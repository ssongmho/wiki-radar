// 비밀 필드(2.13단계 명세 §C-0): 값은 받지도 보이지도 않는다 — "저장됨"/"없음" + [바꾸기](type=password 입력이 열림) + [지우기].
// 환경 변수로 정해졌으면 잠근다. 저장 전 초안만 바꾸고 [저장]으로 확정한다.
import { useRef, type ReactElement } from 'react';
import type { SecretKey } from '../../../../shared/types';
import { IconClose, IconLock, IconPen } from '../../../components/Icons';
import type { SectionHook } from '../../../hooks/useSettingsSection';
import { KEEP_SECRET, secretText } from '../../../lib/settings';

export function SecretField({ hook, secretKey, label }: { hook: SectionHook; secretKey: SecretKey; label: string }): ReactElement {
  const view = hook.view?.secrets[secretKey];
  const draft = hook.secret;
  const locked = view?.source === 'env';
  const inputRef = useRef<HTMLInputElement>(null);
  const id = `sv-secret-${secretKey.replace('.', '-')}`;
  const problem = hook.problems.secret;
  return (
    <div
      className="field sv-field sv-secret"
      data-testid="sv-secret"
      data-key={secretKey}
      data-saved={view?.saved ? 'true' : 'false'}
      data-source={view?.source ?? 'none'}
      data-locked={locked ? 'env' : undefined}
    >
      <label htmlFor={draft.action === 'set' ? id : undefined} className="field-label">
        {label}
      </label>
      <div className="sv-field-row">
        <span className="sv-secret-state" data-testid="sv-secret-state">
          <IconLock size={14} />
          {secretText(view, draft)}
        </span>
        {!locked && draft.action !== 'set' && (
          <button
            type="button"
            className="btn btn--secondary"
            data-testid="sv-secret-change"
            disabled={hook.saving}
            onClick={() => {
              hook.setSecret({ action: 'set', value: '' });
              setTimeout(() => inputRef.current?.focus(), 0);
            }}
          >
            <IconPen size={16} />
            {view?.saved ? '바꾸기' : '넣기'}
          </button>
        )}
        {!locked && view?.saved && draft.action === 'keep' && (
          <button
            type="button"
            className="btn btn--secondary"
            data-testid="sv-secret-clear"
            disabled={hook.saving}
            onClick={() => hook.setSecret({ action: 'clear', value: '' })}
          >
            <IconClose size={16} />
            지우기
          </button>
        )}
        {draft.action !== 'keep' && (
          <button type="button" className="link-btn" data-testid="sv-secret-cancel" disabled={hook.saving} onClick={() => hook.setSecret(KEEP_SECRET)}>
            그대로 두기
          </button>
        )}
      </div>
      {draft.action === 'set' && (
        <input
          id={id}
          ref={inputRef}
          className="text-input sv-input"
          type="password"
          autoComplete="off"
          spellCheck={false}
          data-testid="sv-secret-input"
          value={draft.value}
          disabled={hook.saving}
          aria-invalid={problem ? true : undefined}
          onChange={(e) => hook.setSecret({ action: 'set', value: e.target.value })}
        />
      )}
      {problem && (
        <p className="form-problem" role="alert">
          {problem}
        </p>
      )}
      {!locked && <p className="field-note">이 PC 에 암호화해 둡니다 — 설정 파일·로그·화면에는 남지 않습니다.</p>}
    </div>
  );
}
