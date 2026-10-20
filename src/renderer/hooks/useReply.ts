// 메일 회신(2.5단계 명세 §7) 상태: taskId 별 작성 칸 · 회신 문맥 · 보내는 이름·서명 설정 · 초안 만들기(한 번에 하나).
// FullView 가 들고 있다 — 다른 할 일을 보고 오거나 스냅샷이 바뀌어도 작성 중인 회신이 남는다(메모리에만).
// 발송은 처리 결과 저장과 같은 줄(useResultForms 의 send)에서 한다. 여기는 입력·문맥·초안만 맡는다.
// 메일함 회신(2.10단계 §8-3)도 같은 보관소를 쓴다 — 열쇠가 'mail:<경로>'(mailTargetKey)면 할 일 대신 그 메일이 대상이다
// (문맥은 getMailReplyContext, 초안은 draftMailReply). 같은 실행 잠금(한 번에 하나)을 나눠 쓴다.
import { useCallback, useMemo, useRef, useState } from 'react';
import type { MailReplyDraftInput, MailSettings, RadarAPI, ReplyDraftInput } from '../../shared/types';
import { settingsProblem } from '../../shared/reply';
import { NO_BRIDGE_MESSAGE, getRadar } from '../api';
import {
  IDLE_CONTEXT,
  contextOf,
  draftNote,
  failDraft,
  initialReply,
  makeSendId,
  normalizeMailSettings,
  normalizeReplyContext,
  prefillReply,
  receiveDraft,
  startDraftState,
  stopDraft,
  type ContextEntry,
  type ReplyState,
  type SettingsEntry,
} from '../lib/reply';
import { mailTargetPath } from '../lib/mailbox';
import { errorText } from '../lib/snapshot';

export const NO_REPLY_MESSAGE = '이 앱 연결에는 메일 회신 기능이 없습니다. 앱을 새 버전으로 다시 빌드해 주세요.';

/** 아직 만들지 않은 작성 칸(보이기만 한다 — 고치면 새 sendId 로 만든다) */
const EMPTY_REPLY: ReplyState = initialReply('');

type ReplyApi = Pick<
  RadarAPI,
  'getReplyContext' | 'draftReply' | 'cancelDraftReply' | 'sendReply' | 'getMailSettings' | 'saveMailSettings' | 'getMailReplyContext' | 'draftMailReply'
>;

function replyApi(): ReplyApi | null {
  const api = getRadar();
  return api && typeof api.getReplyContext === 'function' && typeof api.sendReply === 'function' ? api : null;
}

function missingApiText(): string {
  return getRadar() ? NO_REPLY_MESSAGE : NO_BRIDGE_MESSAGE;
}

export interface ReplyPeek {
  reply: ReplyState | undefined;
  context: ContextEntry;
  settings: SettingsEntry;
}

export interface ReplyHook {
  /** 앱 연결에 회신 기능이 있는가 */
  supported: boolean;
  replyOf: (taskId: string) => ReplyState;
  /** 작성 칸 고치기(없으면 새 sendId 로 만든다). 늦게 오는 초안 결과도 이것으로 넣는다 */
  update: (taskId: string, fn: (s: ReplyState) => ReplyState) => void;
  /** '회신 메일 보내기' 켜기·끄기. 켜면 회신 문맥을 다시 읽고 기본값을 (한 번) 채운다 */
  toggle: (taskId: string, on: boolean) => void;
  /** 처음 상태로(취소·발송 뒤). 다음에 켜면 새 sendId 다. 만드는 중인 초안은 멈춘다 */
  reset: (taskId: string) => void;
  contextOf: (taskId: string) => ContextEntry;
  loadContext: (taskId: string) => void;
  settings: SettingsEntry;
  loadSettings: () => void;
  /** 설정 저장. 문제가 있으면 그 문장, 성공이면 null */
  saveSettings: (value: MailSettings) => Promise<string | null>;
  /** 초안을 만드는 할 일(없으면 null). main 은 한 번에 하나만 만든다 */
  draftingId: string | null;
  startDraft: (taskId: string, note: string) => void;
  cancelDraft: (taskId: string) => void;
  /** 발송 흐름이 누르는 순간의 값(ref) */
  peek: (taskId: string) => ReplyPeek;
}

export function useReply(): ReplyHook {
  const [replies, setReplies] = useState<ReadonlyMap<string, ReplyState>>(() => new Map());
  const repliesRef = useRef(replies);
  repliesRef.current = replies;
  const [contexts, setContexts] = useState<ReadonlyMap<string, ContextEntry>>(() => new Map());
  const contextsRef = useRef(contexts);
  contextsRef.current = contexts;
  // 할 일마다 읽기 요청 번호 — 늦게 온 옛 응답이 새 응답을 덮지 않게
  const contextSeq = useRef(new Map<string, number>());
  const [settings, setSettings] = useState<SettingsEntry>({ status: 'idle' });
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const [draftingId, setDraftingId] = useState<string | null>(null);
  // 두 번 누르기 방지(상태 갱신은 다음 그리기에 반영된다)
  const draftingRef = useRef<string | null>(null);

  const update = useCallback((taskId: string, fn: (s: ReplyState) => ReplyState) => {
    setReplies((prev) => {
      const current = prev.get(taskId);
      const base = current ?? initialReply(makeSendId());
      const next = fn(base);
      if (next === base) return prev;
      return new Map(prev).set(taskId, next);
    });
  }, []);

  const setContext = useCallback((taskId: string, entry: ContextEntry) => {
    setContexts((prev) => new Map(prev).set(taskId, entry));
  }, []);

  const loadContext = useCallback(
    (taskId: string) => {
      const api = replyApi();
      if (!api) {
        setContext(taskId, { status: 'error', message: missingApiText() });
        return;
      }
      const seq = (contextSeq.current.get(taskId) ?? 0) + 1;
      contextSeq.current.set(taskId, seq);
      const previous = contextOf(contextsRef.current.get(taskId));
      setContext(taskId, { status: 'loading', ctx: previous });
      const mailPath = mailTargetPath(taskId);
      Promise.resolve()
        .then(() => {
          if (mailPath === null) return api.getReplyContext(taskId);
          if (typeof api.getMailReplyContext !== 'function') throw new Error(missingApiText());
          return api.getMailReplyContext(mailPath);
        })
        .then(
          (raw) => {
            if (contextSeq.current.get(taskId) !== seq) return;
            const ctx = normalizeReplyContext(raw);
            setContext(taskId, ctx ? { status: 'ready', ctx } : { status: 'missing' });
            // 켜 두고 기다리던 작성 칸이면 이제 기본값을 채운다
            if (ctx) update(taskId, (s) => (s.enabled && !s.prefilled ? prefillReply(s, ctx) : s));
          },
          (err: unknown) => {
            if (contextSeq.current.get(taskId) !== seq) return;
            setContext(taskId, { status: 'error', message: errorText(err), ctx: previous });
          },
        );
    },
    [setContext, update],
  );

  const loadSettings = useCallback(() => {
    const api = replyApi();
    if (!api || typeof api.getMailSettings !== 'function') {
      setSettings({ status: 'error', message: missingApiText() });
      return;
    }
    setSettings((prev) => ({ ...prev, status: 'loading' }));
    Promise.resolve()
      .then(() => api.getMailSettings())
      .then(
        (raw) => setSettings({ status: 'ready', value: normalizeMailSettings(raw) }),
        (err: unknown) => setSettings((prev) => ({ status: 'error', message: errorText(err), value: prev.value })),
      );
  }, []);

  const saveSettings = useCallback(async (value: MailSettings): Promise<string | null> => {
    const problem = settingsProblem(value);
    if (problem) return problem;
    const api = replyApi();
    if (!api || typeof api.saveMailSettings !== 'function') return missingApiText();
    try {
      const saved = normalizeMailSettings(await api.saveMailSettings(value));
      setSettings({ status: 'ready', value: saved });
      return null;
    } catch (err) {
      return errorText(err);
    }
  }, []);

  const toggle = useCallback(
    (taskId: string, on: boolean) => {
      const ctx = contextOf(contextsRef.current.get(taskId));
      update(taskId, (s) => {
        if (s.enabled === on) return s;
        const next = { ...s, enabled: on };
        return on && ctx ? prefillReply(next, ctx) : next;
      });
      if (!on) return;
      // 켤 때마다 다시 읽는다 — 그사이 계정(.env)을 넣었거나 같은 할 일로 보낸 기록이 생겼을 수 있다
      loadContext(taskId);
      if (settingsRef.current.status === 'idle' || settingsRef.current.status === 'error') loadSettings();
    },
    [update, loadContext, loadSettings],
  );

  const cancelDraftApi = useCallback(() => {
    const api = replyApi();
    if (!api || typeof api.cancelDraftReply !== 'function') return;
    Promise.resolve()
      .then(() => api.cancelDraftReply())
      .catch(() => undefined); // 멈출 것이 없었으면 그만이다
  }, []);

  const reset = useCallback(
    (taskId: string) => {
      if (repliesRef.current.get(taskId)?.draft.state === 'running') cancelDraftApi();
      setReplies((prev) => {
        if (!prev.has(taskId)) return prev;
        const next = new Map(prev);
        next.delete(taskId);
        return next;
      });
    },
    [cancelDraftApi],
  );

  const startDraft = useCallback(
    (taskId: string, note: string) => {
      if (draftingRef.current) return;
      const startedAt = Date.now();
      update(taskId, (s) => startDraftState(s, startedAt));
      const api = replyApi();
      const mailPath = mailTargetPath(taskId);
      if (!api || (mailPath === null ? typeof api.draftReply !== 'function' : typeof api.draftMailReply !== 'function')) {
        update(taskId, (s) => failDraft(s, startedAt, missingApiText()));
        return;
      }
      const hint = (repliesRef.current.get(taskId)?.hint ?? '').trim();
      draftingRef.current = taskId;
      setDraftingId(taskId);
      Promise.resolve()
        .then(() => {
          if (mailPath !== null) {
            const mailInput: MailReplyDraftInput = { path: mailPath, note: draftNote(note) };
            if (hint) mailInput.hint = hint;
            return (api.draftMailReply as NonNullable<RadarAPI['draftMailReply']>)(mailInput);
          }
          const input: ReplyDraftInput = { taskId, note: draftNote(note) };
          if (hint) input.hint = hint;
          return api.draftReply(input);
        })
        .then(
          (draft) => update(taskId, (s) => receiveDraft(s, startedAt, draft)),
          (err: unknown) => update(taskId, (s) => failDraft(s, startedAt, errorText(err))),
        )
        .finally(() => {
          if (draftingRef.current !== taskId) return;
          draftingRef.current = null;
          setDraftingId(null);
        });
    },
    [update],
  );

  const cancelDraft = useCallback(
    (taskId: string) => {
      update(taskId, stopDraft);
      cancelDraftApi();
    },
    [update, cancelDraftApi],
  );

  const peek = useCallback(
    (taskId: string): ReplyPeek => ({
      reply: repliesRef.current.get(taskId),
      context: contextsRef.current.get(taskId) ?? IDLE_CONTEXT,
      settings: settingsRef.current,
    }),
    [],
  );

  const supported = replyApi() !== null;
  return useMemo(
    () => ({
      supported,
      replyOf: (taskId: string) => replies.get(taskId) ?? EMPTY_REPLY,
      update,
      toggle,
      reset,
      contextOf: (taskId: string) => contexts.get(taskId) ?? IDLE_CONTEXT,
      loadContext,
      settings,
      loadSettings,
      saveSettings,
      draftingId,
      startDraft,
      cancelDraft,
      peek,
    }),
    [supported, replies, contexts, settings, draftingId, update, toggle, reset, loadContext, loadSettings, saveSettings, startDraft, cancelDraft, peek],
  );
}
