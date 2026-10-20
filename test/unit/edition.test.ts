// 판(src/shared/edition.ts): 회사판은 모든 기능, 공개판은 VOC·팀 위키·로컬 LLM 을 가린다.
// scripts/export-public.mjs 는 EDITION 줄을 글자로 찾아 'public' 으로 바꾼다 — 줄 모양이 바뀌면 여기서 먼저 깨진다.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EDITION, FEATURES, featuresOf } from '../../src/shared/edition';

describe('판', () => {
  it('회사판은 모든 기능, 공개판은 셋 다 끈다', () => {
    expect(featuresOf('company')).toEqual({ voc: true, teamWiki: true, localLlm: true });
    expect(featuresOf('public')).toEqual({ voc: false, teamWiki: false, localLlm: false });
  });

  it('기능은 판에서 나온다', () => {
    expect(FEATURES).toEqual(featuresOf(EDITION));
  });

  it('내보내기 스크립트가 찾는 EDITION 줄이 그대로 있다(공개판 사본에서는 public)', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/shared/edition.ts'), 'utf8');
    expect(src).toMatch(new RegExp(`export const EDITION: Edition = '${EDITION}';`));
    expect(['company', 'public']).toContain(EDITION);
  });
});
