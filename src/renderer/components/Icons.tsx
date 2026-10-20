// 선 아이콘(인라인 SVG). 경로는 A 관제 스코프 시안의 것을 그대로 쓴다. 이모지는 쓰지 않는다.
// 아이콘은 모두 장식이다(aria-hidden). 뜻은 옆의 글자나 버튼의 aria-label 이 전한다.
import type { ReactElement, ReactNode } from 'react';
import type { IconName } from '../lib/tasks';

export interface IconProps {
  size?: number;
  className?: string;
}

function Svg({ size = 16, className, children }: IconProps & { children: ReactNode }): ReactElement {
  return (
    <svg
      className={className ? `icon ${className}` : 'icon'}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/** 풀스크린 전환 */
export const IconExpand = (p: IconProps) => (
  <Svg {...p}>
    <path d="M15 3h6v6" />
    <path d="M9 21H3v-6" />
    <path d="M21 3l-7 7" />
    <path d="M3 21l7-7" />
  </Svg>
);

/** 항상 위 고정 */
export const IconPin = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 17v5" />
    <path d="M9 3h6l-1 7 3 3v2H7v-2l3-3z" />
  </Svg>
);

/** 종료 */
export const IconPower = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3v9" />
    <path d="M18.4 6.6a9 9 0 1 1-12.8 0" />
  </Svg>
);

/** 지남(시계) */
export const IconClock = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </Svg>
);

/** 이번 주(달력) */
export const IconCalendar = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="5" width="18" height="16" rx="2" />
    <path d="M3 10h18" />
    <path d="M8 3v4" />
    <path d="M16 3v4" />
  </Svg>
);

/** 재촉 중(종) */
export const IconBell = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
    <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
  </Svg>
);

/** 알림 등급 표식(채운 점 — 색은 currentColor: 긴급 코랄 · 오늘 앰버) */
export const IconDot = ({ size = 8, className }: IconProps) => (
  <svg
    className={className ? `icon ${className}` : 'icon'}
    width={size}
    height={size}
    viewBox="0 0 8 8"
    aria-hidden="true"
    focusable="false"
  >
    <circle cx="4" cy="4" r="4" fill="currentColor" />
  </svg>
);

/** 오래 열림(보관함) */
export const IconArchive = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="4" rx="1" />
    <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" />
    <path d="M10 12h4" />
  </Svg>
);

/** 기타(목록) */
export const IconList = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 6h11" />
    <path d="M9 12h11" />
    <path d="M9 18h11" />
    <path d="M4 6h.01" />
    <path d="M4 12h.01" />
    <path d="M4 18h.01" />
  </Svg>
);

export const IconChevronRight = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 6l6 6-6 6" />
  </Svg>
);

export const IconChevronDown = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 9l6 6 6-6" />
  </Svg>
);

/** 재촉(주고받기 화살표) */
export const IconChase = (p: IconProps) => (
  <Svg {...p}>
    <path d="M17 2l4 4-4 4" />
    <path d="M3 11V9a3 3 0 0 1 3-3h15" />
    <path d="M7 22l-4-4 4-4" />
    <path d="M21 13v2a3 3 0 0 1-3 3H3" />
  </Svg>
);

/** 할 일(체크 목록) */
export const IconChecklist = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 6l1.5 1.5L8 5" />
    <path d="M11 6h9" />
    <path d="M4 12l1.5 1.5L8 11" />
    <path d="M11 12h9" />
    <path d="M4 18l1.5 1.5L8 17" />
    <path d="M11 18h9" />
  </Svg>
);

/** 사이드바로 */
export const IconSidebar = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M15 4v16" />
  </Svg>
);

/** 업체 */
export const IconBuilding = (p: IconProps) => (
  <Svg {...p}>
    <rect x="5" y="3" width="14" height="18" rx="1" />
    <path d="M9 7h2" />
    <path d="M13 7h2" />
    <path d="M9 11h2" />
    <path d="M13 11h2" />
    <path d="M10 21v-4h4v4" />
  </Svg>
);

/** 메일 */
export const IconMail = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="M3 7l9 6 9-6" />
  </Svg>
);

/** 첨부(클립 — 시안 Mail-1) */
export const IconAttach = (p: IconProps) => (
  <Svg {...p}>
    <path d="M21 11l-8.5 8.5a5 5 0 0 1-7-7L14 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L15 7" />
  </Svg>
);

/** 검색 */
export const IconSearch = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="M20 20l-3.5-3.5" />
  </Svg>
);

/** 뒤로(메일로 돌아가기) */
export const IconBack = (p: IconProps) => (
  <Svg {...p}>
    <path d="M15 6l-6 6 6 6" />
  </Svg>
);

/** 더 보기(…) */
export const IconMore = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 12h.01" />
    <path d="M12 12h.01" />
    <path d="M19 12h.01" />
  </Svg>
);

/** 받은편지함으로 되돌리기 */
export const IconInbox = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 13h5l1.5 3h5l1.5-3h5" />
    <path d="M5 5h14l2 8v6H3v-6z" />
  </Svg>
);

/** 되돌리기 */
export const IconUndo = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 14L4 9l5-5" />
    <path d="M4 9h11a5 5 0 0 1 0 10h-3" />
  </Svg>
);

/** 문서 */
export const IconFile = (p: IconProps) => (
  <Svg {...p}>
    <path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z" />
    <path d="M14 3v5h5" />
  </Svg>
);

/** 메모 */
export const IconMemo = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 4h14v11l-5 5H5z" />
    <path d="M14 20v-5h5" />
    <path d="M8 9h8" />
    <path d="M8 13h4" />
  </Svg>
);

/** 바깥에서 열기 */
export const IconExternal = (p: IconProps) => (
  <Svg {...p}>
    <path d="M14 4h6v6" />
    <path d="M20 4l-9 9" />
    <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
  </Svg>
);

/** 열린 기간(모래시계) */
export const IconHourglass = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 3h12" />
    <path d="M6 21h12" />
    <path d="M7 3v3.2a2 2 0 0 0 .6 1.4L12 12l4.4-4.4a2 2 0 0 0 .6-1.4V3" />
    <path d="M7 21v-3.2a2 2 0 0 1 .6-1.4L12 12l4.4 4.4a2 2 0 0 1 .6 1.4V21" />
  </Svg>
);

/** 진행 중 */
export const IconProgress = (p: IconProps) => (
  <Svg {...p}>
    <path d="M21 12a9 9 0 1 1-6.2-8.6" />
    <path d="M12 7v5l3 2" />
  </Svg>
);

/** 담당자 */
export const IconUser = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21a8 8 0 0 1 16 0" />
  </Svg>
);

/** 우선순위(깃발) */
export const IconFlag = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 21V4" />
    <path d="M5 4h11l-2 4 2 4H5" />
  </Svg>
);

/** 경고 */
export const IconAlert = (p: IconProps) => (
  <Svg {...p}>
    <path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
    <path d="M12 9v4" />
    <path d="M12 17h.01" />
  </Svg>
);

/** 다시 시도(새로 고침) */
export const IconRefresh = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 12a9 9 0 0 1 15.5-6.2L21 8" />
    <path d="M21 3v5h-5" />
    <path d="M21 12a9 9 0 0 1-15.5 6.2L3 16" />
    <path d="M3 21v-5h5" />
  </Svg>
);

/** 연결된 줄 */
export const IconLink = (p: IconProps) => (
  <Svg {...p}>
    <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
    <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
  </Svg>
);

/** 반영 대기(올려 보내기) — 시안의 반영 아이콘 */
export const IconUpload = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 15V3" />
    <path d="M7 8l5-5 5 5" />
    <path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" />
  </Svg>
);

/** 닫기 */
export const IconClose = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 6l12 12" />
    <path d="M18 6L6 18" />
  </Svg>
);

/** 마침(체크) */
export const IconCheck = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </Svg>
);

/** 보내기(종이비행기) — [보내고 저장]·[보내기]·지난 발송 */
export const IconSend = (p: IconProps) => (
  <Svg {...p}>
    <path d="M21 3L10 14" />
    <path d="M21 3l-6.5 18-4.5-7-7-4.5z" />
  </Svg>
);

/** 회신(돌아가는 화살표를 얹은 봉투) — '회신 메일 보내기' */
export const IconReply = (p: IconProps) => (
  <Svg {...p}>
    <path d="M21 12V7a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h7" />
    <path d="M3 7l9 6 9-6" />
    <path d="M18 15l-3 3 3 3" />
    <path d="M15 18h4a2 2 0 0 0 2-2v-1" />
  </Svg>
);

/** 초안 쓰기(펜) */
export const IconPen = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z" />
    <path d="M13.5 6.5l4 4" />
  </Svg>
);

/** 멈춤(네모) */
export const IconStop = (p: IconProps) => (
  <Svg {...p}>
    <rect x="6" y="6" width="12" height="12" rx="1.5" />
  </Svg>
);

/** VOC(헤드셋 — 고객 문의 창구) — 내비·사이드바의 VOC */
export const IconVoc = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 13v-1a9 9 0 0 1 18 0v1" />
    <rect x="3" y="13" width="4" height="6" rx="1.5" />
    <rect x="17" y="13" width="4" height="6" rx="1.5" />
    <path d="M19 19a3 3 0 0 1-3 3h-3" />
  </Svg>
);

/** VOC 티켓(표) — 티켓 번호·VOC 칩 */
export const IconTicket = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 8a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v2a2 2 0 0 0 0 4v2a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-2a2 2 0 0 0 0-4z" />
    <path d="M14 7v2" />
    <path d="M14 11v2" />
    <path d="M14 15v2" />
  </Svg>
);

/** 담당 지정(사람 + 더하기) */
export const IconAssign = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="10" cy="8" r="4" />
    <path d="M2.5 21a7.5 7.5 0 0 1 12.2-5.8" />
    <path d="M19 15v6" />
    <path d="M16 18h6" />
  </Svg>
);

/** 설정(톱니바퀴) */
export const IconSettings = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </Svg>
);

/** 웹에서 열기(지구) — [VOC 에서 열기] */
export const IconWeb = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18" />
    <path d="M12 3a14 14 0 0 1 0 18" />
    <path d="M12 3a14 14 0 0 0 0 18" />
  </Svg>
);

/** 복사(겹친 네모) — 로그인 명령 복사 */
export const IconCopy = (p: IconProps) => (
  <Svg {...p}>
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
  </Svg>
);

/** 로그인(문으로 들어가는 화살표) — VOC [로그인] */
export const IconLogin = (p: IconProps) => (
  <Svg {...p}>
    <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
    <path d="M10 17l5-5-5-5" />
    <path d="M15 12H3" />
  </Svg>
);

/** 내려받기(아래 화살표 + 받침) — VOC 첨부 */
export const IconDownload = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 4v11" />
    <path d="M7 10l5 5 5-5" />
    <path d="M5 20h14" />
  </Svg>
);

/** 폴더 — 폴더에서 보기 */
export const IconFolder = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 7a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" />
  </Svg>
);

/** 그림 — 이미지 첨부 [보기] */
export const IconImage = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <circle cx="9" cy="10" r="1.6" />
    <path d="M21 16l-5-5-9 8" />
  </Svg>
);

/** 위키 변경(3a단계): 겹친 문서 두 장 + 점 */
export const IconChanges = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 6V4.5A1.5 1.5 0 0 1 9.5 3H15l4 4v9.5a1.5 1.5 0 0 1-1.5 1.5H16" />
    <path d="M4 9.5A1.5 1.5 0 0 1 5.5 8H11l4 4v7.5a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 4 19.5z" />
    <circle cx="9.5" cy="16" r="1.4" />
  </Svg>
);

/** 비공개(자물쇠) */
export const IconLock = (p: IconProps) => (
  <Svg {...p}>
    <rect x="5" y="11" width="14" height="10" rx="2" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </Svg>
);

/**
 * 이름으로 고르는 아이콘 표. IconName(lib/tasks.ts)에 아직 없는 이름(voc·ticket 등)도 미리 넣어 둔다 —
 * 표를 먼저 만들고 Record<IconName, …> 에 담으므로, IconName 에 이 표의 이름이 늘어나도 타입 검사가 깨지지 않는다.
 */
const ICON_TABLE = {
  clock: IconClock,
  calendar: IconCalendar,
  bell: IconBell,
  archive: IconArchive,
  list: IconList,
  building: IconBuilding,
  chase: IconChase,
  hourglass: IconHourglass,
  progress: IconProgress,
  user: IconUser,
  flag: IconFlag,
  mail: IconMail,
  memo: IconMemo,
  voc: IconVoc,
  ticket: IconTicket,
  assign: IconAssign,
  settings: IconSettings,
  web: IconWeb,
  copy: IconCopy,
  refresh: IconRefresh,
  alert: IconAlert,
  external: IconExternal,
  send: IconSend,
  reply: IconReply,
  check: IconCheck,
  file: IconFile,
};

/** 이름으로 고르는 아이콘(구간 머리·칩) */
export const ICONS: Record<IconName, (p: IconProps) => ReactElement> = ICON_TABLE;

export function Icon({ name, ...rest }: IconProps & { name: IconName }): ReactElement {
  const Component = ICONS[name];
  return <Component {...rest} />;
}
