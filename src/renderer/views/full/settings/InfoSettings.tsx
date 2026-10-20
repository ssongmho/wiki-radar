// 설정 › 정보(2.13단계 명세 §C-6 — 연결 시험 없음): 버전 · [업데이트 확인] · 업데이트 서버(이 칸만 [저장]·[되돌리기]) ·
// [데이터 폴더 열기]·[로그 폴더 열기] · [진단 정보 복사](비밀은 저장됨/없음만) · 설정 내보내기·가져오기(미리보기 → [가져오기]) · 팀 기본값 파일.
import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { FEATURES } from '../../../../shared/edition';
import type { AppInfo, SettingsImportPreview, UpdateCheckResult } from '../../../../shared/types';
import { getRadar } from '../../../api';
import { IconCopy, IconDownload, IconFolder, IconRefresh, IconUpload } from '../../../components/Icons';
import { useSettingsSection } from '../../../hooks/useSettingsSection';
import { normalizeTeamSummary } from '../../../lib/settings';
import { errorText } from '../../../lib/snapshot';
import { copyText } from '../voc/VocBanner';
import type { SectionProps } from './MailInSettings';
import { SectionNotes, SettingsField, TeamLine } from './SettingsField';
import { SettingsFooter } from './SettingsFooter';

const INSTALL_LABEL: Record<AppInfo['install'], string> = { installed: '설치본', zip: '풀어 쓰는 패키지', dev: '개발 실행' };

export function InfoSettings({ today, notify, panelId, tabId, onDirty }: SectionProps): ReactElement {
  const h = useSettingsSection('info', today, onDirty);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [update, setUpdate] = useState<UpdateCheckResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [line, setLine] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [preview, setPreview] = useState<SettingsImportPreview | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const load = useCallback(() => {
    const api = getRadar();
    if (!api || typeof api.getAppInfo !== 'function') return;
    api.getAppInfo().then(
      (i) => {
        setInfo(i);
        setInfoError(null);
      },
      (err: unknown) => setInfoError(errorText(err)),
    );
  }, []);
  useEffect(load, [load]);

  const run = async (key: string, fn: () => Promise<void>): Promise<void> => {
    setBusy(key);
    setLine(null);
    try {
      await fn();
    } catch (err) {
      setLine({ tone: 'error', text: errorText(err) });
    } finally {
      setBusy(null);
    }
  };

  const api = getRadar();
  const updatable = info?.install === 'installed' && !info.testMode;

  const checkUpdate = async (): Promise<void> => {
    if (!api || typeof api.checkForUpdate !== 'function') return;
    setChecking(true);
    try {
      setUpdate(await api.checkForUpdate());
    } catch (err) {
      setUpdate({ state: 'failed', message: errorText(err) });
    } finally {
      setChecking(false);
    }
  };

  const copyDiagnostics = (): Promise<void> =>
    run('diag', async () => {
      if (!api || typeof api.getDiagnostics !== 'function') return;
      const text = await api.getDiagnostics();
      const ok = await copyText(text);
      setLine(ok ? { tone: 'ok', text: '진단 정보를 복사했습니다(비밀번호·키는 들어 있지 않습니다).' } : { tone: 'error', text: '복사하지 못했습니다.' });
    });

  const exportSettings = (): Promise<void> =>
    run('export', async () => {
      if (!api || typeof api.exportSettings !== 'function') return;
      const r = await api.exportSettings();
      if (r.saved) setLine({ tone: 'ok', text: `설정을 내보냈습니다: ${r.path ?? ''}(비밀번호·VOC 로그인·이 PC 경로는 뺐습니다)` });
    });

  const previewImport = (): Promise<void> =>
    run('import', async () => {
      if (!api || typeof api.previewSettingsImport !== 'function') return;
      const p = await api.previewSettingsImport();
      setPreview(p);
      setPicked(new Set(p ? p.sections.filter((s) => s.changes > 0).map((s) => s.key) : []));
    });

  const applyImport = (): Promise<void> =>
    run('apply', async () => {
      if (!api || typeof api.applySettingsImport !== 'function' || !preview) return;
      const r = await api.applySettingsImport(preview.token, [...picked]);
      setPreview(null);
      setLine({ tone: 'ok', text: `가져왔습니다: ${r.applied.length ? r.applied.map((k) => preview.sections.find((s) => s.key === k)?.label ?? k).join(', ') : '없음'} — 바로 적용됩니다.` });
      notify('설정을 가져왔습니다.');
      h.reload();
      load();
    });

  const openFolder = (which: 'data' | 'logs'): Promise<void> =>
    run(which, async () => {
      if (api && typeof api.openAppFolder === 'function') await api.openAppFolder(which);
    });

  const team = info ? normalizeTeamSummary(info.teamDefaults) : null;

  return (
    <section className="sv-panel" role="tabpanel" id={panelId} aria-labelledby={tabId} data-testid="settings-info">
      {infoError && (
        <p className="form-problem" role="alert">
          정보를 읽지 못했습니다. ({infoError})
        </p>
      )}
      <dl className="sv-dl" data-testid="sv-info-version">
        <dt>버전</dt>
        <dd>
          Radar {info?.version ?? '…'} {info && <span className="sv-muted">· {INSTALL_LABEL[info.install] ?? info.install}</span>}
        </dd>
        <dt>구성</dt>
        <dd className="sv-muted">{info ? `Electron ${info.electron} · Chrome ${info.chrome} · Node ${info.node} · ${info.os}` : '…'}</dd>
        <dt>데이터 폴더</dt>
        <dd className="sv-path" title={info?.dataDir}>
          {info?.dataDir ?? '…'}
        </dd>
      </dl>

      <div className="setup-actions">
        <button
          type="button"
          className="btn btn--secondary"
          data-testid="sv-update-check"
          disabled={checking || !info || !updatable}
          title={info && !updatable ? (info.install !== 'installed' ? '설치본에서만' : '시험 중') : undefined}
          onClick={() => void checkUpdate()}
        >
          <IconRefresh size={16} />
          {checking ? '확인 중…' : '업데이트 확인'}
        </button>
        {info && !updatable && (
          <span className="field-note" data-testid="sv-update-note">
            {info.install !== 'installed' ? '설치본에서만' : '시험 중 — 업데이트를 확인하지 않습니다'}
          </span>
        )}
        {update && (
          <span className="field-note" data-testid="sv-update-result" data-state={update.state}>
            {update.message}
          </span>
        )}
      </div>

      {h.view && (
        <form className="sv-form" noValidate onSubmit={(e) => e.preventDefault()}>
          <SettingsField hook={h} field="updateUrl" label="업데이트 서버" wide note="http(s) 주소 또는 off(확인하지 않음). 저장하면 다음 확인부터 씁니다." />
          <SectionNotes notes={h.view.notes} />
          <SettingsFooter
            dirty={h.dirty}
            blocked={Object.keys(h.problems).length > 0}
            saving={h.saving}
            status={h.status}
            onSave={() =>
              void h.save().then((r) => {
                if (r) load();
              })
            }
            onRevert={h.revert}
          />
        </form>
      )}

      <div className="sv-group">
        <h3 className="field-label">폴더·진단</h3>
        <div className="setup-actions">
          <button type="button" className="btn btn--secondary" data-testid="sv-open-data" disabled={busy !== null} onClick={() => void openFolder('data')}>
            <IconFolder size={16} />
            데이터 폴더 열기
          </button>
          <button type="button" className="btn btn--secondary" data-testid="sv-open-logs" disabled={busy !== null} onClick={() => void openFolder('logs')}>
            <IconFolder size={16} />
            로그 폴더 열기
          </button>
          <button type="button" className="btn btn--secondary" data-testid="sv-diagnostics" disabled={busy !== null} onClick={() => void copyDiagnostics()}>
            <IconCopy size={16} />
            진단 정보 복사
          </button>
        </div>
      </div>

      <div className="sv-group">
        <h3 className="field-label">설정 내보내기·가져오기</h3>
        <p className="field-note">비밀번호·키·VOC 로그인·이 PC 의 경로는 내보내지 않습니다.</p>
        <div className="setup-actions">
          <button type="button" className="btn btn--secondary" data-testid="sv-export" disabled={busy !== null} onClick={() => void exportSettings()}>
            <IconUpload size={16} />
            설정 내보내기
          </button>
          <button type="button" className="btn btn--secondary" data-testid="sv-import" disabled={busy !== null} onClick={() => void previewImport()}>
            <IconDownload size={16} />
            설정 가져오기
          </button>
        </div>
        {preview && (
          <div className="sv-import" data-testid="sv-import-preview">
            <p className="field-label">가져올 칸을 고르세요</p>
            <ul className="sv-import-list">
              {preview.sections.map((s) => (
                <li key={s.key}>
                  <label className="vv-check">
                    <input
                      type="checkbox"
                      data-testid="sv-import-section"
                      data-key={s.key}
                      checked={picked.has(s.key)}
                      disabled={busy !== null}
                      onChange={(e) =>
                        setPicked((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(s.key);
                          else next.delete(s.key);
                          return next;
                        })
                      }
                    />
                    <span className="vv-check-text">
                      {s.label} <span className="sv-muted">— 바뀌는 필드 {s.changes}개</span>
                      {s.skipped.length > 0 && <span className="sv-muted"> · 건너뜀: {s.skipped.join(', ')}</span>}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
            <div className="setup-actions">
              <button type="button" className="btn btn--primary" data-testid="sv-import-apply" disabled={busy !== null || picked.size === 0} onClick={() => void applyImport()}>
                가져오기
              </button>
              <button type="button" className="btn btn--secondary" disabled={busy !== null} onClick={() => setPreview(null)}>
                취소
              </button>
            </div>
          </div>
        )}
      </div>

      {line && (
        <p className={line.tone === 'error' ? 'form-problem' : 'sv-status is-ok'} role="status" data-testid="sv-info-line">
          {line.text}
        </p>
      )}

      {/* 공개판은 팀 위키가 없다(src/shared/edition.ts) */}
      {FEATURES.teamWiki && (
        <div className="sv-group" data-testid="sv-team-file">
          <h3 className="field-label">팀 기본값 파일</h3>
          <p className="field-note">
            팀 위키 안 <code>{info?.teamDefaultsFile ?? '.radar/team-settings.json'}</code>
            {team?.path ? ` — 읽은 파일: ${team.path}` : ''}
          </p>
          {team && <TeamLine team={team} />}
        </div>
      )}
    </section>
  );
}
