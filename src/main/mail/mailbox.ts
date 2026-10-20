// 메일함 서비스 — raw/mail 색인·감시·상태·연결·목록 질의(docs/stage2.10-contract.md §5·§6).
// electron 을 import 하지 않는다(감시·시계·저장소를 주입받는다). raw/ 는 읽기만 하고, 색인 캐시·상태는 앱 데이터 폴더에만 쓴다.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  MailFilter,
  MailFolderCount,
  MailIndexEntry,
  MailKey,
  MailMessage,
  MailStateChange,
  MailThreadDetail,
  MailThreadPage,
  MailThreadQuery,
  MailThreadRow,
  MailboxState,
  MailboxSummary,
  MailWikiMark,
  SentMailRecord,
  Task,
} from '../../shared/types';
import { writeJsonAtomic } from '../queue';
import { startWikiWatcher } from '../watcher';
import { compareCodeUnits } from '../wiki/fsutil';
import { normalizeMailPath, readMailMessage } from '../wiki/mail';
import {
  ATTACHMENTS_FOLDER,
  MAIL_INDEX_FILE,
  MailDirMissingError,
  buildMailIndex,
  buildThreads,
  dedupeEntries,
  isMine,
  loadMailIndexCache,
  mailIndexCacheOf,
  type MailFs,
  type MailThread,
} from '../wiki/mailIndex';
import { computeMailLinks, type MailLinkInfo, type MailLinksResult } from './mailLinks';
import { MailStateStore, mailFlags, type MailFlags, type MailMark } from './mailState';

/** 감시 이벤트를 모으는 시간 */
export const MAIL_WATCH_DEBOUNCE_MS = 2_000;
/** OneDrive 가 놓친 이벤트를 따라잡는 다시 확인 주기 */
export const MAIL_RECHECK_MS = 10 * 60_000;
/** 메일함 화면을 열 때 마지막 확인이 이보다 오래면 한 번 더 */
export const MAIL_VIEW_MAX_AGE_MS = 60_000;
/** 위키·raw/mail 이 없을 때 다시 붙기를 보는 주기 */
export const MAIL_WATCH_RETRY_MS = 10_000;
/** 색인 캐시를 마지막 변경 뒤 이만큼 모아 쓴다 */
export const MAIL_CACHE_WRITE_DELAY_MS = 2_000;
/** 한 번에 보내는 목록 줄 수 */
export const MAIL_PAGE_MAX = 200;
/** 사이드바 줄 수 */
export const MAIL_TOP_ROWS = 3;

export const MAILBOX_PROBLEMS = {
  noWiki: '개인 위키가 없어 메일을 읽을 수 없습니다',
  noMailDir: '아직 받은 메일이 없습니다 — 설정 › 메일 받기에서 계정을 넣으면 Radar 가 메일을 받아 옵니다',
} as const;

export interface MailWatchHandle {
  close(): Promise<void> | void;
}

export interface MailboxServiceDeps {
  /** 메일 기준 폴더(그 안의 raw/mail 을 읽는다) — 위키 루트 또는 앱 데이터 메일 보관소(2.15). setMailBase 로 바꾼다 */
  wikiRoot: string;
  dataDir: string;
  /** 상태 시각·기준선에 쓰는 앱 시계(WIKI_RADAR_NOW) */
  now: () => Date;
  /** 보내는 계정 주소(내 사본 판정). 모르면 undefined */
  myAddress: () => string | undefined;
  /** 스냅샷의 열린 할 일(못 읽으면 던져도 된다 — 연결 없이 계속) */
  tasks: () => readonly Task[];
  /** 발송 기록(못 읽으면 던져도 된다) */
  sent: () => readonly SentMailRecord[];
  /** 요약이 바뀔 때(방송) */
  onSummary?: (summary: MailboxSummary) => void;
  /**
   * 2.14: 반영 대기열의 mail 항목(대기·반영 중) — 「위키 반영 대기」 표시를 계산한다(저장하지 않는다, §7-2).
   * 못 읽으면 던져도 된다(표시 없이 계속)
   */
  wikiPending?: () => readonly MailWikiPending[];
  log?: (message: string) => void;
  warn?: (message: string) => void;
  /** 시험용 파일 시스템 */
  fs?: MailFs;
  /** 로컬 LLM 이 회신 필요로 추정한 메일 키(2.16 — 목록 칩). 없으면 칩 없음 */
  aiReplyKeys?: () => ReadonlySet<MailKey>;
  /** raw/mail 감시 시작(기본 startWikiWatcher — 루트가 없으면 retryMs 마다 다시 붙는다) */
  watch?: (mailRoot: string, onSettled: () => void) => MailWatchHandle;
  recheckMs?: number;
  debounceMs?: number;
  retryMs?: number;
  cacheWriteDelayMs?: number;
}

/** 반영 대기열의 mail 항목 하나(2.14 §7-2) */
export interface MailWikiPending {
  mailKey: MailKey;
  scope: 'mail' | 'thread';
  createdAt: string;
  /** 지금 반영 실행에 들어간 항목 */
  running: boolean;
}

interface ThreadView {
  thread: MailThread;
  row: MailThreadRow;
  /** 검색용 — 제목·보낸이(이름·주소)·메일함 이름 */
  haystack: string;
  folders: Set<string>;
}

interface View {
  threads: ThreadView[];
  byId: Map<string, ThreadView>;
  flags: Map<MailKey, MailFlags>;
  folderCounts: MailFolderCount[];
  unread: number;
  replyNeeded: number;
  latestDate?: string;
  top: MailThreadRow[];
}

/** 검색 글 정규화: NFC·소문자·공백 합침 */
export function normSearch(text: string): string {
  return text.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export class MailboxService {
  private readonly deps: MailboxServiceDeps;
  /**
   * 메일 기준 폴더들(그 안의 raw/mail 을 읽는다 — 2.15). 앞이 먼저: 앱 데이터 메일 보관소(새 메일) → 옛 메일 자리(위키 또는 옮긴 보관함).
   * 메일 경로 꼴(`raw/mail/…`)은 어느 폴더든 같다. 처음엔 deps.wikiRoot 하나(옛 동작·시험).
   */
  private bases: string[];
  readonly state: MailStateStore;

  /** 기준 폴더별 파일 항목(캐시 재료) */
  private filesByBase = new Map<string, MailIndexEntry[]>();
  /** 모든 기준 폴더의 파일 항목(앞 폴더 먼저) */
  private files: MailIndexEntry[] = [];
  /** 메일 경로 → 그 파일이 있는 기준 폴더(같은 경로가 둘이면 앞 폴더) */
  private pathBase = new Map<string, string>();
  private entries: MailIndexEntry[] | null = null;
  private threads: MailThread[] = [];
  private entryByKey = new Map<MailKey, MailIndexEntry>();
  private entryByPath = new Map<string, MailIndexEntry>();
  private threadByKey = new Map<MailKey, MailThread>();
  private links: MailLinksResult = { byMail: new Map(), rowLinks: new Map(), threadLinks: new Map() };
  /** 메일 키 → 위키 반영 대기·반영 중(대기열에서 계산 — computeLinks 때 다시) */
  private wikiQueued = new Map<MailKey, MailWikiMark>();
  private view: View | null = null;

  private availability: 'ok' | 'noWiki' | 'noMailDir' = 'ok';
  private error: string | null = null;
  private progress: { done: number; total: number } | null = null;
  private indexedAt: string | null = null;
  private lastCheckMs = 0;
  private revision = 0;

  private running: Promise<void> | null = null;
  private again = false;
  private stopped = false;
  private started = false;
  private watchers: MailWatchHandle[] = [];
  private recheckTimer: NodeJS.Timeout | null = null;
  private cacheTimer: NodeJS.Timeout | null = null;
  private cacheDirty = false;
  private lastEmitted = '';
  private lastProgressEmit = 0;

  constructor(deps: MailboxServiceDeps) {
    this.deps = deps;
    this.bases = [path.resolve(deps.wikiRoot)];
    this.state = new MailStateStore(deps.dataDir, { warn: (m) => this.warn(m), now: deps.now });
  }

  private log(message: string): void {
    this.deps.log?.(message);
  }

  private warn(message: string): void {
    this.deps.warn?.(message);
  }

  // ---- 수명 ------------------------------------------------------------------------------

  /** 캐시로 바로 보이고, 증분 색인·감시·다시 확인을 시작한다 */
  start(): Promise<void> {
    if (this.started) return this.running ?? Promise.resolve();
    this.started = true;
    this.loadCaches();
    if (this.files.length > 0) {
      // 지난 색인으로 먼저 보인다(증분 색인이 곧 맞춘다)
      this.applyIndex(this.files, buildThreads(dedupeEntries(this.withMine(this.files)).entries), false);
    }
    this.startWatch();
    this.recheckTimer = setInterval(() => void this.refresh().catch(() => undefined), this.deps.recheckMs ?? MAIL_RECHECK_MS);
    return this.refresh().then(
      () => undefined,
      () => undefined,
    );
  }

  /** 기준 폴더별 캐시 파일: 첫 폴더는 mail-index.json(옛 이름 그대로), 다른 폴더는 mail-index-<경로 해시>.json */
  private cacheFileOf(base: string): string {
    if (base === this.bases[0]) return path.join(this.deps.dataDir, MAIL_INDEX_FILE);
    return path.join(this.deps.dataDir, `mail-index-${createHash('sha1').update(base).digest('hex').slice(0, 8)}.json`);
  }

  /** 폴더별 캐시를 읽는다(옛 이름 mail-index.json 도 본다 — 1.6.0 이하 캐시를 버리지 않게) */
  private loadCaches(): void {
    this.filesByBase = new Map();
    for (const base of this.bases) {
      if (!isDir(path.join(base, 'raw', 'mail'))) continue;
      let cached = loadMailIndexCache(this.cacheFileOf(base), base);
      if (cached.length === 0) cached = loadMailIndexCache(path.join(this.deps.dataDir, MAIL_INDEX_FILE), base);
      if (cached.length > 0) this.filesByBase.set(base, cached);
    }
    this.mergeFiles();
  }

  /** filesByBase → files·pathBase(앞 폴더 먼저, 같은 경로는 앞 폴더 것만) */
  private mergeFiles(): void {
    const files: MailIndexEntry[] = [];
    const pathBase = new Map<string, string>();
    for (const base of this.bases) {
      for (const e of this.filesByBase.get(base) ?? []) {
        if (pathBase.has(e.path)) continue;
        pathBase.set(e.path, base);
        files.push(e);
      }
    }
    this.files = files;
    this.pathBase = pathBase;
  }

  private closeWatchers(): void {
    const ws = this.watchers;
    this.watchers = [];
    for (const w of ws) {
      try {
        void w.close();
      } catch {
        // 끄기 실패는 무시
      }
    }
  }

  private startWatch(): void {
    const watch =
      this.deps.watch ??
      ((root: string, onSettled: () => void): MailWatchHandle =>
        startWikiWatcher({
          wikiRoot: root,
          excludedDirs: [ATTACHMENTS_FOLDER, '_original'],
          specialFiles: [],
          debounceMs: this.deps.debounceMs ?? MAIL_WATCH_DEBOUNCE_MS,
          retryMs: this.deps.retryMs ?? MAIL_WATCH_RETRY_MS,
          onSettled,
          onWatching: ({ late }) => {
            if (late) this.log(`메일함 감시를 (다시) 시작함: ${root}`);
          },
          onError: (err) => this.warn(`메일함 감시 오류(다시 붙기를 시도함): ${describe(err)}`),
        }));
    this.watchers = this.bases.map((base) => watch(path.join(base, 'raw', 'mail'), () => void this.refresh().catch(() => undefined)));
  }

  /** 지금 메일 기준 폴더들(앞이 먼저) */
  mailBases(): string[] {
    return [...this.bases];
  }

  /** 그 메일 경로(raw/mail/…)의 파일이 있는 기준 폴더. 색인에 없으면 파일이 있는 첫 폴더, 그것도 없으면 첫 폴더 */
  baseOf(rel: string): string {
    const p = normalizeMailPath(rel) ?? rel;
    const known = this.pathBase.get(p);
    if (known) return known;
    for (const base of this.bases) if (fs.existsSync(path.join(base, ...p.split('/')))) return base;
    return this.bases[0];
  }

  /**
   * 메일 기준 폴더들을 바꾼다(2.15 — 보관소 + 옛 메일 자리, 옮기기 뒤 등). 메일 경로 꼴(`raw/mail/…`)·상태 키는 그대로라
   * 상태는 이어지고, 색인은 폴더별 캐시로 다시 맞춘다. 감시도 옮긴다.
   */
  setMailBases(bases: readonly string[]): void {
    const next = [...new Set(bases.map((b) => path.resolve(b)))];
    if (next.length === 0 || next.join('|') === this.bases.join('|')) return;
    this.bases = next;
    this.loadCaches();
    if (!this.started || this.stopped) return;
    this.closeWatchers();
    this.startWatch();
    void this.refresh().catch(() => undefined);
  }

  /** 감시·타이머를 끄고 캐시를 지금 쓴다. 여러 번 불러도 된다 */
  stop(): void {
    this.stopped = true;
    if (this.recheckTimer) clearInterval(this.recheckTimer);
    this.recheckTimer = null;
    if (this.cacheTimer) clearTimeout(this.cacheTimer);
    this.cacheTimer = null;
    this.closeWatchers();
    this.flushCache();
  }

  // ---- 색인 ------------------------------------------------------------------------------

  /** 증분 색인을 하고(실행 중이면 끝난 뒤 한 번 더) 요약을 돌려준다 */
  async refresh(): Promise<MailboxSummary> {
    await this.runIndex();
    return this.summary();
  }

  /** 마지막 확인이 maxAgeMs 보다 오래면 뒤에서 한 번 */
  refreshIfOlder(maxAgeMs = MAIL_VIEW_MAX_AGE_MS): void {
    if (this.running) return;
    if (Date.now() - this.lastCheckMs < maxAgeMs) return;
    void this.runIndex().catch(() => undefined);
  }

  private runIndex(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) {
      this.again = true;
      return this.running;
    }
    const run = (async () => {
      do {
        this.again = false;
        await this.indexOnce();
      } while (this.again && !this.stopped);
    })();
    this.running = run.finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private withMine(files: readonly MailIndexEntry[]): MailIndexEntry[] {
    let me: string | undefined;
    try {
      me = this.deps.myAddress();
    } catch {
      me = undefined;
    }
    return files.map((e) => ({ ...e, mine: isMine(e, me) }));
  }

  private async indexOnce(): Promise<void> {
    const present = this.bases.filter((b) => isDir(path.join(b, 'raw', 'mail')));
    if (present.length === 0) {
      // 위키 하나만 보는 옛 꼴에서 위키 자체가 없으면 noWiki, 아니면(2.15 보관소) 아직 받은 메일이 없는 것
      const onlyWiki = this.bases.length === 1 && this.bases[0] === path.resolve(this.deps.wikiRoot);
      this.setUnavailable(onlyWiki && !isDir(this.bases[0]) ? 'noWiki' : 'noMailDir');
      return;
    }
    let me: string | undefined;
    try {
      me = this.deps.myAddress();
    } catch {
      me = undefined;
    }
    const first = this.entries === null;
    try {
      const stats = { read: 0, reused: 0, removed: 0, duplicates: 0, problems: 0, ms: 0 };
      const byBase = new Map<string, MailIndexEntry[]>();
      for (const base of present) {
        const result = await buildMailIndex({
          wikiRoot: base,
          cache: this.filesByBase.get(base) ?? [],
          ...(this.deps.fs ? { fs: this.deps.fs } : {}),
          ...(me ? { myAddress: me } : {}),
          warn: (m) => this.warn(m),
          onProgress: (done, total) => {
            if (!first || total === 0) return;
            this.progress = { done, total };
            const t = Date.now();
            if (done === total || t - this.lastProgressEmit > 500) {
              this.lastProgressEmit = t;
              this.emit(true);
            }
          },
        });
        byBase.set(base, result.files);
        for (const k of ['read', 'reused', 'removed', 'duplicates', 'problems', 'ms'] as const) stats[k] += result.stats[k];
      }
      // 사라진 기준 폴더(옮긴 위키 raw/mail 등)의 항목도 「빠짐」으로 센다
      for (const [base, list] of this.filesByBase) if (!byBase.has(base)) stats.removed += list.length;
      this.lastCheckMs = Date.now();
      this.progress = null;
      const wasUnavailable = this.availability !== 'ok' || this.error !== null;
      this.availability = 'ok';
      this.error = null;
      const before = this.files;
      this.filesByBase = byBase;
      this.mergeFiles();
      const changed = first || stats.read > 0 || stats.removed > 0 || this.files.length !== before.length || this.mineChanged(before, this.files);
      this.indexedAt = this.deps.now().toISOString();
      if (changed) {
        this.applyIndex(this.files, buildThreads(dedupeEntries(this.withMine(this.files)).entries), true);
        this.cacheDirty = true;
        this.scheduleCacheWrite();
        if (stats.read > 0 || first) {
          this.log(
            `메일함 색인: ${this.files.length}통 · 새로 읽음 ${stats.read} · 그대로 ${stats.reused} · 빠짐 ${stats.removed}` +
              (stats.duplicates ? ` · 같은 메일 ${stats.duplicates}` : '') +
              (stats.problems ? ` · 머리 문제 ${stats.problems}` : '') +
              (present.length > 1 ? ` · 폴더 ${present.length}곳` : '') +
              ` · ${stats.ms}ms`,
          );
        }
      } else if (wasUnavailable) {
        this.revision++;
      }
      this.state.ensureSaved();
      this.emit();
    } catch (err) {
      this.progress = null;
      this.lastCheckMs = Date.now();
      if (err instanceof MailDirMissingError) {
        this.setUnavailable('noMailDir');
        return;
      }
      const message = `메일을 읽지 못했습니다: ${describe(err)}`;
      if (this.error !== message) this.warn(message);
      this.error = message;
      this.revision++;
      this.emit();
    }
  }

  private mineChanged(before: readonly MailIndexEntry[], files: readonly MailIndexEntry[]): boolean {
    if (files.length !== before.length) return true;
    const prev = new Map(before.map((e) => [e.path, e.mine]));
    return files.some((e) => prev.get(e.path) !== e.mine);
  }

  private setUnavailable(kind: 'noWiki' | 'noMailDir'): void {
    this.lastCheckMs = Date.now();
    this.progress = null;
    if (this.availability === kind) return;
    this.availability = kind;
    this.revision++;
    this.emit();
  }

  /** 색인 결과를 들여놓고 연결·보기를 다시 만든다 */
  private applyIndex(files: readonly MailIndexEntry[], threads: MailThread[], bump: boolean): void {
    const { entries } = dedupeEntries(this.withMine(files));
    this.entries = entries;
    this.threads = threads;
    this.entryByKey = new Map(entries.map((e) => [e.key, e]));
    this.entryByPath = new Map(entries.map((e) => [e.path, e]));
    this.threadByKey = new Map();
    for (const t of threads) for (const k of t.mailKeys) this.threadByKey.set(k, t);
    this.links = this.computeLinks();
    this.view = this.buildView();
    if (bump) this.revision++;
  }

  private scheduleCacheWrite(): void {
    if (this.stopped) {
      this.flushCache();
      return;
    }
    if (this.cacheTimer) clearTimeout(this.cacheTimer);
    this.cacheTimer = setTimeout(() => {
      this.cacheTimer = null;
      this.flushCache();
    }, this.deps.cacheWriteDelayMs ?? MAIL_CACHE_WRITE_DELAY_MS);
  }

  private flushCache(): void {
    if (!this.cacheDirty) return;
    try {
      for (const [base, list] of this.filesByBase) writeJsonAtomic(this.cacheFileOf(base), mailIndexCacheOf(base, list, this.deps.now()));
      this.cacheDirty = false;
    } catch (err) {
      this.warn(`메일 색인 캐시를 쓰지 못함: ${describe(err)}`);
    }
  }

  // ---- 연결·보기 --------------------------------------------------------------------------

  private computeLinks(): MailLinksResult {
    let tasks: readonly Task[] = [];
    try {
      tasks = this.deps.tasks();
    } catch {
      tasks = [];
    }
    let sent: readonly SentMailRecord[] = [];
    try {
      sent = this.deps.sent();
    } catch (err) {
      this.warn(`메일함 연결: 발송 기록을 읽지 못함 (${describe(err)})`);
    }
    this.wikiQueued = this.computeWikiQueued();
    return computeMailLinks({
      entries: this.entries ?? [],
      threads: this.threads,
      tasks,
      marks: (k) => this.state.mark(k),
      sent,
      wiki: (k) => this.wikiMarkOf(k),
    });
  }

  /** 대기열의 mail 항목이 덮는 메일 키 → 대기·반영 중(반영 중이 이긴다) */
  private computeWikiQueued(): Map<MailKey, MailWikiMark> {
    const out = new Map<MailKey, MailWikiMark>();
    if (!this.deps.wikiPending) return out;
    let pending: readonly MailWikiPending[];
    try {
      pending = this.deps.wikiPending();
    } catch (err) {
      this.warn(`메일함 연결: 반영 대기열을 읽지 못함 (${describe(err)})`);
      return out;
    }
    for (const p of pending) {
      for (const k of this.coveredKeysOf(p.mailKey, p.scope)) {
        const prev = out.get(k);
        if (prev?.state === 'running') continue;
        out.set(k, { state: p.running ? 'running' : 'queued', at: p.createdAt });
      }
    }
    return out;
  }

  /**
   * 대기 항목(키·범위)이 덮는 메일 키(2.14 §5): mail → 그 키 하나 · thread → 지금 색인의 그 스레드 메일 키(색인에 없으면 그 키 하나)
   */
  coveredKeysOf(key: MailKey, scope: 'mail' | 'thread'): MailKey[] {
    if (scope === 'mail') return [key];
    const keys = this.threadMailsOf(key).map((e) => e.key);
    return keys.length > 0 ? keys : [key];
  }

  /** 메일 한 통의 위키 반영 표시(§7-2): 대기·반영 중이 반영됨(mail-state.json)보다 우선 */
  wikiMarkOf(key: MailKey): MailWikiMark | undefined {
    const q = this.wikiQueued.get(key);
    if (q) return { ...q };
    const w = this.state.mark(key)?.wiki;
    return w ? { state: w.state, at: w.at } : undefined;
  }

  /** 분석 결과가 바뀌었을 때(2.16) — 목록 칩만 다시(색인·연결은 그대로) */
  refreshView(): void {
    if (this.entries === null) return;
    this.view = this.buildView();
    this.revision++;
    this.emit();
  }

  /** 색인 항목 전부(분석 대상 고르기 — 2.16) */
  allEntries(): readonly MailIndexEntry[] {
    return this.entries ?? [];
  }

  /** 스냅샷이 바뀔 때·발송 뒤·VOC 등록 뒤 — 색인은 다시 읽지 않고 연결만 다시 계산한다 */
  relink(): void {
    if (this.entries === null) return;
    const before = JSON.stringify([[...this.links.rowLinks], [...this.wikiQueued]]);
    this.links = this.computeLinks();
    this.view = this.buildView();
    if (JSON.stringify([[...this.links.rowLinks], [...this.wikiQueued]]) !== before) {
      this.revision++;
      this.emit();
    }
  }

  private buildView(): View {
    const entries = this.entries ?? [];
    const baseline = this.state.baselineMs();
    const flags = new Map<MailKey, MailFlags>();
    for (const e of entries) flags.set(e.key, mailFlags(e, this.state.mark(e.key), baseline));

    const folderMap = new Map<string, MailFolderCount>();
    let latestMs = 0;
    let latestDate: string | undefined;
    for (const e of entries) {
      const f = folderMap.get(e.folder) ?? { name: e.folder, count: 0, unread: 0 };
      f.count++;
      if (flags.get(e.key)?.unread) f.unread++;
      folderMap.set(e.folder, f);
      if (e.dateMs > latestMs) {
        latestMs = e.dateMs;
        latestDate = e.date;
      }
    }

    let aiKeys: ReadonlySet<MailKey> = new Set();
    try {
      aiKeys = this.deps.aiReplyKeys?.() ?? new Set();
    } catch {
      aiKeys = new Set();
    }
    const threads: ThreadView[] = [];
    let unread = 0;
    let replyNeeded = 0;
    for (const th of this.threads) {
      const mails = th.mailKeys.map((k) => this.entryByKey.get(k)).filter((e): e is MailIndexEntry => !!e);
      if (mails.length === 0) continue;
      const fl = mails.map((m) => flags.get(m.key) as MailFlags);
      const latest = mails[mails.length - 1];
      const row: MailThreadRow = {
        id: th.id,
        subject: th.subject,
        participants: [...th.participants],
        includesMe: th.includesMe,
        latestMs: th.latestMs,
        count: mails.length,
        unread: fl.some((f) => f.unread),
        replyNeeded: fl.some((f) => f.replyNeeded),
        archived: threadArchivedOf(mails, fl),
        hasAttachments: mails.some((m) => m.attachments > 0),
        suspicious: mails.some((m) => m.suspicious),
        muted: mails.every((m) => m.muted),
        folders: [...th.folders],
        latestKey: latest.key,
        links: { ...(this.links.rowLinks.get(th.id) ?? { tasks: 0 }) },
      };
      if (latest.date) row.latestDate = latest.date;
      // 2.16: 마지막으로 받은 메일이 회신 필요(추정)이고 사람이 아직 손대지 않았으면(회신 필요 표시·처리함·회신 기록 없음)
      if (aiKeys.size > 0 && !row.replyNeeded && !row.archived && !row.links.replied) {
        const lastIn = [...mails].reverse().find((m) => !m.mine);
        if (lastIn && aiKeys.has(lastIn.key)) row.aiReply = true;
      }
      if (row.unread) unread++;
      if (row.replyNeeded) replyNeeded++;
      const hay: string[] = [];
      for (const m of mails) hay.push(m.subject, m.fromName, m.from, m.folder);
      threads.push({ thread: th, row, haystack: normSearch(hay.join('\n')), folders: new Set(th.folders) });
    }
    threads.sort((a, b) => b.row.latestMs - a.row.latestMs || compareCodeUnits(a.row.id, b.row.id));

    const visible = threads.filter((t) => !t.row.archived && !t.row.muted);
    const top = [
      ...visible.filter((t) => t.row.replyNeeded),
      ...visible.filter((t) => !t.row.replyNeeded && t.row.unread),
    ]
      .slice(0, MAIL_TOP_ROWS)
      .map((t) => structuredClone(t.row));

    const folderCounts = [...folderMap.values()].sort((a, b) => b.count - a.count || compareCodeUnits(a.name, b.name));
    const view: View = { threads, byId: new Map(threads.map((t) => [t.row.id, t])), flags, folderCounts, unread, replyNeeded, top };
    if (latestDate) view.latestDate = latestDate;
    return view;
  }

  // ---- 요약·방송 ---------------------------------------------------------------------------

  summary(): MailboxSummary {
    let state: MailboxState;
    let problem: string | undefined;
    if (this.availability === 'noWiki') {
      state = 'noWiki';
      problem = MAILBOX_PROBLEMS.noWiki;
    } else if (this.availability === 'noMailDir') {
      state = 'noMailDir';
      problem = MAILBOX_PROBLEMS.noMailDir;
    } else if (this.error) {
      state = 'error';
      problem = this.error;
    } else if (this.entries === null) {
      state = 'indexing';
    } else {
      state = 'ready';
    }
    const usable = state === 'ready' || state === 'error';
    const v = usable ? this.view : null;
    const out: MailboxSummary = {
      state,
      total: usable ? this.entries?.length ?? 0 : 0,
      unread: v?.unread ?? 0,
      replyNeeded: v?.replyNeeded ?? 0,
      revision: this.revision,
      top: v ? v.top.map((r) => structuredClone(r)) : [],
    };
    if (problem) out.problem = problem;
    if (state === 'indexing' && this.progress) out.progress = { ...this.progress };
    if (v?.latestDate) out.latestDate = v.latestDate;
    if (this.indexedAt && usable) out.indexedAt = this.indexedAt;
    return out;
  }

  /** 요약이 바뀌었으면 방송. progressOnly 면 진행 수만 바뀐 것 */
  private emit(force = false): void {
    if (!this.deps.onSummary) return;
    const s = this.summary();
    const sig = JSON.stringify(s);
    if (!force && sig === this.lastEmitted) return;
    this.lastEmitted = sig;
    try {
      this.deps.onSummary(s);
    } catch (err) {
      this.warn(`메일함 요약 방송 오류: ${describe(err)}`);
    }
  }

  // ---- 질의 ------------------------------------------------------------------------------

  /** 목록(§5-3). 입력은 mailboxInput 이 검사한 것 */
  list(q: MailThreadQuery): MailThreadPage {
    const v = this.view;
    const empty: MailThreadPage = {
      threads: [],
      total: 0,
      counts: { all: 0, unread: 0, replyNeeded: 0, archived: 0 },
      folders: [],
      revision: this.revision,
    };
    if (!v || (this.availability !== 'ok')) return empty;
    const needle = q.query ? normSearch(q.query) : '';
    const base = v.threads.filter(
      (t) =>
        (q.includeMuted || !t.row.muted) &&
        (!q.folder || t.folders.has(q.folder)) &&
        (needle === '' || t.haystack.includes(needle)),
    );
    const match = (t: ThreadView, f: MailFilter): boolean => {
      if (f === 'archived') return t.row.archived;
      if (t.row.archived) return false;
      if (f === 'unread') return t.row.unread;
      if (f === 'replyNeeded') return t.row.replyNeeded;
      return true;
    };
    const counts: Record<MailFilter, number> = { all: 0, unread: 0, replyNeeded: 0, archived: 0 };
    const picked: ThreadView[] = [];
    // keep: 필터에 안 맞아도 제자리에 남긴다(수에는 넣지 않는다)
    const keep = new Set(q.keep ?? []);
    for (const t of base) {
      for (const f of ['all', 'unread', 'replyNeeded', 'archived'] as const) if (match(t, f)) counts[f]++;
      if (match(t, q.filter) || keep.has(t.row.id)) picked.push(t);
    }
    const limit = Math.min(Math.max(1, q.limit), MAIL_PAGE_MAX);
    const offset = Math.max(0, q.offset);
    return {
      threads: picked.slice(offset, offset + limit).map((t) => structuredClone(t.row)),
      total: picked.length,
      counts,
      folders: v.folderCounts.map((f) => ({ ...f })),
      revision: this.revision,
    };
  }

  /** 스레드 상세(§6-1) */
  thread(threadId: string): MailThreadDetail | null {
    const tv = this.view?.byId.get(threadId);
    if (!tv) return null;
    const mails = tv.thread.mailKeys
      .map((k) => this.entryByKey.get(k))
      .filter((e): e is MailIndexEntry => !!e)
      .map((e) => {
        const fl = this.view?.flags.get(e.key) ?? { unread: false, replyNeeded: false, archived: false };
        const mark = this.state.mark(e.key);
        const item: MailThreadDetail['mails'][number] = {
          key: e.key,
          path: e.path,
          from: e.from,
          fromName: e.fromName,
          to: [...e.to],
          ccCount: e.ccCount,
          subject: e.subject,
          folder: e.folder,
          attachments: e.attachments,
          suspicious: e.suspicious,
          mine: e.mine,
          muted: e.muted,
          unread: fl.unread,
          replyNeeded: fl.replyNeeded,
          archived: fl.archived,
        };
        if (e.date) item.date = e.date;
        if (mark?.voc?.number) item.voc = mark.voc.number;
        if (mark?.task?.file) item.taskFile = mark.task.file;
        if (e.problem) item.problem = e.problem;
        const wiki = this.wikiMarkOf(e.key);
        if (wiki) item.wiki = wiki;
        return item;
      });
    const links = this.links.threadLinks.get(threadId) ?? { tasks: [], voc: [], sent: [] };
    return { id: threadId, threadKey: tv.thread.key, subject: tv.thread.subject, mails, links: structuredClone(links) };
  }

  findThread(key: MailKey): { threadId: string } | null {
    const th = this.threadByKey.get(key);
    return th ? { threadId: th.id } : null;
  }

  /** 메일 읽기(§6-2). 경로 검사는 readMailMessage 가 한다 */
  message(rel: string): MailMessage | null {
    if (this.availability === 'noWiki') return null;
    const msg = readMailMessage(this.baseOf(rel), rel);
    if (!msg) return null;
    const entry = this.entryByPath.get(msg.path);
    if (entry) msg.key = entry.key;
    return msg;
  }

  /** 색인 항목(경로로). 없으면 undefined */
  entryOfPath(rel: string): MailIndexEntry | undefined {
    const p = normalizeMailPath(rel);
    return p ? this.entryByPath.get(p) : undefined;
  }

  entryOfKey(key: MailKey): MailIndexEntry | undefined {
    return this.entryByKey.get(key);
  }

  /** 그 메일의 스레드 메일들(날짜순). 색인에 없으면 [] */
  threadMailsOf(key: MailKey): MailIndexEntry[] {
    const th = this.threadByKey.get(key);
    if (!th) return [];
    return th.mailKeys.map((k) => this.entryByKey.get(k)).filter((e): e is MailIndexEntry => !!e);
  }

  /** 그 메일의 연결(§4) */
  linksOf(key: MailKey): MailLinkInfo | undefined {
    return this.links.byMail.get(key);
  }

  markOf(key: MailKey): MailMark | undefined {
    return this.state.mark(key);
  }

  // ---- 바꾸기 ------------------------------------------------------------------------------

  /**
   * 상태 바꾸기(§3-3). 색인에 없는 키는 무시하고 수만 알린다(ignored). 쓰지 못하면 던진다.
   */
  setState(keys: readonly MailKey[], change: MailStateChange): MailboxSummary & { ignored?: number } {
    const known = [...new Set(keys)].filter((k) => this.entryByKey.has(k));
    const ignored = keys.length - known.length;
    const paths = new Map(known.map((k) => [k, (this.entryByKey.get(k) as MailIndexEntry).path]));
    const changed = known.length > 0 ? this.state.apply(known, change, paths) : 0;
    if (changed > 0) {
      this.view = this.buildView();
      this.revision++;
      this.emit();
    }
    const out: MailboxSummary & { ignored?: number } = this.summary();
    if (ignored > 0) out.ignored = ignored;
    return out;
  }

  /** 위키 반영 기록(2.14 §4-3) + 연결 다시 계산. 색인에 없는 키도 적는다(경로는 아는 것만) */
  markWiki(keys: readonly MailKey[], wiki: { state: 'done' | 'skipped'; runId: string }): void {
    const paths = new Map<MailKey, string>();
    for (const k of keys) {
      const p = this.entryByKey.get(k)?.path;
      if (p) paths.set(k, p);
    }
    this.state.setWiki(keys, wiki, paths);
    this.relinkForce();
  }

  /** 메일함 VOC 등록 기록 + 연결 다시 계산 */
  markVoc(key: MailKey, voc: { number: string; ticketId: number }): void {
    this.state.setVoc(key, voc, this.entryByKey.get(key)?.path);
    this.relinkForce();
  }

  /** [할 일로] 기록 + 연결 다시 계산 */
  markTask(key: MailKey, file: string): void {
    this.state.setTask(key, file, this.entryByKey.get(key)?.path);
    this.relinkForce();
  }

  private relinkForce(): void {
    if (this.entries === null) return;
    this.links = this.computeLinks();
    this.view = this.buildView();
    this.revision++;
    this.emit();
  }
}

/**
 * 스레드가 처리함인가(§3-2): 남이 보낸 메일이 모두 처리함. 내 사본(`mine` — bccSelf·보낸편지함 수집)은 세지 않는다 —
 * [보낸 뒤 처리함으로] 뒤에 내 회신 사본이 들어와 스레드가 다시 「전체」에 나오지 않게. 내 사본만 있는 스레드는 모두 처리함일 때
 */
export function threadArchivedOf(mails: readonly { mine: boolean }[], flags: readonly { archived: boolean }[]): boolean {
  const others = mails.map((m, i) => (m.mine ? null : flags[i])).filter((f): f is { archived: boolean } => !!f);
  const pool = others.length > 0 ? others : flags;
  return pool.length > 0 && pool.every((f) => f.archived);
}
