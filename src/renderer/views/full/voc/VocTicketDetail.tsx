// VOC 화면 오른쪽 상세(2.6단계 명세 §3-1·§4): 번호·제목·상태·우선순위·고객사·시스템(위키 문서가 있으면 Obsidian)·요청자·요청유형·
// 접수(KST)·경과·기한·SLA·답변, 요청 내용(글자, 12줄 넘으면 접기), 최근 답변([답변 보기]), 담당·예상일·우선순위 바꾸기(확인 대화상자 뒤),
// [VOC 에서 열기]. 요청 내용·답변은 데이터다 — 글자로만 보이고 HTML·링크로 해석하지 않는다.
import { useEffect, useRef, useState, type ReactElement, type ReactNode, type Ref } from 'react';
import type { VocActionKind, VocBoard, VocReply, VocTicket } from '../../../../shared/types';
import {
  IconAssign,
  IconBuilding,
  IconCalendar,
  IconChevronDown,
  IconExternal,
  IconFlag,
  IconMemo,
  IconRefresh,
  IconReply,
  IconTicket,
  IconWeb,
} from '../../../components/Icons';
import { EmptyState } from '../../../components/StateMessage';
import type { VocRepliesEntry } from '../../../hooks/useVocBoard';
import { cls } from '../../../lib/cls';
import {
  VOC_PRIORITIES,
  ageText,
  assignOptions,
  dateText,
  foldText,
  kstDateTimeText,
  priorityMark,
  replyAuthorType,
  requestTypeLabel,
  slaMark,
  slaTargetText,
  vocStatusLabel,
} from '../../../lib/voc';

export interface VocTicketDetailProps {
  ticket: VocTicket | null;
  /** 고른 칸 이름(경로 표시) */
  laneLabel?: string;
  today: string;
  board: VocBoard | null;
  /** 쓰기를 막는 이유(로그인 필요 등). 없으면 null */
  writeBlock: string | null;
  /** 이 티켓에서 실행 중인 동작 */
  busyKind?: VocActionKind;
  replies?: VocRepliesEntry;
  onLoadReplies: () => void;
  /** 동작 버튼 → 확인 대화상자 */
  onAsk: (kind: VocActionKind, value: string) => void;
  onOpenFile: (path: string) => void;
  onOpenWeb: () => void;
  /** 쓰기 결과 알림(열 아래쪽) */
  notice?: ReactNode;
  /** V4(명세 §14) 첨부·작업시간·해결·고객 메일 — 담당·일정 바꾸기 아래 */
  workPanel?: ReactNode;
  /** 스크롤되는 상세 본문 */
  ref?: Ref<HTMLDivElement>;
}

/** 고객사·시스템: 위키 문서가 있으면 Obsidian 으로 여는 링크 */
function PageValue({ text, page, onOpenFile }: { text: string; page?: string; onOpenFile: (p: string) => void }): ReactElement {
  if (!page) return <>{text}</>;
  return (
    <button type="button" className="link-btn vv-page-link" title={`${page} — Obsidian에서 열기`} onClick={() => onOpenFile(page)}>
      <span>{text}</span>
      <IconExternal size={14} />
    </button>
  );
}

function Facts({ ticket, today, onOpenFile }: { ticket: VocTicket; today: string; onOpenFile: (p: string) => void }): ReactElement {
  const sla = slaMark(ticket.slaStatus);
  const target = slaTargetText(ticket.slaResolutionTarget);
  const created = kstDateTimeText(ticket.createdAt, today);
  const lastReply = kstDateTimeText(ticket.lastReplyAt, today);
  const system = ticket.systemName ?? ticket.system;
  const systemText = ticket.systemName && ticket.system ? `${ticket.systemName} (${ticket.system})` : system;
  const ictOverdue = !!ticket.ictDue && ticket.ictDue < today;
  const customerOverdue = !!ticket.customerDue && ticket.customerDue < today;
  return (
    <dl className="vv-facts">
      <dt>고객사</dt>
      <dd>{ticket.customer ? <PageValue text={ticket.customer} page={ticket.customerPage} onOpenFile={onOpenFile} /> : '—'}</dd>
      <dt>시스템</dt>
      <dd>{systemText ? <PageValue text={systemText} page={ticket.systemPage} onOpenFile={onOpenFile} /> : '—'}</dd>
      <dt>담당</dt>
      <dd>{ticket.assigneeName ?? <span className="tone-amber">미배정</span>}</dd>
      <dt>요청자</dt>
      <dd>{ticket.requesterName ?? '—'}</dd>
      <dt>요청유형</dt>
      <dd>{requestTypeLabel(ticket.requestType) ?? '—'}</dd>
      <dt>접수</dt>
      <dd>{created || '—'}</dd>
      <dt>경과</dt>
      <dd>
        {ageText(ticket.ageDays)}
        {ticket.ageDays > 0 && <span className="vv-fact-note"> · 영업일 {ticket.ageBusinessDays}일</span>}
      </dd>
      <dt>고객 희망일</dt>
      <dd className={cls(customerOverdue && !ticket.ictDue && 'tone-coral')}>
        {ticket.customerDue ? `${dateText(ticket.customerDue, today)}${customerOverdue ? ' — 지남' : ''}` : '—'}
      </dd>
      <dt>ICT 예상일</dt>
      <dd className={cls(ictOverdue && 'tone-coral')}>
        {ticket.ictDue ? `${dateText(ticket.ictDue, today)}${ictOverdue ? ' — 지남' : ''}` : '—'}
      </dd>
      <dt>SLA</dt>
      <dd className={cls(sla?.tone && `tone-${sla.tone}`)}>
        {sla ? sla.text : 'SLA 미적용'}
        {target && <span className="vv-fact-note"> · {target}</span>}
      </dd>
      <dt>답변</dt>
      <dd>
        {ticket.replyCount !== undefined ? `${ticket.replyCount}건` : '—'}
        {lastReply && <span className="vv-fact-note"> · 마지막 {lastReply}</span>}
      </dd>
    </dl>
  );
}

function RequestText({ text }: { text: string }): ReactElement {
  const [open, setOpen] = useState(false);
  const trimmed = text.trim();
  if (!trimmed) return <p className="empty-note">요청 내용이 없습니다.</p>;
  const fold = foldText(trimmed);
  return (
    <>
      <p className="vv-request-text" id="voc-request-text">
        {open || !fold.folded ? trimmed : `${fold.text}…`}
      </p>
      {fold.folded && (
        <button type="button" className="link-btn" aria-expanded={open} aria-controls="voc-request-text" onClick={() => setOpen((v) => !v)}>
          <IconChevronDown size={14} className={cls('vv-fold-chevron', open && 'is-open')} />
          {open ? '접기' : fold.hiddenLines > 0 ? `전체 보기(${fold.hiddenLines}줄 더)` : '전체 보기'}
        </button>
      )}
    </>
  );
}

function ReplyItem({ reply, today }: { reply: VocReply; today: string }): ReactElement {
  const type = replyAuthorType(reply.authorType);
  const at = kstDateTimeText(reply.createdAt, today);
  return (
    <li className="vv-reply">
      <p className="vv-reply-head">
        <span className="vv-reply-author">{reply.authorName ?? '작성자 없음'}</span>
        {type && <span className="vv-reply-type">{type}</span>}
        {at && <span>{at}</span>}
      </p>
      {reply.text.trim() ? <p className="vv-reply-text">{reply.text.trim()}</p> : <p className="empty-note">내용이 없습니다.</p>}
    </li>
  );
}

function Replies({
  ticket,
  entry,
  today,
  onLoad,
}: {
  ticket: VocTicket;
  entry?: VocRepliesEntry;
  today: string;
  onLoad: () => void;
}): ReactElement {
  const loading = entry?.status === 'loading';
  const detail = entry?.detail;
  const replies = detail ? [...detail.replies].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0)) : null;
  const lastReply = kstDateTimeText(ticket.lastReplyAt, today);
  return (
    <section className="vv-section" aria-labelledby="voc-replies-title">
      <div className="vv-section-head">
        <h2 id="voc-replies-title" className="sub-title">
          <IconReply size={16} />
          최근 답변
        </h2>
        <span className="vv-section-note">
          {ticket.replyCount !== undefined ? `${ticket.replyCount}건` : ''}
          {lastReply ? ` · 마지막 ${lastReply}` : ''}
        </span>
        <button type="button" className="btn btn--secondary vv-small-btn" data-testid="btn-voc-replies" disabled={loading} onClick={onLoad}>
          <IconRefresh size={14} />
          {loading ? '받는 중…' : detail ? '다시 받기' : '답변 보기'}
        </button>
      </div>
      {entry?.status === 'error' && (
        <p className="form-problem" role="alert">
          답변을 받지 못했습니다. ({entry.message})
        </p>
      )}
      {replies ? (
        <div data-testid="voc-replies" data-count={replies.length} aria-busy={loading}>
          {replies.length === 0 ? (
            <p className="empty-note">등록된 답변이 없습니다.</p>
          ) : (
            <ol className="vv-reply-list">
              {replies.map((r) => (
                <ReplyItem key={r.id} reply={r} today={today} />
              ))}
            </ol>
          )}
        </div>
      ) : (
        !loading &&
        entry?.status !== 'error' && <p className="empty-note">[답변 보기]를 누르면 VOC 에서 이 티켓의 답변을 한 번 받아 옵니다.</p>
      )}
    </section>
  );
}

interface ActionsProps {
  ticket: VocTicket;
  board: VocBoard | null;
  writeBlock: string | null;
  busyKind?: VocActionKind;
  onAsk: (kind: VocActionKind, value: string) => void;
}

const BUSY_TEXT: Partial<Record<VocActionKind, string>> = {
  assign: '지정하는 중…',
  ictDue: '바꾸는 중…',
  priority: '바꾸는 중…',
};

/** 담당 지정·ICT 예상완료일·우선순위(명세 §4). 담당 해제·고객 희망일 변경은 두지 않는다 */
function Actions({ ticket, board, writeBlock, busyKind, onAsk }: ActionsProps): ReactElement {
  // null = 손대지 않음(티켓 값을 그대로 보인다)
  const [assignee, setAssignee] = useState('');
  const [ict, setIct] = useState<string | null>(null);
  const [priority, setPriority] = useState<string | null>(null);

  // 동작이 끝나면(성공이든 실패든) 입력을 티켓 값으로 되돌린다 — 성공했으면 새 값이 보드로 온다
  const wasBusy = useRef(busyKind);
  useEffect(() => {
    if (wasBusy.current && !busyKind) {
      setAssignee('');
      setIct(null);
      setPriority(null);
    }
    wasBusy.current = busyKind;
  }, [busyKind]);

  const options = assignOptions(board, ticket);
  const locked = !!writeBlock || !!busyKind;
  const ictShown = ict ?? ticket.ictDue ?? '';
  const ictChanged = ictShown !== (ticket.ictDue ?? '') && (ictShown === '' || /^\d{4}-\d{2}-\d{2}$/.test(ictShown));
  const priShown = priority ?? (ticket.priority && (VOC_PRIORITIES as readonly string[]).includes(ticket.priority) ? ticket.priority : '');
  const priChanged = priShown !== '' && priShown !== ticket.priority;
  const busyLabel = (kind: VocActionKind, idle: string): string => (busyKind === kind ? (BUSY_TEXT[kind] ?? '실행하는 중…') : idle);

  let hint: string;
  if (writeBlock) hint = writeBlock;
  else if (busyKind) hint = 'VOC 에 보내는 중입니다. 끝날 때까지 이 티켓의 다른 동작은 막아 둡니다.';
  else hint = '누르면 확인 대화상자에서 한 번 더 확인한 뒤 VOC 에 바로 반영합니다.';

  return (
    <section className="panel vv-actions" aria-labelledby="voc-actions-title" aria-busy={!!busyKind}>
      <h2 id="voc-actions-title" className="result-form-title">
        담당·일정 바꾸기
      </h2>

      <div className="vv-action-row">
        <label htmlFor="voc-assign-select" className="field-label vv-action-label">
          <IconAssign size={16} />
          담당 지정
        </label>
        <div className="vv-action-controls">
          <select
            id="voc-assign-select"
            className="text-input vv-select"
            data-testid="voc-assign-select"
            disabled={locked || options.length === 0}
            value={assignee}
            onChange={(e) => setAssignee(e.target.value)}
          >
            <option value="">{options.length === 0 ? '고를 사람이 없습니다' : '사람 고르기'}</option>
            {options.map((o) => (
              <option key={o.id} value={String(o.id)}>
                {o.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn btn--secondary"
            data-testid="btn-voc-assign"
            disabled={locked || assignee === ''}
            onClick={() => onAsk('assign', assignee)}
          >
            {busyLabel('assign', '담당 지정')}
          </button>
        </div>
      </div>

      <div className="vv-action-row">
        <label htmlFor="voc-ictdue-input" className="field-label vv-action-label">
          <IconCalendar size={16} />
          ICT 예상완료일
        </label>
        <div className="vv-action-controls">
          <input
            id="voc-ictdue-input"
            className="text-input vv-date"
            type="date"
            data-testid="voc-ictdue-input"
            disabled={locked}
            value={ictShown}
            onChange={(e) => setIct(e.target.value)}
          />
          <button
            type="button"
            className="btn btn--secondary"
            data-testid="btn-voc-ictdue"
            disabled={locked || !ictChanged}
            onClick={() => onAsk('ictDue', ictShown)}
          >
            {busyLabel('ictDue', ictShown === '' && ticket.ictDue ? '예상일 지우기' : '예상일 바꾸기')}
          </button>
        </div>
      </div>

      <div className="vv-action-row">
        <label htmlFor="voc-priority-select" className="field-label vv-action-label">
          <IconFlag size={16} />
          우선순위
        </label>
        <div className="vv-action-controls">
          <select
            id="voc-priority-select"
            className="text-input vv-select"
            data-testid="voc-priority-select"
            disabled={locked}
            value={priShown}
            onChange={(e) => setPriority(e.target.value)}
          >
            {priShown === '' && <option value="">{ticket.priority ? `지금 ${ticket.priority}` : '없음'}</option>}
            {VOC_PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {p}
                {p === ticket.priority ? ' (지금)' : ''}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn btn--secondary"
            data-testid="btn-voc-priority"
            disabled={locked || !priChanged}
            onClick={() => onAsk('priority', priShown)}
          >
            {busyLabel('priority', '우선순위 바꾸기')}
          </button>
        </div>
      </div>

      <p className={cls('result-hint vv-actions-hint', writeBlock && 'tone-amber')}>{hint}</p>
    </section>
  );
}

export function VocTicketDetail(props: VocTicketDetailProps): ReactElement {
  const { ticket, laneLabel, today, board, writeBlock, busyKind, replies, onLoadReplies, onAsk, onOpenFile, onOpenWeb, notice, workPanel, ref } =
    props;
  const noticeArea = notice ? <div className="detail-notice scroll">{notice}</div> : null;
  if (!ticket) {
    return (
      <main className="fv-detail vv-detail" data-testid="voc-detail">
        <div className="fv-detail-body scroll" ref={ref}>
          <EmptyState title="고른 티켓이 없습니다.">가운데 목록에서 티켓을 고르면 여기에 자세히 보입니다.</EmptyState>
        </div>
        {noticeArea}
      </main>
    );
  }
  const pri = priorityMark(ticket.priority);
  const sla = slaMark(ticket.slaStatus);
  return (
    <main className="fv-detail vv-detail" data-testid="voc-detail" data-ticket-id={ticket.id} aria-labelledby="voc-detail-title">
      <div className="fv-detail-body scroll" ref={ref}>
        <header className="detail-head">
          <p className="crumb">
            <span>VOC</span>
            {laneLabel && (
              <>
                <span aria-hidden="true">/</span>
                <span>{laneLabel}</span>
              </>
            )}
          </p>
          <p className="vv-detail-number">
            <IconTicket size={16} />
            {ticket.number}
          </p>
          <h1 id="voc-detail-title" className={cls('detail-title', ticket.title.length > 60 && 'detail-title--long')} tabIndex={-1}>
            {ticket.title}
          </h1>
          <ul className="chips" aria-label="티켓 속성">
            <li className="chip">{vocStatusLabel(ticket.status)}</li>
            <li className={cls('chip', pri.tone === 'amber' && 'chip--amber')}>
              <IconFlag size={14} />
              {pri.label}
            </li>
            {sla && ticket.slaStatus !== 'normal' && <li className={cls('chip', sla.tone && `chip--${sla.tone}`)}>{sla.text}</li>}
            {ticket.customer && (
              <li className="chip">
                <IconBuilding size={14} />
                {ticket.customer}
              </li>
            )}
          </ul>
        </header>

        <section className="panel vv-facts-panel" aria-label="티켓 정보">
          <Facts ticket={ticket} today={today} onOpenFile={onOpenFile} />
        </section>

        <section className="vv-section" aria-labelledby="voc-request-title">
          <h2 id="voc-request-title" className="sub-title">
            <IconMemo size={16} />
            요청 내용
          </h2>
          <RequestText key={ticket.id} text={ticket.text} />
        </section>

        <Replies ticket={ticket} entry={replies} today={today} onLoad={onLoadReplies} />

        <Actions key={`actions-${ticket.id}`} ticket={ticket} board={board} writeBlock={writeBlock} busyKind={busyKind} onAsk={onAsk} />

        {workPanel}

        <div className="detail-actions">
          {board?.webBase ? (
            <button type="button" className="btn btn--secondary" data-testid="btn-voc-open-web" onClick={onOpenWeb}>
              <IconWeb size={16} />
              VOC 에서 열기
            </button>
          ) : (
            <p className="empty-note">VOC 웹 주소를 아직 모릅니다(로그인한 VOC 서버 주소로 정합니다).</p>
          )}
        </div>
      </div>
      {noticeArea}
    </main>
  );
}
