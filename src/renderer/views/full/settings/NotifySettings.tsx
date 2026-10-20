// 설정 › 알림(2.9단계 명세 §8-4): 종류별로 Windows 알림 / 알림함만 / 끔, 아침 요약 시각, 업무 시간(평일만·공휴일 제외), 내용 숨김.
// 2.12단계 §6-1: 조용한 시간 · 전체 화면·발표 중 보류 · 소리, 「창」 묶음(창 닫기: 트레이로 숨기기 / Radar 끝내기 — app-settings.json 의 shell).
// [저장]은 다시 시작 없이 바로 적용된다(main 이 판정을 한 번 다시 돈다). 오늘 마감 알림 시각·하루 한도·묶음은 고정.
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { FEATURES } from '../../../../shared/edition';
import { BUNDLE_MINUTES, DAILY_TOAST_LIMIT, DUE_ALERT_TIME, sameNotifySettings } from '../../../../shared/notify';
import type { NotifyKind, NotifyMode, NotifySettings as Settings, RadarAPI, ShellSettings } from '../../../../shared/types';
import { getRadar } from '../../../api';
import { IconCheck, IconClose, IconRefresh } from '../../../components/Icons';
import { LoadingState } from '../../../components/StateMessage';
import { cls } from '../../../lib/cls';
import { NOTIFY_KINDS, NOTIFY_MODES, NOTIFY_MODE_LABEL, NOTIFY_ROW_LABEL, normalizeNotifySettings, notifyDraftProblem } from '../../../lib/inbox';

/** 화면에 보이는 알림 종류 — 공개판은 VOC 알림을 가린다(src/shared/edition.ts) */
const SHOWN_KINDS = FEATURES.voc ? NOTIFY_KINDS : NOTIFY_KINDS.filter((k) => k !== 'vocSla' && k !== 'vocAssign');
import { errorText } from '../../../lib/snapshot';

type NotifyApi = Pick<RadarAPI, 'getNotifySettings' | 'saveNotifySettings' | 'getShellSettings' | 'saveShellSettings'>;

function notifyApi(): NotifyApi | null {
  const api = getRadar();
  return api && typeof api.getNotifySettings === 'function' && typeof api.saveNotifySettings === 'function' ? api : null;
}

/** 창 설정을 쓸 수 있는가(옛 preload 면 「창」 묶음을 숨긴다) */
function shellApi(): Required<Pick<NotifyApi, 'getShellSettings' | 'saveShellSettings'>> | null {
  const api = getRadar();
  return api && typeof api.getShellSettings === 'function' && typeof api.saveShellSettings === 'function'
    ? (api as Required<Pick<NotifyApi, 'getShellSettings' | 'saveShellSettings'>>)
    : null;
}

function normalizeShell(raw: unknown): ShellSettings | null {
  const r = raw as { closeAction?: unknown } | null;
  return r && (r.closeAction === 'tray' || r.closeAction === 'quit') ? { closeAction: r.closeAction } : null;
}

export interface NotifySettingsProps {
  notify: (message: string) => void;
  panelId: string;
  tabId: string;
}

const CLOSE_CHOICES: readonly { value: ShellSettings['closeAction']; label: string; testid: string }[] = [
  { value: 'tray', label: '트레이로 숨기기 — 트레이 아이콘·Ctrl+Alt+R 로 다시', testid: 'shell-close-tray' },
  { value: 'quit', label: 'Radar 끝내기', testid: 'shell-close-quit' },
];

export function NotifySettings({ notify, panelId, tabId }: NotifySettingsProps): ReactElement {
  const supported = notifyApi() !== null;
  const shellSupported = shellApi() !== null;
  const [saved, setSaved] = useState<Settings | null>(null);
  const [edit, setEdit] = useState<Settings | null>(null);
  const [savedShell, setSavedShell] = useState<ShellSettings | null>(null);
  const [editShell, setEditShell] = useState<ShellSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const seq = useRef(0);

  const load = useCallback(() => {
    const api = notifyApi();
    if (!api) return;
    const id = ++seq.current;
    api.getNotifySettings().then(
      (raw) => {
        if (id !== seq.current) return;
        const s = normalizeNotifySettings(raw);
        if (s) {
          setSaved(s);
          setError(null);
        } else setError('설정 › 알림 응답 형식이 맞지 않습니다');
      },
      (err: unknown) => {
        if (id === seq.current) setError(errorText(err));
      },
    );
    const sh = shellApi();
    sh?.getShellSettings().then(
      (raw) => {
        const s = normalizeShell(raw);
        if (s) setSavedShell(s);
      },
      (err: unknown) => setError(errorText(err)),
    );
  }, []);

  useEffect(load, [load]);

  const body = (): ReactElement => {
    if (!supported) return <p className="qv-lead">이 앱 연결에는 알림 설정 기능이 없습니다. 앱을 새 버전으로 다시 빌드해 주세요.</p>;
    if (!saved) return error ? <></> : <LoadingState text="알림 설정을 읽는 중입니다…" />;
    const draft = edit ?? saved;
    const shellDraft = editShell ?? savedShell;
    const notifyChanged = !sameNotifySettings(saved, draft);
    const shellChanged = !!savedShell && !!shellDraft && savedShell.closeAction !== shellDraft.closeAction;
    const changed = notifyChanged || shellChanged;
    const problem = notifyDraftProblem(draft);
    const set = (patch: Partial<Settings>): void => setEdit({ ...draft, ...patch, kinds: { ...draft.kinds, ...(patch.kinds ?? {}) } });
    const setKind = (kind: NotifyKind, mode: NotifyMode): void => set({ kinds: { ...draft.kinds, [kind]: mode } });

    const save = async (): Promise<void> => {
      const api = notifyApi();
      if (!api || saving || !changed || problem) return;
      setSaving(true);
      const id = ++seq.current;
      try {
        // 바뀐 쪽만 차례로 저장한다 — 둘째가 실패하면 문장(첫째는 저장된 채)
        if (notifyChanged) {
          const next = normalizeNotifySettings(await api.saveNotifySettings(draft));
          if (id === seq.current && next) {
            setSaved(next);
            setEdit(null);
          }
        }
        const sh = shellApi();
        if (shellChanged && sh && shellDraft) {
          const next = normalizeShell(await sh.saveShellSettings(shellDraft));
          if (id === seq.current && next) {
            setSavedShell(next);
            setEditShell(null);
          }
        }
        if (id === seq.current) {
          setError(null);
          notify('알림 설정을 저장했습니다.');
        }
      } catch (err) {
        if (id === seq.current) setError(errorText(err));
      } finally {
        setSaving(false);
      }
    };

    const timeField = (
      field: 'morningTime' | 'workStart' | 'workEnd' | 'quietStart' | 'quietEnd',
      label: string,
      testid: string,
    ): ReactElement => (
      <div className="field notify-time">
        <label htmlFor={testid} className="field-label">
          {label}
        </label>
        <input
          id={testid}
          type="time"
          className="text-input notify-time-input"
          data-testid={testid}
          value={draft[field]}
          disabled={saving}
          aria-invalid={problem?.field === field}
          aria-describedby={problem?.field === field ? 'notify-problem' : undefined}
          onChange={(e) => set({ [field]: e.target.value } as Partial<Settings>)}
        />
      </div>
    );

    const check = (
      key: 'hideContent' | 'quietHold' | 'sound',
      testid: string,
      title: string,
      desc: string,
    ): ReactElement => (
      <label className="check-card">
        <input
          type="checkbox"
          data-testid={testid}
          checked={draft[key]}
          disabled={saving}
          aria-labelledby={`${testid}-title`}
          aria-describedby={`${testid}-desc`}
          onChange={(e) => set({ [key]: e.target.checked } as Partial<Settings>)}
        />
        <span className="check-card-text">
          <span id={`${testid}-title`} className="check-card-title">
            {title}
          </span>
          <span id={`${testid}-desc`} className="check-card-desc">
            {desc}
          </span>
        </span>
      </label>
    );

    return (
      <form
        className="sv-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        {SHOWN_KINDS.map((kind) => (
          <fieldset key={kind} className="result-fieldset notify-kind" data-testid={`notify-kind-${kind}`} data-mode={draft.kinds[kind]}>
            <legend className="field-label result-legend">{NOTIFY_ROW_LABEL[kind]}</legend>
            <div className="radio-cards">
              {NOTIFY_MODES.map((mode) => (
                <label key={mode} className={cls('radio-card', draft.kinds[kind] === mode && 'is-checked')}>
                  <input
                    type="radio"
                    name={`notify-${kind}`}
                    value={mode}
                    checked={draft.kinds[kind] === mode}
                    data-testid={`notify-kind-${kind}-${mode}`}
                    disabled={saving}
                    onChange={() => setKind(kind, mode)}
                  />
                  <span>{NOTIFY_MODE_LABEL[mode]}</span>
                </label>
              ))}
            </div>
          </fieldset>
        ))}

        <div className="notify-times">
          {timeField('morningTime', '아침 요약 시각', 'notify-morning-time')}
          {timeField('workStart', '업무 시작', 'notify-work-start')}
          {timeField('workEnd', '업무 끝', 'notify-work-end')}
        </div>
        <p className="field-note">
          업무 시간은 평일만이고 공휴일은 뺍니다. 업무 시간 밖의 긴급 알림은 Windows 알림 없이 알림함에 두었다가 다음 아침 요약에 「보류」로 셉니다.
        </p>

        {check('hideContent', 'notify-hide-content', '내용 숨김', 'Windows 알림과 사이드바 긴급 띠에 건수만 보입니다(화면 공유·발표 중).')}

        <fieldset className="result-fieldset" data-testid="notify-quiet">
          <legend className="field-label result-legend">조용한 시간</legend>
          <div className="notify-quiet">
            {timeField('quietStart', '시작', 'notify-quiet-start')}
            {timeField('quietEnd', '끝', 'notify-quiet-end')}
            <button
              type="button"
              className="btn btn--secondary"
              data-testid="notify-quiet-clear"
              disabled={saving || (draft.quietStart === '' && draft.quietEnd === '')}
              onClick={() => set({ quietStart: '', quietEnd: '' })}
            >
              <IconClose size={16} />
              없음
            </button>
          </div>
          <p className="field-note">이 시간 동안의 Windows 알림은 알림함에 모았다가 끝나면 1건으로 보냅니다(점심시간 등 — 자정을 넘기지 않습니다).</p>
        </fieldset>

        {check(
          'quietHold',
          'notify-quiet-hold',
          '전체 화면·발표 중·잠금 동안 모았다가 끝나면 1건으로',
          '전체 화면 앱·PowerPoint 발표·잠금 화면 동안의 Windows 알림을 모아 두었다가 끝나면 요약 1건으로 보냅니다.',
        )}
        {check('sound', 'notify-sound', '소리', 'Windows 알림에 소리를 냅니다.')}

        <p className="field-note" data-testid="notify-fixed">
          고정 값: 오늘 마감 알림은 오후 {Number(DUE_ALERT_TIME.slice(0, 2)) - 12}시, 긴급 Windows 알림은 하루 {DAILY_TOAST_LIMIT}건까지,
          {` ${BUNDLE_MINUTES}`}분 안에 생긴 것은 한 번에 묶어 보냅니다.
        </p>
        <p className="field-note" data-testid="notify-dnd-note">
          Windows 방해 금지는 알 수 없습니다 — 켜 두면 알림 센터로만 갑니다.
        </p>

        {shellSupported && shellDraft && (
          <fieldset className="result-fieldset" data-testid="shell-close" data-action={shellDraft.closeAction}>
            <legend className="field-label result-legend">창 — 사이드바를 닫으면</legend>
            <div className="radio-cards" role="radiogroup" aria-label="사이드바를 닫으면">
              {CLOSE_CHOICES.map((c) => {
                const on = shellDraft.closeAction === c.value;
                return (
                  <label key={c.value} className={cls('radio-card', on && 'is-checked')}>
                    <input
                      type="radio"
                      name="shell-close"
                      value={c.value}
                      checked={on}
                      aria-checked={on}
                      data-testid={c.testid}
                      disabled={saving}
                      onChange={() => setEditShell({ closeAction: c.value })}
                    />
                    <span>{c.label}</span>
                  </label>
                );
              })}
            </div>
            <p className="field-note">풀스크린을 닫으면 언제나 사이드바로 갑니다. 사이드바의 종료 단추는 언제나 Radar 를 끝냅니다.</p>
          </fieldset>
        )}

        {problem && (
          <p className="form-problem" role="alert" id="notify-problem" data-testid="notify-problem">
            {problem.message}
          </p>
        )}
        {error && (
          <p className="form-problem" role="alert">
            {error}
          </p>
        )}

        <div className="qv-actions">
          <button type="submit" className="btn btn--primary" data-testid="notify-save" disabled={saving || !changed || !!problem}>
            <IconCheck size={16} />
            {saving ? '저장하는 중…' : '저장'}
          </button>
          <button
            type="button"
            className="btn btn--secondary"
            data-testid="notify-revert"
            disabled={saving || !changed}
            onClick={() => {
              setEdit(null);
              setEditShell(null);
            }}
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
    <section className="sv-panel" role="tabpanel" id={panelId} aria-labelledby={tabId} data-testid="settings-notify">
      <p className="qv-lead">
        {FEATURES.voc ? '오늘 마감 할 일 · VOC SLA · VOC 새 배정은' : '오늘 마감 할 일은'} 긴급 알림, 아침 요약은 하루 한 번입니다. 알림은 제목 막대의 종(알림함)에 모이고, 고른 종류만
        Windows 알림으로도 보냅니다.
      </p>
      {error && !saved && (
        <p className="form-problem" role="alert">
          {error}
        </p>
      )}
      {body()}
    </section>
  );
}
