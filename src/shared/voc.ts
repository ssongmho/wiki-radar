// VOC(2.6단계) — main 과 renderer 가 같이 쓰는 문구·검사. 순수 상수·함수만 둔다(글 → VOC HTML 바꾸기는 vocHtml.ts).

/**
 * main 이 이미 쓴 createId(서버에 닿은 등록 시도 — 성공했거나 결과를 모르는 것)를 다시 받아 거부할 때 문장 끝에 붙이는 표식.
 * renderer 는 이 표식을 보면 작성 칸의 createId 를 새로 바꾼다 — 사람이 VOC 에서 확인한 뒤 [등록]을 다시 누르면
 * 새 티켓으로 만든다(같은 createId 로는 두 번 만들지 않는다는 약속은 그대로다).
 */
export const VOC_CREATE_ID_USED = '같은 작성 칸으로는 다시 만들지 않습니다';

/**
 * 할 일 줄에 값이 빈 `[voc::]`·닫히지 않은 `[voc::` 가 있을 때. 줄 붙이기(applyLineField)가 같은 키를 거부하므로 티켓을 만들기 전에
 * 막는다(만든 뒤에야 줄 붙이기가 실패하면 운영 VOC 에 번호 없는 티켓이 남는다). 화면도 [VOC 로 등록] 대신 이 안내를 보인다
 */
export const VOC_LINE_FIELD_BROKEN = '할 일 줄에 값이 없거나 ] 로 닫히지 않은 [voc:: ] 가 있습니다 — 번호를 적거나 지운 뒤 다시 하세요';

// ---- 앱 안 로그인(명세 §13) ------------------------------------------------------------------
// 아래 문장에는 입력한 값(특히 비밀번호)을 넣지 않는다 — 오류 문장은 로그·화면으로 나간다.

/** 로그인 아이디: 영문·숫자·`._@-` 1~64자(명세 §13) */
export const VOC_LOGIN_ID_RE = /^[A-Za-z0-9._@-]{1,64}$/;
/** 비밀번호 한도(글자 — 코드 포인트) */
export const VOC_PASSWORD_MAX = 256;
/** 비밀번호에 넣을 수 없는 글자: 줄바꿈(표준입력 한 줄이 끝난다)·NUL */
const PASSWORD_BAD_RE = /[\r\n\u0000]/;

/**
 * 아이디 검사. 문제가 있으면 그 문장, 없으면 null. 첫 글자가 '-'·'@' 이면 voc-cli(picocli)가 옵션·@파일로 읽으므로 받지 않는다
 * (명세 §13 규칙보다 한 가지 더 좁다 — §12-9)
 */
export function vocLoginIdProblem(loginId: unknown): string | null {
  if (typeof loginId !== 'string' || loginId === '') return '아이디를 적어 주세요.';
  if (!VOC_LOGIN_ID_RE.test(loginId)) return '아이디는 영문·숫자와 . _ @ - 로 64자까지 적습니다.';
  if (/^[-@]/.test(loginId)) return '아이디는 - 나 @ 로 시작할 수 없습니다.';
  return null;
}

/** 아이디로 쓸 수 있는가(vocLoginIdProblem 이 null) */
export function isVocLoginId(loginId: unknown): loginId is string {
  return vocLoginIdProblem(loginId) === null;
}

/** 비밀번호 검사(1~256자, 줄바꿈·NUL 없음). 문제가 있으면 그 문장(값은 넣지 않는다), 없으면 null */
export function vocPasswordProblem(password: unknown): string | null {
  if (typeof password !== 'string' || password === '') return '비밀번호를 적어 주세요.';
  // 코드 포인트로 세기 전에 터무니없이 긴 값은 바로 거른다
  if (password.length > VOC_PASSWORD_MAX * 2 || [...password].length > VOC_PASSWORD_MAX) {
    return `비밀번호는 ${VOC_PASSWORD_MAX}자까지입니다.`;
  }
  if (PASSWORD_BAD_RE.test(password)) return '비밀번호에 줄바꿈이나 NUL 문자를 넣을 수 없습니다.';
  return null;
}

/**
 * VOC 서버(voc20-backend LoginAttemptService)의 로그인 잠금: 아이디별로 5번 연달아 틀리면 10분 잠근다. 틀린 수는 시간이 지나도 줄지 않고
 * 성공하거나 잠금이 풀릴 때만 0 이 된다(웹·터미널에서 틀린 것도 같이 센다). 잠긴 동안에는 맞는 비밀번호도 401 이고, voc-cli 는 401 을
 * 늘 '로그인 실패: 아이디 또는 비밀번호를 확인하세요.'로 바꿔 잠금 문장이 사라진다(명세 §12-9)
 */
export const VOC_SERVER_LOGIN_FAIL_LIMIT = 5;
export const VOC_SERVER_LOGIN_LOCK_MS = 600_000;
/**
 * 앱은 서버 한도보다 먼저(3번째 실패에서) 서버 잠금 시간만큼 막는다 — 웹·터미널에서 틀린 수가 서버에 이미 쌓여 있을 수 있어 두 번을
 * 남겨 둔다(명세 §12-9·§13)
 */
export const VOC_LOGIN_FAIL_LIMIT = 3;
export const VOC_LOGIN_LOCK_MS = VOC_SERVER_LOGIN_LOCK_MS;
/** 셈이 되는 로그인 실패마다 붙이는 서버 잠금 안내(맞는 비밀번호가 '틀림'으로 보일 수 있다는 것까지) */
export const VOC_LOGIN_LOCK_NOTE =
  `VOC 서버는 ${VOC_SERVER_LOGIN_FAIL_LIMIT}번 연달아 틀리면 계정을 ${VOC_SERVER_LOGIN_LOCK_MS / 60_000}분 잠급니다. ` +
  "잠긴 동안에는 맞는 비밀번호도 '확인하세요'로 나옵니다.";
/** 로그인 제한 시간(명세 §13) */
export const VOC_LOGIN_TIMEOUT_MS = 30_000;

// ---- V4 첨부·작업시간·해결·고객 메일(명세 §14) ----------------------------------------------------

/** [보기]로 앱 안에 그리는 이미지 확장자(SVG 는 넣지 않는다 — 스크립트를 품을 수 있다) */
export const VOC_IMAGE_EXTS: readonly string[] = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'];
/** [보기]로 받는 이미지 크기 한도(이보다 크면 내려받기만) */
export const VOC_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
/** 내려받은 뒤 [열기](기본 프로그램)를 허용하는 확장자. 이 밖(실행형·스크립트·바로가기·모르는 것)은 폴더에서 보기만 */
export const VOC_OPEN_EXTS: readonly string[] = ['pdf', 'txt', 'csv', 'log', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'hwp', 'hwpx'];
/** 내려받기 크기 한도(첨부 목록의 크기로 먼저 막는다) */
export const VOC_DOWNLOAD_MAX_BYTES = 200 * 1024 * 1024;

/** 첨부 처리 방식: image = [보기](앱 안 썸네일) · open = [내려받기] 뒤 [열기] · folder = [내려받기] 뒤 폴더에서 보기만 */
export type VocFileKindName = 'image' | 'open' | 'folder';

/** 파일 이름의 확장자(마지막 '.' 뒤, 소문자). 없으면 '' — 끝의 점·공백은 무시한다(Windows 가 떼어 낸다) */
export function vocFileExt(name: unknown): string {
  if (typeof name !== 'string') return '';
  const base = name.replace(/[. ]+$/, '').split(/[\\/]/).pop() ?? '';
  const i = base.lastIndexOf('.');
  if (i <= 0 || i === base.length - 1) return '';
  return base.slice(i + 1).toLowerCase();
}

/** 첨부 처리 방식. 이미지라도 크기를 모르거나 10MB 를 넘으면 내려받기(폴더에서 보기)만 */
export function vocFileKind(name: unknown, size?: number): VocFileKindName {
  const ext = vocFileExt(name);
  if (VOC_IMAGE_EXTS.includes(ext)) {
    return typeof size === 'number' && Number.isFinite(size) && size >= 0 && size <= VOC_IMAGE_MAX_BYTES ? 'image' : 'folder';
  }
  return VOC_OPEN_EXTS.includes(ext) ? 'open' : 'folder';
}

/** 내려받은 파일을 기본 프로그램으로 열어도 되는가(허용 확장자만) */
export function vocCanOpenFile(name: unknown): boolean {
  return VOC_OPEN_EXTS.includes(vocFileExt(name));
}

/** 작업시간 선택지(시간, 0.5 단위 0.5~12) */
export const VOC_WORK_HOURS: readonly number[] = Array.from({ length: 24 }, (_, i) => (i + 1) / 2);
/** 작업시간 메모 한도(글자) */
export const VOC_WORKLOG_NOTE_MAX = 500;
/** 고객 메일 받는 사람·참조 한도(각각) */
export const VOC_EMAIL_RECIPIENTS_MAX = 20;

/** 작업시간 값 검사(0.5 단위 0.5~12). 문제가 있으면 그 문장 */
export function vocHoursProblem(hours: unknown): string | null {
  if (typeof hours !== 'number' || !Number.isFinite(hours)) return '작업시간을 고르세요.';
  if (!VOC_WORK_HOURS.includes(hours)) return '작업시간은 0.5 단위로 0.5~12시간입니다.';
  return null;
}

/** 시간 표시: 1.5 → '1.5시간' */
export function vocHoursText(hours: number): string {
  const rounded = Math.round(hours * 100) / 100;
  return `${rounded}시간`;
}
