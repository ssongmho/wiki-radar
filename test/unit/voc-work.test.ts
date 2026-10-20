// V4(명세 §14): 첨부·작업시간·해결·완료·재오픈·고객 메일 — 허용 목록·명령 조립·열기 허용 확장자·경로 검사·해결 흐름.
// voc-cli 는 가짜(test/fixtures/fake-voc-cli.mjs — 실제 프로세스, 자료는 임시 상태 폴더)만 부른다. 실제 jar·운영 VOC 에 닿지 않는다.
// 사람·고객사·주소는 가짜다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VocWorkInput } from '../../src/shared/types';
import {
  VOC_ALLOWED,
  VOC_DOWNLOAD,
  VOC_WRITE_COMMANDS,
  VocCliRunner,
  VocRunError,
  vocCommandOf,
  vocDownloadArgs,
  vocDownloadProblem,
} from '../../src/main/voc/cli';
import { checkDownloaded, checkOpenable, imageDataUrl, imageMimeOf, isInside, parseDownloadOutput } from '../../src/main/voc/files';
import { requireVocFileInput, requireVocFileOpenInput, requireVocWorkInput } from '../../src/main/voc/ipcInput';
import { parseEmailLogs, parseTicketDetail, parseWorkLogs } from '../../src/main/voc/model';
import { VocService } from '../../src/main/voc/service';
import { VocActionLog, VocSettingsStore } from '../../src/main/voc/settings';
import { VOC_IMAGE_MAX_BYTES, vocCanOpenFile, vocFileExt, vocFileKind, vocHoursProblem } from '../../src/shared/voc';

const FAKE = path.resolve(__dirname, '../fixtures/fake-voc-cli.mjs');
const FIXTURE = path.resolve(__dirname, '../fixtures/voc');
const TODAY = '2026-09-23';

const temps: string[] = [];
/** 뒤에서 도는 새로 받기(쓰기 성공 뒤 refreshSoon)를 기다린다 — 끝나기 전에 폴더를 지우면 Windows 가 EPERM */
const settles: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const s of settles.splice(0)) await s().catch(() => undefined);
  for (const d of temps.splice(0)) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-radar-vocwork-'));
  temps.push(dir);
  return dir;
}

// ---- 허용 목록·명령 조립 ------------------------------------------------------------------------

describe('허용 목록(V4)', () => {
  it('쓰기 분류: worklog add·delete, ticket email·resolve·close·reopen 은 쓰기, worklog list·email-logs·file download 는 읽기', () => {
    for (const c of ['worklog add', 'worklog delete', 'ticket email', 'ticket resolve', 'ticket close', 'ticket reopen']) {
      expect(VOC_ALLOWED).toContain(c);
      expect(VOC_WRITE_COMMANDS).toContain(c);
    }
    for (const c of ['worklog list', 'ticket email-logs', 'file download']) {
      expect(VOC_ALLOWED).toContain(c);
      expect(VOC_WRITE_COMMANDS).not.toContain(c);
    }
    expect(vocCommandOf(['file', 'download', '7001', '--out=C:\\x\\', '--json'])).toBe(VOC_DOWNLOAD);
    // 여전히 쓰지 않는 것
    for (const bad of [['ticket', 'status', '1', 'resolved'], ['ticket', 'attach', '1', 'a.txt'], ['worklog', 'edit', '1'], ['file', 'upload', 'x']]) {
      expect(vocCommandOf(bad)).toBeNull();
    }
  });

  it('내려받기 인자: file download <id> --out=<폴더>\\ --json — 폴더 끝에 구분자를 붙인다', () => {
    const dir = path.join(os.tmpdir(), 'r', 'voc-files', '1004');
    expect(vocDownloadArgs(7001, dir)).toEqual(['file', 'download', '7001', `--out=${dir}${path.sep}`, '--json']);
    expect(vocDownloadArgs(7001, `${dir}${path.sep}`)[3]).toBe(`--out=${dir}${path.sep}`);
  });

  it('내려받기 폴더 검사: 앱 데이터 폴더(voc-files) 아래만, 모양이 정확할 때만', () => {
    const root = path.join(os.tmpdir(), 'r', 'voc-files');
    const ok = vocDownloadArgs(7001, path.join(root, '1004'));
    expect(vocDownloadProblem(ok, root)).toBeNull();
    expect(vocDownloadProblem(ok, undefined)).toMatch(/폴더가 정해지지/);
    // 뿌리 자체·밖·../ 로 빠져나감·상대경로·와일드카드·끝 구분자 없음·모양 틀림
    expect(vocDownloadProblem(vocDownloadArgs(7001, root), root)).toMatch(/밖/);
    expect(vocDownloadProblem(vocDownloadArgs(7001, path.join(os.tmpdir(), 'other')), root)).toMatch(/밖/);
    expect(vocDownloadProblem(['file', 'download', '7001', `--out=${root}${path.sep}..${path.sep}x${path.sep}`, '--json'], root)).toMatch(/밖/);
    expect(vocDownloadProblem(['file', 'download', '7001', '--out=voc-files\\1004\\', '--json'], root)).toMatch(/경로가 올바르지/);
    expect(vocDownloadProblem(['file', 'download', '7001', `--out=${path.join(root, '*')}${path.sep}`, '--json'], root)).toMatch(/경로가 올바르지/);
    expect(vocDownloadProblem(['file', 'download', '7001', `--out=${path.join(root, '1004')}`, '--json'], root)).toMatch(/경로가 올바르지/);
    expect(vocDownloadProblem(['file', 'download', '7001', '-o', `${path.join(root, '1004')}${path.sep}`], root)).toMatch(/모양/);
    expect(vocDownloadProblem(['file', 'download', '-1', `--out=${path.join(root, '1004')}${path.sep}`, '--json'], root)).toMatch(/id/);
    expect(vocDownloadProblem([...ok, '--extra'], root)).toMatch(/모양/);
  });

  it('runner 는 폴더가 틀린 내려받기를 띄우지 않는다(앱 버그로 거부)', async () => {
    const spawnImpl = vi.fn();
    const runner = new VocCliRunner({
      locate: () => ({ ok: true, kind: 'fake', command: process.execPath, baseArgs: [FAKE] }),
      env: { VITEST: 'true' },
      spawnImpl: spawnImpl as never,
      downloadRoot: path.join(os.tmpdir(), 'r', 'voc-files'),
    });
    await expect(runner.run(vocDownloadArgs(7001, os.tmpdir()))).rejects.toBeInstanceOf(VocRunError);
    const noRoot = new VocCliRunner({
      locate: () => ({ ok: true, kind: 'fake', command: process.execPath, baseArgs: [FAKE] }),
      env: { VITEST: 'true' },
      spawnImpl: spawnImpl as never,
    });
    await expect(noRoot.run(vocDownloadArgs(7001, path.join(os.tmpdir(), 'r', 'voc-files', '1')))).rejects.toThrow(/폴더가 정해지지/);
    expect(spawnImpl).not.toHaveBeenCalled();
  });
});

// ---- 첨부 처리 방식·열기 허용 확장자 -------------------------------------------------------------

describe('첨부 처리 방식(열기 허용 확장자)', () => {
  it('이미지 10MB 이하는 [보기], pdf·txt·csv·log·office·hwp 는 [열기], 실행형·스크립트·모르는 것은 폴더에서 보기만', () => {
    expect(vocFileKind('screen.png', 100)).toBe('image');
    expect(vocFileKind('사진.JPEG', 100)).toBe('image');
    expect(vocFileKind('a.webp', VOC_IMAGE_MAX_BYTES)).toBe('image');
    expect(vocFileKind('big.png', VOC_IMAGE_MAX_BYTES + 1)).toBe('folder');
    expect(vocFileKind('nosize.png')).toBe('folder');
    expect(vocFileKind('drawing.svg', 10)).toBe('folder');
    for (const n of ['a.pdf', 'b.TXT', 'c.csv', 'd.log', 'e.doc', 'f.docx', 'g.xls', 'h.xlsx', 'i.ppt', 'j.pptx', 'k.hwp', 'l.hwpx']) {
      expect(vocFileKind(n, 10)).toBe('open');
      expect(vocCanOpenFile(n)).toBe(true);
    }
    for (const n of ['setup.exe', 'run.bat', 'x.cmd', 'y.ps1', 'z.vbs', 'q.js', 'link.lnk', 'site.url', 'a.pdf.exe', 'm.msi', 'h.hta', 'page.html', 'noext', '.pdf', 'trail.']) {
      expect(vocFileKind(n, 10)).toBe('folder');
      expect(vocCanOpenFile(n)).toBe(false);
    }
    // 끝의 점·공백은 Windows 가 떼어 낸다 — 'a.exe.' 는 exe
    expect(vocFileExt('a.exe. ')).toBe('exe');
    expect(vocFileExt('dir/evil.exe')).toBe('exe');
  });

  it('작업시간은 0.5 단위 0.5~12', () => {
    expect(vocHoursProblem(0.5)).toBeNull();
    expect(vocHoursProblem(12)).toBeNull();
    expect(vocHoursProblem(1.5)).toBeNull();
    for (const bad of [0, 0.25, 12.5, 24, -1, Number.NaN, '1' as unknown]) expect(vocHoursProblem(bad)).not.toBeNull();
  });
});

// ---- 내려받은 파일 검사 ---------------------------------------------------------------------------

describe('내려받은 파일 검사(files.ts)', () => {
  const png = fs.readFileSync(path.join(FIXTURE, 'files', '7001', 'screen.png'));

  it('이미지 형식은 파일 머리로 — png·jpeg·gif·webp·bmp, 그 밖(svg·exe)은 null', () => {
    expect(imageMimeOf(png)).toBe('image/png');
    expect(imageMimeOf(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(imageMimeOf(Buffer.from('GIF89a......'))).toBe('image/gif');
    expect(imageMimeOf(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(imageMimeOf(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">'))).toBeNull();
    expect(imageMimeOf(Buffer.from('MZ\x90\0'))).toBeNull();
  });

  it('결과 경로가 그 폴더 바로 아래·보통 파일·크기가 맞을 때만 받는다(크기가 다르면 지운다)', () => {
    const root = tempDir();
    const dir = path.join(root, '1004');
    fs.mkdirSync(dir);
    const p = path.join(dir, 'screen.png');
    fs.writeFileSync(p, png);
    const ok = checkDownloaded({ path: p, filename: 'screen.png', size: png.length }, dir, png.length);
    expect(ok).toEqual({ path: path.resolve(p), fileName: 'screen.png', size: png.length });
    expect(imageDataUrl(ok)).toBe(`data:image/png;base64,${png.toString('base64')}`);
    // 폴더 밖이라 알린 경로
    expect(() => checkDownloaded({ path: path.join(root, 'screen.png'), filename: 'x', size: 1 }, dir)).toThrow(/밖/);
    // 크기 다름 → 지움
    expect(() => checkDownloaded({ path: p, filename: 'screen.png', size: png.length }, dir, png.length + 1)).toThrow(/크기/);
    expect(fs.existsSync(p)).toBe(false);
    // 이미지가 아닌 것은 data URL 로 만들지 않는다
    const fake = path.join(dir, 'fake.png');
    fs.writeFileSync(fake, 'MZ not an image');
    expect(() => imageDataUrl({ path: fake, fileName: 'fake.png', size: fs.statSync(fake).size })).toThrow(/이미지 형식/);
    expect(() => parseDownloadOutput('저장했습니다: x')).toThrow(/읽지 못했습니다/);
    expect(parseDownloadOutput('{"path":"C:/a/b.png","filename":"b.png","size":3,"contentType":"application/octet-stream"}')).toEqual({
      path: 'C:/a/b.png',
      filename: 'b.png',
      size: 3,
    });
  });

  it('열기는 허용 확장자·첨부 폴더 안만, 폴더에서 보기는 확장자와 무관', () => {
    const root = tempDir();
    const dir = path.join(root, '1004');
    fs.mkdirSync(dir);
    const exe = path.join(dir, 'setup.exe');
    fs.writeFileSync(exe, 'x');
    const pdf = path.join(dir, 'report.pdf');
    fs.writeFileSync(pdf, '%PDF');
    expect(() => checkOpenable(root, { path: exe, fileName: 'setup.exe', size: 1 }, 'open')).toThrow(/열지 않습니다/);
    expect(checkOpenable(root, { path: exe, fileName: 'setup.exe', size: 1 }, 'reveal')).toBe(path.resolve(exe));
    expect(checkOpenable(root, { path: pdf, fileName: 'report.pdf', size: 4 }, 'open')).toBe(path.resolve(pdf));
    // 내려받은 뒤 바뀜·없어짐·폴더 밖
    expect(() => checkOpenable(root, { path: pdf, fileName: 'report.pdf', size: 5 }, 'open')).toThrow(/바뀌었습니다/);
    expect(() => checkOpenable(root, { path: path.join(dir, 'gone.pdf'), fileName: 'gone.pdf', size: 1 }, 'open')).toThrow(/없습니다/);
    const outside = path.join(tempDir(), 'a.pdf');
    fs.writeFileSync(outside, 'x');
    expect(() => checkOpenable(root, { path: outside, fileName: 'a.pdf', size: 1 }, 'open')).toThrow(/밖/);
    expect(isInside(root, path.join(root, '..', 'x'))).toBe(false);
    expect(isInside(root, root)).toBe(false);
  });
});

// ---- 출력 읽기·입력 검사 ---------------------------------------------------------------------------

describe('출력 읽기·IPC 입력', () => {
  it('ticket get: 요청·답변 첨부(답변 작성자 표시)와 고객 메일 주소(customerEmails → 없으면 customerEmail)', () => {
    const ticket = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'tickets.json'), 'utf8')).find((t: { id: number }) => t.id === 1004);
    const replies = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'replies', '1004.json'), 'utf8'));
    const d = parseTicketDetail(JSON.stringify({ ...ticket, replies }), TODAY, []);
    expect(d?.attachments?.map((a) => [a.id, a.fileName, a.replyId ?? null])).toEqual([
      [7001, 'screen.png', null],
      [7002, 'report.pdf', null],
      [7003, 'setup.exe', 5002],
    ]);
    expect(d?.attachments?.[2].replyAuthor).toBe('해온정밀 설비팀');
    expect(d?.customerEmails).toEqual(['ops@haeon.example', 'lead@haeon.example']);
    const single = parseTicketDetail(JSON.stringify({ ...ticket, customerEmails: [], customerEmail: 'one@haeon.example' }), TODAY, []);
    expect(single?.customerEmails).toEqual(['one@haeon.example']);
  });

  it('첨부 이름의 방향 바꾸기 글자는 지운다 — 처리 방식은 실제 확장자(exe)로', () => {
    const rlo = String.fromCharCode(0x202e);
    const d = parseTicketDetail(JSON.stringify({ id: 1, attachments: [{ id: 9, fileName: `invoice${rlo}gpj.exe`, fileSize: 3 }] }), TODAY, []);
    expect(d?.attachments?.[0].fileName).toBe('invoicegpj.exe');
    expect(vocFileKind(d?.attachments?.[0].fileName, 3)).toBe('folder');
  });

  it('worklog list(minutes 만 있어도)·email-logs', () => {
    expect(
      parseWorkLogs(JSON.stringify([{ id: 1, workDate: '2026-09-20', minutes: 90, userId: 101, userName: '홍길동', note: null }, { id: 2 }])),
    ).toEqual([{ id: 1, workDate: '2026-09-20', hours: 1.5, userId: 101, userName: '홍길동' }]);
    expect(
      parseEmailLogs(JSON.stringify([{ id: 9, ticketId: 1, sentByName: null, toAddresses: ['a@b.example'], ccAddresses: [], status: 'sent', emailType: 'resolved', sentAt: '2026-09-23T01:00:00' }])),
    ).toEqual([{ id: 9, to: ['a@b.example'], cc: [], status: 'sent', emailType: 'resolved', sentAt: '2026-09-23T01:00:00' }]);
    expect(() => parseWorkLogs('{"x":1}')).toThrow();
  });

  it('vocWork 입력 모양: 종류·id·작업시간·주소 목록(제어 문자 거부), 종류에 없는 필드는 버린다', () => {
    const base = { actionId: 'a1b2c3d4-0000', ticketId: 1004 };
    expect(() => requireVocWorkInput({ ...base, kind: 'delete' })).toThrow(/kind/);
    expect(() => requireVocWorkInput({ ...base, kind: 'worklogAdd' })).toThrow(/작업시간/);
    expect(() => requireVocWorkInput({ ...base, kind: 'worklogAdd', worklog: { hours: 1, date: '2026/09/23', note: '' } })).toThrow(/YYYY/);
    expect(() => requireVocWorkInput({ ...base, kind: 'worklogAdd', worklog: { hours: 1, date: TODAY, note: '줄\n바꿈' } })).toThrow(/제어 문자/);
    expect(() => requireVocWorkInput({ ...base, kind: 'email' })).toThrow(/받는 사람/);
    expect(() => requireVocWorkInput({ ...base, kind: 'email', email: { to: ['a@b.example\r\nBcc: x@y.example'], cc: [], replyIds: [] } })).toThrow(
      /주소 형식/,
    );
    expect(() => requireVocWorkInput({ ...base, kind: 'worklogDelete' })).toThrow(/workLogId/);
    expect(requireVocWorkInput({ ...base, kind: 'reopen', expectedStatus: 'resolved', worklog: { hours: 1, date: TODAY, note: '' }, email: { to: ['a@b.example'] } })).toEqual({
      ...base,
      kind: 'reopen',
      expectedStatus: 'resolved',
    });
    expect(() => requireVocFileInput({ ticketId: 1004, fileId: 7001, mode: 'exec' })).toThrow(/mode/);
    expect(() => requireVocFileOpenInput({ ticketId: 1004, fileId: 7001, how: 'open', path: 'C:\\Windows\\x.exe' })).not.toThrow();
    expect(requireVocFileOpenInput({ ticketId: 1004, fileId: 7001, how: 'open', path: 'C:\\x' })).toEqual({ ticketId: 1004, fileId: 7001, how: 'open' });
  });
});

// ---- 서비스 흐름(가짜 voc-cli 실제 프로세스) -------------------------------------------------------

interface Harness {
  service: VocService;
  filesDir: string;
  state: string;
  dataDir: string;
  /** 지금까지 부른 인자 */
  calls: () => string[][];
  /** 이 번호부터의 호출 */
  since: (n: number) => string[][];
  actions: VocActionLog;
}

async function harness(mode = 'ok'): Promise<Harness> {
  const root = tempDir();
  const state = path.join(root, 'state');
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(state);
  fs.mkdirSync(dataDir);
  const log = path.join(root, 'calls.jsonl');
  const filesDir = path.join(dataDir, 'voc-files');
  const env: NodeJS.ProcessEnv = { ...process.env, FAKE_VOC_STATE: state, FAKE_VOC_LOG: log, FAKE_VOC_MODE: mode, FAKE_VOC_NOW: '2026-09-23T01:00:00Z' };
  const runner = new VocCliRunner({
    locate: () => ({ ok: true, kind: 'fake', command: process.execPath, baseArgs: [FAKE] }),
    env,
    workDir: path.join(dataDir, 'voc-cwd'),
    downloadRoot: filesDir,
  });
  const settings = new VocSettingsStore(dataDir);
  const actions = new VocActionLog(dataDir);
  const service = new VocService({
    runner,
    settings: () => settings,
    actions: () => actions,
    today: () => TODAY,
    holidays: [],
    pageMaps: () => ({ custPage: new Map(), systemPage: new Map(), pageIndex: new Map() }),
    onBoard: () => {},
    filesDir,
    setTimer: (() => 0) as unknown as typeof setTimeout,
    clearTimer: (() => {}) as typeof clearTimeout,
  });
  const calls = (): string[][] =>
    fs.existsSync(log)
      ? fs
          .readFileSync(log, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => (JSON.parse(l) as { args: string[] }).args)
      : [];
  settles.push(() => service.refresh());
  if (mode === 'ok' || mode === 'fail-write') {
    const board = await service.refresh();
    expect(board.state).toBe('ok');
  }
  return { service, filesDir, state, dataDir, calls, since: (n) => calls().slice(n), actions };
}

let seq = 0;
const aid = (): string => `act-${Date.now().toString(16)}-${(++seq).toString(16).padStart(4, '0')}`;
const onBoard = (h: Harness, id: number): boolean => h.service.board().lanes.some((l) => l.tickets.some((t) => t.id === id));
const readState = (h: Harness, name: string): unknown => JSON.parse(fs.readFileSync(path.join(h.state, name), 'utf8'));

describe('VocService 첨부(명세 §14)', () => {
  it('목록에 있는 첨부만 voc-files/<티켓>/ 에 받는다 — 이미지는 data URL, exe 는 열기 없음(폴더에서 보기만)', async () => {
    const h = await harness();
    await expect(h.service.file({ ticketId: 1004, fileId: 7001, mode: 'preview' })).rejects.toThrow(/첨부 목록에 없는/);
    const detail = await h.service.ticketDetail(1004);
    expect(detail.attachments?.map((a) => a.id)).toEqual([7001, 7002, 7003]);

    const n = h.calls().length;
    const img = await h.service.file({ ticketId: 1004, fileId: 7001, mode: 'preview' });
    expect(img.dataUrl).toMatch(/^data:image\/png;base64,/);
    const dir = path.join(h.filesDir, '1004');
    expect(h.since(n)).toEqual([['file', 'download', '7001', `--out=${dir}${path.sep}`, '--json']]);
    expect(fs.existsSync(path.join(dir, 'screen.png'))).toBe(true);
    if (process.platform === 'win32') {
      // 인터넷에서 받은 파일 표시(Office·한글이 제한된 보기로 연다)
      expect(fs.readFileSync(`${path.join(dir, 'screen.png')}:Zone.Identifier`, 'utf8')).toContain('ZoneId=3');
    }

    await expect(h.service.file({ ticketId: 1004, fileId: 7002, mode: 'preview' })).rejects.toThrow(/이미지/);
    const pdf = await h.service.file({ ticketId: 1004, fileId: 7002, mode: 'download' });
    expect(pdf).toMatchObject({ fileName: 'report.pdf', canOpen: true });
    expect(pdf.dataUrl).toBeUndefined();
    expect(h.service.fileTarget({ ticketId: 1004, fileId: 7002, how: 'open' })).toBe(path.join(dir, 'report.pdf'));

    const exe = await h.service.file({ ticketId: 1004, fileId: 7003, mode: 'download' });
    expect(exe).toMatchObject({ fileName: 'setup.exe', canOpen: false });
    expect(() => h.service.fileTarget({ ticketId: 1004, fileId: 7003, how: 'open' })).toThrow(/열지 않습니다/);
    expect(h.service.fileTarget({ ticketId: 1004, fileId: 7003, how: 'reveal' })).toBe(path.join(dir, 'setup.exe'));
    // 받지 않은 것·다른 티켓의 id
    expect(() => h.service.fileTarget({ ticketId: 1004, fileId: 9999, how: 'reveal' })).toThrow(/먼저/);
    await expect(h.service.file({ ticketId: 1005, fileId: 7001, mode: 'download' })).rejects.toThrow(/첨부 목록에 없는/);
    // 받기는 쓰기가 아니다 — 기록 없음
    expect(h.actions.list()).toEqual([]);
  });

  it('받은 크기가 첨부 목록과 다르면 지우고 실패', async () => {
    const h = await harness();
    await h.service.ticketDetail(1004);
    // 상태 폴더의 자료를 바꿔 서버가 다른 바이트를 준 것처럼
    fs.mkdirSync(path.join(h.state, 'files', '7002'), { recursive: true });
    fs.writeFileSync(path.join(h.state, 'files', '7002', 'report.pdf'), '%PDF-short');
    await expect(h.service.file({ ticketId: 1004, fileId: 7002, mode: 'download' })).rejects.toThrow(/크기가 맞지 않아/);
    expect(fs.existsSync(path.join(h.filesDir, '1004', 'report.pdf'))).toBe(false);
    expect(() => h.service.fileTarget({ ticketId: 1004, fileId: 7002, how: 'reveal' })).toThrow(/먼저/);
  });
});

describe('VocService 작업시간(명세 §14)', () => {
  it('넣기: worklog add <id> --hours=1.5 --date=… --note=… --json → 다시 읽은 목록, 기록, 같은 actionId 는 한 번', async () => {
    const h = await harness();
    const input: VocWorkInput = { actionId: aid(), kind: 'worklogAdd', ticketId: 1004, worklog: { hours: 1.5, date: TODAY, note: '-p @원인 확인 *' } };
    const n = h.calls().length;
    const r = await h.service.work(input);
    expect(r).toMatchObject({ ok: true, message: expect.stringContaining('1.5시간') });
    expect(r.workLogs?.map((w) => [w.hours, w.workDate, w.note])).toEqual([[1.5, TODAY, '-p @원인 확인 *']]);
    expect(h.since(n)[0]).toEqual(['worklog', 'add', '1004', '--hours=1.5', `--date=${TODAY}`, '--note=-p @원인 확인 *', '--json']);
    expect(h.actions.list()[0]).toMatchObject({ id: input.actionId, kind: 'worklogAdd', ticketId: 1004, ok: true });
    const again = await h.service.work(input);
    expect(again).toMatchObject({ ok: false, message: expect.stringContaining('이미 실행한') });
    expect((readState(h, 'worklogs.json') as unknown[]).length).toBe(3);
  });

  it('값 규칙에 맞지 않으면 voc-cli 를 부르지 않는다: 0.5 단위 밖·내일 날짜·CP949 밖 글자·보드에 없는 티켓', async () => {
    const h = await harness();
    const n = h.calls().length;
    const bad = async (worklog: VocWorkInput['worklog'], ticketId = 1004) =>
      (await h.service.work({ actionId: aid(), kind: 'worklogAdd', ticketId, worklog })).message;
    expect(await bad({ hours: 0.3, date: TODAY, note: '' })).toMatch(/0.5 단위/);
    expect(await bad({ hours: 1, date: '2026-09-24', note: '' })).toMatch(/오늘 이후/);
    expect(await bad({ hours: 1, date: TODAY, note: '확인 😀' })).toMatch(/보낼 수 없는 글자/);
    expect(await bad({ hours: 1, date: TODAY, note: '' }, 1013)).toMatch(/보드에 없는/);
    expect(h.since(n)).toEqual([]);
  });

  it('지우기: 쓰기 직전 다시 읽어 내가 넣은 것만 — worklog delete <id> -y', async () => {
    const h = await harness();
    const n = h.calls().length;
    const other = await h.service.work({ actionId: aid(), kind: 'worklogDelete', ticketId: 1005, workLogId: 8002 });
    expect(other).toMatchObject({ ok: false, message: expect.stringContaining('내가 넣은') });
    const missing = await h.service.work({ actionId: aid(), kind: 'worklogDelete', ticketId: 1004, workLogId: 8001 });
    expect(missing).toMatchObject({ ok: false, message: expect.stringContaining('없습니다') });
    expect(h.since(n).filter((a) => a[1] === 'delete')).toEqual([]);
    const mine = await h.service.work({ actionId: aid(), kind: 'worklogDelete', ticketId: 1005, workLogId: 8001 });
    expect(mine.ok).toBe(true);
    expect(mine.workLogs?.map((w) => w.id)).toEqual([8002]);
    expect(h.since(n).filter((a) => a[1] === 'delete')).toEqual([['worklog', 'delete', '8001', '-y']]);
  });

  it('쓰기 실패(fail-write)는 서버 문장, 기록 ok:false', async () => {
    const h = await harness('fail-write');
    const input: VocWorkInput = { actionId: aid(), kind: 'worklogAdd', ticketId: 1004, worklog: { hours: 1, date: TODAY, note: '' } };
    const r = await h.service.work(input);
    expect(r).toEqual({ ok: false, message: '요청을 처리하지 못했습니다(가짜 쓰기 실패).' });
    expect(h.actions.list()[0]).toMatchObject({ id: input.actionId, ok: false });
  });
});

describe('VocService 해결·완료·재오픈(명세 §14)', () => {
  it('작업시간이 0건이면 시간 없이는 막고(resolve 를 부르지 않음), 시간을 주면 worklog add → ticket resolve → 보드에서 뺀다', async () => {
    const h = await harness();
    const n = h.calls().length;
    const none = await h.service.work({ actionId: aid(), kind: 'resolve', ticketId: 1006, expectedStatus: 'assigned' });
    expect(none).toMatchObject({ ok: false, message: expect.stringContaining('작업시간이 없어'), workLogs: [] });
    expect(h.since(n).map((a) => a.slice(0, 2).join(' '))).toEqual(['ticket get', 'worklog list']);

    const m = h.calls().length;
    const id = aid();
    const r = await h.service.work({ actionId: id, kind: 'resolve', ticketId: 1006, expectedStatus: 'assigned', worklog: { hours: 2, date: TODAY, note: '데이터 추출' } });
    expect(r).toMatchObject({ ok: true, done: true, message: expect.stringContaining('해결 처리했습니다') });
    expect(r.message).toContain('작업시간 2시간을 함께 넣었습니다');
    await h.service.refresh();
    expect(h.since(m)).toEqual([
      ['ticket', 'get', '1006', '--json'],
      ['worklog', 'list', '1006', '--json'],
      ['worklog', 'add', '1006', '--hours=2', `--date=${TODAY}`, '--note=데이터 추출', '--json'],
      ['ticket', 'resolve', '1006'],
      // 쓰기 뒤 목록 새로 받기
      ['ticket', 'list', '--hide-completed', '--size', '2000', '--json'],
    ]);
    expect(onBoard(h, 1006)).toBe(false);
    expect(h.actions.list().map((x) => [x.id, x.kind, x.ok])).toEqual([
      [id, 'resolve', true],
      [`${id}:worklog`, 'worklogAdd', true],
    ]);

    // 재오픈: 보드에 없어도 다시 읽은 상태(resolved)로 판정 → ticket reopen → 보드에 돌아온다
    const back = await h.service.work({ actionId: aid(), kind: 'reopen', ticketId: 1006, expectedStatus: 'resolved' });
    expect(back).toMatchObject({ ok: true, message: expect.stringContaining('재오픈') });
    expect(h.calls().some((a) => a.join(' ') === 'ticket reopen 1006')).toBe(true);
    expect(onBoard(h, 1006)).toBe(true);
  });

  it('담당자가 없으면 막고, 대화상자가 보인 상태와 다르면 실행하지 않는다(쓰기 직전 다시 읽기)', async () => {
    const h = await harness();
    const n = h.calls().length;
    const noOwner = await h.service.work({ actionId: aid(), kind: 'resolve', ticketId: 1001, expectedStatus: 'new', worklog: { hours: 1, date: TODAY, note: '' } });
    expect(noOwner).toMatchObject({ ok: false, message: expect.stringContaining('담당자가 없어') });
    const changed = await h.service.work({ actionId: aid(), kind: 'close', ticketId: 1005, expectedStatus: 'in_progress' });
    expect(changed).toMatchObject({ ok: false, message: expect.stringContaining('보류') });
    // 진행 중인 티켓은 재오픈하지 않는다
    const notDone = await h.service.work({ actionId: aid(), kind: 'reopen', ticketId: 1004, expectedStatus: 'in_progress' });
    expect(notDone).toMatchObject({ ok: false, message: expect.stringContaining('해결·완료된 티켓만') });
    expect(h.since(n).filter((a) => ['resolve', 'close', 'reopen', 'add'].includes(a[1]))).toEqual([]);
    // 작업시간이 있으면 시간 없이 완료
    const closed = await h.service.work({ actionId: aid(), kind: 'close', ticketId: 1005, expectedStatus: 'pending' });
    expect(closed).toMatchObject({ ok: true, done: true });
    expect(h.calls().some((a) => a.join(' ') === 'ticket close 1005')).toBe(true);
  });
});

describe('VocService 고객 메일(명세 §14)', () => {
  it('ticket email <id> --to=… --reply-id=… --json — 고른 답변 id 를 늘 적고, 발송 기록을 다시 읽는다', async () => {
    const h = await harness();
    const n = h.calls().length;
    const r = await h.service.work({
      actionId: aid(),
      kind: 'email',
      ticketId: 1004,
      expectedStatus: 'in_progress',
      email: { to: ['ops@haeon.example'], cc: ['kim@example.com'], replyIds: [5001, 5003] },
    });
    expect(r).toMatchObject({ ok: true, message: expect.stringContaining('받는 사람 1명 · 참조 1명 · 답변 2건') });
    await h.service.refresh();
    expect(h.since(n)).toEqual([
      ['ticket', 'get', '1004', '--replies', '--json'],
      ['ticket', 'email', '1004', '--to=ops@haeon.example', '--cc=kim@example.com', '--reply-id=5001,5003', '--json'],
      ['ticket', 'email-logs', '1004', '--json'],
      ['ticket', 'list', '--hide-completed', '--size', '2000', '--json'],
    ]);
    expect(r.emailLogs?.[0]).toMatchObject({ to: ['ops@haeon.example'], cc: ['kim@example.com'], emailType: 'progress' });
    expect(onBoard(h, 1004)).toBe(true);
  });

  it('주소 형식·같은 주소·이 티켓에 없는 답변은 막는다(메일 명령을 부르지 않음)', async () => {
    const h = await harness();
    const n = h.calls().length;
    const send = async (email: NonNullable<VocWorkInput['email']>) =>
      (await h.service.work({ actionId: aid(), kind: 'email', ticketId: 1004, expectedStatus: 'in_progress', email })).message;
    expect(await send({ to: ['담당 <ops@haeon.example>'], cc: [], replyIds: [] })).toMatch(/주소 형식/);
    expect(await send({ to: ['ops@haeon'], cc: [], replyIds: [] })).toMatch(/주소 형식/);
    expect(await send({ to: ['ops@haeon.example'], cc: ['OPS@haeon.example'], replyIds: [] })).toMatch(/두 번/);
    expect(await send({ to: ['ops@haeon.example'], cc: [], replyIds: [9999] })).toMatch(/없는 것/);
    expect(h.since(n).filter((a) => a[1] === 'email')).toEqual([]);
  });

  it('해결 + 고객 메일: 작업시간을 넣고 ticket email --resolve(ticket resolve 는 부르지 않는다)', async () => {
    const h = await harness();
    const n = h.calls().length;
    const r = await h.service.work({
      actionId: aid(),
      kind: 'resolve',
      ticketId: 1004,
      expectedStatus: 'in_progress',
      worklog: { hours: 0.5, date: TODAY, note: '' },
      email: { to: ['ops@haeon.example'], cc: [], replyIds: [5003] },
    });
    expect(r).toMatchObject({ ok: true, done: true, message: expect.stringContaining('해결 안내 메일') });
    const writes = h.since(n).filter((a) => ['add', 'email', 'resolve'].includes(a[1]));
    expect(writes).toEqual([
      ['worklog', 'add', '1004', '--hours=0.5', `--date=${TODAY}`, '--json'],
      ['ticket', 'email', '1004', '--to=ops@haeon.example', '--resolve', '--reply-id=5003', '--json'],
    ]);
    expect(onBoard(h, 1004)).toBe(false);
  });
});
