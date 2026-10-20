// 시험용 가짜 voc-cli (docs/stage2.6-contract.md §9). VocCliRunner 가 `node fake-voc-cli.mjs <명령…>` 으로 부른다.
// 네트워크를 쓰지 않고, 실제 voc-cli 의 세션 파일(~/.voc-cli)도 보지 않는다. 출력 모양은 실제 voc-cli 와 같게 한다:
// --json 은 백엔드 응답 그대로(TicketDto 등), 오류는 표준에러에 `오류: <메시지>` + 종료 코드 1, 인자 오류는 종료 코드 2.
//
// 자료: test/fixtures/voc/ — tickets.json(TicketDto 배열), users.json, codes-system.json(voc_sys_programs 대신 — systemName 채우기만,
//       `code list SYSTEM` 은 운영처럼 빈 배열), codes-request-type.json, customers.json, replies/<id>.json, whoami.txt
//
// 환경변수
//   FAKE_VOC_STATE    자료를 둔 임시 폴더. 읽을 때는 여기를 먼저 보고 없으면 test/fixtures/voc 를 본다.
//                     쓰기 명령(update·reply·create)은 여기의 tickets.json·replies/<id>.json 을 고쳐 다음 list·get 에 반영한다.
//                     없으면(또는 test/fixtures/voc 자체를 가리키면) 쓰기는 결과만 내고 아무 파일도 고치지 않는다.
//   FAKE_VOC_LOG      있으면 부른 인자를 한 줄 JSON({args, mode})으로 덧붙인다
//   FAKE_VOC_MODE     ok(기본) · login · expired · offline · slow · fail-write
//   FAKE_VOC_DELAY_MS slow 의 대기 시간(기본 5000)
//   FAKE_VOC_NOW      쓰기 명령이 적는 시각·로그인 잠금을 재는 시각(ISO, 기본 지금)
//   FAKE_VOC_PASSWORD login 이 받는 비밀번호(기본 secret — 가짜 값)
//
// 모드
//   login      모든 명령이 `오류: 로그인이 필요합니다. 먼저 \`voc-cli login\` 을 실행하세요.` + 종료 코드 1
//   expired    `오류: 세션이 만료되었습니다. \`voc-cli login\` 으로 다시 로그인하세요.` + 종료 코드 1
//   offline    `오류: 백엔드에 연결할 수 없습니다: <백엔드> — 서버가 실행 중인지 확인하세요.` + 종료 코드 1
//   slow       FAKE_VOC_DELAY_MS 만큼 기다린 뒤 ok 와 같다(제한 시간·직렬 큐 시험용)
//   fail-write 읽기는 ok, 쓰기는 `오류: 400 — …` + 종료 코드 1 (파일은 그대로)
// 허용 목록(ticket list·get·update·reply·create, user list, code list, customer list, whoami + V4: ticket resolve·close·reopen·email·
// email-logs, worklog list·add·delete, file download) 밖의 명령은 종료 코드 3.
//
// V4(명세 §14): 작업시간은 상태 폴더의 worklogs.json, 메일 기록은 email-logs.json 에 쌓는다(가짜 로그인 사용자는 101 홍길동).
// resolved·closed(update -s·resolve·close·email --resolve)는 서버처럼 담당자 + 작업시간 1건 이상이 없으면 400. worklog delete 는 -y 가
// 없으면 콘솔 오류, 남의 것이면 403. file download 는 files/<fileId>/<서버 파일명> 을 --out 폴더에 복사하고 {path, filename, size,
// contentType} 를 낸다(없는 id 는 404).
//
// 앱 안 로그인(명세 §13): 정확히 `login -u <아이디> --password`(값 없이)만 받는다. 실제 voc-cli(picocli 대화형 옵션)처럼 표준입력 한 줄을
// 비밀번호로 읽어 FAKE_VOC_PASSWORD 와 같으면 FAKE_VOC_STATE 에 로그인 표식(login.json — 아이디·시각만, 비밀번호는 쓰지 않는다)을 남기고
// `로그인 성공: <이름> (<role>) @ <백엔드>`(LoginCommand 와 같은 문장) + 종료 코드 0, 틀리면 `오류: 로그인 실패: 아이디 또는 비밀번호를
// 확인하세요.` + 종료 코드 1, 비었으면(표준입력 없음) `오류: 비밀번호를 입력할 콘솔이 없습니다. …` + 종료 코드 1.
// 서버처럼 아이디별 5번 연달아 틀리면 10분 잠그고(login-attempts.json — 아이디·셈·끝 시각만), 잠긴 동안에는 맞는 비밀번호도 같은
// `로그인 실패: …` 문장이다(실제 voc-cli 는 401 을 늘 이 문장으로 바꾼다).
// 로그인 표식이 있으면 login·expired 모드에서도 ok 처럼 답한다. 인자에 비밀번호가 들어오면(`--password=…`·`--password <값>`)
// 종료 코드 3(그 값은 표준출력·표준에러에 찍지 않는다 — 호출 기록 FAKE_VOC_LOG 는 앱이 보낸 인자 그대로라 새는지 시험이 본다).
// 다른 모양의 login·logout 도 종료 코드 3.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'voc');
const BACKEND = 'https://voc.example.test:11300';
const ALLOWED = new Set([
  'ticket list',
  'ticket get',
  'ticket update',
  'ticket reply',
  'ticket create',
  'user list',
  'code list',
  'customer list',
  'whoami',
  // V4(명세 §14)
  'ticket resolve',
  'ticket close',
  'ticket reopen',
  'ticket email',
  'ticket email-logs',
  'worklog list',
  'worklog add',
  'worklog delete',
  'file download',
]);
const STATUSES = ['new', 'assigned', 'in_progress', 'pending', 'resolved', 'closed', 'withdrawn'];
const COMPLETED = new Set(['resolved', 'closed', 'withdrawn']);
const PRIORITIES = new Set(['P1', 'P2', 'P3']);
/** 우선순위별 SLA 목표(분): [응답, 해결] */
const SLA = { P1: [60, 480], P2: [120, 1440], P3: [240, 2880] };

const argv = process.argv.slice(2);
const mode = process.env.FAKE_VOC_MODE || 'ok';

/** 쓰기를 저장할 폴더(없으면 null — 쓰기는 결과만 낸다) */
function stateDir() {
  const dir = process.env.FAKE_VOC_STATE;
  if (!dir) return null;
  const abs = path.resolve(dir);
  // 시험 자료 원본은 절대 고치지 않는다
  if (abs.toLowerCase() === path.resolve(FIXTURE_DIR).toLowerCase()) return null;
  return abs;
}

class CliError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.exitCode = code;
  }
}

/** picocli 인자 오류(종료 코드 2) */
function usage(message) {
  return new CliError(message, 2);
}

function out(text) {
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

function outJson(value) {
  out(JSON.stringify(value, null, 2));
}

function nowIso() {
  const fixed = process.env.FAKE_VOC_NOW;
  const d = fixed ? new Date(fixed) : new Date();
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ---- 자료 ---------------------------------------------------------------------------------

function readText(name) {
  const state = stateDir();
  if (state) {
    const p = path.join(state, name);
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
  }
  const p = path.join(FIXTURE_DIR, name);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

/** 맨 앞 BOM(U+FEFF)을 뗀다 */
function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function readJson(name, fallback) {
  const text = readText(name);
  if (text === null) return fallback;
  return JSON.parse(stripBom(text));
}

function writeJson(name, value) {
  const state = stateDir();
  if (!state) return;
  const p = path.join(state, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, p);
}

const tickets = () => readJson('tickets.json', []);
const users = () => readJson('users.json', []);
const systems = () => readJson('codes-system.json', []);
const requestTypes = () => readJson('codes-request-type.json', []);
const customers = () => readJson('customers.json', []);
const repliesOf = (id) => readJson(`replies/${id}.json`, []);

// ---- 인자 --------------------------------------------------------------------------------

/**
 * picocli 처럼 옵션을 읽는다. spec.values: 값을 받는 옵션 이름 → 키, spec.flags: 켜기 옵션 이름 → 키.
 * `--opt=값` 도 받는다. 모르는 옵션·값 없음·남는 인자는 종료 코드 2.
 */
function parseArgs(tokens, spec) {
  const opts = {};
  const positionals = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.startsWith('-') && tok.length > 1 && !/^-\d/.test(tok)) {
      const eq = tok.indexOf('=');
      const name = eq > 0 && tok.startsWith('--') ? tok.slice(0, eq) : tok;
      if (spec.flags && name in spec.flags) {
        opts[spec.flags[name]] = true;
        continue;
      }
      if (spec.values && name in spec.values) {
        let value;
        if (eq > 0 && tok.startsWith('--')) value = tok.slice(eq + 1);
        else {
          if (i + 1 >= tokens.length) throw usage(`Missing required parameter for option '${name}'`);
          const next = tokens[i + 1];
          // picocli 처럼: 다음 인자가 옵션 모양(아는 옵션 이름, 또는 '-' + 아는 한 글자 옵션으로 시작)이면 값으로 받지 않는다
          if (looksLikeOption(next, spec)) throw usage(`Expected parameter for option '${name}' but found '${next}'`);
          value = tokens[++i];
        }
        opts[spec.values[name]] = value;
        continue;
      }
      throw usage(`Unknown option: '${tok}'`);
    }
    positionals.push(tok);
  }
  const max = spec.positionals ?? 0;
  if (positionals.length > max) throw usage(`Unmatched argument at index ${max}: '${positionals[max]}'`);
  for (const req of spec.required ?? []) {
    if (opts[req.key] === undefined) throw usage(`Missing required option: '${req.label}'`);
  }
  return { opts, positionals };
}

/** picocli Interpreter.isOption 과 같은 판정(아는 이름 · `이름=값` · `-x…` 에서 -x 가 아는 한 글자 옵션) */
function looksLikeOption(tok, spec) {
  if (typeof tok !== 'string') return false;
  const names = new Set([...Object.keys(spec.values ?? {}), ...Object.keys(spec.flags ?? {})]);
  if (tok === '--' || names.has(tok)) return true;
  const eq = tok.indexOf('=');
  if (eq > 0 && names.has(tok.slice(0, eq))) return true;
  return tok.length > 2 && tok.startsWith('-') && names.has(tok.slice(0, 2));
}

/** 위치 인자 <id>(long) */
function ticketIdArg(positionals) {
  if (positionals.length === 0) throw usage("Missing required parameter: '<id>'");
  const raw = positionals[0];
  if (!/^\d+$/.test(raw)) throw usage(`Invalid value for positional parameter at index 0 (<id>): '${raw}' is not a long`);
  return Number(raw);
}

/** YYYY-MM-DD → 서버가 돌려주는 모양(UTC 로 적은 자정) */
function dueArg(value, label) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new CliError(`${label} 은 YYYY-MM-DD 형식이어야 합니다: ${value}`);
  return `${value}T00:00:00Z`;
}

function findTicket(list, id) {
  const t = list.find((x) => x.id === id);
  if (!t) throw new CliError(`404 — 티켓을 찾을 수 없습니다: ${id}`);
  return t;
}

function userName(id) {
  const u = users().find((x) => x.id === id);
  return u ? u.name : null;
}

function systemName(code) {
  const s = systems().find((x) => x.code === code);
  return s ? s.name : null;
}

/** get·update·create 응답 모양(목록과 달리 replyCount 가 없다 — 실제 서버와 같다) */
function detailShape(t) {
  return { ...t, replyCount: null };
}

function printSummary(t) {
  out(`  번호    : ${t.ticketNumber}  (id=${t.id})`);
  out(`  제목    : ${t.title}`);
  out(`  상태    : ${t.status}   우선순위: ${t.priority ?? '-'}`);
  if (t.internalAssigneeName) out(`  담당자  : ${t.internalAssigneeName}`);
}

// ---- 명령 ---------------------------------------------------------------------------------

function ticketList(tokens) {
  const { opts } = parseArgs(tokens, {
    values: {
      '-s': 'status',
      '--status': 'status',
      '-p': 'priority',
      '--priority': 'priority',
      '-q': 'search',
      '--search': 'search',
      '--assignee': 'assignee',
      '--system': 'system',
      '--created-from': 'createdFrom',
      '--created-to': 'createdTo',
      '--page': 'page',
      '--size': 'size',
    },
    flags: { '--mine': 'mine', '--hide-completed': 'hideCompleted', '--due-soon': 'dueSoon', '--sla-exceeded': 'slaExceeded', '--json': 'json' },
  });
  const page = opts.page === undefined ? 1 : Number(opts.page);
  const size = opts.size === undefined ? 20 : Number(opts.size);
  if (!Number.isInteger(page) || page < 1) throw usage(`Invalid value for option '--page': '${opts.page}' is not an int`);
  if (!Number.isInteger(size) || size < 1) throw usage(`Invalid value for option '--size': '${opts.size}' is not an int`);
  const list = (s) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : null);
  const statuses = list(opts.status);
  const priorities = list(opts.priority);
  const systemsFilter = list(opts.system);
  const assignees = list(opts.assignee);

  let rows = tickets();
  if (opts.hideCompleted) rows = rows.filter((t) => !COMPLETED.has(t.status));
  if (statuses) rows = rows.filter((t) => statuses.includes(t.status));
  if (priorities) rows = rows.filter((t) => priorities.includes(t.priority));
  if (systemsFilter) rows = rows.filter((t) => systemsFilter.includes(t.system));
  if (assignees) {
    rows = rows.filter((t) =>
      assignees.some((a) => (a === 'none' ? t.internalAssigneeId === null || t.internalAssigneeId === undefined : Number(a) === t.internalAssigneeId)),
    );
  }
  if (opts.search) rows = rows.filter((t) => `${t.title} ${t.description ?? ''} ${t.customer ?? ''}`.includes(opts.search));
  // 서버 정렬: created_at DESC
  rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : b.id - a.id));
  const total = rows.length;
  const totalPages = total === 0 ? 0 : Math.ceil(total / size);
  const data = rows.slice((page - 1) * size, page * size);
  if (opts.json) {
    outJson({ data, total, page, pageSize: size, totalPages });
    return;
  }
  out(`총 ${total}건 (페이지 ${page}/${totalPages})`);
  for (const t of data) out(`${t.id}  ${t.ticketNumber}  ${t.status}  ${t.priority ?? '-'}  ${t.internalAssigneeName ?? '미배정'}  ${t.title}`);
}

function ticketGet(tokens) {
  const { opts, positionals } = parseArgs(tokens, { flags: { '--replies': 'replies', '--json': 'json' }, positionals: 1 });
  const id = ticketIdArg(positionals);
  const t = findTicket(tickets(), id);
  const body = detailShape(t);
  if (opts.replies) body.replies = repliesOf(id);
  if (opts.json) {
    outJson(body);
    return;
  }
  printSummary(t);
  if (opts.replies) for (const r of body.replies) out(`  [${r.createdAt}] ${r.authorName ?? '-'}: ${r.content}`);
}

function failWriteIfAsked() {
  if (mode === 'fail-write') throw new CliError('400 — 요청을 처리하지 못했습니다(가짜 쓰기 실패).');
}

function ticketUpdate(tokens) {
  const { opts, positionals } = parseArgs(tokens, {
    values: {
      '-t': 'title',
      '--title': 'title',
      '-d': 'desc',
      '--desc': 'desc',
      '-s': 'status',
      '--status': 'status',
      '-p': 'priority',
      '--priority': 'priority',
      '--assignee': 'assignee',
      '--system': 'system',
      '--type': 'type',
      '--due': 'due',
      '--ict-due': 'ictDue',
    },
    flags: { '--clear-due': 'clearDue', '--clear-ict-due': 'clearIctDue', '--json': 'json' },
    positionals: 1,
  });
  const id = ticketIdArg(positionals);
  if (opts.assignee !== undefined && !/^\d+$/.test(opts.assignee)) {
    throw usage(`Invalid value for option '--assignee': '${opts.assignee}' is not a long`);
  }
  if (opts.status !== undefined && !STATUSES.includes(opts.status)) {
    throw new CliError(`상태는 [${STATUSES.join(', ')}] 중 하나여야 합니다: ${opts.status}`);
  }
  if (opts.priority !== undefined && !PRIORITIES.has(opts.priority)) {
    throw new CliError(`우선순위는 P1/P2/P3 중 하나여야 합니다: ${opts.priority}`);
  }
  const blank = (v) => v === undefined || v.trim() === '';
  const changes = ['title', 'desc', 'status', 'priority', 'assignee', 'system', 'type', 'due', 'ictDue'].filter((k) => !blank(opts[k]));
  if (changes.length === 0 && !opts.clearDue && !opts.clearIctDue) {
    throw new CliError('변경할 필드를 하나 이상 지정하세요. (예: --status resolved)');
  }
  const due = blank(opts.due) ? undefined : dueArg(opts.due, '고객 희망 완료일');
  const ictDue = blank(opts.ictDue) ? undefined : dueArg(opts.ictDue, '내부 목표 완료일');
  failWriteIfAsked();

  const list = tickets();
  const t = findTicket(list, id);
  if (!blank(opts.assignee)) {
    t.internalAssigneeId = Number(opts.assignee);
    t.internalAssigneeName = userName(t.internalAssigneeId);
  }
  if (!blank(opts.status)) {
    if (opts.status === 'resolved' || opts.status === 'closed') finishPrecondition(t);
    t.status = opts.status;
  }
  if (!blank(opts.priority)) {
    t.priority = opts.priority;
    if (!t.slaNotApplied) [t.slaResponseTarget, t.slaResolutionTarget] = SLA[opts.priority];
  }
  if (!blank(opts.title)) t.title = opts.title;
  if (!blank(opts.desc)) t.description = opts.desc;
  if (!blank(opts.system)) {
    t.system = opts.system;
    t.systemName = systemName(opts.system);
  }
  if (!blank(opts.type)) t.requestType = opts.type;
  if (due !== undefined) t.customerDueDate = due;
  if (ictDue !== undefined) t.ictDueDate = ictDue;
  if (opts.clearDue) t.customerDueDate = null;
  if (opts.clearIctDue) t.ictDueDate = null;
  t.updatedAt = nowIso();
  writeJson('tickets.json', list);

  if (opts.json) {
    outJson(detailShape(t));
    return;
  }
  out('티켓이 수정되었습니다.');
  printSummary(t);
}

function ticketReply(tokens) {
  const { opts, positionals } = parseArgs(tokens, {
    values: { '-c': 'content', '--content': 'content' },
    positionals: 1,
    required: [{ key: 'content', label: '--content=<content>' }],
  });
  const id = ticketIdArg(positionals);
  if (opts.content.trim() === '') throw new CliError('답변 내용을 입력하세요. (--content)');
  failWriteIfAsked();

  const list = tickets();
  const t = findTicket(list, id);
  const replies = repliesOf(id);
  const allIds = [5000];
  for (const x of list) for (const r of repliesOf(x.id)) allIds.push(r.id);
  const replyId = Math.max(...allIds) + 1;
  const at = nowIso();
  replies.push({
    id: replyId,
    ticketId: id,
    content: opts.content,
    authorId: 101,
    authorName: '홍길동',
    authorType: 'internal',
    createdAt: at,
    updatedAt: at,
    attachments: [],
  });
  t.replyCount = (typeof t.replyCount === 'number' ? t.replyCount : 0) + 1;
  t.lastReplyAt = at;
  t.updatedAt = at;
  writeJson(`replies/${id}.json`, replies);
  writeJson('tickets.json', list);
  out(`답변이 등록되었습니다. (답변 id=${replyId})`);
}

function ticketCreate(tokens) {
  const { opts } = parseArgs(tokens, {
    values: {
      '-t': 'title',
      '--title': 'title',
      '-d': 'desc',
      '--desc': 'desc',
      '-p': 'priority',
      '--priority': 'priority',
      '--customer': 'customer',
      '--customer-id': 'customerId',
      '--system': 'system',
      '--type': 'type',
      '--assignee': 'assignee',
      '--source': 'source',
      '--due': 'due',
      '--ict-due': 'ictDue',
    },
    flags: { '--json': 'json' },
    required: [{ key: 'title', label: '--title=<title>' }],
  });
  for (const key of ['customerId', 'assignee']) {
    if (opts[key] !== undefined && !/^\d+$/.test(opts[key])) {
      throw usage(`Invalid value for option '--${key === 'customerId' ? 'customer-id' : 'assignee'}': '${opts[key]}' is not a long`);
    }
  }
  if (opts.title.trim() === '') throw new CliError('400 — title: 공백일 수 없습니다');
  if (opts.title.length > 500) throw new CliError('400 — title: 크기가 0에서 500 사이여야 합니다');
  if ((opts.desc ?? '').length > 10_000) throw new CliError('400 — description: 크기가 0에서 10000 사이여야 합니다');
  const due = opts.due === undefined ? null : dueArg(opts.due, '고객 희망 완료일');
  const ictDue = opts.ictDue === undefined ? null : dueArg(opts.ictDue, '내부 목표 완료일');
  failWriteIfAsked();

  const list = tickets();
  const nextId = Math.max(1000, ...list.map((t) => t.id)) + 1;
  const seq = Math.max(
    9000,
    ...list.map((t) => {
      const m = /^VOC-2026-(\d+)$/.exec(t.ticketNumber ?? '');
      return m && Number(m[1]) >= 9001 ? Number(m[1]) : 0;
    }),
  ) + 1;
  let customerId = opts.customerId === undefined ? null : Number(opts.customerId);
  if (customerId === null && opts.customer) customerId = customers().find((c) => c.customerName === opts.customer)?.id ?? null;
  const customer = customerId === null ? null : customers().find((c) => c.id === customerId)?.customerName ?? null;
  const assigneeId = opts.assignee === undefined ? null : Number(opts.assignee);
  const priority = opts.priority ?? null;
  const [resp, resol] = SLA[priority ?? 'P3'] ?? SLA.P3;
  const at = nowIso();
  const t = {
    id: nextId,
    ticketNumber: `VOC-2026-${String(seq).padStart(4, '0')}`,
    title: opts.title,
    description: opts.desc ?? null,
    customerId,
    customer,
    system: opts.system ?? null,
    systemName: opts.system ? systemName(opts.system) : null,
    requestType: opts.type ?? null,
    priority,
    status: assigneeId === null ? 'new' : 'assigned',
    source: opts.source ?? 'internal',
    sourceCustomerName: null,
    createdBy: 101,
    createdByName: '홍길동',
    internalAssigneeId: assigneeId,
    internalAssigneeName: assigneeId === null ? null : userName(assigneeId),
    createdAt: at,
    updatedAt: at,
    customerDueDate: due,
    ictDueDate: ictDue,
    planDueDate: null,
    resolvedAt: null,
    closedAt: null,
    lastReplyAt: null,
    slaResponseTarget: resp,
    slaResolutionTarget: resol,
    slaResponseActual: null,
    slaResolutionActual: null,
    slaStatus: 'normal',
    slaNotApplied: false,
    attachments: [],
    isRecurring: false,
    recurrencePeriod: null,
    recurrenceType: null,
    relatedTicketIds: null,
    customerEmail: null,
    customerEmails: [],
    recurringTaskId: null,
    workType: null,
    maintenanceRatio: null,
    replyCount: 0,
    externalCustomerId: null,
    requesterName: null,
  };
  list.push(t);
  writeJson('tickets.json', list);
  if (opts.json) {
    outJson(detailShape(t));
    return;
  }
  out('티켓이 생성되었습니다.');
  printSummary(t);
}

// ---- V4(명세 §14): 해결·완료·재오픈, 작업시간, 고객 메일, 첨부 내려받기 -----------------------------

/** 가짜 로그인 사용자(whoami 의 홍길동) */
const ME_ID = 101;
const worklogs = () => readJson('worklogs.json', []);
const emailLogs = () => readJson('email-logs.json', []);
/** TicketEmailCommand 의 주소 검사와 같다 */
const EMAIL = /^[^@\s,;]+@[^@\s,;]+$/;

/** 서버의 resolved·closed 선행조건(담당자 + 작업시간 1건 이상). 안 맞으면 400 */
function finishPrecondition(t) {
  if (t.internalAssigneeId === null || t.internalAssigneeId === undefined) {
    throw new CliError('400 — 담당자가 지정되지 않은 상태에서는 해결/완료 처리할 수 없습니다.');
  }
  if (!worklogs().some((w) => w.entityId === t.id)) throw new CliError('400 — 작업 시간을 먼저 입력해야 해결/완료 처리할 수 있습니다.');
}

/** 서버 시각(UTC, Z 없음 — WorkLogDto·이메일 기록처럼) */
function serverNow() {
  return nowIso().replace(/Z$/, '');
}

/** 오늘(KST) YYYY-MM-DD */
function kstToday() {
  return new Date(nowMs() + 9 * 3_600_000).toISOString().slice(0, 10);
}

/** ticket resolve|close|reopen <id> — 텍스트 출력(--json 없음, Tickets.changeStatus) */
function ticketChangeStatus(status, done) {
  return (tokens) => {
    const { positionals } = parseArgs(tokens, { positionals: 1 });
    const id = ticketIdArg(positionals);
    failWriteIfAsked();
    const list = tickets();
    const t = findTicket(list, id);
    if (status === 'resolved' || status === 'closed') finishPrecondition(t);
    t.status = status;
    t.updatedAt = nowIso();
    if (status === 'resolved') t.resolvedAt = t.updatedAt;
    if (status === 'closed') t.closedAt = t.updatedAt;
    writeJson('tickets.json', list);
    out(done);
    printSummary(t);
  };
}

function worklogList(tokens) {
  const { opts, positionals } = parseArgs(tokens, { flags: { '--json': 'json' }, positionals: 1 });
  const id = ticketIdArg(positionals);
  const rows = worklogs()
    .filter((w) => w.entityId === id)
    .sort((a, b) => (a.workDate < b.workDate ? 1 : a.workDate > b.workDate ? -1 : b.id - a.id));
  if (opts.json) {
    outJson(rows);
    return;
  }
  for (const w of rows) out(`${w.id}  ${w.workDate}  ${w.userName}  ${w.hours}h  ${w.note ?? ''}`);
  out(`${rows.length}건 · 합계 ${rows.reduce((s, w) => s + w.hours, 0)}시간`);
}

function worklogAdd(tokens) {
  const { opts, positionals } = parseArgs(tokens, {
    values: { '--hours': 'hours', '--date': 'date', '--note': 'note' },
    flags: { '--json': 'json' },
    positionals: 1,
    required: [{ key: 'hours', label: '--hours=<hours>' }],
  });
  const id = ticketIdArg(positionals);
  const hours = Number(opts.hours);
  if (!Number.isFinite(hours)) throw usage(`Invalid value for option '--hours': '${opts.hours}' is not a double`);
  if (!(hours > 0 && hours <= 24)) throw new CliError('작업 시간은 0보다 크고 24 이하여야 합니다.');
  const date = opts.date ?? kstToday();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new CliError(`작업일은 YYYY-MM-DD 형식이어야 합니다: ${date}`);
  failWriteIfAsked();
  findTicket(tickets(), id);
  const list = worklogs();
  const at = serverNow();
  const w = {
    id: Math.max(8000, ...list.map((x) => x.id)) + 1,
    entityType: 'ticket',
    entityId: id,
    userId: ME_ID,
    userName: userName(ME_ID),
    workDate: date,
    minutes: Math.round(hours * 60),
    hours: Math.round(hours * 60) / 60,
    note: opts.note ?? null,
    createdBy: ME_ID,
    createdAt: at,
    updatedAt: at,
  };
  list.push(w);
  writeJson('worklogs.json', list);
  if (opts.json) {
    outJson(w);
    return;
  }
  out(`작업 로그를 등록했습니다. (id=${w.id})`);
}

function worklogDelete(tokens) {
  const { opts, positionals } = parseArgs(tokens, { flags: { '-y': 'yes', '--yes': 'yes' }, positionals: 1 });
  if (positionals.length === 0) throw usage("Missing required parameter: '<workLogId>'");
  if (!/^\d+$/.test(positionals[0])) throw usage(`Invalid value for positional parameter at index 0 (<workLogId>): '${positionals[0]}' is not a long`);
  const id = Number(positionals[0]);
  // 실제 voc-cli: -y 가 없으면 콘솔 확인을 묻는데, 앱(콘솔 없음)에서는 이 오류다
  if (!opts.yes) throw new CliError('확인 입력을 받을 콘솔이 없습니다. 삭제하려면 --yes 를 붙이세요.');
  failWriteIfAsked();
  const list = worklogs();
  const w = list.find((x) => x.id === id);
  // 서버는 없는 id 에도 204 — "삭제했습니다"
  if (w && w.userId !== ME_ID) throw new CliError('403 — 본인이 등록한 작업 로그만 수정/삭제할 수 있습니다.');
  if (w) writeJson('worklogs.json', list.filter((x) => x.id !== id));
  out(`삭제했습니다: 작업 로그 id=${id}`);
}

/** 콤마 목록(빈 값 제외, 형식 검사) */
function addressList(value, option) {
  const list = (value ?? '').split(',').map((a) => a.trim()).filter(Boolean);
  for (const a of list) if (!EMAIL.test(a)) throw new CliError(`이메일 형식이 올바르지 않습니다: ${a} (${option})`);
  return list;
}

function ticketEmail(tokens) {
  const { opts, positionals } = parseArgs(tokens, {
    values: { '--to': 'to', '--cc': 'cc', '--reply-id': 'replyIds' },
    flags: { '--resolve': 'resolve', '--json': 'json' },
    positionals: 1,
    required: [{ key: 'to', label: '--to=<to>' }],
  });
  const id = ticketIdArg(positionals);
  const to = addressList(opts.to, '--to');
  const cc = addressList(opts.cc, '--cc');
  if (to.length === 0) throw new CliError('받는 사람 이메일을 입력하세요. (--to)');
  const replyIds = (opts.replyIds ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  for (const r of replyIds) if (!/^\d+$/.test(r)) throw usage(`Invalid value for option '--reply-id': '${r}' is not a long`);
  failWriteIfAsked();
  const list = tickets();
  const t = findTicket(list, id);
  if (opts.resolve) {
    try {
      finishPrecondition(t);
    } catch (err) {
      throw new CliError(`400 — 상태 변경에 실패했습니다: ${String(err.message).replace(/^400 — /, '')}`);
    }
    t.status = 'resolved';
    t.updatedAt = nowIso();
    t.resolvedAt = t.updatedAt;
    writeJson('tickets.json', list);
  }
  const logs = emailLogs();
  logs.push({
    id: Math.max(9500, ...logs.map((x) => x.id)) + 1,
    ticketId: id,
    sentByName: userName(ME_ID),
    toAddresses: to,
    ccAddresses: cc,
    subject: `[VOC] ${t.ticketNumber} ${t.title}`,
    status: 'sent',
    emailType: opts.resolve ? 'resolved' : 'progress',
    sentAt: serverNow(),
  });
  writeJson('email-logs.json', logs);
  const body = { toAddresses: to, ccAddresses: cc, changeStatus: !!opts.resolve, replyIds: replyIds.length ? replyIds.map(Number) : null };
  if (opts.json) {
    outJson({ ticketId: id, sent: true, ...body });
    return;
  }
  out(`메일을 발송했습니다. (받는 사람 ${to.length}명${cc.length ? `, 참조 ${cc.length}명` : ''}${replyIds.length ? `, 답변 ${replyIds.length}건` : ''})`);
}

function ticketEmailLogs(tokens) {
  const { opts, positionals } = parseArgs(tokens, { flags: { '--json': 'json' }, positionals: 1 });
  const id = ticketIdArg(positionals);
  const rows = emailLogs()
    .filter((x) => x.ticketId === id)
    .sort((a, b) => (a.sentAt < b.sentAt ? 1 : a.sentAt > b.sentAt ? -1 : b.id - a.id));
  if (opts.json) {
    outJson(rows);
    return;
  }
  for (const x of rows) out(`${x.sentAt}  ${x.status}  ${x.emailType}  ${x.toAddresses.join(',')}`);
}

/** 첨부 자료: files/<fileId>/<서버 파일명> (상태 폴더 → fixture 순) */
function fixtureFile(fileId) {
  const dirs = [];
  const state = stateDir();
  if (state) dirs.push(path.join(state, 'files', String(fileId)));
  dirs.push(path.join(FIXTURE_DIR, 'files', String(fileId)));
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    const name = fs.readdirSync(dir).find((n) => fs.statSync(path.join(dir, n)).isFile());
    if (name) return { name, path: path.join(dir, name) };
  }
  return null;
}

function fileDownload(tokens) {
  const { opts, positionals } = parseArgs(tokens, {
    values: { '-o': 'out', '--out': 'out' },
    flags: { '--json': 'json' },
    positionals: 1,
    required: [{ key: 'out', label: '--out=<out>' }],
  });
  if (positionals.length === 0) throw usage("Missing required parameter: '<fileId>'");
  if (!/^\d+$/.test(positionals[0])) throw usage(`Invalid value for positional parameter at index 0 (<fileId>): '${positionals[0]}' is not a long`);
  const src = fixtureFile(Number(positionals[0]));
  if (!src) throw new CliError('404 — 리소스를 찾을 수 없습니다.');
  const outArg = opts.out;
  const isDir = /[\\/]$/.test(outArg) || (fs.existsSync(outArg) && fs.statSync(outArg).isDirectory());
  const target = isDir ? path.join(path.resolve(outArg), src.name) : path.resolve(outArg);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(src.path, target);
  const size = fs.statSync(target).size;
  if (opts.json) {
    outJson({ path: target, filename: src.name, size, contentType: 'application/octet-stream' });
    return;
  }
  out(`저장했습니다: ${target} (${size} bytes)`);
}

function userList(tokens) {
  const { opts } = parseArgs(tokens, { values: { '-q': 'search', '--search': 'search', '--role': 'role' }, flags: { '--json': 'json' } });
  // 실제 서버는 role 이 비면 빈 배열을 준다
  const roles = (opts.role ?? '').split(',').map((r) => r.trim().toLowerCase()).filter(Boolean);
  let rows = users().filter((u) => roles.includes(String(u.role).toLowerCase()));
  // --json 이면 -q 는 무시된다(실제 voc-cli 와 같다)
  if (!opts.json && opts.search) rows = rows.filter((u) => `${u.name} ${u.email} ${u.department}`.includes(opts.search));
  if (opts.json) {
    outJson(rows);
    return;
  }
  for (const u of rows) out(`${u.id}  ${u.name}  ${u.email}  ${u.department ?? '-'}  ${u.role}`);
}

function codeList(tokens) {
  const { opts, positionals } = parseArgs(tokens, { values: { '--group-id': 'groupId' }, flags: { '--json': 'json' }, positionals: 1 });
  const group = positionals[0];
  // 운영처럼: SYSTEM 코드 그룹은 꺼져 있다(백엔드 V39 — 시스템은 voc_sys_programs 로 옮겨졌다). CodeService.list 는 켜진 그룹만
  // 돌려주므로 `code list SYSTEM` 은 빈 배열이다. codes-system.json 은 voc_sys_programs 대신 티켓의 systemName 을 채우는 데만 쓴다
  let rows;
  if (group === undefined) rows = [...requestTypes()];
  else if (group === 'REQUEST_TYPE') rows = requestTypes();
  else rows = [];
  if (opts.json) {
    outJson(rows);
    return;
  }
  for (const c of rows) out(`${c.code}  ${c.name}${c.enabled === false ? '  (비활성)' : ''}`);
}

function customerList(tokens) {
  const { opts } = parseArgs(tokens, { values: { '-q': 'search', '--search': 'search' }, flags: { '--json': 'json' } });
  let rows = customers();
  if (!opts.json && opts.search) rows = rows.filter((c) => `${c.customerName} ${c.customerCode}`.includes(opts.search));
  if (opts.json) {
    outJson(rows);
    return;
  }
  for (const c of rows) out(`${c.id}  ${c.customerCode}  ${c.customerName}`);
}

function whoami(tokens) {
  parseArgs(tokens, {});
  const text = readText('whoami.txt');
  if (text === null) throw new CliError('응답 파싱 실패: whoami.txt 가 없습니다');
  out(stripBom(text).replace(/\s+$/, ''));
}

// ---- 시작 ---------------------------------------------------------------------------------

// ---- 로그인(명세 §13) ------------------------------------------------------------------------

/** 로그인 표식 파일(FAKE_VOC_STATE 안). 아이디·시각만 적는다 */
const LOGIN_MARK = 'login.json';
/** 서버 로그인 잠금 기록(FAKE_VOC_STATE 안 — 아이디별 연속 실패 수·잠금 끝 시각만, 비밀번호는 쓰지 않는다) */
const LOGIN_ATTEMPTS = 'login-attempts.json';
/** voc20-backend LoginAttemptService 와 같다: 아이디별 5번 연달아 틀리면 10분 잠근다. 셈은 시간으로 줄지 않는다 */
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_LOCK_MS = 600_000;
const LOGIN_FAILED = '로그인 실패: 아이디 또는 비밀번호를 확인하세요.';

/** 지금 시각(ms) — FAKE_VOC_NOW 가 있으면 그 시각 */
function nowMs() {
  const fixed = process.env.FAKE_VOC_NOW;
  const t = fixed ? Date.parse(fixed) : Date.now();
  return Number.isNaN(t) ? Date.now() : t;
}

/** 로그인 잠금 기록 [{loginId, count, lockedUntil(ISO|null)}] */
function readAttempts() {
  const raw = readJson(LOGIN_ATTEMPTS, []);
  return Array.isArray(raw) ? raw.filter((a) => a && typeof a.loginId === 'string') : [];
}

/**
 * 서버의 로그인 잠금(AuthService.login 과 같은 차례): 잠긴 아이디는 비밀번호를 보지 않고 거부한다 — 실제 voc-cli 는 그 401 도
 * `로그인 실패: …확인하세요.`로 바꾼다(잠금 문장이 사라진다). 잠금이 풀렸으면 기록을 지운다. 틀리면 셈을 늘리고 5번째에 10분 잠근다.
 * 맞으면 지운다
 */
function checkLoginAttempt(loginId, correct) {
  const list = readAttempts();
  const i = list.findIndex((a) => a.loginId === loginId);
  let held = i >= 0 ? list[i] : undefined;
  if (held && held.lockedUntil) {
    if (nowMs() > Date.parse(held.lockedUntil)) {
      list.splice(i, 1);
      held = undefined;
      writeJson(LOGIN_ATTEMPTS, list);
    } else {
      throw new CliError(LOGIN_FAILED);
    }
  }
  const rest = list.filter((a) => a.loginId !== loginId);
  if (correct) {
    if (held) writeJson(LOGIN_ATTEMPTS, rest);
    return;
  }
  const count = (held?.count ?? 0) + 1;
  const lockedUntil = count >= LOGIN_MAX_ATTEMPTS ? new Date(nowMs() + LOGIN_LOCK_MS).toISOString() : null;
  writeJson(LOGIN_ATTEMPTS, [...rest, { loginId, count, lockedUntil }]);
  throw new CliError(LOGIN_FAILED);
}

/** 앞서 login 에 성공했는가(표식이 있으면 login·expired 모드에서도 ok 처럼 답한다) */
function loggedIn() {
  const state = stateDir();
  return !!state && fs.existsSync(path.join(state, LOGIN_MARK));
}

/** 인자에 비밀번호 값이 들어왔는가: `--password=…`, 또는 `--password` 뒤에 인자가 더 있다 */
function passwordInArgs(tokens) {
  return tokens.some((t, i) => (typeof t === 'string' && t.startsWith('--password=')) || (t === '--password' && i < tokens.length - 1));
}

/** 표준입력 한 줄(줄바꿈 앞까지). 표준입력이 닫혀 있으면(ignore) '' */
function readStdinLine() {
  return new Promise((resolve) => {
    let buf = '';
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      try {
        process.stdin.destroy();
      } catch {
        // 이미 닫혔다
      }
      resolve(value);
    };
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      buf += chunk;
      const i = buf.indexOf('\n');
      if (i >= 0) finish(buf.slice(0, i).replace(/\r$/, ''));
    });
    process.stdin.on('end', () => finish(buf.replace(/\r?\n$/, '')));
    process.stdin.on('error', () => finish(''));
  });
}

/** whoami.txt 의 한 줄 값(`이름        : 홍길동`) */
function whoamiField(label) {
  const text = readText('whoami.txt') ?? '';
  for (const line of stripBom(text).split(/\r?\n/)) {
    const m = /^\s*([^:]+?)\s*:\s?(.*)$/.exec(line);
    if (m && m[1].replace(/\s+/g, ' ').trim() === label) return m[2].trim();
  }
  return '';
}

/** tokens = ['login', '-u', <아이디>, '--password'](모양은 main 이 먼저 확인했다) */
async function login(tokens) {
  // 실제 LoginCommand: -u/--user 필수, --password 는 값 없이(대화형). 앱은 정확히 이 모양만 보낸다
  const loginId = tokens[2];
  const password = await readStdinLine();
  if (mode === 'offline') throw new CliError(`백엔드에 연결할 수 없습니다: ${BACKEND} — 서버가 실행 중인지 확인하세요.`);
  if (mode === 'slow') await sleep(Number(process.env.FAKE_VOC_DELAY_MS || 5_000));
  if (password === '') throw new CliError('비밀번호를 입력할 콘솔이 없습니다. --password 옵션을 사용하세요.');
  const expected = process.env.FAKE_VOC_PASSWORD || 'secret';
  checkLoginAttempt(loginId, password === expected);
  writeJson(LOGIN_MARK, { loginId, at: nowIso() });
  const name = whoamiField('이름') || loginId;
  const role = whoamiField('권한(role)') || 'staff';
  const state = stateDir();
  out(`로그인 성공: ${name} (${role}) @ ${BACKEND}`);
  out(`세션 저장 위치: ${state ? path.join(state, LOGIN_MARK) : '(가짜 — 저장하지 않음)'}`);
}

function writeLog() {
  const logPath = process.env.FAKE_VOC_LOG;
  if (!logPath) return;
  fs.appendFileSync(logPath, `${JSON.stringify({ args: argv, mode })}\n`, 'utf8');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  writeLog();
  if (argv[0] === 'login') {
    if (passwordInArgs(argv)) {
      process.stderr.write('오류: 가짜 voc-cli: 비밀번호를 인자로 받지 않습니다(표준입력으로만)\n');
      process.exitCode = 3;
      return;
    }
    if (argv.length !== 4 || argv[1] !== '-u' || argv[3] !== '--password' || !argv[2]) {
      process.stderr.write('오류: 가짜 voc-cli 가 허용하지 않는 login 모양입니다(login -u <아이디> --password 만)\n');
      process.exitCode = 3;
      return;
    }
    return login(argv);
  }
  const command = argv[0] === 'whoami' ? 'whoami' : argv.length >= 2 ? `${argv[0]} ${argv[1]}` : String(argv[0] ?? '');
  if (!ALLOWED.has(command)) {
    process.stderr.write(`오류: 가짜 voc-cli 가 허용하지 않는 명령입니다: ${command || '(없음)'}\n`);
    process.exitCode = 3;
    return;
  }
  const rest = argv.slice(command === 'whoami' ? 1 : 2);

  // 앱 안 로그인에 성공한 뒤에는 로그인 필요·만료 모드도 ok 처럼 답한다
  const effective = (mode === 'login' || mode === 'expired') && loggedIn() ? 'ok' : mode;
  switch (effective) {
    case 'login':
      throw new CliError('로그인이 필요합니다. 먼저 `voc-cli login` 을 실행하세요.');
    case 'expired':
      throw new CliError('세션이 만료되었습니다. `voc-cli login` 으로 다시 로그인하세요.');
    case 'offline':
      throw new CliError(`백엔드에 연결할 수 없습니다: ${BACKEND} — 서버가 실행 중인지 확인하세요.`);
    case 'slow':
      await sleep(Number(process.env.FAKE_VOC_DELAY_MS || 5_000));
      break;
    case 'ok':
    case 'fail-write':
      break;
    default:
      process.stderr.write(`가짜 voc-cli: 모르는 모드 ${mode}\n`);
      process.exitCode = 4;
      return;
  }

  switch (command) {
    case 'ticket list':
      return ticketList(rest);
    case 'ticket get':
      return ticketGet(rest);
    case 'ticket update':
      return ticketUpdate(rest);
    case 'ticket reply':
      return ticketReply(rest);
    case 'ticket create':
      return ticketCreate(rest);
    case 'user list':
      return userList(rest);
    case 'code list':
      return codeList(rest);
    case 'customer list':
      return customerList(rest);
    case 'whoami':
      return whoami(rest);
    case 'ticket resolve':
      return ticketChangeStatus('resolved', '해결(resolved) 처리했습니다.')(rest);
    case 'ticket close':
      return ticketChangeStatus('closed', '완료(closed) 처리했습니다.')(rest);
    case 'ticket reopen':
      return ticketChangeStatus('assigned', '재오픈(assigned)했습니다.')(rest);
    case 'ticket email':
      return ticketEmail(rest);
    case 'ticket email-logs':
      return ticketEmailLogs(rest);
    case 'worklog list':
      return worklogList(rest);
    case 'worklog add':
      return worklogAdd(rest);
    case 'worklog delete':
      return worklogDelete(rest);
    case 'file download':
      return fileDownload(rest);
    default:
      throw new CliError(`모르는 명령: ${command}`);
  }
}

main().catch((err) => {
  if (err instanceof CliError) {
    if (err.exitCode === 2) process.stderr.write(`${err.message}\nUsage: voc-cli ${argv.slice(0, 2).join(' ')} [OPTIONS]\n`);
    else process.stderr.write(`오류: ${err.message}\n`);
    process.exitCode = err.exitCode;
    return;
  }
  process.stderr.write(`오류: 가짜 voc-cli 내부 오류 — ${err && err.stack ? err.stack : String(err)}\n`);
  process.exitCode = 5;
});
