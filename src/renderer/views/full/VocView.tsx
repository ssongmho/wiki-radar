// 풀스크린 "VOC" 화면(2.6단계 명세 §3·§4·§7): 머리(합계·받은 시각·[새로고침]·[설정]) · 상태 안내 띠 ·
// 왼쪽 칸 목록(미배정·나·팀원) | 가운데 티켓 목록 | 오른쪽 상세(답변 보기·담당·예상일·우선순위 바꾸기·VOC 에서 열기).
// VOC 운영 데이터는 확인 대화상자의 [실행]을 누를 때만 바뀐다. 화면을 열거나 새로 받는 것은 읽기만 한다.
// 위/아래(목록 안에서는 Home/End 도) 키로 티켓을 옮기고, 칸은 Tab 순서로 옮긴다. 대화상자가 열려 있으면 키로 목록을 옮기지 않는다.
import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type ReactElement, type SetStateAction } from 'react';
import type { VocActionKind, VocTicket } from '../../../shared/types';
import { IconAlert, IconRefresh, IconSettings, IconVoc } from '../../components/Icons';
import { EmptyState, LoadingState } from '../../components/StateMessage';
import { useClock, useVocReplies, type VocActionsHook, type VocBoardHook } from '../../hooks/useVocBoard';
import { useVocWork } from '../../hooks/useVocWork';
import type { VocWorkNotice } from '../../lib/vocWork';
import { cls } from '../../lib/cls';
import { focusLost, refocusIfLost } from '../../lib/focus';
import {
  boardHeadParts,
  boardMembers,
  boardTeamUnknown,
  defaultLaneKey,
  fetchedText,
  findTicket,
  makeActionId,
  objectParticle,
  shouldRefreshOnOpen,
  targetMissingText,
  vocBanner,
  vocSetupBanner,
  writeBlockReason,
  type VocPendingAction,
  type VocSelection,
} from '../../lib/voc';
import { VocBanner } from './voc/VocBanner';
import { VocConfirmDialog } from './voc/VocConfirmDialog';
import { VocLanes } from './voc/VocLanes';
import { VocLoginDialog } from './voc/VocLoginDialog';
import { VocNotice } from './voc/VocNotice';
import { VocTicketDetail } from './voc/VocTicketDetail';
import { VocTicketList } from './voc/VocTicketList';
import { VocWorkNoticeView, VocWorkPanel } from './voc/VocWorkPanel';
import { VocConfirmDialog as VocWorkConfirmDialog } from './VocTaskPanel';

const LIST_KEYS = new Set(['ArrowDown', 'ArrowUp', 'Home', 'End']);

function isEditable(el: HTMLElement | null): boolean {
  return !!el && (el.isContentEditable || el.closest('input, textarea, select') !== null);
}

/** 모달 대화상자가 열려 있거나 키가 대화상자 안에서 왔다(2.5단계 명세 §9-7 — FullView 와 같은 규칙) */
function inDialog(el: HTMLElement | null): boolean {
  if (el?.closest('dialog')) return true;
  return typeof document !== 'undefined' && document.querySelector('dialog[open]') !== null;
}

/** 동작이 끝난 뒤 초점을 돌려놓을 입력(누른 버튼은 값이 되돌려져 비활성일 수 있다) */
const CONTROL_OF: Partial<Record<VocActionKind, string>> = {
  assign: '[data-testid="voc-assign-select"]',
  ictDue: '[data-testid="voc-ictdue-input"]',
  priority: '[data-testid="voc-priority-select"]',
};

/** 바깥(사이드바·배지)에서 고르라고 한 티켓 */
export interface VocTarget {
  ref: string;
  seq: number;
}

export interface VocViewProps {
  voc: VocBoardHook;
  actions: VocActionsHook;
  today: string;
  selection: VocSelection;
  onSelectionChange: Dispatch<SetStateAction<VocSelection>>;
  onOpenFile: (path: string) => void;
  onOpenWeb: (ticketId: number) => void;
  notify: (message: string) => void;
  /** 바깥에서 이 화면을 열 때마다 늘어난다 — 초점이 사라져 있으면 화면 제목으로 옮긴다 */
  focusRequest?: number;
  /** 고를 티켓(없으면 null). 처리하면 onTargetDone */
  target?: VocTarget | null;
  onTargetDone?: (seq: number) => void;
  /** 바깥(사이드바 'VOC 로그인 필요'·할 일 상세의 [로그인])에서 로그인 대화상자를 띄우라는 요청 번호(없으면 null). 띄우면 onLoginRequestDone */
  loginRequest?: number | null;
  onLoginRequestDone?: (seq: number) => void;
  /** [설정] — 설정 › VOC 칸을 연다(2.13단계 §C-5 — 대화상자 대신) */
  onOpenSettings?: () => void;
}

export function VocView(props: VocViewProps): ReactElement {
  const {
    voc,
    actions,
    today,
    selection,
    onSelectionChange,
    onOpenFile,
    onOpenWeb,
    notify,
    focusRequest = 0,
    target,
    onTargetDone,
    loginRequest,
    onLoginRequestDone,
    onOpenSettings,
  } = props;
  const { board } = voc;
  const now = useClock(30_000);
  const replies = useVocReplies();
  const work = useVocWork();
  const [pending, setPending] = useState<VocPendingAction | null>(null);
  /** 해결·완료 알림의 [재오픈] → 확인 대화상자(그 티켓은 보드에서 빠졌다) */
  const [reopen, setReopen] = useState<(NonNullable<VocWorkNotice['reopen']> & { actionId: string }) | null>(null);
  const [loginOpen, setLoginOpen] = useState(false);
  const openSettings = useCallback(() => onOpenSettings?.(), [onOpenSettings]);

  // 로그인 대화상자는 다른 대화상자 위에 겹쳐 열지 않는다
  const openLogin = useCallback(() => {
    setPending(null);
    setLoginOpen(true);
  }, []);

  // 바깥에서 온 로그인 요청(명세 §13 — 사이드바 'VOC 로그인 필요'를 누르면 VOC 화면과 로그인 창이 바로 열린다)
  useEffect(() => {
    if (loginRequest === null || loginRequest === undefined) return;
    openLogin();
    onLoginRequestDone?.(loginRequest);
  }, [loginRequest, openLogin, onLoginRequestDone]);

  const lanes = useMemo(() => board?.lanes ?? [], [board]);
  const fallbackLane = defaultLaneKey(lanes);
  const lane = lanes.find((l) => l.key === selection.lane) ?? lanes.find((l) => l.key === fallbackLane) ?? null;
  const laneKey = lane?.key ?? null;
  const tickets = useMemo(() => lane?.tickets ?? [], [lane]);

  // 고른 티켓이 빠지면(담당 지정으로 다른 칸으로 옮겨 감 등) 그 티켓이 마지막으로 보였던 자리를 쓴다.
  const foundIndex = selection.ticketId !== null ? tickets.findIndex((t) => t.id === selection.ticketId) : -1;
  const lastSeen = useRef<{ lane: string | null; id: number | null; index: number }>({ lane: null, id: null, index: 0 });
  if (foundIndex >= 0) lastSeen.current = { lane: laneKey, id: selection.ticketId, index: foundIndex };
  const fallbackIndex =
    lastSeen.current.id === selection.ticketId && lastSeen.current.lane === laneKey ? lastSeen.current.index : selection.index;
  const selectedIndex =
    tickets.length === 0 ? -1 : foundIndex >= 0 ? foundIndex : Math.min(Math.max(fallbackIndex, 0), tickets.length - 1);
  const selected: VocTicket | null = selectedIndex >= 0 ? tickets[selectedIndex] : null;
  const selectedId = selected?.id ?? null;

  const listRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const refreshRef = useRef<HTMLButtonElement>(null);
  const settingsRef = useRef<HTMLButtonElement>(null);
  const rowRefs = useRef(new Map<number, HTMLButtonElement>());
  const registerRow = useCallback((id: number, el: HTMLButtonElement | null) => {
    if (el) rowRefs.current.set(id, el);
    else rowRefs.current.delete(id);
  }, []);

  const select = useCallback(
    (ticket: VocTicket) => {
      onSelectionChange((prev) => ({
        lane: laneKey,
        ticketId: ticket.id,
        index: Math.max(0, tickets.indexOf(ticket)),
        reveal: prev.reveal,
      }));
    },
    [onSelectionChange, laneKey, tickets],
  );

  const chooseLane = (key: string): void => {
    onSelectionChange((prev) => ({ lane: key, ticketId: null, index: 0, reveal: prev.reveal + 1 }));
  };

  // 화면을 열 때 마지막으로 받은 지 2분 넘게 지났으면 새로 받는다(명세 §2-3). 처음 그릴 때와, 바깥(사이드바 'VOC 미배정'·배지)에서
  // 다시 열 때마다(focusRequest — 풀스크린 창은 숨었다 다시 보일 뿐 이 화면이 다시 그려지지 않는다), 창이 다시 보일 때.
  // 보드가 바뀔 때마다 보지는 않는다(그러면 폴링이 된다) — 그래서 보드는 ref 로 본다
  const { refresh } = voc;
  const boardRef = useRef(board);
  boardRef.current = board;
  const refreshIfOld = useCallback(() => {
    if (shouldRefreshOnOpen(boardRef.current, Date.now())) void refresh();
  }, [refresh]);

  // 바깥에서 열었을 때(창이 바뀌어 초점이 body 에 있다) 화면 제목으로. 그린 직후에 바로 본다(QueueView 와 같다)
  useEffect(() => {
    refreshIfOld();
    if (focusLost()) titleRef.current?.focus();
  }, [focusRequest, refreshIfOld]);

  useEffect(() => {
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') refreshIfOld();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refreshIfOld]);

  // 바깥에서 고른 티켓(배지·사이드바). 보드가 오면 찾아서 고르고, 없으면 알린다. 한 번도 받지 못한 보드에서 못 찾으면 한 번 받아 본
  // 뒤에(받는 중이면 그 끝을 기다려) 판정한다 — 받지 못한 것을 '보드에 없다'로 알리지 않는다
  const waitingFor = useRef<number | null>(null);
  const [waitedFor, setWaitedFor] = useState<number | null>(null);
  useEffect(() => {
    if (!target || !board || board.state === 'loading') return;
    const found = findTicket(board, target.ref);
    const canFetch = board.state !== 'login' && board.state !== 'notConfigured';
    if (!found && !board.fetchedAt && canFetch && waitedFor !== target.seq) {
      if (waitingFor.current !== target.seq) {
        waitingFor.current = target.seq;
        const seq = target.seq;
        void refresh().finally(() => setWaitedFor(seq));
      }
      return;
    }
    if (found) {
      const index = board.lanes.find((l) => l.key === found.lane)?.tickets.indexOf(found.ticket) ?? 0;
      onSelectionChange((prev) => ({ lane: found.lane, ticketId: found.ticket.id, index: Math.max(0, index), reveal: prev.reveal + 1 }));
    } else {
      notify(targetMissingText(board, target.ref));
    }
    onTargetDone?.(target.seq);
  }, [target, board, waitedFor, refresh, onSelectionChange, notify, onTargetDone]);

  // 고른 줄이 보이도록 스크롤한다(바깥에서 고름·칸 바꿈)
  useEffect(() => {
    if (selectedId === null) return;
    rowRefs.current.get(selectedId)?.scrollIntoView({ block: 'nearest' });
  }, [selection.reveal, selectedId, laneKey]);

  // 티켓이 바뀌면 상세를 맨 위부터
  useEffect(() => {
    detailRef.current?.scrollTo({ top: 0 });
  }, [selectedId]);

  // 위/아래(목록 안에서는 Home/End 도) 키로 티켓을 옮긴다
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || !LIST_KEYS.has(e.key)) return;
      const t = e.target instanceof HTMLElement ? e.target : null;
      if (isEditable(t) || inDialog(t)) return;
      const inList = !!t && !!listRef.current?.contains(t);
      if ((e.key === 'Home' || e.key === 'End') && !inList) return;
      if (tickets.length === 0) return;
      const current = selectedId !== null ? tickets.findIndex((x) => x.id === selectedId) : -1;
      let next: number;
      if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = tickets.length - 1;
      else if (current < 0) next = e.key === 'ArrowDown' ? 0 : tickets.length - 1;
      else next = Math.min(tickets.length - 1, Math.max(0, current + (e.key === 'ArrowDown' ? 1 : -1)));
      e.preventDefault();
      const ticket = tickets[next];
      select(ticket);
      const row = rowRefs.current.get(ticket.id);
      const free = !t || t === document.body || t === document.documentElement;
      if (inList || free) row?.focus();
      else row?.scrollIntoView({ block: 'nearest' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tickets, selectedId, select]);

  const doRefresh = async (): Promise<void> => {
    const problem = await refresh();
    if (problem) notify(`VOC 목록을 새로 받지 못했습니다. (${problem})`);
    refocusIfLost(() => refreshRef.current);
  };

  const ask = (kind: VocActionKind, value: string): void => {
    if (!selected || actions.busy.has(selected.id)) return;
    setPending({ actionId: makeActionId(), kind, ticket: selected, value });
  };

  const confirm = async (): Promise<void> => {
    const p = pending;
    setPending(null);
    if (!p) return;
    await actions.run(p);
    const control = CONTROL_OF[p.kind];
    refocusIfLost(
      () => (control ? detailRef.current?.querySelector<HTMLElement>(control) : null),
      () => document.getElementById('voc-detail-title'),
      6,
    );
  };

  const { closeNotice: closeNoticeRaw } = actions;
  const closeNotice = useCallback(() => {
    closeNoticeRaw();
    refocusIfLost(() => document.getElementById('voc-detail-title'), undefined, 1);
  }, [closeNoticeRaw]);

  const banner = board ? vocBanner(board, today) : null;
  const setup = vocSetupBanner(board);
  const teamUnknown = boardTeamUnknown(board);
  const fetched = board ? fetchedText(board.fetchedAt, now, today) : '';
  const writeBlock = writeBlockReason(board, actions.supported);
  const state = board?.state ?? (voc.supported ? 'loading' : 'unavailable');
  const { closeNotice: closeWorkNoticeRaw } = work;
  const closeWorkNotice = useCallback(() => {
    closeWorkNoticeRaw();
    refocusIfLost(() => document.getElementById('voc-detail-title'), undefined, 1);
  }, [closeWorkNoticeRaw]);
  const notice =
    actions.notice || work.notice ? (
      <>
        {actions.notice && <VocNotice notice={actions.notice} onClose={closeNotice} />}
        {work.notice && (
          <VocWorkNoticeView
            notice={work.notice}
            onClose={closeWorkNotice}
            onReopen={(r) => {
              setPending(null);
              setReopen({ ...r, actionId: makeActionId() });
            }}
          />
        )}
      </>
    ) : null;

  let body: ReactElement;
  if (!voc.supported || (!board && voc.error)) {
    body = (
      <div className="vv-state">
        <EmptyState title="VOC 보드를 불러오지 못했습니다.">{voc.error ?? '앱 연결을 확인해 주세요.'}</EmptyState>
      </div>
    );
  } else if (!board || (lanes.length === 0 && board.state === 'loading')) {
    body = (
      <div className="vv-state">
        <LoadingState text="VOC 목록을 받는 중입니다…" />
      </div>
    );
  } else if (lanes.length === 0) {
    const detail =
      board.state === 'login'
        ? 'VOC 에 로그인하면 담당자별 티켓이 보입니다.'
        : board.state === 'notConfigured'
          ? 'voc-cli 위치를 설정하면 담당자별 티켓이 보입니다.'
          : board.state === 'unavailable'
            ? 'VOC 서버에 연결되면 담당자별 티켓이 보입니다.'
            : '설정에서 나와 팀원을 고르면 담당자별 칸이 생깁니다.';
    body = (
      <div className="vv-state">
        <EmptyState title="보여 줄 칸이 없습니다.">{detail}</EmptyState>
      </div>
    );
  } else {
    const unassigned = laneKey === 'unassigned';
    body = (
      <>
        <VocLanes lanes={lanes} selectedKey={laneKey} onSelect={(l) => chooseLane(l.key)} />
        <section className="vv-list" aria-labelledby="vv-list-title">
          <div className="vv-list-head">
            <h2 id="vv-list-title" className="fv-list-title">
              {lane?.label ?? ''}
            </h2>
            <span className="vv-list-count">{tickets.length}건</span>
          </div>
          <VocTicketList
            ref={listRef}
            tickets={tickets}
            today={today}
            selectedId={selectedId}
            focusableId={selectedId ?? tickets[0]?.id ?? null}
            onSelect={select}
            registerRow={registerRow}
            emptyTitle={unassigned ? '미배정 티켓이 없습니다.' : '이 칸에 진행 중인 티켓이 없습니다.'}
            emptyDetail={
              unassigned
                ? teamUnknown
                  ? '나를 찾지 못해 팀 시스템을 정하지 못했습니다 — 설정에서 나를 고르면 팀 시스템의 미배정 티켓이 보입니다.'
                  : '미배정 칸에는 팀 시스템의 티켓만 보입니다(설정 — 미배정 전체 보기).'
                : undefined
            }
          />
        </section>
        <VocTicketDetail
          ref={detailRef}
          ticket={selected}
          laneLabel={lane?.label}
          today={today}
          board={board}
          writeBlock={writeBlock}
          busyKind={selected ? actions.busy.get(selected.id) : undefined}
          replies={selected ? replies.entryOf(selected.id) : undefined}
          onLoadReplies={() => selected && replies.load(selected.id)}
          onAsk={ask}
          onOpenFile={onOpenFile}
          onOpenWeb={() => selected && onOpenWeb(selected.id)}
          notice={notice}
          workPanel={
            selected ? (
              <VocWorkPanel
                key={`work-${selected.id}`}
                ticket={selected}
                today={today}
                board={board}
                writeBlock={writeBlock}
                otherBusy={actions.busy.has(selected.id)}
                work={work}
              />
            ) : null
          }
        />
      </>
    );
  }

  return (
    <div className="vv" data-testid="voc-view" data-state={state}>
      <header className="vv-head">
        <div className="vv-head-text">
          <h1 id="vv-title" className="vv-title" tabIndex={-1} ref={titleRef}>
            <IconVoc size={20} />
            VOC
          </h1>
          {board && (
            <p className="vv-summary">
              {/* 한 번도 받지 못했으면(로그인 필요 등)·팀을 정하지 못했으면(나를 못 찾음) 0건처럼 보이지 않게 합계 대신 사실만 */}
              {!board.fetchedAt ? (
                <span className="vv-summary-part vv-fetched">아직 목록을 받지 못했습니다</span>
              ) : teamUnknown ? (
                <span className="vv-summary-part vv-fetched">나를 찾지 못해 팀을 정하지 못했습니다</span>
              ) : (
                boardHeadParts(board).map((p) => (
                  <span key={p.key} className={cls('vv-summary-part', p.tone && `tone-${p.tone}`)}>
                    {p.text}
                  </span>
                ))
              )}
              {fetched && <span className="vv-summary-part vv-fetched">{fetched}</span>}
            </p>
          )}
        </div>
        <div className="vv-head-actions">
          <button
            type="button"
            className="btn btn--secondary"
            data-testid="btn-voc-refresh"
            ref={refreshRef}
            disabled={voc.refreshing || !voc.supported}
            onClick={() => void doRefresh()}
          >
            <IconRefresh size={16} />
            {voc.refreshing ? '받는 중…' : board?.state === 'login' ? '다시 확인' : '새로고침'}
          </button>
          <button
            type="button"
            className="btn btn--secondary"
            data-testid="btn-voc-settings"
            ref={settingsRef}
            disabled={!voc.supported || !onOpenSettings}
            onClick={openSettings}
          >
            <IconSettings size={16} />
            설정
          </button>
        </div>
      </header>
      {banner && <VocBanner info={banner} onSettings={openSettings} onLogin={openLogin} notify={notify} />}
      {setup && (
        <div className="vv-banner vv-banner--amber" data-testid="voc-setup-banner" data-team={teamUnknown ? 'unknown' : 'known'} role="alert">
          <IconAlert size={16} className="vv-banner-icon" />
          <div className="vv-banner-text">
            <p className="vv-banner-title">{setup.title}</p>
            <p className="vv-banner-detail">{setup.detail}</p>
          </div>
          <button type="button" className="btn btn--secondary vv-banner-action" onClick={openSettings}>
            <IconSettings size={16} />
            설정 열기
          </button>
        </div>
      )}
      {body}

      <VocConfirmDialog
        pending={pending}
        context={{ members: boardMembers(board), me: board?.me, today }}
        onConfirm={() => void confirm()}
        onCancel={() => setPending(null)}
      />
      <VocWorkConfirmDialog
        open={reopen !== null}
        kind="reopen"
        title="VOC 를 재오픈할까요?"
        confirmText="재오픈"
        confirmDisabled={!!writeBlock || (reopen !== null && work.busy.has(reopen.ticketId))}
        onConfirm={() => {
          const r = reopen;
          setReopen(null);
          if (!r) return;
          void work.run({ actionId: r.actionId, kind: 'reopen', ticketId: r.ticketId, expectedStatus: r.status }, { id: r.ticketId, number: r.number });
        }}
        onCancel={() => setReopen(null)}
      >
        {reopen && (
          <p>
            <strong>{reopen.number}</strong>
            {objectParticle(reopen.number)} 다시 진행 상태(배정됨)로 되돌립니다. VOC 에서 지금 {reopen.status === 'resolved' ? '해결' : '완료'} 상태인지 다시 확인한
            뒤 바꿉니다.
          </p>
        )}
      </VocWorkConfirmDialog>
      <VocLoginDialog
        open={loginOpen}
        defaultId={board?.loginId}
        onClose={() => {
          setLoginOpen(false);
          // 누른 [로그인]은 띠에 그대로 있다 — 거기로(바깥에서 열었으면 화면 제목으로)
          refocusIfLost(
            () => document.querySelector<HTMLElement>('[data-testid="btn-voc-login-open"]'),
            () => titleRef.current,
          );
        }}
        onLoggedIn={(message) => {
          setLoginOpen(false);
          notify(message);
          // main 이 이미 새로 받기 시작했다 — 그 약속에 합류해 [새로고침]이 '받는 중'으로 보인다
          void refresh();
          // 띠의 [로그인]은 사라진다 — 화면 제목으로
          refocusIfLost(() => titleRef.current);
        }}
      />
    </div>
  );
}
