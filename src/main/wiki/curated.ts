// 큐레이션 항목(_todo-sync/items.json)·로그 절(내 할 일.md)·메모(할 일 메모.md) 읽기 (명세 §1-1).
import type { TaskStatus } from '../../shared/types';
import { isValidYmd } from './calendar';
import { toPosix } from './fsutil';

export interface CuratedAnchor {
  f: string;
  m: string;
}

/** items.json 의 항목 하나를 검사·정리한 것 */
export interface CuratedItem {
  /** items[] 안의 순번(0부터) */
  index: number;
  t: string;
  g?: string;
  k?: string;
  due?: string;
  why?: string;
  who?: string;
  risk?: number;
  src?: string;
  a: CuratedAnchor[];
}

export interface ItemsParseResult {
  items: CuratedItem[];
  warnings: string[];
}

function optString(v: unknown): string | undefined {
  if (typeof v === 'string') {
    return v.trim() === '' ? undefined : v;
  }
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

/**
 * items.json 원문을 읽는다. 깨졌으면 items 는 비우고 warnings 에 적는다.
 * 항목 하나가 이상해도 나머지는 살린다.
 */
export function parseItemsJson(text: string): ItemsParseResult {
  const warnings: string[] = [];
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { items: [], warnings: [`items.json 을 읽지 못함(JSON 오류: ${message}) — 큐레이션 항목 없이 계속함`] };
  }
  const list = root && typeof root === 'object' ? (root as { items?: unknown }).items : undefined;
  if (!Array.isArray(list)) {
    return { items: [], warnings: ['items.json 에 items 배열이 없음 — 큐레이션 항목 없이 계속함'] };
  }
  const items: CuratedItem[] = [];
  list.forEach((raw: unknown, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      warnings.push(`items.json 항목 ${index + 1}: 객체가 아님 — 건너뜀`);
      return;
    }
    const o = raw as Record<string, unknown>;
    const t = typeof o.t === 'string' ? o.t.trim() : '';
    if (!t) {
      warnings.push(`items.json 항목 ${index + 1}: 제목(t)이 없음 — 건너뜀`);
      return;
    }
    const item: CuratedItem = { index, t, a: [] };
    const g = optString(o.g);
    if (g) item.g = g;
    const k = optString(o.k);
    if (k) item.k = k;
    if (isValidYmd(o.due)) item.due = o.due;
    const why = optString(o.why);
    if (why) item.why = why;
    const who = optString(o.who);
    if (who) item.who = who;
    if (typeof o.risk === 'number' && Number.isFinite(o.risk)) item.risk = o.risk;
    const src = optString(o.src);
    if (src) item.src = src;
    if (Array.isArray(o.a)) {
      for (const an of o.a as unknown[]) {
        const obj = an && typeof an === 'object' ? (an as { f?: unknown; m?: unknown }) : {};
        const f = obj.f;
        const m = obj.m;
        if (typeof f === 'string' && typeof m === 'string' && f.trim() && m.trim()) {
          item.a.push({ f: toPosix(f.trim()), m });
        } else {
          warnings.push(`앵커 형식이 잘못됨: ${t} — 건너뜀`);
        }
      }
    }
    items.push(item);
  });
  return { items, warnings };
}

// ---------------------------------------------------------------- 로그 절

export const LOG_HEADINGS = {
  delegated: '## 위임·담당 이관 (아티팩트 동기화)',
  done: '## 완료 로그 (아티팩트 동기화)',
  wip: '## 진행 중 (아티팩트 동기화)',
} as const;

export interface LogSections {
  delegated: string[];
  done: string[];
  wip: string[];
}

/** `## ` 제목 줄에서 다음 `## ` 줄 전까지를 모은다. 같은 제목이 여럿이면 모두 합친다. */
function collectSection(lines: readonly string[], heading: string): string[] {
  const out: string[] = [];
  let inside = false;
  for (const line of lines) {
    if (line.startsWith('## ')) {
      inside = line.trimEnd() === heading;
      continue;
    }
    if (inside) out.push(line);
  }
  return out;
}

export function parseLogSections(lines: readonly string[]): LogSections {
  return {
    delegated: collectSection(lines, LOG_HEADINGS.delegated),
    done: collectSection(lines, LOG_HEADINGS.done),
    wip: collectSection(lines, LOG_HEADINGS.wip),
  };
}

export interface LogStatus {
  status: TaskStatus;
  owner?: string;
}

/** 앵커 없는 큐레이션 항목의 상태를 로그 절에서 찾는다. 위임 → 완료 → 진행 순. */
export function lookupLogStatus(logs: LogSections, title: string): LogStatus | null {
  const needle = `· ${title}`;
  const delegated = logs.delegated.find((l) => l.includes(needle));
  if (delegated !== undefined) {
    const m = /담당 \*\*(.+?)\*\*/.exec(delegated);
    const res: LogStatus = { status: 'notmine' };
    if (m) res.owner = m[1];
    return res;
  }
  if (logs.done.some((l) => l.includes(needle))) return { status: 'done' };
  if (logs.wip.some((l) => l.includes(needle))) return { status: 'wip' };
  return null;
}

// ---------------------------------------------------------------- 메모

/** build_todo.py memos() 의 `re.sub(r"^- \d{4}-\d{2}-\d{2} · ", "", l)` 과 같다 */
const MEMO_DATE_PREFIX_RE = /^- \d{4}-\d{2}-\d{2} · /;

/**
 * 할 일 메모.md → 제목별 **마지막** 메모. build_todo.py memos() 와 같은 규칙:
 * `## <제목>` 절 안에서 `- ` 로 시작하는 줄이 항목을 시작하고(앞의 `- YYYY-MM-DD · ` 는 뗀다),
 * 두 칸 들여쓴 줄은 **내용이 비어도** `\n` 으로 붙인다(sync_todo.py write_memo 가 여러 단락 메모를
 * `\n  ` 로 이어 쓰므로 단락 사이에 공백 두 칸만 있는 줄이 생긴다). 그 밖의 줄(빈 줄·출처 줄)은
 * 항목을 끊지 않고 건너뛴다 — 항목은 다음 `- ` 줄이나 `## ` 에서만 끝난다. 마지막 값은 앞뒤 공백을 뗀다.
 */
export function parseMemos(lines: readonly string[]): Map<string, string> {
  const memos = new Map<string, string>();
  let title: string | null = null;
  let current: string | null = null;
  const flush = () => {
    if (title !== null && current !== null) {
      const value = current.trim();
      // 빈 항목(`- 2026-09-19 · ` 처럼 내용이 없는 줄)은 build_todo 처럼 마지막 메모로 치지 않는다.
      if (value !== '') memos.set(title, value);
    }
    current = null;
  };
  for (const line of lines) {
    if (line.startsWith('## ')) {
      flush();
      title = line.slice(3).trim();
      continue;
    }
    if (title === null) continue;
    if (line.startsWith('- ')) {
      flush();
      current = line.replace(MEMO_DATE_PREFIX_RE, '');
      continue;
    }
    if (current !== null && line.startsWith('  ')) {
      current += '\n' + line.trim();
    }
    // 그 밖의 줄(빈 줄·출처 줄 등)은 항목을 끊지 않는다.
  }
  flush();
  return memos;
}
