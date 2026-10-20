// 명세 §1-4 골든 — 같은 입력을 실제 sync_todo.py 와 레이더 writeback 에 넣고 결과 파일을 대조한다.
//
// 테스트 사본(test/fixtures/wiki)을 임시 폴더 두 곳(py·radar)에 복사한다. py 쪽은 정본 sync_todo.py 를
// <복사본>/_todo-sync/ 에 복사하고 state.json(항목 하나, date 고정)을 써서 `python -B sync_todo.py` 로 돌린다
// (정본 파일은 읽기만 한다). radar 쪽은 applyWriteback 을 같은 입력으로 부른다. backup/·state.json·sync_todo.py·
// 파이썬 캐시를 뺀 모든 파일을 줄바꿈(CRLF→LF)만 맞춰 바이트 단위로 비교한다(sync_todo 는 Windows 에서 CRLF 로 쓴다).
// 체크박스 항목의 state.json 제목·앵커는 정본 build_todo.py 의 core_of 로 만든다(아티팩트가 만드는 값과 같게).
// python 이나 정본 파일이 없으면 건너뛰고 이유를 출력한다.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import holidaysJson from '../../config/holidays-kr.json';
import type { Task, TaskStatus } from '../../src/shared/types';
import { ANCHOR_LINE_RE, checkboxAnchorMatch, checkboxId, curatedId, displayTitle } from '../../src/main/wiki/checkbox';
import { splitLines, toPosix } from '../../src/main/wiki/fsutil';
import { buildSnapshot } from '../../src/main/wiki/snapshot';
import { applyStatus, applyWriteback, syncTitleOf, type WritebackResult } from '../../src/main/wiki/writeback';

const FIXTURE = path.resolve(__dirname, '../fixtures/wiki');
const TODAY = '2026-09-23';
const TODO = '_private/mgmt/내 할 일.md';
const MEMO = '_private/mgmt/할 일 메모.md';
const WORK = '_private/mgmt/업무 현황 종합 분석.md';
const ENTITY = 'wiki/entities/한결케미칼.md';
const CANON_DIR = process.env.WIKI_RADAR_TODO_SYNC || path.join(os.homedir(), 'OneDrive', 'Obsidian', 'WIKI', '_todo-sync');
const SYNC_TODO = path.join(CANON_DIR, 'sync_todo.py');
const BUILD_TODO = path.join(CANON_DIR, 'build_todo.py');
const PY_ENV = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' };

/** 쓸 수 있는 python 명령. 없으면 건너뛸 이유 */
function probe(): { python: string } | { reason: string } {
  if (!fs.existsSync(SYNC_TODO)) return { reason: `정본 sync_todo.py 가 없음: ${SYNC_TODO}` };
  const candidates = [process.env.WIKI_RADAR_PYTHON, 'python', 'python3', 'py'].filter((c): c is string => !!c);
  for (const cmd of candidates) {
    const r = spawnSync(cmd, ['-B', '-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8', env: PY_ENV });
    if (r.status === 0 && r.stdout.trim() === '3') return { python: cmd };
  }
  return { reason: `python 3 을 찾지 못함(${candidates.join(', ')})` };
}

const probed = probe();
const skipReason = 'reason' in probed ? probed.reason : null;
if (skipReason) console.warn(`[writeback 골든] 건너뜀: ${skipReason}`);
const PYTHON = 'python' in probed ? probed.python : 'python';

const temps: string[] = [];
let helperDir = '';

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function at(root: string, rel: string): string {
  return path.join(root, ...rel.split('/'));
}

function read(root: string, rel: string): string {
  return fs.readFileSync(at(root, rel), 'utf8');
}

function write(root: string, rel: string, text: string): void {
  fs.writeFileSync(at(root, rel), text, 'utf8');
}

beforeAll(() => {
  if (skipReason) return;
  // build_todo.py 는 core_of 만 쓴다. 정본을 건드리지 않게 임시 폴더에 복사해 불러온다.
  helperDir = tempDir('wiki-radar-golden-helper-');
  if (fs.existsSync(BUILD_TODO)) fs.copyFileSync(BUILD_TODO, path.join(helperDir, 'build_todo.py'));
});

afterAll(() => {
  while (temps.length) fs.rmSync(temps.pop() as string, { recursive: true, force: true });
});

/** 줄마다 아티팩트(build_todo)가 만드는 { t, m }. build_todo.py 가 없으면 같은 정규식을 옮긴 사본을 쓴다 */
function pyCheckboxItem(line: string): { t: string; m: string } {
  const code = [
    'import sys, json, re, importlib.util, os',
    'p = os.path.join(sys.argv[1], "build_todo.py")',
    'if os.path.exists(p):',
    '    spec = importlib.util.spec_from_file_location("build_todo", p)',
    '    mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod); core_of = mod.core_of',
    'else:',
    '    def core_of(ln):',
    '        c = re.sub(r"^- \\[[ xX]\\]\\s*", "", ln)',
    '        return re.sub(r"\\s*\\[\\w+::[^\\]]*\\]", "", c).strip()',
    'ln = json.loads(sys.stdin.read())',
    'c = core_of(ln)',
    'print(json.dumps({"t": c[:70] + ("…" if len(c) > 70 else ""), "m": c[:40]}, ensure_ascii=False))',
  ].join('\n');
  const r = spawnSync(PYTHON, ['-B', '-c', code, helperDir], { input: JSON.stringify(line), encoding: 'utf8', env: PY_ENV });
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout) as { t: string; m: string };
}

interface PyResult {
  date: string;
  updated: string[];
  logged_done: string[];
  logged_delegated: string[];
  logged_wip?: string[];
  memo: string[];
  unmatched: string[];
  files: string[];
  backup?: string;
}

interface PyItem {
  t: string;
  s: TaskStatus;
  o: string;
  n: string;
  src: string;
  anchors: { f: string; m: string }[];
}

function runSyncTodo(root: string, item: PyItem): PyResult {
  const dir = at(root, '_todo-sync');
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ date: TODAY, items: [item] }, null, 1), 'utf8');
  const r = spawnSync(PYTHON, ['-B', 'sync_todo.py'], { cwd: dir, encoding: 'utf8', env: PY_ENV, timeout: 30_000 });
  expect(r.status, `sync_todo.py 실패: ${r.stderr}`).toBe(0);
  return JSON.parse(r.stdout) as PyResult;
}

/** 비교 대상 파일(볼트 기준, 이름순): backup/·state.json·sync_todo.py·파이썬 캐시 제외 */
function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const ent of fs.readdirSync(rel ? at(root, rel) : root, { withFileTypes: true })) {
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (r === '_todo-sync/backup' || ent.name === '__pycache__') continue;
        walk(r);
      } else if (r !== '_todo-sync/state.json' && r !== '_todo-sync/sync_todo.py') {
        out.push(r);
      }
    }
  };
  walk('');
  return out.sort();
}

/** 파일 → 줄바꿈만 맞춘 바이트 */
function tree(root: string): Map<string, Buffer> {
  const m = new Map<string, Buffer>();
  for (const rel of listFiles(root)) {
    const buf = fs.readFileSync(at(root, rel));
    m.set(rel, Buffer.from(buf.toString('latin1').replace(/\r\n/g, '\n'), 'latin1'));
  }
  return m;
}

function expectSameTrees(py: string, radar: string, label: string): void {
  const a = tree(py);
  const b = tree(radar);
  expect([...b.keys()], `${label}: 파일 목록`).toEqual([...a.keys()]);
  for (const [rel, bytes] of a) {
    const other = b.get(rel) as Buffer;
    if (!bytes.equals(other)) {
      // 다르면 글자로 보여 준다
      expect(other.toString('utf8'), `${label}: ${rel}`).toBe(bytes.toString('utf8'));
    }
  }
}

// ---------------------------------------------------------------- 항목 지정

type Target =
  | { kind: 'curated'; title: string }
  | { kind: 'checkbox'; file: string; needle: string }
  /** items.json 에 없는 큐레이션 항목(앵커를 직접 준다) */
  | { kind: 'adhoc'; title: string; src: string; anchors: { f: string; m: string }[] };

interface Step {
  target: Target;
  status: TaskStatus;
  owner?: string;
  note?: string;
}

const curated = (title: string): Target => ({ kind: 'curated', title });
const checkbox = (file: string, needle: string): Target => ({ kind: 'checkbox', file, needle });

interface RawItem {
  t: string;
  src?: string;
  a?: { f: string; m: string }[];
}

function itemsOf(root: string): RawItem[] {
  return (JSON.parse(read(root, '_todo-sync/items.json')) as { items: RawItem[] }).items;
}

/** 레이더 쪽 Task — 스냅샷에 있으면 스냅샷의 것(실제 흐름), 없으면(완료·위임 등) 스냅샷과 같은 모양으로 만든다 */
function radarTask(root: string, target: Target): Task {
  const snap = buildSnapshot({ wikiRoot: root, today: TODAY, holidays: holidaysJson.holidays });
  if (target.kind === 'checkbox') {
    const lines = splitLines(read(root, target.file));
    const idx = lines.findIndex((l) => ANCHOR_LINE_RE.test(l) && l.includes(target.needle));
    expect(idx, `체크박스 줄: ${target.needle}`).toBeGreaterThanOrEqual(0);
    const fromSnap = snap.tasks.find((t) => t.source === 'checkbox' && t.file === target.file && t.rawLine === lines[idx]);
    if (fromSnap) return fromSnap;
    return {
      id: checkboxId(target.file, lines[idx]),
      source: 'checkbox',
      title: displayTitle(lines[idx]),
      status: 'open',
      file: target.file,
      line: idx + 1,
      rawLine: lines[idx],
      bucket: 'other',
    };
  }
  if (target.kind === 'adhoc') {
    return {
      id: curatedId(target.title),
      source: 'curated',
      title: target.title,
      status: 'open',
      bucket: 'other',
      src: target.src,
      anchors: target.anchors.map((a) => ({ file: a.f, match: a.m })),
    };
  }
  const fromSnap = snap.tasks.find((t) => t.source === 'curated' && t.title === target.title);
  if (fromSnap) return fromSnap;
  const it = itemsOf(root).find((x) => x.t === target.title);
  expect(it, `items.json 항목: ${target.title}`).toBeDefined();
  const task: Task = { id: curatedId(target.title), source: 'curated', title: target.title, status: 'open', bucket: 'other' };
  if (it?.src) task.src = it.src;
  if (it?.a?.length) task.anchors = it.a.map((a) => ({ file: toPosix(a.f.trim()), match: a.m }));
  return task;
}

/** 파이썬 쪽 state.json 항목 — 아티팩트가 넘기던 값 그대로(큐레이션은 items.json 원문, 체크박스는 build_todo core_of) */
function pyItem(root: string, step: Step, radar: Task): PyItem {
  const base = { s: step.status, o: step.owner ?? '', n: step.note ?? '' };
  const { target } = step;
  if (target.kind === 'checkbox') {
    const { t, m } = pyCheckboxItem(radar.rawLine as string);
    return { ...base, t, src: target.file, anchors: [{ f: target.file, m }] };
  }
  if (target.kind === 'adhoc') return { ...base, t: target.title, src: target.src, anchors: target.anchors };
  const it = itemsOf(root).find((x) => x.t === target.title) as RawItem;
  return { ...base, t: it.t, src: it.src ?? '', anchors: it.a ?? [] };
}

let nowSeconds = 0;

/** 한 단계를 양쪽에 적용하고 결과 필드·파일을 대조한다 */
function runStep(py: string, radar: string, step: Step, label: string): { py: PyResult; radar: WritebackResult } {
  const task = radarTask(radar, step.target);
  const item = pyItem(py, step, task);
  // 체크박스: 레이더의 sync_todo 제목·앵커가 아티팩트(build_todo)의 값과 같아야 한다(메모 절을 함께 쓰려면)
  if (task.source === 'checkbox') {
    expect(syncTitleOf(task), `${label}: sync 제목`).toBe(item.t);
    expect(checkboxAnchorMatch(task.rawLine as string), `${label}: 앵커 문구`).toBe(item.anchors[0].m);
  }
  const before = tree(radar);
  const pyRes = runSyncTodo(py, item);
  const res = applyWriteback({
    wikiRoot: radar,
    today: TODAY,
    task,
    status: step.status,
    owner: step.owner,
    note: step.note,
    now: new Date(2026, 8, 23, 10, 0, nowSeconds++ % 60),
  });

  expect(res.updated, `${label}: updated`).toEqual(pyRes.updated);
  expect(res.loggedDone, `${label}: logged_done`).toEqual(pyRes.logged_done);
  expect(res.loggedDelegated, `${label}: logged_delegated`).toEqual(pyRes.logged_delegated);
  expect(res.loggedWip, `${label}: logged_wip`).toEqual(pyRes.logged_wip ?? []);
  expect(res.memo, `${label}: memo`).toBe(pyRes.memo.length > 0);
  expect(res.unmatched, `${label}: unmatched`).toEqual(pyRes.unmatched);
  // 레이더는 내용이 같으면 쓰지 않는다 — 쓴 파일은 파이썬이 쓴 파일 안에 있고, 실제로 내용이 바뀐 파일과 같다
  for (const f of res.files) expect(pyRes.files, `${label}: files`).toContain(f);
  const after = tree(radar);
  const changed = [...after.keys()].filter((k) => !before.get(k)?.equals(after.get(k) as Buffer));
  expect([...res.files].sort(), `${label}: 바뀐 파일`).toEqual(changed.sort());

  expectSameTrees(py, radar, label);
  return { py: pyRes, radar: res };
}

/** 사본 두 벌(준비 작업은 양쪽에 똑같이) */
function pair(prep?: (root: string) => void): { py: string; radar: string } {
  const py = tempDir('wiki-radar-golden-py-');
  const radar = tempDir('wiki-radar-golden-radar-');
  for (const root of [py, radar]) {
    fs.cpSync(FIXTURE, root, { recursive: true });
    prep?.(root);
  }
  fs.copyFileSync(SYNC_TODO, at(py, '_todo-sync/sync_todo.py'));
  expectSameTrees(py, radar, '준비');
  return { py, radar };
}

function scenario(steps: Step[], prep?: (root: string) => void): { py: string; radar: string; results: WritebackResult[] } {
  const { py, radar } = pair(prep);
  const results = steps.map((s, i) => runStep(py, radar, s, `${i + 1}단계 ${JSON.stringify(s.target)} → ${s.status}`).radar);
  return { py, radar, results };
}

const T_TONGYEONG = '한결케미칼 통영공장 사용량 미반영 회신';
const T_RENEW = '한결케미칼 연간 계약 갱신 검토';
const T_SERVER_QUOTE = '대륙물산 서버 교체 견적 방향 결정';
const T_LDAR = 'LDAR 견적서 회신';
const T_STRATEGY = '전략 검토';
const T_MISSING = '사라진 항목';

/** 첫 절(할 일 목록) 끝에 줄을 더한다 */
function addTodoLine(root: string, line: string): void {
  const text = read(root, TODO);
  write(root, TODO, text.replace('\n\n## 메일 회신 대기', `\n${line}\n\n## 메일 회신 대기`));
}

describe.skipIf(skipReason !== null)('sync_todo.py 골든 (명세 §1-4)', () => {
  it('apply_status 줄 단위 대조(파이썬 공백 규칙 포함)', () => {
    const cases: [string, TaskStatus, string][] = [
      ['- [ ] 일 #내할일 [pri:: 1] [due:: 2026-09-18]', 'done', ''],
      ['- [ ] 앞 [wip:: 2026-09-01] 뒤 [pri:: 2]', 'done', ''],
      ['- [x] 일 [done:: 2026-09-01]   ', 'open', ''],
      ['- [X] 일 [owner:: 김] [st:: 협의]', 'notmine', ''],
      ['- [X] 일 [owner:: 김] [st:: 협의]', 'notmine', '박담당'],
      ['- [ ] 일\x1c[done:: x]', 'open', ''],
      ['- [ ] 일\ufeff[done:: x]', 'open', ''],
      ['- [ ] 일\u3000[done:: x] 끝', 'wip', ''],
      ['- [ ] 일 [done ::x] [done::y]', 'open', ''],
      ['- [ ] 🔴 [[링크|별칭]] [wip:: 2026-09-20] [mail:: raw/mail/a/_[공지] b.md] #내할일', 'done', ''],
      ['- [x] 끝난 일 [done:: 2026-09-01] [wip:: 2026-08-30]', 'wip', ''],
      ['- [ ]  공백 두 칸\t[owner:: 김]\t', 'open', ''],
    ];
    const code = [
      'import sys, json, importlib.util',
      'spec = importlib.util.spec_from_file_location("sync_todo", sys.argv[1])',
      'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
      'cases = json.loads(sys.stdin.read())',
      'print(json.dumps([m.apply_status(l, s, o, "2026-09-23") for l, s, o in cases], ensure_ascii=False))',
    ].join('\n');
    // 정본을 불러오기만 해도 __pycache__ 가 생길 수 있으니 임시 사본에서 불러온다
    const copy = path.join(tempDir('wiki-radar-golden-apply-'), 'sync_todo.py');
    fs.copyFileSync(SYNC_TODO, copy);
    const r = spawnSync(PYTHON, ['-B', '-c', code, copy], { input: JSON.stringify(cases), encoding: 'utf8', env: PY_ENV });
    expect(r.status, r.stderr).toBe(0);
    const expected = JSON.parse(r.stdout) as string[];
    expect(cases.map(([l, s, o]) => applyStatus(l, s, o || undefined, TODAY))).toEqual(expected);
  });

  describe('앵커 있는 큐레이션', () => {
    it('done (+메모 누적)', () => {
      const { results } = scenario([{ target: curated(T_TONGYEONG), status: 'done', note: '8월분 재집계 완료, 회신함' }]);
      expect(results[0].files).toEqual([TODO, MEMO]);
    });

    it('wip (엔티티 파일)', () => {
      scenario([{ target: curated(T_RENEW), status: 'wip' }]);
    });

    it('notmine (담당 지정·비움 → 타담당)', () => {
      scenario([
        { target: curated(T_TONGYEONG), status: 'notmine', owner: '이담당' },
        { target: curated(T_RENEW), status: 'notmine', owner: '' },
      ]);
    });

    it('open 되돌리기 (done → open, wip → open, notmine → open)', () => {
      scenario([
        { target: curated(T_TONGYEONG), status: 'done' },
        { target: curated(T_TONGYEONG), status: 'open' },
        { target: curated(T_RENEW), status: 'wip' },
        { target: curated(T_RENEW), status: 'open' },
        { target: curated(T_RENEW), status: 'notmine', owner: '영업팀' },
        { target: curated(T_RENEW), status: 'open' },
      ]);
    });

    it('앵커 여러 개(두 파일) — 찾은 줄을 모두 고친다', () => {
      const prep = (root: string) => {
        const p = at(root, '_todo-sync/items.json');
        const json = JSON.parse(fs.readFileSync(p, 'utf8'));
        const item = json.items.find((x: RawItem) => x.t === T_RENEW);
        item.a.push({ f: TODO, m: '분기 법정교육' });
        fs.writeFileSync(p, JSON.stringify(json, null, 2), 'utf8');
      };
      const { results } = scenario([{ target: curated(T_RENEW), status: 'done', note: '갱신 조건 확인' }], prep);
      expect(results[0].files).toEqual([TODO, MEMO, ENTITY].sort());
    });
  });

  describe('앵커 없는 큐레이션', () => {
    it('done → 완료 로그', () => {
      scenario([{ target: curated(T_SERVER_QUOTE), status: 'done' }]);
    });

    it('notmine + 메모 → 위임 로그·메모', () => {
      scenario([{ target: curated(T_LDAR), status: 'notmine', owner: '영업팀 이과장', note: '견적 초안은 영업팀이 직접 회신하기로 함' }]);
    });

    it('wip → 진행 중 로그', () => {
      scenario([{ target: curated(T_STRATEGY), status: 'wip' }]);
    });

    it('open 으로 로그 회수(완료·위임·진행 각각)', () => {
      const { results } = scenario([
        { target: curated('큐레이션 완료 항목'), status: 'open' },
        { target: curated('큐레이션 위임 항목'), status: 'open' },
        { target: curated('큐레이션 진행 항목'), status: 'open' },
        { target: curated('큐레이션 진행 항목'), status: 'open' }, // 이미 없음 → 바꿀 것 없음
      ]);
      expect(results.map((r) => r.unlogged)).toEqual([['큐레이션 완료 항목'], ['큐레이션 위임 항목'], ['큐레이션 진행 항목'], []]);
      expect(results[3].files).toEqual([]);
    });

    it('재기록(같은 항목은 절 안에서 한 줄만) · 다른 절에 이미 있는 항목', () => {
      scenario([
        { target: curated('큐레이션 완료 항목'), status: 'done' },
        { target: curated('큐레이션 위임 항목'), status: 'wip' },
        { target: curated('큐레이션 위임 항목'), status: 'notmine', owner: '최담당', note: '다시 넘김' },
      ]);
    });

    it('한 항목의 상태를 차례로 바꾸기(done → notmine → wip → open)', () => {
      scenario([
        { target: curated(T_SERVER_QUOTE), status: 'done' },
        { target: curated(T_SERVER_QUOTE), status: 'notmine', owner: '경영혁신팀' },
        { target: curated(T_SERVER_QUOTE), status: 'wip' },
        { target: curated(T_SERVER_QUOTE), status: 'open' },
      ]);
    });

    it('로그 절이 없으면 파일 끝에 만든다', () => {
      const prep = (root: string) => {
        const text = read(root, TODO);
        write(root, TODO, text.slice(0, text.indexOf('## 완료 로그')).replace(/\n+$/, '\n\n\n'));
      };
      scenario(
        [
          { target: curated(T_SERVER_QUOTE), status: 'done' },
          { target: curated(T_LDAR), status: 'notmine', note: '넘김' },
          { target: curated(T_STRATEGY), status: 'wip' },
        ],
        prep,
      );
    });
  });

  describe('앵커 미발견 → 로그로 떨어짐', () => {
    it('문구 미발견 done·notmine·open', () => {
      const { results } = scenario([
        { target: curated(T_MISSING), status: 'done' },
        { target: curated(T_MISSING), status: 'notmine', owner: '김담당', note: '담당 바뀜' },
        { target: curated(T_MISSING), status: 'open' },
      ]);
      expect(results[0].unmatched).toEqual([`${T_MISSING} — 문구 미발견: ${TODO} / 존재하지 않는 문구`]);
    });

    it('앵커 파일 없음', () => {
      const anchors = [{ f: 'wiki/entities/없는회사.md', m: '어떤 할 일' }];
      const { results } = scenario([
        { target: { kind: 'adhoc', title: '없는 파일의 항목', src: 'wiki/analysis/x.md', anchors }, status: 'done' },
        { target: { kind: 'adhoc', title: '없는 파일의 항목', src: 'wiki/analysis/x.md', anchors }, status: 'wip' },
      ]);
      expect(results[0].unmatched).toEqual(['없는 파일의 항목 — 파일 없음: wiki/entities/없는회사.md']);
    });

    it('28자 넘는 문구는 앞 28자만 적는다', () => {
      const anchors = [{ f: TODO, m: '🔴 아주 긴 앵커 문구 — 이것은 스물여덟 글자를 넘는 문장이다' }];
      scenario([{ target: { kind: 'adhoc', title: '긴 문구 항목', src: '', anchors }, status: 'done' }]);
    });
  });

  describe('체크박스 항목', () => {
    it('done (내 할 일.md)', () => {
      scenario([{ target: checkbox(TODO, '법인카드 지출결의서 작성'), status: 'done' }]);
    });

    it('notmine (엔티티 파일)', () => {
      scenario([{ target: checkbox(ENTITY, '담당자 교체 공지 확인'), status: 'notmine', owner: '한결 영업' }]);
    });

    it('wip (대상 밖 파일의 #내할일) → done (+메모, sync 제목 절)', () => {
      scenario([
        { target: checkbox(WORK, '팀 회의록 공유'), status: 'wip' },
        { target: checkbox(WORK, '팀 회의록 공유'), status: 'done', note: '채널에 올림' },
      ]);
    });

    it('진행 중 줄(**굵게**·[wip::]) → done + 메모', () => {
      scenario([{ target: checkbox(TODO, '초안 작성'), status: 'done', note: '초안 공유함\n검토 의견 반영은 다음 달' }]);
    });

    it('닫힌 줄([x]) 되돌리기', () => {
      scenario([{ target: checkbox(TODO, '상반기 평가 작성'), status: 'open' }]);
    });

    it('70자 넘는 핵심문구(그림 문자 포함) — 제목 70자 + …, 앵커 40자', () => {
      const long =
        '- [ ] 🔴🟡 아주 긴 할 일 — 한결케미칼 통영공장과 울산공장의 8월·9월 인벤토리 사용량을 CMS 실적 화면과 대조하고 누락분 재집계 요청서 작성 #내할일 [due:: 2026-10-01]';
      const { results } = scenario(
        [
          { target: checkbox(TODO, '아주 긴 할 일'), status: 'wip', note: '대조표 절반 작성' },
          { target: checkbox(TODO, '아주 긴 할 일'), status: 'done', note: '재집계 요청서 보냄' },
        ],
        (root) => addTodoLine(root, long),
      );
      expect(results[1].updated[0]).toMatch(/…\s\[done]$/);
    });

    // 필드가 문구 가운데 있어 앵커(핵심문구 앞 40자)가 줄에 이어서 나오지 않는 줄은 골든에서 뺐다(2026-09-28).
    // sync_todo 는 로그 절로 떨어뜨려 줄이 열린 채 남지만, 레이더는 스냅샷이 가리킨 줄을 고친다(의도적 차이 —
    // 2단계 명세 §9-1, writeback.test.ts '필드가 문구 가운데 있어도…').

    it('파이썬과 JS 의 공백이 다른 글자(\\x85·U+FEFF·\\x1c)가 든 줄 — 제목·앵커·로그·메모 절이 같다', () => {
      // \x85(NEL)·\x1c 는 파이썬에서만 공백, U+FEFF 는 JS 에서만 공백이다(build_todo core_of 는 파이썬 규칙)
      // 줄을 찾는 경우만 골든으로 대조한다. 필드 뒤에 U+FEFF 가 붙은 줄·필드가 가운데 있는 줄은 sync_todo 가
      // 로그로 떨어뜨리고 레이더는 줄을 고친다(의도적 차이 — 위 주석). \x1c 는 필드 바로 앞에 두어 파이썬 공백으로
      // 필드와 함께 떨어지는지(제목·메모 절 `## t` 가 같은지)를 본다.
      const lines = [
        '- [ ] 특이 공백 끝 NEL #내할일 [pri:: 1]\x85',
        '- [ ] ﻿특이 공백 앞 BOM #내할일 [pri:: 3]',
        '- [ ] 특이 공백 가운데 분리 문자 #내할일\x1c[pri:: 2]',
      ];
      const { results } = scenario(
        [
          { target: checkbox(TODO, '특이 공백 끝 NEL'), status: 'wip', note: 'NEL 메모' },
          { target: checkbox(TODO, '특이 공백 앞 BOM'), status: 'done', note: '앞 BOM 메모' },
          { target: checkbox(TODO, '특이 공백 가운데'), status: 'done', note: '분리 문자 메모' },
        ],
        (root) => {
          for (const l of lines) addTodoLine(root, l);
        },
      );
      // NEL 줄은 파이썬처럼 줄을 찾아 [wip:: 오늘]을 붙인다(끝의 \x85 는 핵심문구에서 빠진다)
      expect(results[0].updated).toEqual(['특이 공백 끝 NEL #내할일 [wip]']);
      expect(results[0].unmatched).toEqual([]);
    });
  });

  describe('메모', () => {
    it('한 줄 — 새 절', () => {
      scenario([{ target: curated(T_SERVER_QUOTE), status: 'wip', note: '방향 결정 회의 잡음' }]);
    });

    it('여러 줄(빈 줄 포함) — 있는 절에 이어 쓴다', () => {
      scenario([{ target: curated(T_STRATEGY), status: 'wip', note: '1안: 유지\n2안: 확장\n\n결론은 다음 주' }]);
    });

    it('중복(한 줄·여러 줄·기존 메모와 같음)은 쓰지 않는다', () => {
      const { results } = scenario([
        { target: curated(T_STRATEGY), status: 'wip', note: '상무님 보고 후 결정' },
        { target: curated(T_TONGYEONG), status: 'done', note: '재집계 요청\n회신 대기' },
        { target: curated(T_TONGYEONG), status: 'done', note: '재집계 요청\n회신 대기' },
      ]);
      expect(results.map((r) => r.memo)).toEqual([false, true, false]);
      expect(results[2].files).toEqual([]);
    });

    it('앞뒤 공백·CRLF 가 든 메모', () => {
      scenario([{ target: curated(T_TONGYEONG), status: 'done', note: '  앞뒤 공백\r\n둘째 줄  \r\n' }]);
    });

    it('메모 파일이 없으면 머리말과 함께 만든다', () => {
      const { radar, results } = scenario(
        [
          { target: curated(T_SERVER_QUOTE), status: 'wip', note: '방향 결정 회의 잡음' },
          { target: checkbox(TODO, '주간 업무보고'), status: 'done', note: '보고 올림' },
        ],
        (root) => fs.rmSync(at(root, MEMO)),
      );
      expect(results[0].files).toEqual([TODO, MEMO]);
      expect(read(radar, MEMO).startsWith('---\ntype: note\n')).toBe(true);
    });
  });

  describe('같은 저장 두 번(멱등)', () => {
    it('앵커·로그·체크박스 — 두 번째는 파일을 바꾸지 않는다', () => {
      const steps: Step[] = [
        { target: curated(T_TONGYEONG), status: 'done', note: '회신 완료' },
        { target: curated(T_SERVER_QUOTE), status: 'notmine', owner: '경영혁신팀', note: '이관' },
        { target: checkbox(ENTITY, '담당자 교체 공지'), status: 'wip', note: '공지 확인 중' },
      ];
      const { results } = scenario([...steps, ...steps]);
      expect(results.slice(3).map((r) => r.files)).toEqual([[], [], []]);
    });
  });

  describe('BOM + CRLF 사본', () => {
    const toBomCrlf = (root: string) => {
      for (const rel of [TODO, MEMO, WORK, ENTITY]) {
        write(root, rel, '\ufeff' + read(root, rel).replace(/\r?\n/g, '\r\n'));
      }
    };

    it('앵커·로그·체크박스·메모 모두 파이썬과 같고, 레이더는 BOM·CRLF 를 그대로 둔다', () => {
      const { radar } = scenario(
        [
          { target: curated(T_TONGYEONG), status: 'done', note: '회신 완료\n후속 없음' },
          { target: curated(T_LDAR), status: 'notmine', owner: '영업팀', note: '이관' },
          { target: checkbox(WORK, '팀 회의록 공유'), status: 'wip' },
          { target: curated('큐레이션 진행 항목'), status: 'open' },
        ],
        toBomCrlf,
      );
      for (const rel of [TODO, MEMO, WORK]) {
        const buf = fs.readFileSync(at(radar, rel));
        expect(buf.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), `${rel} BOM`).toBe(true);
        const text = buf.toString('utf8');
        expect(text.match(/\n/g)?.length, `${rel} CRLF`).toBe(text.match(/\r\n/g)?.length);
      }
    });
  });

  describe('알려진 차이(명세와 다른 점으로 보고)', () => {
    it('위임 로그의 여러 줄 메모: 레이더는 한 줄(" / ")로 적는다 — 다른 곳은 파이썬과 같다', () => {
      const { py, radar } = pair();
      const step: Step = { target: curated(T_LDAR), status: 'notmine', owner: '영업팀', note: '첫 줄\n## 제목처럼 보이는 줄\n- [ ] 할 일처럼 보이는 줄' };
      const task = radarTask(radar, step.target);
      runSyncTodo(py, pyItem(py, step, task));
      applyWriteback({ wikiRoot: radar, today: TODAY, task, status: step.status, owner: step.owner, note: step.note });
      const a = tree(py);
      const b = tree(radar);
      const differs = [...a.keys()].filter((k) => !a.get(k)?.equals(b.get(k) as Buffer));
      expect(differs).toEqual([TODO]);
      const pyTodo = (a.get(TODO) as Buffer).toString('utf8');
      const radarTodo = (b.get(TODO) as Buffer).toString('utf8');
      // 파이썬은 둘째 줄부터 절 안의 맨 줄로 넣어 `## `·`- [ ]` 줄이 새로 생긴다
      expect(pyTodo).toContain('\n## 제목처럼 보이는 줄\n- [ ] 할 일처럼 보이는 줄\n');
      expect(radarTodo).toContain(`· ${T_LDAR} → 담당 **영업팀** — 첫 줄 / ## 제목처럼 보이는 줄 / - [ ] 할 일처럼 보이는 줄\n`);
      expect(radarTodo).not.toContain('\n## 제목처럼 보이는 줄');
      // 두 줄 사이 차이를 빼면 같다
      expect(radarTodo.replace(' / ## 제목처럼 보이는 줄 / - [ ] 할 일처럼 보이는 줄', '\n## 제목처럼 보이는 줄\n- [ ] 할 일처럼 보이는 줄')).toBe(pyTodo);
    });
  });
}, 120_000);
