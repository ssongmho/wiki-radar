// 설정 › 메일 받기(POP3 — 2.13단계 명세 §C-2): 서버·포트·SSL·아이디·비밀번호·받는 주기·처음 받을 날짜·수집 켬.
// 서버의 메일은 지우지 않는다(입력 없음 — POP3 클라이언트에 DELE 가 없다). 수집 상태·[지금 받기]·보관소는 MailCollectPanel(2.15).
import { useState, type ReactElement } from 'react';
import { getRadar } from '../../../api';
import { IconDownload } from '../../../components/Icons';
import { useSettingsSection } from '../../../hooks/useSettingsSection';
import { errorText } from '../../../lib/snapshot';
import { MailCollectPanel } from './MailCollectPanel';
import { SecretField } from './SecretField';
import { SectionHead, SectionNotes, SettingsCheck, SettingsField } from './SettingsField';
import { SettingsFooter } from './SettingsFooter';

/** 고정 글(입력 없음 — main 의 안내 줄과 겹치면 한 번만) */
const KEEP_NOTE = '서버의 메일은 지우지 않습니다.';

export interface SectionProps {
  today: string;
  notify: (message: string) => void;
  panelId: string;
  tabId: string;
  onDirty: (dirty: boolean) => void;
}

export function MailInSettings({ today, notify, panelId, tabId, onDirty }: SectionProps): ReactElement {
  const h = useSettingsSection('mailIn', today, onDirty);
  const [importing, setImporting] = useState(false);
  const view = h.view;
  const fromDotenv = view?.fields.user?.source === 'dotenv' && view.dotenv?.available;

  const importDotEnv = async (): Promise<void> => {
    const api = getRadar();
    if (!api || typeof api.importDotEnvAccount !== 'function') return;
    setImporting(true);
    try {
      h.accept(await api.importDotEnvAccount());
      notify('.env 계정을 설정으로 옮겼습니다(.env 파일은 그대로 둡니다).');
    } catch (err) {
      h.setStatus({ tone: 'error', text: `옮기지 못했습니다. (${errorText(err)})` });
    } finally {
      setImporting(false);
    }
  };

  return (
    <section className="sv-panel" role="tabpanel" id={panelId} aria-labelledby={tabId} data-testid="settings-mailIn">
      <SectionHead hook={h} lead="Radar 가 회사 메일 서버에서 POP3 로 메일을 받아 옵니다. 서버의 메일은 지우지 않습니다." />
      {view && (
        <form className="sv-form" noValidate onSubmit={(e) => e.preventDefault()}>
          <div className="sv-row">
            <SettingsField hook={h} field="host" label="서버" placeholder="pop3s.example.com" wide />
            <SettingsField hook={h} field="port" label="포트" type="number" />
          </div>
          <SettingsCheck hook={h} field="ssl" title="SSL(보안 연결)" desc="끄면 STLS 로 보안 연결을 엽니다(이 PC 시험 서버만 평문)." />
          <SettingsField hook={h} field="user" label="아이디" placeholder="name@example.com" wide />
          <SecretField hook={h} secretKey="mailIn.pass" label="비밀번호" />
          {fromDotenv && (
            <div className="sv-dotenv" data-testid="sv-dotenv">
              <p className="field-note">
                계정을 위키의 <code>{view.dotenv?.file}</code> 에서 읽고 있습니다. 설정으로 옮기면 이 PC 에 암호화해 둡니다. .env 파일은 고치지도 지우지도
                않습니다(지우기는 직접).
              </p>
              <button type="button" className="btn btn--secondary" data-testid="sv-import-dotenv" disabled={importing || h.saving} onClick={() => void importDotEnv()}>
                <IconDownload size={16} />
                {importing ? '옮기는 중…' : '이 계정을 설정으로 옮기기'}
              </button>
            </div>
          )}
          <div className="sv-row">
            <SettingsField hook={h} field="intervalMinutes" label="받는 주기(분, 5~60)" type="number" />
            <SettingsField
              hook={h}
              field="firstDate"
              label="처음 받을 날짜"
              type="date"
              note={h.text('firstDate') ? undefined : '비우면 수집을 켜는 날 기준 30일 전부터'}
            />
          </div>
          <p className="sv-fixed" data-testid="sv-mailin-keep">
            {KEEP_NOTE}
          </p>
          <div className="sv-collect">
            <SettingsCheck hook={h} field="enabled" title="메일 수집 켜기" desc="받는 주기마다 새 메일을 받아 메일함에 넣습니다." />
          </div>
          <MailCollectPanel />
          <SectionNotes notes={view.notes.filter((n) => n !== KEEP_NOTE)} />
          <SettingsFooter
            dirty={h.dirty}
            blocked={Object.keys(h.problems).length > 0}
            saving={h.saving}
            testing={h.testing}
            status={h.status}
            testResult={h.testResult}
            onSave={() => void h.save().then((r) => r && notify('메일 받기 설정을 저장했습니다.'))}
            onRevert={h.revert}
            onTest={() => void h.test()}
          />
        </form>
      )}
    </section>
  );
}
