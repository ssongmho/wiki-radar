// 2.13단계 §C-6 main 로그 파일 — 줄마다 비밀을 가리고, 7일 지난 파일을 지운다, 최근 경고를 모은다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { installLogFile, pruneLogs } from '../../src/main/logFile';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop() as string, { recursive: true, force: true });
});

describe('logFile', () => {
  it('console 줄을 파일에도 쓰고 비밀을 가린다', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-log-'));
    dirs.push(dir);
    const now = new Date(2026, 9, 19, 10, 0, 0);
    const log = installLogFile({ dir, secrets: () => ['very-secret-77'], now: () => now });
    try {
      log.write('log', '로그인 very-secret-77 시도');
      log.write('warn', '경고 very-secret-77');
    } finally {
      log.restore();
    }
    const text = fs.readFileSync(path.join(dir, 'radar-2026-10-19.log'), 'utf8');
    expect(text).toContain('INFO 로그인 ●●● 시도');
    expect(text).toContain('WARN 경고 ●●●');
    expect(text).not.toContain('very-secret-77');
    expect(log.recentWarnings()).toEqual(['2026-10-19T10:00:00 경고 ●●●']);
  });

  it('7일 지난 파일만 지운다', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-log-'));
    dirs.push(dir);
    for (const d of ['2026-10-01', '2026-10-11', '2026-10-12', '2026-10-19']) fs.writeFileSync(path.join(dir, `radar-${d}.log`), 'x');
    fs.writeFileSync(path.join(dir, 'other.log'), 'x');
    expect(pruneLogs(dir, '2026-10-19')).toBe(2);
    expect(fs.readdirSync(dir).sort()).toEqual(['other.log', 'radar-2026-10-12.log', 'radar-2026-10-19.log']);
  });
});
