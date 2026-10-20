// 설정 › 나(2.9단계 명세 §4-4): 팀 위키 담당과 비교할 내 이름·다른 표기.
// 이름을 비우면 VOC 로그인 이름을 쓴다. 입력하는 동안 팀 위키 할 일 중 내 것으로 잡히는 수를 바로 센다(같은 normName 규칙 — src/shared/team.ts).
import { useState, type ReactElement } from 'react';
import { IconCheck, IconRefresh } from '../../../components/Icons';
import { LoadingState } from '../../../components/StateMessage';
import type { MeHook } from '../../../hooks/useMe';
import { meDraftChanged, meDraftOf, meDraftProblem, mePreview, meSettingsOf, vocNameNote, type MeDraft } from '../../../lib/me';

export interface MeSettingsProps {
  me: MeHook;
  /** 열린 팀 위키 할 일마다의 담당 목록(모르면 null — 팀 할 일 읽기가 아직 없거나 읽기 전) */
  teamOwners: readonly (readonly string[])[] | null;
  /** 팀 위키 동기화가 켜졌는가(모르면 null) */
  teamSyncOn: boolean | null;
  notify: (message: string) => void;
  panelId: string;
  tabId: string;
}

export function MeSettings({ me, teamOwners, teamSyncOn, notify, panelId, tabId }: MeSettingsProps): ReactElement {
  // 사람이 고치기 전에는 null — 저장된 값(또는 다시 읽은 값)을 그대로 보인다
  const [edit, setEdit] = useState<MeDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const { info } = me;

  const body = (): ReactElement => {
    if (!me.supported) {
      return <p className="qv-lead">이 앱 연결에는 설정 › 나 기능이 없습니다. 앱을 새 버전으로 다시 빌드해 주세요.</p>;
    }
    if (!info) return me.error ? <></> : <LoadingState text="나 설정을 읽는 중입니다…" />;
    const draft = edit ?? meDraftOf(info.settings);
    const changed = meDraftChanged(info.settings, draft);
    const problem = meDraftProblem(draft);
    const preview = mePreview(draft, info.vocName, teamOwners, teamSyncOn);
    const set = (patch: Partial<MeDraft>): void => setEdit({ ...draft, ...patch });

    const save = async (): Promise<void> => {
      if (saving || !changed || problem) return;
      setSaving(true);
      const ok = await me.save(meSettingsOf(draft));
      setSaving(false);
      if (ok) {
        setEdit(null);
        notify('나 설정을 저장했습니다.');
      }
    };

    return (
      <form
        className="sv-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="field">
          <label htmlFor="me-name" className="field-label">
            이름
          </label>
          <input
            id="me-name"
            className="text-input sv-input"
            data-testid="me-name"
            value={draft.name}
            placeholder={info.vocName ?? '홍길동'}
            maxLength={80}
            spellCheck={false}
            autoComplete="off"
            disabled={saving}
            aria-describedby="me-name-note"
            onChange={(e) => set({ name: e.target.value })}
          />
          <p id="me-name-note" className="field-note" data-testid="me-voc-name">
            {vocNameNote(info.vocName)}
          </p>
        </div>
        <div className="field">
          <label htmlFor="me-aliases" className="field-label">
            다른 표기
          </label>
          <input
            id="me-aliases"
            className="text-input sv-input"
            data-testid="me-aliases"
            value={draft.aliases}
            placeholder="길동, hong"
            maxLength={600}
            spellCheck={false}
            autoComplete="off"
            disabled={saving}
            aria-describedby="me-aliases-note"
            onChange={(e) => set({ aliases: e.target.value })}
          />
          <p id="me-aliases-note" className="field-note">
            팀 위키 담당에 내 이름이 다르게 적힐 때(예: 길동, hong). 쉼표로 나누고 10개까지. 대소문자와 공백은 보지 않습니다.
          </p>
        </div>

        <p
          className="sv-preview"
          data-testid="me-preview"
          data-mine={preview.note ? undefined : preview.mine}
          data-total={preview.note ? undefined : preview.total}
          aria-live="polite"
        >
          {preview.note ?? (
            <>
              지금 내 것으로 잡히는 팀 위키 할 일 <strong>{preview.mine}건</strong>(팀 전체 {preview.total}건)
            </>
          )}
          <span className="sv-preview-names">
            {preview.names.length > 0 ? `나의 이름: ${preview.names.join(', ')}` : '나의 이름이 없어 팀 위키 할 일 중 내 것이 없습니다'}
          </span>
        </p>

        {problem && changed && (
          <p className="form-problem" role="alert" data-testid="me-problem">
            {problem}
          </p>
        )}
        {me.error && (
          <p className="form-problem" role="alert">
            {me.error}
          </p>
        )}

        <div className="qv-actions">
          <button type="submit" className="btn btn--primary" data-testid="me-save" disabled={saving || !changed || !!problem}>
            <IconCheck size={16} />
            {saving ? '저장하는 중…' : '저장'}
          </button>
          <button
            type="button"
            className="btn btn--secondary"
            data-testid="me-revert"
            disabled={saving || !changed}
            onClick={() => setEdit(null)}
          >
            <IconRefresh size={16} />
            되돌리기
          </button>
          <span className="result-hint">저장하면 다시 시작하지 않아도 바로 적용됩니다.</span>
        </div>
      </form>
    );
  };

  return (
    <section className="sv-panel" role="tabpanel" id={panelId} aria-labelledby={tabId} data-testid="settings-me">
      <p className="qv-lead">
        팀 위키 할 일의 담당(<code>[owner:: 이름]</code>)이 나의 이름 중 하나와 같으면 내 할 일로 모읍니다. 이름을 비워 두면 VOC 로그인 이름을 씁니다.
      </p>
      {me.error && !info && (
        <p className="form-problem" role="alert">
          {me.error}
        </p>
      )}
      {body()}
    </section>
  );
}
