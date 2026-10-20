// 설정 › 위키(2.13단계 명세 §C-1): 개인 위키 폴더(폴더 / 없음) · 팀 위키 동기화(켜기·NAS 경로·내 PC 사본) · [지금 동기화]·[Obsidian으로 열기].
// 개인 위키를 바꾸면 다시 시작해야 적용된다(유일한 예외) — 저장 뒤 앰버 줄 [지금 다시 시작]. 팀 동기화는 저장하면 바로 적용.
import type { ReactElement } from 'react';
import { FEATURES } from '../../../../shared/edition';
import { WIKI_PENDING_NONE } from '../../../../shared/ipc';
import { getRadar } from '../../../api';
import { IconFolder, IconRefresh } from '../../../components/Icons';
import type { SetupHook } from '../../../hooks/useSetup';
import { useSettingsSection } from '../../../hooks/useSettingsSection';
import type { TeamSyncHook } from '../../../hooks/useTeamSync';
import { cls } from '../../../lib/cls';
import { errorText } from '../../../lib/snapshot';
import { TeamSyncPanel } from '../TeamSyncPanel';
import type { SectionProps } from './MailInSettings';
import { SectionHead, SectionNotes, SettingsCheck, SettingsField } from './SettingsField';
import { SettingsFooter } from './SettingsFooter';

export interface WikiSettingsProps extends SectionProps {
  setup: SetupHook;
  teamSync: TeamSyncHook;
}

export function WikiSettings({ today, notify, panelId, tabId, onDirty, setup, teamSync }: WikiSettingsProps): ReactElement {
  const h = useSettingsSection('wiki', today, onDirty);
  const view = h.view;
  const mode = h.text('wikiMode') === 'none' ? 'none' : 'folder';
  const modeLocked = h.locked('wikiMode');
  const teamOn = h.bool('teamEnabled');

  const pick = async (purpose: 'personalWiki' | 'teamLocal'): Promise<void> => {
    const api = getRadar();
    if (!api || typeof api.pickFolder !== 'function') return;
    try {
      const p = await api.pickFolder(purpose);
      if (typeof p === 'string' && p) h.set(purpose === 'personalWiki' ? 'wikiRoot' : 'teamLocal', p);
    } catch (err) {
      h.setStatus({ tone: 'error', text: errorText(err) });
    }
  };

  const restart = view?.restartPending;

  return (
    <section className="sv-panel" role="tabpanel" id={panelId} aria-labelledby={tabId} data-testid="settings-wiki">
      <SectionHead hook={h} lead="할 일·지식을 읽는 위키 폴더를 정합니다." />
      {view && (
        <form className="sv-form" noValidate onSubmit={(e) => e.preventDefault()}>
          <fieldset className="result-fieldset sv-group" data-testid="sv-wiki-personal">
            <legend className="field-label result-legend">개인 위키</legend>
            <div className="radio-cards" role="radiogroup" aria-label="개인 위키" data-testid="sv-wiki-mode" data-mode={mode}>
              {(
                [
                  ['folder', '폴더'],
                  ['none', FEATURES.voc || FEATURES.teamWiki ? '없음 — 팀 위키·VOC 만 씀' : '없음 — 메일만 씀'],
                ] as const
              ).map(([value, label]) => (
                <label key={value} className={cls('radio-card', mode === value && 'is-checked')}>
                  <input
                    type="radio"
                    name="sv-wiki-mode"
                    value={value}
                    data-testid={`sv-wiki-mode-${value}`}
                    checked={mode === value}
                    disabled={modeLocked || h.saving}
                    onChange={() => h.set('wikiMode', value)}
                  />
                  <span>{label}</span>
                </label>
              ))}
            </div>
            {mode === 'folder' && (
              <SettingsField
                hook={h}
                field="wikiRoot"
                label="폴더"
                wide
                aside={
                  !h.locked('wikiRoot') && (
                    <button type="button" className="btn btn--secondary" data-testid="sv-pick-wiki" disabled={h.saving} onClick={() => void pick('personalWiki')}>
                      <IconFolder size={16} />
                      폴더 고르기
                    </button>
                  )
                }
              />
            )}
            <p className="field-note">개인 위키를 바꾸면 다시 시작해야 적용됩니다.</p>
          </fieldset>

          {/* 공개판은 팀 위키를 가린다(src/shared/edition.ts) */}
          {FEATURES.teamWiki && (
            <fieldset className="result-fieldset sv-group" data-testid="sv-wiki-team">
              <legend className="field-label result-legend">팀 위키 동기화</legend>
              <SettingsCheck hook={h} field="teamEnabled" title="팀 위키 동기화 켜기" desc="NAS 의 팀 위키와 내 PC 사본을 양쪽으로 맞춥니다." />
              <SettingsField hook={h} field="teamRemote" label="NAS 팀 위키(원본)" wide />
              <SettingsField
                hook={h}
                field="teamLocal"
                label="내 PC 위키 폴더(Obsidian 으로 여는 곳)"
                wide
                note={teamOn ? undefined : '처음에는 빈 폴더(없으면 만듭니다)여야 합니다. 개인 위키 폴더는 쓸 수 없습니다.'}
                aside={
                  <button type="button" className="btn btn--secondary" data-testid="sv-pick-team" disabled={h.saving} onClick={() => void pick('teamLocal')}>
                    <IconFolder size={16} />
                    폴더 고르기
                  </button>
                }
              />
            </fieldset>
          )}

          {teamSync.supported && (
            <ul className="setup-list" aria-label="팀 위키 동기화 상태">
              <TeamSyncPanel sync={teamSync} />
            </ul>
          )}

          <SectionNotes notes={view.notes} />
          <SettingsFooter
            dirty={h.dirty}
            blocked={Object.keys(h.problems).length > 0}
            saving={h.saving}
            testing={h.testing}
            status={h.status}
            testResult={h.testResult}
            onSave={() =>
              void h.save().then((r) => {
                if (!r) return;
                setup.reload();
                notify(r.restartNeeded ? '위키 설정을 저장했습니다. 다시 시작하면 적용됩니다.' : '위키 설정을 저장했습니다.');
              })
            }
            onRevert={h.revert}
            onTest={() => void h.test()}
            extra={
              restart && (
                <div className="sv-restart" role="alert" data-testid="sv-wiki-restart">
                  <span>다시 시작하면 새 위키를 읽습니다{restart === WIKI_PENDING_NONE ? '(개인 위키 없음)' : `(${restart})`}.</span>
                  <button type="button" className="btn btn--primary" data-testid="sv-wiki-restart-now" onClick={() => void setup.restart()}>
                    <IconRefresh size={16} />
                    지금 다시 시작
                  </button>
                </div>
              )
            }
          />
        </form>
      )}
    </section>
  );
}
