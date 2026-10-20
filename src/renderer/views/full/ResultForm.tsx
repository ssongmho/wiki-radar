// 처리 결과 입력(시안 A-Full, 2단계 명세 §3): 상태 4개 · 넘길 담당자 · 처리 내용 · 위키 지식에도 반영 · [저장] [취소].
// 메일 할 일이면 처리 내용 아래에 '회신 메일 보내기'(2.5단계 명세 §7)가 붙는다. 켜면 제출 버튼이 [보내고 저장]이 되고,
// 확인 대화상자(reply-confirm)의 [보내기]로만 메일이 나간다 — 상태를 안 바꾸고 처리 내용이 없어도 보낼 수 있다(발송 자체가 변화다).
// 입력값은 부모(FullView)가 taskId 별 초안으로 들고 있다 — 스냅샷이 바뀌거나 다른 항목을 보고 와도 남는다.
import { useRef, useState, type FormEvent, type ReactElement } from 'react';
import type { Task, TaskStatus } from '../../../shared/types';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { IconSend } from '../../components/Icons';
import { cls } from '../../lib/cls';
import { refocusIfLost } from '../../lib/focus';
import { checkReply, confirmSummary, contextOf, isReplyDirty } from '../../lib/reply';
import {
  DEFAULT_OWNER,
  OWNER_MAX,
  STATUS_OPTIONS,
  buildSaveInput,
  draftProblem,
  hasChange,
  isDirty,
  josaRo,
  leavesList,
  noteInputMax,
  statusLabel,
  type ResultDraft,
} from '../../lib/result';
import { LastSentBadge, ReplyComposer, ReplyConfirmBody, type ReplyBinding } from './ReplyComposer';

export interface ResultFormProps {
  task: Task;
  draft: ResultDraft;
  onChange: (draft: ResultDraft) => void;
  onCancel: () => void;
  onSubmit: () => void;
  /** 이 항목을 저장하는(회신이면 보내고 저장하는) 중 */
  saving: boolean;
  /** 다른 항목을 저장하는 중(끝날 때까지 저장을 막는다) */
  busy: boolean;
  /** 메일 할 일의 회신 작성 칸(없으면 그리지 않는다) */
  reply?: ReplyBinding;
  /** 확인 대화상자에서 [보내기]를 눌렀다 */
  onSend?: () => void;
}

export function ResultForm({ task, draft, onChange, onCancel, onSubmit, saving, busy, reply, onSend }: ResultFormProps): ReactElement {
  const problem = draftProblem(draft);
  const changed = hasChange(task, draft);
  const replyOn = !!reply && reply.state.enabled;
  const replyCheck = reply && replyOn ? checkReply(reply.state, reply.context) : null;
  const dirty = isDirty(task, draft) || (!!reply && isReplyDirty(reply.state));
  const canSave = changed && !problem && !saving && !busy;
  const canSend = replyOn && !!replyCheck?.ok && !problem && !saving && !busy;
  const notMine = draft.status === 'notmine';
  const [confirming, setConfirming] = useState<'send' | 'discard' | null>(null);

  const formRef = useRef<HTMLFormElement>(null);
  const set = (patch: Partial<ResultDraft>): void => onChange({ ...draft, ...patch });
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (replyOn) {
      if (canSend) setConfirming('send');
    } else if (canSave) onSubmit();
  };
  const send = (): void => {
    setConfirming(null);
    if (canSend) onSend?.();
  };
  // [취소]는 되돌린 뒤 비활성이 되어 초점이 떨어진다 — 되돌린 상태 라디오로 옮긴다
  const revert = (): void => {
    setConfirming(null);
    onCancel();
    reply?.onReset();
    refocusIfLost(() => formRef.current?.querySelector<HTMLInputElement>('input[name="result-status"]:checked'));
  };
  // 회신 본문(받은 초안 포함)은 다시 쓰기 번거로우므로 버리기 전에 묻는다
  const cancel = (): void => {
    if (reply && (reply.state.body.trim() !== '' || reply.state.pendingDraft)) setConfirming('discard');
    else revert();
  };

  const label = statusLabel(draft.status);
  let hint: string;
  if (replyOn) {
    if (saving) hint = '메일을 보내고 위키에 저장하는 중입니다…';
    else if (busy) hint = '다른 할 일을 저장하는 중입니다. 끝나면 보낼 수 있습니다.';
    else if (replyCheck && !replyCheck.ok) hint = replyCheck.reason ?? '보낼 수 없습니다.';
    else if (problem) hint = '처리 결과 입력의 문제를 고치면 보낼 수 있습니다.';
    else if (leavesList(draft.status)) hint = `보내기 전에 한 번 더 확인합니다. 보낸 뒤 ‘${label}’${josaRo(label)} 저장하고 목록에서 뺍니다.`;
    else hint = '보내기 전에 받는사람·제목·본문을 한 번 더 확인합니다. 보낸 뒤 처리 결과를 저장합니다.';
  } else if (saving) hint = '위키에 저장하는 중입니다…';
  else if (busy) hint = '다른 할 일을 저장하는 중입니다. 끝나면 저장할 수 있습니다.';
  else if (!changed) hint = '상태를 바꾸거나 처리 내용을 적으면 저장할 수 있습니다.';
  else if (leavesList(draft.status)) hint = '저장하면 목록에서 빠지고 다음 할 일로 넘어갑니다.';
  else hint = '저장하면 할 일 체크와 메모가 위키에 바로 기록됩니다.';

  const ctx = reply ? contextOf(reply.context) : undefined;
  const lastSent = ctx?.lastSent;
  const summary =
    confirming === 'send' && reply && ctx
      ? confirmSummary({ task, state: reply.state, ctx, settings: reply.settings.value, save: buildSaveInput(task, draft) })
      : null;

  return (
    <form
      ref={formRef}
      className="panel result-form"
      aria-labelledby="result-form-title"
      aria-busy={saving}
      onSubmit={submit}
      noValidate
    >
      <div className="result-form-head">
        <h2 id="result-form-title" className="result-form-title">
          처리 결과 입력
        </h2>
        {lastSent && reply && <LastSentBadge record={lastSent} today={reply.today} />}
      </div>

      <fieldset className="result-fieldset">
        <legend className="field-label result-legend">상태</legend>
        <div className="radio-cards">
          {STATUS_OPTIONS.map((opt) => (
            <label key={opt.value} className={cls('radio-card', draft.status === opt.value && 'is-checked')}>
              <input
                type="radio"
                name="result-status"
                value={opt.value}
                checked={draft.status === opt.value}
                data-testid={`form-status-${opt.value}`}
                onChange={() => set({ status: opt.value as TaskStatus })}
              />
              <span>{opt.label}</span>
              {opt.value === task.status && (
                <>
                  <span className="radio-card-now" aria-hidden="true">
                    지금
                  </span>
                  <span className="sr-only">, 지금 상태</span>
                </>
              )}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="field">
        <label htmlFor="result-owner" className="field-label">
          넘길 담당자
        </label>
        <input
          id="result-owner"
          className="text-input"
          type="text"
          data-testid="form-owner"
          disabled={!notMine}
          maxLength={OWNER_MAX}
          autoComplete="off"
          spellCheck={false}
          placeholder={notMine ? `비워 두면 ‘${DEFAULT_OWNER}’로 적습니다` : '내 일 아님을 고르면 입력합니다'}
          value={draft.owner}
          aria-describedby={problem && notMine ? 'result-problem' : undefined}
          onChange={(e) => set({ owner: e.target.value })}
        />
      </div>

      <div className="field">
        <label htmlFor="result-note" className="field-label">
          처리 내용
        </label>
        <textarea
          id="result-note"
          className="text-input text-area"
          rows={4}
          data-testid="form-note"
          maxLength={noteInputMax(draft)}
          spellCheck={false}
          placeholder={
            reply
              ? '무엇을 했는지 적으면 ‘할 일 메모’에 날짜와 함께 남습니다. 회신 초안도 이 내용을 전합니다.'
              : '무엇을 했는지 적으면 ‘할 일 메모’에 날짜와 함께 남습니다.'
          }
          value={draft.note}
          onChange={(e) => set({ note: e.target.value })}
        />
      </div>

      {reply && (
        <ReplyComposer reply={reply} saving={saving} noteEmpty={draft.note.trim() === ''} holdDialogs={confirming !== null} />
      )}

      <label className="check-card">
        <input
          type="checkbox"
          data-testid="form-reflect"
          checked={draft.reflect}
          aria-labelledby="result-reflect-title"
          aria-describedby="result-reflect-desc"
          onChange={(e) => set({ reflect: e.target.checked })}
        />
        <span className="check-card-text">
          <span id="result-reflect-title" className="check-card-title">
            위키 지식에도 반영
          </span>
          <span id="result-reflect-desc" className="check-card-desc">
            업체 페이지와 로그에 반영할 대기열에 넣습니다. [위키에 반영]을 누를 때 Claude가 처리합니다.
          </span>
        </span>
      </label>

      {problem && (
        <p id="result-problem" className="form-problem" role="alert">
          {problem}
        </p>
      )}

      <div className="result-actions">
        {replyOn ? (
          <button type="submit" className="btn btn--primary" data-testid="btn-send" disabled={!canSend} aria-describedby="result-hint">
            <IconSend size={16} />
            {saving ? '보내는 중…' : '보내고 저장'}
          </button>
        ) : (
          <button type="submit" className="btn btn--primary" data-testid="btn-save" disabled={!canSave} aria-describedby="result-hint">
            {saving ? '저장 중…' : '저장'}
          </button>
        )}
        <button type="button" className="btn btn--secondary" disabled={!dirty || saving} onClick={cancel}>
          취소
        </button>
        <span id="result-hint" className="result-hint">
          {hint}
        </span>
      </div>

      <ConfirmDialog
        open={confirming === 'send' && summary !== null}
        testId="reply-confirm"
        confirmTestId="btn-send-confirm"
        wide
        title="이 회신을 보낼까요?"
        confirmText="보내기"
        confirmIcon={<IconSend size={16} />}
        onConfirm={send}
        onCancel={() => setConfirming(null)}
      >
        {summary && <ReplyConfirmBody summary={summary} />}
      </ConfirmDialog>

      <ConfirmDialog
        open={confirming === 'discard'}
        title="입력을 되돌릴까요?"
        confirmText="되돌리기"
        cancelText="계속 쓰기"
        onConfirm={revert}
        onCancel={() => setConfirming(null)}
      >
        <p>
          처리 결과 입력과 <strong>회신 작성 칸(받는사람·제목·본문)</strong>을 처음 상태로 되돌립니다. 적은 본문과 받은 초안은 사라집니다.
        </p>
      </ConfirmDialog>
    </form>
  );
}
