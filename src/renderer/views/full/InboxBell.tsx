// 알림함(2.9단계 명세 §8-1): 풀스크린 제목 막대 오른쪽(창 단추 바로 왼쪽)의 종 단추와, 누르면 아래로 펼치는 판.
// 판은 비모달 대화상자 — Esc·바깥 누르기로 닫히고, 열면 첫 항목에 초점. 읽음은 판을 열 때가 아니라 [열기]·[모두 읽음]·Windows 알림 클릭으로만.
// 수(안 읽음·오늘 Windows 알림)는 main 이 센 것만 쓴다(§8-3).
// 2.12단계 §10: 긴급·안 읽은 항목의 [나중에](1시간 뒤 · 내일 아침), 미룬 항목은 아래 「나중에」 묶음(접힘), 머리에 보류 중·나중에 N.
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from 'react';
import type { NotifyItem, NotifyKind, NotifySettings, SnoozeKind } from '../../../shared/types';
import {
  IconBell,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconClock,
  IconClose,
  IconDot,
  IconExternal,
  IconRefresh,
  IconSettings,
} from '../../components/Icons';
import type { InboxHook } from '../../hooks/useInbox';
import { cls } from '../../lib/cls';
import {
  badgeTone,
  bellLabel,
  canSnooze,
  formatInboxTime,
  heldBannerText,
  isSnoozed,
  muteNoticeText,
  snoozeOptionText,
  snoozeTagText,
  toastCountText,
} from '../../lib/inbox';

export interface InboxBellProps {
  inbox: InboxHook;
  today: string;
  /** 바깥(view:inbox — 여러 건 Windows 알림·사이드바 긴급 띠)에서 펼치라는 요청. 늘어날 때마다 펼친다 */
  openRequest: number;
  /** 설정 › 알림 칸을 연다 */
  onShowSettings: () => void;
}

interface MuteNotice {
  kind: NotifyKind;
  before: NotifySettings;
}

/** [나중에] 선택(1시간 뒤 · 내일 아침). Esc·바깥 누르기로 닫히고, 위·아래 화살표로 고른다 */
function SnoozeMenu({
  nextMorningAt,
  onPick,
  onClose,
}: {
  nextMorningAt: string | null;
  onPick: (kind: SnoozeKind) => void;
  onClose: () => void;
}): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const [hourAt] = useState(() => new Date(Date.now() + 60 * 60_000).toISOString());
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [onClose]);
  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      // 판까지 닫지 않게 여기서 멈춘다
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    buttons[(i + (e.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus();
  };
  return (
    <div className="inbox-snooze-menu" role="menu" aria-label="나중에 다시 알림" ref={ref} onKeyDown={onKey}>
      <button type="button" role="menuitem" className="inbox-snooze-option tnum" data-testid="inbox-snooze-1h" onClick={() => onPick('1h')}>
        {snoozeOptionText('1h', hourAt)}
      </button>
      <button
        type="button"
        role="menuitem"
        className="inbox-snooze-option tnum"
        data-testid="inbox-snooze-morning"
        onClick={() => onPick('morning')}
      >
        {snoozeOptionText('morning', nextMorningAt)}
      </button>
    </div>
  );
}

function InboxRow({
  item,
  today,
  onOpen,
  onMute,
  onSnooze,
  nextMorningAt,
  busy,
}: {
  item: NotifyItem;
  today: string;
  onOpen: () => void;
  /** 없으면 [이런 알림 끄기]를 그리지 않는다(미룬 묶음) */
  onMute?: () => void;
  /** 없으면 [나중에]를 그리지 않는다(옛 preload·미룰 수 없는 항목) */
  onSnooze?: (kind: SnoozeKind) => void;
  nextMorningAt: string | null;
  busy: boolean;
}): ReactElement {
  const [menu, setMenu] = useState(false);
  const snoozed = isSnoozed(item);
  const unread = item.readAt === null && !snoozed;
  const titleId = `inbox-title-${item.id}`;
  return (
    <li
      className={cls('inbox-item', unread && 'is-unread', snoozed && 'is-snoozed', `is-${item.grade}`)}
      data-testid="inbox-item"
      data-key={item.key}
      data-kind={item.kind}
      data-grade={item.grade}
      data-unread={unread ? 'true' : 'false'}
      data-snoozed={snoozed ? 'true' : 'false'}
      data-reminded={item.reminded ? 'true' : 'false'}
      aria-labelledby={titleId}
    >
      <span className="inbox-mark" title={item.grade === 'urgent' ? '긴급' : '오늘'}>
        <IconDot size={8} />
      </span>
      <div className="inbox-main">
        <p className="inbox-title" id={titleId}>
          {unread && <span className="sr-only">안 읽음 · </span>}
          {item.title}
        </p>
        {item.body && <p className="inbox-body">{item.body}</p>}
        <p className="inbox-meta">
          <span className="tnum">{formatInboxTime(item.createdAt, today)}</span>
          {item.deferred && <span className="inbox-tag">업무 시간 밖</span>}
          {item.reminded && !snoozed && <span className="inbox-tag is-reminded">다시 알림</span>}
          {snoozed && item.snoozeUntil && (
            <span className="inbox-tag tnum" data-testid="inbox-snoozed-tag">
              {snoozeTagText(item.snoozeUntil, today)}
            </span>
          )}
        </p>
        <div className="inbox-actions">
          <button type="button" className="btn btn--ghost btn--sm" data-testid="inbox-open" disabled={busy} onClick={onOpen}>
            <IconExternal size={14} />
            열기
          </button>
          {onSnooze && (
            <button
              type="button"
              className={cls('btn btn--ghost btn--sm', menu && 'is-active')}
              data-testid="inbox-snooze"
              aria-haspopup="menu"
              aria-expanded={menu}
              disabled={busy}
              onClick={() => setMenu((v) => !v)}
            >
              <IconClock size={14} />
              나중에
            </button>
          )}
          {onMute && (
            <button type="button" className="btn btn--ghost btn--sm" data-testid="inbox-mute" disabled={busy} onClick={onMute}>
              <IconClose size={14} />
              이런 알림 끄기
            </button>
          )}
        </div>
        {menu && onSnooze && (
          <SnoozeMenu
            nextMorningAt={nextMorningAt}
            onClose={() => setMenu(false)}
            onPick={(kind) => {
              setMenu(false);
              onSnooze(kind);
            }}
          />
        )}
      </div>
    </li>
  );
}

export function InboxBell({ inbox: hook, today, openRequest, onShowSettings }: InboxBellProps): ReactElement | null {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [muted, setMuted] = useState<MuteNotice | null>(null);
  const [snoozedOpen, setSnoozedOpen] = useState(false);
  const bellRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const { inbox } = hook;

  // 바깥 요청(view:inbox)으로 펼친다
  const firstRequest = useRef(openRequest);
  useEffect(() => {
    if (openRequest !== firstRequest.current) setOpen(true);
  }, [openRequest]);

  // 열면 첫 항목(없으면 판)에 초점
  useEffect(() => {
    if (!open) return;
    const id = window.requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (!panel) return;
      (panel.querySelector<HTMLButtonElement>('[data-testid="inbox-open"]') ?? panel).focus();
    });
    return () => window.cancelAnimationFrame(id);
  }, [open]);

  // Esc·바깥 누르기로 닫는다
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      setOpen(false);
      bellRef.current?.focus();
    };
    const onDown = (e: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  if (!hook.supported) return null;
  const tone = badgeTone(inbox);
  const unread = inbox?.unread ?? 0;
  const mainItems = inbox ? inbox.items.filter((i) => !isSnoozed(i)) : [];
  const snoozedItems = inbox ? inbox.items.filter(isSnoozed) : [];
  const snoozedCount = inbox?.snoozed ?? snoozedItems.length;
  const held = heldBannerText(inbox);
  const nextMorningAt = inbox?.nextMorningAt ?? null;

  const act = async (fn: () => Promise<void>): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  const openItem = (item: NotifyItem) => () =>
    void act(async () => {
      await hook.open(item.id);
      setOpen(false);
    });

  return (
    <div className="inbox" ref={wrapRef}>
      <button
        type="button"
        ref={bellRef}
        className={cls('inbox-bell', open && 'is-open')}
        data-testid="inbox-bell"
        data-unread={unread}
        aria-label={bellLabel(inbox)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title="알림함"
        onClick={() => setOpen((v) => !v)}
      >
        <IconBell size={16} />
        {tone && (
          <span className={cls('inbox-badge', tone === 'urgent' && 'is-urgent')} aria-hidden="true">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
      {open && (
        <div
          className="inbox-panel"
          role="dialog"
          aria-modal="false"
          aria-labelledby="inbox-heading"
          data-testid="inbox-panel"
          tabIndex={-1}
          ref={panelRef}
        >
          <header className="inbox-head">
            <h2 id="inbox-heading" className="inbox-heading">
              알림
            </h2>
            {inbox && <span className="inbox-toasts tnum">{toastCountText(inbox)}</span>}
            {snoozedCount > 0 && (
              <span className="inbox-snoozed-count tnum" data-testid="inbox-snoozed-count">
                나중에 {snoozedCount}
              </span>
            )}
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              data-testid="inbox-read-all"
              disabled={busy || unread === 0}
              onClick={() => void act(hook.markAllRead)}
            >
              <IconCheck size={14} />
              모두 읽음
            </button>
          </header>
          {held && inbox?.held && (
            <p className="inbox-held" role="status" data-testid="inbox-held" data-reason={inbox.held.reason}>
              <IconClock size={14} />
              <span>{held}</span>
            </p>
          )}
          {muted && (
            <div className="inbox-notice" role="status" data-testid="inbox-mute-notice">
              <span>{muteNoticeText(muted.kind)}</span>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                data-testid="inbox-mute-undo"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    if (await hook.restore(muted.before)) setMuted(null);
                  })
                }
              >
                <IconRefresh size={14} />
                되돌리기
              </button>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                data-testid="inbox-mute-settings"
                onClick={() => {
                  setMuted(null);
                  setOpen(false);
                  onShowSettings();
                }}
              >
                <IconSettings size={14} />
                설정 보기
              </button>
            </div>
          )}
          {hook.error && (
            <p className="form-problem inbox-error" role="alert">
              {hook.error}
            </p>
          )}
          {!inbox || inbox.items.length === 0 ? (
            <p className="inbox-empty" data-testid="inbox-empty">
              알림이 없습니다.
            </p>
          ) : (
            <div className="inbox-scroll scroll">
              {mainItems.length > 0 && (
                <ul className="inbox-list" aria-label="알림 목록">
                  {mainItems.map((item) => (
                    <InboxRow
                      key={item.id}
                      item={item}
                      today={today}
                      busy={busy}
                      nextMorningAt={nextMorningAt}
                      onOpen={openItem(item)}
                      onMute={() =>
                        void act(async () => {
                          const before = await hook.mute(item.kind);
                          if (before) setMuted({ kind: item.kind, before });
                        })
                      }
                      onSnooze={
                        hook.snoozeSupported && canSnooze(item) ? (kind) => void act(() => hook.snooze([item.id], kind)) : undefined
                      }
                    />
                  ))}
                </ul>
              )}
              {snoozedItems.length > 0 && (
                <section className="inbox-snoozed" data-testid="inbox-snoozed-group" data-open={snoozedOpen ? 'true' : 'false'}>
                  <button
                    type="button"
                    className="inbox-snoozed-toggle"
                    data-testid="inbox-snoozed-toggle"
                    aria-expanded={snoozedOpen}
                    onClick={() => setSnoozedOpen((v) => !v)}
                  >
                    {snoozedOpen ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
                    나중에 <span className="tnum">{snoozedItems.length}</span>
                  </button>
                  {snoozedOpen && (
                    <ul className="inbox-list" aria-label="미룬 알림">
                      {snoozedItems.map((item) => (
                        <InboxRow
                          key={item.id}
                          item={item}
                          today={today}
                          busy={busy}
                          nextMorningAt={nextMorningAt}
                          onOpen={openItem(item)}
                        />
                      ))}
                    </ul>
                  )}
                </section>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
