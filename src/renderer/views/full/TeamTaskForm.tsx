// 팀 할 일 입력(2.9단계 명세 §4-3): 팀 위키 할 일을 고르면 처리 결과 입력(2단계) 대신 이것을 보인다.
// 상태(대기·진행 중·완료) · 담당(여럿이면 `,`, [나에게]) · 기한([기한 지우기]) · [저장]. 처리 내용(메모)·위키 지식 반영·회신은 없다 —
// 팀 할 일은 개인 위키 쓰기 규칙(할 일 메모·반영 대기)과 섞지 않는다. 입력값은 부모가 taskId 별로 들고 있다(화면을 오가도 그대로).
import { useRef, type FormEvent, type ReactElement } from 'react';
import type { Task, TeamTaskStatus } from '../../../shared/types';
import { IconCheck, IconClose, IconUser } from '../../components/Icons';
import { cls } from '../../lib/cls';
import { refocusIfLost } from '../../lib/focus';
import { teamDraftOf, teamDraftProblem, teamSaveInput, teamStatusLabel, type TeamDraft } from '../../lib/teamTasks';

const STATUS_OPTIONS: readonly TeamTaskStatus[] = ['open', 'wip', 'done'];

export interface TeamTaskFormProps {
  task: Task;
  draft: TeamDraft;
  onChange: (draft: TeamDraft) => void;
  onCancel: () => void;
  onSubmit: () => void;
  saving: boolean;
  /** 다른 할 일을 저장하는 중 */
  busy: boolean;
  /** [나에게]에 쓸 내 이름(없으면 단추를 끈다) */
  myName?: string;
  /** 담당 칸 아래 알려진 담당(datalist) */
  knownOwners: readonly string[];
}

export function TeamTaskForm({ task, draft, onChange, onCancel, onSubmit, saving, busy, myName, knownOwners }: TeamTaskFormProps): ReactElement {
  const formRef = useRef<HTMLFormElement>(null);
  const now = teamDraftOf(task);
  const changed = teamSaveInput(task, draft) !== null;
  const problem = teamDraftProblem(draft);
  const canSave = changed && !problem && !saving && !busy;
  const set = (patch: Partial<TeamDraft>): void => onChange({ ...draft, ...patch });

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (canSave) onSubmit();
  };
  const cancel = (): void => {
    onCancel();
    refocusIfLost(() => formRef.current?.querySelector<HTMLInputElement>('input[name="team-status"]:checked'));
  };

  let hint: string;
  if (saving) hint = '팀 위키에 저장하는 중입니다…';
  else if (busy) hint = '다른 할 일을 저장하는 중입니다. 끝나면 저장할 수 있습니다.';
  else if (!changed) hint = '상태·담당·기한을 바꾸면 저장할 수 있습니다.';
  else if (draft.status === 'done') hint = '저장하면 팀 위키의 그 줄을 완료로 바꾸고 목록에서 뺍니다.';
  else hint = '저장하면 팀 위키 사본의 그 줄에 바로 쓰고, 동기화가 NAS 로 올립니다.';

  return (
    <form ref={formRef} className="panel result-form team-form" aria-labelledby="team-form-title" aria-busy={saving} onSubmit={submit} noValidate>
      <div className="result-form-head">
        <h2 id="team-form-title" className="result-form-title">
          팀 할 일 입력
        </h2>
      </div>

      <fieldset className="result-fieldset">
        <legend className="field-label result-legend">상태</legend>
        <div className="radio-cards">
          {STATUS_OPTIONS.map((value) => (
            <label key={value} className={cls('radio-card', draft.status === value && 'is-checked')}>
              <input
                type="radio"
                name="team-status"
                value={value}
                checked={draft.status === value}
                data-testid={`team-form-status-${value}`}
                onChange={() => set({ status: value })}
              />
              <span>{teamStatusLabel(value)}</span>
              {value === now.status && (
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
        <label htmlFor="team-form-owner" className="field-label">
          담당
        </label>
        <div className="team-form-row">
          <input
            id="team-form-owner"
            className="text-input"
            type="text"
            data-testid="team-form-owner"
            list="team-form-owners"
            maxLength={600}
            autoComplete="off"
            spellCheck={false}
            placeholder="비우면 미배정. 여럿이면 쉼표로(홍길동, 김철수)"
            value={draft.owners}
            disabled={saving}
            aria-describedby="team-form-owner-note"
            onChange={(e) => set({ owners: e.target.value })}
          />
          <button
            type="button"
            className="btn btn--secondary"
            data-testid="team-form-me"
            disabled={!myName || saving}
            title={myName ? `담당을 ${myName}(으)로 바꿉니다` : '설정 › 나에서 이름을 정하세요'}
            onClick={() => myName && set({ owners: myName })}
          >
            <IconUser size={16} />
            나에게
          </button>
        </div>
        <datalist id="team-form-owners">
          {knownOwners.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
        <p id="team-form-owner-note" className="field-note">
          팀 위키 줄의 <code>[owner:: …]</code> 에 적습니다. 내가 아닌 사람으로 바꾸면 내 할 일 목록에서 빠집니다(팀 전체에는 남습니다).
        </p>
      </div>

      <div className="field">
        <label htmlFor="team-form-due" className="field-label">
          기한
        </label>
        <div className="team-form-row">
          <input
            id="team-form-due"
            className="text-input team-form-date"
            type="date"
            data-testid="team-form-due"
            value={draft.due}
            disabled={saving}
            onChange={(e) => set({ due: e.target.value })}
          />
          <button
            type="button"
            className="btn btn--secondary"
            data-testid="team-form-due-clear"
            disabled={draft.due === '' || saving}
            onClick={() => set({ due: '' })}
          >
            <IconClose size={16} />
            기한 지우기
          </button>
        </div>
      </div>

      {problem && (
        <p className="form-problem" role="alert">
          {problem}
        </p>
      )}

      <div className="result-actions">
        <button type="submit" className="btn btn--primary" data-testid="team-form-save" disabled={!canSave} aria-describedby="team-form-hint">
          <IconCheck size={16} />
          {saving ? '저장 중…' : '저장'}
        </button>
        <button type="button" className="btn btn--secondary" disabled={!changed || saving} onClick={cancel}>
          취소
        </button>
        <span id="team-form-hint" className="result-hint">
          {hint}
        </span>
      </div>
    </form>
  );
}
