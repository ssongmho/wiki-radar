// VOC 처리(2.6단계 명세 §5 V3a) — 내 담당 VOC 할 일(source 'voc')의 상세에서 처리 결과 입력(2단계) 대신 보인다.
// 티켓 요약(보드에서) · 요청 내용 · 답변 달기(ticket reply) · 상태 진행 중/보류(ticket update -s) · 해결·완료는 VOC 웹 안내 + [VOC 에서 열기].
// VOC 에 쓰는 것은 확인 대화상자(voc-confirm)의 [실행]으로만 일어난다. 입력은 taskId 별로 useVocCreate 가 들고 있다(다른 할 일을 보고 와도 남는다).
// 티켓 내용은 데이터다 — 글자로만 보이고 HTML·링크로 해석하지 않는다.
import { useEffect, useId, useRef, useState, type ReactElement, type ReactNode } from 'react';
import type { Task, VocActionInput } from '../../../shared/types';
import { IconAlert, IconCheck, IconClose, IconLogin, IconRefresh, IconTicket, IconWeb } from '../../components/Icons';
import {
  NO_VOC_MESSAGE,
  checkCharsetNow,
  closeVocTaskNotice,
  openVocLogin,
  openVocWeb,
  runVocAction,
  showVocTicket,
  updateVocTask,
  useSharedVocBoard,
  useVocCharset,
  useVocTaskEntry,
  vocActionSupported,
} from '../../hooks/useVocCreate';
import { cls } from '../../lib/cls';
import { refocusIfLost } from '../../lib/focus';
import { makeSendId, previewLines } from '../../lib/reply';
import type { SaveNotice } from '../../lib/result';
import { textOf, vocStatusLabel } from '../../lib/tasks';
import { needsVocLogin } from '../../lib/voc';
import {
  VOC_LIMITS,
  VOC_PREVIEW_LINES,
  VOC_RESOLVE_NOTE,
  VOC_STATUS_CHOICES,
  canOpenWeb,
  checkVocReply,
  cleanVocText,
  defaultStatusChoice,
  foldText,
  isStatusChoice,
  replyConfirmLead,
  statusConfirmLead,
  taskWriteBlock,
  ticketFacts,
  ticketOnBoard,
} from '../../lib/vocTask';

// ── 함께 쓰는 조각(VOC 등록 칸도 쓴다) ──

export interface VocConfirmDialogProps {
  open: boolean;
  /** data-kind(reply·status·create) */
  kind: string;
  title: string;
  children: ReactNode;
  confirmText: string;
  confirmIcon?: ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
  wide?: boolean;
  /** [실행]을 막는다(입력이 모자랄 때 — V4 해결·메일 대화상자) */
  confirmDisabled?: boolean;
  /** [취소] 글자(기본 '취소') */
  cancelText?: string;
}

/**
 * VOC 쓰기 확인 대화상자(voc-confirm · 그 안 [실행] btn-voc-confirm · data-kind). 모양·동작은 ConfirmDialog 와 같다 —
 * showModal(바깥 inert·Esc·초점 가둠), 처음 초점은 [취소](되돌리기 번거로운 쓰기를 Enter 한 번으로 시작하지 않게).
 */
export function VocConfirmDialog(props: VocConfirmDialogProps): ReactElement {
  const { open, kind, title, children, confirmText, confirmIcon, onConfirm, onCancel, wide, confirmDisabled, cancelText = '취소' } = props;
  const ref = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const bodyId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      try {
        dialog.showModal();
      } catch {
        dialog.setAttribute('open', ''); // showModal 이 없는 환경(시험 등)
      }
      cancelRef.current?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={wide ? 'dialog dialog--wide' : 'dialog'}
      data-testid={open ? 'voc-confirm' : undefined}
      data-kind={open ? kind : undefined}
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      // Esc: 브라우저가 닫기 전에 상태로 되돌린다(열림 상태를 React 가 쥐고 있게)
      onCancel={(e) => {
        e.preventDefault();
        onCancel();
      }}
    >
      {open && (
        <div className="dialog-inner">
          <h2 id={titleId} className="dialog-title">
            {title}
          </h2>
          <div id={bodyId} className="dialog-body">
            {children}
          </div>
          <div className="dialog-actions">
            <button type="button" className="btn btn--primary" data-testid="btn-voc-confirm" disabled={confirmDisabled} onClick={onConfirm}>
              {confirmIcon}
              {confirmText}
            </button>
            <button type="button" className="btn btn--secondary" ref={cancelRef} onClick={onCancel}>
              {cancelText}
            </button>
          </div>
        </div>
      )}
    </dialog>
  );
}

const AUTO_HIDE_MS = 12_000;

/** VOC 쓰기 결과 알림(voc-action-notice · data-tone). 문제없으면 잠시 뒤 사라지고, 경고·실패는 닫을 때까지 남는다 */
export function VocNotice({ notice, onClose }: { notice: SaveNotice; onClose: () => void }): ReactElement {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (notice.tone !== 'ok') return;
    const timer = window.setTimeout(() => closeRef.current(), AUTO_HIDE_MS);
    return () => window.clearTimeout(timer);
  }, [notice.id, notice.tone]);

  const isError = notice.tone === 'error';
  return (
    <div
      className={cls('save-notice', `save-notice--${notice.tone}`, 'voc-notice')}
      data-testid="voc-action-notice"
      data-tone={notice.tone}
      role={isError ? 'alert' : 'status'}
    >
      <div className="save-notice-head">
        {notice.tone === 'ok' ? <IconCheck size={16} /> : <IconAlert size={16} />}
        <p className="save-notice-title">{notice.title}</p>
        <button type="button" className="icon-btn save-notice-close" aria-label="VOC 결과 알림 닫기" onClick={onClose}>
          <IconClose size={16} />
        </button>
      </div>
      {notice.lines.length > 0 && (
        <ul className="save-notice-lines">
          {notice.lines.map((line, i) => (
            <li key={`${i}:${line.text}`} className={cls(line.warn && 'is-warn')}>
              {line.text}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * '로그인 필요' 안내 + [로그인](명세 §13 — 풀스크린 VOC 화면으로 옮겨 로그인 대화상자를 연다). VOC 처리(V3a)·VOC 등록(V3b)이 쓴다
 */
export function VocLoginNeeded({ text }: { text: string }): ReactElement {
  return (
    <div className="reply-sender reply-sender--warn voc-login-needed" data-testid="voc-login-needed">
      <IconAlert size={16} />
      <p className="reply-sender-text">{text}</p>
      <button type="button" className="btn btn--secondary" data-testid="btn-voc-login-open" onClick={openVocLogin}>
        <IconLogin size={16} />
        로그인
      </button>
    </div>
  );
}

/** 글자 수 '1,234 / 5,000자'(넘으면 코랄) */
export function CharCount({ length, max, id }: { length: number; max: number; id?: string }): ReactElement {
  return (
    <span id={id} className={cls('voc-count', length > max && 'is-over')}>
      {length.toLocaleString('ko-KR')} / {max.toLocaleString('ko-KR')}자
    </span>
  );
}

// ── VOC 처리 ──

/** 대화상자를 열 때 정한 쓰기(actionId 는 대화상자마다 새로 — main 은 같은 값을 두 번 실행하지 않는다) */
interface PendingAction {
  kind: 'reply' | 'status';
  actionId: string;
  value: string;
  /** status: 대화상자를 열 때의 지금 상태(대화상자가 보인 값) */
  from?: string;
}

export interface VocTaskPanelProps {
  task: Task;
  today: string;
}

export function VocTaskPanel({ task, today }: VocTaskPanelProps): ReactElement {
  const info = task.voc;
  const ticketId = info?.id ?? -1;
  const number = textOf(info?.number) ?? `#${ticketId}`;
  const board = useSharedVocBoard();
  const ticket = info ? ticketOnBoard(board, ticketId) : undefined;
  const entry = useVocTaskEntry(task.id);
  const charset = useVocCharset(entry.reply);
  const [, setRecheck] = useState(0);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [expanded, setExpanded] = useState(false);
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const statusRef = useRef<HTMLSelectElement>(null);
  const supported = vocActionSupported();

  const busy = entry.busy !== null;
  const check = checkVocReply(entry.reply, charset.chars, busy);
  const currentStatus = textOf(ticket?.status) ?? textOf(info?.status);
  const statusChoice = isStatusChoice(entry.status) ? entry.status : defaultStatusChoice(currentStatus);
  const statusSame = statusChoice === currentStatus;
  const facts = info ? ticketFacts(task, ticket, today) : [];
  const text = textOf(ticket?.text);
  const fold = text ? foldText(text) : null;
  const replyLength = cleanVocText(entry.reply).length;
  const webOk = canOpenWeb(board);
  // 로그인 필요·설정 필요면 VOC 로 보내 봐야 확인 뒤에 실패한다 — VOC 화면(writeBlockReason)과 같이 버튼을 막고 이유를 보인다
  const writeBlock = taskWriteBlock(board, '바꿀');

  if (!info) {
    return (
      <section className="panel voc-task-panel" data-testid="voc-task-panel">
        <p className="form-problem">VOC 티켓 정보가 없는 VOC 할 일입니다. VOC 화면에서 확인해 주세요.</p>
      </section>
    );
  }

  const askReply = async (): Promise<void> => {
    if (!check.ok || !supported || writeBlock) return;
    const body = cleanVocText(entry.reply);
    // 입력을 멈추자마자 누르면 검사가 아직일 수 있다 — 지금 확인하고, 보낼 수 없는 글자가 있으면 대화상자 대신 안내를 보인다
    const bad = await checkCharsetNow(entry.reply);
    if (bad.length > 0) {
      setRecheck((n) => n + 1);
      return;
    }
    setPending({ kind: 'reply', actionId: makeSendId(), value: body });
  };
  const askStatus = (): void => {
    if (busy || statusSame || !supported || writeBlock) return;
    setPending({ kind: 'status', actionId: makeSendId(), value: statusChoice, from: currentStatus });
  };
  const run = (): void => {
    const p = pending;
    setPending(null);
    if (!p) return;
    const from = p.from ?? currentStatus;
    const input: VocActionInput = { actionId: p.actionId, kind: p.kind, ticketId, value: p.value };
    // 확인 대화상자가 보인 지금 상태 — main 은 쓰기 직전 VOC 에서 다시 읽어 다르면(그사이 바뀌었으면) 실행하지 않는다
    if (p.kind === 'status' && from) input.expected = { status: from };
    void runVocAction(task.id, input, { kind: p.kind, number, from, value: p.value }).then(() => {
      // 쓰는 동안 비활성이던 버튼에서 떨어진 초점을 입력 칸으로
      refocusIfLost(() => (p.kind === 'reply' ? replyRef.current : statusRef.current));
    });
  };

  let replyHint: string;
  if (!supported) replyHint = NO_VOC_MESSAGE;
  else if (entry.busy === 'reply') replyHint = '답변을 등록하는 중입니다…';
  else if (writeBlock) replyHint = writeBlock;
  else if (check.reason) replyHint = check.reason;
  else replyHint = '등록하기 전에 한 번 더 확인합니다.';

  let statusHint: string;
  if (entry.busy === 'status') statusHint = '상태를 바꾸는 중입니다…';
  else if (busy) statusHint = 'VOC 에 쓰는 중입니다. 끝나면 바꿀 수 있습니다.';
  else if (writeBlock) statusHint = `지금 ${vocStatusLabel(currentStatus)} — ${writeBlock}`;
  else statusHint = `지금 ${vocStatusLabel(currentStatus)}`;

  const preview = pending?.kind === 'reply' ? previewLines(pending.value, VOC_PREVIEW_LINES) : null;

  return (
    <section
      className="panel voc-task-panel"
      data-testid="voc-task-panel"
      data-ticket-id={ticketId}
      aria-labelledby="voc-task-title"
      aria-busy={busy}
    >
      <div className="voc-task-head">
        <h2 id="voc-task-title" className="result-form-title">
          VOC 처리
        </h2>
        <span className="voc-task-number">
          <IconTicket size={14} />
          {number}
        </span>
      </div>
      <p className="voc-task-lead">
        이 할 일은 VOC 티켓입니다. 처리는 위키가 아니라 VOC 에 남기고, VOC 에 쓰기 전에는 한 번 더 확인합니다.
      </p>
      {needsVocLogin(board) && <VocLoginNeeded text="VOC 에 로그인이 필요합니다 — 로그인한 뒤 답변·상태를 바꿀 수 있습니다." />}

      {facts.length > 0 && (
        <dl className="voc-facts" aria-label="티켓 요약">
          {facts.map((f) => (
            <div key={f.key} className="voc-fact">
              <dt>{f.label}</dt>
              <dd className={cls(f.tone && `tone-${f.tone}`)}>{f.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {!ticket && (
        <p className="field-note">
          {board ? 'VOC 목록에서 이 티켓을 찾지 못해 할 일에 든 값만 보입니다.' : 'VOC 목록을 받는 중입니다. 받으면 요약이 더 채워집니다.'}
        </p>
      )}

      {fold && (
        <div className="field">
          <h3 className="field-label">요청 내용</h3>
          <p className="voc-task-text" data-testid="voc-task-text">
            {expanded ? text : fold.head}
          </p>
          {fold.hidden > 0 && (
            <button type="button" className="link-btn voc-fold-btn" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
              {expanded ? '요청 내용 접기' : `요청 내용 ${fold.hidden}줄 더 보기`}
            </button>
          )}
        </div>
      )}

      <div className="voc-task-block">
        <div className="field">
          <div className="field-head">
            <label htmlFor="voc-reply-input" className="field-label">
              답변 달기
            </label>
            <CharCount length={replyLength} max={VOC_LIMITS.reply} id="voc-reply-count" />
          </div>
          <textarea
            id="voc-reply-input"
            ref={replyRef}
            className="text-input text-area"
            rows={5}
            data-testid="voc-reply-input"
            disabled={entry.busy === 'reply'}
            spellCheck={false}
            placeholder="VOC 티켓에 남길 답변. 고객 포털에서 보일 수 있습니다."
            value={entry.reply}
            aria-describedby={cls('voc-reply-count', check.charset && 'voc-reply-charset', check.problem && 'voc-reply-problem', 'voc-reply-hint')}
            onChange={(e) => updateVocTask(task.id, { reply: e.target.value })}
          />
        </div>
        {check.charset && (
          <p id="voc-reply-charset" className="form-problem" data-testid="voc-charset-problem" role="alert">
            {check.charset}
          </p>
        )}
        {check.problem && (
          <p id="voc-reply-problem" className="form-problem" role="alert">
            {check.problem}
          </p>
        )}
        <div className="result-actions">
          <button
            type="button"
            className="btn btn--primary"
            data-testid="btn-voc-reply"
            disabled={!check.ok || !supported || !!writeBlock}
            aria-describedby="voc-reply-hint"
            onClick={() => void askReply()}
          >
            {entry.busy === 'reply' ? '등록하는 중…' : '답변 등록'}
          </button>
          <span id="voc-reply-hint" className="result-hint">
            {replyHint}
          </span>
        </div>
      </div>

      <div className="voc-task-block">
        <label htmlFor="voc-status-select" className="field-label">
          상태
        </label>
        <div className="voc-task-row">
          <select
            id="voc-status-select"
            ref={statusRef}
            className="text-input voc-select voc-status-select"
            data-testid="voc-status-select"
            disabled={busy}
            value={statusChoice}
            aria-describedby="voc-status-hint"
            onChange={(e) => updateVocTask(task.id, { status: e.target.value })}
          >
            {VOC_STATUS_CHOICES.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn btn--secondary"
            data-testid="btn-voc-status"
            disabled={busy || statusSame || !supported || !!writeBlock}
            onClick={askStatus}
          >
            <IconRefresh size={16} />
            {entry.busy === 'status' ? '바꾸는 중…' : '상태 바꾸기'}
          </button>
          <span id="voc-status-hint" className="result-hint voc-status-hint">
            {statusHint}
          </span>
        </div>
      </div>

      <div className="voc-task-web">
        <p className="voc-task-web-note">{VOC_RESOLVE_NOTE}</p>
        <div className="voc-task-web-actions">
          <button
            type="button"
            className="btn btn--secondary"
            data-testid="btn-voc-open-web"
            disabled={!webOk}
            title={webOk ? undefined : 'VOC 웹 주소를 아직 모릅니다(로그인한 VOC 서버 주소로 정합니다).'}
            onClick={() => void openVocWeb(task.id, ticketId, number)}
          >
            <IconWeb size={16} />
            VOC 에서 열기
          </button>
          <button type="button" className="link-btn" onClick={() => showVocTicket(ticketId)}>
            <IconTicket size={14} />
            VOC 화면에서 보기
          </button>
        </div>
      </div>

      {entry.notice && <VocNotice notice={entry.notice} onClose={() => closeVocTaskNotice(task.id)} />}

      <VocConfirmDialog
        open={pending !== null}
        kind={pending?.kind ?? 'reply'}
        wide={pending?.kind === 'reply'}
        title={pending?.kind === 'status' ? 'VOC 상태를 바꿀까요?' : 'VOC 에 답변을 등록할까요?'}
        confirmText={pending?.kind === 'status' ? '상태 바꾸기' : '답변 등록'}
        onConfirm={run}
        onCancel={() => setPending(null)}
      >
        {pending?.kind === 'status' ? (
          <p>{statusConfirmLead(number, pending.from ?? currentStatus, pending.value)}</p>
        ) : (
          <>
            <p>{replyConfirmLead(number)}</p>
            {preview && (
              <div className="confirm-section">
                <p className="field-label">답변 앞 {preview.lines.length}줄</p>
                <pre className="confirm-body">
                  {preview.lines.join('\n')}
                  {preview.more > 0 && <span className="confirm-more">{`\n…(${preview.more}줄 더)`}</span>}
                </pre>
              </div>
            )}
          </>
        )}
      </VocConfirmDialog>
    </section>
  );
}
