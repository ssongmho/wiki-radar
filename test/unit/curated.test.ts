// items.json·로그 절·메모 (명세 §1-1)
import { describe, expect, it } from 'vitest';
import { lookupLogStatus, parseItemsJson, parseLogSections, parseMemos } from '../../src/main/wiki/curated';

describe('items.json', () => {
  it('정상', () => {
    const r = parseItemsJson(
      JSON.stringify({
        snapshot: '2026-09-01',
        items: [
          { g: 'now', k: 'do', due: '2026-09-18', t: '제목', why: '이유', who: '', risk: 1, src: 's', a: [{ f: 'a\\b.md', m: '문구' }] },
        ],
      }),
    );
    expect(r.warnings).toEqual([]);
    expect(r.items).toEqual([
      { index: 0, t: '제목', g: 'now', k: 'do', due: '2026-09-18', why: '이유', risk: 1, src: 's', a: [{ f: 'a/b.md', m: '문구' }] },
    ]);
  });

  it('깨진 JSON → 항목 없이 경고', () => {
    const r = parseItemsJson('{"items": [');
    expect(r.items).toEqual([]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/^items\.json 을 읽지 못함/);
  });

  it('items 배열이 없음 → 경고', () => {
    for (const text of ['{}', '[]', 'null', '{"items": {}}']) {
      const r = parseItemsJson(text);
      expect(r.items).toEqual([]);
      expect(r.warnings).toEqual(['items.json 에 items 배열이 없음 — 큐레이션 항목 없이 계속함']);
    }
  });

  it('이상한 항목 하나는 건너뛰고 나머지는 살린다', () => {
    const r = parseItemsJson(
      JSON.stringify({ items: [null, 'x', { t: '' }, { g: 'now' }, { t: '살아남음', due: '다음주', a: [{ f: 'x.md' }, 3] }] }),
    );
    expect(r.items.map((i) => i.t)).toEqual(['살아남음']);
    expect(r.items[0].due).toBeUndefined();
    expect(r.items[0].a).toEqual([]);
    expect(r.warnings).toEqual([
      'items.json 항목 1: 객체가 아님 — 건너뜀',
      'items.json 항목 2: 객체가 아님 — 건너뜀',
      'items.json 항목 3: 제목(t)이 없음 — 건너뜀',
      'items.json 항목 4: 제목(t)이 없음 — 건너뜀',
      '앵커 형식이 잘못됨: 살아남음 — 건너뜀',
      '앵커 형식이 잘못됨: 살아남음 — 건너뜀',
    ]);
  });
});

describe('로그 절', () => {
  const lines = [
    '# 내 할 일',
    '- [ ] 체크박스 · 가짜 완료',
    '## 완료 로그 (아티팩트 동기화)',
    '> 설명',
    '- 2026-09-10 · 완료된 일 — 출처 `x`',
    '- 2026-09-11 · 양쪽에 있는 일',
    '### 하위 제목은 절을 끝내지 않는다',
    '- 2026-09-12 · 하위 아래 완료',
    '## 위임·담당 이관 (아티팩트 동기화)',
    '- 2026-09-11 · 넘긴 일 → 담당 **박담당** — 개발팀에 이관',
    '- 2026-09-12 · 양쪽에 있는 일 → 담당 **이담당**',
    '- 2026-09-13 · 담당자 없는 위임',
    '## 진행 중 (아티팩트 동기화)',
    '- 2026-09-19 · 하는 중인 일',
    '## 다른 절',
    '- 2026-09-20 · 절 밖의 일',
  ];
  const logs = parseLogSections(lines);

  it('절마다 다음 ## 까지', () => {
    expect(logs.done).toHaveLength(5);
    expect(logs.delegated).toHaveLength(3);
    expect(logs.wip).toEqual(['- 2026-09-19 · 하는 중인 일']);
  });

  it.each([
    ['완료된 일', { status: 'done' }],
    ['하위 아래 완료', { status: 'done' }],
    ['넘긴 일', { status: 'notmine', owner: '박담당' }],
    ['양쪽에 있는 일', { status: 'notmine', owner: '이담당' }], // 위임 → 완료 → 진행 순
    ['담당자 없는 위임', { status: 'notmine' }],
    ['하는 중인 일', { status: 'wip' }],
  ])('%s', (title, expected) => {
    expect(lookupLogStatus(logs, title)).toEqual(expected);
  });

  it('절 밖·체크박스 줄은 보지 않는다', () => {
    expect(lookupLogStatus(logs, '절 밖의 일')).toBeNull();
    expect(lookupLogStatus(logs, '가짜 완료')).toBeNull();
    expect(lookupLogStatus(logs, '없는 제목')).toBeNull();
  });

  it('파일이 없으면(빈 줄 목록) 아무것도 찾지 않는다', () => {
    expect(lookupLogStatus(parseLogSections([]), '완료된 일')).toBeNull();
  });
});

describe('메모', () => {
  it('절의 마지막 항목, 두 칸 들여쓴 줄은 \\n 으로', () => {
    const memos = parseMemos([
      '# 할 일 메모',
      '> 설명 [[내 할 일]]',
      '## 가 항목',
      '출처 `x`',
      '- 2026-09-17 · 첫 메모',
      '- 2026-09-19 · 두 번째 메모 첫 줄',
      '  이어지는 줄',
      '  또 이어지는 줄',
      '',
      '## 나 항목  ',
      '- 2026-08-13 · 하나뿐',
      '## 메모 없는 항목',
      '출처만 있음',
    ]);
    expect(memos.get('가 항목')).toBe('두 번째 메모 첫 줄\n이어지는 줄\n또 이어지는 줄');
    expect(memos.get('나 항목')).toBe('하나뿐');
    expect(memos.has('메모 없는 항목')).toBe(false);
  });

  // build_todo.py memos() 와 같은 규칙: 항목은 다음 `- ` 줄이나 `## ` 에서만 끝난다.
  it('빈 줄 뒤의 들여쓴 줄도 이어지는 줄이다(build_todo 와 같게)', () => {
    const memos = parseMemos(['## 가', '- 2026-09-19 · 메모', '', '  떨어진 줄']);
    expect(memos.get('가')).toBe('메모\n떨어진 줄');
  });

  it('두 단락 메모(sync_todo write_memo 가 쓰는 "  " 줄)를 첫 단락에서 자르지 않는다', () => {
    // sync_todo.py:188 `body.replace("\n", "\n  ")` 은 '첫 단락\n\n둘째 단락' 을 이렇게 쓴다
    const memos = parseMemos(['## 가', '출처 `x`', '', '- 2026-09-19 · 첫 단락', '  ', '  둘째 단락', '']);
    expect(memos.get('가')).toBe('첫 단락\n\n둘째 단락');
  });

  it('출처 줄·일반 줄은 항목을 끊지 않고, 마지막 값은 앞뒤 공백을 뗀다', () => {
    const memos = parseMemos(['## 가', '- 2026-09-19 · 메모 ', '출처 `x`', '  이어짐  ', '  ']);
    expect(memos.get('가')).toBe('메모 \n이어짐');
  });

  it('날짜 없는 `- ` 줄도 새 항목을 시작한다(build_todo 와 같게), 빈 항목은 마지막 메모로 치지 않는다', () => {
    expect(parseMemos(['## 가', '- 2026-09-01 · 앞', '- 뒤 항목']).get('가')).toBe('- 뒤 항목');
    expect(parseMemos(['## 가', '- 2026-09-01 · 앞', '- 2026-09-02 · ']).get('가')).toBe('앞');
  });

  it('같은 제목 절이 두 번이면 뒤의 마지막 항목', () => {
    const memos = parseMemos(['## 가', '- 2026-09-01 · 앞', '## 나', '- 2026-09-02 · 나', '## 가', '- 2026-09-03 · 뒤']);
    expect(memos.get('가')).toBe('뒤');
  });
});
