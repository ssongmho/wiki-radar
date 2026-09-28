// 처리 결과 입력(시안 A-Full, 2단계 명세 §3): 상태 4개 · 넘길 담당자 · 처리 내용 · 위키 지식에도 반영 · [저장] [취소].
// 입력값은 부모(FullView)가 taskId 별 초안으로 들고 있다 — 스냅샷이 바뀌거나 다른 항목을 보고 와도 남는다.
import { useRef, type FormEvent, type ReactElement } from 'react';
import type { Task, TaskStatus } from '../../../shared/types';
import { cls } from '../../lib/cls';
import { refocusIfLost } from '../../lib/focus';
import {
  DEFAULT_OWNER,
  NOTE_MAX,
  OWNER_MAX,
  STATUS_OPTIONS,
  draftProblem,
  hasChange,
  isDirty,
  leavesList,
  type ResultDraft,
} from '../../lib/result';

export interface ResultFormProps {
  task: Task;
  draft: ResultDraft;
  onChange: (draft: ResultDraft) => void;
  onCancel: () => void;
  onSubmit: () => void;
  /** 이 항목을 저장하는 중 */
  saving: boolean;
  /** 다른 항목을 저장하는 중(끝날 때까지 저장을 막는다) */
  busy: boolean;
}

export function ResultForm({ task, draft, onChange, onCancel, onSubmit, saving, busy }: ResultFormProps): ReactElement {
  const problem = draftProblem(draft);
  const changed = hasChange(task, draft);
  const dirty = isDirty(task, draft);
  const canSave = changed && !problem && !saving && !busy;
  const notMine = draft.status === 'notmine';

  const formRef = useRef<HTMLFormElement>(null);
  const set = (patch: Partial<ResultDraft>): void => onChange({ ...draft, ...patch });
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (canSave) onSubmit();
  };
  // [취소]는 되돌린 뒤 비활성이 되어 초점이 떨어진다 — 되돌린 상태 라디오로 옮긴다
  const cancel = (): void => {
    onCancel();
    refocusIfLost(() => formRef.current?.querySelector<HTMLInputElement>('input[name="result-status"]:checked'));
  };

  let hint: string;
  if (saving) hint = '위키에 저장하는 중입니다…';
  else if (busy) hint = '다른 할 일을 저장하는 중입니다. 끝나면 저장할 수 있습니다.';
  else if (!changed) hint = '상태를 바꾸거나 처리 내용을 적으면 저장할 수 있습니다.';
  else if (leavesList(draft.status)) hint = '저장하면 목록에서 빠지고 다음 할 일로 넘어갑니다.';
  else hint = '저장하면 할 일 체크와 메모가 위키에 바로 기록됩니다.';

  return (
    <form
      ref={formRef}
      className="panel result-form"
      aria-labelledby="result-form-title"
      aria-busy={saving}
      onSubmit={submit}
      noValidate
    >
      <h2 id="result-form-title" className="result-form-title">
        처리 결과 입력
      </h2>

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
          maxLength={NOTE_MAX}
          spellCheck={false}
          placeholder="무엇을 했는지 적으면 ‘할 일 메모’에 날짜와 함께 남습니다."
          value={draft.note}
          onChange={(e) => set({ note: e.target.value })}
        />
      </div>

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
        <button type="submit" className="btn btn--primary" data-testid="btn-save" disabled={!canSave} aria-describedby="result-hint">
          {saving ? '저장 중…' : '저장'}
        </button>
        <button type="button" className="btn btn--secondary" disabled={!dirty || saving} onClick={cancel}>
          취소
        </button>
        <span id="result-hint" className="result-hint">
          {hint}
        </span>
      </div>
    </form>
  );
}
