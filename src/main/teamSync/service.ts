// 팀 위키 동기화 서비스 — 언제 돌릴지(켤 때·내 PC 저장 뒤·주기·버튼)와 상태 보관. electron 을 import 하지 않는다.
// 계약: docs/stage2.8-contract.md
//
// - 한 번에 하나만 돈다. 도는 중에 또 요청이 오면 끝난 뒤 한 번 더 돈다.
// - 기준 상태(team-sync-state.json)는 앱 데이터 폴더에 원자적으로 쓴다. 깨졌으면 처음 동기화로 돌아간다
//   (처음 동기화는 지우지 않으므로 안전하다 — 다른 내용이면 충돌 사본을 만든다).
import fs from 'node:fs';
import path from 'node:path';
import type { TeamSyncStatus } from '../../shared/types';
import { writeJsonAtomic } from '../queue';
import { LOCAL_MARKER, TRASH_DIR, isSynced, syncOnce, type SyncReport, type SyncState } from './engine';

export const TEAM_SYNC_STATE_FILE = 'team-sync-state.json';
/** 화면에 보일 최근 변경 수 */
const RECENT_MAX = 30;

export interface TeamSyncConfig {
  enabled: boolean;
  remote: string;
  local: string;
}

export interface TeamSyncDeps {
  dataDir: string;
  config: () => TeamSyncConfig;
  /** 충돌 사본 이름에 넣을 사람 */
  who: string;
  onStatus: (status: TeamSyncStatus) => void;
  /** 내 PC 사본으로 쓸 수 없는 폴더(개인 위키 등) — 그 안이거나 같으면 거부 */
  forbidden?: () => string[];
  log?: (message: string) => void;
  now?: () => Date;
  /** 주기(기본 5분) */
  intervalMs?: number;
  /** 내 PC 에서 저장한 뒤 기다리는 시간(기본 4초 — 연달아 저장하면 한 번만) */
  debounceMs?: number;
  /** 켠 뒤 첫 동기화까지(기본 3초) */
  startDelayMs?: number;
  /** 시험용 — 폴더 감시를 쓰지 않는다 */
  noWatch?: boolean;
  /**
   * 동기화 한 번이 끝날 때마다(2.9단계 — changed: 받음·올림·충돌·지움이 하나라도 있었나). 팀 할 일을 다시 읽는 데 쓴다.
   * report 는 그 동기화의 보고서(3a단계 §5-3 — 변경 피드가 내가 올린 것(pushed)을 읽음으로 적는다)
   */
  onSynced?: (changed: boolean, report: SyncReport) => void;
  /**
   * 동기화 한 번이 사본을 훑기 직전(3a단계 §5-3 — 동기화하는 동안 내가 고친 것이 팀원 변경으로 잠깐 보이지 않게,
   * 변경 피드가 이 시각 뒤에 감지했는데 받은 것이 아닌 문서는 다음 동기화까지 숨긴다)
   */
  onSyncStart?: (local: string) => void;
}

function samePath(a: string, b: string): boolean {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

/** child 가 parent 와 같거나 그 안인가 */
export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent).toLowerCase(), path.resolve(child).toLowerCase());
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

/** 설정 경로 검사. 문제가 있으면 한국어 문장 */
export function teamSyncConfigProblem(cfg: TeamSyncConfig, forbidden: string[] = []): string | null {
  if (!cfg.remote.trim()) return 'NAS 팀 위키 경로를 적으세요';
  if (!cfg.local.trim()) return '내 PC 위키 폴더를 적으세요';
  if (isInside(cfg.local, cfg.remote) || isInside(cfg.remote, cfg.local)) return 'NAS 경로와 내 PC 폴더는 서로 안에 있으면 안 됩니다';
  for (const f of forbidden) {
    if (f && (isInside(cfg.local, f) || isInside(f, cfg.local))) return '개인 위키 폴더(또는 그 상위·하위)는 팀 위키 사본으로 쓸 수 없습니다';
  }
  return null;
}

function parseState(raw: unknown): SyncState | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.remote !== 'string' || typeof r.local !== 'string' || !r.files || typeof r.files !== 'object') return null;
  const files: SyncState['files'] = {};
  for (const [k, v] of Object.entries(r.files as Record<string, unknown>)) {
    const f = v as Record<string, unknown>;
    if (
      f &&
      typeof f.hash === 'string' &&
      typeof f.size === 'number' &&
      typeof f.lm === 'number' &&
      typeof f.rm === 'number' &&
      typeof f.rel === 'string'
    ) {
      files[k] = { hash: f.hash, size: f.size, lm: f.lm, rm: f.rm, rel: f.rel };
    }
  }
  return { remote: r.remote, local: r.local, files, at: typeof r.at === 'string' ? r.at : '' };
}

export class TeamSyncService {
  private readonly stateFile: string;
  private running: Promise<void> | null = null;
  private again = false;
  private againConfirm = false;
  private timer: NodeJS.Timeout | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private watcher: fs.FSWatcher | null = null;
  private watchedLocal: string | null = null;
  private stopped = true;
  private st: TeamSyncStatus;
  /** lastOkAt 이 어느 사본 경로의 성공인가 */
  private okLocal: string | null = null;

  constructor(private readonly deps: TeamSyncDeps) {
    this.stateFile = path.join(deps.dataDir, TEAM_SYNC_STATE_FILE);
    const cfg = deps.config();
    this.st = { enabled: cfg.enabled, remote: cfg.remote, local: cfg.local, phase: cfg.enabled ? 'idle' : 'off', recent: [] };
  }

  status(): TeamSyncStatus {
    const cfg = this.deps.config();
    const out: TeamSyncStatus = { ...this.st, enabled: cfg.enabled, remote: cfg.remote, local: cfg.local, recent: [...this.st.recent] };
    // 마지막 성공은 그 사본 경로의 것만 — 경로를 바꾸면 새 사본의 첫 동기화 전까지 없다(3a단계 §5-2 기준선이 이것을 기다린다)
    if (out.lastOkAt && (this.okLocal === null || !samePath(this.okLocal, cfg.local))) delete out.lastOkAt;
    return out;
  }

  /** 켤 때 한 번 — 설정이 켜져 있으면 감시·주기를 시작한다 */
  start(): void {
    this.stopped = false;
    this.reconfigure();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    this.unwatch();
  }

  /** 설정이 바뀌었을 때(켜기·끄기·경로) */
  reconfigure(): void {
    if (this.stopped) return;
    this.clearTimers();
    const cfg = this.deps.config();
    if (!cfg.enabled) {
      this.unwatch();
      this.set({ phase: 'off', message: undefined, pending: undefined });
      return;
    }
    if (this.st.phase === 'off') this.set({ phase: 'idle' });
    this.watch(cfg.local);
    this.timer = setInterval(() => this.request(), this.deps.intervalMs ?? 5 * 60_000);
    this.timer.unref?.();
    this.debounce = setTimeout(() => this.request(), this.deps.startDelayMs ?? 3000);
    this.debounce.unref?.();
  }

  /** 지금 동기화한다. confirmLarge 는 「많이 지우거나 덮어쓰기」 확인 뒤에만 */
  async runNow(confirmLarge = false): Promise<TeamSyncStatus> {
    this.request(confirmLarge);
    while (this.running) await this.running;
    return this.status();
  }

  private request(confirmLarge = false): void {
    if (this.stopped || !this.deps.config().enabled) return;
    if (this.running) {
      this.again = true;
      this.againConfirm ||= confirmLarge;
      return;
    }
    this.running = this.loop(confirmLarge).finally(() => {
      this.running = null;
    });
  }

  private async loop(confirmLarge: boolean): Promise<void> {
    let confirm = confirmLarge;
    for (;;) {
      this.again = false;
      this.againConfirm = false;
      await this.once(confirm);
      if (!this.again || this.stopped) return;
      confirm = this.againConfirm;
    }
  }

  private async once(confirmLarge: boolean): Promise<void> {
    const cfg = this.deps.config();
    if (!cfg.enabled) return;
    const now = this.deps.now?.() ?? new Date();
    const problem = teamSyncConfigProblem(cfg, this.deps.forbidden?.() ?? []);
    if (problem) {
      this.set({ phase: 'error', message: problem, lastRunAt: now.toISOString() });
      return;
    }
    this.set({ phase: 'running' });
    let report: SyncReport;
    try {
      this.deps.onSyncStart?.(cfg.local);
    } catch (err) {
      this.deps.log?.(`동기화 전 처리 오류: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      report = await syncOnce({ remote: cfg.remote, local: cfg.local, state: this.loadState(), who: this.deps.who, now, confirmLarge });
    } catch (err) {
      this.set({ phase: 'error', message: `동기화 중 오류: ${err instanceof Error ? err.message : String(err)}`, lastRunAt: now.toISOString() });
      return;
    }
    if (report.outcome === 'done' && report.state) {
      try {
        writeJsonAtomic(this.stateFile, report.state);
      } catch (err) {
        this.deps.log?.(`팀 위키 동기화 상태를 저장하지 못함: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // 새 폴더를 만들었으면(처음 동기화) 감시를 다시 건다
    if (this.watchedLocal !== cfg.local || !this.watcher) this.watch(cfg.local);
    const at = now.toISOString();
    if (report.outcome === 'done') this.okLocal = cfg.local;
    const recent = [
      ...report.pulled.map((rel) => ({ rel, dir: 'in' as const, at })),
      ...report.pushed.map((rel) => ({ rel, dir: 'out' as const, at })),
      ...report.conflicts.map((rel) => ({ rel, dir: 'conflict' as const, at })),
      ...report.deletedLocal.map((rel) => ({ rel, dir: 'deletedIn' as const, at })),
      ...report.deletedRemote.map((rel) => ({ rel, dir: 'deletedOut' as const, at })),
      ...this.st.recent,
    ].slice(0, RECENT_MAX);
    const changed =
      report.pulled.length + report.pushed.length + report.conflicts.length + report.deletedLocal.length + report.deletedRemote.length > 0;
    if (changed) {
      this.deps.log?.(
        `팀 위키 동기화: 받음 ${report.pulled.length} · 올림 ${report.pushed.length} · 충돌 ${report.conflicts.length} · 지움 ${
          report.deletedLocal.length + report.deletedRemote.length
        }`,
      );
    }
    this.set({
      phase: report.outcome === 'done' ? 'idle' : report.outcome,
      message: report.message,
      pending: report.pending,
      lastRunAt: at,
      lastOkAt: report.outcome === 'done' ? at : this.st.lastOkAt,
      last:
        report.outcome === 'done'
          ? {
              pulled: report.pulled.length,
              pushed: report.pushed.length,
              deleted: report.deletedLocal.length + report.deletedRemote.length,
              conflicts: report.conflicts,
              skipped: report.skipped.slice(0, 20),
            }
          : this.st.last,
      recent,
    });
    try {
      this.deps.onSynced?.(changed, report);
    } catch (err) {
      this.deps.log?.(`동기화 뒤 처리 오류: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private loadState(): SyncState | null {
    try {
      return parseState(JSON.parse(fs.readFileSync(this.stateFile, 'utf8')));
    } catch {
      return null;
    }
  }

  private set(patch: Partial<TeamSyncStatus>): void {
    this.st = { ...this.st, ...patch };
    this.deps.onStatus(this.status());
  }

  private watch(local: string): void {
    if (this.deps.noWatch) return;
    if (this.watcher && this.watchedLocal && samePath(this.watchedLocal, local)) return;
    this.unwatch();
    try {
      if (!fs.existsSync(local)) return; // 처음 동기화가 폴더를 만든 뒤 다시 건다
      this.watcher = fs.watch(local, { recursive: true }, (_event, name) => {
        const rel = typeof name === 'string' ? name.replace(/\\/g, '/') : '';
        if (rel && (!isSynced(rel) || rel.startsWith(`${TRASH_DIR}/`) || rel === LOCAL_MARKER)) return;
        this.onLocalChange();
      });
      this.watcher.on('error', () => this.unwatch());
      this.watchedLocal = local;
    } catch (err) {
      this.deps.log?.(`팀 위키 폴더 감시를 시작하지 못함: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private onLocalChange(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.request(), this.deps.debounceMs ?? 4000);
    this.debounce.unref?.();
  }

  private unwatch(): void {
    try {
      this.watcher?.close();
    } catch {
      // 닫기 실패는 무시
    }
    this.watcher = null;
    this.watchedLocal = null;
  }

  private clearTimers(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.debounce) clearTimeout(this.debounce);
    this.timer = null;
    this.debounce = null;
  }
}
