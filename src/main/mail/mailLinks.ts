// 메일 ↔ 할 일·VOC·발송 기록 연결(docs/stage2.10-contract.md §4). electron 을 import 하지 않는 순수 모듈이다.
// 기존 데이터에서 알 수 있는 범위만 표시한다 — 모두 읽기 전용 판정이다.
import type { MailIndexEntry, MailKey, MailRowLinks, MailThreadLinks, MailWikiMark, SentMailRecord, Task } from '../../shared/types';
import { isGroupableThreadKey, normThread } from '../../shared/mailThread';
import { lineFieldValue } from '../wiki/writeback';
import type { MailThread } from '../wiki/mailIndex';
import type { MailMark } from './mailState';

/** 메일 한 통의 연결 */
export interface MailLinkInfo {
  /** task.mail 이 이 메일 경로이거나 task.thread 가 이 메일의 threadKey 인 열린 할 일 */
  tasks: Task[];
  /** 위 할 일 줄의 [voc::] + 메일함 등록(mark.voc) */
  voc: string[];
  /** mark.task(메일함에서 만든 줄 — 완료돼 스냅샷에 없어도 남는다) */
  taskFile?: string;
  /** 이 메일 경로로 보낸 회신(최근 것부터) */
  sent: SentMailRecord[];
  /** 같은 스레드에 이 메일보다 늦은 내 사본의 date */
  replyGuess?: string;
}

export interface MailLinksInput {
  entries: readonly MailIndexEntry[];
  threads: readonly MailThread[];
  tasks: readonly Task[];
  marks: (key: MailKey) => MailMark | undefined;
  sent: readonly SentMailRecord[];
  /** 2.14: 메일별 위키 반영 표시(대기·반영 중·반영됨). 없으면 표시 없음 */
  wiki?: (key: MailKey) => MailWikiMark | undefined;
}

export interface MailLinksResult {
  byMail: Map<MailKey, MailLinkInfo>;
  /** 스레드 id → 목록 줄 칩 */
  rowLinks: Map<string, MailRowLinks>;
  /** 스레드 id → 상세 연결 */
  threadLinks: Map<string, MailThreadLinks>;
}

function timeOf(iso: string | undefined): number {
  if (!iso) return Number.NEGATIVE_INFINITY;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
}

/** 할 일의 스레드 키(줄의 [thread::] 를 normThread 로 — open_loops 가 이미 정규화해 적는다) */
function taskThreadKey(t: Task): string | undefined {
  if (typeof t.thread !== 'string' || t.thread.trim() === '') return undefined;
  const key = normThread(t.thread);
  return isGroupableThreadKey(key) ? key : undefined;
}

/**
 * 연결 계산(§4). 경로 비교는 '/'·대소문자 그대로. 메일함을 옮겨 경로가 바뀐 메일은 threadKey 로만 잡힌다.
 * 회신 추정 = 같은 스레드에 이 메일보다 늦은 내 사본(open_loops [회신추정::] 과 같은 생각 — 상태를 바꾸지 않는다).
 */
export function computeMailLinks(input: MailLinksInput): MailLinksResult {
  const byPathTasks = new Map<string, Task[]>();
  const byThreadTasks = new Map<string, Task[]>();
  for (const t of input.tasks) {
    if (!t || typeof t !== 'object') continue;
    if (typeof t.mail === 'string' && t.mail !== '') {
      const p = t.mail.replace(/\\/g, '/');
      const arr = byPathTasks.get(p) ?? [];
      arr.push(t);
      byPathTasks.set(p, arr);
    }
    const key = taskThreadKey(t);
    if (key) {
      const arr = byThreadTasks.get(key) ?? [];
      arr.push(t);
      byThreadTasks.set(key, arr);
    }
  }
  const sentByPath = new Map<string, SentMailRecord[]>();
  for (const r of input.sent) {
    if (!r || typeof r.mail !== 'string') continue;
    const arr = sentByPath.get(r.mail) ?? [];
    arr.push(r);
    sentByPath.set(r.mail, arr);
  }
  for (const arr of sentByPath.values()) arr.sort((a, b) => timeOf(b.at) - timeOf(a.at));

  const entryByKey = new Map<MailKey, MailIndexEntry>();
  for (const e of input.entries) entryByKey.set(e.key, e);

  const byMail = new Map<MailKey, MailLinkInfo>();
  const rowLinks = new Map<string, MailRowLinks>();
  const threadLinks = new Map<string, MailThreadLinks>();

  for (const th of input.threads) {
    const mails = th.mailKeys.map((k) => entryByKey.get(k)).filter((e): e is MailIndexEntry => !!e);
    const threadTasks = new Map<string, Task>();
    const threadVoc: string[] = [];
    const threadSent: SentMailRecord[] = [];
    let taskFiles = 0;

    for (let i = 0; i < mails.length; i++) {
      const e = mails[i];
      const mark = input.marks(e.key);
      const tasks: Task[] = [];
      // task.mail 은 옛 꼴(경로) 또는 2.15 메일 ID(키) — 둘 다 같은 표에 넣었다
      for (const t of [...(byPathTasks.get(e.path) ?? []), ...(byPathTasks.get(e.key) ?? []), ...(isGroupableThreadKey(e.threadKey) ? byThreadTasks.get(e.threadKey) ?? [] : [])]) {
        if (!tasks.includes(t)) tasks.push(t);
      }
      const voc: string[] = [];
      for (const t of tasks) {
        const v = typeof t.rawLine === 'string' ? lineFieldValue(t.rawLine, 'voc') : undefined;
        if (v && !voc.includes(v)) voc.push(v);
      }
      if (mark?.voc?.number && !voc.includes(mark.voc.number)) voc.push(mark.voc.number);
      const sent = sentByPath.get(e.path) ?? [];
      let replyGuess: string | undefined;
      if (!e.mine) {
        const later = mails.slice(i + 1).find((m) => m.mine && m.dateMs > e.dateMs);
        if (later) replyGuess = later.date;
      }
      const info: MailLinkInfo = { tasks, voc, sent };
      if (mark?.task?.file) info.taskFile = mark.task.file;
      if (replyGuess) info.replyGuess = replyGuess;
      byMail.set(e.key, info);

      for (const t of tasks) threadTasks.set(t.id, t);
      for (const v of voc) if (!threadVoc.includes(v)) threadVoc.push(v);
      for (const r of sent) if (!threadSent.includes(r)) threadSent.push(r);
      if (info.taskFile) taskFiles++;
    }
    threadSent.sort((a, b) => timeOf(b.at) - timeOf(a.at));

    // 회신 표시: 가장 최근 받은 메일(내 사본 아님) 뒤에 보낸 기록이 있으면 sent, 없고 그 뒤에 내 사본이 있으면 guess
    const incoming = mails.filter((m) => !m.mine);
    const lastIn = incoming[incoming.length - 1];
    let replied: MailRowLinks['replied'];
    let replyGuess: string | undefined;
    if (lastIn) {
      if (threadSent.some((r) => timeOf(r.at) >= lastIn.dateMs)) replied = 'sent';
      const mineAfter = mails.find((m) => m.mine && m.dateMs > lastIn.dateMs);
      if (mineAfter) {
        replyGuess = mineAfter.date;
        replied ??= 'guess';
      }
    }

    const row: MailRowLinks = { tasks: threadTasks.size + taskFiles };
    if (threadVoc.length > 0) row.voc = threadVoc[0];
    if (replied) row.replied = replied;
    // 위키 반영(2.14 §7-2): 대기·반영 중 메일이 하나라도 있으면 queued, 아니면 반영된 메일이 있으면 done
    if (input.wiki) {
      const states = mails.map((m) => input.wiki?.(m.key)?.state);
      if (states.some((s) => s === 'queued' || s === 'running')) row.wiki = 'queued';
      else if (states.includes('done')) row.wiki = 'done';
    }
    rowLinks.set(th.id, row);

    const detail: MailThreadLinks = {
      tasks: [...threadTasks.values()].map((t) => ({
        taskId: t.id,
        title: t.title,
        status: t.status,
        ...(t.mail ? { mail: t.mail } : {}),
      })),
      voc: threadVoc,
      sent: threadSent.map((r) => ({
        at: r.at,
        to: [...r.to],
        subject: r.subject,
        mail: r.mail,
        ...(r.origin ? { origin: r.origin } : {}),
      })),
    };
    if (replyGuess) detail.replyGuess = replyGuess;
    threadLinks.set(th.id, detail);
  }
  return { byMail, rowLinks, threadLinks };
}
