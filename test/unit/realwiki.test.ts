// 실제 위키로 스냅샷을 만들어 본다 — **읽기만** 한다. 위키가 없는 PC 에서는 건너뛴다.
// 경로는 WIKI_RADAR_WIKI 로 바꿀 수 있다(기본 %USERPROFILE%\OneDrive\Obsidian\WIKI).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import holidaysJson from '../../config/holidays-kr.json';
import type { Bucket } from '../../src/shared/types';
import { buildSnapshot } from '../../src/main/wiki/snapshot';

const REAL_WIKI = process.env.WIKI_RADAR_WIKI || path.join(os.homedir(), 'OneDrive', 'Obsidian', 'WIKI');
const exists = (() => {
  try {
    return fs.statSync(REAL_WIKI).isDirectory();
  } catch {
    return false;
  }
})();

/** 로컬 기준 오늘 YYYY-MM-DD (WIKI_RADAR_TODAY 가 있으면 그것) */
function localToday(): string {
  const env = process.env.WIKI_RADAR_TODAY;
  if (env && /^\d{4}-\d{2}-\d{2}$/.test(env)) return env;
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

describe.skipIf(!exists)('실제 위키(읽기 전용)', () => {
  it(
    '예외 없이 5초 안에 스냅샷을 만든다',
    () => {
      const today = localToday();
      const t0 = performance.now();
      const snap = buildSnapshot({ wikiRoot: REAL_WIKI, today, holidays: holidaysJson.holidays });
      const ms = performance.now() - t0;

      const sum = (Object.keys(snap.counts) as Bucket[]).reduce((a, b) => a + snap.counts[b], 0);
      expect(sum).toBe(snap.tasks.length);
      for (const t of snap.tasks) {
        expect(t.title.trim(), `빈 제목: ${t.id} ${t.file ?? ''}:${t.line ?? ''}`).not.toBe('');
        expect(['open', 'wip']).toContain(t.status);
      }
      const ids = snap.tasks.map((t) => t.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(snap.pageCount).toBeGreaterThan(0);
      expect(ms).toBeLessThan(5000);

      const bySource = { curated: 0, checkbox: 0 };
      for (const t of snap.tasks) bySource[t.source]++;
      console.log(
        `[실제 위키] today=${today} ${ms.toFixed(0)}ms pageCount=${snap.pageCount} tasks=${snap.tasks.length}`,
        snap.counts,
        bySource,
      );
      console.log(`[실제 위키] warnings ${snap.warnings.length}건`, snap.warnings);
    },
    60_000,
  );
});
