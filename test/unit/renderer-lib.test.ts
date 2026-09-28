// renderer 순수 함수(날짜 표기·할 일 표시값·스냅샷 정리, 2단계 처리 결과 입력·반영 대기열) 시험.
import { describe, expect, it } from 'vitest';
import { PARTIAL_SAVE_PREFIX } from '../../src/shared/ipc';
import type { QueueItem, ReflectRun, SaveResultOutput, Task } from '../../src/shared/types';
import * as D from '../../src/renderer/lib/date';
import * as T from '../../src/renderer/lib/tasks';
import * as S from '../../src/renderer/lib/snapshot';
import * as R from '../../src/renderer/lib/result';
import * as Q from '../../src/renderer/lib/queue';

const base = (p: Partial<Task>): Task => ({ id: 'x', source: 'checkbox', title: '제목', status: 'open', bucket: 'other', ...p });

describe('date', () => {
  it('parseYmd', () => {
    expect(D.parseYmd('2026-09-23')).toEqual({ year: 2026, month: 9, day: 23 });
    expect(D.parseYmd('2026-02-29')).toBeNull();
    expect(D.parseYmd('2024-02-29')).not.toBeNull();
    expect(D.parseYmd('2026-9-3')).toBeNull();
    expect(D.parseYmd(undefined)).toBeNull();
    expect(D.parseYmd(20260923)).toBeNull();
  });
  it('weekday', () => {
    expect(D.weekdayShort('2026-09-23')).toBe('수');
    expect(D.weekdayShort('2026-09-21')).toBe('월');
    expect(D.weekdayShort('2026-09-27')).toBe('일');
    expect(D.weekdayShort('2000-01-01')).toBe('토');
    expect(D.weekdayShort('2024-02-29')).toBe('목');
    expect(D.weekdayShort('bad')).toBe('');
  });
  it('formats', () => {
    expect(D.formatLongDate('2026-09-23')).toBe('9월 23일 수요일');
    expect(D.formatLongDate('2025-12-31', 2026)).toBe('2025년 12월 31일 수요일');
    expect(D.formatMonthDay('2026-09-18', 2026)).toBe('9월 18일');
    expect(D.formatSlash('2026-09-24')).toBe('9/24');
    expect(D.formatTrackLabel('2026-09-21')).toBe('월 21');
    expect(D.formatTrackLabel('x', 'fb')).toBe('fb');
    expect(D.formatLongDate('garbage')).toBe('garbage');
  });
  it('hour minute', () => {
    expect(D.formatHourMinute(0, 5)).toBe('오전 12:05');
    expect(D.formatHourMinute(12, 0)).toBe('오후 12:00');
    expect(D.formatHourMinute(17, 28)).toBe('오후 5:28');
    expect(D.formatHourMinute(9, 7)).toBe('오전 9:07');
  });
  it('mail date', () => {
    expect(D.formatMailDate('2026-09-15T17:28:40+09:00', { refYear: 2026, offsetMinutes: 540 })).toBe('9월 15일 오후 5:28');
    expect(D.formatMailDate('2026-09-15T08:28:40.000Z', { refYear: 2026, offsetMinutes: 540 })).toBe('9월 15일 오후 5:28');
    expect(D.formatMailDate('2026-09-15T17:28:40', { refYear: 2026 })).toBe('9월 15일 오후 5:28');
    expect(D.formatMailDate('2026-09-15 17:28', { refYear: 2026 })).toBe('9월 15일 오후 5:28');
    expect(D.formatMailDate('2026-09-15', { refYear: 2026 })).toBe('9월 15일');
    expect(D.formatMailDate('2025-12-31T23:30:00Z', { refYear: 2026, offsetMinutes: 540 })).toBe('1월 1일 오전 8:30');
    expect(D.formatMailDate('2025-12-31T10:00:00+09:00', { refYear: 2026, offsetMinutes: 540 })).toBe('2025년 12월 31일 오전 10:00');
    expect(D.formatMailDate('2026-09-15T17:28:40+0900', { offsetMinutes: 540 })).toBe('9월 15일 오후 5:28');
    expect(D.formatMailDate(new Date(Date.UTC(2026, 8, 15, 8, 28)), { offsetMinutes: 540 })).toBe('9월 15일 오후 5:28');
    expect(D.formatMailDate('어제', {})).toBe('어제');
    expect(D.formatMailDate(undefined)).toBe('');
    expect(D.formatMailDate('2026-02-30T10:00:00')).toBe('2026-02-30T10:00:00');
  });
  it('localYmd', () => {
    expect(D.localYmd(new Date(2026, 8, 3, 23, 59))).toBe('2026-09-03');
  });
});

describe('tasks', () => {
  const today = '2026-09-23';
  it('strip cells', () => {
    expect(T.stripCell(base({ bucket: 'overdue', due: '2026-09-18', overdueDays: 3 }), today)).toMatchObject({ top: '+3', sub: '영업일', tone: 'overdue' });
    expect(T.stripCell(base({ bucket: 'overdue', due: '2026-09-18' }), today)).toMatchObject({ top: '지남', sub: '기한' });
    expect(T.stripCell(base({ bucket: 'thisWeek', due: today }), today)).toMatchObject({ top: '오늘', sub: '마감', tone: 'today' });
    expect(T.stripCell(base({ bucket: 'thisWeek', due: '2026-09-24' }), today)).toMatchObject({ top: '목', sub: '9/24', tone: 'day' });
    expect(T.stripCell(base({ bucket: 'chased', chaseCount: 3, pri: 2 }), today)).toMatchObject({ top: '3회', sub: '재촉' });
    expect(T.stripCell(base({ bucket: 'chased', pri: 1 }), today)).toMatchObject({ top: 'P1', sub: '우선' });
    expect(T.stripCell(base({ bucket: 'chased', chaseCount: 0, pri: 1 }), today)).toMatchObject({ top: 'P1', sub: '우선' });
    // 재촉 1회 + P1: 재촉 구간에 든 까닭은 P1 이다(실제 위키에서 '1회/재촉' 으로 보이던 것)
    expect(T.stripCell(base({ bucket: 'chased', chaseCount: 1, pri: 1 }), today)).toMatchObject({ top: 'P1', sub: '우선' });
    expect(T.stripCell(base({ bucket: 'chased', chaseCount: 2, pri: 1 }), today)).toMatchObject({ top: '2회', sub: '재촉' });
    expect(T.stripCell(base({ bucket: 'stale', openDays: 38, pri: 3 }), today)).toMatchObject({ top: '38', sub: '영업일' });
    expect(T.stripCell(base({ bucket: 'other', due: '2026-09-30', pri: 2 }), today)).toMatchObject({ top: '9/30', sub: '수' });
    expect(T.stripCell(base({ bucket: 'other', pri: 3 }), today)).toMatchObject({ top: 'P3', sub: '우선' });
    expect(T.stripCell(base({ bucket: 'other' }), today)).toMatchObject({ top: '기한', sub: '없음', tone: 'none' });
    expect(T.stripCell(base({ bucket: 'other', due: 'not-a-date' }), today)).toMatchObject({ tone: 'none' });
    expect(T.stripCell(base({ bucket: 'weird' as never }), today)).toMatchObject({ tone: 'none' });
  });
  it('meta', () => {
    expect(T.rowMeta(base({ bucket: 'overdue', company: '한결케미칼', chaseCount: 2 })).map((m) => m.text)).toEqual(['한결케미칼', '재촉 2']);
    expect(T.rowMeta(base({ bucket: 'chased', company: '해온정밀', chaseCount: 3, openDays: 26 })).map((m) => m.text)).toEqual(['해온정밀', '열린 지 26영업일']);
    expect(T.rowMeta(base({ bucket: 'chased', company: '경영지원', chaseCount: 1, pri: 1, openDays: 13 })).map((m) => m.text)).toEqual(['경영지원', '재촉 1', '열린 지 13영업일']);
    expect(T.rowMeta(base({ bucket: 'other', status: 'wip' })).map((m) => m.text)).toEqual(['진행 중']);
    expect(T.rowMeta(base({ company: '  ' }))).toEqual([]);
  });
  it('chips', () => {
    const t = base({ bucket: 'overdue', due: '2026-09-18', overdueDays: 3, chaseCount: 2, openDays: 7, company: '한결케미칼', mail: 'raw/mail/a.md', opened: '2026-09-15', pri: 1 });
    expect(T.detailChips(t, today).map((c) => c.text)).toEqual(['한결케미칼', '기한 9월 18일, 3영업일 지남', '재촉 2회', '열림 7영업일', '우선 P1', '9월 15일 메일에서 등록']);
    expect(T.detailChips(base({ bucket: 'thisWeek', due: today }), today).map((c) => c.text)).toEqual(['기한 오늘, 9월 23일']);
    expect(T.detailChips(base({ bucket: 'thisWeek', due: '2026-09-25', status: 'wip', owner: '김담당' }), today).map((c) => c.text)).toEqual(['기한 9월 25일 금요일', '진행 중', '담당 김담당']);
    expect(T.detailChips(base({}), today)).toEqual([]);
  });
  it('sources', () => {
    const s = T.splitSources('wiki/analysis/메일브리핑_2026-09-16.md · _private/mgmt/업무 현황 종합 분석 · 메모');
    expect(s.map((x) => [x.name, x.folder, x.openPath])).toEqual([
      ['메일브리핑_2026-09-16', 'wiki/analysis', 'wiki/analysis/메일브리핑_2026-09-16.md'],
      ['업무 현황 종합 분석', '_private/mgmt', undefined],
      ['메모', undefined, undefined],
    ]);
    expect(T.splitSources(undefined)).toEqual([]);
    expect(T.splitSources('  ')).toEqual([]);
    expect(T.splitSources('`wiki/x.md`')[0].openPath).toBe('wiki/x.md');
  });
  it('sender', () => {
    expect(T.senderName('한결케미칼 EHS팀 <ehs@hangyeol.example>')).toBe('한결케미칼 EHS팀');
    expect(T.senderName('"홍 길동" <a@b.c>')).toBe('홍 길동');
    expect(T.senderName('<a@b.c>')).toBe('a@b.c');
    expect(T.senderName('a@b.c')).toBe('a@b.c');
    expect(T.senderName(undefined)).toBeUndefined();
  });
  it('group', () => {
    const g = T.groupByBucket([base({ id: 'a', bucket: 'overdue' }), base({ id: 'b', bucket: 'bogus' as never }), base({ id: 'c', bucket: 'overdue' })]);
    expect(g.overdue.map((t) => t.id)).toEqual(['a', 'c']);
    expect(g.other.map((t) => t.id)).toEqual(['b']);
  });
});

describe('snapshot', () => {
  it('normalizes partial', () => {
    const s = S.normalizeSnapshot({ tasks: [base({ id: 'a' }), { nope: 1 }], week: { today: '2026-09-23', days: [{ date: '2026-09-21' }, { date: 'bad' }] } });
    expect(s.tasks).toHaveLength(1);
    expect(s.week.days).toHaveLength(1);
    expect(s.week.days[0]).toMatchObject({ isToday: false, isHoliday: false, dueCount: 0, label: '2026-09-21' });
    expect(s.counts.other).toBe(1);
    expect(s.warnings).toEqual([]);
    expect(s.partial).toBe(false);
  });
  it('partial 표시는 참일 때만 참', () => {
    expect(S.normalizeSnapshot({ tasks: [], partial: true }).partial).toBe(true);
    expect(S.normalizeSnapshot({ tasks: [], partial: 'yes' }).partial).toBe(false);
  });
  it('rejects garbage', () => {
    expect(() => S.normalizeSnapshot(null)).toThrow();
    expect(() => S.normalizeSnapshot({})).toThrow();
  });
  it('newer wins', () => {
    const a = S.normalizeSnapshot({ tasks: [], generatedAt: '2026-09-23T03:00:00.000Z' });
    const b = S.normalizeSnapshot({ tasks: [], generatedAt: '2026-09-23T02:00:00.000Z' });
    expect(S.newerSnapshot(a, b)).toBe(a);
    expect(S.newerSnapshot(b, a)).toBe(a);
    expect(S.newerSnapshot(null, b)).toBe(b);
  });
  it('error text', () => {
    expect(S.errorText(new Error("Error invoking remote method 'radar:getSnapshot': Error: not implemented"))).toBe('not implemented');
    expect(S.errorText(undefined)).toBe('알 수 없는 오류');
  });
});

// ── 2단계 ──

describe('stage2 tasks (정리 대상·진행 메모)', () => {
  const today = '2026-09-23';
  it('정리 대상 이름·풀이', () => {
    expect(T.BUCKET_INFO.stale.label).toBe('정리 대상');
    expect(T.STALE_HINT).toContain('15영업일');
  });
  it('정리 대상 왼쪽 칸: 오래 밀린 것은 지난 영업일 수(코랄 아님), 기한 없는 것은 열린 영업일 수', () => {
    expect(T.stripCell(base({ bucket: 'stale', due: '2026-07-15', overdueDays: 49, pri: 2 }), today)).toMatchObject({
      top: '+49',
      sub: '영업일',
      tone: 'count',
      label: '기한 49영업일 지남',
    });
    expect(T.stripCell(base({ bucket: 'stale', openDays: 38 }), today)).toMatchObject({ top: '38', sub: '영업일', tone: 'count' });
  });
  it('정리 대상 상세 칩: 기한 지남을 적되 코랄로 칠하지 않는다', () => {
    const chips = T.detailChips(base({ bucket: 'stale', due: '2026-07-15', overdueDays: 49, pri: 2 }), today);
    expect(chips.map((c) => c.text)).toEqual(['기한 7월 15일, 49영업일 지남', '우선 P2']);
    expect(chips[0].tone).toBeUndefined();
  });
  it('[st:: 값] 칩', () => {
    const chips = T.detailChips(base({ bucket: 'other', due: '2026-10-12', st: '협의' }), today);
    expect(chips.map((c) => c.text)).toEqual(['기한 10월 12일 월요일', '메모 상태: 협의']);
    expect(chips[1].icon).toBe('memo');
    expect(T.detailChips(base({ st: '  ' }), today)).toEqual([]);
  });
});

describe('result form', () => {
  const task = base({ id: 'c:abc', title: '법인카드 지출결의서 작성', status: 'open', bucket: 'thisWeek' });
  const wip = base({ id: 'c:wip', title: '월간 리포트 초안 작성', status: 'wip' });
  it('상태 네 개(대기·진행 중·완료·내 일 아님)', () => {
    expect(R.STATUS_OPTIONS.map((o) => [o.value, o.label])).toEqual([
      ['open', '대기'],
      ['wip', '진행 중'],
      ['done', '완료'],
      ['notmine', '내 일 아님'],
    ]);
  });
  it('처음 폼은 지금 상태를 고른다', () => {
    expect(R.initialDraft(task)).toEqual({ status: 'open', owner: '', note: '', reflect: false });
    expect(R.initialDraft(wip).status).toBe('wip');
    expect(R.initialDraft(base({ status: 'weird' as never })).status).toBe('open');
  });
  it('바뀐 것이 있어야 저장할 수 있다', () => {
    const d = R.initialDraft(task);
    expect(R.hasChange(task, d)).toBe(false);
    expect(R.isDirty(task, d)).toBe(false);
    expect(R.hasChange(task, { ...d, note: '   ' })).toBe(false);
    expect(R.isDirty(task, { ...d, note: '   ' })).toBe(true);
    expect(R.hasChange(task, { ...d, note: '회신함' })).toBe(true);
    expect(R.hasChange(task, { ...d, status: 'done' })).toBe(true);
    expect(R.hasChange(task, { ...d, reflect: true })).toBe(true);
    // 진행 중인 항목에 메모만 남기는 저장
    expect(R.hasChange(wip, { ...R.initialDraft(wip), note: '초안 절반' })).toBe(true);
  });
  it('완료·내 일 아님은 목록에서 빠진다', () => {
    expect(['open', 'wip', 'done', 'notmine'].map((s) => R.leavesList(s as never))).toEqual([false, false, true, true]);
  });
  it('입력 검사: 담당자 대괄호·길이', () => {
    const d = { ...R.initialDraft(task), status: 'notmine' as const };
    expect(R.draftProblem({ ...d, owner: '김[담당]' })).toContain('대괄호');
    expect(R.draftProblem({ ...d, owner: '김담당' })).toBeNull();
    // 내 일 아님이 아니면 담당자 칸은 보지 않는다(보내지도 않는다)
    expect(R.draftProblem({ ...d, status: 'done', owner: '[x]' })).toBeNull();
    expect(R.draftProblem({ ...d, owner: 'a'.repeat(R.OWNER_MAX + 1) })).toContain(`${R.OWNER_MAX}자`);
  });
  it('저장 입력: 담당자는 내 일 아님일 때만, 빈 메모는 빼고, 줄바꿈은 LF', () => {
    const d = R.initialDraft(task);
    expect(R.buildSaveInput(task, { ...d, status: 'done', owner: '무시됨' })).toEqual({ taskId: 'c:abc', status: 'done', reflect: false });
    expect(R.buildSaveInput(task, { ...d, status: 'notmine', owner: '  김\t 담당 ' })).toEqual({
      taskId: 'c:abc',
      status: 'notmine',
      owner: '김 담당',
      reflect: false,
    });
    expect(R.buildSaveInput(task, { ...d, status: 'notmine', owner: '   ' })).toEqual({ taskId: 'c:abc', status: 'notmine', reflect: false });
    expect(R.buildSaveInput(task, { ...d, note: ' 첫 줄\r\n둘째 줄\u0007 \n', reflect: true })).toEqual({
      taskId: 'c:abc',
      status: 'open',
      note: '첫 줄\n둘째 줄',
      reflect: true,
    });
    // 탭은 남긴다(main 도 받는다)
    expect(R.buildSaveInput(task, { ...d, note: 'a\tb' }).note).toBe('a\tb');
  });
  it('빠진 뒤 옮겨 갈 항목: 다음 → 앞 → 없음', () => {
    expect(R.nextAfterRemoval(['a', 'b', 'c'], 'b')).toBe('c');
    expect(R.nextAfterRemoval(['a', 'b', 'c'], 'c')).toBe('b');
    expect(R.nextAfterRemoval(['a'], 'a')).toBeNull();
    expect(R.nextAfterRemoval(['a', 'b'], 'zzz')).toBe('a');
    expect(R.nextAfterRemoval([], 'zzz')).toBeNull();
  });

  const out = (p: Partial<SaveResultOutput>): SaveResultOutput => ({
    date: '2026-09-23',
    updated: [],
    loggedDone: [],
    loggedDelegated: [],
    loggedWip: [],
    unlogged: [],
    memo: false,
    unmatched: [],
    files: [],
    warnings: [],
    ...p,
  });

  it('저장 알림: 고친 파일 수·백업 위치·메모·대기열', () => {
    const n = R.summarizeSave(
      task,
      { taskId: task.id, status: 'done', note: '제출함', reflect: true },
      out({
        updated: ['법인카드 지출결의서 작성 [done]'],
        memo: true,
        files: ['_private/mgmt/내 할 일.md', '_private/mgmt/할 일 메모.md'],
        backupDir: '_todo-sync/backup/20260923T101500',
        queued: { id: 'q1', kind: 'task', createdAt: '2026-09-23T01:15:00.000Z', title: '법인카드 지출결의서 작성', note: '제출함' },
      }),
      7,
    );
    expect(n.id).toBe(7);
    expect(n.tone).toBe('ok');
    expect(n.title).toBe('‘법인카드 지출결의서 작성’ — 완료로 저장했습니다.');
    const texts = n.lines.map((l) => l.text);
    expect(texts[0]).toBe('위키 파일 2개를 고쳤습니다.');
    expect(texts[1]).toBe('고친 파일: _private/mgmt/내 할 일.md · _private/mgmt/할 일 메모.md');
    expect(texts).toContain('고치기 전 사본: _todo-sync/backup/20260923T101500');
    expect(texts.some((t) => t.includes('할 일 메모'))).toBe(true);
    expect(texts.some((t) => t.startsWith('반영 대기열에 넣었습니다'))).toBe(true);
    expect(n.lines.every((l) => !l.warn)).toBe(true);
  });
  it('저장 알림: 못 찾은 앵커·경고는 경고색, 조사(으로/로)', () => {
    const n = R.summarizeSave(
      task,
      { taskId: task.id, status: 'wip', reflect: false },
      out({
        loggedWip: ['사라진 항목'],
        unmatched: ['사라진 항목 — 문구 미발견: _private/mgmt/내 할 일.md / 사라진 앵커'],
        warnings: ['파일이 바뀌어 다시 읽었습니다'],
        files: ['_private/mgmt/내 할 일.md'],
      }),
      1,
    );
    expect(n.tone).toBe('warn');
    expect(n.title).toContain('진행 중으로 저장했습니다');
    const warn = n.lines.filter((l) => l.warn).map((l) => l.text);
    expect(warn).toEqual(['찾지 못함: 사라진 항목 — 문구 미발견: _private/mgmt/내 할 일.md / 사라진 앵커', '파일이 바뀌어 다시 읽었습니다']);
    expect(n.lines.some((l) => l.text.includes('동기화 로그 절에 적었습니다'))).toBe(true);
    expect(R.summarizeSave(task, { taskId: 'x', status: 'notmine', reflect: false }, out({}), 2).title).toContain('내 일 아님으로');
    expect(R.summarizeSave(task, { taskId: 'x', status: 'open', reflect: false }, out({ unlogged: ['x'] }), 3).title).toContain('대기로');
  });
  it('저장 알림: 같은 메모·대기열 누락·고친 파일 없음', () => {
    const n = R.summarizeSave(task, { taskId: 'x', status: 'open', note: '같은 말', reflect: true }, out({}), 4);
    const texts = n.lines.map((l) => l.text);
    expect(texts[0]).toBe('고친 위키 파일이 없습니다.');
    expect(texts.some((t) => t.includes('같은 메모가 이미 있어'))).toBe(true);
    expect(n.lines.find((l) => l.text.includes('대기열에 넣었는지'))?.warn).toBe(true);
    expect(n.tone).toBe('warn');
  });
  it('저장 실패 알림', () => {
    const n = R.saveFailure(task, '파일이 계속 바뀌어 저장하지 못했습니다', 9);
    expect(n.tone).toBe('error');
    expect(n.title).toContain('저장하지 못했습니다');
    expect(n.lines[0]).toEqual({ text: '파일이 계속 바뀌어 저장하지 못했습니다', warn: true });
    expect(n.lines[1].text).toContain('입력한 내용은 그대로');
  });
  it('일부만 저장한 실패는 경고로 — 쓴 파일을 보이고 "입력한 내용은 그대로"라고 하지 않는다', () => {
    const message =
      `${PARTIAL_SAVE_PREFIX}: 파일을 쓰지 못함(EPERM): _private/mgmt/내 할 일.md — 다른 프로그램이 파일을 잡고 있을 수 있음` +
      ' — 먼저 쓴 파일: _private/mgmt/할 일 메모.md — 다시 저장하면 이어서 반영됨';
    expect(R.isPartialSave(message)).toBe(true);
    expect(R.isPartialSave('위키에 저장하지 못했습니다: x')).toBe(false);
    const n = R.saveFailure(task, message, 10);
    expect(n.tone).toBe('warn');
    expect(n.title).toContain('일부만 저장했습니다');
    expect(n.lines[0]).toEqual({ text: message, warn: true });
    expect(n.lines.some((l) => l.text.includes('입력한 내용은 그대로'))).toBe(false);
    expect(n.lines[1].text).toContain('다시 저장하면 이어서 반영됩니다');
  });
  it('망가진 결과도 견딘다', () => {
    const n = R.summarizeSave(task, { taskId: 'x', status: 'done', reflect: false }, {} as SaveResultOutput, 5);
    expect(n.tone).toBe('ok');
    expect(n.lines.map((l) => l.text)).toEqual(['고친 위키 파일이 없습니다.']);
  });
});

describe('queue', () => {
  const item = (p: Partial<QueueItem>): QueueItem => ({
    id: 'q1',
    kind: 'task',
    createdAt: '2026-09-23T08:28:00.000Z',
    title: '제목',
    note: '',
    ...p,
  });
  it('대기열 다듬기: 모양 틀린 것·중복 id 는 버린다', () => {
    const q = Q.normalizeQueue([
      item({ id: 'a', status: 'done', company: '한결케미칼', note: '회신함' }),
      { id: '', title: 'x' },
      null,
      item({ id: 'a', title: '중복' }),
      { id: 'b', title: '  ', status: 'bogus', note: 3, kind: 'decision' },
    ]);
    expect(q.map((i) => i.id)).toEqual(['a', 'b']);
    expect(q[0]).toMatchObject({ status: 'done', company: '한결케미칼', note: '회신함' });
    expect(q[1]).toMatchObject({ title: '(제목 없음)', note: '', kind: 'decision' });
    expect(q[1].status).toBeUndefined();
    expect(Q.normalizeQueue('nope')).toEqual([]);
  });
  it('상태 풀이', () => {
    expect(Q.queueStatusText(item({ status: 'done' }))).toBe('완료');
    expect(Q.queueStatusText(item({ status: 'notmine', owner: '김담당' }))).toBe('내 일 아님 → 김담당');
    expect(Q.queueStatusText(item({ status: 'wip' }))).toBe('진행 중');
    expect(Q.queueStatusText(item({ kind: 'decision' }))).toBe('판단 결정');
    expect(Q.queueStatusText(item({}))).toBe('상태 없음');
  });
  it('실행 기록 다듬기', () => {
    expect(Q.normalizeRun(null)).toBeNull();
    expect(Q.normalizeRun({ id: '' })).toBeNull();
    const run = Q.normalizeRun({
      id: 'r1',
      startedAt: '2026-09-23T08:00:00.000Z',
      finishedAt: '2026-09-23T08:01:20.000Z',
      state: 'done',
      itemIds: ['a', 3, 'b'],
      changed: ['wiki/entities/한결케미칼.md', 5],
      skipped: [{ title: '전략 검토' }, 'x'],
      log: ['시작', '', '끝'],
      summary: ' 한결 페이지에 반영 ',
    });
    expect(run).toMatchObject({
      state: 'done',
      itemIds: ['a', 'b'],
      changed: ['wiki/entities/한결케미칼.md'],
      skipped: [{ title: '전략 검토', reason: '이유가 적혀 있지 않습니다.' }],
      log: ['시작', '끝'],
      summary: '한결 페이지에 반영',
    });
    expect(Q.normalizeRun({ id: 'r2', state: '??' })?.state).toBe('failed');
  });
  it('실행 기록 고르기: 같은 실행이면 끝난 쪽, 다르면 나중에 시작한 것', () => {
    const r = (p: Partial<ReflectRun>): ReflectRun => ({
      id: 'r1',
      startedAt: '2026-09-23T08:00:00.000Z',
      state: 'running',
      itemIds: [],
      log: [],
      ...p,
    });
    const running = r({});
    const done = r({ state: 'done' });
    expect(Q.newerRun(null, running)).toBe(running);
    expect(Q.newerRun(running, done)).toBe(done);
    expect(Q.newerRun(done, running)).toBe(done);
    expect(Q.newerRun(done, null)).toBe(done);
    const later = r({ id: 'r2', startedAt: '2026-09-23T09:00:00.000Z' });
    expect(Q.newerRun(done, later)).toBe(later);
    expect(Q.newerRun(later, done)).toBe(later);
  });
  it('경과 시간', () => {
    expect(Q.formatElapsed(0)).toBe('0초');
    expect(Q.formatElapsed(35_400)).toBe('35초');
    expect(Q.formatElapsed(80_000)).toBe('1분 20초');
    expect(Q.formatElapsed(120_000)).toBe('2분');
    expect(Q.formatElapsed(3_720_000)).toBe('1시간 2분');
    expect(Q.formatElapsed(-5)).toBe('0초');
    expect(Q.formatElapsed(Number.NaN)).toBe('0초');
    const run: ReflectRun = { id: 'r', startedAt: '2026-09-23T08:00:00.000Z', state: 'running', itemIds: [], log: [] };
    expect(Q.runElapsed(run, Date.parse('2026-09-23T08:00:05.000Z'))).toBe(5000);
    expect(Q.runElapsed({ ...run, finishedAt: '2026-09-23T08:01:00.000Z' }, 0)).toBe(60_000);
    expect(Q.runElapsed({ ...run, startedAt: '' }, 0)).toBeNull();
  });
  it('바뀐 파일: 볼트 안 상대 .md 만 열 수 있다', () => {
    expect(
      Q.changedFiles(['wiki\\entities\\한결케미칼.md', './log.md', 'wiki/entities/한결케미칼.md', 'C:/x/y.md', '../밖.md', 'wiki/a.txt', ' ']),
    ).toEqual([
      { path: 'wiki/entities/한결케미칼.md', openPath: 'wiki/entities/한결케미칼.md' },
      { path: 'log.md', openPath: 'log.md' },
      { path: 'C:/x/y.md' },
      { path: '../밖.md' },
      { path: 'wiki/a.txt' },
    ]);
    expect(Q.changedFiles(undefined)).toEqual([]);
  });
  it('대기열에 넣은 시각', () => {
    expect(Q.queueTimeText('2026-09-23', '2026-09-23')).toBe('9월 23일');
    expect(Q.queueTimeText('', '2026-09-23')).toBe('');
  });
  it('실행 시각: 오늘이면 시각만, 다른 날이면 날짜도(해가 다르면 해도)', () => {
    // 이 PC 시간대의 벽시계로 만든 시각(시험이 어느 시간대에서 돌아도 같게)
    const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi).toISOString();
    expect(Q.runTimeText(at(2026, 9, 23, 9, 33), '2026-09-23')).toBe('오전 9:33');
    expect(Q.runTimeText(at(2026, 9, 18, 9, 33), '2026-09-23')).toBe('9월 18일 오전 9:33');
    expect(Q.runTimeText(at(2025, 12, 31, 17, 5), '2026-01-02')).toBe('2025년 12월 31일 오후 5:05');
    expect(Q.runTimeText('', '2026-09-23')).toBe('');
    expect(Q.runTimeText('모름', '2026-09-23')).toBe('');
    expect(Q.runTimeText(undefined, '2026-09-23')).toBe('');
  });
  it('실행 결과 머리 문장: 실패는 지금 대기열이 아니라 그때 한 일로 말한다', () => {
    const run = (state: ReflectRun['state']): ReflectRun => ({ id: 'r', startedAt: '', state, itemIds: ['a'], log: [] });
    expect(Q.runHeadline(run('failed'))).toBe('반영하지 못했습니다. 그때 보낸 항목은 대기열에 남겨 두었습니다.');
    expect(Q.runHeadline(run('failed'))).not.toContain('그대로 남아 있습니다');
    expect(Q.runHeadline(run('done'))).toBe('반영을 마쳤습니다.');
    expect(Q.runHeadline(run('running'))).toContain('반영하는 중');
  });
});
