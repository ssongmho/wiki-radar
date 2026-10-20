// [할 일로](2.10단계 명세 §7-3·§8-3) — 읽기 칸 안 작은 칸: 제목 · 우선순위 · 기한 · [만들기].
// main 이 `내 할 일.md` 「메일 회신 대기」 절 끝에 open_loops cmd_add 형식 줄 하나를 넣는다(같은 메일·스레드 줄이 있거나 절이 없으면 거부).
import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { CreateMailTaskOutput } from '../../../../shared/types';
import { IconChecklist } from '../../../components/Icons';
import { MAIL_TASK_TITLE_MAX, mailTaskProblem, mailTaskTitle } from '../../../lib/mailbox';

export interface MailTaskFormProps {
  path: string;
  subject: string;
  /** 만들기(main 에 보낸다). 실패하면 던진다 */
  onCreate: (input: { path: string; title: string; pri?: number; due?: string }) => Promise<CreateMailTaskOutput>;
  onDone: (out: CreateMailTaskOutput, title: string) => void;
  onFail: (message: string) => void;
  onCancel: () => void;
  /** 로컬 LLM 할 일 후보(2.16) — 제목·기한을 미리 채운다 */
  suggest?: { title: string; due?: string };
}

export function MailTaskForm({ path, subject, onCreate, onDone, onFail, onCancel, suggest }: MailTaskFormProps): ReactElement {
  const [title, setTitle] = useState(() => (suggest?.title ? suggest.title : mailTaskTitle(subject)));
  const [pri, setPri] = useState('');
  const [due, setDue] = useState(suggest?.due ?? '');
  const [busy, setBusy] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    titleRef.current?.focus();
    titleRef.current?.select();
  }, []);
  const problem = mailTaskProblem({ title, pri, due });

  const submit = async (): Promise<void> => {
    if (problem || busy) return;
    setBusy(true);
    try {
      const out = await onCreate({
        path,
        title: title.trim(),
        ...(pri ? { pri: Number(pri) } : {}),
        ...(due ? { due } : {}),
      });
      onDone(out, title.trim());
    } catch (err) {
      onFail(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="mb-task-form"
      data-testid="mail-task-form"
      aria-labelledby="mb-task-title"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <h2 id="mb-task-title" className="mb-section-title">
        할 일로 — 내 할 일 「메일 회신 대기」에 줄 하나
      </h2>
      <div className="mb-task-grid">
        <div className="field mb-task-title-field">
          <label htmlFor="mail-task-title" className="field-label">
            제목
          </label>
          <input
            id="mail-task-title"
            ref={titleRef}
            className="text-input"
            data-testid="mail-task-title"
            maxLength={MAIL_TASK_TITLE_MAX}
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="mail-task-pri" className="field-label">
            우선순위
          </label>
          <select id="mail-task-pri" className="text-input" data-testid="mail-task-pri" disabled={busy} value={pri} onChange={(e) => setPri(e.target.value)}>
            <option value="">없음</option>
            <option value="1">1</option>
            <option value="2">2</option>
            <option value="3">3</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="mail-task-due" className="field-label">
            기한
          </label>
          <input
            id="mail-task-due"
            type="date"
            className="text-input"
            data-testid="mail-task-due"
            disabled={busy}
            value={due}
            onChange={(e) => setDue(e.target.value)}
          />
        </div>
      </div>
      {problem && title !== '' && (
        <p className="form-problem" role="alert">
          {problem}
        </p>
      )}
      <div className="result-actions">
        <button type="submit" className="btn btn--primary" data-testid="btn-mail-task-create" disabled={!!problem || busy}>
          <IconChecklist size={16} />
          {busy ? '넣는 중…' : '만들기'}
        </button>
        <button type="button" className="btn btn--secondary" disabled={busy} onClick={onCancel}>
          취소
        </button>
        <span className="result-hint">메일 경로·스레드·받은 날짜를 줄에 함께 적습니다. 쓰기 전에 백업합니다.</span>
      </div>
    </form>
  );
}
