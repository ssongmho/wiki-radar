// 풀스크린 「설정」 화면(2.9단계 명세 §2 → 2.13단계 §C-0): 왼쪽 세로 칸 목록 9칸
// [점검 · 나 · 위키 · 메일 받기 · 메일 보내기 · AI · VOC · 알림 · 정보] 과 고른 칸. 칸 옆 앰버 점 = 점검 줄의 warn/off 가 그 칸을 가리킴.
// 칸은 FullView 가 메모리에 들고 있다(view:setup → 점검, view:settings:<칸> → 그 칸). 저장하지 않은 변경이 있으면 칸을 옮기기 전에 묻는다.
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactElement } from 'react';
import type { VocBoard } from '../../../shared/types';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import type { MeHook } from '../../hooks/useMe';
import type { SetupHook } from '../../hooks/useSetup';
import { useTeamSync } from '../../hooks/useTeamSync';
import { cls } from '../../lib/cls';
import { focusLost } from '../../lib/focus';
import { SETTINGS_TAB_LIST, tabDots, type SettingsTab } from '../../lib/settings';
import { teamSyncSummary } from '../../lib/teamSync';
import { AiSettings } from './settings/AiSettings';
import { InfoSettings } from './settings/InfoSettings';
import { MailInSettings } from './settings/MailInSettings';
import { MailOutSettings } from './settings/MailOutSettings';
import { MeSettings } from './settings/MeSettings';
import { NotifySettings } from './settings/NotifySettings';
import { VocSettings } from './settings/VocSettings';
import { WikiSettings } from './settings/WikiSettings';
import { SetupView } from './SetupView';

export type { SettingsTab } from '../../lib/settings';

/** 옛 이름(2.9) — 칸 목록 */
export const SETTINGS_TABS = SETTINGS_TAB_LIST;

export interface SettingsViewProps {
  tab: SettingsTab;
  onTab: (tab: SettingsTab) => void;
  setup: SetupHook;
  me: MeHook;
  board: VocBoard | null;
  /** 열린 팀 위키 할 일마다의 담당 목록(나 칸 미리보기 — 모르면 null) */
  teamOwners: readonly (readonly string[])[] | null;
  /** VOC 화면을 열고 로그인 대화상자를 띄운다 */
  onVocLogin: () => void;
  /** VOC 보드를 새로 받는다(VOC 칸 저장·로그아웃 뒤) */
  onVocRefresh?: () => void;
  /** 점검 칸 [확인] 뒤 — 쓸 수 있는 첫 화면으로 */
  onDone: () => void;
  notify: (message: string) => void;
  /** 오늘(앱 시계 — 처음 받을 날짜 검사) */
  today: string;
  /** 바깥(처음 실행·사이드바·알림함)에서 이 화면을 열 때마다 늘어난다. 초점이 사라져 있으면 제목으로 */
  focusRequest?: number;
}

const tabId = (key: SettingsTab): string => `settings-tab-${key}-btn`;
const panelId = (key: SettingsTab): string => `settings-panel-${key}`;

export function SettingsView({
  tab,
  onTab,
  setup,
  me,
  board,
  teamOwners,
  onVocLogin,
  onVocRefresh,
  onDone,
  notify,
  today,
  focusRequest,
}: SettingsViewProps): ReactElement {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const tabRefs = useRef(new Map<SettingsTab, HTMLButtonElement>());
  const teamSync = useTeamSync();
  const current = SETTINGS_TAB_LIST.find((t) => t.key === tab) ?? SETTINGS_TAB_LIST[0];
  // 고른 칸에 저장하지 않은 변경이 있는가 — 칸을 옮기기 전에 묻는다
  const dirty = useRef(false);
  const onDirty = useCallback((d: boolean) => {
    dirty.current = d;
  }, []);
  const [leaveTo, setLeaveTo] = useState<SettingsTab | null>(null);

  useEffect(() => {
    if (focusLost()) titleRef.current?.focus();
  }, [focusRequest]);

  const go = (key: SettingsTab): void => {
    if (key === current.key) return;
    if (dirty.current) {
      setLeaveTo(key);
      return;
    }
    onTab(key);
  };

  // 칸 목록: 위·아래(왼쪽·오른쪽도) · 처음·끝 키로 옮기며 바로 연다(roving tabindex)
  const onTabKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    const n = SETTINGS_TAB_LIST.length;
    const i = SETTINGS_TAB_LIST.findIndex((t) => t.key === current.key);
    const next =
      e.key === 'ArrowDown' || e.key === 'ArrowRight'
        ? (i + 1) % n
        : e.key === 'ArrowUp' || e.key === 'ArrowLeft'
          ? (i - 1 + n) % n
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? n - 1
              : -1;
    if (next < 0) return;
    e.preventDefault();
    const key = SETTINGS_TAB_LIST[next].key;
    go(key);
    if (!dirty.current) tabRefs.current.get(key)?.focus();
  };

  const teamSyncOn = teamSync.status ? teamSync.status.enabled : teamSync.supported ? null : false;
  // 팀 위키 동기화는 켜 두었을 때만 점(끈 것은 고를 수 있는 상태다)
  const teamTone = teamSync.status?.enabled ? teamSyncSummary(teamSync.status, new Date()).tone : null;
  const dots = tabDots(setup.status, board, teamTone);
  const common = { today, notify, panelId: panelId(current.key), tabId: tabId(current.key), onDirty };

  const body = (): ReactElement => {
    switch (current.key) {
      case 'check':
        return (
          <SetupView
            setup={setup}
            board={board}
            onVocLogin={onVocLogin}
            onDone={onDone}
            notify={notify}
            teamSync={teamSync}
            onFix={go}
            panelId={panelId('check')}
            tabId={tabId('check')}
          />
        );
      case 'me':
        return <MeSettings me={me} teamOwners={teamOwners} teamSyncOn={teamSyncOn} notify={notify} panelId={panelId('me')} tabId={tabId('me')} />;
      case 'wiki':
        return <WikiSettings {...common} setup={setup} teamSync={teamSync} />;
      case 'mailIn':
        return <MailInSettings {...common} />;
      case 'mailOut':
        return <MailOutSettings {...common} />;
      case 'ai':
        return <AiSettings {...common} />;
      case 'voc':
        return (
          <VocSettings
            board={board}
            notify={notify}
            panelId={panelId('voc')}
            tabId={tabId('voc')}
            onDirty={onDirty}
            onLogin={onVocLogin}
            onRefresh={() => onVocRefresh?.()}
          />
        );
      case 'notify':
        return <NotifySettings notify={notify} panelId={panelId('notify')} tabId={tabId('notify')} />;
      case 'info':
        return <InfoSettings {...common} />;
    }
  };

  return (
    <main className="qv scroll" aria-labelledby="settings-title" data-testid="settings-view" data-tab={current.key}>
      <div className="qv-inner sv-inner">
        <header className="qv-head">
          <p className="crumb">
            <span>설정</span>
            <span aria-hidden="true">/</span>
            <span>{current.label}</span>
          </p>
          <h1 id="settings-title" className="detail-title" tabIndex={-1} ref={titleRef}>
            설정
          </h1>
        </header>

        <div className="sv-layout">
          <div className="sv-nav" role="tablist" aria-label="설정 칸" aria-orientation="vertical" data-testid="settings-tabs" onKeyDown={onTabKey}>
            {SETTINGS_TAB_LIST.map((t) => {
              const selected = t.key === current.key;
              const dot = dots.has(t.key);
              return (
                <button
                  key={t.key}
                  type="button"
                  role="tab"
                  id={tabId(t.key)}
                  className={cls('sv-tab', selected && 'is-selected')}
                  data-testid={t.testid}
                  data-dot={dot ? 'amber' : undefined}
                  aria-selected={selected}
                  aria-controls={panelId(t.key)}
                  tabIndex={selected ? 0 : -1}
                  ref={(el) => {
                    if (el) tabRefs.current.set(t.key, el);
                    else tabRefs.current.delete(t.key);
                  }}
                  onClick={() => go(t.key)}
                >
                  <span className="sv-tab-label">{t.label}</span>
                  {dot && (
                    <span className="sv-tab-dot" data-testid={`settings-dot-${t.key}`} aria-label="고칠 것 있음" role="img" />
                  )}
                </button>
              );
            })}
          </div>
          <div className="sv-body">{body()}</div>
        </div>
      </div>
      <ConfirmDialog
        open={leaveTo !== null}
        title="저장하지 않은 변경이 있습니다"
        confirmText="버리고 옮기기"
        cancelText="이 칸에 남기"
        testId="sv-leave-confirm"
        confirmTestId="sv-leave-discard"
        cancelTestId="sv-leave-stay"
        onConfirm={() => {
          const to = leaveTo;
          setLeaveTo(null);
          dirty.current = false;
          if (to) onTab(to);
        }}
        onCancel={() => setLeaveTo(null)}
      >
        저장하지 않은 변경이 있습니다 — 버리고 옮길까요?
      </ConfirmDialog>
    </main>
  );
}
