// 설정 칸 하나(2.13단계 명세 §D-1)의 상태: main 이 준 저장값(view)과 화면 초안(draft·비밀 초안), [저장]·[되돌리기]·[연결 시험].
// 초안이 없을 때 main 이 「설정 바뀜」(radar:settingsChanged — 팀 기본값을 다시 읽음·가져오기 등)을 보내면 다시 읽는다.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ConnectionTestResult,
  FieldSource,
  RadarAPI,
  SettingsSaveResult,
  SettingsSection,
  SettingsSectionView,
  TestableSection,
} from '../../shared/types';
import { getRadar } from '../api';
import {
  KEEP_SECRET,
  changedPatch,
  normalizeSectionView,
  normalizeTestResult,
  patchIsEmpty,
  patchProblems,
  saveResultText,
  shownBool,
  shownSource,
  shownText,
  type SecretDraft,
  type SettingsDraft,
} from '../lib/settings';
import { errorText } from '../lib/snapshot';

type SettingsApi = Required<Pick<RadarAPI, 'getSettings' | 'saveSettings' | 'testSettings'>> & Pick<RadarAPI, 'onSettingsChanged'>;

export function settingsApi(): SettingsApi | null {
  const api = getRadar();
  return api && typeof api.getSettings === 'function' && typeof api.saveSettings === 'function' && typeof api.testSettings === 'function'
    ? (api as SettingsApi)
    : null;
}

export interface SectionStatus {
  tone: 'ok' | 'error' | 'info';
  text: string;
}

export interface SectionHook {
  section: SettingsSection;
  supported: boolean;
  view: SettingsSectionView | null;
  loadError: string | null;
  draft: SettingsDraft;
  secret: SecretDraft;
  /** 바뀐 필드만(저장·시험에 보낼 것) */
  patch: ReturnType<typeof changedPatch>;
  problems: Record<string, string>;
  dirty: boolean;
  saving: boolean;
  testing: boolean;
  status: SectionStatus | null;
  testResult: ConnectionTestResult | null;
  text: (field: string) => string;
  bool: (field: string) => boolean;
  source: (field: string) => FieldSource;
  locked: (field: string) => boolean;
  set: (field: string, value: string | boolean) => void;
  /** [팀 기본값으로] — 내 값을 지운다(저장 전 초안) */
  reset: (field: string) => void;
  setSecret: (d: SecretDraft) => void;
  save: () => Promise<SettingsSaveResult | null>;
  revert: () => void;
  test: () => Promise<void>;
  reload: () => void;
  /** 다른 길(.env 옮기기 등)로 받은 새 보기 */
  accept: (raw: unknown) => void;
  setStatus: (s: SectionStatus | null) => void;
}

export function useSettingsSection(section: SettingsSection, today: string, onDirty?: (dirty: boolean) => void): SectionHook {
  const supported = settingsApi() !== null;
  const [view, setView] = useState<SettingsSectionView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<SettingsDraft>({});
  const [secret, setSecret] = useState<SecretDraft>(KEEP_SECRET);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [status, setStatus] = useState<SectionStatus | null>(null);
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null);
  const seq = useRef(0);

  const patch = useMemo(() => (view ? changedPatch(section, view, draft, secret) : {}), [section, view, draft, secret]);
  const problems = useMemo(() => patchProblems(section, patch, today), [section, patch, today]);
  const dirty = !patchIsEmpty(patch) || secret.action !== 'keep';
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  useEffect(() => {
    onDirty?.(dirty);
  }, [dirty, onDirty]);
  useEffect(() => () => onDirty?.(false), [onDirty]);

  const accept = useCallback(
    (raw: unknown) => {
      const v = normalizeSectionView(raw, section);
      if (v) {
        setView(v);
        setLoadError(null);
      } else setLoadError('설정 응답 형식이 맞지 않습니다');
    },
    [section],
  );

  const reload = useCallback(() => {
    const api = settingsApi();
    if (!api) return;
    const id = ++seq.current;
    api.getSettings(section).then(
      (raw) => {
        if (id === seq.current) accept(raw);
      },
      (err: unknown) => {
        if (id === seq.current) setLoadError(errorText(err));
      },
    );
  }, [section, accept]);

  useEffect(() => {
    reload();
    const api = settingsApi();
    if (!api || typeof api.onSettingsChanged !== 'function') return;
    return api.onSettingsChanged(() => {
      // 고치는 중이면 덮지 않는다([되돌리기]·[저장] 뒤 새로 읽는다)
      if (!dirtyRef.current) reload();
    });
  }, [reload]);

  const set = useCallback((field: string, value: string | boolean) => {
    setDraft((d) => ({ ...d, [field]: value }));
    setStatus(null);
  }, []);
  const reset = useCallback((field: string) => {
    setDraft((d) => ({ ...d, [field]: null }));
    setStatus(null);
  }, []);

  const revert = useCallback(() => {
    setDraft({});
    setSecret(KEEP_SECRET);
    setStatus(null);
    setTestResult(null);
    reload();
  }, [reload]);

  const save = useCallback(async (): Promise<SettingsSaveResult | null> => {
    const api = settingsApi();
    if (!api || !view || saving || !dirty || Object.keys(problems).length) return null;
    setSaving(true);
    const id = ++seq.current;
    try {
      const r = await api.saveSettings(section, patch);
      const v = normalizeSectionView(r?.view, section);
      if (v) setView(v);
      setDraft({});
      setSecret(KEEP_SECRET);
      const result: SettingsSaveResult = { view: v ?? view, ignored: Array.isArray(r?.ignored) ? r.ignored.filter((x) => typeof x === 'string') : [] };
      if (r?.restartNeeded === true) result.restartNeeded = true;
      if (r?.secretStorage === 'file' || r?.secretStorage === 'memory') result.secretStorage = r.secretStorage;
      setStatus({ tone: 'ok', text: saveResultText(result) });
      return result;
    } catch (err) {
      setStatus({ tone: 'error', text: `저장하지 못했습니다. (${errorText(err)})` });
      // 일부만 저장했을 수 있다 — 다시 읽는다(초안은 그대로)
      if (id === seq.current) {
        api.getSettings(section).then(
          (raw) => {
            const v = normalizeSectionView(raw, section);
            if (v) setView(v);
          },
          () => undefined,
        );
      }
      return null;
    } finally {
      setSaving(false);
    }
  }, [view, saving, dirty, problems, section, patch]);

  const test = useCallback(async (): Promise<void> => {
    const api = settingsApi();
    if (!api || testing || Object.keys(problems).length) return;
    setTesting(true);
    setTestResult(null);
    setStatus(null);
    try {
      const r = normalizeTestResult(await api.testSettings(section as TestableSection, patch));
      if (!r) setStatus({ tone: 'error', text: '연결 시험 응답 형식이 맞지 않습니다' });
      else {
        setTestResult(r);
        if (r.ok && dirtyRef.current) setStatus({ tone: 'info', text: '시험 성공. [저장]을 눌러야 적용됩니다.' });
      }
    } catch (err) {
      setStatus({ tone: 'error', text: `연결 시험을 하지 못했습니다. (${errorText(err)})` });
    } finally {
      setTesting(false);
    }
  }, [testing, problems, section, patch]);

  const empty = useMemo<SettingsSectionView>(
    () => ({ section, fields: {}, secrets: {}, notes: [], team: { source: 'none', problems: [] } }),
    [section],
  );
  const v = view ?? empty;

  return {
    section,
    supported,
    view,
    loadError,
    draft,
    secret,
    patch,
    problems,
    dirty,
    saving,
    testing,
    status,
    testResult,
    text: (field) => shownText(v, draft, field),
    bool: (field) => shownBool(v, draft, field),
    source: (field) => shownSource(v, draft, field),
    locked: (field) => v.fields[field]?.source === 'env',
    set,
    reset,
    setSecret: (d) => {
      setSecret(d);
      setStatus(null);
    },
    save,
    revert,
    test,
    reload,
    accept,
    setStatus,
  };
}
