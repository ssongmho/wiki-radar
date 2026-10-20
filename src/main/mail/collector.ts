// 메일 수집기 — Radar 가 POP3 로 받아 메일 보관소에 쌓는다(docs/stage2.15-contract.md §A-6).
// electron 을 import 하지 않는다(시계·설정·계정·POP3 연결을 주입받는다). 서버의 메일은 지우지 않는다 — pop3.ts 에 DELE 가 없다.
//
// 한 회: (처음 한 번 위키 수집기의 받은 기록·분류 규칙 이어받기 — 파일 둘) → 연결 → 로그인 → UIDL → 받은 적 없는 것만 RETR(오래된 것부터,
// 한 회 최대 COLLECT_MAX_PER_RUN 통) → 파싱 → 처음 받을 날짜 이전이면 받은 것으로만 셈 → 쓰기 → 메일마다 seen 저장 → QUIT.
// 한 통 실패는 그 통만 건너뛰고 다음 회에 다시 한다.
import type { MailCollectStatus } from '../../shared/types';
import type { Pop3Account } from '../settings/resolve';
import { addressOf } from '../../shared/reply';
import { SENT_FOLDER } from '../wiki/mailIndex';
import { testModeProblem } from './account';
import { MAIL_MAX_BYTES, parseMessage } from './mimeParse';
import { EMPTY_RULES, SKIP_FOLDERS, classify, parseRules, writeMail, type MailRules } from './mailWrite';
import { MailCollectState, adoptWikiRules, mailBaseList, mailStoreBase, readRulesText, readWikiSeen, storeMailRoot } from './mailStore';
import { Pop3Connection, Pop3Error, type Pop3ConnectOptions } from './pop3';

/** 한 회에 받는 최대 통수(나머지는 다음 회) */
export const COLLECT_MAX_PER_RUN = 500;
/** 앱이 뜬 뒤 첫 회까지 */
export const COLLECT_FIRST_DELAY_MS = 30_000;
/** 처음 받을 날짜가 없을 때: 수집을 처음 켠 날의 이만큼 전 */
export const COLLECT_DEFAULT_BACK_DAYS = 30;

export interface CollectSettings {
  enabled: boolean;
  intervalMinutes: number;
  /** YYYY-MM-DD — 없으면 처음 켠 날 30일 전 */
  firstDate?: string;
}

export interface MailCollectorDeps {
  dataDir: string;
  /** 개인 위키 루트(없으면 null) — 가져오기·seen·규칙 이어받기 */
  wikiRoot: () => string | null;
  settings: () => CollectSettings;
  account: () => { ok: true; account: Pop3Account } | { ok: false; problem: string };
  env: NodeJS.ProcessEnv;
  now: () => Date;
  /** 오늘(YYYY-MM-DD, 앱 시계) */
  today: () => string;
  /** frontmatter contributors(설정 › 나의 이름). 없으면 넣지 않는다 */
  contributor?: () => string | undefined;
  /** 새 메일을 썼을 때(메일함 다시 색인) */
  onNewMail?: () => void;
  /** 이 Message-ID(꺾쇠 없이, 소문자)를 Radar 가 보내 이미 보관소에 남겼나 — 숨은참조로 돌아온 내 사본을 두 번 저장하지 않는다 */
  isOwnSent?: (messageId: string) => boolean;
  onStatus?: (status: MailCollectStatus) => void;
  log?: (m: string) => void;
  warn?: (m: string) => void;
  /** 시험: POP3 연결 옵션 더하기 */
  connectOptions?: Partial<Pop3ConnectOptions>;
  /** 시험: 타이머를 쓰지 않는다(직접 runNow) */
  manual?: boolean;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) + days * 86_400_000);
  return t.toISOString().slice(0, 10);
}

export class MailCollector {
  readonly state: MailCollectState;
  private running: Promise<void> | null = null;
  private phase: 'idle' | 'collecting' = 'idle';
  private progress: { done: number; total: number } | null = null;
  private timer: NodeJS.Timeout | null = null;
  private nextAt: number | null = null;
  private stopped = false;
  private lastSig = '';

  constructor(private readonly deps: MailCollectorDeps) {
    this.state = new MailCollectState(deps.dataDir, (m) => this.warn(m));
  }

  private log(m: string): void {
    this.deps.log?.(m);
  }

  private warn(m: string): void {
    this.deps.warn?.(m);
  }

  // ---- 읽는 곳 --------------------------------------------------------------------------

  /** 메일함에 주는 기준 폴더 목록 — 앱 데이터 메일 보관소 하나 */
  mailBases(): string[] {
    return mailBaseList(this.deps.dataDir);
  }

  // ---- 수명 ------------------------------------------------------------------------------

  start(): void {
    if (this.deps.manual) return;
    this.schedule(COLLECT_FIRST_DELAY_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextAt = null;
  }

  /** 설정이 바뀌었을 때 — 주기를 다시 맞춘다 */
  settingsChanged(): void {
    if (this.stopped || this.deps.manual) return;
    this.schedule(this.intervalMs());
    this.emit();
  }

  private intervalMs(): number {
    const m = this.deps.settings().intervalMinutes;
    const min = Number.isFinite(m) ? Math.min(60, Math.max(5, Math.round(m))) : 10;
    return min * 60_000;
  }

  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextAt = null;
    if (this.stopped) return;
    this.nextAt = Date.now() + ms;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runNow().finally(() => this.schedule(this.intervalMs()));
    }, ms);
    this.timer.unref?.();
  }

  // ---- 상태 ------------------------------------------------------------------------------

  status(): MailCollectStatus {
    const s = this.state.get();
    const settings = this.deps.settings();
    const acc = settings.enabled ? this.deps.account() : null;
    let state: MailCollectStatus['state'];
    let problem: string | undefined;
    if (this.phase === 'collecting') state = 'collecting';
    else if (!settings.enabled) state = 'off';
    else if (acc && !acc.ok) {
      state = 'noAccount';
      problem = acc.problem;
    } else if (s.lastError && s.lastRun !== s.lastOk) {
      // 마지막 회차 전체가 실패(일부 통만 실패한 회차는 lastOk === lastRun — 상태는 idle, 문장은 lastError)
      state = 'error';
      problem = s.lastError;
    } else state = 'idle';
    const out: MailCollectStatus = { state, seen: this.state.seenCount(), store: { newMail: mailStoreBase(this.deps.dataDir) } };
    if (problem) out.problem = problem;
    if (s.lastRun) out.lastRun = s.lastRun;
    if (s.lastOk) out.lastOk = s.lastOk;
    if (s.lastCount !== undefined) out.lastCount = s.lastCount;
    if (s.lastError) out.lastError = s.lastError;
    if (this.progress) out.progress = { ...this.progress };
    if (this.nextAt && settings.enabled) out.nextAt = new Date(this.nextAt).toISOString();
    return out;
  }

  private emit(force = false): void {
    if (!this.deps.onStatus) return;
    const st = this.status();
    const sig = JSON.stringify(st);
    if (!force && sig === this.lastSig) return;
    this.lastSig = sig;
    try {
      this.deps.onStatus(st);
    } catch (err) {
      this.warn(`수집 상태 방송 오류: ${describe(err)}`);
    }
  }

  // ---- 이어받기 ----------------------------------------------------------------------------

  /**
   * 위키 수집기(파이썬)의 받은 기록(state.json)·분류 규칙(rules.txt)을 처음 한 번 이어받는다 — 파일 두 개를 읽을 뿐,
   * 옛 메일은 복사하지 않는다(제자리에서 읽는다).
   */
  private adoptStep(): void {
    const wikiRoot = this.deps.wikiRoot();
    if (!wikiRoot || this.state.get().adoptedAt) return;
    const added = this.state.addSeen(readWikiSeen(wikiRoot));
    const rules = adoptWikiRules(this.deps.dataDir, wikiRoot);
    this.state.update({ adoptedAt: this.deps.now().toISOString() });
    this.state.save();
    if (added || rules) this.log(`위키 수집기 기록 이어받음: 받은 메일 ${added}개` + (rules ? ' · 분류 규칙(rules.txt → 앱 데이터 mail-rules.txt)' : ''));
  }

  // ---- 수집 ------------------------------------------------------------------------------

  /** 한 번에 하나. 돌고 있으면 그 회차를 기다린다 */
  private exclusive(fn: () => Promise<void>): Promise<MailCollectStatus> {
    if (this.running) return this.running.then(() => this.status());
    const run = (async () => {
      try {
        await fn();
      } catch (err) {
        this.warn(`메일 수집 오류: ${describe(err)}`);
      }
    })();
    this.running = run.finally(() => {
      this.running = null;
    });
    return this.running.then(() => this.status());
  }

  /** [지금 받기]·주기 */
  runNow(): Promise<MailCollectStatus> {
    return this.exclusive(() => this.collectOnce());
  }

  private rules(): MailRules {
    const r = readRulesText(this.deps.dataDir, this.deps.wikiRoot());
    if (r.from === 'none') return EMPTY_RULES;
    const rules = parseRules(r.text);
    for (const p of rules.problems.slice(0, 3)) this.warn(`분류 규칙: ${p}`);
    return rules;
  }

  /**
   * Radar 가 보낸 메일(보낸 MIME 원문 그대로)을 보관소 '보낸 편지함' 메일함에 남긴다 — 본문·첨부까지. 회신이면 In-Reply-To 로
   * 원본 스레드에 붙는다. 같은 메일이 이미 있으면(같은 파일 이름) 쓰지 않는다. 쓴 경로(raw/mail 기준)를 돌려준다. 실패는 던진다.
   */
  saveSent(raw: Buffer): string {
    const parsed = parseMessage(raw, this.deps.now);
    // 내가 쓴 메일이라 피싱 신호로 격리하지 않는다(보낸 원문에는 인증 결과 머리말도 없다)
    parsed.signals = [];
    const uid = `sent:${parsed.messageId || parsed.date.toISOString()}`;
    const contributor = this.deps.contributor?.();
    const w = writeMail({
      parsed,
      uid,
      rules: this.rules(),
      mailRoot: storeMailRoot(this.deps.dataDir),
      today: this.deps.today(),
      folder: SENT_FOLDER,
      original: raw,
      ...(contributor ? { contributor } : {}),
    });
    if (!w.existed) {
      this.log(`보낸 메일을 메일함에 남김: ${w.rel}`);
      this.deps.onNewMail?.();
    }
    return w.rel;
  }

  private sinceMs(): number {
    const s = this.deps.settings();
    let first = s.firstDate;
    if (!first) {
      let on = this.state.get().firstOn;
      if (!on) {
        on = this.deps.today();
        this.state.update({ firstOn: on });
      }
      first = addDays(on, -COLLECT_DEFAULT_BACK_DAYS);
    }
    // 수집기와 같이 UTC 자정 기준
    return Date.parse(`${first}T00:00:00Z`);
  }

  private async collectOnce(): Promise<void> {
    const settings = this.deps.settings();
    if (!settings.enabled) {
      this.emit();
      return;
    }
    const acc = this.deps.account();
    if (!acc.ok) {
      this.emit();
      return;
    }
    const account = acc.account;
    const guard = testModeProblem(this.deps.env, account.host);
    if (guard) {
      this.state.update({ lastRun: this.deps.now().toISOString(), lastError: guard });
      this.state.save();
      this.emit();
      return;
    }

    // 처음 한 번: 위키 수집기의 받은 기록을 이어받아야 이미 받은 메일을 다시 받지 않는다
    this.adoptStep();

    const startedAt = this.deps.now().toISOString();
    this.phase = 'collecting';
    this.progress = null;
    this.emit(true);
    const rules = this.rules();
    const mailRoot = storeMailRoot(this.deps.dataDir);
    const since = this.sinceMs();
    let conn: Pop3Connection | null = null;
    let saved = 0;
    let skipped = 0;
    let failed = 0;
    try {
      conn = await Pop3Connection.open({
        host: account.host,
        port: account.port,
        ssl: account.ssl,
        secrets: [account.pass],
        ...(this.deps.connectOptions ?? {}),
      });
      await conn.login(account.user, account.pass);
      const list = await conn.uidl();
      const pending = list.filter((x) => !this.state.hasSeen(x.uid)).slice(0, COLLECT_MAX_PER_RUN);
      this.progress = { done: 0, total: pending.length };
      this.emit();
      const today = this.deps.today();
      const contributor = this.deps.contributor?.();
      const myAddress = addressOf(account.user)?.toLowerCase();
      for (const { num, uid } of pending) {
        try {
          const raw = await conn.retr(num, MAIL_MAX_BYTES);
          const parsed = parseMessage(raw, this.deps.now);
          // 내가 보낸 메일(숨은참조로 돌아온 사본 등): 분류 규칙 없이도 '보낸 편지함'. Radar 가 보내며 이미 남긴 것은 다시 쓰지 않는다
          const mine = !!myAddress && addressOf(parsed.from)?.toLowerCase() === myAddress;
          if (parsed.date.getTime() < since) {
            skipped++;
          } else if (mine && parsed.messageId && this.deps.isOwnSent?.(parsed.messageId.toLowerCase())) {
            skipped++;
          } else if (!mine && SKIP_FOLDERS.has(classify(rules, parsed.from, parsed.subject, [...parsed.to, ...parsed.cc]).folder)) {
            skipped++;
          } else {
            writeMail({ parsed, uid, rules, mailRoot, today, original: raw, ...(contributor ? { contributor } : {}), ...(mine ? { folder: SENT_FOLDER } : {}) });
            saved++;
          }
          this.state.addSeen([uid]);
          this.state.save();
        } catch (err) {
          failed++;
          if (failed <= 5) this.warn(`메일 한 통을 받지 못함(uid ${uid.slice(0, 16)}): ${describe(err)}`);
          // 연결이 끊겼으면 이번 회차는 그만
          if (err instanceof Pop3Error && err.stage === 'connect') throw err;
        } finally {
          if (this.progress) this.progress = { done: this.progress.done + 1, total: this.progress.total };
          this.emit();
        }
      }
      await conn.quit();
      conn = null;
      const msg = `메일 받기: 새로 ${saved}통 · 기간 밖·버림 ${skipped}통` + (failed ? ` · 실패 ${failed}통` : '') + (list.length - pending.length > 0 ? ` · 서버 ${list.length}통` : '');
      if (saved || failed) this.log(msg);
      const patch: Parameters<MailCollectState['update']>[0] = { lastRun: startedAt, lastOk: startedAt, lastCount: saved };
      this.state.update(failed ? { ...patch, lastError: `${failed}통을 받지 못했습니다(다음 회에 다시)` } : { ...patch, lastError: undefined });
    } catch (err) {
      const message = describe(err);
      this.warn(`메일 받기 실패: ${message}`);
      this.state.update({ lastRun: startedAt, lastError: message });
    } finally {
      conn?.destroy();
      this.state.save();
      this.phase = 'idle';
      this.progress = null;
      this.emit(true);
    }
    if (saved > 0) this.deps.onNewMail?.();
  }
}
