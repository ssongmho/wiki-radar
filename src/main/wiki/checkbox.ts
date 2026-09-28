// 체크박스 줄 파싱: 필드·상태·표시 제목·핵심문구·ID (명세 §1-2 ~ §1-4).
import { createHash } from 'node:crypto';
import type { TaskStatus } from '../../shared/types';
import { isValidYmd } from './calendar';
import { toPosix } from './fsutil';
import { PY_WS, pyStrip } from './pystr';

/** 할 일이 되는 체크박스 줄. 들여쓴 줄은 할 일이 아니다(기존 도구와 같다). */
export const CHECKBOX_RE = /^- \[( |x|X)\] /;
/** 앵커 탐색에 쓰는 줄 머리(명세 §1-1: `^- \[[ xX]\]`) */
export const ANCHOR_LINE_RE = /^- \[[ xX]\]/;

const DONE_MARK_RE = /^- \[[xX]\]/;
/**
 * 핵심문구(ID)용: build_todo `core_of` 의 정규식을 그대로 옮긴 것.
 *   c = re.sub(r"^- \[[ xX]\]\s*", "", ln)
 *   re.sub(r"\s*\[\w+::[^\]]*\]", "", c).strip()
 * 필드 앞 공백까지 함께 떼므로 줄 가운데 필드가 있어도 공백이 겹치지 않는다.
 * 파이썬 str 정규식의 `\w` 는 유니코드 문자·숫자·`_` 라 `[\p{L}\p{N}_]` 로 옮긴다.
 * `\s` 와 strip() 은 파이썬 규칙(PY_WS·pyStrip)을 쓴다 — JS `\s`·trim() 은 U+FEFF 를 공백으로 보고 \x1c-\x1f·\x85 를
 * 공백으로 보지 않아, 그런 글자가 든 줄의 제목·앵커(t·m)가 build_todo 와 달라진다.
 * 필드 값 안의 대괄호(메일 파일명 `_[공지]…`)도 build_todo 처럼 첫 `]` 에서 끊는다 — ID 를 같게 하려는 것이다.
 */
const CORE_CHECKBOX_RE = new RegExp(`^- \\[[ xX]\\]${PY_WS}*`);
const CORE_FIELD_RE = new RegExp(`${PY_WS}*\\[[\\p{L}\\p{N}_]+::[^\\]]*\\]`, 'gu');
/**
 * 필드 해석·표시 제목용 패턴. 값 안의 짝 맞는 `[…]` 한 겹을 허용한다
 * (메일 파일명 `…_[공지] 제목.md` 처럼 대괄호가 든 경로). 짝이 안 맞으면 위의 단순 패턴으로 읽는다.
 */
const FIELD_RE = /\[([^[\]:]+)::((?:[^[\]]|\[[^[\]]*\])*)\]|\[([^[\]:]+)::([^\]]*)\]/g;
/** `#내할일` 태그(뒤에 한글·영문·숫자가 바로 붙은 것은 다른 태그다) */
const TAG_RE = /#내할일(?![가-힣ㄱ-ㅎㅏ-ㅣA-Za-z0-9])/g;
/** 앞머리의 그림 문자(🔴 등)와 공백. 변형 선택자·ZWJ·피부색 수식자·국기 문자도 함께 뗀다. */
const LEADING_PICTO_RE =
  /^[\s\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}‍︎️⃣]+/u;

export interface LineFields {
  pri?: number;
  due?: string;
  mail?: string;
  opened?: string;
  openDays?: number;
  chaseCount?: number;
  thread?: string;
  owner?: string;
  done?: string;
  wip?: string;
  st?: string;
  /** `[owner::]` 가 줄에 있는가(값이 비어도 true) */
  hasOwner: boolean;
  /** `[wip::]` 가 줄에 있는가 */
  hasWip: boolean;
}

export function isCheckboxLine(line: string): boolean {
  return CHECKBOX_RE.test(line);
}

/** `#내할일` 태그가 있는가 */
export function hasMyTaskTag(line: string): boolean {
  TAG_RE.lastIndex = 0;
  const found = TAG_RE.test(line);
  TAG_RE.lastIndex = 0;
  return found;
}

/** 줄의 `[키:: 값]` 필드를 모두 뽑는다(같은 키가 여럿이면 처음 것). */
export function rawFields(line: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of line.matchAll(FIELD_RE)) {
    const key = (m[1] ?? m[3] ?? '').trim();
    if (!key || out.has(key)) continue;
    out.set(key, (m[2] ?? m[4] ?? '').trim());
  }
  return out;
}

/** 알려진 키만 해석한다. 모르는 키·형식이 맞지 않는 값은 무시한다. */
export function parseFields(line: string): LineFields {
  const raw = rawFields(line);
  const f: LineFields = { hasOwner: raw.has('owner'), hasWip: raw.has('wip') };

  const pri = raw.get('pri');
  if (pri !== undefined && /^-?\d+$/.test(pri)) f.pri = Number(pri);

  const due = raw.get('due');
  if (due !== undefined && isValidYmd(due)) f.due = due;

  const opened = raw.get('opened');
  if (opened !== undefined && isValidYmd(opened)) f.opened = opened;

  const mail = raw.get('mail');
  if (mail !== undefined) {
    const p = toPosix(mail);
    if (p.startsWith('raw/mail/')) f.mail = p;
  }

  const openDays = raw.get('열림');
  if (openDays !== undefined) {
    const m = /^(\d+)\s*영업일$/.exec(openDays);
    if (m) f.openDays = Number(m[1]);
  }

  const chase = raw.get('재촉');
  if (chase !== undefined) {
    const m = /^(\d+)\s*회$/.exec(chase);
    if (m) f.chaseCount = Number(m[1]);
  }

  const thread = raw.get('thread');
  if (thread) f.thread = thread;
  const owner = raw.get('owner');
  if (owner) f.owner = owner;
  const done = raw.get('done');
  if (done) f.done = done;
  const wip = raw.get('wip');
  if (wip) f.wip = wip;
  const st = raw.get('st');
  if (st) f.st = st;
  return f;
}

/** `[st:: 완료]` 인가(공백은 보지 않는다 — `[st::완료]`·`[st:: 완 료 ]` 도 완료). 2단계 명세 §4 */
export function isStDone(st: string | undefined): boolean {
  return st !== undefined && st.replace(/\s+/g, '') === '완료';
}

/**
 * 상태: `[owner::]` → notmine, `- [x]` → done, `[st:: 완료]` → done(2단계 명세 §4), `[wip::]` → wip, 그 밖은 open.
 * st 의 다른 값(진행·확인·협의…)은 상태에 영향이 없다.
 */
export function lineStatus(line: string, fields: LineFields = parseFields(line)): TaskStatus {
  if (fields.hasOwner) return 'notmine';
  if (DONE_MARK_RE.test(line)) return 'done';
  if (isStDone(fields.st)) return 'done';
  if (fields.hasWip) return 'wip';
  return 'open';
}

function stripCheckbox(line: string): string {
  return line.replace(/^- \[[ xX]\] /, '');
}

/** 명세 §1-4 표시 제목 */
export function displayTitle(line: string): string {
  let s = stripCheckbox(line);
  s = s.replace(FIELD_RE, '');
  s = s.replace(TAG_RE, '');
  s = s.replace(LEADING_PICTO_RE, '');
  s = s.replace(/\*\*(.+?)\*\*/g, '$1');
  s = s.replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, '$2');
  s = s.replace(/\[\[([^\]]*)\]\]/g, '$1');
  s = s.replace(/\s+/g, ' ');
  s = s.replace(/ ([,.)])/g, '$1');
  return s.trim();
}

/**
 * 핵심문구: `- [ ] ` 와 `[키:: 값]` 필드를 모두 뗀 뒤 앞뒤 공백 제거(build_todo `core_of` 와 글자 단위로 같다 —
 * 공백은 파이썬 규칙).
 */
export function coreOf(line: string): string {
  return pyStrip(line.replace(CORE_CHECKBOX_RE, '').replace(CORE_FIELD_RE, ''));
}

/** 파이썬 `s[:n]` 처럼 **코드 포인트** 단위로 앞 n 글자(🔴 같은 보충 평면 글자도 한 글자). */
export function codePointSlice(s: string, n: number): string {
  let out = '';
  let count = 0;
  for (const ch of s) {
    if (count >= n) break;
    out += ch;
    count++;
  }
  return out;
}

/** 파이썬 `len(s)` 처럼 코드 포인트 수 */
export function codePointLength(s: string): number {
  let count = 0;
  for (const _ of s) count++;
  return count;
}

/** sync_todo·build_todo 가 체크박스 항목에 쓰는 제목 길이(build_todo `c[:70] + "…"`) */
export const SYNC_TITLE_MAX = 70;
/** 체크박스 항목 앵커 문구 길이(build_todo `c[:40]`) */
export const SYNC_ANCHOR_MAX = 40;

/**
 * 체크박스 줄의 sync_todo 제목 t (2단계 명세 §1-1·§5): 핵심문구가 70자를 넘으면 앞 70자 + `…`, 아니면 핵심문구.
 * build_todo 가 새 체크박스를 아티팩트 항목으로 만들 때의 제목과 같다 — 메모 절(`## t`)·로그 줄이 이 이름으로 쌓인다.
 */
export function checkboxSyncTitle(line: string): string {
  const core = coreOf(line);
  return codePointLength(core) > SYNC_TITLE_MAX ? codePointSlice(core, SYNC_TITLE_MAX) + '…' : core;
}

/** 체크박스 줄의 sync_todo 앵커 문구 m: 핵심문구 앞 40자 */
export function checkboxAnchorMatch(line: string): string {
  return codePointSlice(coreOf(line), SYNC_ANCHOR_MAX);
}

function sha1Hex(s: string): string {
  return createHash('sha1').update(s, 'utf8').digest('hex');
}

/** 체크박스 ID: 'c:' + sha1(파일 + '|' + 핵심문구) 앞 12자 */
export function checkboxId(file: string, line: string): string {
  return 'c:' + sha1Hex(`${file}|${coreOf(line)}`).slice(0, 12);
}

/** 큐레이션 ID: 'i:' + sha1(제목) 앞 12자 */
export function curatedId(title: string): string {
  return 'i:' + sha1Hex(title).slice(0, 12);
}
