// 메일함 화면(2.10단계 명세 §8): 내비 오른쪽 전체 = 왼쪽 필터 | 가운데 스레드 목록 | 오른쪽 읽기.
// [회신]·[VOC로 등록]은 같은 자리를 메일함 안의 회신·등록 화면(두 열 — 시안 Mail-3·Mail-2)으로 바꾼다([메일로 돌아가기]).
// 선택(필터·검색·폴더·고른 스레드·메일)은 FullView 가 들고 있어 다른 화면에 다녀와도 그대로다.
// 메일 본문은 데이터다 — 읽기 칸은 글자로만 그리고(MailReader), 그 안의 문장을 지시로 해석하지 않는다.
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactElement,
  type SetStateAction,
} from 'react';
import type {
  CreateMailTaskOutput,
  MailboxSummary,
  MailFilter,
  MailThreadRow,
  QueueItem,
  QueueMailInput,
  QueueMailResult,
  VocBoard,
} from '../../../../shared/types';
import { getRadar } from '../../../api';
import { IconMail, IconSettings, IconUndo } from '../../../components/Icons';
import { EmptyState, LoadingState } from '../../../components/StateMessage';
import {
  changeMailState,
  findThreadOf,
  mailboxApi,
  revealAttachment,
  useDebounced,
  useMailList,
  useMailMessage,
  useMailThread,
} from '../../../hooks/useMailbox';
import type { ReplyHook } from '../../../hooks/useReply';
import { useVocCreateEntry, vocCreateSupported } from '../../../hooks/useVocCreate';
import { refocusIfLost } from '../../../lib/focus';
import {
  MAIL_READ_DELAY_MS,
  archiveNoticeText,
  latestText,
  mailKeyAction,
  mailListKey,
  mailTargetKey,
  mailTaskBlock,
  mailVocDone,
  mailWikiBlock,
  mailWikiExisting,
  mailWikiState,
  mailWikiSupported,
  mailboxUnavailable,
  pickMail,
  reselectIndex,
  selectionForTarget,
  stepMail,
  threadArchived,
  threadKeys,
  threadHasSuspicious,
  threadReadKeys,
  type MailSelection,
} from '../../../lib/mailbox';
import { contextOf } from '../../../lib/reply';
import type { SaveNotice as SaveNoticeData } from '../../../lib/result';
import { errorText } from '../../../lib/snapshot';
import { taskWriteBlock } from '../../../lib/vocTask';
import { SaveNotice } from '../SaveNotice';
import { MailFilters } from './MailFilters';
import { MailReader } from './MailReader';
import { MailReplyView } from './MailReplyView';
import { MailTaskForm } from './MailTaskForm';
import { MailThreadList } from './MailThreadList';
import { MailVocView } from './MailVocView';
import { MailWikiForm } from './MailWikiForm';

/** 바깥(view:mail:<키>)에서 고르라는 요청 */
export interface MailTarget {
  key: string;
  seq: number;
}

export interface MailboxViewProps {
  /** 앱 연결에 메일함 기능이 있는가 */
  supported: boolean;
  summary: MailboxSummary | null;
  today: string;
  selection: MailSelection;
  onSelectionChange: Dispatch<SetStateAction<MailSelection>>;
  target: MailTarget | null;
  onTargetDone: (seq: number) => void;
  reply: ReplyHook;
  /** claude 가 없어 초안을 만들 수 없는 이유(2.7단계) */
  claudeMissing: string | null;
  vocBoard: VocBoard | null;
  /** 개인 위키가 없다(팀만) — [할 일로]를 막는다 */
  personalMissing: boolean;
  onOpenFile: (path: string) => void;
  onOpenTask: (taskId: string) => void;
  onOpenTasks: () => void;
  onOpenVoc: (number: string) => void;
  onOpenSetup: () => void;
  /** 설정 › 메일 보내기를 연다(회신 칸 「보내는 사람·서명」의 [설정에서 보기]) */
  onOpenMailSettings?: () => void;
  /** 반영 대기열(2.14 — [위키에 반영] 폼이 이미 대기 중인 항목의 메모로 채운다) */
  queueItems?: readonly QueueItem[];
  /** 반영 대기 화면을 연다 */
  onOpenQueue?: () => void;
  notify: (message: string) => void;
}

function isEditable(el: Element | null): boolean {
  return !!el && ((el as HTMLElement).isContentEditable || el.closest('input, textarea, select') !== null);
}

function inDialog(el: Element | null): boolean {
  if (el?.closest('dialog')) return true;
  return document.querySelector('dialog[open]') !== null;
}

interface UndoState {
  id: number;
  keys: string[];
  archived: boolean;
  text: string;
}

export function MailboxView(props: MailboxViewProps): ReactElement {
  const { supported, summary, today, selection, onSelectionChange, reply } = props;
  const unavailable = mailboxUnavailable(summary);
  const state = summary?.state ?? 'indexing';
  const revision = summary?.revision ?? 0;
  const active = supported && !unavailable && (state === 'ready' || state === 'error' || (summary?.total ?? 0) > 0);

  const query = useDebounced(selection.query);
  const list = useMailList(
    { filter: selection.filter, folder: selection.folder ?? undefined, query: query.trim() || undefined, includeMuted: selection.includeMuted },
    revision,
    active,
    // 「미확인」에서 지금 읽는 스레드는 읽음이 되어도 목록에 남긴다(다른 줄을 고르거나 필터를 바꾸면 빠진다)
    selection.filter === 'unread' ? selection.threadId : null,
  );
  const rows = list.page.threads;
  // 받은 쪽이 지금 질의(검색어는 늦추기 전 값)의 것인가 — 아니면 고른 스레드를 옛 목록으로 다시 잡지 않는다
  const wantKey = mailListKey({ filter: selection.filter, folder: selection.folder, query: selection.query.trim() || undefined, includeMuted: selection.includeMuted });
  const listFresh = list.status === 'ready' && list.queryKey === wantKey;
  const index = reselectIndex(rows, selection);
  const row: MailThreadRow | null = index >= 0 ? rows[index] : null;
  const rowIsPicked = !!row && (row.id === selection.threadId || selection.threadKeys.includes(row.latestKey));
  // 바깥에서 고른 스레드가 아직 목록에 없으면(옛 질의·200줄 밖) 그 스레드를 그대로 읽기 칸에 둔다
  const threadId = selection.pin && selection.threadId && !rowIsPicked ? selection.threadId : (row?.id ?? null);
  const thread = useMailThread(threadId, revision);
  const detail = thread.detail && thread.detail.id === threadId ? thread.detail : null;
  const mail = pickMail(detail, selection.mailKey);
  const message = useMailMessage(mail?.path ?? null);

  // 목록이 새로 오면 고른 스레드를 다시 잡는다(id → 메일 키 → 같은 자리). 지금 질의의 목록일 때만
  const pinLoadAt = useRef(-1);
  const { loadMore, loadingMore } = list;
  const loaded = rows.length;
  const more = loaded < list.page.total;
  useEffect(() => {
    if (!listFresh) return;
    if (selection.pin && selection.threadId && !rowIsPicked) {
      // 바깥에서 고른 스레드가 받은 줄 밖이면 더 받아 찾는다(더 받아도 줄이 늘지 않으면 그만)
      if (more && pinLoadAt.current < loaded) {
        if (!loadingMore) {
          pinLoadAt.current = loaded;
          loadMore();
        }
        return;
      }
      if (more && loadingMore) return;
    }
    pinLoadAt.current = -1;
    if (!row) {
      if (selection.threadId !== null || selection.pin) onSelectionChange((s) => ({ ...s, threadId: null, threadKeys: [], mailKey: null, pin: false, readHold: false }));
      return;
    }
    if (row.id === selection.threadId && index === selection.index && !selection.pin) return;
    onSelectionChange((s) => {
      const sameThread = s.threadKeys.includes(row.latestKey) || row.id === s.threadId;
      // 「미확인」에서 고른 스레드가 빠져 다음 줄이 저절로 보이면 그 줄은 읽음으로 바꾸지 않는다(§3-2 — 줄줄이 읽음 막기)
      const readHold = sameThread ? s.readHold === true : s.threadId !== null && s.filter === 'unread';
      return {
        ...s,
        threadId: row.id,
        index,
        threadKeys: sameThread ? s.threadKeys : [row.latestKey],
        mailKey: sameThread ? s.mailKey : null,
        pin: false,
        readHold,
      };
    });
  }, [listFresh, row, rowIsPicked, index, more, loaded, loadingMore, loadMore, selection.threadId, selection.index, selection.pin, onSelectionChange]);

  // 스레드를 읽으면 그 메일 키들을 기억한다(스레드 id 가 바뀌어도 다시 찾게)
  useEffect(() => {
    if (!detail) return;
    const keys = threadKeys(detail);
    onSelectionChange((s) => (s.threadId === detail.id && s.threadKeys.join('|') !== keys.join('|') ? { ...s, threadKeys: keys } : s));
  }, [detail, onSelectionChange]);

  // 바깥에서 연 메일(view:mail:<키>): 그 스레드가 보이는 필터로 바꾸고 고른다
  const { target, onTargetDone } = props;
  useEffect(() => {
    if (!target) return;
    let live = true;
    void (async () => {
      const id = await findThreadOf(target.key);
      const api = mailboxApi();
      const found = id && api ? await api.getMailThread(id).catch(() => null) : null;
      if (!live) return;
      if (found && Array.isArray(found.mails)) onSelectionChange(selectionForTarget(found, target.key));
      else props.notify('그 메일을 메일함에서 찾지 못했습니다. 옮겨졌거나 지워졌을 수 있습니다.');
      onTargetDone(target.seq);
    })();
    return () => {
      live = false;
    };
    // target 이 바뀔 때만
  }, [target]);

  // ── 상태 바꾸기 ──
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<SaveNoticeData | null>(null);
  const [undo, setUndo] = useState<UndoState | null>(null);
  const noticeSeq = useRef(0);
  const skipRead = useRef<string | null>(null);

  const change = useCallback(
    async (keys: string[], ch: Parameters<typeof changeMailState>[1], failText: string): Promise<boolean> => {
      if (keys.length === 0) return false;
      setBusy(true);
      try {
        await changeMailState(keys, ch);
        return true;
      } catch (err) {
        props.notify(`${failText} (${errorText(err)})`);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [props.notify],
  );

  // 읽음: 읽기 칸에 1초 넘게 머문 스레드만(§3-2) — 그 스레드의 미확인 메일 모두(스레드 단위 §3-3).
  // [미확인으로] 바로 뒤에는 다시 읽음으로 바꾸지 않는다. 저절로 보이는 줄(readHold)·아직 잡히지 않은 선택도 바꾸지 않는다
  const settled = threadId !== null && threadId === selection.threadId && selection.readHold !== true;
  const readKeys = settled && selection.sub === 'read' ? threadReadKeys(detail, mail) : [];
  const readKey = readKeys.length > 0 && mail ? mail.key : null;
  const readKeysRef = useRef(readKeys);
  readKeysRef.current = readKeys;
  useEffect(() => {
    if (!readKey || skipRead.current === readKey) return;
    // 창이 숨어 있으면(사이드바 모드) 사람이 본 것이 아니다 — 읽음으로 바꾸지 않는다
    const t = window.setTimeout(() => {
      if (document.visibilityState === 'hidden') return;
      const keys = readKeysRef.current.length > 0 ? readKeysRef.current : [readKey];
      void changeMailState(keys, { read: true }).catch(() => undefined);
    }, MAIL_READ_DELAY_MS);
    return () => window.clearTimeout(t);
  }, [readKey]);
  useEffect(() => {
    if (mail?.key !== skipRead.current) skipRead.current = null;
  }, [mail?.key]);

  const archived = threadArchived(detail);
  const archive = useCallback(async (): Promise<void> => {
    if (!detail || busy) return;
    const keys = threadKeys(detail);
    const next = !archived;
    if (await change(keys, { archived: next }, next ? '처리함으로 옮기지 못했습니다.' : '받은편지함으로 되돌리지 못했습니다.')) {
      setUndo({ id: ++noticeSeq.current, keys, archived: next, text: archiveNoticeText(next, detail.subject) });
    }
  }, [detail, busy, archived, change]);
  const undoArchive = async (): Promise<void> => {
    if (!undo) return;
    const u = undo;
    setUndo(null);
    await change(u.keys, { archived: !u.archived }, '되돌리지 못했습니다.');
  };
  useEffect(() => {
    if (!undo) return;
    const t = window.setTimeout(() => setUndo((u) => (u && u.id === undo.id ? null : u)), 12_000);
    return () => window.clearTimeout(t);
  }, [undo]);

  const toggleReplyNeeded = useCallback(async (): Promise<void> => {
    if (!mail || busy) return;
    await change([mail.key], { replyNeeded: !mail.replyNeeded }, '회신 필요 표시를 바꾸지 못했습니다.');
  }, [mail, busy, change]);
  const markUnread = useCallback(async (): Promise<void> => {
    if (!mail || busy || mail.mine || mail.muted) return;
    skipRead.current = mail.key;
    await change([mail.key], { read: false }, '미확인으로 바꾸지 못했습니다.');
  }, [mail, busy, change]);

  // ── 동작 막힘 ──
  const replyKey = mail ? mailTargetKey(mail.path) : '';
  const { loadContext } = reply;
  useEffect(() => {
    if (replyKey && reply.supported) loadContext(replyKey);
    // 메일이 바뀔 때만(계정 준비 여부 — 회신 버튼을 막을지)
  }, [replyKey]);
  const replyCtx = replyKey ? contextOf(reply.contextOf(replyKey)) : undefined;
  const replyBlocked = !reply.supported
    ? '이 앱 연결에는 메일 회신 기능이 없습니다. 앱을 새 버전으로 다시 빌드해 주세요.'
    : replyCtx && !replyCtx.sender.ready
      ? (replyCtx.sender.problem ?? '메일 계정이 없습니다')
      : null;
  const vocEntry = useVocCreateEntry(replyKey || 'mail:');
  const vocDone = mailVocDone(mail, vocEntry.created?.number);
  const vocBlocked = !vocCreateSupported(true)
    ? '이 앱 연결에는 VOC 등록 기능이 없습니다. 앱을 새 버전으로 다시 빌드해 주세요.'
    : taskWriteBlock(props.vocBoard, '등록할');
  const taskSupported = typeof getRadar()?.createMailTask === 'function';
  const taskBlocked = mailTaskBlock({ personalMissing: props.personalMissing, supported: taskSupported, detail, mail });

  // ── [위키에 반영](2.14 §8) — 옛 preload 면 버튼을 숨긴다 ──
  const wikiSupported = mailWikiSupported(getRadar());
  const wikiState = mailWikiState(mail);
  const mailboxReady = state === 'ready' || state === 'error';
  const wikiBlocked = mailWikiBlock({
    personalMissing: props.personalMissing,
    mailboxReady,
    mail,
    suspicious: message.message?.suspicious === true,
  });
  const [wikiFormKey, setWikiFormKey] = useState<string | null>(null);
  /** 폼을 연 순간의 「이미 대기 중」 항목과 회차 — 열린 뒤 대기열·상태가 바뀌어도 폼을 다시 만들지 않는다(입력 보존) */
  const [wikiFormSnap, setWikiFormSnap] = useState<{ seq: number; existing?: QueueItem }>({ seq: 0 });
  const wikiOpen = !!mail && wikiFormKey === mail.key && !wikiBlocked;
  const queueMail = async (input: QueueMailInput): Promise<QueueMailResult> => {
    const api = getRadar();
    if (!api || typeof api.queueMailForWiki !== 'function') throw new Error('이 앱 연결에는 [위키에 반영] 기능이 없습니다.');
    return api.queueMailForWiki(input);
  };

  // ── [할 일로] ──
  const [taskFormKey, setTaskFormKey] = useState<string | null>(null);
  /** 분석의 할 일 후보(2.16) — 그 메일의 [할 일로] 칸을 채운다 */
  const [taskSuggest, setTaskSuggest] = useState<{ key: string; task: { title: string; due?: string } } | null>(null);
  const taskOpen = !!mail && taskFormKey === mail.key && !taskBlocked;
  const headingRef = useRef<HTMLHeadingElement>(null);
  const createTask = async (input: { path: string; title: string; pri?: number; due?: string }): Promise<CreateMailTaskOutput> => {
    const api = getRadar();
    if (!api || typeof api.createMailTask !== 'function') throw new Error('이 앱 연결에는 [할 일로] 기능이 없습니다.');
    return api.createMailTask(input);
  };

  const openReply = useCallback((): void => {
    if (!mail || replyBlocked) return;
    onSelectionChange((s) => ({ ...s, sub: 'reply', mailKey: mail.key }));
  }, [mail, replyBlocked, onSelectionChange]);
  const openVoc = useCallback((): void => {
    if (!mail) return;
    if (vocDone) {
      props.onOpenVoc(vocDone);
      return;
    }
    if (vocBlocked) return;
    onSelectionChange((s) => ({ ...s, sub: 'voc', mailKey: mail.key }));
  }, [mail, vocDone, vocBlocked, onSelectionChange, props.onOpenVoc]);
  const openTask = useCallback((): void => {
    if (!mail || taskBlocked) return;
    setWikiFormKey(null);
    setTaskSuggest(null);
    setTaskFormKey(mail.key);
  }, [mail, taskBlocked]);
  const openTaskSuggested = useCallback(
    (task: { title: string; due?: string }): void => {
      if (!mail || taskBlocked) return;
      setWikiFormKey(null);
      setTaskSuggest({ key: mail.key, task });
      setTaskFormKey(mail.key);
    },
    [mail, taskBlocked],
  );
  const { onOpenQueue, queueItems } = props;
  const openWiki = useCallback((): void => {
    if (!mail || !wikiSupported || wikiBlocked) return;
    // 반영 중이면 반영 대기 화면으로(그동안 바꿀 수 없다)
    if (wikiState === 'running') {
      onOpenQueue?.();
      return;
    }
    setTaskFormKey(null);
    const existing = wikiState === 'queued' ? mailWikiExisting(queueItems ?? [], detail, mail) : undefined;
    setWikiFormSnap((s) => ({ seq: s.seq + 1, ...(existing ? { existing } : {}) }));
    setWikiFormKey(mail.key);
  }, [mail, wikiSupported, wikiBlocked, wikiState, onOpenQueue, queueItems, detail]);
  // 폼이 열린 채 이 메일이 반영 실행에 들어가면 폼을 닫고 알린다(그동안 바꿀 수 없다 — main 도 막는다)
  useEffect(() => {
    if (!wikiOpen || wikiState !== 'running') return;
    setWikiFormKey(null);
    setNotice({
      id: ++noticeSeq.current,
      tone: 'warn',
      title: '이 메일을 지금 위키에 반영하는 중이라 폼을 닫았습니다.',
      lines: [{ text: '반영이 끝난 뒤 다시 [위키에 반영]을 누르세요.' }],
    });
  }, [wikiOpen, wikiState]);
  const back = (): void => {
    onSelectionChange((s) => ({ ...s, sub: 'read' }));
    refocusIfLost(() => headingRef.current, undefined, 6);
  };

  // ── 키보드(§8-4) ──
  const listRef = useRef<HTMLDivElement>(null);
  const readerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const registerRow = useCallback((id: string, el: HTMLButtonElement | null) => {
    if (el) rowRefs.current.set(id, el);
    else rowRefs.current.delete(id);
  }, []);
  const selectRow = useCallback(
    (r: MailThreadRow, i: number) => {
      onSelectionChange((s) => ({ ...s, threadId: r.id, threadKeys: [r.latestKey], mailKey: null, index: i, sub: 'read', pin: false, readHold: false }));
      setTaskFormKey(null);
      setWikiFormKey(null);
    },
    [onSelectionChange],
  );
  useEffect(() => {
    if (threadId) rowRefs.current.get(threadId)?.scrollIntoView({ block: 'nearest' });
  }, [threadId]);

  const keyState = useRef({ rows, index, detail, mail });
  keyState.current = { rows, index, detail, mail };
  const actions = useRef({ openReply, openVoc, openTask, openWiki, archive, toggleReplyNeeded, markUnread });
  actions.current = { openReply, openVoc, openTask, openWiki, archive, toggleReplyNeeded, markUnread };
  const sub = selection.sub;
  useEffect(() => {
    if (!active || sub !== 'read') return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented) return;
      const target = e.target instanceof Element ? e.target : null;
      // [위키에 반영] 폼이 열려 그 안에 초점이 있으면 목록 단축키를 쓰지 않는다(2.14 §8-2 — Esc 는 폼이 닫는다)
      if (target?.closest('[data-testid="mail-wiki-form"]')) return;
      const inList = !!target && !!listRef.current?.contains(target);
      const act = mailKeyAction({
        key: e.key,
        altKey: e.altKey,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        shiftKey: e.shiftKey,
        editable: isEditable(target),
        inDialog: inDialog(target),
        inList,
      });
      if (!act) return;
      const { rows: rs, index: i, detail: d, mail: m } = keyState.current;
      const a = actions.current;
      const focusFree = !target || target === document.body || target === document.documentElement;
      switch (act) {
        case 'next':
        case 'prev': {
          if (rs.length === 0) return;
          e.preventDefault();
          const next = Math.min(rs.length - 1, Math.max(0, (i < 0 ? -1 : i) + (act === 'next' ? 1 : -1)));
          selectRow(rs[next], next);
          const el = rowRefs.current.get(rs[next].id);
          if (inList || focusFree) el?.focus();
          else el?.scrollIntoView({ block: 'nearest' });
          return;
        }
        case 'enterReader':
          e.preventDefault();
          headingRef.current?.focus();
          return;
        case 'toList': {
          e.preventDefault();
          const id = i >= 0 ? rs[i]?.id : undefined;
          (id ? rowRefs.current.get(id) : null)?.focus();
          return;
        }
        case 'search':
          e.preventDefault();
          searchRef.current?.focus();
          searchRef.current?.select();
          return;
        case 'prevMail':
        case 'nextMail': {
          const k = stepMail(d, m?.key ?? null, act === 'nextMail' ? 1 : -1);
          if (!k) return;
          e.preventDefault();
          onSelectionChange((s) => ({ ...s, mailKey: k, readHold: false }));
          return;
        }
        case 'reply':
          e.preventDefault();
          a.openReply();
          return;
        case 'archive':
          e.preventDefault();
          void a.archive();
          return;
        case 'replyNeeded':
          e.preventDefault();
          void a.toggleReplyNeeded();
          return;
        case 'unread':
          e.preventDefault();
          void a.markUnread();
          return;
        case 'voc':
          e.preventDefault();
          a.openVoc();
          return;
        case 'task':
          e.preventDefault();
          a.openTask();
          return;
        case 'wiki':
          e.preventDefault();
          a.openWiki();
          return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, sub, selectRow, onSelectionChange]);

  const counts = list.page.counts;
  const latest = latestText(summary?.latestDate, today);
  const filterLabel: Record<MailFilter, string> = { all: '받은 메일', unread: '미확인', replyNeeded: '회신 필요', archived: '처리함' };

  const shell = (children: ReactElement | ReactElement[], cls = 'mb'): ReactElement => (
    <section className={cls} data-testid="mailbox-view" data-state={supported ? state : 'unsupported'} aria-label="메일함">
      {children}
    </section>
  );

  if (!supported) {
    return shell(
      <div className="mb-unavailable" data-testid="mailbox-unavailable">
        <EmptyState title="메일함을 쓸 수 없습니다.">이 앱 연결에는 메일함 기능이 없습니다. 앱을 새 버전으로 다시 빌드해 주세요.</EmptyState>
      </div>,
      'mb mb--single',
    );
  }
  if (unavailable) {
    return shell(
      <div className="mb-unavailable" data-testid="mailbox-unavailable">
        <EmptyState title="메일함을 쓸 수 없습니다.">{unavailable}</EmptyState>
        <button type="button" className="btn btn--secondary" onClick={props.onOpenSetup}>
          <IconSettings size={16} />
          설정 › 점검
        </button>
      </div>,
      'mb mb--single',
    );
  }
  if (!active) {
    const p = summary?.progress;
    return shell(
      <div className="mb-unavailable">
        <LoadingState text={p && p.total > 0 ? `메일을 읽는 중입니다… (${p.done.toLocaleString('ko-KR')}/${p.total.toLocaleString('ko-KR')})` : '메일을 읽는 중입니다…'} />
      </div>,
      'mb mb--single',
    );
  }

  if (sub !== 'read' && mail && detail) {
    return shell(
      sub === 'reply' ? (
        <MailReplyView
          mail={mail}
          detail={detail}
          message={message.message}
          reply={reply}
          today={today}
          claudeMissing={props.claudeMissing}
          onOpenMailSettings={props.onOpenMailSettings}
          onBack={back}
          onOpenFile={props.onOpenFile}
          onOpenTask={props.onOpenTask}
          onSent={(n) => {
            setNotice(n);
            onSelectionChange((s) => ({ ...s, sub: 'read' }));
          }}
          nextNoticeId={() => ++noticeSeq.current}
        />
      ) : (
        <MailVocView mail={mail} detail={detail} today={today} onBack={back} onOpenVoc={props.onOpenVoc} />
      ),
      'mb mb--sub',
    );
  }

  const listEmpty =
    list.status === 'error'
      ? { title: '목록을 불러오지 못했습니다.', detail: list.message }
      : list.status !== 'ready'
        ? { title: '불러오는 중입니다…' }
        : selection.query.trim() || selection.folder
          ? { title: '맞는 메일이 없습니다.', detail: '검색어나 메일함 고르기를 바꿔 보세요.' }
          : selection.filter === 'all'
            ? { title: '받은편지함이 비었습니다.', detail: '새 메일이 오면 여기에 나타납니다.' }
            : { title: `${filterLabel[selection.filter]} 메일이 없습니다.` };

  const taskForm =
    taskOpen && mail ? (
      <MailTaskForm
        key={`${mail.key}:${taskSuggest?.key === mail.key ? taskSuggest.task.title : ''}`}
        path={mail.path}
        subject={mail.subject}
        {...(taskSuggest?.key === mail.key ? { suggest: taskSuggest.task } : {})}
        onCreate={createTask}
        onDone={(out, title) => {
          setTaskFormKey(null);
          const lines = [{ text: `${out.file} 「메일 회신 대기」 절 끝에 줄 하나를 넣었습니다.` }];
          if (out.backupDir) lines.push({ text: `백업: ${out.backupDir}` });
          for (const w of out.warnings) lines.push({ text: w, warn: true } as { text: string; warn?: boolean });
          setNotice({ id: ++noticeSeq.current, tone: out.warnings.length > 0 ? 'warn' : 'ok', title: `‘${title}’ 를 내 할 일에 넣었습니다`, lines });
          refocusIfLost(() => headingRef.current);
        }}
        onFail={(msg) => setNotice({ id: ++noticeSeq.current, tone: 'error', title: '할 일을 만들지 못했습니다.', lines: [{ text: msg, warn: true }] })}
        onCancel={() => {
          setTaskFormKey(null);
          refocusIfLost(() => headingRef.current);
        }}
      />
    ) : undefined;

  const wikiExisting = wikiFormSnap.existing;
  const wikiForm =
    wikiOpen && mail && detail ? (
      <MailWikiForm
        key={`${mail.key}:${wikiFormSnap.seq}`}
        mailKey={mail.key}
        threadCount={detail.mails.length}
        threadSuspicious={threadHasSuspicious(detail)}
        attachments={message.message?.attachments.length ?? mail.attachments}
        existing={wikiExisting}
        reflectedAt={mail.wiki && (mail.wiki.state === 'done' || mail.wiki.state === 'skipped') ? mail.wiki.at : undefined}
        today={today}
        onSubmit={queueMail}
        onDone={(item, warnings) => {
          setWikiFormKey(null);
          const lines = [{ text: '반영 대기 화면의 [위키에 반영]을 누를 때 Claude Code 로 보냅니다.' } as { text: string; warn?: boolean }];
          for (const w of warnings) lines.push({ text: w, warn: true });
          setNotice({ id: ++noticeSeq.current, tone: warnings.length > 0 ? 'warn' : 'ok', title: `‘${item.title}’ 을 반영 대기에 넣었습니다`, lines });
          refocusIfLost(() => headingRef.current);
        }}
        onCancel={() => {
          setWikiFormKey(null);
          refocusIfLost(() => headingRef.current);
        }}
        onOpenQueue={() => props.onOpenQueue?.()}
      />
    ) : undefined;

  const noticeEl = (
    <>
      {undo && (
        <div className="mb-undo" role="status" data-testid="mail-undo">
          <span>{undo.text}</span>
          <button type="button" className="link-btn" data-testid="btn-mail-undo" onClick={() => void undoArchive()}>
            <IconUndo size={14} />
            되돌리기
          </button>
        </div>
      )}
      {notice && (
        <SaveNotice
          notice={notice}
          onClose={() => setNotice(null)}
          action={
            notice.tone !== 'error' && notice.title.endsWith('내 할 일에 넣었습니다') ? (
              <button type="button" className="link-btn" data-testid="btn-mail-task-show" onClick={props.onOpenTasks}>
                할 일 보기
              </button>
            ) : notice.tone !== 'error' && notice.title.endsWith('반영 대기에 넣었습니다') && props.onOpenQueue ? (
              <button type="button" className="link-btn" data-testid="btn-mail-wiki-show" onClick={props.onOpenQueue}>
                반영 대기 보기
              </button>
            ) : undefined
          }
        />
      )}
    </>
  );

  return shell(
    <>
      <MailFilters
        filter={selection.filter}
        counts={counts}
        query={selection.query}
        includeMuted={selection.includeMuted}
        folder={selection.folder}
        folders={list.page.folders}
        total={summary?.total ?? 0}
        latest={latest}
        onFilter={(f) => onSelectionChange((s) => ({ ...s, filter: f, index: 0, threadId: null, threadKeys: [], mailKey: null, pin: false, readHold: false }))}
        onQuery={(q) => onSelectionChange((s) => ({ ...s, query: q, pin: false }))}
        onIncludeMuted={(on) => onSelectionChange((s) => ({ ...s, includeMuted: on, pin: false }))}
        onFolder={(f) => onSelectionChange((s) => ({ ...s, folder: f, index: 0, threadId: null, threadKeys: [], mailKey: null, pin: false, readHold: false }))}
        searchRef={searchRef}
      />
      <section className="mb-list" aria-label="메일 목록">
        <div className="mb-list-head">
          <h2 className="mb-list-title">
            <IconMail size={16} />
            {selection.folder ?? filterLabel[selection.filter]}
          </h2>
          <span className="mb-list-count">
            스레드 {list.page.total.toLocaleString('ko-KR')}개{summary?.state === 'error' && summary.problem ? ` · ${summary.problem}` : ''}
          </span>
        </div>
        <MailThreadList
          ref={listRef}
          rows={rows}
          total={list.page.total}
          today={today}
          selectedId={threadId}
          focusableId={threadId ?? rows[0]?.id ?? null}
          onSelect={(r) => selectRow(r, rows.indexOf(r))}
          registerRow={registerRow}
          onMore={list.loadMore}
          loadingMore={list.loadingMore}
          emptyTitle={listEmpty.title}
          emptyDetail={listEmpty.detail}
        />
      </section>
      <div className="mb-reader-wrap" ref={readerRef}>
        <MailReader
          thread={detail ? thread : threadId ? { status: thread.status === 'ready' ? 'loading' : thread.status, detail: null, message: thread.message } : { status: 'idle', detail: null }}
          mail={mail}
          message={message}
          today={today}
          archived={archived}
          replyNeeded={!!mail?.replyNeeded}
          reply={{ blocked: replyBlocked }}
          voc={{ blocked: vocBlocked, done: vocDone }}
          task={{ blocked: taskBlocked }}
          wiki={wikiSupported ? { blocked: wikiBlocked, state: wikiState } : undefined}
          busy={busy}
          onReply={openReply}
          onVoc={openVoc}
          onTask={openTask}
          onTaskSuggest={openTaskSuggested}
          onWiki={wikiSupported ? openWiki : undefined}
          onOpenQueue={props.onOpenQueue}
          onArchive={() => void archive()}
          onReplyNeeded={() => void toggleReplyNeeded()}
          onUnread={() => void markUnread()}
          onOpenFile={props.onOpenFile}
          onSelectMail={(k) => onSelectionChange((s) => ({ ...s, mailKey: k, readHold: false }))}
          onReveal={(i) => {
            if (!mail) return;
            revealAttachment(mail.path, i).catch((err: unknown) => props.notify(`폴더를 열지 못했습니다. (${errorText(err)})`));
          }}
          onOpenTask={props.onOpenTask}
          onOpenVoc={props.onOpenVoc}
          taskForm={taskForm}
          wikiForm={wikiForm}
          notice={noticeEl}
          headingRef={headingRef}
        />
      </div>
    </>,
  );
}

/** 메일함 화면이 쓰는 「지금 고른 스레드가 아직 목록에 있는가」 — FullView 가 바깥 요청 뒤 쓴다 */
export function useMailTargetState(): [MailTarget | null, (key: string) => void, (seq: number) => void] {
  const [target, setTarget] = useState<MailTarget | null>(null);
  const seq = useRef(0);
  const open = useCallback((key: string) => setTarget({ key, seq: ++seq.current }), []);
  const done = useCallback((s: number) => setTarget((t) => (t && t.seq === s ? null : t)), []);
  return useMemo(() => [target, open, done], [target, open, done]);
}
