// 위키 검색·변경 화면(3a단계 명세 §8·§10)의 순수 도우미: 요약 정리 · 내비/사이드바 수 · 강조 조각 나누기 · 날짜 묶음 · 칩 글자 · 키 판정.
// DOM·Node 없음(vitest 로 시험).
import type {
  WikiChangeItem,
  WikiDocInput,
  WikiDocKind,
  WikiDocSource,
  WikiDocsSummary,
  WikiSearchSource,
  WikiSourceInfo,
  WikiSourceState,
} from '../../shared/types';
import { normText } from '../../shared/wikiDocs';
import { formatClock, localYmd, parseYmd } from './date';

/** 검색 칸 입력 뒤 질의까지(§8-2) */
export const WIKI_SEARCH_DELAY_MS = 150;
/** 미리보기에 이만큼 보이면 읽음(§5-7 — 메일과 같다) */
export const WIKI_READ_DELAY_MS = 1000;
/** [모두 읽음] 뒤 [되돌리기] 줄이 보이는 시간 */
export const WIKI_UNDO_MS = 12_000;
/** 검색 결과 한 번에 · 최대 */
export const WIKI_PAGE_SIZE = 50;
export const WIKI_MAX_RESULTS = 200;
/** 빈 질의 화면의 최근 바뀐 문서 수 */
export const WIKI_RECENT_COUNT = 10;
/** 미리보기 안 이동 기록 */
export const WIKI_HISTORY_MAX = 30;
/** 한 번에 불러오는 그림 수 */
export const WIKI_IMAGE_BATCH = 20;
/** 화면을 열 때 마지막 색인이 이보다 오래면 한 번 더 확인(§3-1) */
export const WIKI_RECHECK_MS = 60_000;

const STATES: readonly WikiSourceState[] = ['noWiki', 'off', 'problem', 'missing', 'indexing', 'ready', 'error'];
/** 쓸 수 없는 출처 상태(색인할 것이 없다) */
const UNUSABLE: ReadonlySet<WikiSourceState> = new Set(['noWiki', 'off', 'problem', 'missing']);

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined);

function normalizeInfo(raw: unknown): WikiSourceInfo {
  const r = isRecord(raw) ? raw : {};
  const state = STATES.includes(r.state as WikiSourceState) ? (r.state as WikiSourceState) : 'error';
  const out: WikiSourceInfo = { state, docs: Math.max(0, num(r.docs)) };
  const problem = str(r.problem);
  if (problem) out.problem = problem;
  const indexedAt = str(r.indexedAt);
  if (indexedAt) out.indexedAt = indexedAt;
  if (r.stale === true) out.stale = true;
  if (isRecord(r.progress)) out.progress = { done: num(r.progress.done), total: num(r.progress.total) };
  return out;
}

/** main 이 보낸 요약을 믿을 수 있는 모양으로(옛 preload·깨진 값이면 null) */
export function normalizeWikiSummary(raw: unknown): WikiDocsSummary | null {
  if (!isRecord(raw) || !isRecord(raw.sources) || !isRecord(raw.changes)) return null;
  const personal = Math.max(0, num(raw.changes.personal));
  const team = Math.max(0, num(raw.changes.team));
  return {
    sources: { personal: normalizeInfo(raw.sources.personal), team: normalizeInfo(raw.sources.team) },
    changes: { personal, team, total: personal + team },
    revision: num(raw.revision),
  };
}

/** 그 출처를 쓸 수 있는가(색인 중·오류여도 쓸 수 있다 — 꺼짐·폴더 없음만 아님) */
export function sourceUsable(info: WikiSourceInfo | undefined): boolean {
  return !!info && !UNUSABLE.has(info.state);
}

const SOURCE_REASON: Partial<Record<WikiSourceState, string>> = {
  noWiki: '개인 위키가 없습니다',
  off: '팀 위키 동기화가 꺼져 있습니다',
  missing: '팀 위키 사본 폴더가 없습니다',
};

/** 쓸 수 없는 출처의 이유(쓸 수 있으면 null) */
export function sourceReason(info: WikiSourceInfo | undefined, source: WikiDocSource): string | null {
  if (!info) return null;
  if (!UNUSABLE.has(info.state)) return null;
  return info.problem ?? SOURCE_REASON[info.state] ?? (source === 'team' ? '팀 위키를 쓸 수 없습니다' : '개인 위키를 쓸 수 없습니다');
}

/** 두 출처 모두 쓸 수 없을 때의 이유(§8-1) */
export const WIKI_NONE_REASON = '개인 위키도 팀 위키 동기화도 없습니다';

export interface NavWikiInfo {
  /** 안 읽은 변경 수(개인 + 팀) */
  count: number;
  personal: number;
  team: number;
  /** 두 출처 모두 쓸 수 없으면 그 이유 */
  unavailable?: string;
  /** 수 자리 글자(색인 중 「읽는 중」) */
  note?: string;
}

/** 내비 [변경]·사이드바 「변경 N」 표시(§8-1·§10-1) */
export function navWikiInfo(summary: WikiDocsSummary | null): NavWikiInfo {
  if (!summary) return { count: 0, personal: 0, team: 0, note: '읽는 중' };
  const { personal, team } = summary.sources;
  const out: NavWikiInfo = { count: summary.changes.total, personal: summary.changes.personal, team: summary.changes.team };
  const usable = [personal, team].filter(sourceUsable);
  if (usable.length === 0) out.unavailable = WIKI_NONE_REASON;
  // 첫 색인(캐시 없음) 중이면 수가 아직 사실이 아니다
  else if (usable.some((s) => s.state === 'indexing' && !s.stale && s.docs === 0)) out.note = '읽는 중';
  return out;
}

/** 마지막 색인 시각(두 출처 중 늦은 것) — 「색인 오후 3:02」 */
export function indexedText(summary: WikiDocsSummary | null): string {
  if (!summary) return '';
  const times = [summary.sources.personal.indexedAt, summary.sources.team.indexedAt].filter((t): t is string => !!t);
  if (times.length === 0) return '';
  const latest = times.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b));
  const clock = formatClock(latest);
  return clock ? `색인 ${clock}` : '';
}

/** 화면을 열 때 다시 확인할까(마지막 색인이 60초보다 오래) */
export function needsRecheck(summary: WikiDocsSummary | null, nowMs: number): boolean {
  if (!summary) return false;
  return [summary.sources.personal, summary.sources.team]
    .filter((s) => s.state === 'ready')
    .some((s) => !s.indexedAt || nowMs - Date.parse(s.indexedAt) > WIKI_RECHECK_MS);
}

// ── 강조 ──

export interface HighlightPart {
  text: string;
  mark: boolean;
}

/** 글을 강조 범위([시작, 끝) — UTF-16 위치)로 나눈다. 겹치거나 밖으로 나간 범위는 정리한다(텍스트 노드로 그리기 위함) */
export function splitHighlights(text: string, hits: readonly (readonly [number, number])[]): HighlightPart[] {
  const ranges = hits
    .map(([s, e]) => [Math.max(0, Math.min(text.length, s)), Math.max(0, Math.min(text.length, e))] as [number, number])
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: [number, number][] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  const out: HighlightPart[] = [];
  let pos = 0;
  for (const [s, e] of merged) {
    if (s > pos) out.push({ text: text.slice(pos, s), mark: false });
    out.push({ text: text.slice(s, e), mark: true });
    pos = e;
  }
  if (pos < text.length || out.length === 0) out.push({ text: text.slice(pos), mark: false });
  return out;
}

/** 질의 낱말(§4 — normText 뒤 공백으로 나눔, 중복 제거, 최대 8개) */
export function queryWords(query: string): string[] {
  return [...new Set(normText(query).trim().split(' ').filter(Boolean))].slice(0, 8);
}

/** 제목 안 낱말 위치(소문자화로 길이가 바뀌는 글자가 있으면 강조하지 않는다) */
export function titleHits(title: string, query: string): [number, number][] {
  const lower = title.normalize('NFC').toLowerCase();
  if (lower.length !== title.length) return [];
  const out: [number, number][] = [];
  for (const w of queryWords(query)) {
    let from = 0;
    while (out.length < 10) {
      const at = lower.indexOf(w, from);
      if (at < 0) break;
      out.push([at, at + w.length]);
      from = at + w.length;
    }
  }
  return out;
}

// ── 칩 글자 ──

/** 종류 칩(§8-2): entity 「업체」·topic 「주제」·analysis 「분석」·private 「비공개」. 나머지는 칩 없음 */
export function kindChip(kind: WikiDocKind): string | null {
  switch (kind) {
    case 'entity':
      return '업체';
    case 'topic':
      return '주제';
    case 'analysis':
      return '분석';
    case 'private':
      return '비공개';
    case 'meta':
      return '기록';
    default:
      return null;
  }
}

export const CHANGE_LABEL: Readonly<Record<WikiChangeItem['change'], string>> = {
  new: '새 문서',
  changed: '바뀜',
  deleted: '지움',
};

/** 바뀐 줄 수 글자: `+3 −1` · 모름 · 줄 순서만 */
export function linesText(lines: WikiChangeItem['lines'], unit = ''): string {
  if (lines === undefined) return '';
  if (lines === null) return '줄 수 모름';
  if (lines.added === 0 && lines.removed === 0) return '내용 변화 없음(줄 순서만)';
  return `+${lines.added} −${lines.removed}${unit}`;
}

/** 문서 키 */
export function docKey(ref: WikiDocInput): string {
  return `${ref.source}:${ref.path}`;
}

export function sameDoc(a: WikiDocInput | null | undefined, b: WikiDocInput | null | undefined): boolean {
  return !!a && !!b && a.source === b.source && a.path === b.path;
}

/** 파일 경로의 폴더 부분(경로 줄 — 흐린 글자) */
export function folderOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i > 0 ? path.slice(0, i) : '';
}

// ── 날짜 묶음 ──

function ymdOfIso(iso: string): string | null {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return localYmd(new Date(ms));
}

function shiftYmd(ymd: string, days: number): string {
  const p = parseYmd(ymd);
  if (!p) return ymd;
  return localYmd(new Date(p.year, p.month - 1, p.day + days));
}

/** 변경 날짜 묶음 글자(§8-3): 오늘 · 어제 · M/D */
export function changeDayLabel(iso: string, today: string): string {
  const ymd = ymdOfIso(iso);
  if (!ymd) return '날짜 모름';
  if (ymd === today) return '오늘';
  if (ymd === shiftYmd(today, -1)) return '어제';
  const p = parseYmd(ymd);
  return p ? `${p.month}/${p.day}` : ymd;
}

export interface ChangeGroup<T> {
  label: string;
  items: T[];
}

/** 받은 순서(detectedAt 최근 순)를 지키며 날짜로 묶는다 */
export function groupChanges<T extends { detectedAt: string }>(items: readonly T[], today: string): ChangeGroup<T>[] {
  const out: ChangeGroup<T>[] = [];
  for (const it of items) {
    const label = changeDayLabel(it.detectedAt, today);
    const last = out[out.length - 1];
    if (last && last.label === label) last.items.push(it);
    else out.push({ label, items: [it] });
  }
  return out;
}

/** 변경 시각 글자 */
export function changeTimeText(iso: string): string {
  return formatClock(iso);
}

/** 수정 시각(mtime ms) → 'M월 D일 오후 H:MM' */
export function mtimeText(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const d = new Date(ms);
  return `${d.getMonth() + 1}월 ${d.getDate()}일 ${formatClock(d.toISOString())}`;
}

// ── 변경 목록: 읽음 처리한 줄 붙잡기 ──

/**
 * 받은 변경 목록에 이 화면에서 읽음 처리한 줄을 흐린 채로 남긴다(§8-3 — 화면을 떠나면 빠진다).
 * 붙잡은 줄은 예전 자리(앞 줄 바로 뒤)에 끼운다.
 */
export function mergeRetained(
  fresh: readonly WikiChangeItem[],
  previous: readonly WikiChangeItem[],
  retained: ReadonlySet<string>,
): WikiChangeItem[] {
  const freshKeys = new Set(fresh.map(docKey));
  const out = [...fresh];
  for (let i = 0; i < previous.length; i++) {
    const it = previous[i];
    const k = docKey(it);
    if (freshKeys.has(k) || !retained.has(k)) continue;
    // 앞쪽에서 가장 가까운, 지금 목록에 있는 줄 뒤에
    let at = 0;
    for (let j = i - 1; j >= 0; j--) {
      const idx = out.findIndex((x) => docKey(x) === docKey(previous[j]));
      if (idx >= 0) {
        at = idx + 1;
        break;
      }
    }
    out.splice(at, 0, it);
  }
  return out;
}

// ── 키 ──

/** 앱 안 빠른 검색 Ctrl+K(§8-5) — IME 조합 중·다른 수식 키는 아님 */
export function isQuickSearchKey(e: {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey?: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing?: boolean;
}): boolean {
  if (e.isComposing || e.altKey || e.shiftKey) return false;
  if (!e.ctrlKey && !e.metaKey) return false;
  return e.key.toLowerCase() === 'k' || e.code === 'KeyK';
}

/** 검색 출처 칩 */
export const SEARCH_SOURCES: readonly { key: WikiSearchSource; label: string }[] = [
  { key: 'all', label: '전체' },
  { key: 'personal', label: '개인' },
  { key: 'team', label: '팀' },
];
