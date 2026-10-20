// voc-cli 실행: 위치·인자·시험 가드·오류 판정·직렬 큐 — 명세 §1·§9.
// 실제 voc-cli(jar)·java 는 부르지 않는다. 실행은 가짜 spawn 이나 가짜 voc-cli(test/fixtures/fake-voc-cli.mjs)만.
import { spawnSync, type spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_VOC_JAR_DIR,
  VOC_ALLOWED,
  VOC_GUARD_MESSAGE,
  VOC_JAVA_NOT_FOUND_MESSAGE,
  VOC_LOGIN_COMMAND,
  VOC_LOGIN_MESSAGE,
  VOC_NOT_CONFIGURED_MESSAGE,
  VOC_READ_TIMEOUT_MS,
  VOC_STOPPED_MESSAGE,
  VOC_UNAVAILABLE_MESSAGE,
  VOC_USAGE_ERROR_MESSAGE,
  VOC_WRITE_TIMEOUT_MS,
  VocCliRunner,
  VocRunError,
  classifyVocFailure,
  findJava,
  isVocLoginArgs,
  javaArgs,
  locateVocCli,
  pickDefaultJar,
  vocCommandOf,
  vocLoginArgs,
  vocTestGuard,
  type VocCliLocation,
  type VocRunResult,
} from '../../src/main/voc/cli';
import { parseTicketList, parseWhoami } from '../../src/main/voc/model';

const FAKE = path.resolve(__dirname, '../fixtures/fake-voc-cli.mjs');

const temps: string[] = [];
afterEach(() => {
  for (const d of temps.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-radar-voccli-'));
  temps.push(dir);
  return dir;
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

// ---- 위치 ----------------------------------------------------------------------------------

const JDK = path.resolve('C:\\jdk-17');
const JAVA = path.join(JDK, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
const HOME = path.resolve('C:\\Users\\sample');
const JAR = path.resolve('C:\\tools\\voc-cli-1.2.0.jar');
const JSA = path.join(HOME, '.voc-cli', 'voc-cli-1.2.0.jsa');

function existsOf(files: string[]): (p: string) => boolean {
  const set = new Set(files.map((f) => path.resolve(f).toLowerCase()));
  return (p) => set.has(path.resolve(p).toLowerCase());
}

describe('허용 목록', () => {
  it('읽기 6개 + 쓰기 3개 + V4(읽기 3개·쓰기 6개)만', () => {
    expect([...VOC_ALLOWED].sort()).toEqual(
      [
        'code list',
        'customer list',
        'ticket create',
        'ticket get',
        'ticket list',
        'ticket reply',
        'ticket update',
        'user list',
        'whoami',
        // V4(명세 §14)
        'worklog list',
        'ticket email-logs',
        'file download',
        'worklog add',
        'worklog delete',
        'ticket email',
        'ticket resolve',
        'ticket close',
        'ticket reopen',
      ].sort(),
    );
    expect(VOC_LOGIN_COMMAND).toBe('voc-cli login -u <아이디>');
    expect(VOC_READ_TIMEOUT_MS).toBe(30_000);
    expect(VOC_WRITE_TIMEOUT_MS).toBe(90_000);
  });

  it('vocCommandOf: 앞 한두 단어로 명령을 정한다', () => {
    expect(vocCommandOf(['ticket', 'list', '--json'])).toBe('ticket list');
    expect(vocCommandOf(['whoami'])).toBe('whoami');
    expect(vocCommandOf(['code', 'list', 'SYSTEM', '--json'])).toBe('code list');
    for (const bad of [
      ['ticket', 'delete', '1'],
      ['ticket', 'assign', '1', '2'],
      ['ticket', 'status', '1', 'closed'],
      ['ticket', 'attach', '1'],
      ['login', '-u', 'hong'],
      ['logout'],
      ['config'],
      ['usage', '--clear'],
      ['ticket'],
      [],
    ]) {
      expect(vocCommandOf(bad)).toBeNull();
    }
  });
});

describe('locateVocCli', () => {
  it('WIKI_RADAR_VOC_CLI 의 jar + JAVA_HOME + jsa → bat 과 같은 인자(셸 없음)', () => {
    const loc = locateVocCli({ env: { WIKI_RADAR_VOC_CLI: JAR, JAVA_HOME: JDK }, exists: existsOf([JAR, JAVA, JSA]), homedir: HOME });
    expect(loc).toEqual({
      ok: true,
      kind: 'jar',
      command: JAVA,
      baseArgs: [
        '-XX:TieredStopAtLevel=1',
        '-Xshare:auto',
        `-XX:SharedArchiveFile=${JSA}`,
        '-Xlog:cds=off',
        '-Xlog:class+path=off',
        '-Dspring.main.lazy-initialization=true',
        '-Dfile.encoding=UTF-8',
        '-jar',
        JAR,
      ],
    });
  });

  it('jsa 가 없으면 SharedArchiveFile 인자를 빼고 나머지 순서는 같다', () => {
    const loc = locateVocCli({ env: { WIKI_RADAR_VOC_CLI: JAR, JAVA_HOME: JDK }, exists: existsOf([JAR, JAVA]), homedir: HOME });
    expect(loc.ok && loc.baseArgs).toEqual(javaArgs(JAR, undefined));
    expect(javaArgs(JAR, undefined)).toEqual([
      '-XX:TieredStopAtLevel=1',
      '-Xshare:auto',
      '-Xlog:cds=off',
      '-Xlog:class+path=off',
      '-Dspring.main.lazy-initialization=true',
      '-Dfile.encoding=UTF-8',
      '-jar',
      JAR,
    ]);
  });

  it('java: JAVA_HOME 에 없으면 PATH(상대 경로 조각은 보지 않는다), 둘 다 없으면 notConfigured', () => {
    const other = path.resolve('C:\\other-jdk\\bin');
    const otherJava = path.join(other, process.platform === 'win32' ? 'java.exe' : 'java');
    const env = { JAVA_HOME: JDK, Path: ['relative\\bin', other].join(path.delimiter) };
    expect(findJava(env, existsOf([otherJava]))).toBe(otherJava);
    expect(findJava({ PATH: 'relative\\bin' }, existsOf([path.resolve('relative\\bin\\java.exe')]))).toBeUndefined();
    const loc = locateVocCli({ env: { WIKI_RADAR_VOC_CLI: JAR }, exists: existsOf([JAR]), homedir: HOME });
    expect(loc).toEqual({ ok: false, message: VOC_JAVA_NOT_FOUND_MESSAGE });
  });

  it('환경변수 jar 가 없으면 다른 곳으로 넘어가지 않고 알린다', () => {
    const fallback = path.join(DEFAULT_VOC_JAR_DIR, 'voc-cli-1.2.0.jar');
    const loc = locateVocCli({
      env: { WIKI_RADAR_VOC_CLI: `"${JAR}"`, JAVA_HOME: JDK },
      jarPath: JAR,
      exists: existsOf([JAVA, fallback]),
      listDir: () => ['voc-cli-1.2.0.jar'],
      homedir: HOME,
    });
    expect(loc.ok).toBe(false);
    expect(!loc.ok && loc.message).toContain('WIKI_RADAR_VOC_CLI');
    expect(!loc.ok && loc.message).toContain(JAR);
  });

  it('환경변수는 .jar 또는 시험용 .mjs 만', () => {
    const loc = locateVocCli({ env: { WIKI_RADAR_VOC_CLI: 'C:\\tools\\voc-cli.bat' }, exists: () => true, homedir: HOME });
    expect(loc.ok).toBe(false);
    expect(!loc.ok && loc.message).toContain('.jar');
  });

  it('시험용 .mjs → node 로 실행(fake)', () => {
    const loc = locateVocCli({ env: { WIKI_RADAR_VOC_CLI: FAKE } });
    expect(loc).toEqual({ ok: true, kind: 'fake', command: process.execPath, baseArgs: [FAKE] });
    const missing = locateVocCli({ env: { WIKI_RADAR_VOC_CLI: path.join(tempDir(), '없음.mjs') } });
    expect(missing.ok).toBe(false);
  });

  it('설정 jarPath → 없으면 설정을 확인하라고 알린다', () => {
    const ok = locateVocCli({ env: { JAVA_HOME: JDK }, jarPath: JAR, exists: existsOf([JAR, JAVA]), homedir: HOME });
    expect(ok.ok && ok.baseArgs[ok.baseArgs.length - 1]).toBe(JAR);
    const bad = locateVocCli({ env: { JAVA_HOME: JDK }, jarPath: JAR, exists: existsOf([JAVA]), homedir: HOME });
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.message).toContain('설정');
  });

  it('기본 폴더: voc-cli-*.jar 중 이름순 마지막(-plain.jar 제외, 숫자는 숫자로)', () => {
    const seen: string[] = [];
    const want = path.join(DEFAULT_VOC_JAR_DIR, 'voc-cli-1.10.0.jar');
    const loc = locateVocCli({
      env: { JAVA_HOME: JDK },
      exists: existsOf([JAVA, want]),
      listDir: (dir) => {
        seen.push(dir);
        return ['voc-cli-1.9.0.jar', 'voc-cli-1.10.0.jar', 'voc-cli-1.10.0-plain.jar', 'other.jar', 'voc-cli-1.10.0.jsa'];
      },
      homedir: HOME,
    });
    expect(seen).toEqual([DEFAULT_VOC_JAR_DIR]);
    expect(loc.ok && loc.baseArgs[loc.baseArgs.length - 1]).toBe(want);
    expect(pickDefaultJar(['voc-cli-1.2.0.jar', 'voc-cli-1.2.0-plain.jar'])).toBe('voc-cli-1.2.0.jar');
    expect(pickDefaultJar(['other.jar'])).toBeUndefined();
  });

  it('jar 를 찾지 못하면 notConfigured 문장', () => {
    const loc = locateVocCli({ env: { JAVA_HOME: JDK }, exists: existsOf([JAVA]), listDir: () => [], homedir: HOME });
    expect(loc).toEqual({ ok: false, message: VOC_NOT_CONFIGURED_MESSAGE });
  });
});

describe('vocTestGuard', () => {
  const jar: VocCliLocation = { ok: true, kind: 'jar', command: JAVA, baseArgs: javaArgs(JAR, undefined) };
  const fake: VocCliLocation = { ok: true, kind: 'fake', command: process.execPath, baseArgs: [FAKE] };

  it('시험 중(VITEST·WIKI_RADAR_TEST_MODE=1)에는 가짜(.mjs)만', () => {
    expect(vocTestGuard({ VITEST: 'true' }, jar)).toBe(VOC_GUARD_MESSAGE);
    expect(vocTestGuard({ WIKI_RADAR_TEST_MODE: '1' }, jar)).toBe(VOC_GUARD_MESSAGE);
    expect(vocTestGuard({ VITEST: 'true' }, fake)).toBeNull();
    // kind 가 fake 라도 .mjs 가 아니면 막는다
    expect(vocTestGuard({ VITEST: 'true' }, { ...fake, baseArgs: ['C:\\tools\\x.js'] } as VocCliLocation)).toBe(VOC_GUARD_MESSAGE);
  });

  it('시험이 아니면 막지 않는다. 위치를 못 정했으면 판정할 것이 없다', () => {
    expect(vocTestGuard({}, jar)).toBeNull();
    expect(vocTestGuard({ WIKI_RADAR_TEST_MODE: '0' }, jar)).toBeNull();
    expect(vocTestGuard({ VITEST: 'true' }, { ok: false, message: 'x' })).toBeNull();
  });
});

// ---- 오류 판정 -------------------------------------------------------------------------------

function res(stderr: string, code = 1, extra: Partial<VocRunResult> = {}): VocRunResult {
  return { code, stdout: '', stderr, timedOut: false, ...extra };
}

describe('classifyVocFailure', () => {
  it('로그인 필요·세션 만료 → login', () => {
    expect(classifyVocFailure(res('오류: 로그인이 필요합니다. 먼저 `voc-cli login` 을 실행하세요.\n'))).toEqual({
      state: 'login',
      message: VOC_LOGIN_MESSAGE,
    });
    const expired = classifyVocFailure(res('오류: 세션이 만료되었습니다. `voc-cli login` 으로 다시 로그인하세요.'));
    expect(expired.state).toBe('login');
    expect(expired.message).toContain(VOC_LOGIN_MESSAGE);
    expect(expired.message).toContain('주말처럼 하루 넘게 쓰지 않으면 다시 로그인해야 합니다');
  });

  it('연결 실패·요청 실패 → unavailable', () => {
    const offline = classifyVocFailure(
      res('오류: 백엔드에 연결할 수 없습니다: https://voc.example.test:11300 — 서버가 실행 중인지 확인하세요.'),
    );
    expect(offline.state).toBe('unavailable');
    expect(offline.message.startsWith(VOC_UNAVAILABLE_MESSAGE)).toBe(true);
    expect(classifyVocFailure(res('오류: 요청 실패: HTTP connect timed out')).state).toBe('unavailable');
  });

  it('jar 를 찾지 못함·java 가 jar 를 열지 못함 → notConfigured', () => {
    expect(classifyVocFailure(res('voc-cli jar not found. Build first: gradlew clean bootJar'))).toEqual({
      state: 'notConfigured',
      message: VOC_NOT_CONFIGURED_MESSAGE,
    });
    expect(classifyVocFailure(res('Error: Unable to access jarfile C:\\tools\\voc-cli-1.2.0.jar')).state).toBe('notConfigured');
  });

  it('API 오류 → 서버 문장 그대로 + 상태 번호', () => {
    expect(classifyVocFailure(res('오류: 400 — 작업 시간을 먼저 입력해야 해결/완료 처리할 수 있습니다.'))).toEqual({
      state: 'api',
      message: '작업 시간을 먼저 입력해야 해결/완료 처리할 수 있습니다.',
      apiStatus: 400,
    });
    expect(classifyVocFailure(res('오류: 404 — 티켓을 찾을 수 없습니다: 9'))).toMatchObject({ state: 'api', apiStatus: 404 });
    // JVM 경고 줄이 앞에 있어도 첫 '오류:' 줄을 본다
    expect(classifyVocFailure(res('OpenJDK 64-Bit Server VM warning: 경고\r\n오류: 500 — 서버 오류\r\n'))).toMatchObject({
      state: 'api',
      apiStatus: 500,
      message: '서버 오류',
    });
  });

  it('종료 코드 2(인자 오류) → 앱 버그 문장', () => {
    expect(classifyVocFailure(res("Unknown option: '--nope'\nUsage: voc-cli ticket reply", 2))).toEqual({
      state: 'unavailable',
      message: VOC_USAGE_ERROR_MESSAGE,
    });
  });

  it('그 밖의 오류: 줄은 그 문장(api), 오류 줄이 없으면 종료 코드와 마지막 줄', () => {
    expect(classifyVocFailure(res('오류: 변경할 필드를 하나 이상 지정하세요. (예: --status resolved)'))).toEqual({
      state: 'api',
      message: '변경할 필드를 하나 이상 지정하세요. (예: --status resolved)',
    });
    const odd = classifyVocFailure(res('무언가 잘못됨\n마지막 줄', 3));
    expect(odd.state).toBe('unavailable');
    expect(odd.message).toContain('종료 코드 3');
    expect(odd.message).toContain('마지막 줄');
    expect(classifyVocFailure(res('', 0)).state).toBe('unavailable');
  });

  it('시간 초과 → unavailable — 두 실행기 공용 문장이라 voc-cli 를 이름으로 대지 않는다(API 모드엔 voc-cli 가 없다)', () => {
    const t = classifyVocFailure(res('', -1, { timedOut: true }));
    expect(t).toEqual({ state: 'unavailable', message: `${VOC_UNAVAILABLE_MESSAGE} — VOC 요청이 제한 시간 안에 끝나지 않아 중단했습니다` });
    expect(t.message).not.toContain('voc-cli');
    expect(classifyVocFailure(res('', 0)).message).not.toContain('voc-cli');
  });

  it('실행하지 못함(spawnError)', () => {
    expect(classifyVocFailure({ spawnError: 'spawn C:\\jdk\\bin\\java.exe ENOENT' }).state).toBe('notConfigured');
    expect(classifyVocFailure({ spawnError: VOC_GUARD_MESSAGE })).toEqual({ state: 'notConfigured', message: VOC_GUARD_MESSAGE });
    expect(classifyVocFailure({ spawnError: VOC_NOT_CONFIGURED_MESSAGE })).toEqual({
      state: 'notConfigured',
      message: VOC_NOT_CONFIGURED_MESSAGE,
    });
    expect(classifyVocFailure({ spawnError: VOC_JAVA_NOT_FOUND_MESSAGE }).state).toBe('notConfigured');
    expect(classifyVocFailure({ spawnError: VOC_STOPPED_MESSAGE })).toEqual({ state: 'unavailable', message: VOC_STOPPED_MESSAGE });
    expect(classifyVocFailure({ spawnError: 'EACCES' })).toEqual({ state: 'unavailable', message: 'voc-cli 를 실행하지 못했습니다 — EACCES' });
  });
});

// ---- 실행기(가짜 spawn) ------------------------------------------------------------------------

/** 가짜 자식 프로세스. pid 가 없어 트리 종료(taskkill)가 다른 프로세스에 닿지 않는다 */
class FakeChild extends EventEmitter {
  readonly pid: number | undefined = undefined;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;
  /** 실행기가 표준입력에 쓴 글(닫히면 stdinEnded) */
  stdinText = '';
  stdinEnded = false;

  constructor() {
    super();
    this.stdin.setEncoding('utf8');
    this.stdin.on('data', (chunk: string) => {
      this.stdinText += chunk;
    });
    this.stdin.on('end', () => {
      this.stdinEnded = true;
    });
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }

  /** 출력을 다 내보낸 뒤 끝난다(실제 프로세스처럼 출력 끝 → exit → close) */
  finish(code: number, stdout: string | Buffer[] = '', stderr = ''): void {
    let open = 2;
    const done = (): void => {
      if (--open > 0) return;
      this.emit('exit', code, null);
      this.emit('close', code, null);
    };
    this.stdout.on('end', done);
    this.stderr.on('end', done);
    for (const chunk of Array.isArray(stdout) ? stdout : [stdout]) if (chunk.length > 0) this.stdout.write(chunk);
    if (stderr) this.stderr.write(stderr);
    this.stdout.end();
    this.stderr.end();
  }
}

interface SpawnCall {
  command: string;
  args: string[];
  options: Record<string, unknown>;
  child: FakeChild;
}

function fakeSpawn(onSpawn?: (call: SpawnCall) => void): { calls: SpawnCall[]; impl: typeof spawn } {
  const calls: SpawnCall[] = [];
  const impl = ((command: string, args: string[], options: Record<string, unknown>) => {
    const child = new FakeChild();
    const call = { command, args, options, child };
    calls.push(call);
    onSpawn?.(call);
    return child;
  }) as unknown as typeof spawn;
  return { calls, impl };
}

const FAKE_LOC: VocCliLocation = { ok: true, kind: 'fake', command: 'node-for-test', baseArgs: [FAKE] };

function runnerWith(impl: typeof spawn, loc: VocCliLocation = FAKE_LOC, env: NodeJS.ProcessEnv = { VITEST: 'true' }): VocCliRunner {
  return new VocCliRunner({ locate: () => loc, env, spawnImpl: impl });
}

describe('VocCliRunner (가짜 spawn)', () => {
  it('셸 없이, 창 없이, 위치의 인자 + 명령 인자로 띄운다(자식 환경에서 메일 비밀·세션 표식 뺌)', async () => {
    const { calls, impl } = fakeSpawn();
    const runner = runnerWith(impl, FAKE_LOC, {
      VITEST: 'true',
      PATH: 'C:\\Windows',
      WIKI_RADAR_SMTP_PASS: 'secret-pass',
      MAILHOST_MAIL_PASS: 'secret-pass',
      CLAUDECODE: '1',
      FAKE_VOC_MODE: 'ok',
    });
    const p = runner.run(['ticket', 'list', '--hide-completed', '--size', '2000', '--json']);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.command).toBe('node-for-test');
    expect(call.args).toEqual([FAKE, 'ticket', 'list', '--hide-completed', '--size', '2000', '--json']);
    expect(call.options).toMatchObject({ shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const env = call.options.env as NodeJS.ProcessEnv;
    expect(env.FAKE_VOC_MODE).toBe('ok');
    expect(env.PATH).toBe('C:\\Windows');
    expect(env).not.toHaveProperty('WIKI_RADAR_SMTP_PASS');
    expect(env).not.toHaveProperty('MAILHOST_MAIL_PASS');
    expect(env).not.toHaveProperty('CLAUDECODE');
    call.child.finish(0, '{"data":[]}');
    expect(await p).toEqual({ code: 0, stdout: '{"data":[]}', stderr: '', timedOut: false });
  });

  it('작업 폴더: workDir(빈 전용 폴더 — 없으면 만든다), 없거나 만들 수 없으면 jar·스크립트 폴더', async () => {
    // java 런처는 따옴표 없는 인자의 * · ? 를 작업 폴더 파일 이름으로 펼친다 — jar 폴더에서 띄우지 않는다
    const root = tempDir();
    const workDir = path.join(root, 'data', 'voc-cwd');
    const { calls, impl } = fakeSpawn();
    const runner = new VocCliRunner({ locate: () => FAKE_LOC, env: { VITEST: 'true' }, spawnImpl: impl, workDir });
    const p = runner.run(['whoami']);
    expect(calls[0].options.cwd).toBe(workDir);
    expect(fs.statSync(workDir).isDirectory()).toBe(true);
    expect(fs.readdirSync(workDir)).toEqual([]);
    calls[0].child.finish(0, 'ok');
    await p;

    const plain = fakeSpawn();
    const p2 = runnerWith(plain.impl).run(['whoami']);
    expect(plain.calls[0].options.cwd).toBe(path.dirname(FAKE));
    plain.calls[0].child.finish(0, 'ok');
    await p2;

    // 파일 아래(폴더를 만들 수 없음) → jar·스크립트 폴더로
    const file = path.join(root, 'a-file');
    fs.writeFileSync(file, 'x');
    const blocked = fakeSpawn();
    const p3 = new VocCliRunner({ locate: () => FAKE_LOC, env: { VITEST: 'true' }, spawnImpl: blocked.impl, workDir: path.join(file, 'voc-cwd') }).run([
      'whoami',
    ]);
    expect(blocked.calls[0].options.cwd).toBe(path.dirname(FAKE));
    blocked.calls[0].child.finish(0, 'ok');
    await p3;
  });

  it('표준출력은 UTF-8 로 읽는다(글자가 조각 사이에서 잘려도)', async () => {
    const { calls, impl } = fakeSpawn();
    const runner = runnerWith(impl);
    const p = runner.run(['whoami']);
    const bytes = Buffer.from('이름 : 홍길동', 'utf8');
    // 한 글자(3바이트) 가운데서 나눈다
    calls[0].child.finish(0, [bytes.subarray(0, 2), bytes.subarray(2, 7), bytes.subarray(7)], '경고');
    expect(await p).toMatchObject({ stdout: '이름 : 홍길동', stderr: '경고' });
  });

  it('종료 코드가 0 이 아니어도 결과로 돌려준다(판정은 classifyVocFailure)', async () => {
    const { calls, impl } = fakeSpawn();
    const runner = runnerWith(impl);
    const p = runner.run(['ticket', 'get', '1', '--json']);
    calls[0].child.finish(1, '', '오류: 로그인이 필요합니다. 먼저 `voc-cli login` 을 실행하세요.\n');
    const r = await p;
    expect(r.code).toBe(1);
    expect(classifyVocFailure(r).state).toBe('login');
  });

  it('한 번에 하나만 돈다(직렬 큐)', async () => {
    const { calls, impl } = fakeSpawn();
    const runner = runnerWith(impl);
    const p1 = runner.run(['ticket', 'list', '--json']);
    const p2 = runner.run(['whoami']);
    const p3 = runner.run(['user', 'list', '--role', 'staff,admin', '--json']);
    await tick();
    expect(calls).toHaveLength(1);
    expect(runner.busy).toBe(true);
    expect(runner.pending).toBe(2);
    calls[0].child.finish(0, 'A');
    expect((await p1).stdout).toBe('A');
    await tick();
    expect(calls).toHaveLength(2);
    expect(calls[1].args.slice(1)).toEqual(['whoami']);
    calls[1].child.finish(0, 'B');
    await p2;
    await tick();
    expect(calls).toHaveLength(3);
    calls[2].child.finish(0, 'C');
    expect((await p3).stdout).toBe('C');
    await tick();
    expect(runner.busy).toBe(false);
  });

  it('기다리는 쓰기가 기다리는 읽기보다 먼저 돈다', async () => {
    const { calls, impl } = fakeSpawn();
    const runner = runnerWith(impl);
    const read1 = runner.run(['ticket', 'list', '--json']);
    const read2 = runner.run(['user', 'list', '--role', 'staff,admin', '--json']);
    const write = runner.run(['ticket', 'reply', '1004', '-c', '확인했습니다']);
    const read3 = runner.run(['code', 'list', 'SYSTEM', '--json'], { write: false });
    calls[0].child.finish(0);
    await read1;
    await tick();
    expect(calls[1].args.slice(1, 3)).toEqual(['ticket', 'reply']);
    calls[1].child.finish(0, '답변이 등록되었습니다. (답변 id=5007)');
    await write;
    await tick();
    expect(calls[2].args.slice(1, 3)).toEqual(['user', 'list']);
    calls[2].child.finish(0);
    await read2;
    await tick();
    expect(calls[3].args.slice(1, 3)).toEqual(['code', 'list']);
    calls[3].child.finish(0);
    await read3;
  });

  it('허용 목록 밖·틀린 인자는 띄우지 않고 거부한다', async () => {
    const { calls, impl } = fakeSpawn();
    const runner = runnerWith(impl);
    for (const args of [['ticket', 'delete', '1'], ['login', '-u', 'hong'], ['ticket', 'assign', '1', '2'], ['usage'], []]) {
      const err = await runner.run(args).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(VocRunError);
      expect((err as VocRunError).failure.state).toBe('unavailable');
    }
    await expect(runner.run(['ticket', 'reply', '1', '-c', `가${String.fromCharCode(0)}나`])).rejects.toThrow('NUL');
    await expect(runner.run(['ticket', 'reply', '1', '-c', 'x'.repeat(40_000)])).rejects.toThrow('너무 깁니다');
    expect(calls).toHaveLength(0);
  });

  it('시험 중에는 jar 를 띄우지 않는다(가드)', async () => {
    const { calls, impl } = fakeSpawn();
    const jarLoc: VocCliLocation = { ok: true, kind: 'jar', command: JAVA, baseArgs: javaArgs(JAR, undefined) };
    // 넘겨받은 환경에 표식이 없어도 이 프로세스(vitest)가 시험 중이면 막는다
    const runner = runnerWith(impl, jarLoc, {});
    const err = (await runner.run(['ticket', 'list', '--json']).catch((e: unknown) => e)) as VocRunError;
    expect(err).toBeInstanceOf(VocRunError);
    expect(err.failure).toEqual({ state: 'notConfigured', message: VOC_GUARD_MESSAGE });
    expect(classifyVocFailure({ spawnError: err.message }).state).toBe('notConfigured');
    expect(calls).toHaveLength(0);
  });

  it('위치를 정하지 못하면 notConfigured 로 거부하고 다음 명령은 돈다', async () => {
    const { calls, impl } = fakeSpawn();
    let loc: VocCliLocation = { ok: false, message: VOC_NOT_CONFIGURED_MESSAGE };
    const runner = new VocCliRunner({ locate: () => loc, env: { VITEST: 'true' }, spawnImpl: impl });
    await expect(runner.run(['whoami'])).rejects.toMatchObject({ failure: { state: 'notConfigured', message: VOC_NOT_CONFIGURED_MESSAGE } });
    loc = FAKE_LOC;
    const p = runner.run(['whoami']);
    await tick();
    calls[0].child.finish(0, 'ok');
    expect((await p).stdout).toBe('ok');
  });

  it('띄우지 못하면(ENOENT) notConfigured 로 거부한다', async () => {
    const { impl } = fakeSpawn((call) => {
      setImmediate(() => call.child.emit('error', Object.assign(new Error('spawn node-for-test ENOENT'), { code: 'ENOENT' })));
    });
    const runner = runnerWith(impl);
    await expect(runner.run(['whoami'])).rejects.toMatchObject({ failure: { state: 'notConfigured' } });
    const throwing = runnerWith((() => {
      throw Object.assign(new Error('spawn EACCES'), { code: 'EACCES' });
    }) as unknown as typeof spawn);
    await expect(throwing.run(['whoami'])).rejects.toMatchObject({ failure: { state: 'unavailable' } });
  });

  it('login(명세 §13): 비밀번호는 인자가 아니라 표준입력으로 — 쓰고 닫는다. 표준입력을 주지 않으면 열지 않는다', async () => {
    const { calls, impl } = fakeSpawn();
    const runner = runnerWith(impl);
    const p = runner.run(vocLoginArgs('hong'), { stdin: 'Pw-unit-7f3a9c\n', write: true, timeoutMs: 30_000 });
    await tick();
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.args).toEqual([FAKE, 'login', '-u', 'hong', '--password']);
    expect(call.options).toMatchObject({ shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    await tick();
    expect(call.child.stdinText).toBe('Pw-unit-7f3a9c\n');
    expect(call.child.stdinEnded).toBe(true);
    // 비밀번호는 인자·환경 어디에도 없다
    expect(JSON.stringify(call.args)).not.toContain('Pw-unit-7f3a9c');
    expect(JSON.stringify(call.options.env)).not.toContain('Pw-unit-7f3a9c');
    call.child.finish(0, '로그인 성공: 홍길동 (staff) @ https://voc.example.test:11300\n');
    expect((await p).stdout).toContain('로그인 성공');

    // 표준입력이 없는 명령은 지금처럼 닫아 둔다
    const p2 = runner.run(['whoami']);
    await tick();
    expect(calls[1].options.stdio).toEqual(['ignore', 'pipe', 'pipe']);
    expect(calls[1].child.stdinText).toBe('');
    calls[1].child.finish(0, 'ok');
    await p2;
  });

  it('login 은 정확히 `login -u <아이디> --password` 만(다른 login·logout 은 거부), 표준입력은 login 에만 — 오류 문장에 표준입력 글이 없다', async () => {
    expect(vocCommandOf(vocLoginArgs('hong'))).toBe('login');
    expect(vocCommandOf(['login', '-u', 'a.b_c@d-e', '--password'])).toBe('login');
    expect(isVocLoginArgs(['login', '-u', 'hong', '--password'])).toBe(true);
    const badShapes: unknown[][] = [
      ['login'],
      ['login', '-u', 'hong'],
      ['login', '-u', 'hong', '--password', 'Pw-unit-7f3a9c'],
      ['login', '-u', 'hong', '--password=Pw-unit-7f3a9c'],
      ['login', '--user', 'hong', '--password'],
      ['login', '-u', 'hong', '--password', '--url', 'http://127.0.0.1:9'],
      ['login', '-u', 'hong', '--url'],
      ['login', '-u', '-h', '--password'],
      ['login', '-u', '@secret.txt', '--password'],
      ['login', '-u', '홍길동', '--password'],
      ['login', '-u', 'a b', '--password'],
      ['login', '-u', 'x'.repeat(65), '--password'],
      ['login', '-u', '', '--password'],
      ['logout'],
      ['logout', '--all'],
    ];
    for (const bad of badShapes) {
      expect(isVocLoginArgs(bad), JSON.stringify(bad)).toBe(false);
      expect(vocCommandOf(bad as string[]), JSON.stringify(bad)).toBeNull();
    }

    const { calls, impl } = fakeSpawn();
    const runner = runnerWith(impl);
    for (const args of badShapes) {
      const err = await runner.run(args as string[], { stdin: 'Pw-unit-7f3a9c\n' }).catch((e: unknown) => e);
      expect(err, JSON.stringify(args)).toBeInstanceOf(VocRunError);
      expect((err as VocRunError).message).not.toContain('Pw-unit-7f3a9c');
    }
    // 표준입력은 login 에만
    const notLogin = (await runner.run(['whoami'], { stdin: 'Pw-unit-7f3a9c\n' }).catch((e: unknown) => e)) as VocRunError;
    expect(notLogin).toBeInstanceOf(VocRunError);
    expect(notLogin.message).toContain('login 에만');
    expect(notLogin.message).not.toContain('Pw-unit-7f3a9c');
    const nul = (await runner.run(vocLoginArgs('hong'), { stdin: `Pw${String.fromCharCode(0)}x\n` }).catch((e: unknown) => e)) as VocRunError;
    expect(nul).toBeInstanceOf(VocRunError);
    expect(nul.message).not.toContain('Pw');
    expect(calls).toHaveLength(0);
  });

  it('login 을 띄우지 못하면(ENOENT)·멈추면 표준입력 글 없이 거부한다', async () => {
    const { impl } = fakeSpawn((call) => {
      setImmediate(() => call.child.emit('error', Object.assign(new Error('spawn node-for-test ENOENT'), { code: 'ENOENT' })));
    });
    const err = (await runnerWith(impl).run(vocLoginArgs('hong'), { stdin: 'Pw-unit-7f3a9c\n' }).catch((e: unknown) => e)) as VocRunError;
    expect(err.failure.state).toBe('notConfigured');
    expect(err.message).not.toContain('Pw-unit-7f3a9c');

    const held = fakeSpawn();
    const runner = runnerWith(held.impl);
    const active = runner.run(['ticket', 'list', '--json']);
    const waiting = runner.run(vocLoginArgs('hong'), { stdin: 'Pw-unit-7f3a9c\n', write: true });
    runner.stopAll();
    const stopped = (await waiting.catch((e: unknown) => e)) as VocRunError;
    expect(stopped.message).toBe(VOC_STOPPED_MESSAGE);
    await active.catch(() => undefined);
    expect(held.calls).toHaveLength(1); // 기다리던 login 은 띄우지 않았다
  });

  it('stopAll: 실행 중·대기 중인 것을 모두 끝내고, 그 뒤 명령은 평소대로', async () => {
    const { calls, impl } = fakeSpawn();
    const runner = runnerWith(impl);
    const active = runner.run(['ticket', 'list', '--json']);
    const waiting = runner.run(['whoami']);
    runner.stopAll();
    await expect(active).rejects.toMatchObject({ failure: { state: 'unavailable', message: VOC_STOPPED_MESSAGE } });
    await expect(waiting).rejects.toThrow(VOC_STOPPED_MESSAGE);
    // 멈춘 프로세스가 나중에 끝나도 문제없다
    calls[0].child.finish(0, 'late');
    await tick();
    expect(calls).toHaveLength(1);
    const next = runner.run(['whoami']);
    await tick();
    calls[1].child.finish(0, 'ok');
    expect((await next).stdout).toBe('ok');
  });
});

// ---- 실행기 + 가짜 voc-cli(실제 프로세스) -------------------------------------------------------

function fakeRunner(extraEnv: Record<string, string> = {}): { runner: VocCliRunner; state: string; log: string } {
  const state = tempDir();
  const log = path.join(state, 'calls.jsonl');
  const env: NodeJS.ProcessEnv = { ...process.env, FAKE_VOC_STATE: state, FAKE_VOC_LOG: log, ...extraEnv };
  const runner = new VocCliRunner({ locate: () => locateVocCli({ env: { WIKI_RADAR_VOC_CLI: FAKE } }), env });
  return { runner, state, log };
}

function loggedArgs(log: string): string[][] {
  return fs
    .readFileSync(log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => (JSON.parse(l) as { args: string[] }).args);
}

describe('VocCliRunner + 가짜 voc-cli', () => {
  it('목록·whoami 를 받는다', async () => {
    const { runner, log } = fakeRunner();
    const list = await runner.run(['ticket', 'list', '--hide-completed', '--size', '2000', '--json']);
    expect(list.code).toBe(0);
    const parsed = parseTicketList(list.stdout);
    expect(parsed).toMatchObject({ total: 12, page: 1, totalPages: 1 });
    expect(parsed.data).toHaveLength(12);
    const who = await runner.run(['whoami']);
    expect(parseWhoami(who.stdout)).toMatchObject({ email: 'owner@example.com', backend: 'https://voc.example.test:11300' });
    expect(loggedArgs(log)).toEqual([['ticket', 'list', '--hide-completed', '--size', '2000', '--json'], ['whoami']]);
  });

  it('쓰기는 FAKE_VOC_STATE 의 자료를 고쳐 다음 목록에 반영한다(원본 자료는 그대로)', async () => {
    const before = fs.readFileSync(path.resolve(__dirname, '../fixtures/voc/tickets.json'), 'utf8');
    const { runner, state } = fakeRunner({ FAKE_VOC_NOW: '2026-09-28T01:00:00Z' });
    const upd = await runner.run(['ticket', 'update', '1001', '--assignee', '102', '--status', 'assigned', '--json']);
    expect(upd.code).toBe(0);
    expect(JSON.parse(upd.stdout)).toMatchObject({ id: 1001, status: 'assigned', internalAssigneeId: 102, internalAssigneeName: '김담당' });
    const list = parseTicketList((await runner.run(['ticket', 'list', '--hide-completed', '--json', '--size', '2000'])).stdout);
    expect(list.data.find((d) => (d as { id: number }).id === 1001)).toMatchObject({ internalAssigneeId: 102 });
    expect(fs.existsSync(path.join(state, 'tickets.json'))).toBe(true);
    expect(fs.readFileSync(path.resolve(__dirname, '../fixtures/voc/tickets.json'), 'utf8')).toBe(before);
  });

  it('로그인 필요·만료·연결 실패·쓰기 실패 모드', async () => {
    const login = await fakeRunner({ FAKE_VOC_MODE: 'login' }).runner.run(['ticket', 'list', '--json']);
    expect(classifyVocFailure(login)).toEqual({ state: 'login', message: VOC_LOGIN_MESSAGE });
    const expired = await fakeRunner({ FAKE_VOC_MODE: 'expired' }).runner.run(['whoami']);
    expect(classifyVocFailure(expired).message).toContain('세션이 만료되었습니다');
    const offline = await fakeRunner({ FAKE_VOC_MODE: 'offline' }).runner.run(['whoami']);
    expect(classifyVocFailure(offline).state).toBe('unavailable');
    const { runner } = fakeRunner({ FAKE_VOC_MODE: 'fail-write' });
    expect((await runner.run(['ticket', 'get', '1001', '--json'])).code).toBe(0);
    const failed = await runner.run(['ticket', 'update', '1001', '-p', 'P1', '--json']);
    expect(classifyVocFailure(failed)).toMatchObject({ state: 'api', apiStatus: 400 });
  });

  it('code list SYSTEM 은 운영처럼 빈 배열(SYSTEM 코드 그룹이 꺼졌다), REQUEST_TYPE 은 코드', async () => {
    const { runner } = fakeRunner();
    const system = await runner.run(['code', 'list', 'SYSTEM', '--json']);
    expect(system.code).toBe(0);
    expect(JSON.parse(system.stdout)).toEqual([]);
    const types = await runner.run(['code', 'list', 'REQUEST_TYPE', '--json']);
    expect((JSON.parse(types.stdout) as { code: string }[]).map((c) => c.code)).toContain('inquiry');
  });

  it('글은 --긴이름=값 한 인자로 받는다(HTML·@·* 그대로)', async () => {
    const { runner, state } = fakeRunner();
    for (const content of ['<p>*</p>', '<p>@@확인</p>', '@nofile', '*']) {
      expect((await runner.run(['ticket', 'reply', '1004', `--content=${content}`])).code).toBe(0);
    }
    const replies = JSON.parse(fs.readFileSync(path.join(state, 'replies', '1004.json'), 'utf8')) as { content: string }[];
    expect(replies.slice(-4).map((r) => r.content)).toEqual(['<p>*</p>', '<p>@@확인</p>', '@nofile', '*']);
  });

  it('인자 오류는 종료 코드 2 → 앱 버그 문장', async () => {
    const { runner } = fakeRunner();
    const r = await runner.run(['ticket', 'reply', '1001', '-c', '내용', '--json']);
    expect(r.code).toBe(2);
    expect(classifyVocFailure(r).message).toBe(VOC_USAGE_ERROR_MESSAGE);
  });

  it("'-' 로 시작하는 값: 떨어진 값이 옵션 모양이면 picocli 처럼 종료 코드 2, --긴이름=값 이면 그대로 받는다", async () => {
    const { runner, state } = fakeRunner();
    // reply 의 옵션(-c)으로 시작하는 값
    const bad = await runner.run(['ticket', 'reply', '1004', '-c', '-c 항목을 다시 확인했습니다']);
    expect(bad.code).toBe(2);
    // create 의 옵션(-p)으로 시작하는 제목
    const badTitle = await runner.run(['ticket', 'create', '-t', '-p1 긴급 확인', '--customer-id', '1', '--json']);
    expect(badTitle.code).toBe(2);
    // '- ' 로 시작하는 목록 모양은 옵션이 아니다
    expect((await runner.run(['ticket', 'reply', '1004', '-c', '- 1차 반영'])).code).toBe(0);
    const ok = await runner.run(['ticket', 'reply', '1004', '--content=-c 항목을 다시 확인했습니다']);
    expect(ok.code).toBe(0);
    const replies = JSON.parse(fs.readFileSync(path.join(state, 'replies', '1004.json'), 'utf8')) as { content: string }[];
    expect(replies.map((r) => r.content)).toEqual(expect.arrayContaining(['- 1차 반영', '-c 항목을 다시 확인했습니다']));
  });

  it('제한 시간을 넘기면 프로세스 트리째 끝내고 timedOut', async () => {
    const { runner } = fakeRunner({ FAKE_VOC_MODE: 'slow', FAKE_VOC_DELAY_MS: '20000' });
    const started = Date.now();
    const r = await runner.run(['ticket', 'list', '--json'], { timeoutMs: 800 });
    expect(r.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(classifyVocFailure(r).state).toBe('unavailable');
  }, 15_000);

  it('login(명세 §13): 표준입력 한 줄의 비밀번호 — 맞으면 LoginCommand 와 같은 성공 문구·로그인 표식(비밀번호 없음), 틀리면 로그인 실패 문장', async () => {
    const { runner, state, log } = fakeRunner({ FAKE_VOC_MODE: 'login', FAKE_VOC_PASSWORD: 'Pw-unit-7f3a9c' });
    // 로그인 전: 로그인 필요
    expect(classifyVocFailure(await runner.run(['whoami'])).state).toBe('login');
    const wrong = await runner.run(vocLoginArgs('hong'), { stdin: 'nope\n', write: true });
    expect(wrong.code).toBe(1);
    expect(classifyVocFailure(wrong)).toEqual({ state: 'api', message: '로그인 실패: 아이디 또는 비밀번호를 확인하세요.' });
    const empty = await runner.run(vocLoginArgs('hong'));
    expect(empty.stderr).toContain('비밀번호를 입력할 콘솔이 없습니다');
    const ok = await runner.run(vocLoginArgs('hong'), { stdin: 'Pw-unit-7f3a9c\n', write: true });
    expect(ok.code).toBe(0);
    expect(ok.stdout).toMatch(/^로그인 성공: 홍길동 \(staff\) @ https:\/\/voc\.example\.test:11300$/m);
    // 로그인 표식이 있으면 login 모드에서도 ok 처럼 답한다
    const who = await runner.run(['whoami']);
    expect(who.code).toBe(0);
    expect(parseWhoami(who.stdout).loginId).toBe('hong');
    const mark = fs.readFileSync(path.join(state, 'login.json'), 'utf8');
    expect(JSON.parse(mark)).toMatchObject({ loginId: 'hong' });
    // 비밀번호는 호출 기록·표식·출력 어디에도 없다
    expect(mark).not.toContain('Pw-unit-7f3a9c');
    expect(fs.readFileSync(log, 'utf8')).not.toContain('Pw-unit-7f3a9c');
    expect(ok.stdout + ok.stderr + wrong.stdout + wrong.stderr).not.toContain('Pw-unit-7f3a9c');
    expect(loggedArgs(log).filter((a) => a[0] === 'login')).toEqual([vocLoginArgs('hong'), vocLoginArgs('hong'), vocLoginArgs('hong')]);
  });

  it('가짜 voc-cli 로그인 잠금(voc20-backend 와 같다): 아이디별 5번 연달아 틀리면 10분 — 잠긴 동안에는 맞는 비밀번호도 같은 "로그인 실패", 10분 넘으면 풀린다', async () => {
    const PW = 'Pw-unit-7f3a9c';
    const WRONG = '로그인 실패: 아이디 또는 비밀번호를 확인하세요.';
    const state = tempDir();
    const at = (now: string): VocCliRunner =>
      new VocCliRunner({
        locate: () => locateVocCli({ env: { WIKI_RADAR_VOC_CLI: FAKE } }),
        env: { ...process.env, FAKE_VOC_STATE: state, FAKE_VOC_MODE: 'login', FAKE_VOC_PASSWORD: PW, FAKE_VOC_NOW: now },
      });
    const login = (runner: VocCliRunner, id: string, pw: string) => runner.run(vocLoginArgs(id), { stdin: `${pw}\n`, write: true });
    const t0 = at('2026-09-28T01:00:00Z');
    for (let i = 0; i < 5; i++) expect(classifyVocFailure(await login(t0, 'hong', `nope-${i}`)).message).toBe(WRONG);
    const locked = await login(t0, 'hong', PW);
    expect(locked.code).toBe(1);
    expect(classifyVocFailure(locked)).toEqual({ state: 'api', message: WRONG });
    // 셈은 아이디별
    expect((await login(t0, 'kim.d', PW)).code).toBe(0);
    expect((await login(at('2026-09-28T01:09:59Z'), 'hong', PW)).code).toBe(1);
    const back = await login(at('2026-09-28T01:10:01Z'), 'hong', PW);
    expect(back.code).toBe(0);
    // 성공하면 기록을 지운다. 기록에 비밀번호는 없다
    const text = fs.readFileSync(path.join(state, 'login-attempts.json'), 'utf8');
    expect(JSON.parse(text)).toEqual([]);
    // 네 번 틀린 뒤 맞으면 들어간다(잠그지 않았다) — 그 뒤 다시 1번부터
    const t1 = at('2026-09-28T02:00:00Z');
    for (let i = 0; i < 4; i++) await login(t1, 'hong', 'nope');
    expect((await login(t1, 'hong', PW)).code).toBe(0);
    await login(t1, 'hong', 'nope');
    const after = fs.readFileSync(path.join(state, 'login-attempts.json'), 'utf8');
    expect(JSON.parse(after)).toEqual([{ loginId: 'hong', count: 1, lockedUntil: null }]);
    expect(text + after).not.toContain(PW);
    expect(text + after).not.toContain('nope');
  }, 30_000);

  it('가짜 voc-cli: 인자에 비밀번호가 오면(--password=…·--password <값>) 종료 코드 3, 값은 출력하지 않는다. 다른 login·logout 도 3', () => {
    for (const args of [
      ['login', '-u', 'hong', '--password=Pw-unit-7f3a9c'],
      ['login', '-u', 'hong', '--password', 'Pw-unit-7f3a9c'],
      ['login', '-u', 'hong'],
      ['logout'],
    ]) {
      const r = spawnSync(process.execPath, [FAKE, ...args], { encoding: 'utf8', windowsHide: true, input: '' });
      expect(r.status, JSON.stringify(args)).toBe(3);
      expect(r.stdout + r.stderr).not.toContain('Pw-unit-7f3a9c');
    }
  });

  it('가짜 voc-cli 는 허용 목록 밖 명령을 종료 코드 3 으로 거부한다', () => {
    const r = spawnSync(process.execPath, [FAKE, 'ticket', 'delete', '1001'], { encoding: 'utf8', windowsHide: true });
    expect(r.status).toBe(3);
    expect(r.stderr).toContain('허용하지 않는 명령');
  });
});
