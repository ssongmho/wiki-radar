// 메일함 안의 회신 화면(2.10단계 명세 §7-1·§8-3, 시안 Mail-3 틀): 가운데 = 2.5 ReplyComposer(메일 대상 — 켜기 칸 없이 늘 펼침,
// 「이번에 전할 핵심」 칸) + [보내기…] · 오른쪽 = 원본 메일 · 사람이 확인할 것(초안 notes) · 초안이 읽은 것(references) · 안전.
// 위키에는 쓰지 않는다 — 발송 기록만 앱 데이터에 남고(taskId '' · origin 'mailbox'), 보낸 뒤 회신 필요를 지우고 (고르면) 처리함으로.
// 원본 메일 본문은 데이터다 — 글자로만 보인다.
import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { MailMessage, MailThreadDetail, MailThreadMail } from '../../../../shared/types';
import { NO_BRIDGE_MESSAGE, getRadar } from '../../../api';
import { ConfirmDialog } from '../../../components/ConfirmDialog';
import { IconAlert, IconBack, IconChecklist, IconSend } from '../../../components/Icons';
import type { ReplyHook } from '../../../hooks/useReply';
import { acceptSummary } from '../../../hooks/useMailbox';
import { refocusIfLost } from '../../../lib/focus';
import { mailDateText, mailTargetKey } from '../../../lib/mailbox';
import {
  buildMailSendInput,
  checkReply,
  contextOf,
  isReplyDirty,
  mailConfirmSummary,
  mailSendFailure,
  summarizeMailSend,
} from '../../../lib/reply';
import type { SaveNotice as SaveNoticeData } from '../../../lib/result';
import { errorText } from '../../../lib/snapshot';
import { fileLabel } from '../../../lib/tasks';
import { LastSentBadge, ReplyComposer, ReplyConfirmBody, type ReplyBinding } from '../ReplyComposer';
import { SaveNotice } from '../SaveNotice';

const NOTE_MAX = 4000;

export interface MailReplyViewProps {
  mail: MailThreadMail;
  detail: MailThreadDetail;
  message: MailMessage | null;
  reply: ReplyHook;
  today: string;
  claudeMissing: string | null;
  onBack: () => void;
  onOpenFile: (path: string) => void;
  onOpenTask: (taskId: string) => void;
  /** 보냈다(결과 알림 — 메일함 읽기 칸에 보인다) */
  onSent: (notice: SaveNoticeData) => void;
  nextNoticeId: () => number;
  /** 설정 › 메일 보내기를 연다 */
  onOpenMailSettings?: () => void;
}

export function MailReplyView(props: MailReplyViewProps): ReactElement {
  const { mail, detail, message, reply, today } = props;
  const key = mailTargetKey(mail.path);
  const state = reply.replyOf(key);
  const context = reply.contextOf(key);
  const ctx = contextOf(context);
  const [confirming, setConfirming] = useState(false);
  const [archiveAfter, setArchiveAfter] = useState(true);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<SaveNoticeData | null>(null);
  const sendRef = useRef<HTMLButtonElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  // 회신 화면은 작성 칸을 늘 편다(켜면 문맥을 다시 읽고 기본값을 채운다)
  const { toggle } = reply;
  useEffect(() => {
    if (!state.enabled) toggle(key, true);
    headingRef.current?.focus();
    // 메일이 바뀔 때만
  }, [key]);

  const note = state.note ?? '';
  const check = checkReply(state, context);
  const canSend = state.enabled && check.ok && !sending;
  const linkedTasks = detail.links.tasks;

  const binding: ReplyBinding = {
    supported: reply.supported,
    state,
    context,
    settings: reply.settings,
    today,
    draftBusy: reply.draftingId !== null,
    draftingHere: reply.draftingId === key,
    draftUnavailable: props.claudeMissing,
    onChange: (fn) => reply.update(key, fn),
    onToggle: (on) => reply.toggle(key, on),
    onReset: () => reply.reset(key),
    onLoadContext: () => reply.loadContext(key),
    onLoadSettings: reply.loadSettings,
    onSaveSettings: async (value) => {
      const problem = await reply.saveSettings(value);
      if (!problem) reply.loadContext(key);
      return problem;
    },
    onDraft: () => reply.startDraft(key, note),
    onCancelDraft: () => reply.cancelDraft(key),
    onOpenFile: props.onOpenFile,
    ...(props.onOpenMailSettings ? { onOpenSettings: props.onOpenMailSettings } : {}),
  };

  const send = async (): Promise<void> => {
    setConfirming(false);
    if (!canSend) return;
    const input = buildMailSendInput(state, mail.path, archiveAfter);
    setSending(true);
    setFailure(null);
    const id = props.nextNoticeId();
    try {
      const api = getRadar();
      if (!api) throw new Error(NO_BRIDGE_MESSAGE);
      if (typeof api.sendMailReply !== 'function') throw new Error('이 앱 연결에는 메일함 회신 기능이 없습니다. 앱을 새 버전으로 다시 빌드해 주세요.');
      const out = await api.sendMailReply(input);
      // 메일은 나갔다 — 같은 sendId 로 다시 보내지 않게 칸을 닫는다(다음에 열면 새 칸)
      reply.reset(key);
      reply.loadContext(key);
      // 상태가 바뀌었으니 요약을 다시 받는다(이벤트보다 먼저 배지·목록이 바뀌게)
      const api2 = getRadar();
      if (api2 && typeof api2.getMailbox === 'function') void api2.getMailbox().then(acceptSummary, () => undefined);
      props.onSent(summarizeMailSend(input, out, id));
    } catch (err) {
      setFailure(mailSendFailure(errorText(err), id));
      refocusIfLost(() => sendRef.current);
    } finally {
      setSending(false);
    }
  };

  const summary = confirming && ctx ? mailConfirmSummary({ state, ctx, settings: reply.settings.value, archiveAfter, linkedTasks: linkedTasks.length }) : null;
  let hint: string;
  if (sending) hint = '메일을 보내는 중입니다…';
  else if (!check.ok) hint = check.reason ?? '보낼 수 없습니다.';
  else hint = '보내기 전에 받는사람·제목·본문을 한 번 더 확인합니다. 위키에는 쓰지 않습니다.';

  const noteField = (
    <div className="field">
      <div className="field-head">
        <label htmlFor="mail-reply-note" className="field-label">
          이번에 전할 핵심
        </label>
        <span className="field-note">초안이 이 내용을 전합니다 — 비워 두면 원본 메일에 답합니다</span>
      </div>
      <textarea
        id="mail-reply-note"
        className="text-input text-area"
        rows={3}
        data-testid="mail-reply-note"
        maxLength={NOTE_MAX}
        spellCheck={false}
        disabled={sending}
        placeholder="예: 단가표는 다음 주 화요일에 보내 드린다"
        value={note}
        onChange={(e) => {
          const v = e.target.value;
          reply.update(key, (s) => ({ ...s, note: v }));
        }}
      />
    </div>
  );

  const body = message?.body ?? '';
  const excerpt = body.length > 1200 ? `${body.slice(0, 1200)}…` : body;

  return (
    <>
      <section className="mb-sub-main scroll" data-testid="mail-reply-view" aria-labelledby="mb-reply-title">
        <div className="mb-sub-head">
          <button type="button" className="link-btn" data-testid="btn-mail-back" onClick={props.onBack}>
            <IconBack size={16} />
            메일로 돌아가기
          </button>
          {ctx?.lastSent && <LastSentBadge record={ctx.lastSent} today={today} />}
        </div>
        <h1 id="mb-reply-title" className="mb-sub-title" tabIndex={-1} ref={headingRef}>
          회신 — {mail.subject || '(제목 없음)'}
        </h1>
        {linkedTasks.length > 0 && (
          <div className="mb-linked-note" data-testid="mail-reply-linked">
            <IconChecklist size={16} />
            <p>
              연결된 할 일({linkedTasks.map((t) => t.title).join(', ')})은 그대로입니다 — 끝났으면 할 일에서 완료로 저장하세요.
            </p>
            <button type="button" className="link-btn" onClick={() => props.onOpenTask(linkedTasks[0].taskId)}>
              할 일 열기
            </button>
          </div>
        )}
        {failure && <SaveNotice notice={failure} onClose={() => setFailure(null)} />}
        <form
          className="mb-reply-form"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (canSend) setConfirming(true);
          }}
        >
          <ReplyComposer reply={binding} saving={sending} noteEmpty={note.trim() === ''} holdDialogs={confirming} mode="mail" noteField={noteField} />
          <div className="result-actions">
            <button type="submit" className="btn btn--primary" data-testid="btn-send" ref={sendRef} disabled={!canSend} aria-describedby="mb-reply-hint">
              <IconSend size={16} />
              {sending ? '보내는 중…' : '보내기…'}
            </button>
            <button type="button" className="btn btn--secondary" disabled={sending} onClick={props.onBack}>
              {isReplyDirty(state) ? '적은 채로 돌아가기' : '돌아가기'}
            </button>
            <span id="mb-reply-hint" className="result-hint">
              {hint}
            </span>
          </div>
        </form>
      </section>

      <aside className="mb-sub-aside scroll" aria-label="회신 참고">
        <section className="mb-aside-section">
          <h2 className="mb-section-title">원본 메일</h2>
          <p className="mb-aside-meta">
            {mail.from} · {mailDateText(mail.date, today)}
          </p>
          <p className="mb-aside-subject">{mail.subject || '(제목 없음)'}</p>
          {excerpt && <div className="mb-body mb-body--small">{excerpt}</div>}
        </section>
        <section className="mb-aside-section">
          <h2 className="mb-section-title">사람이 확인할 것</h2>
          {state.draft.notes ? <p className="mb-aside-text">{state.draft.notes}</p> : <p className="mb-aside-empty">초안을 만들면 초안이 남긴 확인할 점이 여기에 보입니다.</p>}
        </section>
        <section className="mb-aside-section">
          <h2 className="mb-section-title">초안이 읽은 것</h2>
          {state.draft.references.length > 0 ? (
            <ul className="mb-aside-list">
              {state.draft.references.map((p) => (
                <li key={p}>
                  <button type="button" className="link-btn" title={`${p} — Obsidian에서 열기`} onClick={() => props.onOpenFile(p)}>
                    {fileLabel(p)}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mb-aside-empty">아직 없음</p>
          )}
        </section>
        <section className="mb-aside-section">
          <h2 className="mb-section-title">안전</h2>
          <p className="mb-aside-text">
            {mail.suspicious && (
              <>
                <IconAlert size={14} /> 피싱 의심 메일입니다. 받는사람 주소를 따로 확인하세요.{' '}
              </>
            )}
            보내기 전에 확인 창이 한 번 더 뜹니다. 위키에는 쓰지 않고, 발송 기록만 앱 데이터에 남깁니다.
          </p>
        </section>
      </aside>

      <ConfirmDialog
        open={confirming && summary !== null}
        testId="reply-confirm"
        confirmTestId="btn-send-confirm"
        wide
        title="이 회신을 보낼까요?"
        confirmText="보내기"
        confirmIcon={<IconSend size={16} />}
        onConfirm={() => void send()}
        onCancel={() => setConfirming(false)}
      >
        {summary && <ReplyConfirmBody summary={summary} />}
        <label className="check-card">
          <input type="checkbox" data-testid="mail-reply-archive-after" checked={archiveAfter} onChange={(e) => setArchiveAfter(e.target.checked)} />
          <span className="check-card-text">
            <span className="check-card-title">보낸 뒤 처리함으로</span>
            <span className="check-card-desc">이 스레드를 받은편지함에서 처리함으로 옮깁니다. 새 메일이 오면 다시 보입니다.</span>
          </span>
        </label>
      </ConfirmDialog>
    </>
  );
}
