// 설정 › 점검(2.7단계 명세 §4, 2.9단계에서 「환경 점검」 → 「설정」): main 이 준 SetupStatus 와 VOC 보드를 화면의 점검 줄로 바꾼다.
// 내비의 쓸 수 없는 메뉴 이유(2.9단계 §1)도 여기서 정한다. 순수 함수만.
import { FEATURES } from '../../shared/edition';
import type { SetupLine, SetupStatus, VocBoard } from '../../shared/types';
import { textOf } from './tasks';

export type SetupKey = 'wiki' | 'claude' | 'mail' | 'voc' | 'notify' | 'mailIn' | 'ai' | 'team' | 'secrets';
/** ok 사용 가능 · off 쓸 수 없음 · warn 쓸 수는 있지만 확인 필요 · wait 확인 중 */
export type SetupTone = 'ok' | 'off' | 'warn' | 'wait';

export interface SetupRow {
  key: SetupKey;
  title: string;
  tone: SetupTone;
  /** 짧은 상태 글자(사용 가능·없음·로그인 필요 …) */
  state: string;
  /** 무엇을 봤는지·어떻게 고치는지 */
  detail: string;
  /** 이 항목이 없어서 꺼지는 기능(사용 가능이면 없음) */
  effect?: string;
  /** 보여 줄 경로(위키 폴더·claude 위치) */
  path?: string;
  /** 알림 줄의 보류 감지 상태(2.12단계 §11 — data-quiet) */
  quiet?: 'ok' | 'held' | 'unavailable' | 'off';
}

/** Claude Code 설치 명령(PowerShell) — 공식 설치 스크립트 */
export const CLAUDE_INSTALL_COMMAND = 'irm https://claude.ai/install.ps1 | iex';

const WIKI_SOURCES = new Set(['env', 'settings', 'default', 'none']);
const QUIET_STATES = new Set(['ok', 'held', 'unavailable', 'off']);
const CLAUDE_SOURCES = new Set(['env', 'path', 'default']);

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** main 응답 검사. 모양이 틀리면 null */
export function normalizeSetup(raw: unknown): SetupStatus | null {
  if (!isObject(raw) || !isObject(raw.wiki) || !isObject(raw.claude) || !isObject(raw.mail)) return null;
  const { wiki, claude, mail } = raw;
  if (typeof wiki.ok !== 'boolean' || typeof wiki.path !== 'string' || !WIKI_SOURCES.has(wiki.source as string)) return null;
  if (typeof claude.ok !== 'boolean' || typeof claude.path !== 'string' || !CLAUDE_SOURCES.has(claude.source as string)) {
    return null;
  }
  if (typeof mail.ok !== 'boolean') return null;
  const out: SetupStatus = {
    wiki: { ok: wiki.ok, path: wiki.path, source: wiki.source as SetupStatus['wiki']['source'] },
    claude: { ok: claude.ok, path: claude.path, source: claude.source as SetupStatus['claude']['source'] },
    mail: { ok: mail.ok },
    seen: raw.seen === true,
  };
  if (typeof wiki.pending === 'string' && wiki.pending !== '') out.wiki.pending = wiki.pending;
  else if (wiki.pendingNone === true) out.wiki.pendingNone = true;
  if (typeof mail.problem === 'string' && mail.problem !== '') out.mail.problem = mail.problem;
  const n = raw.notify;
  if (isObject(n) && typeof n.supported === 'boolean' && (n.mode === 'toast' || n.mode === 'log')) {
    out.notify = {
      supported: n.supported,
      mode: n.mode,
      todayToasts: typeof n.todayToasts === 'number' && n.todayToasts >= 0 ? Math.floor(n.todayToasts) : 0,
    };
    const q = n.quiet;
    if (isObject(q) && typeof q.state === 'string' && QUIET_STATES.has(q.state)) {
      out.notify.quiet = {
        state: q.state as NonNullable<NonNullable<SetupStatus['notify']>['quiet']>['state'],
        ...(typeof q.label === 'string' && q.label !== '' ? { label: q.label } : {}),
      };
    }
    if (isObject(n.lastFailure) && typeof n.lastFailure.at === 'string' && !Number.isNaN(Date.parse(n.lastFailure.at))) {
      out.notify.lastFailure = { at: n.lastFailure.at };
    }
  }
  // 2.13단계 §D-3 점검 줄(main 이 문장까지 만든다)
  for (const key of ['mailIn', 'ai', 'team', 'secrets'] as const) {
    const line = normalizeLine(raw[key]);
    if (line) out[key] = line;
  }
  return out;
}

function normalizeLine(raw: unknown): SetupLine | null {
  if (!isObject(raw) || (raw.state !== 'ok' && raw.state !== 'warn' && raw.state !== 'off') || typeof raw.text !== 'string') return null;
  return { state: raw.state, text: raw.text, ...(raw.quiet === true ? { quiet: true } : {}) };
}

/** 위키 폴더가 없다고 확인됐는가(모르면 거짓 — 확인 전에는 할 일 화면을 그대로 둔다) */
export function wikiMissing(status: SetupStatus | null): boolean {
  return !!status && !status.wiki.ok;
}

/** claude 가 없어 위키 반영·회신 초안을 쓸 수 없으면 그 문장(모르거나 있으면 null) */
export function claudeProblem(status: SetupStatus | null): string | null {
  if (!status || status.claude.ok) return null;
  return 'Claude Code가 설치되어 있지 않아 쓸 수 없습니다 — 설정 › 점검을 보세요.';
}

function wikiRow(s: SetupStatus): SetupRow {
  const { wiki } = s;
  // 설정 › 위키에서 「없음」을 골랐다(2.13단계 §C-1) — 없는 것이 정상이다
  if (wiki.source === 'none') {
    return {
      key: 'wiki',
      title: '위키 폴더',
      tone: wiki.pending ? 'warn' : 'ok',
      state: wiki.pending ? '다시 시작 필요' : '쓰지 않음',
      detail: wiki.pending
        ? `개인 위키를 쓰지 않도록 설정되어 있습니다. 새로 고른 폴더(${wiki.pending})는 다시 시작하면 적용됩니다.`
        : `개인 위키를 쓰지 않도록 설정했습니다(설정 › 위키). ${FEATURES.voc || FEATURES.teamWiki ? '할 일은 팀 위키·VOC 에서만 나옵니다.' : '메일만 씁니다.'}`,
    };
  }
  // 설정 › 위키에서 「없음」으로 바꿔 다시 시작을 기다린다 — 폴더 경로로 보이지 않는다
  if (wiki.pendingNone) {
    return {
      key: 'wiki',
      title: '위키 폴더',
      tone: 'warn',
      state: '다시 시작 필요',
      detail: '개인 위키를 쓰지 않도록 바꿨습니다 — 다시 시작하면 적용됩니다.',
      path: wiki.path,
    };
  }
  const where =
    wiki.source === 'env' ? '환경 변수 WIKI_RADAR_WIKI 로 정한 폴더' : wiki.source === 'settings' ? '고른 폴더' : '기본 위치';
  const pending = wiki.pending ? ` 새로 고른 폴더(${wiki.pending})는 다시 시작하면 적용됩니다.` : '';
  if (wiki.ok) {
    return {
      key: 'wiki',
      title: '위키 폴더',
      tone: wiki.pending ? 'warn' : 'ok',
      state: wiki.pending ? '다시 시작 필요' : '사용 가능',
      detail: `${where}를 읽습니다.${pending}`,
      path: wiki.path,
    };
  }
  return {
    key: 'wiki',
    title: '위키 폴더',
    tone: wiki.pending ? 'warn' : 'off',
    state: wiki.pending ? '다시 시작 필요' : '없음',
    detail: wiki.pending
      ? `${where}가 없습니다.${pending}`
      : wiki.source === 'env'
        ? `${where}가 없습니다. 환경 변수를 고치거나 지워야 합니다.`
        : `${where}에 위키 폴더가 없습니다. 개인 위키(Obsidian 볼트)가 있으면 [폴더 고르기]로 고르세요. 없으면 ${FEATURES.voc ? 'VOC' : '메일'}만 씁니다.`,
    effect: '할 일 · 반영 대기 · 메일 회신',
    path: wiki.path,
  };
}

function claudeRow(s: SetupStatus): SetupRow {
  const { claude } = s;
  if (claude.ok) {
    return { key: 'claude', title: 'Claude Code', tone: 'ok', state: '사용 가능', detail: '위키 반영과 회신 초안에 씁니다.', path: claude.path };
  }
  return {
    key: 'claude',
    title: 'Claude Code',
    tone: 'off',
    state: '없음',
    detail:
      claude.source === 'env'
        ? '환경 변수 WIKI_RADAR_CLAUDE 가 가리키는 파일이 없습니다.'
        : 'claude 실행 파일을 찾지 못했습니다. PowerShell에서 아래 명령으로 설치하고 한 번 로그인한 뒤 [다시 확인]을 누르세요.',
    effect: '위키 반영 · 회신 초안 만들기',
    path: claude.path,
  };
}

function mailRow(s: SetupStatus): SetupRow {
  if (s.mail.ok) return { key: 'mail', title: '메일 계정(SMTP)', tone: 'ok', state: '사용 가능', detail: '메일 할 일에 회신을 보냅니다.' };
  return {
    key: 'mail',
    title: '메일 계정(SMTP)',
    tone: 'off',
    state: '없음',
    detail: textOf(s.mail.problem) || '메일 계정이 없습니다.',
    effect: '메일 회신 보내기',
  };
}

function vocRow(board: VocBoard | null): SetupRow {
  const base = { key: 'voc' as const, title: 'VOC 로그인' };
  if (!board || board.state === 'loading') return { ...base, tone: 'wait', state: '확인 중', detail: 'VOC 서버에 연결하는 중입니다.' };
  if (board.state === 'login') {
    return {
      ...base,
      tone: 'off',
      state: '로그인 필요',
      detail: 'VOC 계정으로 한 번 로그인하면 이 PC에 암호화해 기억합니다.',
      effect: 'VOC 보드 · 티켓 처리',
    };
  }
  if (board.state === 'notConfigured') {
    return { ...base, tone: 'off', state: '설정 필요', detail: textOf(board.message) || 'VOC 설정이 필요합니다.', effect: 'VOC 보드 · 티켓 처리' };
  }
  if (!board.fetchedAt) {
    return {
      ...base,
      tone: 'warn',
      state: '연결 안 됨',
      detail: textOf(board.message) || 'VOC 서버에 연결하지 못했습니다. 사내망에 연결돼 있는지 확인하세요.',
    };
  }
  const who = textOf(board.me?.name);
  return { ...base, tone: 'ok', state: '로그인됨', detail: who ? `${who}(으)로 로그인했습니다.` : '로그인했습니다.' };
}

function hmOfIso(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * 알림 줄(2.9단계 §8-5 + 2.12단계 §6-2). 위에서부터 처음 맞는 것: 보낼 수 없음 → Windows 표시 실패 → 보류 중 → 감지를 쓸 수 없음 →
 * 시험 기록 / 사용 가능(시험 기록이어도 보류·실패는 보인다 — 명세 §6-2 비고). 어느 경우도 off 로 두지 않는다(「설정」 수를 바꾸지 않게). 옛 main 이면(notify 없음) 줄 없음
 */
function notifyRow(s: SetupStatus): SetupRow | null {
  const n = s.notify;
  if (!n) return null;
  const base = { key: 'notify' as const, title: '알림', ...(n.quiet ? { quiet: n.quiet.state } : {}) };
  if (n.mode !== 'log' && !n.supported) {
    return { ...base, tone: 'warn', state: '보낼 수 없음', detail: 'Windows 알림을 보낼 수 없습니다 — 알림함에만 남습니다.' };
  }
  if (n.lastFailure) {
    const hm = hmOfIso(n.lastFailure.at);
    return { ...base, tone: 'warn', state: '표시 실패', detail: `Windows 가 알림을 표시하지 못했습니다(${hm}) — 알림함에는 남습니다.` };
  }
  if (n.quiet?.state === 'held') {
    return { ...base, tone: 'warn', state: '보류 중', detail: `지금 보낼 수 없음 — ${n.quiet.label ?? '보류 중'}. 끝나면 1건으로 보냅니다.` };
  }
  if (n.quiet?.state === 'unavailable') {
    return { ...base, tone: 'warn', state: '감지 없음', detail: '전체 화면·발표 중 감지를 쓸 수 없습니다 — 그대로 보냅니다.' };
  }
  if (n.mode === 'log') return { ...base, tone: 'ok', state: '시험 기록', detail: '시험 기록 파일에 씁니다.' };
  return { ...base, tone: 'ok', state: '사용 가능', detail: `사용 가능 — 오늘 Windows 알림 ${n.todayToasts}건` };
}

const LINE_TITLE = { mailIn: '메일 받기(POP3)', ai: 'AI(로컬 LLM)', team: '팀 기본값', secrets: '저장된 비밀' } as const;
const LINE_STATE = {
  mailIn: { ok: '설정됨', warn: '설정 필요', off: '없음' },
  ai: { ok: '설정됨', warn: '확인 필요', off: '쓸 수 없음' }, // warn = 주소·모델이 없거나 [연결 시험] 전(detail 이 이유)
  team: { ok: '읽음', warn: '파일 문제', off: '없음' },
  secrets: { ok: '정상', warn: '다시 넣으세요', off: '없음' },
} as const;

/** 2.13단계 줄(main 의 SetupLine) → 점검 줄 */
function lineRow(key: keyof typeof LINE_TITLE, line: SetupLine | undefined): SetupRow | null {
  if (!line) return null;
  const effect = key === 'ai' && line.state === 'off' ? '회신 초안 만들기(로컬 LLM)' : undefined;
  return {
    key,
    title: LINE_TITLE[key],
    tone: line.state,
    state: key === 'team' && line.quiet ? '내장 기본값' : LINE_STATE[key][line.state],
    detail: line.text,
    ...(effect ? { effect } : {}),
  };
}

/** 점검 줄: 위키 폴더 · Claude Code · 메일 계정 · 메일 받기 · AI · VOC 로그인 · 알림 · 팀 기본값 · 저장된 비밀(있을 때만) */
export function setupRows(status: SetupStatus, board: VocBoard | null): SetupRow[] {
  const rows: SetupRow[] = [wikiRow(status), claudeRow(status), mailRow(status)];
  // 공개판은 가린 기능(로컬 LLM·VOC·팀 위키)의 줄을 뺀다(src/shared/edition.ts)
  for (const key of FEATURES.localLlm ? (['mailIn', 'ai'] as const) : (['mailIn'] as const)) {
    const r = lineRow(key, status[key]);
    if (r) rows.push(r);
  }
  if (FEATURES.voc) rows.push(vocRow(board));
  const notify = notifyRow(status);
  if (notify) rows.push(notify);
  for (const key of FEATURES.teamWiki ? (['team', 'secrets'] as const) : (['secrets'] as const)) {
    const r = lineRow(key, status[key]);
    if (r) rows.push(r);
  }
  return rows;
}

/** 쓸 수 없는(off) 항목 수 — 내비 '설정' 옆 수 */
export function setupProblemCount(status: SetupStatus | null, board: VocBoard | null): number {
  if (!status) return 0;
  return setupRows(status, board).filter((r) => r.tone === 'off').length;
}

/** 개인 위키가 없어 반영 대기를 쓸 수 없을 때 반영 대기 화면의 문장 */
export const QUEUE_NO_WIKI = '개인 위키가 없어 반영할 수 없습니다 — 설정 › 점검을 보세요.';

/** 내비 메뉴를 쓸 수 없는 이유(2.9단계 §1). 쓸 수 있으면 없음 — 메뉴는 숨기지 않고 흐리게 + 이 이유 */
export interface NavAvailability {
  tasks?: string;
  queue?: string;
  voc?: string;
}

export function navAvailability(input: {
  status: SetupStatus | null;
  /** 할 일 스냅샷이 있는가(개인 위키 또는 팀 위키 할 일) */
  hasSnapshot: boolean;
  /** 스냅샷이 개인 위키 없이 만들어졌는가(2.9단계 B — 팀 위키만) */
  personalMissing?: boolean;
  board: VocBoard | null;
}): NavAvailability {
  const out: NavAvailability = {};
  const noPersonal = wikiMissing(input.status) || input.personalMissing === true;
  if (!input.hasSnapshot && wikiMissing(input.status)) out.tasks = '위키 없음';
  if (noPersonal) out.queue = '개인 위키가 없어 반영할 수 없습니다';
  else if (input.status && !input.status.claude.ok) out.queue = 'Claude Code 없음';
  if (input.board?.state === 'notConfigured') out.voc = textOf(input.board.message) || 'VOC 설정이 필요합니다';
  return out;
}
