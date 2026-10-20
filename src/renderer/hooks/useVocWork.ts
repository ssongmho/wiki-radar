// V4(2.6단계 명세 §14) 훅: 첨부 목록(ticket get --replies)·첨부 받기·작업시간·메일 기록 읽기와 V4 쓰기(vocWork).
// 읽은 것은 티켓마다 메모리에만 둔다. 쓰기는 이 훅이 부르기·두 번 누르기 막기·결과 알림만 맡는다 — 확인 대화상자는 화면이 띄운다
// (작업시간 넣기만 대화상자 없이 바로 — 결과 알림과 main 의 기록이 남는다).
import { useCallback, useRef, useState } from 'react';
import type { VocFileResult, VocTicketDetail, VocWorkInput, VocWorkKind, VocWorkLog, VocEmailLog, VocWorkResult } from '../../shared/types';
import { getRadar } from '../api';
import { errorText } from '../lib/snapshot';
import { normalizeTicketDetail } from '../lib/voc';
import { normalizeEmailLogs, normalizeWorkLogs, normalizeWorkResult, workNotice, type VocWorkNotice } from '../lib/vocWork';

export type Loadable<T> =
  | { status: 'loading'; value?: T }
  | { status: 'ready'; value: T }
  | { status: 'error'; message: string; value?: T };

export interface VocFileState {
  status: 'loading' | 'ready' | 'error';
  mode: 'preview' | 'download';
  result?: VocFileResult;
  message?: string;
}

const NO_V4 = '이 앱 연결에는 첨부·작업시간 기능이 없습니다. 앱을 새 버전으로 다시 빌드해 주세요.';

/** 키별 Loadable 묶음(같은 키를 다시 부르면 마지막 요청의 응답만 받는다) */
function useKeyed<T>(): {
  get: (key: string) => Loadable<T> | undefined;
  load: (key: string, fetch: () => Promise<T>) => Promise<T | null>;
  set: (key: string, value: T) => void;
} {
  const [map, setMap] = useState<ReadonlyMap<string, Loadable<T>>>(() => new Map());
  const ref = useRef(map);
  ref.current = map;
  const seqs = useRef(new Map<string, number>());
  const put = useCallback((key: string, entry: Loadable<T>) => setMap((prev) => new Map(prev).set(key, entry)), []);
  const get = useCallback((key: string) => map.get(key), [map]);
  const set = useCallback((key: string, value: T) => put(key, { status: 'ready', value }), [put]);
  const load = useCallback(
    async (key: string, fetch: () => Promise<T>): Promise<T | null> => {
      const seq = (seqs.current.get(key) ?? 0) + 1;
      seqs.current.set(key, seq);
      const previous = ref.current.get(key)?.value;
      put(key, previous !== undefined ? { status: 'loading', value: previous } : { status: 'loading' });
      try {
        const value = await Promise.resolve().then(fetch);
        if (seqs.current.get(key) === seq) put(key, { status: 'ready', value });
        return value;
      } catch (err) {
        if (seqs.current.get(key) === seq) {
          put(key, previous !== undefined ? { status: 'error', message: errorText(err), value: previous } : { status: 'error', message: errorText(err) });
        }
        return null;
      }
    },
    [put],
  );
  return { get, load, set };
}

export interface VocWorkHook {
  supported: boolean;
  detailOf: (ticketId: number) => Loadable<VocTicketDetail> | undefined;
  loadDetail: (ticketId: number) => Promise<VocTicketDetail | null>;
  workLogsOf: (ticketId: number) => Loadable<VocWorkLog[]> | undefined;
  loadWorkLogs: (ticketId: number) => Promise<VocWorkLog[] | null>;
  emailLogsOf: (ticketId: number) => Loadable<VocEmailLog[]> | undefined;
  loadEmailLogs: (ticketId: number) => Promise<VocEmailLog[] | null>;
  fileOf: (ticketId: number, fileId: number) => VocFileState | undefined;
  getFile: (ticketId: number, fileId: number, mode: 'preview' | 'download') => void;
  /** 내려받은 첨부 열기·폴더에서 보기. 실패하면 그 문장(성공 null) */
  openFile: (ticketId: number, fileId: number, how: 'open' | 'reveal') => Promise<string | null>;
  /** 쓰기가 실행 중인 티켓 → 종류 */
  busy: ReadonlyMap<number, VocWorkKind>;
  /** 쓰기(확인 대화상자 뒤 — 작업시간 넣기는 바로). 결과(실패 포함) 또는 부르지 못했으면 null */
  run: (input: VocWorkInput, ticket: { id: number; number: string }) => Promise<VocWorkResult | null>;
  notice: VocWorkNotice | null;
  closeNotice: () => void;
}

export function useVocWork(): VocWorkHook {
  const api = getRadar();
  const supported = !!api && typeof api.vocWork === 'function' && typeof api.vocFile === 'function';
  const details = useKeyed<VocTicketDetail>();
  const workLogs = useKeyed<VocWorkLog[]>();
  const emailLogs = useKeyed<VocEmailLog[]>();
  const [files, setFiles] = useState<ReadonlyMap<string, VocFileState>>(() => new Map());
  const [busy, setBusy] = useState<ReadonlyMap<number, VocWorkKind>>(() => new Map());
  const busyRef = useRef(new Set<number>());
  const done = useRef(new Set<string>());
  const [notice, setNotice] = useState<VocWorkNotice | null>(null);
  const seq = useRef(0);

  const need = <K extends keyof NonNullable<ReturnType<typeof getRadar>>>(name: K) => {
    const a = getRadar();
    if (!a || typeof a[name] !== 'function') throw new Error(NO_V4);
    return a;
  };

  const loadDetail = useCallback(
    (ticketId: number) => details.load(String(ticketId), async () => normalizeTicketDetail(await need('getVocTicket').getVocTicket(ticketId))),
    [details.load],
  );
  const loadWorkLogs = useCallback(
    (ticketId: number) => workLogs.load(String(ticketId), async () => normalizeWorkLogs(await need('getVocWorkLogs').getVocWorkLogs(ticketId))),
    [workLogs.load],
  );
  const loadEmailLogs = useCallback(
    (ticketId: number) => emailLogs.load(String(ticketId), async () => normalizeEmailLogs(await need('getVocEmailLogs').getVocEmailLogs(ticketId))),
    [emailLogs.load],
  );

  const fileKey = (ticketId: number, fileId: number): string => `${ticketId}:${fileId}`;
  const fileOf = useCallback((ticketId: number, fileId: number) => files.get(fileKey(ticketId, fileId)), [files]);
  const getFile = useCallback((ticketId: number, fileId: number, mode: 'preview' | 'download') => {
    const key = fileKey(ticketId, fileId);
    const put = (s: VocFileState): void => setFiles((prev) => new Map(prev).set(key, s));
    const a = getRadar();
    if (!a || typeof a.vocFile !== 'function') {
      put({ status: 'error', mode, message: NO_V4 });
      return;
    }
    put({ status: 'loading', mode });
    Promise.resolve()
      .then(() => a.vocFile({ ticketId, fileId, mode }))
      .then(
        (result) => put({ status: 'ready', mode, result }),
        (err: unknown) => put({ status: 'error', mode, message: errorText(err) }),
      );
  }, []);

  const openFile = useCallback(async (ticketId: number, fileId: number, how: 'open' | 'reveal'): Promise<string | null> => {
    const a = getRadar();
    if (!a || typeof a.openVocFile !== 'function') return NO_V4;
    try {
      await a.openVocFile({ ticketId, fileId, how });
      return null;
    } catch (err) {
      return errorText(err);
    }
  }, []);

  const closeNotice = useCallback(() => setNotice(null), []);

  const { set: setWorkLogs } = workLogs;
  const { set: setEmailLogs } = emailLogs;
  const run = useCallback(
    async (input: VocWorkInput, ticket: { id: number; number: string }): Promise<VocWorkResult | null> => {
      if (busyRef.current.has(input.ticketId) || done.current.has(input.actionId)) return null;
      const id = ++seq.current;
      const a = getRadar();
      if (!a || typeof a.vocWork !== 'function') {
        setNotice(workNotice({ ok: false, message: NO_V4 }, input.kind, ticket, id));
        return null;
      }
      busyRef.current.add(input.ticketId);
      done.current.add(input.actionId);
      setBusy((prev) => new Map(prev).set(input.ticketId, input.kind));
      try {
        const result = normalizeWorkResult(await a.vocWork(input));
        if (result.workLogs) setWorkLogs(String(input.ticketId), result.workLogs);
        if (result.emailLogs) setEmailLogs(String(input.ticketId), result.emailLogs);
        setNotice(workNotice(result, input.kind, ticket, id));
        return result;
      } catch (err) {
        setNotice(workNotice({ ok: false, message: errorText(err) }, input.kind, ticket, id));
        return null;
      } finally {
        busyRef.current.delete(input.ticketId);
        setBusy((prev) => {
          const next = new Map(prev);
          next.delete(input.ticketId);
          return next;
        });
      }
    },
    [setWorkLogs, setEmailLogs],
  );

  return {
    supported,
    detailOf: (ticketId) => details.get(String(ticketId)),
    loadDetail,
    workLogsOf: (ticketId) => workLogs.get(String(ticketId)),
    loadWorkLogs,
    emailLogsOf: (ticketId) => emailLogs.get(String(ticketId)),
    loadEmailLogs,
    fileOf,
    getFile,
    openFile,
    busy,
    run,
    notice,
    closeNotice,
  };
}
