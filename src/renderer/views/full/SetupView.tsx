// 풀스크린 「설정 › 점검」 칸(2.7단계 명세 §4 — 2.9단계 §2 에서 「환경 점검」 화면이 설정의 첫 칸이 됨): 위키 폴더 · Claude Code ·
// 메일 계정 · VOC 로그인 · 팀 위키 동기화(2.8단계)를 줄마다 보이고, 없는 것은 무엇이 꺼지는지와 고치는 방법을 적는다.
// 처음 실행에 main 이 이 칸으로 열고, [확인]을 누르면 다음부터 저절로 뜨지 않는다. 제목·칸 탭은 SettingsView 가 그린다.
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { getRadar } from '../../api';
import { FEATURES } from '../../../shared/edition';
import type { VocBoard } from '../../../shared/types';
import { IconAlert, IconCheck, IconCopy, IconFolder, IconLogin, IconRefresh, IconSettings } from '../../components/Icons';
import { LoadingState } from '../../components/StateMessage';
import type { SetupHook } from '../../hooks/useSetup';
import type { TeamSyncHook } from '../../hooks/useTeamSync';
import { cls } from '../../lib/cls';
import { SETUP_FIX_TAB, type SettingsTab } from '../../lib/settings';
import { CLAUDE_INSTALL_COMMAND, setupRows, type SetupRow } from '../../lib/setup';
import { TeamSyncPanel } from './TeamSyncPanel';
import { copyText } from './voc/VocBanner';

export interface SetupViewProps {
  setup: SetupHook;
  board: VocBoard | null;
  /** VOC 화면을 열고 로그인 대화상자를 띄운다 */
  onVocLogin: () => void;
  /** [확인] 뒤 — 쓸 수 있는 첫 화면으로 */
  onDone: () => void;
  notify: (message: string) => void;
  /** 팀 위키 동기화(SettingsView 가 한 번 구독해 나 칸과 같이 쓴다) */
  teamSync: TeamSyncHook;
  /** 줄마다 [고치기] — 그 줄을 고치는 설정 칸을 연다(2.13단계 §D-3). 없으면 단추 없음 */
  onFix?: (tab: SettingsTab) => void;
  /** 칸 탭과 이어 주는 id(tabpanel 의 id·aria-labelledby) */
  panelId: string;
  tabId: string;
}

const TONE_ICON = {
  ok: <IconCheck size={16} />,
  off: <IconAlert size={16} />,
  warn: <IconAlert size={16} />,
  wait: <IconRefresh size={16} />,
} as const;

function SetupItem({
  row,
  children,
  onFix,
}: {
  row: SetupRow;
  children?: ReactElement | false | null;
  onFix?: (tab: SettingsTab) => void;
}): ReactElement {
  const headId = `setup-${row.key}-title`;
  return (
    <li
      className={cls('setup-item', `is-${row.tone}`)}
      data-testid={`setup-${row.key}`}
      data-tone={row.tone}
      data-quiet={row.quiet}
      aria-labelledby={headId}
    >
      <span className="setup-mark" aria-hidden="true">
        {TONE_ICON[row.tone]}
      </span>
      <div className="setup-body">
        <p className="setup-head">
          <span id={headId} className="setup-title">
            {row.title}
          </span>
          <span className="setup-state" data-testid={`setup-${row.key}-state`}>
            {row.state}
          </span>
        </p>
        <p className="setup-detail">{row.detail}</p>
        {row.path && (
          <p className="setup-path" title={row.path}>
            {row.path}
          </p>
        )}
        {row.effect && (
          <p className="setup-effect">
            쓸 수 없는 기능: <strong>{row.effect}</strong>
          </p>
        )}
        {children}
        {onFix && (
          <div className="setup-actions setup-fix">
            <button
              type="button"
              className="btn btn--secondary"
              data-testid={`setup-${row.key}-fix`}
              aria-describedby={headId}
              onClick={() => onFix(SETUP_FIX_TAB[row.key])}
            >
              <IconSettings size={16} />
              {row.tone === 'ok' ? '설정 보기' : '고치기'}
            </button>
          </div>
        )}
      </div>
    </li>
  );
}

export function SetupView({ setup, board, onVocLogin, onDone, notify, teamSync, onFix, panelId, tabId }: SetupViewProps): ReactElement {
  const [choosing, setChoosing] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const { status } = setup;
  const { reload } = setup;

  // 「알림」 줄이 살아 있게(2.12단계 §6-2): 칸을 열 때 한 번, 알림함의 보류 상태가 바뀔 때마다 다시 읽는다
  const heldSig = useRef<string | null>(null);
  useEffect(() => {
    reload();
    const api = getRadar();
    if (!api || typeof api.onInbox !== 'function') return;
    return api.onInbox((inbox) => {
      const sig = JSON.stringify(inbox?.held ?? null);
      if (heldSig.current !== null && heldSig.current !== sig) reload();
      heldSig.current = sig;
    });
  }, [reload]);

  const choose = async (): Promise<void> => {
    setChoosing(true);
    const changed = await setup.chooseWiki();
    setChoosing(false);
    if (changed) notify('위키 폴더를 바꿨습니다. 다시 시작하면 적용됩니다.');
  };
  const copyInstall = async (): Promise<void> => {
    notify((await copyText(CLAUDE_INSTALL_COMMAND)) ? '설치 명령을 복사했습니다.' : '복사하지 못했습니다. 명령을 직접 골라 복사하세요.');
  };
  const finish = async (): Promise<void> => {
    setFinishing(true);
    await setup.markSeen();
    setFinishing(false);
    onDone();
  };

  const rows = status ? setupRows(status, board) : [];
  const row = (key: SetupRow['key']) => rows.find((r) => r.key === key);
  const wiki = row('wiki');
  const claude = row('claude');
  const mail = row('mail');
  const voc = row('voc');
  const notifyLine = row('notify');
  const extra = (keys: readonly SetupRow['key'][]) => keys.map((k) => row(k)).filter((r): r is SetupRow => !!r);

  return (
    <section className="sv-panel" role="tabpanel" id={panelId} aria-labelledby={tabId} data-testid="setup-view">
      <p className="qv-lead">
        이 PC에서 쓸 수 있는 기능을 확인합니다. 없는 항목이 있어도 앱은 그대로 쓸 수 있고, 그 항목이 필요한 기능만 꺼집니다.
        {FEATURES.voc ? ' 개인 위키가 없으면 VOC 보드만 씁니다.' : ' 개인 위키가 없으면 메일만 씁니다.'}
      </p>

      {setup.error && (
        <p className="form-problem" role="alert">
          {setup.error}
        </p>
      )}

      {!status ? (
        <LoadingState text="환경을 확인하는 중입니다…" />
      ) : (
        <ul className="setup-list" aria-label="점검 항목">
          {wiki && (
            <SetupItem row={wiki} onFix={onFix}>
              {status.wiki.source !== 'env' && (
                <div className="setup-actions">
                  <button
                    type="button"
                    className="btn btn--secondary"
                    data-testid="setup-choose-wiki"
                    disabled={choosing}
                    onClick={() => void choose()}
                  >
                    <IconFolder size={16} />
                    {choosing ? '고르는 중…' : '폴더 고르기'}
                  </button>
                  {(status.wiki.pending || status.wiki.pendingNone) && (
                    <button type="button" className="btn btn--primary" data-testid="setup-restart" onClick={() => void setup.restart()}>
                      <IconRefresh size={16} />
                      다시 시작
                    </button>
                  )}
                </div>
              )}
            </SetupItem>
          )}
          {claude && (
            <SetupItem row={claude} onFix={onFix}>
              {!status.claude.ok && (
                <div className="setup-actions">
                  {status.claude.source !== 'env' && (
                    <>
                      <code className="setup-command" data-testid="setup-claude-command">
                        {CLAUDE_INSTALL_COMMAND}
                      </code>
                      <button type="button" className="btn btn--secondary" onClick={() => void copyInstall()}>
                        <IconCopy size={16} />
                        복사
                      </button>
                    </>
                  )}
                  <button type="button" className="btn btn--secondary" data-testid="setup-recheck" onClick={setup.reload}>
                    <IconRefresh size={16} />
                    다시 확인
                  </button>
                </div>
              )}
            </SetupItem>
          )}
          {mail && <SetupItem row={mail} onFix={onFix} />}
          {extra(['mailIn', 'ai']).map((r) => (
            <SetupItem key={r.key} row={r} onFix={onFix} />
          ))}
          {voc && (
            <SetupItem row={voc} onFix={onFix}>
              {board?.state === 'login' && (
                <div className="setup-actions">
                  <button type="button" className="btn btn--secondary" data-testid="setup-voc-login" onClick={onVocLogin}>
                    <IconLogin size={16} />
                    로그인
                  </button>
                </div>
              )}
            </SetupItem>
          )}
          {notifyLine && <SetupItem row={notifyLine} onFix={onFix} />}
          <TeamSyncPanel sync={teamSync} onFix={onFix ? () => onFix('wiki') : undefined} />
          {extra(['team', 'secrets']).map((r) => (
            <SetupItem key={r.key} row={r} onFix={onFix} />
          ))}
        </ul>
      )}

      <div className="qv-actions">
        <button
          type="button"
          className="btn btn--primary"
          data-testid="setup-done"
          disabled={!status || finishing}
          onClick={() => void finish()}
        >
          <IconCheck size={16} />
          확인
        </button>
        <span className="result-hint">이 칸은 왼쪽 아래 ‘설정’에서 다시 볼 수 있습니다.</span>
      </div>
    </section>
  );
}
