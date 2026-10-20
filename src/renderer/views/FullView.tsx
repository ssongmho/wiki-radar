// 풀스크린 모드: 216px 내비 | 384px 목록 | 상세 | 344px 연결된 정보. 내비의 "VOC"·"반영 대기"를 고르면 내비 오른쪽 전체가 그 화면이 된다.
// 선택은 onFocusTask(사이드바에서 누른 항목)로 바뀌고, 기본은 첫 항목. 위/아래 키로 옮긴다.
// VOC 보드(2.6단계)는 여기서 한 번 구독해 내비 수와 VOC 화면이 같이 쓴다. VOC 화면의 선택·쓰기 알림도 여기서 들어
// 할 일 화면에 다녀와도 그대로다(메모리에만).
// 처리 결과 입력값은 taskId 별 초안으로 여기서 들고 있다 — 스냅샷이 바뀌거나 화면을 오가도 입력을 잃지 않는다(메모리에만).
// 메일 할 일의 회신 작성 칸(2.5단계)도 taskId 별로 여기서 든다(useReply). 보내고 저장은 저장과 같은 줄에서 한 번에 하나만.
// 팀 위키 동기화가 켜지면(2.9단계 §4-1) 할 일 화면 위에 [내 할 일 | 팀 전체] 탭 — 팀 전체는 TeamTasksView. 탭·팀 칸 선택·팀 할 일 입력값도
// 여기서 메모리에 든다.
// 메일함(2.10단계): 「들어오는 것」 맨 위 [메일](미확인 스레드 수). 메일함의 선택(필터·검색·폴더·고른 스레드)도 여기서 든다.
// 위키(3a단계): 「들어오는 것」과 「남기기」 사이 「위키」 묶음 [검색] [변경](안 읽은 변경 수). 질의·출처·탭·고른 문서도 여기서 든다.
// 풀스크린 어디서나 Ctrl+K → 검색 화면 + 검색 칸 초점(IME 조합 중·대화상자 안은 무시).
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
  type SetStateAction,
} from 'react';
import type { Snapshot, Task, TaskStatus } from '../../shared/types';
import {
  FOCUS_CHANGES_VIEW,
  FOCUS_INBOX_VIEW,
  FOCUS_SEARCH_VIEW,
  FOCUS_QUEUE_VIEW,
  FOCUS_SETUP_VIEW,
  FOCUS_TASKS_VIEW,
  FOCUS_TEAM_VIEW,
  NO_BRIDGE_MESSAGE,
  getRadar,
  parseDocFocusId,
} from '../api';
import {
  IconAlert,
  IconChanges,
  IconChecklist,
  IconChevronDown,
  IconFolder,
  IconMail,
  IconSearch,
  IconSettings,
  IconSidebar,
  IconUpload,
  IconVoc,
} from '../components/Icons';
import { EmptyState, ErrorState, LoadingState, NoticeBar, PartialNote } from '../components/StateMessage';
import { BreakNote, WeekTrack } from '../components/WeekTrack';
import { useNotice } from '../hooks/useNotice';
import { useQueue, useReflect } from '../hooks/useQueue';
import { useReply, type ReplyHook } from '../hooks/useReply';
import { useInbox, type InboxHook } from '../hooks/useInbox';
import { useMailboxSummary } from '../hooks/useMailbox';
import { useMe } from '../hooks/useMe';
import { useSetup } from '../hooks/useSetup';
import { useTeamSync } from '../hooks/useTeamSync';
import { draftUnavailableOf, useDraftEngine } from '../hooks/useDraftEngine';
import { parseSettingsFocus } from '../../shared/ipc';
import { useTeamTasks, type TeamTasksHook } from '../hooks/useTeamTasks';
import type { SnapshotHook } from '../hooks/useSnapshot';
import { useVocActions, useVocBoard } from '../hooks/useVocBoard';
import { useWikiSummary } from '../hooks/useWikiDocs';
import { cls } from '../lib/cls';
import { formatClock, formatLongDate, localYmd } from '../lib/date';
import { afterRender, refocusIfLost } from '../lib/focus';
import {
  buildSaveInput,
  draftProblem,
  hasChange,
  initialDraft,
  leavesList,
  nextAfterRemoval,
  saveFailure,
  summarizeSave,
  type ResultDraft,
  type SaveNotice as SaveNoticeData,
} from '../lib/result';
import { buildSendInput, checkReply, sendFailure, summarizeSend, withSentLine } from '../lib/reply';
import { errorText } from '../lib/snapshot';
import { BUCKETS, bucketOf, groupByBucket, isTeamTask, textOf } from '../lib/tasks';
import {
  knownOwners,
  staysMine,
  teamDraftOf,
  teamOwnerLists,
  teamSaveFailure,
  teamSaveInput,
  teamSaveNotice,
  type TeamDraft,
} from '../lib/teamTasks';
import { QUEUE_NO_WIKI, claudeProblem, navAvailability, setupProblemCount, wikiMissing, type NavAvailability } from '../lib/setup';
import { INITIAL_MAIL_SELECTION, navMailInfo, parseMailFocus, type MailSelection, type NavMailInfo } from '../lib/mailbox';
import { INITIAL_VOC_SELECTION, navVocInfo, parseVocFocus, type NavVocInfo, type VocSelection } from '../lib/voc';
import { isQuickSearchKey, navWikiInfo, type NavWikiInfo } from '../lib/wiki';
import { InboxBell } from './full/InboxBell';
import { InfoAside } from './full/InfoAside';
import { MailboxView, useMailTargetState } from './full/mail/MailboxView';
import { QueueView } from './full/QueueView';
import type { ReplyBinding } from './full/ReplyComposer';
import { SaveNotice } from './full/SaveNotice';
import { SettingsView, type SettingsTab } from './full/SettingsView';
import { TaskDetail } from './full/TaskDetail';
import { TaskList } from './full/TaskList';
import type { TeamTaskFormProps } from './full/TeamTaskForm';
import { INITIAL_TEAM_SELECTION, TeamTasksView, type TeamSelection } from './full/TeamTasksView';
import { VocView, type VocTarget } from './full/VocView';
import { FEATURES } from '../../shared/edition';
import { ChangesView, INITIAL_WIKI_CHANGES, type WikiChangesSelection } from './full/wiki/ChangesView';
import { INITIAL_WIKI_SEARCH, SearchView, type WikiSearchSelection } from './full/wiki/SearchView';

/** 선택 상태. id 가 목록에서 사라지면(완료 등) 같은 자리(index)의 항목을 고른다. */
interface Selection {
  id: string | null;
  index: number;
  /** 바깥(onFocusTask)에서 고를 때마다 늘려, 같은 항목이어도 목록을 그 줄로 스크롤한다 */
  reveal: number;
}

/** 내비로 고르는 화면 */
type FullPage = 'tasks' | 'mail' | 'voc' | 'search' | 'changes' | 'queue' | 'setup';
/** 위키가 없을 때 할 일 대신 여는 화면(공개판은 VOC 가 없다 — src/shared/edition.ts) */
const NO_WIKI_PAGE: FullPage = FEATURES.voc ? 'voc' : 'mail';

const LIST_KEYS = new Set(['ArrowDown', 'ArrowUp', 'Home', 'End']);

function isEditable(el: HTMLElement | null): boolean {
  return !!el && (el.isContentEditable || el.closest('input, textarea, select') !== null);
}

/**
 * 모달 대화상자(확인 대화상자 등)가 열려 있거나 키가 대화상자 안에서 왔다. 그때 위/아래 키로 목록 선택을 옮기면
 * 폼이 다른 할 일로 바뀌며 열린 대화상자가 사라지고 초점이 body 로 떨어진다(showModal 은 바깥을 inert 로 만들지만
 * 대화상자 안 버튼의 keydown 은 window 까지 올라온다).
 */
function inDialog(el: HTMLElement | null): boolean {
  if (el?.closest('dialog')) return true;
  return typeof document !== 'undefined' && document.querySelector('dialog[open]') !== null;
}

function Warnings({ warnings }: { warnings: string[] }): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <div className="warnings">
      <button
        type="button"
        className={cls('warnings-toggle', open && 'is-open')}
        aria-expanded={open}
        aria-controls={open ? 'nav-warnings' : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        <IconAlert size={16} />
        <span className="warnings-label">확인할 문제 {warnings.length}건</span>
        <IconChevronDown size={14} className="warnings-chevron" />
      </button>
      {open && (
        <ul id="nav-warnings" className="warnings-list scroll">
          {warnings.map((w, i) => (
            <li key={`${i}:${w}`}>{w}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface FullNavProps {
  snapshot: Snapshot | null;
  today: string;
  page: FullPage;
  queueCount: number;
  /** 'VOC' 옆 표시(팀 미배정 수 — 수가 사실이 아니면 받는 중·로그인 필요·설정 필요·연결 안 됨 글자) */
  voc: NavVocInfo;
  /** '메일' 옆 표시(미확인 스레드 수 — 2.10단계 §8-1). 앱 연결에 메일함이 없으면 없음(메뉴를 숨긴다) */
  mail?: NavMailInfo;
  /** 「위키」 묶음(3a단계 §8-1). 앱 연결에 위키 문서 기능이 없으면 없음(묶음을 숨긴다) */
  wiki?: NavWikiInfo;
  /** 설정(2.7단계 환경 점검 → 2.9단계 설정). 앱 연결에 점검 기능이 없으면 없음 */
  setup?: { problems: number; wikiMissing: boolean };
  /** 쓸 수 없는 메뉴와 그 이유(2.9단계 §1) — 숨기지 않고 흐리게 */
  unavailable: NavAvailability;
  onPage: (page: FullPage) => void;
  onSidebar: () => void;
}

function FullNav({ snapshot, today, page, queueCount, voc, mail, wiki, setup, unavailable, onPage, onSidebar }: FullNavProps): ReactElement {
  const updated = snapshot ? formatClock(snapshot.generatedAt) : '';
  return (
    <nav className="fv-nav" aria-label="보기">
      <div className="brand brand--nav">
        <span className="brand-name">Radar</span>
        <span className="brand-date">{formatLongDate(today)}</span>
      </div>
      <ul className="nav-list">
        <li>
          <button
            type="button"
            className={cls('nav-item', unavailable.tasks && 'is-unavailable')}
            data-testid="nav-tasks"
            data-unavailable={unavailable.tasks ? 'true' : undefined}
            aria-description={unavailable.tasks}
            aria-current={page === 'tasks' ? 'page' : undefined}
            onClick={() => onPage('tasks')}
          >
            <IconChecklist size={18} />
            <span className="nav-item-label">할 일</span>
            {snapshot ? (
              <span className="nav-item-count">{snapshot.tasks.length}</span>
            ) : (
              setup?.wikiMissing && (
                <span className="nav-item-count nav-item-count--note" data-testid="nav-tasks-note">
                  위키 없음
                </span>
              )
            )}
          </button>
        </li>
      </ul>
      <p id="nav-group-incoming" className="nav-group-title" data-testid="nav-group-incoming">
        들어오는 것
      </p>
      <ul className="nav-list" aria-labelledby="nav-group-incoming">
        {mail && (
          <li>
            <button
              type="button"
              className={cls('nav-item', mail.unavailable && 'is-unavailable')}
              data-testid="nav-mail"
              data-count={mail.count}
              data-reply-needed={mail.replyNeeded}
              data-unavailable={mail.unavailable ? 'true' : undefined}
              aria-current={page === 'mail' ? 'page' : undefined}
              aria-description={
                mail.unavailable ??
                (mail.note ? `메일 ${mail.note}` : `미확인 스레드 ${mail.count}개${mail.replyNeeded > 0 ? `, 회신 필요 ${mail.replyNeeded}개` : ''}`)
              }
              onClick={() => onPage('mail')}
            >
              <IconMail size={18} />
              <span className="nav-item-label">메일</span>
              {mail.note ? (
                <span className="nav-item-count nav-item-count--note" data-testid="nav-mail-note">
                  {mail.note}
                </span>
              ) : (
                <>
                  {mail.replyNeeded > 0 && <span className="nav-mail-dot" aria-hidden="true" title={`회신 필요 ${mail.replyNeeded}`} />}
                  <span className={cls('nav-item-count', mail.count === 0 && 'is-zero')}>{mail.count}</span>
                </>
              )}
            </button>
          </li>
        )}
        {FEATURES.voc && (
          <li>
            <button
              type="button"
              className={cls('nav-item', unavailable.voc && 'is-unavailable')}
              data-testid="nav-voc"
              data-count={voc.count}
              data-unavailable={unavailable.voc ? 'true' : undefined}
              aria-current={page === 'voc' ? 'page' : undefined}
              aria-description={voc.description}
              onClick={() => onPage('voc')}
            >
              <IconVoc size={18} />
              <span className="nav-item-label">VOC</span>
              {voc.note ? (
                <span className="nav-item-count nav-item-count--note" data-testid="nav-voc-note">
                  {voc.note}
                </span>
              ) : (
                <span className={cls('nav-item-count', voc.count === 0 && 'is-zero')}>{voc.count}</span>
              )}
            </button>
          </li>
        )}
      </ul>
      {wiki && (
        <>
          <p id="nav-group-wiki" className="nav-group-title" data-testid="nav-group-wiki">
            위키
          </p>
          <ul className="nav-list" aria-labelledby="nav-group-wiki">
            <li>
              <button
                type="button"
                className={cls('nav-item', wiki.unavailable && 'is-unavailable')}
                data-testid="nav-search"
                data-unavailable={wiki.unavailable ? 'true' : undefined}
                aria-current={page === 'search' ? 'page' : undefined}
                aria-description={wiki.unavailable}
                aria-keyshortcuts="Control+K"
                title="위키 검색 (Ctrl+K)"
                onClick={() => onPage('search')}
              >
                <IconSearch size={18} />
                <span className="nav-item-label">검색</span>
                <kbd className="nav-item-kbd">Ctrl+K</kbd>
              </button>
            </li>
            <li>
              <button
                type="button"
                className={cls('nav-item', wiki.unavailable && 'is-unavailable')}
                data-testid="nav-changes"
                data-count={wiki.count}
                data-personal={wiki.personal}
                data-team={wiki.team}
                data-unavailable={wiki.unavailable ? 'true' : undefined}
                aria-current={page === 'changes' ? 'page' : undefined}
                aria-description={
                  wiki.unavailable ?? (wiki.note ? `위키 변경 ${wiki.note}` : `안 읽은 변경 ${wiki.count}건(개인 ${wiki.personal}, 팀 ${wiki.team})`)
                }
                onClick={() => onPage('changes')}
              >
                <IconChanges size={18} />
                <span className="nav-item-label">변경</span>
                {wiki.note && !wiki.unavailable ? (
                  <span className="nav-item-count nav-item-count--note" data-testid="nav-changes-note">
                    {wiki.note}
                  </span>
                ) : (
                  <span className={cls('nav-item-count', wiki.count === 0 && 'is-zero')}>{wiki.count}</span>
                )}
              </button>
            </li>
          </ul>
        </>
      )}
      <p id="nav-group-record" className="nav-group-title" data-testid="nav-group-record">
        남기기
      </p>
      <ul className="nav-list" aria-labelledby="nav-group-record">
        <li>
          <button
            type="button"
            className={cls('nav-item', unavailable.queue && 'is-unavailable')}
            data-testid="nav-queue"
            data-count={queueCount}
            data-unavailable={unavailable.queue ? 'true' : undefined}
            aria-description={unavailable.queue}
            aria-current={page === 'queue' ? 'page' : undefined}
            onClick={() => onPage('queue')}
          >
            <IconUpload size={18} />
            <span className="nav-item-label">반영 대기</span>
            <span className={cls('nav-item-count', queueCount === 0 && 'is-zero')}>{queueCount}</span>
          </button>
        </li>
      </ul>
      <div className="nav-foot">
        {snapshot?.partial && <PartialNote />}
        {snapshot && snapshot.warnings.length > 0 && <Warnings warnings={snapshot.warnings} />}
        {snapshot && (
          <p className="nav-status">
            <span>위키 문서 {snapshot.pageCount}개</span>
            {updated && <span>{updated} 갱신</span>}
          </p>
        )}
        {setup && (
          <button
            type="button"
            className="nav-item nav-item--setup"
            data-testid="nav-setup"
            data-count={setup.problems}
            aria-current={page === 'setup' ? 'page' : undefined}
            aria-description={setup.problems > 0 ? `쓸 수 없는 항목 ${setup.problems}개` : '모든 항목을 쓸 수 있습니다'}
            onClick={() => onPage('setup')}
          >
            <IconSettings size={18} />
            <span className="nav-item-label">설정</span>
            {setup.problems > 0 && <span className="nav-item-count nav-item-count--note">{setup.problems}</span>}
          </button>
        )}
        <button
          type="button"
          className="nav-sidebar-btn"
          data-testid="btn-sidebar"
          aria-keyshortcuts="Control+Alt+R"
          onClick={onSidebar}
        >
          <IconSidebar size={18} />
          <span className="nav-sidebar-label">사이드바로</span>
          <kbd>Ctrl+Alt+R</kbd>
        </button>
      </div>
    </nav>
  );
}

/** 처리 결과 입력 상태(초안·저장 중·알림). FullView 가 들고 Workspace 에 내려 준다 */
interface ResultForms {
  draftOf: (task: Task) => ResultDraft;
  setDraft: (taskId: string, draft: ResultDraft) => void;
  resetDraft: (taskId: string) => void;
  savingId: string | null;
  /** 저장. 성공하면 저장한 상태, 실패하면 null */
  save: (task: Task) => Promise<TaskStatus | null>;
  /** 회신을 보내고 저장(확인 대화상자의 [보내기] 뒤). 보내고 저장까지 했으면 저장한 상태, 아니면 null */
  send: (task: Task) => Promise<TaskStatus | null>;
  notice: SaveNoticeData | null;
  closeNotice: () => void;
  /** 다른 저장(팀 할 일 — 2.9단계 §4-3)의 결과를 같은 알림 띠에 보인다 */
  pushNotice: (make: (id: number) => SaveNoticeData) => void;
}

function useResultForms(reply: ReplyHook): ResultForms {
  const [drafts, setDrafts] = useState<ReadonlyMap<string, ResultDraft>>(() => new Map());
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const [savingId, setSavingId] = useState<string | null>(null);
  // 두 번 누르기 방지: 상태 갱신은 다음 그리기에 반영되므로 ref 로 바로 막는다.
  const savingRef = useRef<string | null>(null);
  const [notice, setNotice] = useState<SaveNoticeData | null>(null);
  const noticeSeq = useRef(0);

  const draftOf = useCallback((task: Task) => drafts.get(task.id) ?? initialDraft(task), [drafts]);
  const setDraft = useCallback((taskId: string, draft: ResultDraft) => {
    setDrafts((prev) => new Map(prev).set(taskId, draft));
  }, []);
  const resetDraft = useCallback((taskId: string) => {
    setDrafts((prev) => {
      if (!prev.has(taskId)) return prev;
      const next = new Map(prev);
      next.delete(taskId);
      return next;
    });
  }, []);
  const closeNotice = useCallback(() => setNotice(null), []);
  const pushNotice = useCallback((make: (id: number) => SaveNoticeData) => setNotice(make(++noticeSeq.current)), []);

  const save = useCallback(async (task: Task): Promise<TaskStatus | null> => {
    if (savingRef.current) return null;
    const draft = draftsRef.current.get(task.id) ?? initialDraft(task);
    if (!hasChange(task, draft) || draftProblem(draft)) return null;
    const input = buildSaveInput(task, draft);
    savingRef.current = task.id;
    setSavingId(task.id);
    const id = ++noticeSeq.current;
    try {
      const api = getRadar();
      if (!api) throw new Error(NO_BRIDGE_MESSAGE);
      if (typeof api.saveResult !== 'function') {
        throw new Error('이 앱 연결에는 저장 기능이 없습니다. 앱을 새 버전으로 다시 빌드해 주세요.');
      }
      const out = await api.saveResult(input);
      setNotice(summarizeSave(task, input, out, id));
      // 저장한 초안만 지운다(저장하는 동안 더 고쳤으면 그 입력은 남긴다)
      setDrafts((prev) => {
        if (prev.get(task.id) !== draft) return prev;
        const next = new Map(prev);
        next.delete(task.id);
        return next;
      });
      return input.status;
    } catch (err) {
      setNotice(saveFailure(task, errorText(err), id));
      return null;
    } finally {
      savingRef.current = null;
      setSavingId(null);
    }
  }, []);

  const { peek, reset: resetReply, loadContext } = reply;
  const send = useCallback(
    async (task: Task): Promise<TaskStatus | null> => {
      if (savingRef.current) return null;
      const draft = draftsRef.current.get(task.id) ?? initialDraft(task);
      const { reply: state, context } = peek(task.id);
      if (!state?.enabled || draftProblem(draft) || !checkReply(state, context).ok) return null;
      const input = buildSendInput(state, task, draft);
      savingRef.current = task.id;
      setSavingId(task.id);
      const id = ++noticeSeq.current;
      try {
        const api = getRadar();
        if (!api) throw new Error(NO_BRIDGE_MESSAGE);
        if (typeof api.sendReply !== 'function') {
          throw new Error('이 앱 연결에는 메일 회신 기능이 없습니다. 앱을 새 버전으로 다시 빌드해 주세요.');
        }
        const out = await api.sendReply(input);
        // 메일은 나갔다 — 저장이 실패했어도 회신 칸을 닫는다(같은 sendId 로 다시 보내지 않게, 다음에 켜면 새 칸)
        resetReply(task.id);
        loadContext(task.id); // 지난 발송 배지
        setNotice(summarizeSend(task, input, out, id));
        const saved = !!out && typeof out === 'object' && !!out.save && !textOf(out.saveError);
        if (saved) {
          // 저장한 초안만 지운다(보내는 동안 더 고쳤으면 그 입력은 남긴다)
          setDrafts((prev) => {
            if (prev.get(task.id) !== draft) return prev;
            const next = new Map(prev);
            next.delete(task.id);
            return next;
          });
          return input.save.status;
        }
        // 보냈지만 저장 실패: 처리 결과 입력은 남기고 처리 내용에 발송 줄을 붙여 둔다 — 같은 상태로 다시 [저장]하면 메모에 남는다
        setDrafts((prev) => new Map(prev).set(task.id, withSentLine(prev.get(task.id) ?? draft, input)));
        return null;
      } catch (err) {
        setNotice(sendFailure(task, errorText(err), id));
        return null;
      } finally {
        savingRef.current = null;
        setSavingId(null);
      }
    },
    [peek, resetReply, loadContext],
  );

  return { draftOf, setDraft, resetDraft, savingId, save, send, notice, closeNotice, pushNotice };
}

/** 팀 할 일 입력 상태(2.9단계 §4-3) — 초안은 taskId 별로 메모리에. 저장 알림은 처리 결과 알림 띠를 같이 쓴다 */
interface TeamForms {
  supported: boolean;
  draftOf: (task: Task) => TeamDraft;
  setDraft: (taskId: string, draft: TeamDraft) => void;
  resetDraft: (taskId: string) => void;
  savingId: string | null;
  /** 저장. 성공하면 저장한 초안(목록에서 빠지는지 판단용), 실패·바뀐 것 없음이면 null */
  save: (task: Task) => Promise<TeamDraft | null>;
}

function useTeamForms(team: TeamTasksHook, forms: ResultForms): TeamForms {
  const [drafts, setDrafts] = useState<ReadonlyMap<string, TeamDraft>>(() => new Map());
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const [savingId, setSavingId] = useState<string | null>(null);
  const savingRef = useRef<string | null>(null);
  const { pushNotice } = forms;
  const { save: saveTeam } = team;

  const draftOf = useCallback((task: Task) => drafts.get(task.id) ?? teamDraftOf(task), [drafts]);
  const setDraft = useCallback((taskId: string, draft: TeamDraft) => setDrafts((prev) => new Map(prev).set(taskId, draft)), []);
  const resetDraft = useCallback((taskId: string) => {
    setDrafts((prev) => {
      if (!prev.has(taskId)) return prev;
      const next = new Map(prev);
      next.delete(taskId);
      return next;
    });
  }, []);

  const save = useCallback(
    async (task: Task): Promise<TeamDraft | null> => {
      if (savingRef.current) return null;
      const draft = draftsRef.current.get(task.id) ?? teamDraftOf(task);
      const input = teamSaveInput(task, draft);
      if (!input) return null;
      savingRef.current = task.id;
      setSavingId(task.id);
      try {
        const out = await saveTeam(input);
        pushNotice((id) => teamSaveNotice(task, input, out, id));
        setDrafts((prev) => {
          if (prev.get(task.id) !== draft) return prev;
          const next = new Map(prev);
          next.delete(task.id);
          return next;
        });
        return draft;
      } catch (err) {
        pushNotice((id) => teamSaveFailure(task, errorText(err), id));
        return null;
      } finally {
        savingRef.current = null;
        setSavingId(null);
      }
    },
    [saveTeam, pushNotice],
  );

  return { supported: team.supported, draftOf, setDraft, resetDraft, savingId, save };
}

type TasksTab = 'mine' | 'team';

/** [내 할 일 | 팀 전체] 탭(2.9단계 §4-1). 화살표 키로 옮기며 바로 연다 */
function TasksTabs({ tab, onTab }: { tab: TasksTab; onTab: (tab: TasksTab) => void }): ReactElement {
  const refs = useRef(new Map<TasksTab, HTMLButtonElement>());
  const tabs: readonly { key: TasksTab; label: string }[] = [
    { key: 'mine', label: '내 할 일' },
    { key: 'team', label: '팀 전체' },
  ];
  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    const next: TasksTab =
      e.key === 'Home' ? 'mine' : e.key === 'End' ? 'team' : tab === 'mine' ? 'team' : 'mine';
    onTab(next);
    refs.current.get(next)?.focus();
  };
  return (
    <div className="sv-tabs tasks-tabs" role="tablist" aria-label="할 일 보기" onKeyDown={onKey}>
      {tabs.map((t) => {
        const selected = t.key === tab;
        return (
          <button
            key={t.key}
            type="button"
            role="tab"
            className={cls('sv-tab', selected && 'is-selected')}
            data-testid={`tasks-tab-${t.key}`}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            ref={(el) => {
              if (el) refs.current.set(t.key, el);
              else refs.current.delete(t.key);
            }}
            onClick={() => onTab(t.key)}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

/** 제출 버튼([저장] 또는 회신이 켜졌을 때 [보내고 저장]) */
const SUBMIT_SELECTOR = '[data-testid="btn-save"], [data-testid="btn-send"]';

interface WorkspaceProps {
  snapshot: Snapshot;
  selection: Selection;
  onSelectionChange: Dispatch<SetStateAction<Selection>>;
  onOpenFile: (path: string) => void;
  listRef: RefObject<HTMLDivElement | null>;
  forms: ResultForms;
  reply: ReplyHook;
  /** '기타' 구간을 폈는가. FullView 가 들고 있다 — 반영 대기 화면에 다녀와도(Workspace 가 새로 그려져도) 그대로 */
  otherOpen: boolean;
  setOtherOpen: Dispatch<SetStateAction<boolean>>;
  /** claude 가 없어 회신 초안을 만들 수 없는 이유(2.7단계) */
  claudeMissing: string | null;
  /** 팀 동기화가 켜져 개인·팀 할 일이 섞였는가(출처 칩 — 2.9단계 §4-2) */
  mixed: boolean;
  /** 목록 머리 위 [내 할 일 | 팀 전체] 탭(팀 동기화가 꺼져 있으면 없음) */
  tabs?: ReactNode;
  /** 팀 할 일 입력(2.9단계 §4-3) */
  teamForms: TeamForms;
  /** 나의 이름들(팀 할 일 담당이 나에게서 빠지는지) */
  myNames: readonly string[];
  knownOwners: readonly string[];
  onOpenTeamDoc: (path: string) => void;
  /** 설정 › 메일 보내기를 연다(회신 칸의 [설정에서 보기]) */
  onOpenMailSettings?: () => void;
}

function Workspace({
  snapshot,
  selection,
  onSelectionChange,
  onOpenFile,
  listRef,
  forms,
  reply,
  otherOpen,
  setOtherOpen,
  claudeMissing,
  mixed,
  tabs,
  teamForms,
  myNames,
  knownOwners: owners,
  onOpenMailSettings,
  onOpenTeamDoc,
}: WorkspaceProps): ReactElement {
  const { week, tasks } = snapshot;
  const groups = useMemo(() => groupByBucket(tasks), [tasks]);
  const ordered = useMemo(() => BUCKETS.flatMap((b) => groups[b]), [groups]);

  const foundIndex = selection.id ? ordered.findIndex((t) => t.id === selection.id) : -1;
  // 고른 항목이 빠지면(완료 등) 그 항목이 마지막으로 보였던 자리를 쓴다 — 사이드바에서 연 항목은 selection.index 가 0 이다.
  const lastSeen = useRef<{ id: string | null; index: number }>({ id: null, index: 0 });
  if (foundIndex >= 0) lastSeen.current = { id: selection.id, index: foundIndex };
  const fallbackIndex = lastSeen.current.id === selection.id ? lastSeen.current.index : selection.index;
  const selectedIndex =
    ordered.length === 0 ? -1 : foundIndex >= 0 ? foundIndex : Math.min(Math.max(fallbackIndex, 0), ordered.length - 1);
  const selected: Task | null = selectedIndex >= 0 ? ordered[selectedIndex] : null;
  const selectedId = selected?.id ?? null;
  const selectedBucket = selected ? bucketOf(selected) : null;
  // 저장하는 동안 사람이 다른 항목을 골랐는지 알기 위해. 고른 id 가 아니라 선택 상태 객체를 본다 —
  // main 은 답보다 새 스냅샷을 먼저 보내므로, 완료한 항목은 답이 오기 전에 목록에서 빠져 있을 수 있다.
  const selectionRef = useRef(selection);
  selectionRef.current = selection;

  // 기타 구간의 항목이 골라지면(사이드바 '기타 N건' 등) 기타를 편다. 사용자가 접는 것은 막지 않는다.
  useEffect(() => {
    if (selectedBucket === 'other') setOtherOpen(true);
  }, [selectedId, selectedBucket, setOtherOpen]);

  const visible = useMemo(
    () => (otherOpen ? ordered : ordered.filter((t) => bucketOf(t) !== 'other')),
    [ordered, otherOpen],
  );
  const focusableId = selected && visible.some((t) => t.id === selected.id) ? selected.id : (visible[0]?.id ?? null);

  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const registerRow = useCallback((id: string, el: HTMLButtonElement | null) => {
    // 다시 그릴 때 React 는 옛 ref 에 null, 새 ref 에 요소를 차례로 넘긴다(지웠다 다시 넣는다).
    if (el) rowRefs.current.set(id, el);
    else rowRefs.current.delete(id);
  }, []);

  const select = useCallback(
    (task: Task) => {
      onSelectionChange((prev) => ({ id: task.id, index: Math.max(0, ordered.indexOf(task)), reveal: prev.reveal }));
    },
    [onSelectionChange, ordered],
  );

  // 바깥에서 고른 항목(또는 기타가 펴진 뒤)이 보이도록 목록을 스크롤한다.
  useEffect(() => {
    if (!selectedId) return;
    rowRefs.current.get(selectedId)?.scrollIntoView({ block: 'nearest' });
  }, [selection.reveal, selectedId, otherOpen]);

  // 항목이 바뀌면 상세·오른쪽 열을 맨 위부터 보인다.
  const detailRef = useRef<HTMLDivElement>(null);
  const asideRef = useRef<HTMLElement>(null);
  useEffect(() => {
    detailRef.current?.scrollTo({ top: 0 });
    asideRef.current?.scrollTo({ top: 0 });
  }, [selectedId]);

  // 위/아래(목록 안에서는 Home/End 도) 키로 선택을 옮긴다.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || !LIST_KEYS.has(e.key)) return;
      const target = e.target instanceof HTMLElement ? e.target : null;
      if (isEditable(target) || inDialog(target)) return;
      const inList = !!target && !!listRef.current?.contains(target);
      if ((e.key === 'Home' || e.key === 'End') && !inList) return;
      if (visible.length === 0) return;

      const current = selectedId ? visible.findIndex((t) => t.id === selectedId) : -1;
      let next: number;
      if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = visible.length - 1;
      else if (current < 0) next = e.key === 'ArrowDown' ? 0 : visible.length - 1;
      else next = Math.min(visible.length - 1, Math.max(0, current + (e.key === 'ArrowDown' ? 1 : -1)));
      e.preventDefault();

      const task = visible[next];
      select(task);
      const row = rowRefs.current.get(task.id);
      const focusIsFree = !target || target === document.body || target === document.documentElement;
      if (inList || focusIsFree) row?.focus();
      else row?.scrollIntoView({ block: 'nearest' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, selectedId, select, listRef]);

  const { save, send } = forms;
  const submit = useCallback(
    async (task: Task, mode: 'save' | 'send'): Promise<void> => {
      // 빠질 때 옮겨 갈 항목은 저장 전 목록으로 정한다(저장 뒤 스냅샷에는 이미 빠져 있을 수 있다).
      const pool = visible.some((t) => t.id === task.id) ? visible : ordered;
      const nextId = nextAfterRemoval(
        pool.map((t) => t.id),
        task.id,
      );
      const index = Math.max(0, ordered.findIndex((t) => t.id === task.id));
      const started = selectionRef.current;
      const saved = mode === 'send' ? await send(task) : await save(task);
      if (selectionRef.current !== started) return;
      if (!saved) {
        // 실패(또는 일부만 저장·보냈지만 저장 실패): 저장 중 비활성이던 제출 버튼에서 떨어진 초점을 제출 버튼으로(다시 누를 수 있게),
        // 안 되면 고른 상태 라디오로
        refocusIfLost(
          () => detailRef.current?.querySelector<HTMLButtonElement>(SUBMIT_SELECTOR),
          () => detailRef.current?.querySelector<HTMLInputElement>('input[name="result-status"]:checked'),
        );
        return;
      }
      if (leavesList(saved)) {
        // 완료·내 일 아님은 목록에서 빠진다 → 다음 항목으로
        onSelectionChange((prev) => ({ id: nextId, index, reveal: prev.reveal + 1 }));
        refocusIfLost(() => (nextId ? rowRefs.current.get(nextId) : null));
      } else {
        // 같은 항목에 남는다. 누른 [저장]이 비활성이 되어 초점이 떨어졌으면 고른 상태 라디오로 돌려놓는다.
        refocusIfLost(() => detailRef.current?.querySelector<HTMLInputElement>('input[name="result-status"]:checked'));
      }
    },
    [visible, ordered, save, send, onSelectionChange],
  );

  // 팀 할 일 저장: 완료하거나 담당을 내가 아닌 사람으로 바꾸면 내 할 일 목록에서 빠진다 → 다음 항목으로
  const { save: saveTeam } = teamForms;
  const submitTeam = useCallback(
    async (task: Task): Promise<void> => {
      const pool = visible.some((t) => t.id === task.id) ? visible : ordered;
      const nextId = nextAfterRemoval(
        pool.map((t) => t.id),
        task.id,
      );
      const index = Math.max(0, ordered.findIndex((t) => t.id === task.id));
      const started = selectionRef.current;
      const saved = await saveTeam(task);
      if (selectionRef.current !== started) return;
      if (!saved) {
        refocusIfLost(() => detailRef.current?.querySelector<HTMLButtonElement>('[data-testid="team-form-save"]'));
        return;
      }
      const ownersChanged = saved.owners !== teamDraftOf(task).owners;
      if (saved.status === 'done' || (ownersChanged && !staysMine(saved, myNames))) {
        onSelectionChange((prev) => ({ id: nextId, index, reveal: prev.reveal + 1 }));
        refocusIfLost(() => (nextId ? rowRefs.current.get(nextId) : null));
      } else {
        refocusIfLost(() => detailRef.current?.querySelector<HTMLInputElement>('input[name="team-status"]:checked'));
      }
    },
    [visible, ordered, saveTeam, myNames, onSelectionChange],
  );

  // 알림을 닫으면 닫기 버튼이 사라져 초점이 떨어진다 — 제출 버튼(누를 수 있으면) 또는 상세 제목으로 돌려놓는다.
  // (잠시 뒤 저절로 닫힐 때는 초점이 다른 곳에 있으므로 건드리지 않는다.) SaveNotice 의 타이머가 매번 새로 걸리지 않게 고정 함수로.
  const { closeNotice: closeNoticeRaw } = forms;
  const closeNotice = useCallback(() => {
    closeNoticeRaw();
    refocusIfLost(
      () => detailRef.current?.querySelector<HTMLButtonElement>(SUBMIT_SELECTOR),
      () => detailRef.current?.querySelector<HTMLElement>('#detail-title'),
      1,
    );
  }, [closeNoticeRaw]);
  const notice = forms.notice ? <SaveNotice notice={forms.notice} onClose={closeNotice} /> : null;

  // 메일 할 일의 회신 작성 칸(2.5단계 명세 §7). 처리 내용(초안이 전할 핵심)은 누를 때의 처리 결과 초안에서 넣는다
  const replyBinding = (task: Task): ReplyBinding | undefined => {
    if (!textOf(task.mail)) return undefined;
    return {
      supported: reply.supported,
      state: reply.replyOf(task.id),
      context: reply.contextOf(task.id),
      settings: reply.settings,
      today: week.today,
      draftBusy: reply.draftingId !== null,
      draftingHere: reply.draftingId === task.id,
      draftUnavailable: claudeMissing,
      onChange: (fn) => reply.update(task.id, fn),
      onToggle: (on) => reply.toggle(task.id, on),
      onReset: () => reply.reset(task.id),
      onLoadContext: () => reply.loadContext(task.id),
      onLoadSettings: reply.loadSettings,
      onSaveSettings: async (value) => {
        const problem = await reply.saveSettings(value);
        if (!problem) reply.loadContext(task.id); // 보내는 쪽 줄의 이름·숨은참조
        return problem;
      },
      onDraft: () => reply.startDraft(task.id, forms.draftOf(task).note),
      onCancelDraft: () => reply.cancelDraft(task.id),
      onOpenFile,
      ...(onOpenMailSettings ? { onOpenSettings: onOpenMailSettings } : {}),
    };
  };

  return (
    <>
      <section className="fv-list" aria-label="이번 주 할 일">
        <div className="fv-list-head">
          {tabs}
          {snapshot.personalMissing && (
            <p className="personal-missing" data-testid="personal-missing">
              개인 위키 없음 — 팀 위키 할 일만 봅니다
            </p>
          )}
          <div className="section-head">
            <h2 className="fv-list-title">이번 주 할 일</h2>
            <BreakNote week={week} />
          </div>
          <WeekTrack week={week} variant="full" />
        </div>
        <TaskList
          ref={listRef}
          groups={groups}
          today={week.today}
          selectedId={selectedId}
          focusableId={focusableId}
          otherOpen={otherOpen}
          onToggleOther={() => setOtherOpen((v) => !v)}
          onSelect={select}
          registerRow={registerRow}
          mixed={mixed}
        />
      </section>
      <TaskDetail
        ref={detailRef}
        task={selected}
        today={week.today}
        onOpenFile={onOpenFile}
        onOpenTeamDoc={onOpenTeamDoc}
        notice={notice}
        teamForm={
          selected && isTeamTask(selected) && teamForms.supported
            ? {
                draft: teamForms.draftOf(selected),
                onChange: (draft) => teamForms.setDraft(selected.id, draft),
                onCancel: () => teamForms.resetDraft(selected.id),
                onSubmit: () => void submitTeam(selected),
                saving: teamForms.savingId === selected.id,
                busy: (teamForms.savingId !== null && teamForms.savingId !== selected.id) || forms.savingId !== null,
                myName: myNames[0],
                knownOwners: owners,
              }
            : undefined
        }
        form={
          selected
            ? {
                draft: forms.draftOf(selected),
                onChange: (draft) => forms.setDraft(selected.id, draft),
                onCancel: () => forms.resetDraft(selected.id),
                onSubmit: () => void submit(selected, 'save'),
                onSend: () => void submit(selected, 'send'),
                reply: replyBinding(selected),
                saving: forms.savingId === selected.id,
                busy: forms.savingId !== null && forms.savingId !== selected.id,
              }
            : undefined
        }
      />
      <InfoAside
        ref={asideRef}
        task={selected}
        version={snapshot.generatedAt}
        today={week.today}
        onOpenFile={onOpenFile}
        onOpenTeamDoc={onOpenTeamDoc}
      />
    </>
  );
}

export function FullView({ state, reload }: SnapshotHook): ReactElement {
  const { notice, notify, run } = useNotice();
  const snapshot = state.status === 'ready' ? state.snapshot : null;
  const today = snapshot?.week.today ?? localYmd(new Date());
  const [selection, setSelection] = useState<Selection>({ id: null, index: 0, reveal: 0 });
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const [page, setPage] = useState<FullPage>('tasks');
  // '기타' 구간을 폈는가 — 화면(할 일 ↔ 반영 대기)을 오가도 유지한다(Workspace 는 할 일 화면에서만 그려진다)
  const [otherOpen, setOtherOpen] = useState(false);
  // 사이드바 '반영 N' 으로 반영 대기 화면을 열 때마다 늘린다 — 그 화면이 제목으로 초점을 옮긴다
  const [queueFocus, setQueueFocus] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const reply = useReply();
  const setup = useSetup();
  const [setupFocus, setSetupFocus] = useState(0);
  // 설정 화면의 칸(점검 · 나 · 알림) — 메모리에만. 바깥에서 view:setup 이 오면 점검 칸으로
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('check');
  // 알림함(2.9단계 §8-1): view:inbox 가 올 때마다 늘려 종 판을 펼친다
  const inbox = useInbox();
  const [inboxRequest, setInboxRequest] = useState(0);
  // 사람이 내비·사이드바로 화면을 고른 적이 있는가 — 없을 때만 위키가 없으면 VOC 화면으로 연다
  const pageChosen = useRef(false);
  const forms = useResultForms(reply);
  // 팀 위키 할 일(2.9단계 B): 보드·탭·팀 칸 선택·팀 할 일 입력
  const teamTasks = useTeamTasks();
  const teamSync = useTeamSync();
  const teamForms = useTeamForms(teamTasks, forms);
  const [tasksTab, setTasksTab] = useState<TasksTab>('mine');
  const [teamSelection, setTeamSelection] = useState<TeamSelection>(INITIAL_TEAM_SELECTION);
  const queue = useQueue();
  const reflect = useReflect();
  // VOC(2.6단계): 보드·쓰기 상태·화면 선택. 사이드바 'VOC 미배정 N' 으로 열 때마다 vocFocus 를 늘린다
  const voc = useVocBoard();
  const vocActions = useVocActions();
  const [vocSelection, setVocSelection] = useState<VocSelection>(INITIAL_VOC_SELECTION);
  // 메일함(2.10단계 §8): 요약(내비 배지) · 화면 선택 · 바깥에서 고른 메일(view:mail:<키>)
  const mailbox = useMailboxSummary();
  const [mailSelection, setMailSelection] = useState<MailSelection>(INITIAL_MAIL_SELECTION);
  const [mailTarget, openMailTarget, doneMailTarget] = useMailTargetState();
  // 위키(3a단계 §8): 요약(내비 배지) · 검색·변경 화면 선택 · 검색 칸 초점 요청(Ctrl+K·view:search)
  const wiki = useWikiSummary();
  const [wikiSearch, setWikiSearch] = useState<WikiSearchSelection>(INITIAL_WIKI_SEARCH);
  const [wikiChanges, setWikiChanges] = useState<WikiChangesSelection>(INITIAL_WIKI_CHANGES);
  const [searchFocus, setSearchFocus] = useState(0);
  const [vocFocus, setVocFocus] = useState(0);
  const [vocTarget, setVocTarget] = useState<VocTarget | null>(null);
  const vocTargetSeq = useRef(0);
  const doneVocTarget = useCallback((seq: number) => {
    setVocTarget((prev) => (prev && prev.seq === seq ? null : prev));
  }, []);
  // 로그인 대화상자를 띄우라는 바깥 요청(사이드바 'VOC 로그인 필요'·할 일 상세의 [로그인] — 명세 §13). VOC 화면이 띄우면 null 로
  const [vocLoginRequest, setVocLoginRequest] = useState<number | null>(null);
  const vocLoginSeq = useRef(0);
  const doneVocLogin = useCallback((seq: number) => {
    setVocLoginRequest((prev) => (prev === seq ? null : prev));
  }, []);

  // 사이드바에서 누른 항목(main 이 IPC.focusTask 로 보낸다). 스냅샷보다 먼저 와도 기억해 둔다.
  // 사이드바 상태 줄의 "반영 N"은 항목 대신 FOCUS_QUEUE_VIEW 를, "VOC"는 FOCUS_VOC_VIEW('view:voc[:<티켓>]')를 보낸다.
  useEffect(() => {
    const api = getRadar();
    if (!api) return;
    let off: (() => void) | undefined;
    try {
      off = api.onFocusTask((taskId) => {
        if (typeof taskId !== 'string' || taskId === '') return;
        pageChosen.current = true;
        const tab: SettingsTab | null = taskId === FOCUS_SETUP_VIEW ? 'check' : parseSettingsFocus(taskId);
        if (tab) {
          setPage('setup');
          setSettingsTab(tab);
          setSetupFocus((n) => n + 1);
          return;
        }
        if (taskId === FOCUS_INBOX_VIEW) {
          setInboxRequest((n) => n + 1);
          return;
        }
        if (taskId === FOCUS_TEAM_VIEW || taskId === FOCUS_TASKS_VIEW) {
          setPage('tasks');
          setTasksTab(taskId === FOCUS_TEAM_VIEW ? 'team' : 'mine');
          return;
        }
        if (taskId === FOCUS_SEARCH_VIEW) {
          setPage('search');
          setSearchFocus((n) => n + 1);
          return;
        }
        if (taskId === FOCUS_CHANGES_VIEW) {
          setPage('changes');
          setWikiChanges((s) => ({ ...s, tab: null }));
          return;
        }
        const docReq = parseDocFocusId(taskId);
        if (docReq) {
          setPage('search');
          setWikiSearch((s) => ({ ...s, selected: docReq }));
          return;
        }
        if (taskId === FOCUS_QUEUE_VIEW) {
          setPage('queue');
          setQueueFocus((n) => n + 1);
          return;
        }
        const mailFocusReq = parseMailFocus(taskId);
        if (mailFocusReq) {
          setPage('mail');
          if (mailFocusReq.key) openMailTarget(mailFocusReq.key);
          return;
        }
        const vocFocusReq = parseVocFocus(taskId);
        if (vocFocusReq) {
          setPage('voc');
          setVocFocus((n) => n + 1);
          if (vocFocusReq.ref) setVocTarget({ ref: vocFocusReq.ref, seq: ++vocTargetSeq.current });
          if (vocFocusReq.login) setVocLoginRequest(++vocLoginSeq.current);
          return;
        }
        // 사이드바에서 누른 항목(팀 할 일 포함)은 내 할 일 탭에서 연다
        setPage('tasks');
        setTasksTab('mine');
        setSelection((prev) => ({ id: taskId, index: 0, reveal: prev.reveal + 1 }));
      });
    } catch {
      // 구독하지 못하면 기본 선택(첫 항목)만 쓴다.
    }
    return () => {
      if (typeof off === 'function') off();
    };
  }, []);

  // 앱 안 빠른 검색 Ctrl+K(§8-5): 검색 화면 + 검색 칸 초점·글자 전체 선택. 대화상자 안·IME 조합 중은 무시
  const wikiSupported = wiki.supported;
  useEffect(() => {
    if (!wikiSupported) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || !isQuickSearchKey(e)) return;
      const target = e.target instanceof HTMLElement ? e.target : null;
      if (inDialog(target)) return;
      e.preventDefault();
      pageChosen.current = true;
      setPage('search');
      setSearchFocus((n) => n + 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [wikiSupported]);

  // 저장하고 나면 대기열을 한 번 더 읽는다(반영을 켜고 저장했을 때 main 의 알림을 놓쳐도 수가 맞게).
  const { refresh: refreshQueue } = queue;
  const lastNoticeId = useRef<number | null>(null);
  useEffect(() => {
    if (!forms.notice || forms.notice.id === lastNoticeId.current) return;
    lastNoticeId.current = forms.notice.id;
    if (forms.notice.tone !== 'error') refreshQueue();
  }, [forms.notice, refreshQueue]);

  const toSidebar = (): void => {
    void run((api) => api.setMode('sidebar'), '사이드바로 바꾸지 못했습니다.');
  };
  const openFile = useCallback(
    (path: string): void => {
      void run((api) => api.openInObsidian(path), 'Obsidian에서 열지 못했습니다.');
    },
    [run],
  );
  const openTeamDoc = useCallback(
    (path: string): void => {
      void run((api) => api.openTeamDoc(path), '팀 위키 문서를 Obsidian에서 열지 못했습니다.');
    },
    [run],
  );
  const openVocWeb = useCallback(
    (ticketId: number): void => {
      void run((api) => api.openVocWeb(ticketId), 'VOC 웹에서 열지 못했습니다.');
    },
    [run],
  );
  /**
   * 할 일 목록의 고른 줄로 초점을 옮긴다(목록이 다시 그려진 뒤). 고른 줄이 아직 없으면(기타 구간이 펴지는 중 등)
   * 몇 프레임 기다리고, 끝내 없으면(고른 항목이 목록에서 빠짐) 목록의 Tab 자리 줄(tabindex=0)로.
   */
  const focusList = (): void => {
    let frames = 3;
    const run = (): void => {
      const list = listRef.current;
      if (!list) return;
      const id = selectionRef.current.id;
      const rows = list.querySelectorAll<HTMLButtonElement>('.row[data-task-id]');
      const selected = id ? [...rows].find((r) => r.dataset.taskId === id) : undefined;
      if (selected) {
        selected.focus();
        return;
      }
      if (--frames > 0) {
        afterRender(run);
        return;
      }
      list.querySelector<HTMLButtonElement>('.row[tabindex="0"]')?.focus();
    };
    afterRender(run);
  };
  // 위키 폴더가 없으면(점검으로 확인) 할 일 화면 대신 VOC 화면(공개판은 메일)으로 연다 — 사람이 아직 화면을 고르지 않았을 때만
  const noWiki = wikiMissing(setup.status);
  // (개인 위키가 없어도 팀 위키 할 일로 목록이 있으면 — 2.9단계 §3 — 할 일 화면에 둔다)
  const tasksFailed = state.status === 'error';
  useEffect(() => {
    if (noWiki && tasksFailed && !pageChosen.current) setPage((p) => (p === 'tasks' ? NO_WIKI_PAGE : p));
  }, [noWiki, tasksFailed]);
  // 위키가 생기거나(OneDrive 동기화) 스냅샷이 실패로 바뀌면 점검을 다시 읽는다
  const { reload: reloadSetup } = setup;
  useEffect(() => {
    reloadSetup();
  }, [state.status, reloadSetup]);
  const missingClaude = claudeProblem(setup.status);
  // 회신 초안을 만들 수 없는 이유 — 엔진(설정 › AI)이 local 이면 로컬 LLM 준비, 아니면 Claude Code(2.13단계 §E)
  const draftEngine = useDraftEngine();
  const draftMissing = draftUnavailableOf(draftEngine, missingClaude);
  const me = useMe(voc.board?.me?.name);
  const unavailable = navAvailability({
    status: setup.status,
    hasSnapshot: !!snapshot,
    personalMissing: snapshot?.personalMissing === true,
    board: voc.board,
  });
  // 팀 동기화가 켜져 있을 때만 탭을 그린다(꺼져 있으면 지금 화면 그대로 — §4-1)
  const teamOn = teamTasks.supported && (teamSync.status?.enabled === true || (teamTasks.board !== null && teamTasks.board.state !== 'off'));
  const tab: TasksTab = teamOn ? tasksTab : 'mine';
  const tabs = teamOn ? <TasksTabs tab={tab} onTab={setTasksTab} /> : undefined;
  const myTeamNames = teamTasks.board?.me.names ?? me.info?.effective ?? [];
  const owners = useMemo(() => knownOwners(teamTasks.board), [teamTasks.board]);
  const teamFormFor = (task: Task): Omit<TeamTaskFormProps, 'task'> => ({
    draft: teamForms.draftOf(task),
    onChange: (draft) => teamForms.setDraft(task.id, draft),
    onCancel: () => teamForms.resetDraft(task.id),
    onSubmit: () => void teamForms.save(task),
    saving: teamForms.savingId === task.id,
    busy: (teamForms.savingId !== null && teamForms.savingId !== task.id) || forms.savingId !== null,
    myName: myTeamNames[0],
    knownOwners: owners,
  });

  const openSettingsTab = (tab: SettingsTab): void => {
    pageChosen.current = true;
    setPage('setup');
    setSettingsTab(tab);
    setSetupFocus((n) => n + 1);
  };

  const choosePage = (next: FullPage): void => {
    pageChosen.current = true;
    setPage(next);
    if (next === 'tasks') focusList();
  };

  return (
    <div className="full-frame">
    <TitleBar
      page={page}
      tasksTab={teamOn ? tab : null}
      inbox={inbox}
      today={today}
      inboxRequest={inboxRequest}
      onNotifySettings={() => {
        pageChosen.current = true;
        setPage('setup');
        setSettingsTab('notify');
        setSetupFocus((n) => n + 1);
      }}
    />
    <div className="full" data-testid="full" data-page={page}>
      <FullNav
        snapshot={snapshot}
        today={today}
        page={page}
        queueCount={queue.items.length}
        voc={navVocInfo(voc.board)}
        mail={mailbox.supported ? navMailInfo(mailbox.summary) : undefined}
        wiki={wiki.supported ? navWikiInfo(wiki.summary) : undefined}
        setup={setup.supported ? { problems: setupProblemCount(setup.status, voc.board), wikiMissing: noWiki } : undefined}
        unavailable={unavailable}
        onPage={choosePage}
        onSidebar={toSidebar}
      />
      {page === 'setup' ? (
        <SettingsView
          tab={settingsTab}
          onTab={setSettingsTab}
          setup={setup}
          me={me}
          // 팀 위키 할 일의 담당 목록으로 나 칸 미리보기를 센다(읽기 전·꺼짐이면 null)
          teamOwners={teamOwnerLists(teamTasks.board)}
          board={voc.board}
          onVocLogin={() => {
            setPage('voc');
            setVocLoginRequest(++vocLoginSeq.current);
          }}
          onVocRefresh={() => void voc.refresh()}
          onDone={() => setPage(noWiki ? NO_WIKI_PAGE : 'tasks')}
          notify={notify}
          today={today}
          focusRequest={setupFocus}
        />
      ) : page === 'queue' ? (
        <QueueView
          queue={queue}
          reflect={reflect}
          today={today}
          onOpenFile={openFile}
          notify={notify}
          unavailable={noWiki ? QUEUE_NO_WIKI : missingClaude}
          focusRequest={queueFocus}
          onOpenMail={(key) => {
            setPage('mail');
            openMailTarget(key);
          }}
        />
      ) : page === 'search' ? (
        <SearchView
          summary={wiki.summary}
          selection={wikiSearch}
          onSelectionChange={setWikiSearch}
          focusRequest={searchFocus}
          onOpenFile={openFile}
          onOpenTeamDoc={openTeamDoc}
          notify={notify}
        />
      ) : page === 'changes' ? (
        <ChangesView
          summary={wiki.summary}
          selection={wikiChanges}
          onSelectionChange={setWikiChanges}
          today={today}
          onOpenSetup={() => choosePage('setup')}
          onOpenFile={openFile}
          onOpenTeamDoc={openTeamDoc}
          notify={notify}
        />
      ) : page === 'mail' ? (
        <MailboxView
          supported={mailbox.supported}
          summary={mailbox.summary}
          today={today}
          selection={mailSelection}
          onSelectionChange={setMailSelection}
          target={mailTarget}
          onTargetDone={doneMailTarget}
          reply={reply}
          claudeMissing={draftMissing}
          vocBoard={voc.board}
          personalMissing={snapshot?.personalMissing === true || noWiki}
          onOpenFile={openFile}
          onOpenTask={(taskId) => {
            setPage('tasks');
            setTasksTab('mine');
            setSelection((prev) => ({ id: taskId, index: 0, reveal: prev.reveal + 1 }));
          }}
          onOpenTasks={() => choosePage('tasks')}
          onOpenVoc={(number) => {
            setPage('voc');
            setVocFocus((n) => n + 1);
            setVocTarget({ ref: number, seq: ++vocTargetSeq.current });
          }}
          onOpenSetup={() => choosePage('setup')}
          onOpenMailSettings={() => openSettingsTab('mailOut')}
          queueItems={queue.items}
          onOpenQueue={() => {
            setPage('queue');
            setQueueFocus((n) => n + 1);
          }}
          notify={notify}
        />
      ) : page === 'voc' ? (
        <VocView
          voc={voc}
          actions={vocActions}
          today={today}
          selection={vocSelection}
          onSelectionChange={setVocSelection}
          onOpenFile={openFile}
          onOpenWeb={openVocWeb}
          notify={notify}
          focusRequest={vocFocus}
          target={vocTarget}
          onTargetDone={doneVocTarget}
          loginRequest={vocLoginRequest}
          onLoginRequestDone={doneVocLogin}
          onOpenSettings={() => openSettingsTab('voc')}
        />
      ) : tab === 'team' ? (
        <TeamTasksView
          board={teamTasks.board}
          today={today}
          tabs={tabs}
          selection={teamSelection}
          onSelectionChange={setTeamSelection}
          teamForm={teamForms.supported ? teamFormFor : undefined}
          onOpenTeamDoc={openTeamDoc}
          onOpenFile={openFile}
          notice={forms.notice ? <SaveNotice notice={forms.notice} onClose={forms.closeNotice} /> : null}
        />
      ) : (
        <>
          {state.status === 'loading' && (
            <div className="fv-state">
              <LoadingState />
            </div>
          )}
          {state.status === 'error' &&
            (noWiki ? (
              <div className="fv-state fv-state--stack" data-testid="wiki-missing">
                <EmptyState title="위키 폴더가 없어 할 일을 볼 수 없습니다.">
                  개인 위키(Obsidian 볼트)가 있으면 설정 › 점검에서 폴더를 고르세요. 없으면 {FEATURES.voc ? 'VOC 보드만' : '메일만'} 씁니다.
                </EmptyState>
                <div className="fv-state-actions">
                  <button type="button" className="btn btn--secondary" onClick={() => choosePage('setup')}>
                    <IconFolder size={16} />
                    설정
                  </button>
                  {FEATURES.voc && (
                    <button type="button" className="btn btn--secondary" onClick={() => choosePage('voc')}>
                      <IconVoc size={16} />
                      VOC 보기
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <div className="fv-state">
                <ErrorState message={state.message} onRetry={reload} />
              </div>
            ))}
          {snapshot && (
            <Workspace
              snapshot={snapshot}
              selection={selection}
              onSelectionChange={setSelection}
              onOpenFile={openFile}
              listRef={listRef}
              forms={forms}
              reply={reply}
              otherOpen={otherOpen}
              setOtherOpen={setOtherOpen}
              claudeMissing={draftMissing}
              mixed={teamOn}
              tabs={tabs}
              teamForms={teamForms}
              myNames={myTeamNames}
              knownOwners={owners}
              onOpenTeamDoc={openTeamDoc}
              onOpenMailSettings={() => openSettingsTab('mailOut')}
            />
          )}
        </>
      )}
      <NoticeBar notice={notice} />
    </div>
    </div>
  );
}

/**
 * 창 맨 위 끌기 막대(Windows 기본 제목 표시줄 대신 — 최소화·최대화·닫기는 오른쪽에 Windows 가 그린다).
 * 꾸밈 부분만 aria-hidden 이고, 알림함 종 단추(2.9단계 §8-1)는 그 밖 — 창 단추 바로 왼쪽에 둔다(끌기 영역 아님)
 */
function TitleBar({
  page,
  tasksTab,
  inbox,
  today,
  inboxRequest,
  onNotifySettings,
}: {
  page: FullPage;
  tasksTab: TasksTab | null;
  inbox: InboxHook;
  today: string;
  inboxRequest: number;
  onNotifySettings: () => void;
}): ReactElement {
  const tasksTitle = tasksTab === 'team' ? '팀 할 일' : tasksTab === 'mine' ? '내 할 일' : '할 일';
  const title =
    page === 'mail'
      ? '메일'
      : page === 'voc'
        ? 'VOC'
        : page === 'search'
          ? '검색'
          : page === 'changes'
            ? '변경'
            : page === 'queue'
              ? '반영 대기'
              : page === 'setup'
                ? '설정'
                : tasksTitle;
  return (
    <header className="titlebar">
      <div className="titlebar-deco" aria-hidden="true">
        <span className="titlebar-mark" />
        <span className="titlebar-app">Radar</span>
        <span className="titlebar-version" data-testid="app-version">v{__APP_VERSION__}</span>
        <span className="titlebar-sep">/</span>
        <span className="titlebar-page">{title}</span>
      </div>
      <InboxBell inbox={inbox} today={today} openRequest={inboxRequest} onShowSettings={onNotifySettings} />
    </header>
  );
}
