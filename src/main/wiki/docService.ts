// 위키 문서 서비스(docs/stage3a-contract.md §3) — 두 출처(개인 위키·팀 위키 사본) 색인·검색·문서 읽기·변경 피드·요약 방송.
// electron 을 import 하지 않는다(시계·설정·방송을 주입받는다). 위키는 읽기만 하고, 캐시·읽음 기록은 앱 데이터 폴더에만 쓴다.
//
// 다시 색인하는 때(감시기를 새로 열지 않는다 — §3-1): 개인은 1단계 감시기의 onSettled, 팀은 2.9 사본 감시(onChanged)와
// 동기화 끝(onTeamSynced), 그리고 10분마다·화면을 열 때 60초보다 오래면·날짜가 바뀔 때.
import fs from 'node:fs';
import path from 'node:path';
import type {
  MarkWikiSeenInput,
  MarkWikiSeenOutput,
  WikiChangeItem,
  WikiChangesPage,
  WikiDocRef,
  WikiDocsSummary,
  WikiImageResult,
  WikiLinkTarget,
  WikiLogEntry,
  WikiPage,
  WikiSearchPage,
  WikiSearchQuery,
  WikiSearchSource,
  WikiDocSource,
  WikiSourceInfo,
  WikiSourceState,
} from '../../shared/types';
import { writeJsonAtomic } from '../queue';
import {
  ChangeBaseStore,
  WIKI_BULK_THRESHOLD,
  WIKI_CHANGES_MAX,
  WikiSeenStore,
  isChangeExcluded,
  listChanges,
  makeBaseline,
  markSeenPaths,
  observeIndex,
  type ChangeBase,
  type SeenDoc,
} from './docChanges';
import {
  DocRootMissingError,
  WIKI_BODY_MAX_BYTES,
  WIKI_INDEX_FILE,
  buildDocIndex,
  cutUnits,
  emptyImageDict,
  loadWikiIndexCache,
  parseDocText,
  readWithRetry,
  wikiIndexCacheOf,
  type DocFs,
  type ImageDict,
  type WikiDocEntry,
  type WikiIndexCacheSource,
  nodeDocFs,
} from './docIndex';
import { IMAGE_REASONS, WIKI_IMAGE_MAX_BYTES, findImageRef, imageRefsOf, imageTypeOf, imageTypeOfName, resolveImageRef } from './docInput';
import { docRefOf, prepareSearchDoc, recentDocs, searchDocs, type SearchDoc } from './docSearch';
import { errCode, isInsideDir } from './fsutil';
import { buildNameDict, extractWikiLinks, resolveLink, type NameDict } from './wikiLinks';
import { logItemsByDoc, logReasonOf, parseWikiLog, reasonsFor, recentLogItems, resolveLogItems, type ResolvedLogItem } from './wikiLog';

/** 다시 확인 주기 · 화면을 열 때 기준 · 모아 쓰기(§12) */
export const WIKI_RECHECK_MS = 10 * 60_000;
export const WIKI_VIEW_MAX_AGE_MS = 60_000;
export const WIKI_WRITE_DELAY_MS = 2_000;
/** 미리보기 본문 한도(§6) */
export const WIKI_PAGE_BODY_MAX = 300_000;
/** 미리보기 본문 자르기(서로게이트 쌍을 가르지 않는다) — page()·image() 가 같은 본문을 본다 */
const cutPageBody = (body: string): string => cutUnits(body, WIKI_PAGE_BODY_MAX);
/** 되돌리기 토큰 유효 시간 */
export const WIKI_UNDO_MS = 60_000;

export const WIKI_PROBLEMS = {
  noWiki: '개인 위키가 없습니다',
  off: '팀 위키 동기화가 꺼져 있습니다',
  missing: '팀 위키 사본 폴더가 없습니다',
  waiting: '첫 동기화를 기다리는 중',
  syncStopped: '동기화가 멈춰 있어 새 변경을 받지 못합니다 — 설정 › 점검',
  big: '문서가 커서 미리보기를 하지 않습니다 — Obsidian 에서 여세요',
} as const;

export interface WikiDocsServiceDeps {
  dataDir: string;
  /** 앱 시계(WIKI_RADAR_NOW) */
  now: () => Date;
  /** 오늘(로컬 YYYY-MM-DD) */
  today: () => string;
  /** 개인 위키 루트 */
  personalRoot: () => string;
  /** 팀 위키 사본 설정(동기화 켜짐·사본 경로·설정 문제) */
  team: () => { enabled: boolean; local: string; problem?: string | null };
  /** 팀 동기화 상태(첫 동기화 뒤 기준선·멈춤 안내) */
  teamSync?: () => { phase: string; lastOkAt?: string };
  onSummary?: (summary: WikiDocsSummary) => void;
  log?: (message: string) => void;
  warn?: (message: string) => void;
  fs?: DocFs;
  recheckMs?: number;
  writeDelayMs?: number;
}

interface SourceRuntime {
  source: WikiDocSource;
  root: string | null;
  state: WikiSourceState;
  problem?: string;
  entries: Map<string, WikiDocEntry> | null;
  search: Map<string, SearchDoc>;
  images: ImageDict;
  dict: NameDict;
  indexedAt?: string;
  stale: boolean;
  progress?: { done: number; total: number };
  running: Promise<void> | null;
  again: boolean;
  lastCheckMs: number;
  bulk?: number;
}

interface UndoRecord {
  at: number;
  items: { source: WikiDocSource; path: string; seen?: SeenDoc; base?: ChangeBase }[];
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

function sameRoot(a: string, b: string): boolean {
  const ra = path.resolve(a);
  const rb = path.resolve(b);
  return process.platform === 'win32' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** ISO → 로컬 YYYY-MM-DD */
export function localDateOfIso(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '0000-00-00';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export class WikiDocsService {
  private readonly deps: WikiDocsServiceDeps;
  private readonly cacheFile: string;
  readonly seen: WikiSeenStore;
  readonly base: ChangeBaseStore;
  private readonly rt: Record<WikiDocSource, SourceRuntime>;
  private revision = 0;
  private started = false;
  private stopped = false;
  private recheckTimer: NodeJS.Timeout | null = null;
  private cacheTimer: NodeJS.Timeout | null = null;
  private stateTimer: NodeJS.Timeout | null = null;
  private cacheDirty = false;
  private lastEmitted = '';
  private logItems: ResolvedLogItem[] = [];
  private logByDoc = new Map<string, ResolvedLogItem[]>();
  private logSource: WikiDocEntry | null = null;
  private changeMemo: { revision: number; lists: Partial<Record<WikiDocSource, WikiChangeItem[]>> } = { revision: -1, lists: {} };
  private undo = new Map<string, UndoRecord>();
  private undoSeq = 0;
  /** 이 앱이 방금 쓴 파일(noteOwnWrite) — 그동안의 색인마다 지금 해시를 읽음으로 적는다(잠깐 「변경」으로 보이지 않게) */
  private ownWrites: Record<WikiDocSource, Map<string, number>> = { personal: new Map(), team: new Map() };
  /** 지금 도는 팀 동기화가 사본을 훑기 시작한 시각(이 앱 시계 — §5-3) */
  private teamSyncStartAt: string | null = null;

  constructor(deps: WikiDocsServiceDeps) {
    this.deps = deps;
    this.cacheFile = path.join(deps.dataDir, WIKI_INDEX_FILE);
    this.seen = new WikiSeenStore(deps.dataDir, { warn: (m) => this.warn(m) });
    this.base = new ChangeBaseStore(deps.dataDir, { warn: (m) => this.warn(m) });
    const empty = (source: WikiDocSource): SourceRuntime => ({
      source,
      root: null,
      state: source === 'personal' ? 'noWiki' : 'off',
      entries: null,
      search: new Map(),
      images: emptyImageDict(),
      dict: buildNameDict([]),
      stale: false,
      running: null,
      again: false,
      lastCheckMs: 0,
    });
    this.rt = { personal: empty('personal'), team: empty('team') };
  }

  private log(message: string): void {
    this.deps.log?.(message);
  }

  private warn(message: string): void {
    this.deps.warn?.(message);
  }

  private nowIso(): string {
    return this.deps.now().toISOString();
  }

  private get dfs(): DocFs {
    return this.deps.fs ?? nodeDocFs;
  }

  // ---- 출처 설정 ---------------------------------------------------------------------------

  /** 지금 설정으로 그 출처를 쓸 수 있는가 — 쓸 수 있으면 루트, 아니면 상태·이유 */
  private configOf(source: WikiDocSource): { root: string } | { state: WikiSourceState; problem: string } {
    if (source === 'personal') {
      const root = path.resolve(this.deps.personalRoot());
      return isDir(root) ? { root } : { state: 'noWiki', problem: WIKI_PROBLEMS.noWiki };
    }
    const cfg = this.deps.team();
    if (!cfg.enabled) return { state: 'off', problem: WIKI_PROBLEMS.off };
    if (cfg.problem) return { state: 'problem', problem: cfg.problem };
    const root = path.resolve(cfg.local);
    return isDir(root) ? { root } : { state: 'missing', problem: WIKI_PROBLEMS.missing };
  }

  // ---- 수명 ------------------------------------------------------------------------------

  /** 캐시로 바로 검색 가능(stale) → 증분 색인. 다시 확인 타이머를 건다 */
  start(): Promise<void> {
    if (this.started) return Promise.resolve();
    this.started = true;
    const roots: Partial<Record<WikiDocSource, string>> = {};
    for (const source of ['personal', 'team'] as const) {
      const c = this.configOf(source);
      if ('root' in c) roots[source] = c.root;
    }
    const cached = loadWikiIndexCache(this.cacheFile, roots);
    for (const source of ['personal', 'team'] as const) {
      const c = cached[source];
      const root = roots[source];
      if (!c || !root) continue;
      const st = this.rt[source];
      st.root = root;
      this.applyEntries(st, c.entries, emptyImageDict());
      st.state = 'ready';
      st.stale = true;
      if (c.builtAt) st.indexedAt = c.builtAt;
    }
    if (cached.personal || cached.team) this.revision++;
    this.recheckTimer = setInterval(() => void this.refreshAll().catch(() => undefined), this.deps.recheckMs ?? WIKI_RECHECK_MS);
    this.recheckTimer.unref?.();
    return this.refreshAll().then(
      () => undefined,
      () => undefined,
    );
  }

  /** 타이머를 끄고 캐시·기록을 지금 쓴다. 여러 번 불러도 된다 */
  stop(): void {
    this.stopped = true;
    if (this.recheckTimer) clearInterval(this.recheckTimer);
    this.recheckTimer = null;
    if (this.cacheTimer) clearTimeout(this.cacheTimer);
    this.cacheTimer = null;
    if (this.stateTimer) clearTimeout(this.stateTimer);
    this.stateTimer = null;
    this.flushCache();
    this.seen.flush();
    this.base.flush();
  }

  /** 설정이 바뀌었을 때(개인 위키 폴더 · 팀 동기화 켜기/끄기/경로) — 바뀐 출처는 처음부터 다시 */
  reconfigure(): Promise<void> {
    for (const source of ['personal', 'team'] as const) {
      const st = this.rt[source];
      const c = this.configOf(source);
      const gone = !('root' in c) || (st.root !== null && !sameRoot(st.root, c.root));
      if (gone && (st.entries !== null || st.root !== null)) {
        this.reset(st);
        this.cacheDirty = true;
        this.scheduleCacheWrite();
        this.revision++;
      }
    }
    this.emit();
    return this.refreshAll().then(() => undefined);
  }

  private reset(st: SourceRuntime): void {
    st.root = null;
    st.entries = null;
    st.search = new Map();
    st.images = emptyImageDict();
    st.dict = buildNameDict([]);
    st.stale = false;
    delete st.indexedAt;
    delete st.progress;
    delete st.bulk;
    if (st.source === 'personal') {
      this.logItems = [];
      this.logByDoc = new Map();
      this.logSource = null;
    }
  }

  // ---- 색인 ------------------------------------------------------------------------------

  /** 두 출처 증분 색인을 기다린다 */
  async refreshAll(): Promise<WikiDocsSummary> {
    await Promise.all([this.runIndex('personal'), this.runIndex('team')]);
    return this.summary();
  }

  /** 한 출처(감시기가 부른다). 실행 중이면 끝난 뒤 한 번 더 */
  refresh(source: WikiDocSource): Promise<void> {
    return this.runIndex(source);
  }

  /** 마지막 확인이 maxAgeMs 보다 오래면 뒤에서 한 번 */
  refreshIfOlder(maxAgeMs = WIKI_VIEW_MAX_AGE_MS): void {
    for (const source of ['personal', 'team'] as const) {
      const st = this.rt[source];
      if (st.running || Date.now() - st.lastCheckMs < maxAgeMs) continue;
      void this.runIndex(source).catch(() => undefined);
    }
  }

  private runIndex(source: WikiDocSource): Promise<void> {
    const st = this.rt[source];
    if (this.stopped) return Promise.resolve();
    if (st.running) {
      st.again = true;
      return st.running;
    }
    const run = (async () => {
      do {
        st.again = false;
        await this.indexOnce(st);
      } while (st.again && !this.stopped);
    })();
    st.running = run.finally(() => {
      st.running = null;
    });
    return st.running;
  }

  private setUnavailable(st: SourceRuntime, state: WikiSourceState, problem: string): void {
    st.lastCheckMs = Date.now();
    const had = st.entries !== null;
    if (had) {
      this.reset(st);
      this.cacheDirty = true;
      this.scheduleCacheWrite();
    }
    if (st.state === state && st.problem === problem && !had) return;
    st.state = state;
    st.problem = problem;
    this.revision++;
    this.emit();
  }

  private async indexOnce(st: SourceRuntime): Promise<void> {
    const c = this.configOf(st.source);
    if (!('root' in c)) {
      this.setUnavailable(st, c.state, c.problem);
      return;
    }
    if (st.root && !sameRoot(st.root, c.root)) this.reset(st);
    const root = c.root;
    const first = st.entries === null;
    if (first && st.state !== 'indexing') {
      st.state = 'indexing';
      delete st.problem;
      this.revision++;
      this.emit();
    }
    let lastProgress = 0;
    try {
      const result = await buildDocIndex({
        source: st.source,
        root,
        cache: st.entries?.values() ?? [],
        fs: this.dfs,
        warn: (m) => this.warn(m),
        onProgress: (done, total) => {
          if (!first || total === 0) return;
          st.progress = { done, total };
          const t = Date.now();
          if (done === total || t - lastProgress > 500) {
            lastProgress = t;
            this.emit();
          }
        },
      });
      if (this.stopped) return;
      // 그사이 설정이 바뀌었으면 버린다(다음 한 번이 맞춘다)
      const again = this.configOf(st.source);
      if (!('root' in again) || !sameRoot(again.root, root)) {
        st.again = true;
        return;
      }
      st.lastCheckMs = Date.now();
      delete st.progress;
      const prev = st.entries;
      const changed =
        first ||
        result.stats.read > 0 ||
        result.stats.removed > 0 ||
        (prev !== null && result.entries.length !== prev.size) ||
        st.state !== 'ready' ||
        st.stale;
      st.root = root;
      if (changed) this.applyEntries(st, result.entries, result.images);
      else st.images = result.images;
      st.state = 'ready';
      delete st.problem;
      st.stale = false;
      st.indexedAt = this.nowIso();
      if (result.stats.read > 0 || first) {
        this.log(
          `위키 색인(${st.source === 'personal' ? '개인' : '팀'}): ${result.stats.files}문서 · 새로 읽음 ${result.stats.read} · 그대로 ${result.stats.reused} · 빠짐 ${result.stats.removed}` +
            (result.stats.problems ? ` · 문제 ${result.stats.problems}` : '') +
            ` · ${result.stats.ms}ms`,
        );
      }
      const changesMoved = this.afterIndex(st, prev);
      if (changed) {
        this.cacheDirty = true;
        this.scheduleCacheWrite();
      }
      if (changed || changesMoved) this.revision++;
      this.emit();
    } catch (err) {
      st.lastCheckMs = Date.now();
      delete st.progress;
      if (err instanceof DocRootMissingError) {
        this.setUnavailable(st, st.source === 'personal' ? 'noWiki' : 'missing', st.source === 'personal' ? WIKI_PROBLEMS.noWiki : WIKI_PROBLEMS.missing);
        return;
      }
      const message = `위키 문서를 읽지 못했습니다: ${describe(err)}`;
      if (st.problem !== message) this.warn(message);
      st.state = st.entries ? 'ready' : 'error';
      st.problem = message;
      if (!st.entries) st.state = 'error';
      this.revision++;
      this.emit();
    }
  }

  /** 색인 결과를 들여놓는다 — 검색 문서는 항목 객체가 같으면 다시 만들지 않는다 */
  private applyEntries(st: SourceRuntime, entries: readonly WikiDocEntry[], images: ImageDict): void {
    const map = new Map<string, WikiDocEntry>();
    const search = new Map<string, SearchDoc>();
    for (const e of entries) {
      map.set(e.path, e);
      const prevDoc = st.search.get(e.path);
      search.set(e.path, prevDoc && prevDoc.entry === e ? prevDoc : prepareSearchDoc(e));
    }
    st.entries = map;
    st.search = search;
    st.images = images;
    st.dict = buildNameDict([...map.values()].map((e) => ({ path: e.path, aliases: e.fm.aliases })));
    if (st.source === 'personal') this.rebuildLog();
  }

  private rebuildLog(): void {
    const entry = this.rt.personal.entries?.get('log.md') ?? null;
    if (entry === this.logSource && this.logItems.length > 0) {
      // 링크 사전이 바뀌었을 수 있다 — 다시 해석만
      this.logItems = resolveLogItems(this.logItems, this.rt.personal.dict);
      this.logByDoc = logItemsByDoc(this.logItems);
      return;
    }
    this.logSource = entry;
    if (!entry || !entry.body) {
      this.logItems = [];
      this.logByDoc = new Map();
      return;
    }
    try {
      this.logItems = resolveLogItems(parseWikiLog(entry.body), this.rt.personal.dict);
    } catch (err) {
      this.warn(`log.md 를 읽지 못함(이유 없이 계속): ${describe(err)}`);
      this.logItems = [];
    }
    this.logByDoc = logItemsByDoc(this.logItems);
  }

  /** 기준선·관찰(§5-2·§5-4). 변경 목록이 바뀌었으면 true */
  private afterIndex(st: SourceRuntime, prev: Map<string, WikiDocEntry> | null): boolean {
    if (!st.entries || !st.root) return false;
    const seenSrc = this.seen.source(st.source);
    const nowIso = this.nowIso();
    if (!seenSrc || !sameRoot(seenSrc.root, st.root)) {
      if (st.source === 'team') {
        // 이 사본 경로의 첫 동기화가 끝난 뒤에만(§5-2). lastOkAt 은 지금 경로의 성공만 담는다 — 경로를 바꾸면 비고,
        // 동기화가 도는 중이면 반쯤 받은 사본이라 끝날 때(onTeamSynced) 잡는다
        const sync = this.deps.teamSync?.();
        if (!sync?.lastOkAt || sync.phase === 'running') return false;
      }
      if (!this.seen.writable()) return false;
      const baseline = makeBaseline(st.root, st.entries.values(), nowIso);
      if (st.source === 'team') baseline.teamCutoffAt = nowIso;
      this.seen.mutate((d) => {
        d.sources[st.source] = baseline;
      });
      // 그 출처의 기준 내용은 버린다
      const items = this.base.items;
      for (const k of Object.keys(items)) if (k.startsWith(`${st.source}:`)) delete items[k];
      this.base.touch();
      this.scheduleStateWrite();
      this.log(`위키 변경 기준선(${st.source === 'personal' ? '개인' : '팀'}): ${Object.keys(baseline.docs).length}문서`);
      return true;
    }
    // 이 앱이 쓴 파일은 관찰 전에 읽음으로(§5-3 「내가 한 일은 알리지 않는다」)
    let own = false;
    const pending = this.ownWrites[st.source];
    if (pending.size > 0 && this.seen.writable()) {
      const paths = [...pending.keys()].filter((p) => st.entries?.has(p));
      if (paths.length > 0) {
        this.seen.mutate((d) => {
          const s = d.sources[st.source];
          if (s && markSeenPaths(st.source, paths, st.entries as Map<string, WikiDocEntry>, s, this.base.items, nowIso) > 0) own = true;
        });
      }
    }
    const { changed: observed, detected } = observeIndex({
      source: st.source,
      prev,
      next: st.entries,
      seen: seenSrc,
      base: this.base.items,
      nowIso,
    });
    if (detected > WIKI_BULK_THRESHOLD) st.bulk = detected;
    const changed = observed || own;
    if (changed) {
      this.base.touch();
      this.scheduleStateWrite();
    }
    return changed;
  }

  /**
   * 동기화가 끝났을 때(§5-3): ① 팀 출처를 먼저 증분 색인 ② 내가 올린 것(pushed·deletedRemote)의 지금 해시를 읽음으로 ③ teamCutoffAt = 지금.
   */
  async onTeamSynced(report: {
    outcome: string;
    pushed: readonly string[];
    deletedRemote?: readonly string[];
    pulled?: readonly string[];
    deletedLocal?: readonly string[];
    conflicts?: readonly string[];
  }): Promise<void> {
    const startedAt = this.teamSyncStartAt;
    this.teamSyncStartAt = null;
    if (this.stopped) return;
    await this.runIndex('team');
    if (report.outcome !== 'done') return;
    const st = this.rt.team;
    if (st.state !== 'ready' || !st.entries || !st.root) return;
    const seenSrc = this.seen.source('team');
    if (!seenSrc || !sameRoot(seenSrc.root, st.root)) {
      // 첫 색인이 동기화보다 먼저 끝났으면 지금 기준선을 잡는다
      if (this.afterIndex(st, null)) {
        this.revision++;
        this.emit();
      }
      return;
    }
    if (!this.seen.writable()) return;
    const mine = [...report.pushed, ...(report.deletedRemote ?? [])]
      .map((p) => p.replace(/\\/g, '/').normalize('NFC'))
      .filter((p) => p.toLowerCase().endsWith('.md'));
    const nowIso = this.nowIso();
    this.seen.mutate((d) => {
      const s = d.sources.team;
      if (!s) return;
      markSeenPaths('team', mine, st.entries as Map<string, WikiDocEntry>, s, this.base.items, nowIso);
      // 동기화가 사본을 훑은 뒤 감지했는데 이번에 받은(지운) 것이 아니면 내가 그 사이 고친 것이다 —
      // 다음 동기화가 올릴 때까지 cutoff 뒤로 미뤄 「팀원 변경」으로 잠깐 보이지 않게(§5-3)
      if (startedAt) {
        const theirs = new Set(
          [
            ...(report.pulled ?? []),
            ...(report.deletedLocal ?? []),
            // 충돌이면 본문은 NAS 쪽으로 맞춰진다 — 사본 이름에서 `(충돌 …)` 를 뗀 본문 문서도 받은 것
            ...(report.conflicts ?? []).map((p) => p.replace(/ \(충돌 [^()/\\]*\)(\.[^./\\]+)$/, '$1')),
          ].map((p) => p.replace(/\\/g, '/').normalize('NFC')),
        );
        const from = Date.parse(startedAt);
        const later = new Date(Date.parse(nowIso) + 1).toISOString();
        for (const [key, b] of Object.entries(this.base.items)) {
          if (!key.startsWith('team:')) continue;
          if (Date.parse(b.detectedAt) > from && !theirs.has(key.slice('team:'.length))) b.detectedAt = later;
        }
      }
      s.teamCutoffAt = nowIso;
    });
    this.base.touch();
    this.scheduleStateWrite();
    this.revision++;
    this.emit();
  }

  /** 팀 동기화가 사본을 훑기 직전(TeamSyncService.onSyncStart) — §5-3 */
  noteTeamSyncStart(): void {
    this.teamSyncStartAt = this.nowIso();
  }

  /**
   * 이 앱이 위키에 쓴 직후(2단계 저장·메일 [할 일로]) — 그 파일의 새 해시를 읽음으로(§5-3 「내가 한 일은 알리지 않는다」).
   * 색인이 도는 동안(감시가 먼저 돌아도) 그 파일은 관찰 전에 읽음으로 적혀 잠깐도 「변경」으로 보이지 않는다.
   */
  async noteOwnWrite(source: WikiDocSource, rels: readonly string[]): Promise<void> {
    const paths = rels.map((p) => p.replace(/\\/g, '/').normalize('NFC')).filter((p) => !isChangeExcluded(source, p));
    if (paths.length === 0) return;
    const pending = this.ownWrites[source];
    for (const p of paths) pending.set(p, (pending.get(p) ?? 0) + 1);
    try {
      await this.runIndex(source);
    } finally {
      for (const p of paths) {
        const n = (pending.get(p) ?? 1) - 1;
        if (n > 0) pending.set(p, n);
        else pending.delete(p);
      }
    }
  }

  // ---- 저장 ------------------------------------------------------------------------------

  private scheduleCacheWrite(): void {
    if (this.stopped) {
      this.flushCache();
      return;
    }
    if (this.cacheTimer) clearTimeout(this.cacheTimer);
    this.cacheTimer = setTimeout(() => {
      this.cacheTimer = null;
      this.flushCache();
    }, this.deps.writeDelayMs ?? WIKI_WRITE_DELAY_MS);
    this.cacheTimer.unref?.();
  }

  private flushCache(): void {
    if (!this.cacheDirty) return;
    const sources: Partial<Record<WikiDocSource, WikiIndexCacheSource>> = {};
    for (const source of ['personal', 'team'] as const) {
      const st = this.rt[source];
      if (!st.entries || !st.root) continue;
      sources[source] = { root: st.root, builtAt: st.indexedAt ?? this.nowIso(), entries: [...st.entries.values()] };
    }
    try {
      const { file, withoutBody } = wikiIndexCacheOf(sources);
      if (withoutBody) this.warn('위키 색인 캐시가 커서 본문 없이 씁니다(다음 시작에 본문을 다시 읽습니다)');
      writeJsonAtomic(this.cacheFile, file);
      this.cacheDirty = false;
    } catch (err) {
      this.warn(`위키 색인 캐시를 쓰지 못함: ${describe(err)}`);
    }
  }

  private scheduleStateWrite(): void {
    if (this.stopped) {
      this.seen.flush();
      this.base.flush();
      return;
    }
    if (this.stateTimer) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      this.seen.flush();
      this.base.flush();
    }, this.deps.writeDelayMs ?? WIKI_WRITE_DELAY_MS);
    this.stateTimer.unref?.();
  }

  /** 시험용: 모아 둔 쓰기를 지금 */
  flushNow(): void {
    this.flushCache();
    this.seen.flush();
    this.base.flush();
  }

  // ---- 변경 ------------------------------------------------------------------------------

  /** 출처의 변경 목록(보이는 것만, 최근 순). waiting·쓸 수 없음이면 null */
  private changeList(source: WikiDocSource): WikiChangeItem[] | null {
    const st = this.rt[source];
    if (st.state !== 'ready' || !st.entries || !st.root) return null;
    const seenSrc = this.seen.source(source);
    if (!seenSrc || !sameRoot(seenSrc.root, st.root)) return null;
    if (this.changeMemo.revision !== this.revision) this.changeMemo = { revision: this.revision, lists: {} };
    const memo = this.changeMemo.lists[source];
    if (memo) return memo;
    const list = listChanges({
      source,
      entries: st.entries,
      seen: seenSrc,
      base: this.base.items,
      localDate: localDateOfIso,
      ...(source === 'personal' ? { reasons: (p: string, since: string) => reasonsFor(this.logByDoc, p, since) } : {}),
    });
    this.changeMemo.lists[source] = list;
    return list;
  }

  private changeState(source: WikiDocSource): WikiSourceState | 'waiting' {
    const st = this.rt[source];
    if (st.state !== 'ready') return st.state;
    return this.changeList(source) === null ? 'waiting' : 'ready';
  }

  changes(q: { source: WikiDocSource; offset: number; limit: number }): WikiChangesPage {
    const st = this.rt[q.source];
    const state = this.changeState(q.source);
    const list = this.changeList(q.source) ?? [];
    const capped = list.slice(0, WIKI_CHANGES_MAX);
    const page: WikiChangesPage = {
      state,
      items: capped.slice(q.offset, q.offset + Math.min(200, Math.max(1, q.limit))).map((i) => structuredClone(i)),
      total: capped.length,
      more: Math.max(0, list.length - WIKI_CHANGES_MAX),
      revision: this.revision,
    };
    if (state === 'waiting') page.problem = WIKI_PROBLEMS.waiting;
    else if (st.problem) page.problem = st.problem;
    if (st.bulk && list.length > 0) page.bulk = st.bulk;
    if (q.source === 'team') {
      const phase = this.deps.teamSync?.()?.phase;
      if (phase === 'paused' || phase === 'error') page.syncNote = WIKI_PROBLEMS.syncStopped;
    }
    return page;
  }

  /** 읽음으로(§5-7). 결과에 되돌리기 토큰 */
  markSeen(input: MarkWikiSeenInput): MarkWikiSeenOutput {
    const groups = new Map<WikiDocSource, string[]>();
    if ('all' in input) {
      const list = this.changeList(input.source) ?? [];
      groups.set(input.source, list.map((i) => i.path));
      delete this.rt[input.source].bulk;
    } else {
      for (const it of input.items) {
        const arr = groups.get(it.source) ?? [];
        if (!arr.includes(it.path)) arr.push(it.path);
        groups.set(it.source, arr);
      }
    }
    const nowIso = this.nowIso();
    const undo: UndoRecord = { at: Date.now(), items: [] };
    let changed = 0;
    for (const [source, paths] of groups) {
      const st = this.rt[source];
      const seenSrc = this.seen.source(source);
      if (!st.entries || !seenSrc || !st.root || !sameRoot(seenSrc.root, st.root) || paths.length === 0) continue;
      const items = this.base.items;
      for (const p of paths) {
        const key = `${source}:${p}`;
        const rec: UndoRecord['items'][number] = { source, path: p };
        if (seenSrc.docs[p]) rec.seen = { ...seenSrc.docs[p] };
        if (items[key]) rec.base = { ...items[key] };
        undo.items.push(rec);
      }
      this.seen.mutate((d) => {
        const s = d.sources[source];
        if (s) changed += markSeenPaths(source, paths, st.entries as Map<string, WikiDocEntry>, s, items, nowIso);
      });
    }
    const out: MarkWikiSeenOutput = this.summaryAfterChange(changed > 0);
    if (changed > 0 && undo.items.length > 0) {
      this.pruneUndo();
      const token = `u${(++this.undoSeq).toString(36)}${Date.now().toString(36)}`;
      this.undo.set(token, undo);
      out.undoToken = token;
    }
    return out;
  }

  /** 되돌리기(markSeen 결과의 토큰, 60초 안) */
  undoSeen(token: string): WikiDocsSummary {
    this.pruneUndo();
    const rec = this.undo.get(token);
    if (!rec) throw new Error('되돌릴 수 있는 시간이 지났습니다');
    this.undo.delete(token);
    this.seen.mutate((d) => {
      for (const it of rec.items) {
        const s = d.sources[it.source];
        if (!s) continue;
        if (it.seen) s.docs[it.path] = { ...it.seen };
        else delete s.docs[it.path];
        const key = `${it.source}:${it.path}`;
        if (it.base) this.base.items[key] = { ...it.base };
      }
    });
    return this.summaryAfterChange(true);
  }

  private pruneUndo(): void {
    const t = Date.now();
    for (const [k, v] of this.undo) if (t - v.at > WIKI_UNDO_MS) this.undo.delete(k);
  }

  private summaryAfterChange(changed: boolean): WikiDocsSummary {
    if (changed) {
      this.base.touch();
      this.scheduleStateWrite();
      this.revision++;
      this.emit();
    }
    return this.summary();
  }

  // ---- 요약·방송 ---------------------------------------------------------------------------

  private sourceInfo(source: WikiDocSource): WikiSourceInfo {
    const st = this.rt[source];
    const info: WikiSourceInfo = { state: st.state, docs: st.entries?.size ?? 0 };
    if (st.problem) info.problem = st.problem;
    if (st.indexedAt && st.entries) info.indexedAt = st.indexedAt;
    if (st.stale) info.stale = true;
    if (st.progress && st.state === 'indexing') info.progress = { ...st.progress };
    return info;
  }

  summary(): WikiDocsSummary {
    const personal = this.changeList('personal')?.length ?? 0;
    const team = this.changeList('team')?.length ?? 0;
    return {
      sources: { personal: this.sourceInfo('personal'), team: this.sourceInfo('team') },
      changes: { personal, team, total: personal + team },
      revision: this.revision,
    };
  }

  private emit(): void {
    if (!this.deps.onSummary) return;
    const s = this.summary();
    const sig = JSON.stringify(s);
    if (sig === this.lastEmitted) return;
    this.lastEmitted = sig;
    try {
      this.deps.onSummary(s);
    } catch (err) {
      this.warn(`위키 요약 방송 오류: ${describe(err)}`);
    }
  }

  // ---- 검색·목록 ---------------------------------------------------------------------------

  private *searchDocsOf(): Iterable<SearchDoc> {
    for (const source of ['personal', 'team'] as const) {
      const st = this.rt[source];
      if (st.state === 'ready' && st.entries) yield* st.search.values();
    }
  }

  search(q: WikiSearchQuery): WikiSearchPage {
    const started = performance.now();
    const r = searchDocs(this.searchDocsOf(), q);
    return { hits: r.hits, total: r.total, counts: r.counts, ms: Math.round(performance.now() - started), revision: this.revision };
  }

  recent(source: WikiSearchSource, limit: number): WikiDocRef[] {
    const all: WikiDocEntry[] = [];
    for (const s of ['personal', 'team'] as const) {
      const st = this.rt[s];
      if (st.state === 'ready' && st.entries) all.push(...st.entries.values());
    }
    return recentDocs(all, source, limit);
  }

  logRecent(): WikiLogEntry[] {
    const st = this.rt.personal;
    if (st.state !== 'ready' || !st.entries) return [];
    return recentLogItems(this.logItems, this.deps.today()).map((it) => {
      const r = logReasonOf(it);
      const entry: WikiLogEntry = { date: r.date, title: r.title, excerpt: r.excerpt, docs: [] };
      if (r.kind) entry.kind = r.kind;
      for (const p of it.docs) {
        const e = st.entries?.get(p);
        if (e) entry.docs.push(docRefOf(e));
      }
      return entry;
    });
  }

  /** 색인 항목(검사한 경로). 없으면 undefined */
  entryOf(source: WikiDocSource, rel: string): WikiDocEntry | undefined {
    const st = this.rt[source];
    return st.state === 'ready' ? st.entries?.get(rel) : undefined;
  }

  /** 출처 루트(쓸 수 있을 때) */
  rootOf(source: WikiDocSource): string | null {
    const st = this.rt[source];
    return st.state === 'ready' ? st.root : null;
  }

  // ---- 문서 읽기 ---------------------------------------------------------------------------

  /** 색인에 있는 문서의 절대경로 — 실제 경로까지 루트 안인지 본다 */
  private async absOf(source: WikiDocSource, rel: string): Promise<{ abs: string; entry: WikiDocEntry; root: string } | null> {
    const entry = this.entryOf(source, rel);
    const root = this.rootOf(source);
    if (!entry || !root) return null;
    const abs = path.join(root, ...(entry.fsPath ?? entry.path).split('/'));
    let real: string;
    let realRoot: string;
    try {
      real = await this.dfs.realpath(abs);
      realRoot = await this.dfs.realpath(root);
    } catch (err) {
      if (errCode(err) === 'ENOENT') return null;
      throw new Error(`문서를 확인하지 못했습니다: ${rel} (${errCode(err)})`);
    }
    if (!isInsideDir(realRoot, real)) throw new Error(`위키 밖을 가리키는 문서라 열지 않습니다: ${rel}`);
    return { abs, entry, root };
  }

  private async readPageText(source: WikiDocSource, rel: string): Promise<{ text: string; size: number; mtimeMs: number; root: string } | null> {
    const loc = await this.absOf(source, rel);
    if (!loc) return null;
    let st: { size: number; mtimeMs: number; isFile: boolean };
    try {
      st = await this.dfs.stat(loc.abs);
    } catch (err) {
      if (errCode(err) === 'ENOENT') return null;
      throw new Error(`문서를 읽지 못했습니다: ${rel} (${errCode(err)})`);
    }
    if (st.size > WIKI_BODY_MAX_BYTES) throw new Error(WIKI_PROBLEMS.big);
    let buf: Buffer;
    try {
      buf = await readWithRetry(this.dfs, loc.abs);
    } catch (err) {
      if (errCode(err) === 'ENOENT') return null;
      throw new Error(`문서를 읽지 못했습니다: ${rel} (${errCode(err)})`);
    }
    if (buf.length > WIKI_BODY_MAX_BYTES) throw new Error(WIKI_PROBLEMS.big);
    return { text: buf.toString('utf8'), size: st.size, mtimeMs: st.mtimeMs, root: loc.root };
  }

  private dicts(): Partial<Record<WikiDocSource, NameDict>> {
    const out: Partial<Record<WikiDocSource, NameDict>> = {};
    for (const s of ['personal', 'team'] as const) if (this.rt[s].state === 'ready' && this.rt[s].entries) out[s] = this.rt[s].dict;
    return out;
  }

  /** 문서 읽기(§6) — 색인에 있는 문서만, 파일을 새로 읽는다. 없으면 null */
  async page(source: WikiDocSource, rel: string): Promise<WikiPage | null> {
    const read = await this.readPageText(source, rel);
    if (!read) return null;
    const parsed = parseDocText(source, rel, read.text, true);
    const truncated = parsed.body.length > WIKI_PAGE_BODY_MAX;
    const body = cutPageBody(parsed.body);
    const dicts = this.dicts();
    const links: Record<string, WikiLinkTarget | null> = {};
    for (const l of extractWikiLinks(body)) {
      if (l.key in links) continue;
      links[l.key] = resolveLink(dicts, { source, path: rel }, l.key);
    }
    const images: WikiPage['images'] = {};
    const imgDict = this.rt[source].images;
    for (const r of imageRefsOf(body)) {
      if (r.ref in images) continue;
      const res = resolveImageRef(r, rel, imgDict, (p) => fs.existsSync(path.join(read.root, ...p.split('/'))));
      if (!res.ok) {
        images[r.ref] = { ok: false, reason: res.reason };
        continue;
      }
      try {
        const st = fs.statSync(path.join(read.root, ...res.path.split('/')));
        images[r.ref] = st.size > WIKI_IMAGE_MAX_BYTES ? { ok: false, reason: IMAGE_REASONS.big } : { ok: true };
      } catch {
        images[r.ref] = { ok: false, reason: IMAGE_REASONS.missing };
      }
    }
    const page: WikiPage = {
      source,
      path: rel,
      title: parsed.title,
      kind: parsed.kind,
      private: parsed.private,
      mtimeMs: read.mtimeMs,
      hash: parsed.hash,
      fm: parsed.fm,
      body,
      truncated,
      links,
      images,
    };
    const change = (this.changeList(source) ?? []).find((i) => i.path === rel);
    if (change) page.change = structuredClone(change);
    return page;
  }

  /** 그림(§7-4): 「이 문서의 이 참조」 → data: URL. renderer 는 경로를 보내지 않는다 */
  async image(source: WikiDocSource, pageRel: string, ref: string): Promise<WikiImageResult> {
    const read = await this.readPageText(source, pageRel);
    if (!read) return { problem: '색인에 없는 문서입니다' };
    const parsed = parseDocText(source, pageRel, read.text, true);
    // page() 가 알려 준 참조와 같게 — 같은 길이로 자른 본문에서 찾는다
    const r = findImageRef(cutPageBody(parsed.body), ref);
    if (!r) return { problem: '문서에 없는 그림 참조입니다' };
    const root = read.root;
    const res = resolveImageRef(r, pageRel, this.rt[source].images, (p) => fs.existsSync(path.join(root, ...p.split('/'))));
    if (!res.ok) return { problem: res.reason };
    const abs = path.join(root, ...res.path.split('/'));
    const type = imageTypeOfName(abs);
    if (!type) return { problem: IMAGE_REASONS.ext };
    try {
      const [real, realRoot] = await Promise.all([this.dfs.realpath(abs), this.dfs.realpath(root)]);
      if (!isInsideDir(realRoot, real)) return { problem: IMAGE_REASONS.outside };
      const st = await this.dfs.stat(abs);
      if (!st.isFile) return { problem: IMAGE_REASONS.missing };
      if (st.size > WIKI_IMAGE_MAX_BYTES) return { problem: IMAGE_REASONS.big };
      const buf = await readWithRetry(this.dfs, abs);
      if (buf.length > WIKI_IMAGE_MAX_BYTES) return { problem: IMAGE_REASONS.big };
      if (imageTypeOf(buf) !== type) return { problem: IMAGE_REASONS.signature };
      return { dataUrl: `data:image/${type};base64,${buf.toString('base64')}` };
    } catch (err) {
      if (errCode(err) === 'ENOENT') return { problem: IMAGE_REASONS.missing };
      return { problem: `그림을 읽지 못함 (${errCode(err)})` };
    }
  }
}
