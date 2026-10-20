// 설정 칸의 필드 하나(2.13단계 명세 §C-0·§B-5): 라벨 · 입력 · 출처 글(환경 변수 잠금 / 팀 기본값 / 내장 기본값 / .env) · [팀 기본값으로].
// 출처가 팀 기본값이면 점선 테두리(.sv-field.is-team, data-source="team"), 환경 변수면 입력을 잠근다(data-locked="env").
import type { ReactElement, ReactNode } from 'react';
import type { SectionHook } from '../../../hooks/useSettingsSection';
import { cls } from '../../../lib/cls';
import { FEATURES } from '../../../../shared/edition';
import type { TeamDefaultsSummary } from '../../../../shared/types';
import { isResetDraft, sourceText, teamHeadText } from '../../../lib/settings';

export interface SettingsFieldProps {
  hook: SectionHook;
  field: string;
  label: string;
  /** 입력 꼴(기본 text) */
  type?: 'text' | 'number' | 'date';
  placeholder?: string;
  /** 필드 아래 작은 안내 */
  note?: ReactNode;
  /** 입력 대신 그릴 것(고르기 등) — 없으면 글 입력 */
  children?: (p: { id: string; disabled: boolean; describedBy: string }) => ReactElement;
  /** 입력 옆 단추(폴더 고르기 등) */
  aside?: ReactNode;
  disabled?: boolean;
  /** 넓은 칸(경로·주소) */
  wide?: boolean;
}

export function SettingsField({ hook, field, label, type = 'text', placeholder, note, children, aside, disabled, wide }: SettingsFieldProps): ReactElement {
  const f = hook.view?.fields[field];
  const source = hook.source(field);
  const locked = hook.locked(field);
  const id = `sv-${hook.section}-${field}`;
  const srcId = `${id}-source`;
  const problem = hook.problems[field];
  const off = !!disabled || locked || hook.saving;
  const srcText = source === 'user' ? '' : sourceText(source, f?.envName);
  // 내 값이 있거나 초안에서 고쳤으면 [팀 기본값으로](팀 값이 없으면 「기본값으로」)
  const canReset =
    !locked && !isResetDraft(hook.draft, field) && (f?.userValue !== undefined || (field in hook.draft && hook.draft[field] !== null));
  const describedBy = [srcText ? srcId : '', problem ? `${id}-problem` : ''].filter(Boolean).join(' ');
  return (
    <div
      className={cls('field', 'sv-field', source === 'team' && 'is-team', locked && 'is-locked', wide && 'sv-field--wide')}
      data-testid={`sv-field-${field}`}
      data-source={source}
      data-locked={locked ? 'env' : undefined}
    >
      <label htmlFor={id} className="field-label">
        {label}
      </label>
      <div className="sv-field-row">
        {children ? (
          children({ id, disabled: off, describedBy })
        ) : (
          <input
            id={id}
            className={cls('text-input', 'sv-input', type === 'number' && 'sv-input--num')}
            data-testid={`sv-input-${field}`}
            type={type === 'number' ? 'text' : type}
            inputMode={type === 'number' ? 'numeric' : undefined}
            value={hook.text(field)}
            placeholder={placeholder}
            spellCheck={false}
            autoComplete="off"
            disabled={off}
            aria-invalid={problem ? true : undefined}
            aria-describedby={describedBy || undefined}
            onChange={(e) => hook.set(field, e.target.value)}
          />
        )}
        {aside}
      </div>
      {(srcText || canReset) && (
        <p className="sv-source" id={srcId} data-testid={`sv-source-${field}`}>
          {srcText && <span>{srcText}</span>}
          {canReset && (
            <button type="button" className="link-btn sv-reset" data-testid={`sv-reset-${field}`} disabled={hook.saving} onClick={() => hook.reset(field)}>
              {f?.teamValue !== undefined ? '팀 기본값으로' : '기본값으로'}
            </button>
          )}
        </p>
      )}
      {problem && (
        <p className="form-problem" id={`${id}-problem`} role="alert">
          {problem}
        </p>
      )}
      {f?.problem && <p className="field-note sv-warn">{f.problem}</p>}
      {note && <p className="field-note">{note}</p>}
    </div>
  );
}

/** 켬/끔 필드(체크 카드) */
export function SettingsCheck({
  hook,
  field,
  title,
  desc,
  disabled,
}: {
  hook: SectionHook;
  field: string;
  title: string;
  desc?: ReactNode;
  disabled?: boolean;
}): ReactElement {
  const f = hook.view?.fields[field];
  const source = hook.source(field);
  const locked = hook.locked(field);
  const id = `sv-${hook.section}-${field}`;
  const srcText = source === 'env' || source === 'team' ? sourceText(source, f?.envName) : '';
  return (
    <div
      className={cls('sv-field', 'sv-field--check', source === 'team' && 'is-team')}
      data-testid={`sv-field-${field}`}
      data-source={source}
      data-locked={locked ? 'env' : undefined}
    >
      <label className="check-card">
        <input
          type="checkbox"
          id={id}
          data-testid={`sv-input-${field}`}
          checked={hook.bool(field)}
          disabled={!!disabled || locked || hook.saving}
          aria-labelledby={`${id}-title`}
          aria-describedby={desc ? `${id}-desc` : undefined}
          onChange={(e) => hook.set(field, e.target.checked)}
        />
        <span className="check-card-text">
          <span id={`${id}-title`} className="check-card-title">
            {title}
          </span>
          {desc && (
            <span id={`${id}-desc`} className="check-card-desc">
              {desc}
            </span>
          )}
        </span>
      </label>
      {srcText && <p className="sv-source">{srcText}</p>}
    </div>
  );
}

/** 칸 머리(팀 기본값 출처 한 줄 + 문제). noTeam = 팀 기본값을 받지 않는 칸(AI — 소유자 결정 2026-10-19) */
export function SectionHead({ hook, lead, noTeam }: { hook: SectionHook; lead?: ReactNode; noTeam?: boolean }): ReactElement {
  const team = hook.view?.team;
  return (
    <>
      {lead && <p className="qv-lead">{lead}</p>}
      {hook.loadError && (
        <p className="form-problem" role="alert">
          설정을 불러오지 못했습니다. ({hook.loadError})
        </p>
      )}
      {/* 공개판은 팀 위키(팀 기본값)가 없다(src/shared/edition.ts) */}
      {team && !noTeam && FEATURES.teamWiki && <TeamLine team={team} />}
    </>
  );
}

export function TeamLine({ team }: { team: TeamDefaultsSummary }): ReactElement {
  return (
    <div className="sv-team" data-testid="sv-team" data-source={team.source}>
      <p className="sv-team-line">{teamHeadText(team)}</p>
      {team.problems.length > 0 && (
        <p className="sv-team-problem" data-testid="sv-team-problem">
          {team.problems[0]}
          {team.problems.length > 1 ? ` 외 ${team.problems.length - 1}건` : ''}
        </p>
      )}
    </div>
  );
}

/** 칸 아래 안내 줄 */
export function SectionNotes({ notes }: { notes: readonly string[] }): ReactElement | null {
  if (!notes.length) return null;
  return (
    <ul className="sv-notes" data-testid="sv-notes">
      {notes.map((n) => (
        <li key={n}>{n}</li>
      ))}
    </ul>
  );
}
