// 처리 결과 입력(2단계 명세 §3) — 초안·검사·저장 입력·저장 결과 풀이. React 를 모르는 순수 함수만 둔다.
// 메일 회신(2.5단계)의 발송 알림은 lib/reply.ts 가 이 파일의 저장 알림(summarizeSave)을 이어 쓴다.
import { PARTIAL_SAVE_PREFIX } from '../../shared/ipc';
import type { SaveResultInput, SaveResultOutput, Task, TaskStatus } from '../../shared/types';
import { taskTitle, textOf } from './tasks';

export interface StatusOption {
  value: TaskStatus;
  label: string;
}

/** 상태 라디오(시안 A-Full + 대기). 순서가 화면 순서다 */
export const STATUS_OPTIONS: readonly StatusOption[] = [
  { value: 'open', label: '대기' },
  { value: 'wip', label: '진행 중' },
  { value: 'done', label: '완료' },
  { value: 'notmine', label: '내 일 아님' },
];

const STATUS_VALUES: readonly string[] = STATUS_OPTIONS.map((o) => o.value);

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && STATUS_VALUES.includes(value);
}

export function statusLabel(status: unknown): string {
  return STATUS_OPTIONS.find((o) => o.value === status)?.label ?? '알 수 없음';
}

/** 담당자·처리 내용 길이 상한(화면 쪽. main 도 따로 검사한다) */
export const OWNER_MAX = 60;
export const NOTE_MAX = 4000;

/** 담당자를 비우고 내 일 아님으로 저장하면 sync_todo 와 같이 이 이름으로 적힌다 */
export const DEFAULT_OWNER = '타담당';

/**
 * 저장할 때 main 이 받는 처리 내용 최대 길이(main config.ts MAX_NOTE_LENGTH 와 같다). 화면의 NOTE_MAX 는 사람이 적는
 * 몫이고, 보냈지만 저장이 실패해 앱이 붙인 발송 줄까지 합친 것은 이 길이까지 받는다.
 */
export const NOTE_SAVE_MAX = 8000;

/** 입력 중인 처리 결과. taskId 별로 메모리에 들고 있다 */
export interface ResultDraft {
  status: TaskStatus;
  owner: string;
  note: string;
  reflect: boolean;
  /**
   * 보냈지만 저장이 실패해 앱이 처리 내용 끝에 붙여 둔 발송 줄(2.5단계 명세 §9-5). 사람이 적은 몫이 아니므로
   * 처리 내용 길이(NOTE_MAX)에 세지 않는다 — 다시 [저장]하는 길이 막히지 않게.
   */
  sentLines?: string[];
}

/** 처리 내용 가운데 앱이 붙인 발송 줄(draft.sentLines 중 note 에 남아 있는 것)이 차지하는 글자 수(줄바꿈 포함) */
function sentLinesLength(draft: ResultDraft): number {
  let note = draft.note;
  let total = 0;
  for (const line of draft.sentLines ?? []) {
    if (line === '' || !note.includes(line)) continue;
    note = note.replace(line, '');
    total += line.length + 1;
  }
  return total;
}

/** 사람이 적은 처리 내용 길이(앞뒤 공백 뺌) — 앱이 붙인 발송 줄은 세지 않는다 */
export function ownNoteLength(draft: ResultDraft): number {
  return Math.max(0, draft.note.trim().length - sentLinesLength(draft));
}

/** 처리 내용 칸의 maxLength — 사람이 적는 몫(NOTE_MAX) + 앱이 붙인 발송 줄 */
export function noteInputMax(draft: ResultDraft): number {
  return NOTE_MAX + sentLinesLength(draft);
}

/** 처음 여는 폼: 지금 상태를 고르고 나머지는 비운다 */
export function initialDraft(task: Task): ResultDraft {
  return {
    status: isTaskStatus(task.status) ? task.status : 'open',
    owner: '',
    note: '',
    reflect: false,
  };
}

/** 처음 연 폼과 다른가(취소로 되돌릴 것이 있는가) */
export function isDirty(task: Task, draft: ResultDraft): boolean {
  const base = initialDraft(task);
  return (
    draft.status !== base.status || draft.owner !== base.owner || draft.note !== base.note || draft.reflect !== base.reflect
  );
}

/** 저장해서 달라지는 것이 있는가: 상태를 바꿨거나, 처리 내용을 적었거나, 반영을 켰다 */
export function hasChange(task: Task, draft: ResultDraft): boolean {
  const base = initialDraft(task);
  return draft.status !== base.status || draft.note.trim() !== '' || draft.reflect;
}

/** 저장하면 목록에서 빠지는 상태(목록은 열린 것만 보인다) */
export function leavesList(status: TaskStatus): boolean {
  return status === 'done' || status === 'notmine';
}

/** 입력 문제(없으면 null). 담당자는 [owner:: 값] 필드 안에 들어가므로 대괄호를 받지 않는다(줄바꿈·제어 문자는 저장할 때 걷는다) */
export function draftProblem(draft: ResultDraft): string | null {
  if (draft.status === 'notmine') {
    const owner = draft.owner.trim();
    if (/[[\]]/.test(owner)) return '담당자 이름에는 대괄호([ ])를 쓸 수 없습니다.';
    if (owner.length > OWNER_MAX) return `담당자 이름은 ${OWNER_MAX}자까지 적을 수 있습니다.`;
  }
  if (ownNoteLength(draft) > NOTE_MAX) return `처리 내용은 ${NOTE_MAX}자까지 적을 수 있습니다.`;
  if (draft.note.trim().length > NOTE_SAVE_MAX) {
    return `처리 내용과 발송 줄을 합쳐 ${NOTE_SAVE_MAX}자까지 저장할 수 있습니다. 처리 내용을 줄여 주세요.`;
  }
  return null;
}

/**
 * 초안 → IPC 입력. 담당자는 내 일 아님일 때만(공백은 한 칸으로), 빈 처리 내용은 보내지 않는다.
 * 줄바꿈은 LF 로 맞추고, 붙여 넣다 섞인 제어 문자(줄바꿈·탭 말고)는 뗀다 — main 이 거부하는 값이다.
 */
export function buildSaveInput(task: Task, draft: ResultDraft): SaveResultInput {
  const input: SaveResultInput = { taskId: task.id, status: draft.status, reflect: draft.reflect };
  if (draft.status === 'notmine') {
    const owner = draft.owner
      .replace(/\s+/g, ' ')
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .trim();
    if (owner) input.owner = owner;
  }
  const note = draft.note
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .trim();
  if (note) input.note = note;
  return input;
}

/** 목록에서 id 가 빠질 때 옮겨 갈 항목: 바로 다음, 없으면 바로 앞, 그것도 없으면 null */
export function nextAfterRemoval(ids: readonly string[], id: string): string | null {
  const i = ids.indexOf(id);
  if (i < 0) return ids[0] ?? null;
  return ids[i + 1] ?? ids[i - 1] ?? null;
}

// ── 저장 결과 알림 ──

export type NoticeTone = 'ok' | 'warn' | 'error';

export interface NoticeLine {
  text: string;
  /** 경고색으로 보일 줄(못 찾은 앵커·경고) */
  warn?: boolean;
}

export interface SaveNotice {
  /** 알림마다 새 값(같은 문장이 다시 와도 새 알림으로 본다) */
  id: number;
  tone: NoticeTone;
  title: string;
  lines: NoticeLine[];
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.trim() !== '') : [];
}

/** 조사 '(으)로'. 회신 알림(lib/reply.ts)도 쓴다 */
export function josaRo(word: string): string {
  // '진행 중'·'완료'·'대기'·'내 일 아님' — 받침이 ㄹ 이거나 없으면 '로', 그 밖엔 '으로'
  const last = word.charCodeAt(word.length - 1);
  if (last < 0xac00 || last > 0xd7a3) return '(으)로';
  const jong = (last - 0xac00) % 28;
  return jong === 0 || jong === 8 ? '로' : '으로';
}

/** 저장 결과 → 알림. 고친 파일 수와 경로·백업 위치·로그/메모 처리·대기열·경고(경고색) */
export function summarizeSave(task: Task, input: SaveResultInput, out: SaveResultOutput, id: number): SaveNotice {
  const title = taskTitle(task);
  const label = statusLabel(input.status);
  const files = strings(out?.files);
  const unmatched = strings(out?.unmatched);
  const warnings = strings(out?.warnings);
  const lines: NoticeLine[] = [];

  lines.push({ text: files.length > 0 ? `위키 파일 ${files.length}개를 고쳤습니다.` : '고친 위키 파일이 없습니다.' });
  if (files.length > 0) lines.push({ text: `고친 파일: ${files.join(' · ')}` });
  const backup = textOf(out?.backupDir);
  if (backup) lines.push({ text: `고치기 전 사본: ${backup}` });

  if (strings(out?.loggedDone).length + strings(out?.loggedDelegated).length + strings(out?.loggedWip).length > 0) {
    lines.push({ text: '위키에 맞는 체크박스 줄이 없어 ‘내 할 일’의 동기화 로그 절에 적었습니다.' });
  }
  if (strings(out?.unlogged).length > 0) lines.push({ text: '동기화 로그 절에서 이 항목을 지웠습니다(되돌리기).' });

  if (input.note) {
    lines.push({ text: out?.memo === true ? '처리 내용을 ‘할 일 메모’에 남겼습니다.' : '같은 메모가 이미 있어 메모는 다시 쓰지 않았습니다.' });
  }
  if (input.reflect) {
    lines.push(
      out?.queued
        ? { text: '반영 대기열에 넣었습니다. [위키에 반영]을 누르면 Claude가 위키 지식에 반영합니다.' }
        : { text: '반영 대기열에 넣었는지 확인하지 못했습니다. 반영 대기 화면을 확인해 주세요.', warn: true },
    );
  }
  for (const u of unmatched) lines.push({ text: `찾지 못함: ${u}`, warn: true });
  for (const w of warnings) lines.push({ text: w, warn: true });

  const warn = lines.some((l) => l.warn);
  return {
    id,
    tone: warn ? 'warn' : 'ok',
    title: `‘${title}’ — ${label}${josaRo(label)} 저장했습니다.`,
    lines,
  };
}

/** main 이 '파일 일부만 쓰고 실패'를 알린 문장인가(PARTIAL_SAVE_PREFIX 로 시작한다) */
export function isPartialSave(message: string): boolean {
  return message.startsWith(PARTIAL_SAVE_PREFIX);
}

/**
 * 저장 실패 알림.
 * - 아무것도 쓰지 않은 실패(error): 위키는 그대로이고 입력은 남아 있다.
 * - 일부만 쓴 실패(warn): 쓴 파일은 main 문장에 있다. 다시 저장하면 나머지가 반영된다(같은 메모는 다시 쓰지 않는다).
 */
export function saveFailure(task: Task, message: string, id: number): SaveNotice {
  if (isPartialSave(message)) {
    return {
      id,
      tone: 'warn',
      title: `‘${taskTitle(task)}’을(를) 일부만 저장했습니다.`,
      lines: [
        { text: message, warn: true },
        { text: '나머지 파일은 고치지 못했습니다. 확인한 뒤 같은 내용으로 다시 저장하면 이어서 반영됩니다(같은 메모는 다시 쓰지 않습니다).' },
      ],
    };
  }
  return {
    id,
    tone: 'error',
    title: `‘${taskTitle(task)}’을(를) 저장하지 못했습니다.`,
    lines: [{ text: message, warn: true }, { text: '입력한 내용은 그대로 남아 있습니다. 확인한 뒤 다시 저장해 주세요.' }],
  };
}
