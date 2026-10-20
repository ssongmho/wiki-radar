// 변경 피드(docs/stage3a-contract.md §5) — 읽음 기록 · 기준선 · 새/바뀜/지움 판정 · 변경 기준 내용 · 바뀐 줄 수.
// electron 을 import 하지 않는다. 위키는 읽기만 하고, 기록은 앱 데이터 폴더(wiki-seen.json · wiki-change-base.json)에만 쓴다.
//
// - wiki-seen.json: 원자적 쓰기. 깨진 파일은 wiki-seen.broken-<시각>.json 으로 옮기고 새 기준선 + 경고.
//   ENOENT 가 아닌 읽기 실패(잠김·권한)는 빈 기록으로 덮어쓰지 않는다 — 쓰기를 거부한다(2.10 mail-state.json 과 같은 이유).
// - wiki-change-base.json: 안 읽은 변경의 기준 내용·처음 감지 시각. 지우면 줄 수가 「모름」이 될 뿐이라 깨지면 새로 시작한다.
import fs from 'node:fs';
import path from 'node:path';
import type { WikiChangeItem, WikiLogReason, WikiDocSource } from '../../shared/types';
import { wikiDocKey } from '../../shared/wikiDocs';
import { compactStamp, writeJsonAtomic } from '../queue';
import { PROBLEM_BIG, docKindOf, docNameOf, type WikiDocEntry } from './docIndex';
import { compareCodeUnits, errCode, readTextFile } from './fsutil';

export const WIKI_SEEN_FILE = 'wiki-seen.json';
export const WIKI_CHANGE_BASE_FILE = 'wiki-change-base.json';
/** 출처마다 문서 수 한도 · 파일 크기 한도(§5-1) */
export const WIKI_SEEN_MAX_DOCS = 20_000;
export const WIKI_SEEN_MAX_BYTES = 8 * 1024 * 1024;
/** 기준 내용 한도(§5-4) */
export const WIKI_BASE_DOC_MAX_BYTES = 256 * 1024;
export const WIKI_BASE_TOTAL_MAX_BYTES = 32 * 1024 * 1024;
/** 계산하는 항목 수 한도 · 대량 변경 안내 기준(§5-3) */
export const WIKI_CHANGES_MAX = 2_000;
export const WIKI_BULK_THRESHOLD = 300;
/** 줄 표본 수·길이 · 새 문서 첫 줄 길이 */
const SAMPLE_MAX = 3;
const SAMPLE_LEN = 80;
const FIRST_LINE_LEN = 80;

/**
 * 개인 위키에서 변경으로 보이지 않는 문서(§5-3): log.md·index.md(늘 바뀐다 — log 는 「이유」로 쓴다),
 * 할 일 원천(이 앱·open_loops.py·sync_todo.py 가 하루에도 여러 번 고친다 — 할 일 화면이 보여 준다)
 */
export const PERSONAL_CHANGE_EXCLUDED: ReadonlySet<string> = new Set([
  'log.md',
  'index.md',
  '_private/mgmt/내 할 일.md',
  '_private/mgmt/할 일 메모.md',
]);

export function isChangeExcluded(source: WikiDocSource, rel: string): boolean {
  return source === 'personal' && PERSONAL_CHANGE_EXCLUDED.has(rel);
}

// ---- 읽음 기록 -------------------------------------------------------------------------------

export interface SeenDoc {
  hash: string;
  at: string;
}

export interface SeenSource {
  root: string;
  baselineAt: string;
  teamCutoffAt?: string;
  docs: Record<string, SeenDoc>;
}

export interface WikiSeenFile {
  version: 1;
  sources: Partial<Record<WikiDocSource, SeenSource>>;
}

const isoOk = (v: unknown): v is string => typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v));
const HASH_RE = /^[0-9a-f]{40}$/;

/** 파일 내용 → 기록. 형식이 틀리면 null(항목 하나가 틀리면 그 항목만 버린다) */
export function parseWikiSeenFile(value: unknown): WikiSeenFile | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v.version !== 1 || !v.sources || typeof v.sources !== 'object' || Array.isArray(v.sources)) return null;
  const out: WikiSeenFile = { version: 1, sources: {} };
  for (const source of ['personal', 'team'] as const) {
    const s = (v.sources as Record<string, unknown>)[source] as Record<string, unknown> | undefined;
    if (s === undefined) continue;
    if (!s || typeof s !== 'object' || typeof s.root !== 'string' || !isoOk(s.baselineAt)) return null;
    if (!s.docs || typeof s.docs !== 'object' || Array.isArray(s.docs)) return null;
    const docs: Record<string, SeenDoc> = {};
    for (const [p, raw] of Object.entries(s.docs as Record<string, unknown>)) {
      const d = raw as Record<string, unknown> | null;
      if (!d || typeof d !== 'object' || p.length > 1024) continue;
      if (typeof d.hash !== 'string' || !HASH_RE.test(d.hash) || !isoOk(d.at)) continue;
      docs[p] = { hash: d.hash, at: d.at };
    }
    const src: SeenSource = { root: s.root, baselineAt: s.baselineAt as string, docs };
    if (isoOk(s.teamCutoffAt)) src.teamCutoffAt = s.teamCutoffAt;
    out.sources[source] = src;
  }
  return out;
}

/** 한도(§5-1): 문서 수·파일 크기를 넘으면 오래 전에 본 것부터 버린다(버린 문서는 다음에 「새 문서」로 보인다) */
export function pruneWikiSeen(file: WikiSeenFile, maxDocs = WIKI_SEEN_MAX_DOCS, maxBytes = WIKI_SEEN_MAX_BYTES): number {
  let dropped = 0;
  const sizeOf = (): number => Buffer.byteLength(JSON.stringify(file, null, 2), 'utf8');
  for (const s of Object.values(file.sources)) {
    if (!s) continue;
    const keys = Object.keys(s.docs);
    if (keys.length <= maxDocs) continue;
    keys.sort((a, b) => Date.parse(s.docs[a].at) - Date.parse(s.docs[b].at));
    for (const k of keys.slice(0, keys.length - maxDocs)) {
      delete s.docs[k];
      dropped++;
    }
  }
  let total = 0;
  for (const s of Object.values(file.sources)) total += Object.keys(s?.docs ?? {}).length;
  if (total < 20_000 && maxBytes >= WIKI_SEEN_MAX_BYTES) return dropped;
  while (sizeOf() > maxBytes) {
    const all: [SeenSource, string][] = [];
    for (const s of Object.values(file.sources)) if (s) for (const k of Object.keys(s.docs)) all.push([s, k]);
    if (all.length === 0) break;
    all.sort((a, b) => Date.parse(a[0].docs[a[1]].at) - Date.parse(b[0].docs[b[1]].at));
    for (const [s, k] of all.slice(0, Math.max(1, Math.floor(all.length / 10)))) {
      delete s.docs[k];
      dropped++;
    }
  }
  return dropped;
}

/** 깨진 파일을 옮길 이름: wiki-seen.broken-<시각>.json(있으면 -2, -3 …) */
function brokenPathFor(file: string): string {
  const dir = path.dirname(file);
  const stem = path.basename(file, '.json');
  const base = path.join(dir, `${stem}.broken-${compactStamp()}`);
  if (!fs.existsSync(`${base}.json`)) return `${base}.json`;
  for (let i = 2; ; i++) {
    const p = `${base}-${i}.json`;
    if (!fs.existsSync(p)) return p;
  }
}

/** wiki-seen.json 저장소. 바꾸기는 메모리에서 하고 flush() 가 쓴다(서비스가 2초 모아 부른다) */
export class WikiSeenStore {
  private readonly file: string;
  private readonly warn: (message: string) => void;
  private data: WikiSeenFile | null = null;
  private readError: string | null = null;
  private dirty = false;

  constructor(dataDir: string, opts: { warn?: (m: string) => void } = {}) {
    this.file = path.join(dataDir, WIKI_SEEN_FILE);
    this.warn = opts.warn ?? (() => {});
  }

  get filePath(): string {
    return this.file;
  }

  /** 읽지 못한 이유(있으면 — 그동안 쓰지 않는다) */
  get problem(): string | null {
    return this.readError;
  }

  get isDirty(): boolean {
    return this.dirty;
  }

  load(): WikiSeenFile {
    if (this.data) return this.data;
    let text: string;
    try {
      text = readTextFile(this.file);
    } catch (err) {
      const code = errCode(err);
      if (code === 'ENOENT') {
        this.readError = null;
        this.data = { version: 1, sources: {} };
        return this.data;
      }
      const message = `위키 읽음 기록(${WIKI_SEEN_FILE})을 읽지 못했습니다 (${code}) — 덮어쓰지 않도록 기록을 멈춥니다`;
      if (this.readError !== message) this.warn(message);
      this.readError = message;
      return { version: 1, sources: {} };
    }
    this.readError = null;
    let parsed: WikiSeenFile | null = null;
    let reason = '';
    try {
      parsed = parseWikiSeenFile(JSON.parse(text));
      if (!parsed) reason = '형식이 맞지 않음';
    } catch (err) {
      reason = text.trim() === '' ? '빈 파일' : `JSON 이 아님: ${errCode(err)}`;
    }
    if (!parsed) {
      const target = brokenPathFor(this.file);
      let moved = false;
      try {
        fs.renameSync(this.file, target);
        moved = true;
      } catch {
        try {
          fs.copyFileSync(this.file, target);
          moved = true;
        } catch {
          // 옮기지 못하면 경고만
        }
      }
      this.warn(
        `위키 읽음 기록(${WIKI_SEEN_FILE})이 깨져 있어 새 기준선으로 시작합니다. ` +
          (moved ? `원래 파일은 ${path.basename(target)} 로 옮겼습니다` : '원래 파일을 옮기지 못했습니다') +
          ` (원인: ${reason})`,
      );
      parsed = { version: 1, sources: {} };
      this.dirty = true;
    }
    this.data = parsed;
    return parsed;
  }

  source(source: WikiDocSource): SeenSource | undefined {
    return this.load().sources[source];
  }

  /** 쓸 수 있는가(읽기 실패면 한 번 더 읽어 본다) */
  writable(): boolean {
    if (this.readError) {
      this.data = null;
      this.load();
    }
    return this.readError === null;
  }

  /** 바꾸기. 쓸 수 없으면 던진다 */
  mutate(fn: (data: WikiSeenFile) => void): void {
    if (!this.writable()) throw new Error(this.readError ?? '위키 읽음 기록을 쓸 수 없습니다');
    fn(this.load());
    this.dirty = true;
  }

  /** 지금 쓴다(바뀐 것이 있을 때만). 실패하면 경고하고 다음에 다시 */
  flush(): void {
    if (!this.dirty || !this.data || this.readError) return;
    const dropped = pruneWikiSeen(this.data);
    if (dropped > 0) this.warn(`위키 읽음 기록이 한도를 넘어 오래된 항목 ${dropped}개를 버렸습니다`);
    try {
      writeJsonAtomic(this.file, this.data);
      this.dirty = false;
    } catch (err) {
      this.warn(err instanceof Error ? err.message : String(err));
    }
  }
}

// ---- 변경 기준 내용 --------------------------------------------------------------------------

export interface ChangeBase {
  /** 바뀜: 마지막으로 본 내용의 해시(= 읽음 기록 해시). 새 문서·지움은 없음 */
  baseHash?: string;
  /** 그 내용(256KB 까지). 없으면 줄 수 「모름」 */
  baseText?: string;
  /** 처음 감지한 시각(ISO) */
  detectedAt: string;
}

export interface ChangeBaseFile {
  version: 1;
  items: Record<string, ChangeBase>;
}

export function parseChangeBaseFile(value: unknown): ChangeBaseFile | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v.version !== 1 || !v.items || typeof v.items !== 'object' || Array.isArray(v.items)) return null;
  const items: Record<string, ChangeBase> = {};
  for (const [k, raw] of Object.entries(v.items as Record<string, unknown>)) {
    const r = raw as Record<string, unknown> | null;
    if (!r || typeof r !== 'object' || !/^(personal|team):/.test(k) || !isoOk(r.detectedAt)) continue;
    const b: ChangeBase = { detectedAt: r.detectedAt };
    if (typeof r.baseHash === 'string' && HASH_RE.test(r.baseHash)) b.baseHash = r.baseHash;
    if (typeof r.baseText === 'string') b.baseText = r.baseText;
    items[k] = b;
  }
  return { version: 1, items };
}

/** wiki-change-base.json 저장소(다시 만들 수 있는 정보 — 깨지면 경고하고 새로) */
export class ChangeBaseStore {
  private readonly file: string;
  private readonly warn: (message: string) => void;
  private data: ChangeBaseFile | null = null;
  private dirty = false;
  private blocked = false;

  constructor(dataDir: string, opts: { warn?: (m: string) => void } = {}) {
    this.file = path.join(dataDir, WIKI_CHANGE_BASE_FILE);
    this.warn = opts.warn ?? (() => {});
  }

  get items(): Record<string, ChangeBase> {
    return this.load().items;
  }

  load(): ChangeBaseFile {
    if (this.data) return this.data;
    let text: string;
    try {
      text = readTextFile(this.file);
    } catch (err) {
      const code = errCode(err);
      if (code !== 'ENOENT') {
        this.warn(`변경 기준 내용(${WIKI_CHANGE_BASE_FILE})을 읽지 못했습니다 (${code}) — 줄 수는 「모름」으로 보입니다`);
        this.blocked = true;
      }
      this.data = { version: 1, items: {} };
      return this.data;
    }
    let parsed: ChangeBaseFile | null = null;
    try {
      parsed = parseChangeBaseFile(JSON.parse(text));
    } catch {
      parsed = null;
    }
    if (!parsed) {
      this.warn(`변경 기준 내용(${WIKI_CHANGE_BASE_FILE})이 깨져 있어 새로 시작합니다 — 줄 수는 「모름」으로 보입니다`);
      parsed = { version: 1, items: {} };
      this.dirty = true;
    }
    this.data = parsed;
    return parsed;
  }

  touch(): void {
    this.dirty = true;
  }

  get isDirty(): boolean {
    return this.dirty;
  }

  flush(): void {
    if (!this.dirty || !this.data || this.blocked) return;
    try {
      writeJsonAtomic(this.file, this.data);
      this.dirty = false;
    } catch (err) {
      this.warn(err instanceof Error ? err.message : String(err));
    }
  }
}

// ---- 줄 수 ----------------------------------------------------------------------------------

/** 줄 단위 다중집합 차이(§5-4): 앞뒤 공백을 뗀 빈 줄 아닌 줄 */
export function lineDiff(baseText: string, curText: string): { added: number; removed: number; sample: string[] } {
  const count = new Map<string, number>();
  for (const l of baseText.split('\n')) {
    const t = l.trim();
    if (t) count.set(t, (count.get(t) ?? 0) + 1);
  }
  let added = 0;
  const sample: string[] = [];
  for (const l of curText.split('\n')) {
    const t = l.trim();
    if (!t) continue;
    const n = count.get(t) ?? 0;
    if (n > 0) {
      count.set(t, n - 1);
    } else {
      added++;
      if (sample.length < SAMPLE_MAX) {
        const chars = Array.from(t);
        sample.push(chars.length > SAMPLE_LEN ? `${chars.slice(0, SAMPLE_LEN).join('')}…` : t);
      }
    }
  }
  let removed = 0;
  for (const n of count.values()) removed += n;
  return { added, removed, sample };
}

/** 본문 첫 80자(줄바꿈은 공백) */
export function firstLineOf(body: string): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  const chars = Array.from(flat);
  return chars.length > FIRST_LINE_LEN ? `${chars.slice(0, FIRST_LINE_LEN).join('')}…` : flat;
}

// ---- 기준선·관찰·판정 -------------------------------------------------------------------------

/** 기준선(§5-2): 지금 있는 문서 전부를 읽음으로 */
export function makeBaseline(root: string, entries: Iterable<WikiDocEntry>, nowIso: string): SeenSource {
  const docs: Record<string, SeenDoc> = {};
  for (const e of entries) {
    if (!e.hash || isChangeExcluded(e.source, e.path)) continue;
    docs[e.path] = { hash: e.hash, at: nowIso };
  }
  return { root, baselineAt: nowIso, docs };
}

function textBytes(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

export interface ObserveInput {
  source: WikiDocSource;
  /** 지난 색인(캐시·메모리) — 기준 내용을 잡는 데 쓴다 */
  prev: ReadonlyMap<string, WikiDocEntry> | null;
  next: ReadonlyMap<string, WikiDocEntry>;
  seen: SeenSource;
  base: Record<string, ChangeBase>;
  nowIso: string;
}

/**
 * 색인 뒤 관찰(§5-4): 새로 감지한 변경에 처음 감지 시각과 (바뀜이면) 이전 본문을 기준 내용으로 적고,
 * 읽음 해시로 돌아간 문서·없어진 변경의 기준 내용은 지운다. 바뀌었으면 true 와 새로 감지한 수.
 */
export function observeIndex(input: ObserveInput): { changed: boolean; detected: number } {
  const { source, prev, next, seen, base } = input;
  let detectedAt = input.nowIso;
  // 팀: 감지 시각이 cutoff 와 같으면 보이게 되므로 cutoff 뒤로 민다(§5-3)
  if (source === 'team' && seen.teamCutoffAt && Date.parse(detectedAt) <= Date.parse(seen.teamCutoffAt)) {
    detectedAt = new Date(Date.parse(seen.teamCutoffAt) + 1).toISOString();
  }
  let changed = false;
  let detected = 0;
  let totalBytes = 0;
  for (const b of Object.values(base)) if (b.baseText) totalBytes += b.baseText.length * 2;
  const live = new Set<string>();

  for (const e of next.values()) {
    if (!e.hash || isChangeExcluded(source, e.path)) continue;
    const key = wikiDocKey(source, e.path);
    const s = seen.docs[e.path];
    if (s && s.hash === e.hash) continue; // 읽음 그대로(되돌림이면 아래에서 기준 내용을 지운다)
    live.add(key);
    const cur = base[key];
    if (!s) {
      if (!cur || cur.baseHash !== undefined) {
        base[key] = { detectedAt };
        changed = true;
        detected++;
      }
      continue;
    }
    if (cur && cur.baseHash === s.hash) continue;
    const p = prev?.get(e.path);
    const b: ChangeBase = { baseHash: s.hash, detectedAt: cur?.detectedAt ?? detectedAt };
    if (p && p.hash === s.hash && typeof p.body === 'string' && p.problem !== PROBLEM_BIG) {
      const bytes = textBytes(p.body);
      if (bytes <= WIKI_BASE_DOC_MAX_BYTES && totalBytes + bytes <= WIKI_BASE_TOTAL_MAX_BYTES) {
        b.baseText = p.body;
        totalBytes += bytes;
      }
    }
    base[key] = b;
    changed = true;
    if (!cur) detected++;
  }
  for (const p of Object.keys(seen.docs)) {
    if (next.has(p) || isChangeExcluded(source, p)) continue;
    const key = wikiDocKey(source, p);
    live.add(key);
    if (!base[key] || base[key].baseHash !== undefined) {
      base[key] = { detectedAt };
      changed = true;
      detected++;
    }
  }
  // 변경이 아닌 것(읽음으로 돌아감·지운 새 문서)의 기준 내용은 지운다
  const prefix = `${source}:`;
  for (const key of Object.keys(base)) {
    if (key.startsWith(prefix) && !live.has(key)) {
      delete base[key];
      changed = true;
    }
  }
  return { changed, detected };
}

export interface ListChangesInput {
  source: WikiDocSource;
  entries: ReadonlyMap<string, WikiDocEntry>;
  seen: SeenSource;
  base: Readonly<Record<string, ChangeBase>>;
  /** 개인: 이유(경로, 기준 날짜) */
  reasons?: (path: string, sinceDate: string) => WikiLogReason[];
  /** ISO → 로컬 YYYY-MM-DD */
  localDate: (iso: string) => string;
}

function localDateOr(localDate: (iso: string) => string, iso: string): string {
  try {
    return localDate(iso);
  } catch {
    return '0000-00-00';
  }
}

/**
 * 변경 항목(§5-3) — 처음 감지한 시각 최근 순(같으면 mtime 최근 순). 팀은 detectedAt ≤ teamCutoffAt 만.
 */
export function listChanges(input: ListChangesInput): WikiChangeItem[] {
  const { source, entries, seen, base } = input;
  const cutoff = source === 'team' ? (seen.teamCutoffAt ? Date.parse(seen.teamCutoffAt) : -Infinity) : Infinity;
  const items: WikiChangeItem[] = [];
  const visible = (detectedAt: string): boolean => Date.parse(detectedAt) <= cutoff;
  for (const e of entries.values()) {
    if (!e.hash || isChangeExcluded(source, e.path)) continue;
    const s = seen.docs[e.path];
    if (s && s.hash === e.hash) continue;
    const b = base[wikiDocKey(source, e.path)];
    const detectedAt = b?.detectedAt ?? seen.baselineAt;
    if (!visible(detectedAt)) continue;
    const item: WikiChangeItem = {
      source,
      path: e.path,
      title: e.title,
      kind: e.kind,
      private: e.private,
      mtimeMs: e.mtimeMs,
      change: s ? 'changed' : 'new',
      detectedAt,
    };
    if (s) {
      item.lines = b && b.baseHash === s.hash && typeof b.baseText === 'string' && e.problem !== PROBLEM_BIG ? lineDiff(b.baseText, e.body ?? '') : null;
    } else {
      item.firstLine = firstLineOf(e.body ?? '');
    }
    if (source === 'personal' && input.reasons) {
      const since = localDateOr(input.localDate, s?.at ?? seen.baselineAt);
      item.reasons = input.reasons(e.path, since);
    }
    items.push(item);
  }
  for (const [p, s] of Object.entries(seen.docs)) {
    if (entries.has(p) || isChangeExcluded(source, p)) continue;
    const b = base[wikiDocKey(source, p)];
    const detectedAt = b?.detectedAt ?? seen.baselineAt;
    if (!visible(detectedAt)) continue;
    const item: WikiChangeItem = {
      source,
      path: p,
      title: docNameOf(p),
      kind: docKindOf(source, p),
      private: source === 'personal' && p.startsWith('_private/'),
      mtimeMs: 0,
      change: 'deleted',
      detectedAt,
    };
    if (source === 'personal' && input.reasons) item.reasons = input.reasons(p, localDateOr(input.localDate, s.at));
    items.push(item);
  }
  items.sort(
    (a, b) =>
      (a.detectedAt < b.detectedAt ? 1 : a.detectedAt > b.detectedAt ? -1 : 0) ||
      b.mtimeMs - a.mtimeMs ||
      compareCodeUnits(a.path, b.path),
  );
  return items;
}

/** 읽음으로(§5-7): 지금 색인 해시를 적고(색인에 없으면 기록에서 지운다) 기준 내용을 지운다. 바뀐 수 */
export function markSeenPaths(
  source: WikiDocSource,
  paths: Iterable<string>,
  entries: ReadonlyMap<string, WikiDocEntry>,
  seen: SeenSource,
  base: Record<string, ChangeBase>,
  nowIso: string,
): number {
  let n = 0;
  for (const p of paths) {
    const e = entries.get(p);
    const before = seen.docs[p];
    if (e && e.hash) {
      if (!before || before.hash !== e.hash) {
        seen.docs[p] = { hash: e.hash, at: nowIso };
        n++;
      }
    } else if (!e && before) {
      delete seen.docs[p];
      n++;
    }
    const key = wikiDocKey(source, p);
    if (base[key]) {
      delete base[key];
      n++;
    }
  }
  return n;
}
