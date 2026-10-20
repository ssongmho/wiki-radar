// 설정 › VOC(2.13단계 명세 §C-5): 서버 주소(출처) · 로그인 상태 · [로그인]·[로그아웃] + 2.6 의 VOC 설정 본문(VocSettingsForm).
// 저장은 기존 saveVocSettings(바로 적용 — 보드 주기를 다시 정한다). 서버 주소를 바꾸면 다시 로그인해야 한다.
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import type { AppInfo, VocBoard } from '../../../../shared/types';
import { getRadar } from '../../../api';
import { IconLogin, IconPower } from '../../../components/Icons';
import { sourceText } from '../../../lib/settings';
import { errorText } from '../../../lib/snapshot';
import { textOf } from '../../../lib/tasks';
import { VocSettingsForm } from '../voc/VocSettingsForm';

export interface VocSettingsProps {
  board: VocBoard | null;
  notify: (message: string) => void;
  panelId: string;
  tabId: string;
  onDirty: (dirty: boolean) => void;
  /** VOC 화면을 열고 로그인 대화상자를 띄운다 */
  onLogin: () => void;
  /** 저장·로그아웃 뒤 보드를 새로 받는다 */
  onRefresh: () => void;
}

function loginText(board: VocBoard | null): string {
  if (!board || board.state === 'loading') return '확인 중';
  if (board.state === 'login') return '로그인 필요';
  if (board.state === 'notConfigured') return textOf(board.message) || '설정 필요';
  const who = textOf(board.me?.name);
  if (!board.fetchedAt) return '연결 안 됨';
  return who ? `${who}(으)로 로그인됨` : '로그인됨';
}

export function VocSettings({ board, notify, panelId, tabId, onDirty, onLogin, onRefresh }: VocSettingsProps): ReactElement {
  const [info, setInfo] = useState<AppInfo['voc'] | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const loadInfo = useCallback(() => {
    const api = getRadar();
    if (!api || typeof api.getAppInfo !== 'function') return;
    api.getAppInfo().then(
      (i) => setInfo(i?.voc && i.voc.apiUrl && typeof i.voc.cli === 'boolean' ? i.voc : null),
      () => setInfo(null),
    );
  }, []);
  useEffect(loadInfo, [loadInfo]);

  // 로그인 상태가 바뀌면(로그인·로그아웃) 사람·시스템 목록을 다시 받는다
  const state = board?.state;
  const prevState = useRef(state);
  useEffect(() => {
    const before = prevState.current;
    prevState.current = state;
    if (before !== state && (before === 'login' || state === 'login')) setReloadKey((n) => n + 1);
  }, [state]);

  const logout = async (): Promise<void> => {
    const api = getRadar();
    if (!api || typeof api.vocLogout !== 'function') return;
    setBusy(true);
    setProblem(null);
    try {
      await api.vocLogout();
      notify('VOC 에서 로그아웃했습니다(이 PC 의 세션을 지웠습니다).');
      onRefresh();
    } catch (err) {
      setProblem(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const loggedIn = !!board && board.state !== 'login' && board.state !== 'loading' && !!board.fetchedAt;
  const cli = info?.cli === true;
  const url = info?.apiUrl;

  return (
    <section className="sv-panel" role="tabpanel" id={panelId} aria-labelledby={tabId} data-testid="settings-voc">
      <p className="qv-lead">VOC 보드의 팀·시스템·받는 주기와 로그인을 정합니다.</p>
      <dl className="sv-dl sv-voc-head">
        <dt>서버 주소</dt>
        <dd data-testid="sv-voc-url" data-source={url?.source ?? 'none'} data-locked={url?.source === 'env' ? 'env' : undefined}>
          {cli ? 'voc-cli 를 쓰는 중(WIKI_RADAR_VOC_CLI)' : (url?.value ?? '확인 중')}
          {!cli && url && url.source !== 'user' && <span className="sv-muted"> · {sourceText(url.source, url.envName)}</span>}
        </dd>
        <dt>로그인</dt>
        <dd data-testid="sv-voc-login-state" data-state={board?.state ?? 'loading'}>
          {loginText(board)}
        </dd>
      </dl>
      <div className="setup-actions">
        {!loggedIn && (
          <button type="button" className="btn btn--primary" data-testid="sv-voc-login" onClick={onLogin}>
            <IconLogin size={16} />
            로그인
          </button>
        )}
        <button
          type="button"
          className="btn btn--secondary"
          data-testid="sv-voc-logout"
          disabled={busy || cli || board?.state === 'login'}
          title={cli ? 'voc-cli 를 쓰는 중' : undefined}
          onClick={() => void logout()}
        >
          <IconPower size={16} />
          로그아웃
        </button>
        {cli && <span className="field-note">voc-cli 를 쓰는 중이라 앱에서 로그아웃하지 않습니다.</span>}
      </div>
      {problem && (
        <p className="form-problem" role="alert">
          {problem}
        </p>
      )}
      <VocSettingsForm
        apiUrlInfo={url}
        boardState={board?.state}
        onLogin={onLogin}
        onDirty={onDirty}
        reloadKey={reloadKey}
        onSaved={() => {
          notify('VOC 설정을 저장했습니다. 목록을 새로 받습니다.');
          onRefresh();
          loadInfo();
        }}
      />
    </section>
  );
}
