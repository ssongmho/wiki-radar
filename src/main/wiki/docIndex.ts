// 위키 문서 증분 색인(docs/stage3a-contract.md §1-2·§2). electron 을 import 하지 않는 순수 모듈이다.
//
// - 개인 위키: 1단계 제외 폴더(EXCLUDED_DIRS — raw·_mail-ingest 등) + `.` 으로 시작하는 폴더 + templates·_templates 를 뺀다.
// - 팀 위키 사본: 2.9 팀 할 일과 같은 규칙(isTeamSkippedDir + isTeamExcluded — 휴지통·충돌 사본·템플릿 폴더).
// - 걷기 + stat 만 하고 캐시의 (경로, 크기, mtime) 가 같으면 다시 읽지 않는다(2.10 mailIndex 와 같은 방식).
// - 위키는 읽기만 한다. 캐시는 앱 데이터 폴더(wiki-index.json)에만 쓴다.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { WikiDocFm, WikiDocKind, WikiDocSource } from '../../shared/types';
import { isWikiImageName } from '../../shared/wikiDocs';
import { scalarToString, splitFrontmatter } from './frontmatter';
import { EXCLUDED_DIRS, READ_RETRY_DELAYS_MS, TRANSIENT_READ_ERRORS, compareCodeUnits, errCode, stripBom } from './fsutil';
import { nodeMailFs, type MailDirEntry } from './mailIndex';
import { isTeamExcluded, isTeamSkippedDir, readTemplateFolder } from './teamTasks';
import { maskCode, outgoingLinks } from './wikiLinks';

/** 본문을 색인하는 파일 크기 한도(§1-2) */
export const WIKI_BODY_MAX_BYTES = 2 * 1024 * 1024;
/** 이보다 큰 파일은 읽지도 않는다(해시는 크기·mtime 으로) */
export const WIKI_READ_MAX_BYTES = 64 * 1024 * 1024;
/** 읽기 동시 개수(§2-2) */
export const DOC_INDEX_CONCURRENCY = 16;
/** frontmatter 문자열 자르기 */
const FM_STR_MAX = 200;
const FM_LIST_MAX = 20;
/** 제목 H1 을 찾는 앞 줄 수 */
const TITLE_SCAN_LINES = 40;

export const PROBLEM_FM = 'frontmatter 를 읽지 못함';
export const PROBLEM_BIG = '파일이 커서 본문을 색인하지 않음';
export const PROBLEM_UNREADABLE = '파일을 읽지 못함';

/** 색인 항목(§2-1) */
export interface WikiDocEntry {
  source: WikiDocSource;
  /** 출처 루트 기준 '/' 상대경로(NFC) */
  path: string;
  /** 파일 시스템의 실제 이름이 NFC 와 다를 때만(macOS 에서 온 NFD 이름 등) */
  fsPath?: string;
  size: number;
  mtimeMs: number;
  /** sha1(BOM 떼고 CRLF/CR → LF 한 원문). 처음부터 못 읽은 파일은 '' */
  hash: string;
  title: string;
  kind: WikiDocKind;
  private: boolean;
  fm: WikiDocFm;
  /** frontmatter 를 뗀 본문(NFC). 큰 파일은 '' */
  body: string;
  /** 나가는 위키링크 대상 이름(중복 없이, 최대 500) */
  links: string[];
  problem?: string;
}

// ---- 파일 시스템(시험에서 바꿔 끼운다) --------------------------------------------------------

export interface DocFs {
  readdir(abs: string): Promise<MailDirEntry[]>;
  stat(abs: string): Promise<{ size: number; mtimeMs: number; isFile: boolean }>;
  readFile(abs: string): Promise<Buffer>;
  realpath(abs: string): Promise<string>;
}

export const nodeDocFs: DocFs = {
  readdir: (abs) => nodeMailFs.readdir(abs),
  stat: (abs) => nodeMailFs.stat(abs),
  readFile: (abs) => fs.promises.readFile(abs),
  realpath: (abs) => fs.promises.realpath(abs),
};

// ---- 제외 규칙 -------------------------------------------------------------------------------

const PERSONAL_EXTRA_SKIP = new Set(['templates', '_templates']);

/** 개인 위키 색인에서 빼는 폴더 이름(어디에 있든) */
export function isPersonalSkippedDir(name: string): boolean {
  return EXCLUDED_DIRS.has(name) || name.startsWith('.') || PERSONAL_EXTRA_SKIP.has(name.toLowerCase());
}

/** 상대경로가 그 출처의 색인 대상 폴더 안인가(파일 이름은 보지 않는다) */
export function isIndexedDirPath(source: WikiDocSource, rel: string, templateFolder: string | null = null): boolean {
  const segs = rel.split('/');
  const dirs = segs.slice(0, -1);
  if (source === 'personal') return !dirs.some(isPersonalSkippedDir);
  if (dirs.some(isTeamSkippedDir)) return false;
  return !isTeamExcluded(rel, templateFolder);
}

/** 개인 문서 종류(§1-3) */
export function docKindOf(source: WikiDocSource, rel: string): WikiDocKind {
  if (source === 'team') return 'team';
  if (rel.startsWith('wiki/entities/')) return 'entity';
  if (rel.startsWith('wiki/topics/')) return 'topic';
  if (rel.startsWith('wiki/analysis/')) return 'analysis';
  if (rel.startsWith('_private/')) return 'private';
  if (rel === 'log.md' || rel === 'index.md') return 'meta';
  return 'other';
}

// ---- 항목 파서 -------------------------------------------------------------------------------

export function sha1Hex(text: string): string {
  return createHash('sha1').update(text, 'utf8').digest('hex');
}

/** BOM 떼고 줄바꿈을 LF 로 */
export function normalizeNewlines(text: string): string {
  return stripBom(text).replace(/\r\n?/g, '\n');
}

/** UTF-16 단위로 max 까지 자른다 — 끝에 남은 짝 없는 high surrogate 는 뗀다(글자가 깨져 보이지 않게) */
export function cutUnits(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = s.slice(0, max);
  const last = head.charCodeAt(head.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? head.slice(0, -1) : head;
}

function cut(s: string): string {
  return cutUnits(s, FM_STR_MAX);
}

function fmString(v: unknown): string | undefined {
  if (Array.isArray(v)) {
    const parts = v.map(scalarToString).filter((x): x is string => !!x && x.trim() !== '');
    return parts.length > 0 ? cut(parts.join(', ')) : undefined;
  }
  const s = scalarToString(v);
  return s !== undefined && s.trim() !== '' ? cut(s.trim()) : undefined;
}

function fmList(v: unknown, stripHash: boolean): string[] | undefined {
  const raw = Array.isArray(v) ? v : v === undefined || v === null ? [] : [v];
  const out: string[] = [];
  for (const x of raw) {
    let s = scalarToString(x)?.trim();
    if (!s) continue;
    if (stripHash) s = s.replace(/^#+/, '').trim();
    if (!s) continue;
    s = cut(s.normalize('NFC'));
    if (!out.includes(s)) out.push(s);
    if (out.length >= FM_LIST_MAX) break;
  }
  return out.length > 0 ? out : undefined;
}

/** frontmatter 객체 → 일부(§2-1) */
export function pickFm(data: Record<string, unknown> | null): WikiDocFm {
  if (!data) return {};
  const fm: WikiDocFm = {};
  const type = fmString(data.type);
  if (type) fm.type = type;
  const domain = fmString(data.domain);
  if (domain) fm.domain = domain;
  const updated = fmString(data.updated);
  if (updated) fm.updated = updated.length > 10 && /^\d{4}-\d{2}-\d{2}T/.test(updated) ? updated.slice(0, 10) : updated;
  const tags = fmList(data.tags, true);
  if (tags) fm.tags = tags;
  const aliases = fmList(data.aliases ?? data.alias, false);
  if (aliases) fm.aliases = aliases;
  const scope = fmString(data['공개범위']) ?? fmString(data.access);
  if (scope) fm.scope = scope;
  return fm;
}

/** 파일 이름(.md 뗌) */
export function docNameOf(rel: string): string {
  return path.posix.basename(rel).replace(/\.md$/i, '');
}

/** 본문 앞 40줄(코드 블록 밖)의 첫 `# ` H1 */
export function firstH1(body: string): string | undefined {
  const masked = maskCode(body.split('\n').slice(0, TITLE_SCAN_LINES).join('\n'));
  for (const line of masked.split('\n')) {
    const m = /^ {0,3}#[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line);
    if (m && m[1].trim()) return m[1].trim();
  }
  return undefined;
}

export type ParsedDoc = Omit<WikiDocEntry, 'size' | 'mtimeMs' | 'fsPath'>;

/**
 * 원문 → 항목(§2-1). bodyIndexed=false 면(큰 파일) 본문을 들고 있지 않는다 — 제목·frontmatter 는 앞부분에서.
 */
export function parseDocText(source: WikiDocSource, rel: string, raw: string, bodyIndexed = true): ParsedDoc {
  const text = normalizeNewlines(raw);
  const hash = sha1Hex(text);
  const head = bodyIndexed ? text : text.slice(0, 64 * 1024);
  const lines = head.split('\n');
  const split = splitFrontmatter(lines);
  let problem: string | undefined;
  let fm: WikiDocFm = {};
  let fmTitle: string | undefined;
  if (split.present && split.error) {
    problem = PROBLEM_FM;
  } else if (split.data) {
    fm = pickFm(split.data);
    const t = scalarToString(split.data.title)?.trim();
    if (t) fmTitle = cut(t.normalize('NFC'));
  }
  const body = split.bodyLines.join('\n').normalize('NFC');
  const title = fmTitle ?? firstH1(body)?.normalize('NFC') ?? docNameOf(rel).normalize('NFC');
  const entry: ParsedDoc = {
    source,
    path: rel,
    hash,
    title,
    kind: docKindOf(source, rel),
    private: source === 'personal' && rel.startsWith('_private/'),
    fm,
    body: bodyIndexed ? body : '',
    links: bodyIndexed ? outgoingLinks(body) : [],
  };
  if (!bodyIndexed) problem = PROBLEM_BIG;
  if (problem) entry.problem = problem;
  return entry;
}

// ---- 걷기 -----------------------------------------------------------------------------------

export interface WikiImageFile {
  path: string;
  size: number;
}

/** 그림 사전(§2-4): 파일 이름(소문자, NFC) → 그림들 · 경로(소문자) → 그림 */
export interface ImageDict {
  byName: Map<string, WikiImageFile[]>;
  byPath: Map<string, WikiImageFile>;
}

export function emptyImageDict(): ImageDict {
  return { byName: new Map(), byPath: new Map() };
}

interface WalkOut {
  docs: { rel: string; fsRel: string }[];
  images: { rel: string; fsRel: string }[];
  errors: string[];
}

async function walkSource(root: string, source: WikiDocSource, dfs: DocFs, templateFolder: string | null): Promise<WalkOut> {
  const out: WalkOut = { docs: [], images: [], errors: [] };
  const skipDir = source === 'personal' ? isPersonalSkippedDir : isTeamSkippedDir;
  let pending: string[] = [''];
  while (pending.length > 0) {
    const batch = pending;
    pending = [];
    await runLimited(batch, DOC_INDEX_CONCURRENCY, async (relDir) => {
      const absDir = relDir === '' ? root : path.join(root, ...relDir.split('/'));
      let ents: MailDirEntry[];
      try {
        ents = await dfs.readdir(absDir);
      } catch (err) {
        if (relDir === '') throw err;
        out.errors.push(`폴더를 읽지 못함: ${relDir} (${errCode(err)})`);
        return;
      }
      for (const ent of ents) {
        const fsRel = relDir === '' ? ent.name : `${relDir}/${ent.name}`;
        if (ent.isDir) {
          if (!skipDir(ent.name)) pending.push(fsRel);
          continue;
        }
        if (!ent.isFile) continue;
        const rel = fsRel.normalize('NFC');
        if (source === 'team' && isTeamExcluded(rel, templateFolder)) continue;
        const lower = ent.name.toLowerCase();
        if (lower.endsWith('.md') && lower.length > 3) out.docs.push({ rel, fsRel });
        else if (isWikiImageName(lower)) out.images.push({ rel, fsRel });
      }
    });
  }
  out.docs.sort((a, b) => compareCodeUnits(a.rel, b.rel));
  out.images.sort((a, b) => compareCodeUnits(a.rel, b.rel));
  return out;
}

/** 동시 n 개까지 */
export async function runLimited<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failed: unknown = null;
  const worker = async (): Promise<void> => {
    while (next < items.length && failed === null) {
      const i = next++;
      try {
        await fn(items[i]);
      } catch (err) {
        failed ??= err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  if (failed !== null) throw failed;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 일시적 오류는 짧게 다시 읽는다(2.10 과 같은 간격) */
export async function readWithRetry(dfs: DocFs, abs: string, delays: readonly number[] = READ_RETRY_DELAYS_MS): Promise<Buffer> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await dfs.readFile(abs);
    } catch (err) {
      if (attempt >= delays.length || !TRANSIENT_READ_ERRORS.has(errCode(err))) throw err;
      await sleep(delays[attempt]);
    }
  }
}

// ---- 증분 색인 -------------------------------------------------------------------------------

export interface DocIndexStats {
  files: number;
  read: number;
  reused: number;
  removed: number;
  problems: number;
  ms: number;
}

export interface BuildDocIndexOptions {
  source: WikiDocSource;
  root: string;
  /** 지난 색인의 항목(캐시·메모리) */
  cache?: Iterable<WikiDocEntry>;
  fs?: DocFs;
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
  warn?: (message: string) => void;
  clock?: () => number;
  /** 시험용 — 재시도 간격 */
  retryDelays?: readonly number[];
}

export interface DocIndexResult {
  /** 경로순 */
  entries: WikiDocEntry[];
  images: ImageDict;
  stats: DocIndexStats;
}

/** 루트 폴더가 없을 때 */
export class DocRootMissingError extends Error {
  constructor(root: string) {
    super(`폴더가 없습니다: ${root}`);
    this.name = 'DocRootMissingError';
  }
}

/**
 * 증분 색인(§2-2). 걷기 + stat 만 하고, 캐시의 (경로, 크기, mtime) 가 같고 본문이 있으면 다시 읽지 않는다.
 * 못 읽은 파일은 이전 항목을 그대로 두고 problem 만 단다(잠깐 잠긴 파일이 「지움」으로 보이지 않게).
 */
export async function buildDocIndex(opts: BuildDocIndexOptions): Promise<DocIndexResult> {
  const clock = opts.clock ?? (() => Date.now());
  const started = clock();
  const dfs = opts.fs ?? nodeDocFs;
  const warn = opts.warn ?? (() => {});
  const concurrency = opts.concurrency ?? DOC_INDEX_CONCURRENCY;
  const root = path.resolve(opts.root);
  const templateFolder = opts.source === 'team' ? readTemplateFolder(root) : null;

  let walked: WalkOut;
  try {
    walked = await walkSource(root, opts.source, dfs, templateFolder);
  } catch (err) {
    const code = errCode(err);
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new DocRootMissingError(root);
    throw new Error(`폴더를 읽지 못했습니다 (${code})`);
  }
  for (const e of walked.errors.slice(0, 5)) warn(e);

  const cacheByPath = new Map<string, WikiDocEntry>();
  for (const e of opts.cache ?? []) if (e && typeof e.path === 'string') cacheByPath.set(e.path, e);

  // 1) stat → 캐시 판정
  const kept: WikiDocEntry[] = [];
  const toRead: { rel: string; fsRel: string; size: number; mtimeMs: number }[] = [];
  await runLimited(walked.docs, concurrency * 4, async ({ rel, fsRel }) => {
    let st: { size: number; mtimeMs: number; isFile: boolean };
    try {
      st = await dfs.stat(path.join(root, ...fsRel.split('/')));
    } catch {
      return; // 그사이 지워짐
    }
    if (!st.isFile) return;
    const hit = cacheByPath.get(rel);
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs && typeof hit.body === 'string' && !hit.problem?.startsWith(PROBLEM_UNREADABLE)) {
      kept.push(hit);
    } else {
      toRead.push({ rel, fsRel, size: st.size, mtimeMs: st.mtimeMs });
    }
  });
  const present = new Set(walked.docs.map((d) => d.rel));
  let removed = 0;
  for (const p of cacheByPath.keys()) if (!present.has(p)) removed++;

  // 2) 새 파일·바뀐 파일만 읽는다
  let done = 0;
  opts.onProgress?.(0, toRead.length);
  const fresh: WikiDocEntry[] = [];
  await runLimited(toRead, concurrency, async ({ rel, fsRel, size, mtimeMs }) => {
    const abs = path.join(root, ...fsRel.split('/'));
    const prev = cacheByPath.get(rel);
    try {
      let parsed: ParsedDoc;
      if (size > WIKI_READ_MAX_BYTES) {
        parsed = {
          source: opts.source,
          path: rel,
          hash: sha1Hex(`size:${size}:${mtimeMs}`),
          title: docNameOf(rel),
          kind: docKindOf(opts.source, rel),
          private: opts.source === 'personal' && rel.startsWith('_private/'),
          fm: {},
          body: '',
          links: [],
          problem: PROBLEM_BIG,
        };
      } else {
        const buf = await readWithRetry(dfs, abs, opts.retryDelays);
        parsed = parseDocText(opts.source, rel, buf.toString('utf8'), buf.length <= WIKI_BODY_MAX_BYTES);
      }
      const entry: WikiDocEntry = { ...parsed, size, mtimeMs };
      if (fsRel !== rel) entry.fsPath = fsRel;
      fresh.push(entry);
    } catch (err) {
      const problem = `${PROBLEM_UNREADABLE} (${errCode(err)})`;
      warn(`위키 문서를 읽지 못함: ${opts.source === 'team' ? '팀 ' : ''}${rel} (${errCode(err)})`);
      if (prev) {
        // 이전 항목 그대로(크기·mtime 도 이전 값 — 다음 색인에서 다시 읽는다)
        fresh.push({ ...prev, problem });
      } else {
        const entry: WikiDocEntry = {
          source: opts.source,
          path: rel,
          size,
          mtimeMs,
          hash: '',
          title: docNameOf(rel),
          kind: docKindOf(opts.source, rel),
          private: opts.source === 'personal' && rel.startsWith('_private/'),
          fm: {},
          body: '',
          links: [],
          problem,
        };
        if (fsRel !== rel) entry.fsPath = fsRel;
        fresh.push(entry);
      }
    } finally {
      done++;
      opts.onProgress?.(done, toRead.length);
    }
  });

  const entries = [...kept, ...fresh].sort((a, b) => compareCodeUnits(a.path, b.path));

  // 3) 그림 사전 — 경로·크기만(내용은 읽지 않는다)
  const images = emptyImageDict();
  for (const img of walked.images) {
    let size = 0;
    try {
      const st = await dfs.stat(path.join(root, ...img.fsRel.split('/')));
      if (!st.isFile) continue;
      size = st.size;
    } catch {
      continue;
    }
    const file: WikiImageFile = { path: img.fsRel, size };
    images.byPath.set(img.rel.toLowerCase(), file);
    const name = path.posix.basename(img.rel).toLowerCase();
    const arr = images.byName.get(name);
    if (arr) arr.push(file);
    else images.byName.set(name, [file]);
  }

  return {
    entries,
    images,
    stats: {
      files: entries.length,
      read: fresh.length,
      reused: kept.length,
      removed,
      problems: entries.filter((e) => e.problem).length,
      ms: clock() - started,
    },
  };
}

// ---- 캐시 파일 -------------------------------------------------------------------------------

export const WIKI_INDEX_FILE = 'wiki-index.json';
export const WIKI_INDEX_VERSION = 1;
/** 캐시가 이보다 크면 본문 없이 쓴다(§2-2) */
export const WIKI_INDEX_MAX_BYTES = 64 * 1024 * 1024;

export interface WikiIndexCacheSource {
  root: string;
  builtAt: string;
  entries: WikiDocEntry[];
}

export interface WikiIndexCacheFile {
  version: 1;
  sources: Partial<Record<WikiDocSource, WikiIndexCacheSource>>;
}

const KINDS: ReadonlySet<string> = new Set(['entity', 'topic', 'analysis', 'private', 'meta', 'other', 'team']);

function isStrArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/** 캐시 항목 하나의 모양 검사(틀리면 null — 그 파일은 다시 읽는다). body 가 없으면(큰 캐시) body: undefined 로 둔다 */
function toCacheEntry(source: WikiDocSource, raw: unknown): WikiDocEntry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.source !== source || typeof r.path !== 'string' || r.path.length > 1024) return null;
  if (typeof r.size !== 'number' || typeof r.mtimeMs !== 'number') return null;
  if (typeof r.hash !== 'string' || typeof r.title !== 'string' || typeof r.kind !== 'string' || !KINDS.has(r.kind)) return null;
  if (typeof r.private !== 'boolean' || !isStrArray(r.links)) return null;
  if (!r.fm || typeof r.fm !== 'object' || Array.isArray(r.fm)) return null;
  const fm = r.fm as Record<string, unknown>;
  for (const k of ['type', 'domain', 'updated', 'scope'] as const) if (fm[k] !== undefined && typeof fm[k] !== 'string') return null;
  for (const k of ['tags', 'aliases'] as const) if (fm[k] !== undefined && !isStrArray(fm[k])) return null;
  if (r.body !== undefined && typeof r.body !== 'string') return null;
  if (r.problem !== undefined && typeof r.problem !== 'string') return null;
  if (r.fsPath !== undefined && typeof r.fsPath !== 'string') return null;
  return raw as WikiDocEntry;
}

/**
 * 캐시 읽기. 없거나 깨졌거나 버전이 다르면 빈 것. 출처의 root 가 다르면 그 출처는 버린다(다시 만들 수 있는 캐시라 옮기지 않는다).
 * roots: 지금 쓰는 출처별 루트(없는 출처는 버린다)
 */
export function loadWikiIndexCache(file: string, roots: Partial<Record<WikiDocSource, string>>): Partial<Record<WikiDocSource, WikiIndexCacheSource>> {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return {};
  }
  try {
    const data = JSON.parse(stripBom(text)) as Partial<WikiIndexCacheFile>;
    if (!data || data.version !== WIKI_INDEX_VERSION || !data.sources || typeof data.sources !== 'object') return {};
    const out: Partial<Record<WikiDocSource, WikiIndexCacheSource>> = {};
    for (const source of ['personal', 'team'] as const) {
      const s = data.sources[source] as Partial<WikiIndexCacheSource> | undefined;
      const want = roots[source];
      if (!s || !want || typeof s.root !== 'string' || path.resolve(s.root) !== path.resolve(want) || !Array.isArray(s.entries)) continue;
      out[source] = {
        root: s.root,
        builtAt: typeof s.builtAt === 'string' ? s.builtAt : '',
        entries: s.entries.map((e) => toCacheEntry(source, e)).filter((e): e is WikiDocEntry => e !== null),
      };
    }
    return out;
  } catch {
    return {};
  }
}

/** 캐시 내용. 크기가 한도를 넘으면 본문을 뺀다 */
export function wikiIndexCacheOf(sources: Partial<Record<WikiDocSource, WikiIndexCacheSource>>, maxBytes = WIKI_INDEX_MAX_BYTES): { file: WikiIndexCacheFile; withoutBody: boolean } {
  const file: WikiIndexCacheFile = { version: 1, sources };
  let bytes = 0;
  for (const s of Object.values(sources)) for (const e of s?.entries ?? []) bytes += (e.body ?? '').length * 3 + 400;
  if (bytes <= maxBytes) return { file, withoutBody: false };
  const stripped: Partial<Record<WikiDocSource, WikiIndexCacheSource>> = {};
  for (const [k, s] of Object.entries(sources) as [WikiDocSource, WikiIndexCacheSource][]) {
    stripped[k] = { ...s, entries: s.entries.map(({ body: _body, ...rest }) => rest as WikiDocEntry) };
  }
  return { file: { version: 1, sources: stripped }, withoutBody: true };
}
