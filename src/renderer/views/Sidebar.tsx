// 사이드바 모드(폭 320, 화면 오른쪽 고정). 흘깃 보는 용도라 한 줄 제목만 보여 준다.
// 머리는 끌어 옮기는 영역이고, 목록 영역만 스크롤한다. 맨 아래 상태 줄(시안 Main)은 "VOC 미배정 N"(2.6단계)·"변경 N"(3a단계)·"반영 N"을 둔다
// (판단은 만들 때). Ctrl+K 는 풀스크린 검색을 연다(3a단계 §8-5). VOC 는 팀 합계만 — 담당자별 내역은 늘 떠 있는 창에 보이지 않는다(2.6단계 명세 §3-2).
// 상태 줄 위에 메일 블록(2.10단계 §9): 회신 필요·미확인 수 + 최대 3줄(제목까지만 — 본문·주소는 보이지 않는다).
import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { FEATURES } from '../../shared/edition';
import type { Bucket, Snapshot, Task, VocBoard } from '../../shared/types';
import {
  FOCUS_CHANGES_VIEW,
  FOCUS_INBOX_VIEW,
  FOCUS_MAIL_VIEW,
  FOCUS_QUEUE_VIEW,
  FOCUS_SEARCH_VIEW,
  FOCUS_SETUP_VIEW,
  FOCUS_VOC_LOGIN,
  FOCUS_VOC_VIEW,
  mailFocusId,
} from '../api';
import {
  IconAlert,
  IconArchive,
  IconChanges,
  IconChevronRight,
  IconExpand,
  IconList,
  IconMail,
  IconPin,
  IconPower,
  IconRefresh,
  IconSettings,
  IconUpload,
  IconVoc,
} from '../components/Icons';
import { EmptyState, ErrorState, LoadingState, NoticeBar, PartialNote } from '../components/StateMessage';
import { BucketHeading, TaskRow } from '../components/TaskRow';
import { BreakNote, WeekTrack } from '../components/WeekTrack';
import type { SnapshotHook } from '../hooks/useSnapshot';
import { useInbox } from '../hooks/useInbox';
import { useMailboxSummary } from '../hooks/useMailbox';
import { useNotice } from '../hooks/useNotice';
import { useQueue } from '../hooks/useQueue';
import { useSetup } from '../hooks/useSetup';
import { useTeamSync } from '../hooks/useTeamSync';
import { useVocBoard } from '../hooks/useVocBoard';
import { useWikiSummary } from '../hooks/useWikiDocs';
import { cls } from '../lib/cls';
import { formatLongDate, localYmd } from '../lib/date';
import { urgentBand } from '../lib/inbox';
import { sidebarMailInfo } from '../lib/mailbox';
import { wikiMissing } from '../lib/setup';
import { teamSyncBadge } from '../lib/teamSync';
import { SIDEBAR_BUCKET_LIMIT, STALE_HINT, groupByBucket } from '../lib/tasks';
import { needsVocLogin, sidebarVocInfo } from '../lib/voc';
import { isQuickSearchKey, navWikiInfo, type NavWikiInfo } from '../lib/wiki';

/** 사이드바에 줄로 펼쳐 보이는 구간(오래 열림·기타는 한 줄 요약) */
const LISTED_BUCKETS = ['overdue', 'thisWeek', 'chased'] as const satisfies readonly Bucket[];

interface SidebarBucketProps {
  bucket: Bucket;
  tasks: Task[];
  today: string;
  onOpen: (taskId?: string) => void;
}

function SidebarBucket({ bucket, tasks, today, onOpen }: SidebarBucketProps): ReactElement {
  const shown = tasks.slice(0, SIDEBAR_BUCKET_LIMIT);
  const hidden = tasks.length - shown.length;
  const headId = `sb-bucket-${bucket}`;
  return (
    <section className="bucket" data-testid={`bucket-${bucket}`} data-count={tasks.length} aria-labelledby={headId}>
      <BucketHeading bucket={bucket} count={tasks.length} id={headId} />
      {shown.length > 0 && (
        <ul className="rows">
          {shown.map((task, i) => (
            <li key={`${task.id}@${i}`}>
              <TaskRow task={task} today={today} variant="sidebar" onActivate={() => onOpen(task.id)} />
            </li>
          ))}
        </ul>
      )}
      {hidden > 0 && (
        <button type="button" className="more-btn" onClick={() => onOpen(tasks[SIDEBAR_BUCKET_LIMIT]?.id)}>
          <span>{hidden}건 더 보기</span>
          <IconChevronRight size={14} />
        </button>
      )}
    </section>
  );
}

function SidebarBody({ snapshot, onOpen }: { snapshot: Snapshot; onOpen: (taskId?: string) => void }): ReactElement {
  const { week, tasks } = snapshot;
  const groups = useMemo(() => groupByBucket(tasks), [tasks]);
  return (
    <>
      <section className="sb-week" aria-labelledby="sb-week-title">
        <div className="section-head">
          <h2 id="sb-week-title" className="section-title">
            이번 주
          </h2>
          <BreakNote week={week} />
        </div>
        <WeekTrack week={week} variant="sidebar" />
      </section>

      <div className="sb-list scroll">
        {snapshot.partial && <PartialNote />}
        {tasks.length === 0 ? (
          <EmptyState title="열린 할 일이 없습니다.">위키에 새 할 일이 생기면 여기에 바로 나타납니다.</EmptyState>
        ) : (
          <>
            {LISTED_BUCKETS.map((bucket) => (
              <SidebarBucket key={bucket} bucket={bucket} tasks={groups[bucket]} today={week.today} onOpen={onOpen} />
            ))}
            {groups.stale.length > 0 && (
              <button
                type="button"
                className="line-link line-link--dashed"
                data-testid="bucket-stale"
                data-count={groups.stale.length}
                aria-label={`정리 대상 ${groups.stale.length}건, ${STALE_HINT}`}
                title={STALE_HINT}
                onClick={() => onOpen(groups.stale[0]?.id)}
              >
                <IconArchive size={16} />
                <span className="line-link-text">정리 대상 {groups.stale.length}건</span>
                <IconChevronRight size={16} />
              </button>
            )}
            {groups.other.length > 0 && (
              <button
                type="button"
                className="line-link"
                data-testid="bucket-other"
                data-count={groups.other.length}
                onClick={() => onOpen(groups.other[0]?.id)}
              >
                <IconList size={16} />
                <span className="line-link-text">기타 {groups.other.length}건</span>
                <IconChevronRight size={16} />
              </button>
            )}
          </>
        )}
      </div>
    </>
  );
}

/** 상태 줄의 VOC 칸: 'VOC 미배정 N'(0이면 흐리게) + SLA 초과가 있으면 '· 초과 M'(코랄), 로그인이 필요하면 'VOC 로그인 필요' */
function VocStatusItem({ board, today, onVoc }: { board: VocBoard | null; today: string; onVoc: () => void }): ReactElement {
  const info = sidebarVocInfo(board, today);
  return (
    <button
      type="button"
      className={cls('sb-status-item', 'sb-status-item--voc', info.dim && 'is-zero', info.attention && 'is-attention')}
      data-testid="sidebar-voc"
      data-count={info.count}
      data-state={info.state}
      aria-description={info.description}
      title={info.title}
      onClick={onVoc}
    >
      <IconVoc size={16} />
      <span className="sb-status-text">
        <span>{info.label}</span>
        {info.showCount && <span className="sb-status-count">{info.count}</span>}
        {info.showCount && info.exceeded > 0 && <span className="sb-status-extra">· 초과 {info.exceeded}</span>}
      </span>
    </button>
  );
}

/** 메일 블록(2.10단계 §9). 쓸 수 없으면(위키 없음·raw/mail 없음·색인 전) 숨긴다 — 이유는 내비·메일함에서 */
function MailBlock({
  summary,
  today,
  onOpen,
}: {
  summary: ReturnType<typeof useMailboxSummary>['summary'];
  today: string;
  onOpen: (key?: string) => void;
}): ReactElement | null {
  const info = sidebarMailInfo(summary, today);
  if (info.hidden) return null;
  return (
    <section
      className={cls('sb-mail', info.empty && 'is-empty')}
      data-testid="sidebar-mail"
      data-unread={info.unread}
      data-reply-needed={info.replyNeeded}
      aria-labelledby="sb-mail-title"
    >
      <button type="button" className="sb-mail-head" onClick={() => onOpen()} title="메일함 열기">
        <IconMail size={16} />
        <span id="sb-mail-title" className="sb-mail-title">
          메일
        </span>
        {info.latest && <span className="sb-mail-latest">최근 {info.latest}</span>}
        {info.empty ? (
          <span className="sb-mail-none">새 메일 없음</span>
        ) : (
          <span className="sb-mail-counts">
            <span className={cls('sb-mail-count', 'is-amber', info.replyNeeded === 0 && 'is-zero')}>회신 필요 {info.replyNeeded}</span>
            <span className={cls('sb-mail-count', info.unread === 0 && 'is-zero')}>미확인 {info.unread}</span>
          </span>
        )}
      </button>
      {!info.empty && info.rows.length > 0 && (
        <ul className="sb-mail-rows">
          {info.rows.map((r) => (
            <li key={r.id}>
              <button type="button" className="sb-mail-row" data-testid="sidebar-mail-row" title={r.subject} onClick={() => onOpen(r.key)}>
                <span className="sb-mail-row-top">
                  <span className={cls('sb-mail-chip', r.chip === '회신 필요' && 'is-amber')}>{r.chip}</span>
                  <span className="sb-mail-time">{r.time}</span>
                </span>
                <span className="sb-mail-subject">{r.subject || '(제목 없음)'}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {!info.empty && (
        <button type="button" className="sb-mail-open" data-testid="btn-sidebar-mailbox" onClick={() => onOpen()}>
          메일함 열기
        </button>
      )}
    </section>
  );
}

/** 맨 아래 상태 줄(시안 Main 의 nav). 누르면 풀스크린의 그 화면이 열린다. 0이면 흐리게 */
function StatusLine({
  queueCount,
  onQueue,
  voc,
  team,
  changes,
}: {
  queueCount: number;
  onQueue: () => void;
  /** VOC 칸(앱 연결에 VOC 기능이 없으면 없음) */
  voc?: { board: VocBoard | null; today: string; onVoc: () => void };
  /** 팀 위키 동기화 칸(꺼져 있으면 없음 — 2.8단계) */
  team?: { label: string; attention: boolean; onOpen: () => void };
  /** 위키 「변경 N」 칸(3a단계 §10-1 — 두 출처 모두 쓸 수 없거나 옛 앱 연결이면 없음). 문서 제목은 보이지 않는다(수만) */
  changes?: { info: NavWikiInfo; onOpen: () => void };
}): ReactElement {
  return (
    <nav className={cls('sb-status', voc && 'sb-status--voc', changes && 'sb-status--changes')} aria-label="다른 알림">
      {voc && <VocStatusItem board={voc.board} today={voc.today} onVoc={voc.onVoc} />}
      {team && (
        <button
          type="button"
          className={cls('sb-status-item', team.attention && 'is-attention')}
          data-testid="sidebar-teamsync"
          aria-description={`팀 위키 동기화: ${team.label}. 누르면 설정 › 점검이 열립니다.`}
          title="팀 위키 동기화 — 설정 › 점검 열기"
          onClick={team.onOpen}
        >
          <IconRefresh size={16} />
          <span>팀위키</span>
          <span className="sb-status-extra">{team.label}</span>
        </button>
      )}
      {changes && (
        <button
          type="button"
          className={cls('sb-status-item', 'sb-status-item--changes', changes.info.count === 0 && 'is-zero')}
          data-testid="sidebar-changes"
          data-count={changes.info.count}
          data-personal={changes.info.personal}
          data-team={changes.info.team}
          aria-description={`위키 변경 ${changes.info.count}건(개인 ${changes.info.personal}, 팀 ${changes.info.team}). 누르면 풀스크린의 변경 화면이 열립니다.`}
          title="위키 변경 화면 열기"
          onClick={changes.onOpen}
        >
          <IconChanges size={16} />
          <span>변경</span>
          <span className="sb-status-count">{changes.info.note ?? changes.info.count}</span>
        </button>
      )}
      <button
        type="button"
        className={cls('sb-status-item', queueCount === 0 && 'is-zero')}
        data-testid="sidebar-queue"
        data-count={queueCount}
        aria-description={`위키 지식 반영 대기 ${queueCount}건. 누르면 풀스크린의 반영 대기 화면이 열립니다.`}
        title="반영 대기 화면 열기"
        onClick={onQueue}
      >
        <IconUpload size={16} />
        <span>반영</span>
        <span className="sb-status-count">{queueCount}</span>
      </button>
    </nav>
  );
}

/**
 * 머리 바로 아래 긴급 띠(2.9단계 §8-2): 안 읽은 긴급(오늘 생긴 것)이 있을 때만 코랄 한 줄. 깜빡이지 않는다.
 * 수는 main 이 센 것(unreadUrgent)만 쓴다. 누르면 풀스크린 알림함
 */
function UrgentBand({ band, onOpen }: { band: { count: number; text: string } | null; onOpen: () => void }): ReactElement | null {
  if (!band) return null;
  return (
    <button
      type="button"
      className="sb-urgent"
      data-testid="sidebar-urgent"
      data-count={band.count}
      aria-description="누르면 풀스크린 알림함이 열립니다."
      title="알림함 열기"
      onClick={onOpen}
    >
      <IconAlert size={16} />
      <span className="sb-urgent-text">{band.text}</span>
      <IconChevronRight size={16} />
    </button>
  );
}

export function Sidebar({ state, reload }: SnapshotHook): ReactElement {
  const { notice, run } = useNotice();
  const queue = useQueue();
  const voc = useVocBoard();
  const setup = useSetup();
  const teamSync = useTeamSync();
  const teamBadge = teamSyncBadge(teamSync.status);
  const inbox = useInbox();
  const mailbox = useMailboxSummary();
  const wiki = useWikiSummary();
  const wikiInfo = wiki.supported ? navWikiInfo(wiki.summary) : null;
  // 사이드바 창은 항상 위(alwaysOnTop)로 열린다. 이후 값은 togglePin 의 결과를 따른다.
  const [pinned, setPinned] = useState(true);
  const snapshot = state.status === 'ready' ? state.snapshot : null;
  const today = snapshot?.week.today ?? localYmd(new Date());

  const openFull = (taskId?: string): void => {
    void run((api) => (taskId ? api.setMode('full', taskId) : api.setMode('full')), '풀스크린으로 바꾸지 못했습니다.');
  };
  const togglePin = async (): Promise<void> => {
    const next = await run((api) => api.togglePin(), '항상 위 설정을 바꾸지 못했습니다.');
    if (typeof next === 'boolean') setPinned(next);
  };
  const openInbox = (): void => {
    void run((api) => api.setMode('full', FOCUS_INBOX_VIEW), '알림함을 열지 못했습니다.');
  };
  const quit = (): void => {
    void run((api) => api.quit(), '종료하지 못했습니다.');
  };
  const openSetup = (): void => {
    void run((api) => api.setMode('full', FOCUS_SETUP_VIEW), '설정 화면을 열지 못했습니다.');
  };
  const openQueue = (): void => {
    void run((api) => api.setMode('full', FOCUS_QUEUE_VIEW), '반영 대기 화면을 열지 못했습니다.');
  };
  const openMail = (key?: string): void => {
    void run((api) => api.setMode('full', key ? mailFocusId(key) : FOCUS_MAIL_VIEW), '메일함을 열지 못했습니다.');
  };
  // 'VOC 로그인 필요'면 VOC 화면과 함께 로그인 창을 바로 연다(명세 §13)
  const openVoc = (): void => {
    const focus = needsVocLogin(voc.board) ? FOCUS_VOC_LOGIN : FOCUS_VOC_VIEW;
    void run((api) => api.setMode('full', focus), 'VOC 화면을 열지 못했습니다.');
  };
  const openChanges = (): void => {
    void run((api) => api.setMode('full', FOCUS_CHANGES_VIEW), '변경 화면을 열지 못했습니다.');
  };
  // 사이드바 창에서도 Ctrl+K → 풀스크린 검색(3a단계 §8-5). 대화상자 안·IME 조합 중은 무시
  const wikiSupported = wiki.supported;
  useEffect(() => {
    if (!wikiSupported) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || !isQuickSearchKey(e)) return;
      if (document.querySelector('dialog[open]')) return;
      e.preventDefault();
      void run((api) => api.setMode('full', FOCUS_SEARCH_VIEW), '검색 화면을 열지 못했습니다.');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [wikiSupported, run]);

  return (
    <div className="sidebar" data-testid="sidebar">
      <header className="sb-head">
        <div className="brand">
          <span className="brand-name" title={`버전 ${__APP_VERSION__}`}>
            Radar
          </span>
          <span className="brand-date">{formatLongDate(today)}</span>
        </div>
        <div className="sb-actions">
          <button
            type="button"
            className="icon-btn"
            data-testid="btn-full"
            aria-label="풀스크린으로 전환"
            title="풀스크린으로 전환 (Ctrl+Alt+R)"
            onClick={() => openFull()}
          >
            <IconExpand size={18} />
          </button>
          <button
            type="button"
            className="icon-btn"
            data-testid="btn-pin"
            aria-label="항상 위에 고정"
            aria-pressed={pinned}
            title={pinned ? '항상 위 고정됨 (누르면 해제)' : '항상 위에 고정'}
            onClick={() => void togglePin()}
          >
            <IconPin size={18} />
          </button>
          <button type="button" className="icon-btn" data-testid="btn-quit" aria-label="Radar 종료" title="종료" onClick={quit}>
            <IconPower size={18} />
          </button>
        </div>
      </header>

      {inbox.supported && <UrgentBand band={urgentBand(inbox.inbox, today)} onOpen={openInbox} />}
      {state.status === 'loading' && <LoadingState />}
      {state.status === 'error' &&
        (wikiMissing(setup.status) ? (
          <div className="sb-list scroll" data-testid="wiki-missing">
            <EmptyState title="위키 폴더가 없습니다.">
              할 일은 개인 위키에서 읽습니다. {FEATURES.voc ? '위키가 없으면 아래 VOC만 씁니다.' : '설정에서 위키 폴더를 고르세요.'}
            </EmptyState>
            <button type="button" className="line-link" data-testid="sidebar-setup" onClick={openSetup}>
              <IconSettings size={16} />
              <span className="line-link-text">설정</span>
              <IconChevronRight size={16} />
            </button>
          </div>
        ) : (
          <ErrorState message={state.message} onRetry={reload} />
        ))}
      {snapshot && <SidebarBody snapshot={snapshot} onOpen={openFull} />}
      {mailbox.supported && <MailBlock summary={mailbox.summary} today={today} onOpen={openMail} />}
      <StatusLine
        queueCount={queue.items.length}
        onQueue={openQueue}
        voc={voc.supported ? { board: voc.board, today, onVoc: openVoc } : undefined}
        team={teamBadge ? { ...teamBadge, onOpen: openSetup } : undefined}
        changes={wikiInfo && !wikiInfo.unavailable ? { info: wikiInfo, onOpen: openChanges } : undefined}
      />
      <NoticeBar notice={notice} />
    </div>
  );
}
