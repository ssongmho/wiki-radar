// VOC 화면 가운데 티켓 목록(2.6단계 명세 §3-1): 고른 칸의 티켓. 줄마다 우선순위 표식·번호·제목·고객사 · 시스템·경과·SLA·기한.
// 줄은 roving tabindex(고른 줄만 Tab 으로 들어온다). 위/아래 키 이동은 VocView 가 맡는다.
import type { ReactElement, Ref } from 'react';
import type { VocTicket } from '../../../../shared/types';
import { EmptyState } from '../../../components/StateMessage';
import { cls } from '../../../lib/cls';
import { priorityMark, slaKey, slaMark, ticketAriaLabel, ticketMetaParts } from '../../../lib/voc';

export interface VocTicketListProps {
  tickets: readonly VocTicket[];
  today: string;
  selectedId: number | null;
  /** Tab 으로 들어올 줄 */
  focusableId: number | null;
  onSelect: (ticket: VocTicket) => void;
  registerRow: (id: number, el: HTMLButtonElement | null) => void;
  /** 비었을 때 문장 */
  emptyTitle: string;
  emptyDetail?: string;
  ref?: Ref<HTMLDivElement>;
}

export function VocTicketRow({
  ticket,
  today,
  selected,
  tabIndex,
  onSelect,
  ref,
}: {
  ticket: VocTicket;
  today: string;
  selected: boolean;
  tabIndex: number;
  onSelect: (ticket: VocTicket) => void;
  ref?: Ref<HTMLButtonElement>;
}): ReactElement {
  const pri = priorityMark(ticket.priority);
  const sla = slaMark(ticket.slaStatus);
  const meta = ticketMetaParts(ticket, today);
  return (
    <button
      ref={ref}
      type="button"
      className={cls('row', 'row--full', 'vv-ticket', selected && 'is-selected')}
      data-testid="voc-ticket"
      data-ticket-id={ticket.id}
      data-sla={slaKey(ticket.slaStatus)}
      aria-current={selected ? 'true' : undefined}
      aria-label={ticketAriaLabel(ticket, today)}
      tabIndex={tabIndex}
      title={`${ticket.number} ${ticket.title}`}
      onClick={() => onSelect(ticket)}
    >
      <span className={cls('strip', 'vv-pri', pri.tone && `vv-pri--${pri.tone}`)} aria-hidden="true">
        <span className="strip-top">{pri.text}</span>
      </span>
      <span className="row-body" aria-hidden="true">
        <span className="vv-ticket-top">
          <span className="vv-ticket-number">{ticket.number}</span>
          {sla && ticket.slaStatus !== 'normal' && <span className={cls('voc-badge', sla.tone && `voc-badge--${sla.tone}`)}>{sla.text}</span>}
        </span>
        <span className="row-title">{ticket.title}</span>
        <span className="row-meta">
          {meta.map((m) => (
            <span key={m.key} className={cls('meta', m.tone && `meta--${m.tone}`)}>
              {m.text}
            </span>
          ))}
        </span>
      </span>
    </button>
  );
}

export function VocTicketList(props: VocTicketListProps): ReactElement {
  const { tickets, today, selectedId, focusableId, onSelect, registerRow, emptyTitle, emptyDetail, ref } = props;
  return (
    <div className="vv-list-body scroll" ref={ref}>
      {tickets.length === 0 ? (
        <EmptyState title={emptyTitle}>{emptyDetail}</EmptyState>
      ) : (
        <ul className="rows">
          {tickets.map((ticket) => (
            <li key={ticket.id}>
              <VocTicketRow
                ticket={ticket}
                today={today}
                selected={ticket.id === selectedId}
                tabIndex={ticket.id === focusableId ? 0 : -1}
                onSelect={onSelect}
                ref={(el) => registerRow(ticket.id, el)}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
