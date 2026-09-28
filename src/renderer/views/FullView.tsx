// 풀스크린 모드: 216px 내비 | 384px 목록 | 상세 | 344px 연결된 정보. 내비의 "반영 대기"를 고르면 내비 오른쪽 전체가 그 화면이 된다.
// 선택은 onFocusTask(사이드바에서 누른 항목)로 바뀌고, 기본은 첫 항목. 위/아래 키로 옮긴다.
// 처리 결과 입력값은 taskId 별 초안으로 여기서 들고 있다 — 스냅샷이 바뀌거나 화면을 오가도 입력을 잃지 않는다(메모리에만).
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactElement,
  type RefObject,
  type SetStateAction,
} from 'react';
import type { Snapshot, Task, TaskStatus } from '../../shared/types';
import { FOCUS_QUEUE_VIEW, NO_BRIDGE_MESSAGE, getRadar } from '../api';
import { IconAlert, IconChecklist, IconChevronDown, IconSidebar, IconUpload } from '../components/Icons';
import { ErrorState, LoadingState, NoticeBar, PartialNote } from '../components/StateMessage';
import { BreakNote, WeekTrack } from '../components/WeekTrack';
import { useNotice } from '../hooks/useNotice';
import { useQueue, useReflect } from '../hooks/useQueue';
import type { SnapshotHook } from '../hooks/useSnapshot';
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
import { errorText } from '../lib/snapshot';
import { BUCKETS, bucketOf, groupByBucket } from '../lib/tasks';
import { InfoAside } from './full/InfoAside';
import { QueueView } from './full/QueueView';
import { SaveNotice } from './full/SaveNotice';
import { TaskDetail } from './full/TaskDetail';
import { TaskList } from './full/TaskList';

/** 선택 상태. id 가 목록에서 사라지면(완료 등) 같은 자리(index)의 항목을 고른다. */
interface Selection {
  id: string | null;
  index: number;
  /** 바깥(onFocusTask)에서 고를 때마다 늘려, 같은 항목이어도 목록을 그 줄로 스크롤한다 */
  reveal: number;
}

/** 내비로 고르는 화면 */
type FullPage = 'tasks' | 'queue';

const LIST_KEYS = new Set(['ArrowDown', 'ArrowUp', 'Home', 'End']);

function isEditable(el: HTMLElement | null): boolean {
  return !!el && (el.isContentEditable || el.closest('input, textarea, select') !== null);
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
  onPage: (page: FullPage) => void;
  onSidebar: () => void;
}

function FullNav({ snapshot, today, page, queueCount, onPage, onSidebar }: FullNavProps): ReactElement {
  const updated = snapshot ? formatClock(snapshot.generatedAt) : '';
  return (
    <nav className="fv-nav" aria-label="보기">
      <div className="brand brand--nav">
        <span className="brand-name">wiki-radar</span>
        <span className="brand-date">{formatLongDate(today)}</span>
      </div>
      <ul className="nav-list">
        <li>
          <button
            type="button"
            className="nav-item"
            data-testid="nav-tasks"
            aria-current={page === 'tasks' ? 'page' : undefined}
            onClick={() => onPage('tasks')}
          >
            <IconChecklist size={18} />
            <span className="nav-item-label">할 일</span>
            {snapshot && <span className="nav-item-count">{snapshot.tasks.length}</span>}
          </button>
        </li>
        <li>
          <button
            type="button"
            className="nav-item"
            data-testid="nav-queue"
            data-count={queueCount}
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
  notice: SaveNoticeData | null;
  closeNotice: () => void;
}

function useResultForms(): ResultForms {
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

  return { draftOf, setDraft, resetDraft, savingId, save, notice, closeNotice };
}

interface WorkspaceProps {
  snapshot: Snapshot;
  selection: Selection;
  onSelectionChange: Dispatch<SetStateAction<Selection>>;
  onOpenFile: (path: string) => void;
  listRef: RefObject<HTMLDivElement | null>;
  forms: ResultForms;
  /** '기타' 구간을 폈는가. FullView 가 들고 있다 — 반영 대기 화면에 다녀와도(Workspace 가 새로 그려져도) 그대로 */
  otherOpen: boolean;
  setOtherOpen: Dispatch<SetStateAction<boolean>>;
}

function Workspace({
  snapshot,
  selection,
  onSelectionChange,
  onOpenFile,
  listRef,
  forms,
  otherOpen,
  setOtherOpen,
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
      if (isEditable(target)) return;
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

  const { save } = forms;
  const submit = useCallback(
    async (task: Task): Promise<void> => {
      // 빠질 때 옮겨 갈 항목은 저장 전 목록으로 정한다(저장 뒤 스냅샷에는 이미 빠져 있을 수 있다).
      const pool = visible.some((t) => t.id === task.id) ? visible : ordered;
      const nextId = nextAfterRemoval(
        pool.map((t) => t.id),
        task.id,
      );
      const index = Math.max(0, ordered.findIndex((t) => t.id === task.id));
      const started = selectionRef.current;
      const saved = await save(task);
      if (selectionRef.current !== started) return;
      if (!saved) {
        // 실패(또는 일부만 저장): 저장 중 비활성이던 [저장]에서 떨어진 초점을 [저장]으로(다시 누를 수 있게), 안 되면 고른 상태 라디오로
        refocusIfLost(
          () => detailRef.current?.querySelector<HTMLButtonElement>('[data-testid="btn-save"]'),
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
    [visible, ordered, save, onSelectionChange],
  );

  // 알림을 닫으면 닫기 버튼이 사라져 초점이 떨어진다 — [저장](누를 수 있으면) 또는 상세 제목으로 돌려놓는다.
  // (잠시 뒤 저절로 닫힐 때는 초점이 다른 곳에 있으므로 건드리지 않는다.) SaveNotice 의 타이머가 매번 새로 걸리지 않게 고정 함수로.
  const { closeNotice: closeNoticeRaw } = forms;
  const closeNotice = useCallback(() => {
    closeNoticeRaw();
    refocusIfLost(
      () => detailRef.current?.querySelector<HTMLButtonElement>('[data-testid="btn-save"]'),
      () => detailRef.current?.querySelector<HTMLElement>('#detail-title'),
      1,
    );
  }, [closeNoticeRaw]);
  const notice = forms.notice ? <SaveNotice notice={forms.notice} onClose={closeNotice} /> : null;

  return (
    <>
      <section className="fv-list" aria-label="이번 주 할 일">
        <div className="fv-list-head">
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
        />
      </section>
      <TaskDetail
        ref={detailRef}
        task={selected}
        today={week.today}
        onOpenFile={onOpenFile}
        notice={notice}
        form={
          selected
            ? {
                draft: forms.draftOf(selected),
                onChange: (draft) => forms.setDraft(selected.id, draft),
                onCancel: () => forms.resetDraft(selected.id),
                onSubmit: () => void submit(selected),
                saving: forms.savingId === selected.id,
                busy: forms.savingId !== null && forms.savingId !== selected.id,
              }
            : undefined
        }
      />
      <InfoAside ref={asideRef} task={selected} version={snapshot.generatedAt} today={week.today} onOpenFile={onOpenFile} />
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
  const forms = useResultForms();
  const queue = useQueue();
  const reflect = useReflect();

  // 사이드바에서 누른 항목(main 이 IPC.focusTask 로 보낸다). 스냅샷보다 먼저 와도 기억해 둔다.
  // 사이드바 상태 줄의 "반영 N"은 항목 대신 FOCUS_QUEUE_VIEW 를 보낸다.
  useEffect(() => {
    const api = getRadar();
    if (!api) return;
    let off: (() => void) | undefined;
    try {
      off = api.onFocusTask((taskId) => {
        if (typeof taskId !== 'string' || taskId === '') return;
        if (taskId === FOCUS_QUEUE_VIEW) {
          setPage('queue');
          setQueueFocus((n) => n + 1);
          return;
        }
        setPage('tasks');
        setSelection((prev) => ({ id: taskId, index: 0, reveal: prev.reveal + 1 }));
      });
    } catch {
      // 구독하지 못하면 기본 선택(첫 항목)만 쓴다.
    }
    return () => {
      if (typeof off === 'function') off();
    };
  }, []);

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
  const choosePage = (next: FullPage): void => {
    setPage(next);
    if (next === 'tasks') focusList();
  };

  return (
    <div className="full" data-testid="full" data-page={page}>
      <FullNav
        snapshot={snapshot}
        today={today}
        page={page}
        queueCount={queue.items.length}
        onPage={choosePage}
        onSidebar={toSidebar}
      />
      {page === 'queue' ? (
        <QueueView
          queue={queue}
          reflect={reflect}
          today={today}
          onOpenFile={openFile}
          notify={notify}
          focusRequest={queueFocus}
        />
      ) : (
        <>
          {state.status === 'loading' && (
            <div className="fv-state">
              <LoadingState />
            </div>
          )}
          {state.status === 'error' && (
            <div className="fv-state">
              <ErrorState message={state.message} onRetry={reload} />
            </div>
          )}
          {snapshot && (
            <Workspace
              snapshot={snapshot}
              selection={selection}
              onSelectionChange={setSelection}
              onOpenFile={openFile}
              listRef={listRef}
              forms={forms}
              otherOpen={otherOpen}
              setOtherOpen={setOtherOpen}
            />
          )}
        </>
      )}
      <NoticeBar notice={notice} />
    </div>
  );
}
