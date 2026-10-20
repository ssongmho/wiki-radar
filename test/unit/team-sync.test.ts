// 팀 위키 동기화 엔진(src/main/teamSync/engine.ts — 명세 docs/stage2.8-contract.md). 임시 폴더(os.tmpdir)에만 쓴다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LOCAL_MARKER,
  TRASH_DIR,
  conflictName,
  isSynced,
  syncOnce,
  type SyncReport,
  type SyncState,
} from '../../src/main/teamSync/engine';
import { TeamSyncService, isInside, teamSyncConfigProblem } from '../../src/main/teamSync/service';
import { agoText, normalizeTeamSync, teamSyncBadge, teamSyncSummary } from '../../src/renderer/lib/teamSync';
import type { TeamSyncStatus } from '../../src/shared/types';

const temps: string[] = [];
afterEach(() => {
  for (const d of temps.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function setup(): { remote: string; local: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-radar-teamsync-'));
  temps.push(dir);
  const remote = path.join(dir, 'nas');
  fs.mkdirSync(remote);
  return { remote, local: path.join(dir, 'pc') };
}

let clock = Date.UTC(2026, 9, 13, 6, 0, 0);
/** 파일을 쓰고 수정 시각을 매번 다르게 둔다(같은 ms 안에 두 번 쓰면 바뀐 것을 못 알아보므로) */
function put(root: string, rel: string, text: string): void {
  const p = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  clock += 5000;
  fs.utimesSync(p, clock / 1000, clock / 1000);
}
function read(root: string, rel: string): string | null {
  try {
    return fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');
  } catch {
    return null;
  }
}
function list(root: string, sub = ''): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else out.push(r);
    }
  };
  walk(path.join(root, sub), '');
  return out.sort();
}

const NOW = new Date(2026, 9, 13, 15, 30);
function run(remote: string, local: string, state: SyncState | null, extra: Partial<Parameters<typeof syncOnce>[0]> = {}): Promise<SyncReport> {
  return syncOnce({ remote, local, state, who: '홍길동', now: NOW, ...extra });
}

describe('팀 위키 동기화 — 처음', () => {
  it('빈 내 PC 폴더로 NAS 를 모두 받고, 다시 돌리면 할 일이 없다', async () => {
    const { remote, local } = setup();
    put(remote, 'README.md', '안내');
    put(remote, 'wiki/topics/a.md', 'A');
    const r1 = await run(remote, local, null);
    expect(r1.outcome).toBe('done');
    expect(r1.pulled.sort()).toEqual(['README.md', 'wiki/topics/a.md']);
    expect(read(local, 'wiki/topics/a.md')).toBe('A');
    expect(fs.existsSync(path.join(local, LOCAL_MARKER))).toBe(true);
    const r2 = await run(remote, local, r1.state);
    expect([...r2.pulled, ...r2.pushed, ...r2.conflicts]).toEqual([]);
    expect(list(remote)).toEqual(['README.md', 'wiki/topics/a.md']); // 표시 파일은 NAS 로 올라가지 않는다
  });

  it('다른 파일이 있는 폴더로는 처음 동기화를 하지 않는다(개인 위키가 통째로 올라가는 사고 방지)', async () => {
    const { remote, local } = setup();
    put(remote, 'a.md', 'A');
    put(local, '개인/비밀.md', '손익');
    const r = await run(remote, local, null);
    expect(r.outcome).toBe('error');
    expect(r.message).toMatch(/빈 폴더/);
    expect(list(remote)).toEqual(['a.md']);
  });

  it('양쪽에 같은 내용이 이미 있으면 충돌로 보지 않는다', async () => {
    const { remote, local } = setup();
    put(remote, 'a.md', 'same');
    fs.mkdirSync(local, { recursive: true });
    fs.writeFileSync(path.join(local, LOCAL_MARKER), '');
    put(local, 'a.md', 'same');
    const r = await run(remote, local, null);
    expect(r.conflicts).toEqual([]);
    expect(r.state?.files['a.md']).toBeTruthy();
  });
});

describe('팀 위키 동기화 — 한쪽만 바뀜', () => {
  it('내 PC 수정·새 문서는 올리고, NAS 수정은 받는다', async () => {
    const { remote, local } = setup();
    put(remote, 'a.md', 'A1');
    put(remote, 'b.md', 'B1');
    let s = (await run(remote, local, null)).state;
    put(local, 'a.md', 'A2-내수정');
    put(local, 'wiki/새 문서.md', '새');
    put(remote, 'b.md', 'B2-팀원수정');
    const r = await run(remote, local, s);
    expect(r.pushed.sort()).toEqual(['a.md', 'wiki/새 문서.md']);
    expect(r.pulled).toEqual(['b.md']);
    expect(read(remote, 'a.md')).toBe('A2-내수정');
    expect(read(remote, 'wiki/새 문서.md')).toBe('새');
    expect(read(local, 'b.md')).toBe('B2-팀원수정');
    s = r.state;
    const again = await run(remote, local, s);
    expect([...again.pulled, ...again.pushed]).toEqual([]);
  });

  it('수정 시각만 바뀌고 내용이 같으면 아무것도 옮기지 않는다', async () => {
    const { remote, local } = setup();
    put(remote, 'a.md', 'A');
    const s = (await run(remote, local, null)).state;
    put(local, 'a.md', 'A');
    const r = await run(remote, local, s);
    expect([...r.pulled, ...r.pushed, ...r.conflicts]).toEqual([]);
  });

  it('지운 것은 지우지 않고 반대쪽 휴지통으로 옮긴다', async () => {
    const { remote, local } = setup();
    put(remote, 'wiki/a.md', 'A');
    put(remote, 'b.md', 'B');
    const s = (await run(remote, local, null)).state;
    fs.rmSync(path.join(local, 'wiki', 'a.md'));
    fs.rmSync(path.join(remote, 'b.md'));
    const r = await run(remote, local, s);
    expect(r.deletedRemote).toEqual(['wiki/a.md']);
    expect(r.deletedLocal).toEqual(['b.md']);
    expect(read(remote, `${TRASH_DIR}/2026-10-13/wiki/a.md`)).toBe('A');
    expect(read(local, `${TRASH_DIR}/2026-10-13/b.md`)).toBe('B');
    expect(fs.existsSync(path.join(remote, 'wiki'))).toBe(false); // 비어 버린 폴더는 정리
    expect(Object.keys(r.state!.files)).toEqual([]);
  });
});

describe('팀 위키 동기화 — 양쪽 다 바뀜', () => {
  it('둘 다 고치면 내 수정은 충돌 사본으로 양쪽에 남고 본문은 NAS 쪽이 된다', async () => {
    const { remote, local } = setup();
    put(remote, 'wiki/a.md', '원본');
    const s = (await run(remote, local, null)).state;
    put(local, 'wiki/a.md', '내 수정');
    put(remote, 'wiki/a.md', '팀원 수정');
    const r = await run(remote, local, s);
    const copy = conflictName('wiki/a.md', '홍길동', NOW);
    expect(copy).toBe('wiki/a (충돌 홍길동 10-13 1530).md');
    expect(r.conflicts).toEqual([copy]);
    expect(read(local, 'wiki/a.md')).toBe('팀원 수정');
    expect(read(remote, 'wiki/a.md')).toBe('팀원 수정');
    expect(read(local, copy)).toBe('내 수정');
    expect(read(remote, copy)).toBe('내 수정');
    const again = await run(remote, local, r.state);
    expect([...again.pulled, ...again.pushed, ...again.conflicts]).toEqual([]);
  });

  it('삭제와 수정이 맞서면 수정이 이긴다(양방향)', async () => {
    const { remote, local } = setup();
    put(remote, 'a.md', 'A');
    put(remote, 'b.md', 'B');
    const s = (await run(remote, local, null)).state;
    fs.rmSync(path.join(local, 'a.md'));
    put(remote, 'a.md', 'A-팀원수정');
    put(local, 'b.md', 'B-내수정');
    fs.rmSync(path.join(remote, 'b.md'));
    const r = await run(remote, local, s);
    expect(r.pulled).toEqual(['a.md']);
    expect(r.pushed).toEqual(['b.md']);
    expect(read(local, 'a.md')).toBe('A-팀원수정');
    expect(read(remote, 'b.md')).toBe('B-내수정');
  });

  it('처음 동기화에서 같은 이름·다른 내용이면 충돌 사본을 만든다', async () => {
    const { remote, local } = setup();
    put(remote, 'a.md', 'NAS');
    fs.mkdirSync(local, { recursive: true });
    fs.writeFileSync(path.join(local, LOCAL_MARKER), '');
    put(local, 'a.md', 'PC');
    const r = await run(remote, local, null);
    expect(r.conflicts).toHaveLength(1);
    expect(read(local, 'a.md')).toBe('NAS');
    expect(read(remote, r.conflicts[0])).toBe('PC');
  });
});

describe('팀 위키 동기화 — 안전장치', () => {
  it('한 번에 많이 지우게 되면 멈추고, 확인하면 진행한다', async () => {
    const { remote, local } = setup();
    for (let i = 0; i < 12; i++) put(remote, `d/${i}.md`, `x${i}`);
    const s = (await run(remote, local, null)).state;
    fs.rmSync(path.join(local, 'd'), { recursive: true });
    put(local, 'keep.md', 'k'); // 폴더가 통째로 빈 것은 아니다
    const paused = await run(remote, local, s);
    expect(paused.outcome).toBe('paused');
    expect(paused.pending?.deletes).toBe(12);
    expect(paused.state).toBe(s);
    expect(list(remote, 'd')).toHaveLength(12); // 아무것도 바꾸지 않았다
    const go = await run(remote, local, s, { confirmLarge: true });
    expect(go.outcome).toBe('done');
    expect(go.deletedRemote).toHaveLength(12);
    // 파일 수십 개를 두 번 오가므로 전체 시험이 함께 돌 때(부하) 5초 기본 한도를 넘을 수 있다
  }, 30_000);

  it('NAS 가 비어 보이면 내 PC 를 지우지 않고 오류로 멈춘다', async () => {
    const { remote, local } = setup();
    put(remote, 'a.md', 'A');
    const s = (await run(remote, local, null)).state;
    fs.rmSync(path.join(remote, 'a.md'));
    const r = await run(remote, local, s);
    expect(r.outcome).toBe('error');
    expect(r.message).toMatch(/비어 보입니다/);
    expect(read(local, 'a.md')).toBe('A');
  });

  it('NAS 에 연결할 수 없으면 아무것도 하지 않는다', async () => {
    const { remote, local } = setup();
    const r = await run(path.join(remote, '없는폴더'), local, null);
    expect(r.outcome).toBe('error');
    expect(r.message).toMatch(/연결할 수 없습니다/);
  });

  it('내 PC 사본을 통째로 지웠으면 NAS 를 지우지 않고 다시 받는다', async () => {
    const { remote, local } = setup();
    put(remote, 'a.md', 'A');
    put(remote, 'b.md', 'B');
    const s = (await run(remote, local, null)).state;
    fs.rmSync(local, { recursive: true });
    const r = await run(remote, local, s);
    expect(r.outcome).toBe('done');
    expect(r.deletedRemote).toEqual([]);
    expect(r.pulled.sort()).toEqual(['a.md', 'b.md']);
  });

  it('창 배치·임시·휴지통·Synology 폴더는 동기화하지 않는다', async () => {
    expect(isSynced('.obsidian/workspace.json')).toBe(false);
    expect(isSynced('.obsidian/workspace-mobile.json')).toBe(false);
    expect(isSynced('.obsidian/app.json')).toBe(true);
    expect(isSynced('wiki/~$문서.docx')).toBe(false);
    expect(isSynced('.휴지통/2026-10-13/a.md')).toBe(false);
    expect(isSynced('@eaDir/a.md')).toBe(false);
    expect(isSynced('#recycle/a.md')).toBe(false);
    expect(isSynced('wiki/.a.md.1234abcd.wiki-radar-tmp')).toBe(false);
    expect(isSynced(LOCAL_MARKER)).toBe(false);
    expect(isSynced('팀장 정리/.wiki-export')).toBe(true);

    const { remote, local } = setup();
    put(remote, 'a.md', 'A');
    const s = (await run(remote, local, null)).state;
    put(local, '.obsidian/workspace.json', '{"내 창":1}');
    put(remote, '.obsidian/workspace.json', '{"남의 창":1}');
    const r = await run(remote, local, s);
    expect([...r.pulled, ...r.pushed, ...r.conflicts]).toEqual([]);
    expect(read(local, '.obsidian/workspace.json')).toBe('{"내 창":1}');
  });

  it('경로가 바뀌면 지난 기준을 쓰지 않는다', async () => {
    const { remote, local } = setup();
    put(remote, 'a.md', 'A');
    const s = (await run(remote, local, null)).state!;
    const other = { ...s, remote: path.join(remote, '..', 'other') };
    put(local, 'b.md', 'B');
    // 기준이 무시되면 처음 동기화와 같다 — 표시 파일이 있으므로 진행하고, a.md 는 같은 내용이라 그대로
    const r = await run(remote, local, other);
    expect(r.outcome).toBe('done');
    expect(r.pushed).toEqual(['b.md']);
  });
});

// ---- 서비스(주기·한 번에 하나)·화면 문장 -------------------------------------------

describe('팀 위키 동기화 — 설정 검사', () => {
  it('개인 위키와 겹치거나 NAS 와 겹치는 폴더는 거부한다', () => {
    const W = process.platform === 'win32' ? 'C:\Users\a\OneDrive\Obsidian\WIKI' : '/home/a/WIKI';
    const N = process.platform === 'win32' ? '\\nas\share\WIKI' : '/mnt/nas/WIKI';
    const ok = process.platform === 'win32' ? 'C:\Users\a\dc-wiki' : '/home/a/dc-wiki';
    expect(teamSyncConfigProblem({ enabled: true, remote: N, local: ok }, [W])).toBeNull();
    expect(teamSyncConfigProblem({ enabled: true, remote: N, local: W }, [W])).toMatch(/개인 위키/);
    expect(teamSyncConfigProblem({ enabled: true, remote: N, local: path.join(W, 'team') }, [W])).toMatch(/개인 위키/);
    expect(teamSyncConfigProblem({ enabled: true, remote: N, local: path.dirname(W) }, [W])).toMatch(/개인 위키/);
    expect(teamSyncConfigProblem({ enabled: true, remote: N, local: path.join(N, 'x') }, [])).toMatch(/서로 안에/);
    expect(isInside(ok, path.dirname(ok))).toBe(true);
    expect(isInside(path.dirname(ok), ok)).toBe(false);
  });
});

describe('팀 위키 동기화 — 서비스', () => {
  it('켜져 있으면 동기화하고 상태를 알리며, 기준 상태를 저장한다', async () => {
    const { remote, local } = setup();
    put(remote, 'a.md', 'A');
    const dataDir = path.join(path.dirname(remote), 'data');
    const seen: TeamSyncStatus[] = [];
    const svc = new TeamSyncService({
      dataDir,
      config: () => ({ enabled: true, remote, local }),
      who: '홍길동',
      onStatus: (s) => seen.push(s),
      noWatch: true,
      startDelayMs: 60_000,
    });
    svc.start();
    const st = await svc.runNow();
    expect(st.phase).toBe('idle');
    expect(st.last?.pulled).toBe(1);
    expect(st.recent[0]).toMatchObject({ rel: 'a.md', dir: 'in' });
    expect(seen.some((s) => s.phase === 'running')).toBe(true);
    expect(fs.existsSync(path.join(dataDir, 'team-sync-state.json'))).toBe(true);
    // 기준 상태가 저장됐으므로 NAS 에서 지운 것이 내 PC 휴지통으로 간다(처음 동기화처럼 다시 올리지 않는다)
    put(remote, 'b.md', 'B');
    fs.rmSync(path.join(remote, 'a.md'));
    const st2 = await svc.runNow();
    expect(st2.last).toMatchObject({ pulled: 1, deleted: 1 });
    expect(read(remote, 'a.md')).toBeNull();
    svc.stop();
  });

  it('꺼져 있으면 아무것도 하지 않는다 · 겹치는 폴더면 오류로 알린다', async () => {
    const { remote, local } = setup();
    put(remote, 'a.md', 'A');
    const dataDir = path.join(path.dirname(remote), 'data');
    let enabled = false;
    const svc = new TeamSyncService({
      dataDir,
      config: () => ({ enabled, remote, local }),
      who: 'x',
      onStatus: () => {},
      noWatch: true,
      startDelayMs: 60_000,
      forbidden: () => [local],
    });
    svc.start();
    expect((await svc.runNow()).phase).toBe('off');
    expect(fs.existsSync(local)).toBe(false);
    enabled = true;
    svc.reconfigure();
    const st = await svc.runNow();
    expect(st.phase).toBe('error');
    expect(st.message).toMatch(/개인 위키/);
    svc.stop();
  });
});

describe('팀 위키 동기화 — 마지막 성공은 그 사본 경로의 것만(검토 지적)', () => {
  it('사본 경로를 바꾸면 새 경로의 첫 동기화 전까지 lastOkAt 이 없다 · 시작 알림은 훑기 전에', async () => {
    const { remote, local } = setup();
    put(remote, 'a.md', 'A');
    const dataDir = path.join(path.dirname(remote), 'data');
    let cur = local;
    const starts: string[] = [];
    const svc = new TeamSyncService({
      dataDir,
      config: () => ({ enabled: true, remote, local: cur }),
      who: 'x',
      onStatus: () => {},
      noWatch: true,
      startDelayMs: 60_000,
      onSyncStart: (l) => starts.push(l),
    });
    svc.start();
    expect((await svc.runNow()).lastOkAt).toBeTruthy();
    expect(starts).toEqual([local]);
    cur = path.join(path.dirname(local), 'pc2');
    svc.reconfigure();
    expect(svc.status().lastOkAt).toBeUndefined();
    expect((await svc.runNow()).lastOkAt).toBeTruthy();
    svc.stop();
  });
});

describe('팀 위키 동기화 — 화면 문장', () => {
  const NOWD = new Date('2026-10-13T06:30:00Z');
  const base: TeamSyncStatus = { enabled: true, remote: '\\nas\WIKI', local: 'C:\dc-wiki', phase: 'idle', recent: [] };
  it('응답 모양을 검사한다', () => {
    expect(normalizeTeamSync(null)).toBeNull();
    expect(normalizeTeamSync({ ...base, phase: 'weird' })).toBeNull();
    const n = normalizeTeamSync({ ...base, recent: [{ rel: 'a.md', dir: 'in', at: 'x' }, { rel: 1 }], last: { pulled: 2, conflicts: ['c'], skipped: [{ rel: 'z', reason: 'r' }, 3] } });
    expect(n?.recent).toHaveLength(1);
    expect(n?.last).toMatchObject({ pulled: 2, pushed: 0, conflicts: ['c'], skipped: [{ rel: 'z', reason: 'r' }] });
  });
  it('상태별 문장·사이드바 칸', () => {
    expect(agoText('2026-10-13T06:27:00Z', NOWD)).toBe('3분 전');
    expect(agoText('2026-10-13T06:29:50Z', NOWD)).toBe('방금');
    expect(teamSyncSummary({ ...base, enabled: false, phase: 'off' }, NOWD).state).toBe('꺼짐');
    expect(teamSyncSummary({ ...base, lastOkAt: '2026-10-13T06:27:00Z' }, NOWD).detail).toMatch(/3분 전/);
    expect(teamSyncSummary({ ...base, phase: 'paused', message: '멈춤' }, NOWD)).toMatchObject({ tone: 'warn', detail: '멈춤' });
    expect(teamSyncSummary({ ...base, last: { pulled: 0, pushed: 0, deleted: 0, conflicts: ['a'], skipped: [] } }, NOWD).state).toBe('충돌 1건');
    expect(teamSyncBadge(null)).toBeNull();
    expect(teamSyncBadge({ ...base, enabled: false, phase: 'off' })).toBeNull();
    expect(teamSyncBadge(base)).toEqual({ label: '켜짐', attention: false });
    expect(teamSyncBadge({ ...base, phase: 'error' })).toEqual({ label: '오류', attention: true });
  });
});
