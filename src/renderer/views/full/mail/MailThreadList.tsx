// 메일함 가운데 목록(2.10단계 명세 §8-2): 스레드 한 줄 = 보낸이(참여자, 내가 있으면 '나, …') · 시각 · 제목 · 칩.
// 미확인은 굵게 + 시안 점. 200줄씩, 끝에서 [더 보기]. 줄은 roving tabindex(고른 줄만 Tab 으로 들어온다) — 위/아래 키는 MailboxView 가 맡는다.
// 제목·보낸이는 메일에서 온 글자다 — 텍스트 노드로만 그린다.
import type { ReactElement, Ref } from 'react';
import type { MailThreadRow } from '../../../../shared/types';
import { EmptyState } from '../../../components/StateMessage';
import { cls } from '../../../lib/cls';
import { mailTimeLabel, participantsText, rowChips } from '../../../lib/mailbox';

export interface MailThreadListProps {
  rows: readonly MailThreadRow[];
  total: number;
  today: string;
  selectedId: string | null;
  focusableId: string | null;
  onSelect: (row: MailThreadRow) => void;
  registerRow: (id: string, el: HTMLButtonElement | null) => void;
  onMore: () => void;
  loadingMore: boolean;
  emptyTitle: string;
  emptyDetail?: string;
  ref?: Ref<HTMLDivElement>;
}

function rowAriaLabel(row: MailThreadRow, today: string): string {
  const parts = [participantsText(row), row.subject, mailTimeLabel(row.latestDate, today)];
  if (row.unread) parts.unshift('미확인');
  if (row.count > 1) parts.push(`${row.count}통`);
  for (const c of rowChips(row)) parts.push(c.label);
  return parts.filter(Boolean).join(', ');
}

export function MailThreadList(props: MailThreadListProps): ReactElement {
  const { rows, total, today, selectedId, focusableId, onSelect, registerRow, onMore, loadingMore, emptyTitle, emptyDetail, ref } = props;
  return (
    <div className="mb-list-body scroll" ref={ref} data-testid="mail-list" data-count={rows.length}>
      {rows.length === 0 ? (
        <EmptyState title={emptyTitle}>{emptyDetail}</EmptyState>
      ) : (
        <ul className="mb-rows">
          {rows.map((row) => {
            const selected = row.id === selectedId;
            const chips = rowChips(row);
            return (
              <li key={row.id}>
                <button
                  ref={(el) => registerRow(row.id, el)}
                  type="button"
                  className={cls('mb-row', selected && 'is-selected', row.unread && 'is-unread', row.muted && 'is-muted')}
                  data-testid="mail-thread-row"
                  data-thread-id={row.id}
                  data-unread={row.unread ? 'true' : 'false'}
                  data-reply-needed={row.replyNeeded ? 'true' : 'false'}
                  data-archived={row.archived ? 'true' : 'false'}
                  data-count={row.count}
                  aria-current={selected ? 'true' : undefined}
                  aria-label={rowAriaLabel(row, today)}
                  tabIndex={row.id === focusableId ? 0 : -1}
                  title={row.subject}
                  onClick={() => onSelect(row)}
                >
                  <span className="mb-row-top" aria-hidden="true">
                    <span className={cls('mb-dot', row.unread && 'is-on')} />
                    <span className="mb-row-from">{participantsText(row)}</span>
                    <span className="mb-row-time">{mailTimeLabel(row.latestDate, today)}</span>
                  </span>
                  <span className="mb-row-subject" aria-hidden="true">
                    {row.subject || '(제목 없음)'}
                  </span>
                  {(chips.length > 0 || row.count > 1) && (
                    <span className="mb-row-chips" aria-hidden="true">
                      {chips.map((c) => (
                        <span key={c.kind} className={cls('mb-chip', `mb-chip--${c.tone}`)} data-testid={`mail-chip-${c.kind}`} data-state={c.state}>
                          {c.label}
                        </span>
                      ))}
                      {row.count > 1 && (
                        <span className="mb-chip mb-chip--count" title={`스레드 ${row.count}통`}>
                          {row.count}
                        </span>
                      )}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {rows.length < total && (
        <button type="button" className="btn btn--secondary mb-more" data-testid="btn-mail-more" disabled={loadingMore} onClick={onMore}>
          {loadingMore ? '받는 중…' : `더 보기 (${(total - rows.length).toLocaleString('ko-KR')}개 더)`}
        </button>
      )}
    </div>
  );
}
