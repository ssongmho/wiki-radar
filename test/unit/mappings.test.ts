// _raw-link/link_raw.py 텍스트 파싱 (명세 §1-5)
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDictLiteral, parseLinkRaw, parseSetLiteral } from '../../src/main/wiki/mappings';

const FIXTURE_PY = path.resolve(__dirname, '../fixtures/wiki/_raw-link/link_raw.py');

describe('테스트 사본의 link_raw.py', () => {
  const maps = parseLinkRaw(fs.readFileSync(FIXTURE_PY, 'utf8'));

  it('FOLDER_PAGE', () => {
    expect([...maps.folderPage]).toEqual([
      ['해온', '해온정밀'],
      ['경영지원', '사내 조직'],
      ['사업부', '사내 조직'],
    ]);
  });

  it('FOLDER_SKIP (여러 줄 집합)', () => {
    expect([...maps.folderSkip]).toEqual(['_미분류', '_노이즈-추정', '_노이즈', '_격리', 'etc', '내 메모', '사내-보안알림']);
  });

  it('CUST_PAGE (중간에 # 주석 줄)', () => {
    expect([...maps.custPage]).toEqual([['한결', '한결케미칼']]);
  });

  it('SYSTEM_PAGE (값에 괄호)', () => {
    expect([...maps.systemPage]).toEqual([['CMS(화학물질관리시스템)', '화학물질 관리시스템 (CMS)']]);
  });
});

describe('파싱 규칙', () => {
  it('빈 파일·대입이 없는 파일은 빈 표', () => {
    for (const src of ['', '\n\n', '# 주석만\nimport re\n']) {
      const m = parseLinkRaw(src);
      expect(m.folderPage.size).toBe(0);
      expect(m.folderSkip.size).toBe(0);
      expect(m.custPage.size).toBe(0);
      expect(m.systemPage.size).toBe(0);
    }
  });

  it('# 주석(줄 전체·줄 끝)과 문자열 속 # 구분', () => {
    const src = [
      'FOLDER_PAGE = {',
      '    # "주석": "무시",',
      '    "C#팀": "씨샵팀",  # 줄 끝 주석 "가짜": "값"',
      "    '작은따옴표': '값',",
      '}',
    ].join('\n');
    expect([...parseDictLiteral(src, 'FOLDER_PAGE')]).toEqual([
      ['C#팀', '씨샵팀'],
      ['작은따옴표', '값'],
    ]);
  });

  it('여러 줄 집합·끝 쉼표·주석', () => {
    const src = [
      'FOLDER_SKIP = {',
      '    "_미분류",  # 분류 전',
      '    # "주석 속 원소",',
      "    '_노이즈',",
      '    "etc",',
      '}',
      'OTHER = {"x"}',
    ].join('\n');
    expect([...parseSetLiteral(src, 'FOLDER_SKIP')]).toEqual(['_미분류', '_노이즈', 'etc']);
  });

  it('\\r\\n 줄바꿈', () => {
    const src = 'FOLDER_PAGE = {\r\n    "해온": "해온정밀",\r\n    # 주석\r\n    "a": "b",\r\n}\r\n';
    expect([...parseDictLiteral(src, 'FOLDER_PAGE')]).toEqual([
      ['해온', '해온정밀'],
      ['a', 'b'],
    ]);
  });

  it('이름이 비슷한 다른 변수·들여쓴 대입과 헷갈리지 않는다', () => {
    const src = [
      'FOLDER_PAGE_OLD = {"옛": "값"}',
      'def f():',
      '    FOLDER_PAGE = {"안쪽": "값"}',
      'FOLDER_PAGE = {"진짜": "값"}',
      'x = FOLDER_PAGE == {}',
    ].join('\n');
    expect([...parseDictLiteral(src, 'FOLDER_PAGE')]).toEqual([['진짜', '값']]);
  });

  it('타입 표기·frozenset(...)·set([...])', () => {
    expect([...parseDictLiteral('FOLDER_PAGE: dict[str, str] = {"a": "b"}', 'FOLDER_PAGE')]).toEqual([['a', 'b']]);
    expect([...parseSetLiteral('FOLDER_SKIP = frozenset({"a", "b"})', 'FOLDER_SKIP')]).toEqual(['a', 'b']);
    expect([...parseSetLiteral('FOLDER_SKIP = set([\n  "a",\n  "b",\n])', 'FOLDER_SKIP')]).toEqual(['a', 'b']);
  });

  it('이스케이프·r 접두·이어 붙인 문자열', () => {
    const src = 'FOLDER_PAGE = {\n  "따옴\\"표": "줄\\n바꿈",\n  r"a\\b": "x",\n  "이어" "붙임": "\\uD55C",\n}';
    expect([...parseDictLiteral(src, 'FOLDER_PAGE')]).toEqual([
      ['따옴"표', '줄\n바꿈'],
      ['a\\b', 'x'],
      ['이어붙임', '한'],
    ]);
  });

  it('닫히지 않은 리터럴은 빈 표', () => {
    expect(parseDictLiteral('FOLDER_PAGE = {"a": "b",\n', 'FOLDER_PAGE').size).toBe(0);
  });

  it('문자열이 아닌 값은 건너뛴다', () => {
    expect([...parseDictLiteral('FOLDER_PAGE = {"a": None, "b": "c", "d": 1}', 'FOLDER_PAGE')]).toEqual([['b', 'c']]);
  });
});
