// 메일함 [할 일로] — `내 할 일.md` 「메일 회신 대기」 절 끝에 줄 하나(docs/stage2.10-contract.md §7-3).
// electron 을 import 하지 않는 순수 모듈이다. 줄 형식은 `WIKI/_mail-ingest/open_loops.py cmd_add` 와 글자까지 같다:
//
//     fields = ["#내할일"]
//     if args.pri:  fields.append("[pri:: {}]".format(args.pri))
//     if args.due:  fields.append("[due:: {}]".format(args.due))
//     if mail:      fields.append("[mail:: {}]".format(mail))
//     if thread:    fields.append("[thread:: {}]".format(thread))
//     fields.append("[opened:: {}]".format(args.opened or today.isoformat()))
//     items.append(Item("- [ ] {} {}".format(title, " ".join(fields))))
//
// 다른 점(결정): open_loops 는 같은 mail/thread 가 있으면 thread 만 갱신하지만, 앱은 줄을 바꾸지 않고 거부한다.
// 절이 없으면 open_loops 는 절을 만들지만, 앱은 문서 구조를 만들지 않고 거부한다.
import { isGroupableThreadKey } from '../../shared/mailThread';
import { pyRstrip, pyStrip } from './pystr';
import { WIKI_PATHS } from './snapshot';
import { EditRefusedError, applyFileEditWith, type LineFieldResult, type WritebackHooks } from './writeback';

/** open_loops.py SECTION */
export const MAIL_TASK_SECTION = '## 메일 회신 대기 (브리핑 자동 적재)';
export const MAIL_TASK_FILE = WIKI_PATHS.myTasks;

export const MAIL_TASK_NO_SECTION = '`내 할 일.md` 에 「메일 회신 대기」 절이 없어 넣지 않았습니다';

export interface MailTaskLineInput {
  title: string;
  pri?: number;
  due?: string;
  /** 메일 ID(`m:<16자>` — 2.15) 또는 옛 꼴 볼트 기준 raw/mail/…md */
  mail: string;
  /** 같은 메일 줄 찾기에 더 보는 값(2.15 — 메일 ID 로 쓸 때 옛 경로) */
  altMail?: string;
  /** normThread(제목) — 비었으면 넣지 않는다 */
  thread: string;
  /** 메일 날짜 YYYY-MM-DD */
  opened: string;
}

/** open_loops cmd_add 와 같은 줄 */
export function mailTaskLine(input: Omit<MailTaskLineInput, 'altMail'> & { altMail?: string }): string {
  const fields = ['#내할일'];
  if (input.pri !== undefined) fields.push(`[pri:: ${input.pri}]`);
  if (input.due) fields.push(`[due:: ${input.due}]`);
  if (input.mail) fields.push(`[mail:: ${input.mail.replace(/\\/g, '/')}]`);
  if (input.thread) fields.push(`[thread:: ${input.thread}]`);
  fields.push(`[opened:: ${input.opened}]`);
  return `- [ ] ${pyStrip(input.title)} ${fields.join(' ')}`;
}

const CHECKBOX_RE = /^\s*[-*+]\s+\[.\]/;

/**
 * 이미 같은 메일·스레드의 줄이 있는가([x] 포함 — open_loops 의 멱등 규칙과 같다). 줄 번호(1부터)를 돌려준다. 경로에 대괄호가 들어갈 수 있어(실제 메일 파일 이름)
 * 필드 파서 대신 `[mail:: 경로]`·`[thread:: 키]` 글자로 찾는다.
 */
export function findExistingMailTask(lines: readonly string[], mail: string, thread: string, altMail?: string): number {
  const mailTag = `[mail:: ${mail}]`;
  const altTag = altMail ? `[mail:: ${altMail}]` : null;
  // 흔한 제목·짧은 키(「문의」 등)는 스레드로 묶지 않으므로(§2-3) 같은 키라도 다른 메일이다 — 경로로만 본다
  const threadTag = thread && isGroupableThreadKey(thread) ? `[thread:: ${thread}]` : null;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (!CHECKBOX_RE.test(ln)) continue;
    if (ln.includes(mailTag) || (altTag !== null && ln.includes(altTag)) || (threadTag !== null && ln.includes(threadTag))) return i + 1;
  }
  return 0;
}

/** 절 끝(다음 `## ` 앞, 끝의 빈 줄 앞)에 줄을 넣은 새 줄 목록. 절이 없으면 EditRefusedError */
export function insertIntoSection(lines: readonly string[], line: string): string[] {
  const s = lines.findIndex((l) => pyRstrip(l) === MAIL_TASK_SECTION);
  if (s < 0) throw new EditRefusedError(MAIL_TASK_NO_SECTION);
  let e = lines.length;
  for (let j = s + 1; j < lines.length; j++) {
    if (lines[j].startsWith('## ')) {
      e = j;
      break;
    }
  }
  let at = e;
  while (at > s + 1 && pyStrip(lines[at - 1]) === '') at--;
  const out = lines.slice();
  // 절 머리 바로 뒤(빈 절)면 빈 줄 하나를 두고 넣는다
  if (at === s + 1) {
    out.splice(at, 0, '', line);
    return out;
  }
  out.splice(at, 0, line);
  return out;
}

export interface AppendTaskLineInput extends MailTaskLineInput {
  wikiRoot: string;
  now?: Date;
}

/**
 * [할 일로] 줄 넣기. 같은 [mail:: 경로]·[thread:: 키] 줄이 있으면 거부("이미 할 일이 있습니다"), 절이 없으면 거부.
 * 안전장치는 2단계 writeback 과 같다(applyFileEditWith). 결과의 line 은 넣은 줄.
 */
export function appendTaskLine(input: AppendTaskLineInput, hooks: WritebackHooks = {}): LineFieldResult & { line: string } {
  const line = mailTaskLine(input);
  const result = applyFileEditWith(
    { wikiRoot: input.wikiRoot, rel: MAIL_TASK_FILE, ...(input.now ? { now: input.now } : {}) },
    (lines) => {
      const dup = findExistingMailTask(lines, input.mail, input.thread, input.altMail);
      if (dup > 0) throw new EditRefusedError(`이미 할 일이 있습니다(${MAIL_TASK_FILE} ${dup}번째 줄)`);
      return insertIntoSection(lines, line);
    },
    hooks,
  );
  return { ...result, line };
}
