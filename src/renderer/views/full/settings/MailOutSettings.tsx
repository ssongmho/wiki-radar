// 설정 › 메일 보내기(SMTP — 2.13단계 명세 §C-3): 받기와 같은 계정 · 서버·포트·보안 · (다른 계정이면) 아이디·비밀번호 ·
// 보내는 이름·서명·나에게 숨은참조(2.5 의 mail-settings.json — main 이 나눠 쓴다). 저장하면 다음 발송부터 바로 쓴다.
import type { ReactElement } from 'react';
import { useSettingsSection } from '../../../hooks/useSettingsSection';
import type { SectionProps } from './MailInSettings';
import { SecretField } from './SecretField';
import { SectionHead, SectionNotes, SettingsCheck, SettingsField } from './SettingsField';
import { SettingsFooter } from './SettingsFooter';

export function MailOutSettings({ today, notify, panelId, tabId, onDirty }: SectionProps): ReactElement {
  const h = useSettingsSection('mailOut', today, onDirty);
  const view = h.view;
  const same = h.bool('sameAccount');
  const sameUser = view?.sameAccountUser;
  return (
    <section className="sv-panel" role="tabpanel" id={panelId} aria-labelledby={tabId} data-testid="settings-mailOut">
      <SectionHead hook={h} lead="메일 할 일·메일함의 회신을 이 계정으로 보냅니다." />
      {view && (
        <form className="sv-form" noValidate onSubmit={(e) => e.preventDefault()}>
          <SettingsCheck
            hook={h}
            field="sameAccount"
            title="메일 받기와 같은 계정"
            desc={same ? `메일 받기 칸의 계정을 씀${sameUser ? `(${sameUser})` : ' — 메일 받기 칸에 계정이 없습니다'}` : '아래에 보내기 계정을 따로 넣습니다.'}
          />
          <div className="sv-row">
            <SettingsField hook={h} field="host" label="서버" placeholder="smtps.example.com" wide />
            <SettingsField hook={h} field="port" label="포트" type="number" />
          </div>
          <SettingsField hook={h} field="security" label="보안">
            {({ id, disabled, describedBy }) => (
              <select
                id={id}
                className="text-input sv-select"
                data-testid="sv-input-security"
                value={h.text('security') || 'ssl'}
                disabled={disabled}
                aria-describedby={describedBy || undefined}
                onChange={(e) => h.set('security', e.target.value)}
              >
                <option value="ssl">SSL(465 등)</option>
                <option value="starttls">STARTTLS(587 등)</option>
              </select>
            )}
          </SettingsField>
          {!same && (
            <>
              <SettingsField hook={h} field="user" label="아이디" placeholder="name@example.com" wide />
              <SecretField hook={h} secretKey="mailOut.pass" label="비밀번호" />
            </>
          )}

          <fieldset className="result-fieldset sv-group">
            <legend className="field-label result-legend">보내는 사람·서명</legend>
            <SettingsField hook={h} field="fromName" label="보내는 이름" placeholder="비우면 메일 주소만" wide />
            <SettingsField hook={h} field="signature" label="서명" wide>
              {({ id, disabled, describedBy }) => (
                <textarea
                  id={id}
                  className="text-input sv-textarea"
                  data-testid="sv-input-signature"
                  rows={5}
                  value={h.text('signature')}
                  disabled={disabled}
                  aria-describedby={describedBy || undefined}
                  onChange={(e) => h.set('signature', e.target.value)}
                />
              )}
            </SettingsField>
            <SettingsCheck hook={h} field="bccSelf" title="나에게 숨은참조" desc="보낸 회신을 내 메일함에도 남깁니다." />
            <p className="field-note">회신 작성 칸의 「보내는 사람·서명」과 같은 설정입니다.</p>
          </fieldset>

          <SectionNotes notes={view.notes} />
          <SettingsFooter
            dirty={h.dirty}
            blocked={Object.keys(h.problems).length > 0}
            saving={h.saving}
            testing={h.testing}
            status={h.status}
            testResult={h.testResult}
            onSave={() => void h.save().then((r) => r && notify('메일 보내기 설정을 저장했습니다.'))}
            onRevert={h.revert}
            onTest={() => void h.test()}
          />
        </form>
      )}
    </section>
  );
}
