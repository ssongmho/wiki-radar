// 3a단계 §3·§5·§6 위키 문서 서비스: 두 출처 색인·검색·문서 읽기·그림·변경 피드(개인·팀)·다시 시작. 테스트 사본의 임시 복사본만 쓴다.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WikiDocsService, type WikiDocsServiceDeps } from '../../src/main/wiki/docService';
import { IMAGE_REASONS } from '../../src/main/wiki/docInput';
import type { WikiDocsSummary } from '../../src/shared/types';

const FIXTURE = path.resolve(__dirname, '..', 'fixtures', 'wiki');
const TEAM_FIXTURE = path.resolve(__dirname, '..', 'fixtures', 'team-wiki');

const temps: string[] = [];
const services: WikiDocsService[] = [];
afterEach(() => {
  for (const s of services.splice(0)) s.stop();
  for (const t of temps.splice(0)) fs.rmSync(t, { recursive: true, force: true });
});

interface Env {
  wiki: string;
  team: string;
  data: string;
  sync: { phase: string; lastOkAt?: string };
  teamEnabled: boolean;
  clock: { t: number };
  summaries: WikiDocsSummary[];
}

function setup(): Env {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-radar-docsvc-'));
  temps.push(root);
  const wiki = path.join(root, 'wiki');
  const team = path.join(root, 'team');
  const data = path.join(root, 'data');
  fs.cpSync(FIXTURE, wiki, { recursive: true });
  fs.cpSync(TEAM_FIXTURE, team, { recursive: true });
  fs.mkdirSync(data);
  return { wiki, team, data, sync: { phase: 'idle' }, teamEnabled: true, clock: { t: Date.parse('2026-09-23T01:00:00Z') }, summaries: [] };
}

function make(env: Env, extra: Partial<WikiDocsServiceDeps> = {}): WikiDocsService {
  const s = new WikiDocsService({
    dataDir: env.data,
    now: () => new Date((env.clock.t += 1000)),
    today: () => '2026-09-23',
    personalRoot: () => env.wiki,
    team: () => ({ enabled: env.teamEnabled, local: env.team, problem: null }),
    teamSync: () => env.sync,
    onSummary: (sum) => env.summaries.push(sum),
    recheckMs: 3_600_000,
    writeDelayMs: 10,
    ...extra,
  });
  services.push(s);
  return s;
}

function treeDigest(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string, rel: string) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(path.join(dir, ent.name), r);
      else out[r] = createHash('sha1').update(fs.readFileSync(path.join(dir, ent.name))).digest('hex');
    }
  };
  walk(root, '');
  return out;
}

function edit(root: string, rel: string, fn: (text: string) => string): void {
  const abs = path.join(root, ...rel.split('/'));
  fs.writeFileSync(abs, fn(fs.readFileSync(abs, 'utf8')), 'utf8');
  const t = new Date(Date.now() + 10_000);
  fs.utimesSync(abs, t, t);
}

describe('색인·검색·읽기', () => {
  it('두 출처 검색·제외·별칭·읽기 전용', async () => {
    const env = setup();
    env.sync.lastOkAt = '2026-09-23T00:00:00Z';
    const before = { wiki: treeDigest(env.wiki), team: treeDigest(env.team) };
    const s = make(env);
    await s.start();
    const sum = s.summary();
    expect(sum.sources.personal).toMatchObject({ state: 'ready', docs: 13 });
    expect(sum.sources.team).toMatchObject({ state: 'ready', docs: 5 });
    expect(sum.changes).toEqual({ personal: 0, team: 0, total: 0 });

    const inv = s.search({ query: '인벤토리', source: 'all', limit: 50, offset: 0 });
    expect(inv.hits[0].title).toBe('CMS 인벤토리 사용량 집계');
    expect(inv.counts.personal).toBeGreaterThanOrEqual(1);
    expect(inv.counts.team).toBeGreaterThanOrEqual(1);
    expect(s.search({ query: '인벤토리', source: 'team', limit: 50, offset: 0 }).hits.every((h) => h.source === 'team')).toBe(true);
    expect(s.search({ query: '대륙', source: 'all', limit: 50, offset: 0 }).hits[0].path).toBe('wiki/entities/대륙물산.md');
    for (const word of ['옛 회의록', '회의록 템플릿', '클로드명령전용문구', '템플릿전용문구', '자재 단가 문의 메일입니다', '충돌']) {
      expect(s.search({ query: word, source: 'all', limit: 50, offset: 0 }).hits.filter((h) => h.path.includes('충돌') || h.path.includes('.휴지통') || h.path.startsWith('templates/') || h.path.startsWith('.claude/') || h.path.startsWith('raw/')), word).toEqual([]);
    }
    expect(s.search({ query: '클로드명령전용문구', source: 'all', limit: 50, offset: 0 }).total).toBe(0);
    expect(s.search({ query: '목표', source: 'personal', limit: 50, offset: 0 }).hits.find((h) => h.path === '_private/mgmt/연간 목표.md')?.private).toBe(true);
    expect(s.recent('all', 10)).toHaveLength(10);

    s.flushNow();
    expect(fs.existsSync(path.join(env.data, 'wiki-index.json'))).toBe(true);
    expect(fs.existsSync(path.join(env.data, 'wiki-seen.json'))).toBe(true);
    expect(treeDigest(env.wiki)).toEqual(before.wiki);
    expect(treeDigest(env.team)).toEqual(before.team);
  });

  it('getWikiPage: 링크 해석(같은 출처 우선·다른 출처·미작성)·그림·색인에 없는 경로', async () => {
    const env = setup();
    env.sync.lastOkAt = '2026-09-23T00:00:00Z';
    const s = make(env);
    await s.start();
    const page = await s.page('personal', 'wiki/topics/dev/배치 마감 경계 조건.md');
    expect(page).not.toBeNull();
    expect(page!.title).toBe('배치 마감 경계 조건');
    expect(page!.links['한결케미칼']).toEqual({ source: 'personal', path: 'wiki/entities/한결케미칼.md' });
    expect(page!.links['없는 문서']).toBeNull();
    expect(page!.links['CMS 인벤토리 사용량 집계#원인']).toEqual({ source: 'personal', path: 'wiki/topics/dev/CMS 인벤토리 사용량 집계.md', heading: '원인' });
    expect(Object.keys(page!.links)).not.toContain('코드 안 링크');
    expect(page!.images['경계조건.png']).toEqual({ ok: true });
    expect(page!.images['https://tracker.example.invalid/p.png']).toEqual({ ok: false, reason: IMAGE_REASONS.remote });
    expect(page!.fm.type).toBe('topic');
    expect(page!.body).not.toMatch(/^---/);

    const teamPage = await s.page('team', '운영/배포 절차.md');
    expect(teamPage!.links['CMS 인벤토리 사용량 집계']).toEqual({ source: 'team', path: 'wiki/topics/dev/CMS 인벤토리 사용량 집계.md' });
    expect(teamPage!.links['한결케미칼']).toEqual({ source: 'personal', path: 'wiki/entities/한결케미칼.md', crossSource: true });
    expect(teamPage!.links['서버 점검']).toEqual({ source: 'team', path: '운영/서버 점검.md' });

    // 색인에 없는 경로(제외 폴더·없는 파일)는 null
    const rawMail = fs.readdirSync(path.join(env.wiki, 'raw', 'mail', '대륙물산', '2026'))[0];
    expect(await s.page('personal', `raw/mail/대륙물산/2026/${rawMail}`)).toBeNull();
    expect(await s.page('personal', 'templates/문서 틀.md')).toBeNull();
    expect(await s.page('personal', '.claude/commands/x.md')).toBeNull();
    expect(await s.page('team', '운영/서버 점검 (충돌 홍길동 09-22 1530).md')).toBeNull();
    expect(await s.page('team', 'wiki/entities/한결케미칼.md')).toBeNull();
  });

  it('getWikiImage: data URL · 본문에 없는 참조·SVG·서명 불일치·5MB 거부', async () => {
    const env = setup();
    const page = 'wiki/topics/dev/배치 마감 경계 조건.md';
    edit(env.wiki, page, (t) => `${t}\n![[다이어그램.svg]] ![[가짜.png]] ![[큰.png]]\n`);
    fs.writeFileSync(path.join(env.wiki, 'wiki/topics/dev/_img/다이어그램.svg'), '<svg/>');
    fs.writeFileSync(path.join(env.wiki, 'wiki/topics/dev/_img/가짜.png'), '<svg onload="x"/>');
    fs.writeFileSync(path.join(env.wiki, 'wiki/topics/dev/_img/큰.png'), Buffer.alloc(5 * 1024 * 1024 + 1));
    const s = make(env);
    await s.start();
    const ok = await s.image('personal', page, '경계조건.png');
    expect('dataUrl' in ok && ok.dataUrl.startsWith('data:image/png;base64,')).toBe(true);
    expect(await s.image('personal', page, '없는그림.png')).toEqual({ problem: '문서에 없는 그림 참조입니다' });
    expect(await s.image('personal', page, '다이어그램.svg')).toEqual({ problem: IMAGE_REASONS.svg });
    expect(await s.image('personal', page, '가짜.png')).toEqual({ problem: IMAGE_REASONS.signature });
    expect(await s.image('personal', page, '큰.png')).toEqual({ problem: IMAGE_REASONS.big });
    expect(await s.image('personal', page, 'https://tracker.example.invalid/p.png')).toEqual({ problem: IMAGE_REASONS.remote });
    expect(await s.image('personal', 'templates/문서 틀.md', '경계조건.png')).toEqual({ problem: '색인에 없는 문서입니다' });
    const team = await s.image('team', '운영/배포 절차.md', '배포도.png');
    expect('dataUrl' in team).toBe(true);
  });
});

describe('변경 피드', () => {
  it('개인: 바뀜(log 이유·줄 수)·새 문서·지움 → 읽음·모두 읽음·되돌리기', async () => {
    const env = setup();
    const s = make(env);
    await s.start();
    expect(s.changes({ source: 'personal', offset: 0, limit: 200 })).toMatchObject({ state: 'ready', items: [], total: 0 });
    // 팀은 첫 동기화 전 — 기다림
    expect(s.changes({ source: 'team', offset: 0, limit: 200 }).state).toBe('waiting');

    edit(env.wiki, 'wiki/entities/한결케미칼.md', (t) => `${t}\n- 사용량 회신 반영 완료\n`);
    edit(env.wiki, 'log.md', (t) => `${t}\n## [2026-09-23] update | 사용량 회신 반영\n\n[[한결케미칼]] 회신을 반영했다.\n`);
    fs.writeFileSync(path.join(env.wiki, 'wiki/topics/새 주제.md'), '# 새 주제\n처음 쓰는 글');
    fs.rmSync(path.join(env.wiki, 'wiki/entities/해온정밀.md'));
    await s.refresh('personal');
    const page = s.changes({ source: 'personal', offset: 0, limit: 200 });
    expect(page.items.map((i) => [i.path, i.change])).toEqual(
      expect.arrayContaining([
        ['wiki/entities/한결케미칼.md', 'changed'],
        ['wiki/topics/새 주제.md', 'new'],
        ['wiki/entities/해온정밀.md', 'deleted'],
      ]),
    );
    expect(page.total).toBe(3);
    const hg = page.items.find((i) => i.path === 'wiki/entities/한결케미칼.md')!;
    expect(hg.lines).toEqual({ added: 1, removed: 0, sample: ['- 사용량 회신 반영 완료'] });
    expect(hg.reasons?.[0]).toMatchObject({ date: '2026-09-23', kind: 'update', title: '사용량 회신 반영' });
    expect(page.items.find((i) => i.change === 'new')?.firstLine).toBe('# 새 주제 처음 쓰는 글');
    expect(s.summary().changes).toEqual({ personal: 3, team: 0, total: 3 });
    const p = await s.page('personal', 'wiki/entities/한결케미칼.md');
    expect(p?.change?.change).toBe('changed');

    const one = s.markSeen({ items: [{ source: 'personal', path: 'wiki/entities/한결케미칼.md' }] });
    expect(one.changes.personal).toBe(2);
    const all = s.markSeen({ all: true, source: 'personal' });
    expect(all.changes.personal).toBe(0);
    expect(all.undoToken).toBeTruthy();
    expect(s.undoSeen(all.undoToken!).changes.personal).toBe(2);
    expect(() => s.undoSeen(all.undoToken!)).toThrow(/시간이 지났/);
    s.markSeen({ all: true, source: 'personal' });
    expect(s.summary().changes.total).toBe(0);
    expect(env.summaries.at(-1)?.changes.total).toBe(0);

    // 최근 기록(log.md 14일)
    const recent = s.logRecent();
    expect(recent[0]).toMatchObject({ date: '2026-09-23', title: '사용량 회신 반영' });
    expect(recent[0].docs.map((d) => d.path)).toEqual(['wiki/entities/한결케미칼.md']);
    expect(recent.some((r) => r.date === '2026-02-30')).toBe(false);
  });

  it('개인: 할 일 원천·log·index 는 변경이 아니고, 앱이 쓴 파일은 읽음으로', async () => {
    const env = setup();
    const s = make(env);
    await s.start();
    edit(env.wiki, '_private/mgmt/내 할 일.md', (t) => `${t}\n추가\n`);
    edit(env.wiki, 'index.md', (t) => `${t}\n추가\n`);
    await s.refresh('personal');
    expect(s.summary().changes.personal).toBe(0);
    edit(env.wiki, 'wiki/entities/서진화학.md', (t) => `${t}\n앱이 씀\n`);
    const from = env.summaries.length;
    // 감시가 먼저 돌고 있어도(동시에) 잠깐도 「변경」으로 방송되지 않는다
    await Promise.all([s.refresh('personal'), s.noteOwnWrite('personal', ['wiki/entities/서진화학.md'])]);
    expect(s.summary().changes.personal).toBe(0);
    expect(env.summaries.slice(from).every((x) => x.changes.personal === 0)).toBe(true);
  });

  it('팀: 첫 동기화 뒤 기준선 · 내가 고친 것은 숨김 → pushed 로 읽음 · 받은 것은 변경(+줄 수)', async () => {
    const env = setup();
    const s = make(env);
    await s.start();
    expect(s.changes({ source: 'team', offset: 0, limit: 200 }).state).toBe('waiting');
    env.sync.lastOkAt = '2026-09-23T01:00:00Z';
    await s.onTeamSynced({ outcome: 'done', pushed: [], deletedRemote: [] });
    expect(s.changes({ source: 'team', offset: 0, limit: 200 })).toMatchObject({ state: 'ready', total: 0 });

    // 내가 사본을 고침 → 감시가 색인해도 보이지 않는다
    edit(env.team, '운영/서버 점검.md', (t) => `${t}\n내가 더한 줄\n`);
    await s.refresh('team');
    expect(s.changes({ source: 'team', offset: 0, limit: 200 }).total).toBe(0);
    // 다른 사람이 고친 것을 받음(pulled) + 내 것은 올림(pushed)
    edit(env.team, '회의록/2026-09-22 주간회의.md', (t) => `${t}\n팀원이 더한 첫 줄\n팀원이 더한 둘째 줄\n`);
    await s.onTeamSynced({ outcome: 'done', pushed: ['운영/서버 점검.md'], deletedRemote: [] });
    const page = s.changes({ source: 'team', offset: 0, limit: 200 });
    expect(page.items.map((i) => [i.path, i.change, i.lines?.added, i.lines?.removed, i.lines?.sample[0]])).toEqual([
      ['회의록/2026-09-22 주간회의.md', 'changed', 2, 0, '팀원이 더한 첫 줄'],
    ]);
    expect(page.items[0].reasons).toBeUndefined();
    env.sync.phase = 'paused';
    expect(s.changes({ source: 'team', offset: 0, limit: 200 }).syncNote).toMatch(/멈춰/);
  });

  it('팀: 동기화가 도는 중에는 기준선을 잡지 않고 끝날 때 잡는다(검토 지적 — 반쯤 받은 사본)', async () => {
    const env = setup();
    env.sync = { phase: 'running', lastOkAt: '2026-09-23T00:00:00Z' };
    const s = make(env);
    await s.start();
    expect(s.changes({ source: 'team', offset: 0, limit: 200 }).state).toBe('waiting');
    env.sync.phase = 'idle';
    await s.onTeamSynced({ outcome: 'done', pushed: [], deletedRemote: [] });
    expect(s.changes({ source: 'team', offset: 0, limit: 200 })).toMatchObject({ state: 'ready', total: 0 });
  });

  it('팀: 동기화하는 동안 내가 고친 것은 그 동기화가 끝나도 숨김, 받은 것은 보임(검토 지적 §5-3)', async () => {
    const env = setup();
    env.sync.lastOkAt = '2026-09-23T00:00:00Z';
    const s = make(env);
    await s.start();
    expect(s.changes({ source: 'team', offset: 0, limit: 200 }).state).toBe('ready');
    s.noteTeamSyncStart();
    // 동기화가 사본을 훑은 뒤: 내가 저장 → 감시가 색인
    edit(env.team, '운영/서버 점검.md', (t) => `${t}\n동기화 중 내가 더함\n`);
    await s.refresh('team');
    // 동기화가 받은 것
    edit(env.team, '회의록/2026-09-22 주간회의.md', (t) => `${t}\n팀원이 더함\n`);
    await s.onTeamSynced({ outcome: 'done', pushed: [], deletedRemote: [], pulled: ['회의록/2026-09-22 주간회의.md'], deletedLocal: [] });
    expect(s.changes({ source: 'team', offset: 0, limit: 200 }).items.map((i) => i.path)).toEqual(['회의록/2026-09-22 주간회의.md']);
    // 다음 동기화가 내 것을 올리면 읽음으로 — 끝내 보이지 않는다
    s.noteTeamSyncStart();
    await s.onTeamSynced({ outcome: 'done', pushed: ['운영/서버 점검.md'], deletedRemote: [], pulled: [], deletedLocal: [] });
    expect(s.changes({ source: 'team', offset: 0, limit: 200 }).items.map((i) => i.path)).toEqual(['회의록/2026-09-22 주간회의.md']);
  });

  it('팀 동기화를 끄면 출처가 빠지고(메모리·캐시) 켜면 다시', async () => {
    const env = setup();
    env.sync.lastOkAt = '2026-09-23T00:00:00Z';
    const s = make(env);
    await s.start();
    env.teamEnabled = false;
    await s.reconfigure();
    expect(s.summary().sources.team).toMatchObject({ state: 'off', docs: 0 });
    expect(s.search({ query: '배포', source: 'all', limit: 50, offset: 0 }).counts.team).toBe(0);
    s.flushNow();
    expect(JSON.parse(fs.readFileSync(path.join(env.data, 'wiki-index.json'), 'utf8')).sources.team).toBeUndefined();
    env.teamEnabled = true;
    await s.reconfigure();
    expect(s.summary().sources.team.state).toBe('ready');
  });

  it('다시 시작: 꺼진 동안 바뀐 문서는 캐시 본문으로 줄 수를 센다', async () => {
    const env = setup();
    const s1 = make(env);
    await s1.start();
    s1.stop();
    edit(env.wiki, 'wiki/entities/서진화학.md', (t) => `${t}\n꺼진 동안 더함\n`);
    const s2 = make(env);
    await s2.start();
    const items = s2.changes({ source: 'personal', offset: 0, limit: 200 }).items;
    expect(items.map((i) => [i.path, i.change, i.lines?.added, i.lines?.removed])).toEqual([['wiki/entities/서진화학.md', 'changed', 1, 0]]);
  });

  it('개인 위키가 없으면 noWiki, 둘 다 없으면 둘 다 쓸 수 없음', async () => {
    const env = setup();
    fs.rmSync(env.wiki, { recursive: true, force: true });
    env.teamEnabled = false;
    const s = make(env);
    await s.start();
    expect(s.summary().sources.personal.state).toBe('noWiki');
    expect(s.summary().sources.team.state).toBe('off');
    expect(s.search({ query: '한결', source: 'all', limit: 50, offset: 0 }).total).toBe(0);
    expect(s.changes({ source: 'personal', offset: 0, limit: 10 }).state).toBe('noWiki');
  });
});
