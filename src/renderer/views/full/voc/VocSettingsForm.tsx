// VOC 설정 본문(2.6단계 명세 §7 — 2.13단계 §C-5 에서 대화상자 대신 설정 › VOC 칸으로): 나 · 팀원(부서별 체크 목록) · 팀 시스템 ·
// 미배정 전체 보기 · 받는 주기 · VOC 서버 주소 · 사용량 기록 안내. 칸을 열 때마다 설정과 사람·시스템 목록(VOC user list·code list)을 새로 받는다.
// 저장은 앱 데이터 폴더에만 한다(위키에 쓰지 않는다). 바닥은 설정 칸 공통([저장]·[되돌리기]·[연결 시험]).
import { useEffect, useId, useRef, useState, type ReactElement } from 'react';
import type { ConnectionTestResult, FieldView, VocBoardState, VocDirectory, VocSettings } from '../../../../shared/types';
import { NO_BRIDGE_MESSAGE, getRadar } from '../../../api';
import { IconAlert, IconLogin, IconRefresh } from '../../../components/Icons';
import { LoadingState } from '../../../components/StateMessage';
import type { SectionStatus } from '../../../hooks/useSettingsSection';
import { NO_VOC_MESSAGE } from '../../../hooks/useVocBoard';
import { normalizeTestResult } from '../../../lib/settings';
import { errorText } from '../../../lib/snapshot';
import { SettingsFooter } from '../settings/SettingsFooter';
import {
  DEFAULT_VOC_API_URL,
  VOC_SETTINGS_LIMITS,
  directoryErrorHint,
  groupMembers,
  matchesFilter,
  normalizeDirectory,
  normalizeVocSettings,
  sameDepartmentIds,
  sameDraft,
  settingsDraftOf,
  settingsFromDraft,
  systemChoices,
  toggleIn,
  vocSettingsProblem,
  type VocSettingsDraft,
} from '../../../lib/voc';

type LoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; settings: VocSettings; directory: VocDirectory | null; directoryError?: string };

export interface VocSettingsFormProps {
  /** 저장한 설정(main 이 돌려준 값) */
  onSaved: (settings: VocSettings) => void;
  /** 지금 보드 상태 — 목록을 받지 못했을 때 할 일(서버 주소·로그인·연결)을 고른다 */
  boardState?: VocBoardState;
  /** 로그인이 필요해 목록을 받지 못했을 때의 [로그인](VOC 화면과 로그인 대화상자를 연다 — 명세 §13) */
  onLogin?: () => void;
  /** 저장하지 않은 변경이 있는가(칸을 떠날 때 확인) */
  onDirty?: (dirty: boolean) => void;
  /** 다시 받으라는 요청 번호(로그인·로그아웃 뒤) */
  reloadKey?: number;
  /** 지금 쓰는 서버 주소와 출처(설정 › VOC 칸 머리와 같은 것). 환경 변수면 입력을 잠근다 */
  apiUrlInfo?: FieldView<string>;
}

export function VocSettingsForm({ onSaved, boardState, onLogin, onDirty, reloadKey = 0, apiUrlInfo }: VocSettingsFormProps): ReactElement {
  // 서버 주소가 환경 변수로 정해졌으면 여기 값은 쓰지 않는다 — 입력을 잠그고 시험도 지금 주소로(§A-3)
  const urlLocked = apiUrlInfo?.source === 'env';
  const urlFallback = apiUrlInfo?.teamValue ?? apiUrlInfo?.builtinValue ?? DEFAULT_VOC_API_URL;
  const urlFallbackLabel = apiUrlInfo?.teamValue ? '팀 기본값' : '기본 주소';
  const titleId = useId();
  const [load, setLoad] = useState<LoadState>({ status: 'idle' });
  const [base, setBase] = useState<VocSettingsDraft | null>(null);
  const [draft, setDraft] = useState<VocSettingsDraft | null>(null);
  const [memberFilter, setMemberFilter] = useState('');
  const [systemFilter, setSystemFilter] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [status, setStatus] = useState<SectionStatus | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null);
  const loadSeq = useRef(0);

  const reload = (): void => {
    const api = getRadar();
    if (!api || typeof api.getVocSettings !== 'function') {
      setLoad({ status: 'error', message: api ? NO_VOC_MESSAGE : NO_BRIDGE_MESSAGE });
      return;
    }
    const seq = ++loadSeq.current;
    setLoad({ status: 'loading' });
    const settingsP = Promise.resolve().then(() => api.getVocSettings());
    const dirP = Promise.resolve().then(() =>
      typeof api.getVocDirectory === 'function' ? api.getVocDirectory() : Promise.reject(new Error(NO_VOC_MESSAGE)),
    );
    void Promise.allSettled([settingsP, dirP]).then(([s, d]) => {
      if (seq !== loadSeq.current) return;
      if (s.status === 'rejected') {
        setLoad({ status: 'error', message: errorText(s.reason) });
        return;
      }
      const settings = normalizeVocSettings(s.value);
      const directory = d.status === 'fulfilled' ? normalizeDirectory(d.value) : null;
      const next = settingsDraftOf(settings);
      setBase(next);
      setDraft(next);
      setLoad({
        status: 'ready',
        settings,
        directory,
        directoryError: d.status === 'rejected' ? errorText(d.reason) : undefined,
      });
    });
  };

  useEffect(() => {
    setMemberFilter('');
    setSystemFilter('');
    setSaveError(null);
    reload();
    return () => {
      loadSeq.current += 1; // 늦게 온 응답은 버린다
    };
    // reload 는 그릴 때마다 새 함수다 — 열릴 때·다시 받으라 할 때만 부른다
  }, [reloadKey]);

  const ready = load.status === 'ready' ? load : null;
  const directory = ready?.directory ?? null;
  const problem = draft ? vocSettingsProblem(draft) : null;
  const dirty = !!draft && !!base && !sameDraft(draft, base);
  const canSave = !!ready && !!draft && !problem && !saving && dirty;

  useEffect(() => {
    onDirty?.(dirty);
  }, [dirty, onDirty]);
  useEffect(() => () => onDirty?.(false), [onDirty]);

  const change = (patch: Partial<VocSettingsDraft>): void => {
    setDraft((prev) => (prev ? { ...prev, ...patch } : prev));
    setSaveError(null);
    setStatus(null);
  };

  const revert = (): void => {
    setDraft(base);
    setSaveError(null);
    setStatus(null);
    setTestResult(null);
  };

  // [연결 시험] — 초안의 서버 주소로(비면 지금 주소). 로그인돼 있으면 whoami
  const test = async (): Promise<void> => {
    const api = getRadar();
    if (!api || typeof api.testSettings !== 'function' || testing) return;
    setTesting(true);
    setTestResult(null);
    setStatus(null);
    try {
      const r = normalizeTestResult(await api.testSettings('voc', !urlLocked && draft?.apiUrl.trim() ? { apiUrl: draft.apiUrl.trim() } : {}));
      if (r) setTestResult(r);
      else setStatus({ tone: 'error', text: '연결 시험 응답 형식이 맞지 않습니다' });
    } catch (err) {
      setStatus({ tone: 'error', text: `연결 시험을 하지 못했습니다. (${errorText(err)})` });
    } finally {
      setTesting(false);
    }
  };

  const save = async (): Promise<void> => {
    if (!canSave || !draft) return;
    const api = getRadar();
    if (!api || typeof api.saveVocSettings !== 'function') {
      setSaveError(api ? NO_VOC_MESSAGE : NO_BRIDGE_MESSAGE);
      return;
    }
    setSaving(true);
    try {
      const saved = normalizeVocSettings(await api.saveVocSettings(settingsFromDraft(draft)));
      setSaving(false);
      const next = settingsDraftOf(saved);
      setBase(next);
      setDraft(next);
      setLoad((prev) => (prev.status === 'ready' ? { ...prev, settings: saved } : prev));
      setStatus({ tone: 'ok', text: '저장했습니다. 바로 적용됩니다 — 목록을 새로 받습니다.' });
      onSaved(saved);
    } catch (err) {
      setSaving(false);
      setSaveError(errorText(err));
    }
  };

  const me = directory?.me;
  const users = directory?.users ?? [];
  const groups = groupMembers(
    users.filter((u) => matchesFilter(memberFilter, u.name, u.department, u.email)),
    users.find((u) => u.id === me?.id)?.department ?? me?.department,
  );
  const systems = draft ? systemChoices(directory?.systems ?? [], draft.systems) : [];
  const shownSystems = systems.filter((c) => matchesFilter(systemFilter, c.name, c.code));
  const sameDept = sameDepartmentIds(users, users.find((u) => u.id === (draft?.myId ? Number(draft.myId) : me?.id)) ?? me);

  return (
    <div className="vv-settings sv-form sv-form--wide" role="group" data-testid="voc-settings" aria-labelledby={titleId}>
      <h3 id={titleId} className="field-label">
        팀·보드
      </h3>
      <div className="vv-settings-body vv-settings-body--inline">
        {(load.status === 'loading' || load.status === 'idle') && <LoadingState text="설정과 사람·시스템 목록을 받는 중입니다…" />}
        {load.status === 'error' && (
          <div className="vv-settings-error">
            <p className="form-problem" role="alert">
              설정을 불러오지 못했습니다. ({load.message})
            </p>
            <button type="button" className="btn btn--secondary" onClick={reload}>
              <IconRefresh size={16} />
              다시 시도
            </button>
          </div>
        )}
        {ready && draft && (
          <>
            {ready.directoryError && (
              <div className="dialog-warn voc-login-needed" data-testid="voc-settings-directory-error">
                <IconAlert size={16} />
                <span className="voc-login-needed-text">
                  사람·시스템 목록을 받지 못했습니다({ready.directoryError}). 받는 주기·서버 주소는 바꿀 수 있습니다 —{' '}
                  {directoryErrorHint(boardState)}
                </span>
                {boardState === 'login' && onLogin && (
                  <button
                    type="button"
                    className="btn btn--secondary"
                    data-testid="btn-voc-settings-login"
                    disabled={saving}
                    onClick={onLogin}
                  >
                    <IconLogin size={16} />
                    로그인
                  </button>
                )}
              </div>
            )}

            <div className="field">
              <label htmlFor="voc-settings-me" className="field-label">
                나
              </label>
              <select
                id="voc-settings-me"
                className="text-input vv-select"
                data-testid="voc-settings-me"
                disabled={saving}
                value={draft.myId}
                onChange={(e) => change({ myId: e.target.value })}
              >
                <option value="">자동 — VOC 로그인 이메일로 찾기{me ? ` (지금: ${me.name})` : ''}</option>
                {draft.myId !== '' && !users.some((u) => String(u.id) === draft.myId) && (
                  <option value={draft.myId}>사용자 {draft.myId}</option>
                )}
                {[...users]
                  .sort((a, b) => a.name.localeCompare(b.name, 'ko'))
                  .map((u) => (
                    <option key={u.id} value={String(u.id)}>
                      {u.name}
                      {u.department ? ` · ${u.department}` : ''}
                    </option>
                  ))}
              </select>
            </div>

            <fieldset className="vv-settings-group">
              <legend className="field-label">팀원</legend>
              <p className="vv-settings-note">
                {draft.memberIds.length > 0
                  ? `${draft.memberIds.length}명 고름 — 칸은 고른 순서로 놓입니다(나는 맨 앞).`
                  : '비워 두면 나와 같은 부서 사람들을 팀으로 봅니다.'}{' '}
                최대 {VOC_SETTINGS_LIMITS.members}명.
              </p>
              <div className="vv-settings-tools">
                <input
                  className="text-input vv-filter"
                  type="search"
                  aria-label="팀원 찾기"
                  placeholder="이름·부서로 찾기"
                  value={memberFilter}
                  disabled={users.length === 0}
                  onChange={(e) => setMemberFilter(e.target.value)}
                />
                <button
                  type="button"
                  className="link-btn"
                  disabled={saving || sameDept.length === 0}
                  onClick={() => change({ memberIds: sameDept })}
                >
                  나와 같은 부서 고르기
                </button>
                <button
                  type="button"
                  className="link-btn"
                  disabled={saving || draft.memberIds.length === 0}
                  onClick={() => change({ memberIds: [] })}
                >
                  비우기(기본값)
                </button>
              </div>
              {users.length === 0 ? (
                <p className="empty-note">받은 사람 목록이 없습니다.</p>
              ) : groups.length === 0 ? (
                <p className="empty-note">찾는 사람이 없습니다.</p>
              ) : (
                <div className="vv-check-groups">
                  {groups.map((g, i) => {
                    // aria-labelledby 는 공백으로 나뉜 id 목록이다 — 부서 이름('부서 없음'·'규제DX 1팀')을 id 에 넣지 않는다
                    const headId = `${titleId}-dept-${i}`;
                    return (
                      <div key={g.department} className="vv-check-group" role="group" aria-labelledby={headId}>
                        <h3 id={headId} className="vv-check-group-title">
                          {g.department}
                          <span className="vv-check-group-count">{g.members.length}명</span>
                        </h3>
                        <ul className="vv-check-list">
                          {g.members.map((u) => (
                            <li key={u.id}>
                              <label className="vv-check">
                                <input
                                  type="checkbox"
                                  data-testid="voc-settings-member"
                                  data-user-id={u.id}
                                  disabled={saving}
                                  checked={draft.memberIds.includes(u.id)}
                                  onChange={(e) => change({ memberIds: toggleIn(draft.memberIds, u.id, e.target.checked) })}
                                />
                                <span className="vv-check-text">
                                  {u.name}
                                  {me?.id === u.id && <span className="vv-check-hint"> 나</span>}
                                </span>
                              </label>
                            </li>
                          ))}
                        </ul>
                      </div>
                    );
                  })}
                </div>
              )}
            </fieldset>

            <fieldset className="vv-settings-group">
              <legend className="field-label">팀 시스템</legend>
              <p className="vv-settings-note">
                {draft.systems.length > 0
                  ? `${draft.systems.length}개 고름 — 미배정 칸에 이 시스템의 티켓이 보입니다.`
                  : '비워 두면 팀원이 담당인 진행 중 티켓에 나오는 시스템을 팀 시스템으로 봅니다.'}{' '}
                최대 {VOC_SETTINGS_LIMITS.systems}개.
              </p>
              <div className="vv-settings-tools">
                <input
                  className="text-input vv-filter"
                  type="search"
                  aria-label="시스템 찾기"
                  placeholder="시스템 이름·코드로 찾기"
                  value={systemFilter}
                  disabled={systems.length === 0}
                  onChange={(e) => setSystemFilter(e.target.value)}
                />
                <button
                  type="button"
                  className="link-btn"
                  disabled={saving || draft.systems.length === 0}
                  onClick={() => change({ systems: [] })}
                >
                  비우기(기본값)
                </button>
              </div>
              {systems.length === 0 ? (
                <p className="empty-note">
                  고를 수 있는 시스템이 없습니다 — 시스템은 받은 진행 중 티켓에서 모읍니다(VOC 목록을 받은 뒤 다시 여세요).
                </p>
              ) : shownSystems.length === 0 ? (
                <p className="empty-note">찾는 시스템이 없습니다.</p>
              ) : (
                <ul className="vv-check-list vv-check-list--systems">
                  {shownSystems.map((c) => (
                    <li key={c.code}>
                      <label className="vv-check">
                        <input
                          type="checkbox"
                          data-testid="voc-settings-system"
                          data-code={c.code}
                          disabled={saving}
                          checked={draft.systems.includes(c.code)}
                          onChange={(e) => change({ systems: toggleIn(draft.systems, c.code, e.target.checked) })}
                        />
                        <span className="vv-check-text">
                          {c.name}
                          {c.name !== c.code && <span className="vv-check-hint"> {c.code}</span>}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </fieldset>

            <label className="check-card">
              <input
                type="checkbox"
                data-testid="voc-settings-all-unassigned"
                disabled={saving}
                checked={draft.showAllUnassigned}
                aria-labelledby={`${titleId}-all-title`}
                aria-describedby={`${titleId}-all-desc`}
                onChange={(e) => change({ showAllUnassigned: e.target.checked })}
              />
              <span className="check-card-text">
                <span id={`${titleId}-all-title`} className="check-card-title">
                  미배정 전체 보기
                </span>
                <span id={`${titleId}-all-desc`} className="check-card-desc">
                  미배정 칸에 팀 시스템 밖의 미배정 티켓도 보입니다.
                </span>
              </span>
            </label>

            <div className="vv-settings-row">
              <div className="field">
                <label htmlFor="voc-settings-poll" className="field-label">
                  받는 주기(분)
                </label>
                <input
                  id="voc-settings-poll"
                  className="text-input vv-poll"
                  type="number"
                  inputMode="numeric"
                  min={VOC_SETTINGS_LIMITS.pollMin}
                  max={VOC_SETTINGS_LIMITS.pollMax}
                  step={1}
                  data-testid="voc-settings-poll"
                  disabled={saving}
                  value={draft.pollMinutes}
                  onChange={(e) => change({ pollMinutes: e.target.value })}
                />
              </div>
              <div className="field vv-settings-grow">
                <label htmlFor="voc-settings-api-url" className="field-label">
                  VOC 서버 주소
                </label>
                <input
                  id="voc-settings-api-url"
                  className="text-input"
                  type="text"
                  data-testid="voc-settings-api-url"
                  disabled={saving || urlLocked}
                  aria-describedby={urlLocked ? 'voc-settings-api-url-env' : undefined}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={`비워 두면 ${urlFallbackLabel}(${urlFallback})`}
                  value={urlLocked ? (apiUrlInfo?.value ?? '') : draft.apiUrl}
                  onChange={(e) => change({ apiUrl: e.target.value })}
                />
                {urlLocked && (
                  <p className="field-note" id="voc-settings-api-url-env" data-testid="voc-settings-api-url-env">
                    환경 변수 {apiUrlInfo?.envName ?? 'WIKI_RADAR_VOC_URL'} 로 정해져 여기서 바꿀 수 없습니다.
                  </p>
                )}
              </div>
            </div>

            <p className="vv-settings-note">
              VOC 를 부를 때마다 voc-cli 와 같은 사용량 기록(<code>~/.voc-cli/usage.jsonl</code>)에 한 줄을 남깁니다. 10분마다
              받으면 하루 약 19KB 가 쌓입니다. 서버 주소를 바꾸면 다시 로그인해야 합니다.
            </p>

            {problem && (
              <p className="form-problem" role="alert">
                {problem}
              </p>
            )}
          </>
        )}
      </div>
      <SettingsFooter
        dirty={dirty}
        blocked={!!problem}
        saving={saving}
        testing={testing}
        status={saveError ? { tone: 'error', text: `설정을 저장하지 못했습니다. (${saveError})` } : status}
        testResult={testResult}
        onSave={() => void save()}
        onRevert={revert}
        onTest={() => void test()}
      />
    </div>
  );
}
