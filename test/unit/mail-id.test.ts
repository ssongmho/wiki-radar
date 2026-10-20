// 2.15단계 §A-7 메일 ID 연결: [mail:: m:<16자>] — 줄 파서·같은 메일 줄 찾기·[할 일로] 줄·연결 계산.
import { describe, expect, it } from 'vitest';
import type { MailIndexEntry, Task } from '../../src/shared/types';
import { computeMailLinks } from '../../src/main/mail/mailLinks';
import { MAIL_KEY_RE, parseFields } from '../../src/main/wiki/checkbox';
import { buildThreads, parseMailHead } from '../../src/main/wiki/mailIndex';
import { findExistingMailTask, mailTaskLine } from '../../src/main/wiki/mailTask';
import { mailRel, mailText } from './mailFixtures';

describe('메일 ID', () => {
  it('줄 파서: 옛 경로와 메일 ID 를 받고 그 밖은 버린다', () => {
    expect(parseFields('- [ ] a [mail:: m:0123456789abcdef]').mail).toBe('m:0123456789abcdef');
    expect(parseFields('- [ ] a [mail:: raw/mail/x/2026/y.md]').mail).toBe('raw/mail/x/2026/y.md');
    expect(parseFields('- [ ] a [mail:: m:XYZ]').mail).toBeUndefined();
    expect(MAIL_KEY_RE.test('u:0123456789abcdef')).toBe(true);
  });

  it('[할 일로] 줄은 메일 ID, 같은 메일 찾기는 ID·옛 경로 둘 다', () => {
    const line = mailTaskLine({ title: '회신', mail: 'm:0123456789abcdef', thread: '견적', opened: '2026-10-19' });
    expect(line).toBe('- [ ] 회신 #내할일 [mail:: m:0123456789abcdef] [thread:: 견적] [opened:: 2026-10-19]');
    const lines = ['## x', '- [ ] 옛 줄 [mail:: raw/mail/a/2026/[견적] b.md]'];
    expect(findExistingMailTask(lines, 'm:0123456789abcdef', '', 'raw/mail/a/2026/[견적] b.md')).toBe(2);
    expect(findExistingMailTask(['- [x] 새 줄 [mail:: m:0123456789abcdef]'], 'm:0123456789abcdef', '')).toBe(1);
    expect(findExistingMailTask(lines, 'm:ffffffffffffffff', '')).toBe(0);
  });

  it('연결 계산: task.mail 이 메일 ID 면 그 키의 메일에 잇는다', () => {
    const head = parseMailHead(mailRel('대륙물산', 'k1'), mailText({ subject: '자재 단가 문의 건', date: '2026-09-21T11:00:00+09:00', messageId: 'k1@x', folder: '대륙물산' }));
    const e: MailIndexEntry = { ...head, size: 1, mtimeMs: 1 };
    const t: Task = { id: 'c:t9', source: 'checkbox', title: '단가 회신', status: 'open', bucket: 'thisWeek', mail: e.key };
    const r = computeMailLinks({ entries: [e], threads: buildThreads([e]), tasks: [t], marks: () => undefined, sent: [] });
    expect(r.byMail.get(e.key)?.tasks.map((x) => x.id)).toEqual(['c:t9']);
  });
});
