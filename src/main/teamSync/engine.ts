// 팀 위키 양방향 동기화 엔진 — 업무 NAS 원본(remote)과 내 PC 사본(local). electron 을 import 하지 않는다.
// 계약: docs/stage2.8-contract.md
//
// 지난 동기화 때의 상태(파일별 해시·크기·수정 시각)를 기준(base)으로 양쪽을 비교한다.
//   - 한쪽만 바뀜 → 그쪽을 다른 쪽으로 복사(삭제도 같다)
//   - 양쪽 다 바뀜 → 「충돌 사본」을 따로 남기고 NAS 쪽을 본문으로 둔다(아무것도 버리지 않는다)
//   - 한쪽 삭제 + 다른 쪽 수정 → 수정이 이긴다
//   - 삭제는 지우지 않고 그쪽 `.휴지통\날짜\` 로 옮긴다
// 그리고 한 번에 많이 지우거나 덮어쓰게 되면(NAS 연결이 끊겨 "전부 사라짐"으로 보이는 경우 등) 멈추고 사람에게 묻는다.
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

/** 동기화하지 않는 폴더(어느 깊이든) — 휴지통·버전관리·Synology 가 만드는 폴더 */
const SKIP_DIRS = new Set(['.휴지통', '.trash', '.git', '#recycle', '@eaDir', '#snapshot']);
/** 사람마다 다른 Obsidian 창 배치 — 서로 덮어쓰면 창이 뒤죽박죽이 된다 */
const SKIP_OBSIDIAN = /^\.obsidian\/(workspace[^/]*\.json|cache(\/|$))/i;
/** 시스템·임시 파일 */
const SKIP_NAMES = /^(thumbs\.db|desktop\.ini|\.ds_store|~\$.*|\.~lock\..*|.*\.tmp|.*\.wiki-radar-tmp)$/i;

/** 휴지통 폴더 이름(양쪽 공통) */
export const TRASH_DIR = '.휴지통';
/** 내 PC 사본이 이 앱이 만든 동기화 폴더라는 표시. 동기화하지 않는다 */
export const LOCAL_MARKER = '.wiki-radar-team';
/** 이보다 많이 지우거나 덮어쓰면 멈추고 묻는다 */
export const DEFAULT_LARGE_LIMIT = 10;

export interface FileRec {
  /** 지난 동기화 때 양쪽이 같았던 내용의 sha256 */
  hash: string;
  size: number;
  /** 그때 내 PC·NAS 파일의 수정 시각(ms). 같으면 내용을 다시 읽지 않는다 */
  lm: number;
  rm: number;
  /** 화면에 보일 경로('/' 구분, 실제 대소문자) */
  rel: string;
}

export interface SyncState {
  remote: string;
  local: string;
  /** 키: 소문자 상대경로(Windows·SMB 는 대소문자를 가리지 않는다) */
  files: Record<string, FileRec>;
  at: string;
}

export interface SyncOptions {
  remote: string;
  local: string;
  /** 지난 동기화 상태. 처음이거나 경로가 바뀌었으면 null */
  state: SyncState | null;
  /** 충돌 사본 이름에 넣을 사람 */
  who: string;
  now: Date;
  /** 많이 지우거나 덮어쓰는 것을 사람이 확인했다 */
  confirmLarge?: boolean;
  largeLimit?: number;
}

export interface SyncPending {
  deletes: number;
  overwrites: number;
  /** 예시 경로 몇 개 */
  sample: string[];
}

export interface SyncReport {
  outcome: 'done' | 'paused' | 'error';
  pulled: string[];
  pushed: string[];
  deletedLocal: string[];
  deletedRemote: string[];
  /** 만든 충돌 사본(상대경로) */
  conflicts: string[];
  /** 이번에 건너뛴 파일과 이유 — 다음 동기화 때 다시 본다 */
  skipped: { rel: string; reason: string }[];
  pending?: SyncPending;
  message?: string;
  /** 다음 동기화의 기준. error 면 입력 상태 그대로 */
  state: SyncState | null;
}

interface Stat {
  rel: string;
  size: number;
  mtime: number;
}

type Kind = 'keep' | 'adopt' | 'pull' | 'push' | 'deleteLocal' | 'deleteRemote' | 'conflict' | 'forget' | 'carry';

interface Plan {
  key: string;
  kind: Kind;
  rel: string;
  /** 판정에 쓴 내용 해시(있을 때) */
  lHash?: string;
  rHash?: string;
}

/** 동기화 대상인가('/' 구분 상대경로) */
export function isSynced(rel: string): boolean {
  const parts = rel.split('/');
  if (parts.some((p) => SKIP_DIRS.has(p))) return false;
  if (SKIP_OBSIDIAN.test(rel)) return false;
  const name = parts[parts.length - 1];
  if (name === LOCAL_MARKER) return false;
  return !SKIP_NAMES.test(name);
}

function keyOf(rel: string): string {
  return rel.toLowerCase();
}

/** 폴더 아래 파일 목록(키 → 상태). 읽지 못하는 하위 폴더는 건너뛰지 않고 오류로 올린다 */
export async function scanTree(root: string): Promise<Map<string, Stat>> {
  const out = new Map<string, Stat>();
  const walk = async (dir: string, relDir: string): Promise<void> => {
    for (const ent of await fsp.readdir(dir, { withFileTypes: true })) {
      const rel = relDir ? `${relDir}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue;
        await walk(path.join(dir, ent.name), rel);
      } else if (ent.isFile()) {
        if (!isSynced(rel)) continue;
        const st = await fsp.stat(path.join(dir, ent.name));
        out.set(keyOf(rel), { rel, size: st.size, mtime: Math.trunc(st.mtimeMs) });
      }
    }
  };
  await walk(root, '');
  return out;
}

async function hashFile(abs: string): Promise<string> {
  return sha256(await fsp.readFile(abs));
}

function sha256(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

async function exists(p: string): Promise<boolean> {
  try {
    await fsp.stat(p);
    return true;
  } catch {
    return false;
  }
}

function abs(root: string, rel: string): string {
  return path.join(root, ...rel.split('/'));
}

/** 같은 폴더의 임시 파일에 쓰고 이름을 바꾼다(쓰다 끊겨도 원래 파일은 그대로) */
async function writeAtomic(target: string, data: Buffer): Promise<void> {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${crypto.randomBytes(4).toString('hex')}.wiki-radar-tmp`);
  try {
    await fsp.writeFile(tmp, data);
    await fsp.rename(tmp, target);
  } catch (err) {
    await fsp.rm(tmp, { force: true });
    throw err;
  }
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 충돌 사본 이름: `문서 (충돌 홍길동 10-13 1530).md` */
export function conflictName(rel: string, who: string, now: Date): string {
  const dir = path.posix.dirname(rel);
  const ext = path.posix.extname(rel);
  const stem = path.posix.basename(rel, ext);
  const safeWho = who.replace(/[\\/:*?"<>|]/g, '').trim() || '이름없음';
  const stamp = `${pad2(now.getMonth() + 1)}-${pad2(now.getDate())} ${pad2(now.getHours())}${pad2(now.getMinutes())}`;
  const name = `${stem} (충돌 ${safeWho} ${stamp})${ext}`;
  return dir === '.' ? name : `${dir}/${name}`;
}

/** 지우지 않고 `.휴지통\YYYY-MM-DD\상대경로` 로 옮긴다. 같은 이름이 있으면 번호를 붙인다 */
async function moveToTrash(root: string, rel: string, now: Date): Promise<void> {
  const day = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  let dest = abs(path.join(root, TRASH_DIR, day), rel);
  for (let i = 2; await exists(dest); i++) {
    const ext = path.extname(dest);
    dest = `${dest.slice(0, dest.length - ext.length).replace(/ \(\d+\)$/, '')} (${i})${ext}`;
  }
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.rename(abs(root, rel), dest);
  await removeEmptyParents(root, rel);
}

/** 파일을 옮긴 뒤 비어 버린 상위 폴더를 지운다(루트는 남긴다) */
async function removeEmptyParents(root: string, rel: string): Promise<void> {
  let dir = path.posix.dirname(rel);
  while (dir && dir !== '.') {
    try {
      await fsp.rmdir(abs(root, dir));
    } catch {
      return; // 비어 있지 않거나 못 지우면 거기서 멈춘다
    }
    dir = path.posix.dirname(dir);
  }
}

function sameStat(a: Stat | undefined, b: Stat | undefined): boolean {
  return !!a && !!b && a.size === b.size && a.mtime === b.mtime;
}

function errText(err: unknown): string {
  const code = (err as { code?: unknown })?.code;
  if (code === 'EBUSY' || code === 'EPERM') return '다른 프로그램이 쓰는 중';
  if (code === 'EACCES') return '권한 없음';
  if (code === 'ENOENT') return '그사이 사라짐';
  return typeof code === 'string' ? code : err instanceof Error ? err.message : String(err);
}

function emptyReport(state: SyncState | null): SyncReport {
  return { outcome: 'done', pulled: [], pushed: [], deletedLocal: [], deletedRemote: [], conflicts: [], skipped: [], state };
}

/** 내 PC 사본 폴더로 써도 되는가. 문제가 있으면 한국어 문장 */
export async function localFolderProblem(local: string, state: SyncState | null): Promise<string | null> {
  if (!(await exists(local))) return null;
  let entries: string[];
  try {
    entries = await fsp.readdir(local);
  } catch (err) {
    return `내 PC 위키 폴더를 읽지 못했습니다 (${errText(err)})`;
  }
  if (state || entries.length === 0 || entries.includes(LOCAL_MARKER)) return null;
  // 처음 동기화인데 아무 폴더나 가리키면 그 안의 파일이 전부 NAS 로 올라간다(예: 개인 위키)
  return '처음 동기화는 빈 폴더(또는 이 앱이 만든 팀 위키 폴더)에서만 합니다 — 다른 파일이 있는 폴더입니다';
}

/** 한 번 동기화한다. 파일 하나의 실패는 건너뛰고 다음에 다시 본다(그 파일의 기준은 바꾸지 않는다) */
export async function syncOnce(opts: SyncOptions): Promise<SyncReport> {
  const { remote, local, who, now } = opts;
  const limit = opts.largeLimit ?? DEFAULT_LARGE_LIMIT;
  let base = opts.state && opts.state.remote === remote && opts.state.local === local ? opts.state : null;

  // ---- 확인 -------------------------------------------------------------------
  let remoteOk = false;
  try {
    remoteOk = (await fsp.stat(remote)).isDirectory();
  } catch {
    remoteOk = false;
  }
  if (!remoteOk) {
    return { ...emptyReport(opts.state), outcome: 'error', message: 'NAS 팀 위키 폴더에 연결할 수 없습니다' };
  }
  const localProblem = await localFolderProblem(local, base);
  if (localProblem) return { ...emptyReport(opts.state), outcome: 'error', message: localProblem };
  await fsp.mkdir(local, { recursive: true });

  let L: Map<string, Stat>;
  let R: Map<string, Stat>;
  try {
    R = await scanTree(remote);
  } catch (err) {
    return { ...emptyReport(opts.state), outcome: 'error', message: `NAS 팀 위키를 읽지 못했습니다 (${errText(err)})` };
  }
  try {
    L = await scanTree(local);
  } catch (err) {
    return { ...emptyReport(opts.state), outcome: 'error', message: `내 PC 위키 폴더를 읽지 못했습니다 (${errText(err)})` };
  }
  const baseCount = base ? Object.keys(base.files).length : 0;
  if (baseCount > 0 && R.size === 0) {
    // NAS 가 비어 보이는 것은 연결·권한 문제일 가능성이 훨씬 크다 — 내 PC 를 지우지 않는다
    return { ...emptyReport(opts.state), outcome: 'error', message: 'NAS 팀 위키가 비어 보입니다 — 연결·권한을 확인하세요(아무것도 바꾸지 않았습니다)' };
  }
  if (baseCount > 0 && L.size === 0) {
    // 내 PC 사본을 통째로 지웠다 → 처음부터 다시 받는다(NAS 는 지우지 않는다)
    base = null;
  }
  const files = base?.files ?? {};

  // ---- 판정 -------------------------------------------------------------------
  const hashCache = new Map<string, string>();
  const hashOf = async (root: string, rel: string): Promise<string> => {
    const k = `${root}\u0000${rel}`;
    let h = hashCache.get(k);
    if (!h) {
      h = await hashFile(abs(root, rel));
      hashCache.set(k, h);
    }
    return h;
  };

  const plans: Plan[] = [];
  const skipped: SyncReport['skipped'] = [];
  const keys = new Set<string>([...L.keys(), ...R.keys(), ...Object.keys(files)]);
  for (const key of [...keys].sort()) {
    const l = L.get(key);
    const r = R.get(key);
    const b = files[key];
    const rel = r?.rel ?? l?.rel ?? b.rel;
    try {
      const lHash = l ? (b && l.size === b.size && l.mtime === b.lm ? b.hash : await hashOf(local, l.rel)) : undefined;
      const rHash = r ? (b && r.size === b.size && r.mtime === b.rm ? b.hash : await hashOf(remote, r.rel)) : undefined;
      let kind: Kind;
      if (!b) {
        if (l && r) kind = lHash === rHash ? 'adopt' : 'conflict';
        else kind = l ? 'push' : 'pull';
      } else {
        const lc = !l || lHash !== b.hash;
        const rc = !r || rHash !== b.hash;
        if (!lc && !rc) kind = 'keep';
        else if (lc && !rc) kind = l ? 'push' : 'deleteRemote';
        else if (!lc && rc) kind = r ? 'pull' : 'deleteLocal';
        else if (!l && !r) kind = 'forget';
        else if (!l) kind = 'pull';
        else if (!r) kind = 'push';
        else kind = lHash === rHash ? 'adopt' : 'conflict';
      }
      plans.push({ key, kind, rel, lHash, rHash });
    } catch (err) {
      skipped.push({ rel, reason: `읽지 못함 (${errText(err)})` });
      plans.push({ key, kind: 'carry', rel }); // 기준은 그대로 두고 다음에 다시 본다
    }
  }

  // ---- 많이 지우거나 덮어쓰면 멈춘다 ---------------------------------------------
  const risky = plans.filter(
    (p) =>
      p.kind === 'deleteLocal' ||
      p.kind === 'deleteRemote' ||
      p.kind === 'conflict' ||
      (p.kind === 'pull' && L.has(p.key)) ||
      (p.kind === 'push' && R.has(p.key)),
  );
  if (risky.length > limit && !opts.confirmLarge) {
    const deletes = risky.filter((p) => p.kind === 'deleteLocal' || p.kind === 'deleteRemote').length;
    return {
      ...emptyReport(opts.state),
      outcome: 'paused',
      skipped,
      pending: { deletes, overwrites: risky.length - deletes, sample: risky.slice(0, 8).map((p) => p.rel) },
      message: `한 번에 ${risky.length}개를 지우거나 덮어쓰게 됩니다 — 확인 후 계속하세요(아직 아무것도 바꾸지 않았습니다)`,
    };
  }

  // ---- 실행 -------------------------------------------------------------------
  const report = emptyReport(null);
  report.skipped = skipped;
  const next: Record<string, FileRec> = {};
  const record = async (rel: string, hash: string): Promise<void> => {
    const ls = await fsp.stat(abs(local, rel));
    const rs = await fsp.stat(abs(remote, rel));
    next[keyOf(rel)] = { hash, size: rs.size, lm: Math.trunc(ls.mtimeMs), rm: Math.trunc(rs.mtimeMs), rel };
  };
  /** 판정 뒤에 그쪽 파일이 또 바뀌었으면 손대지 않는다(다른 사람이 쓰는 중) */
  const unchanged = async (root: string, rel: string, before: Stat | undefined): Promise<boolean> => {
    try {
      const st = await fsp.stat(abs(root, rel));
      return sameStat(before, { rel, size: st.size, mtime: Math.trunc(st.mtimeMs) });
    } catch {
      return !before;
    }
  };
  /** src 쪽 파일을 읽어 dst 쪽에 쓴다. 읽은 내용이 판정 때와 다르면 건너뛴다 */
  const copy = async (fromRoot: string, toRoot: string, fromRel: string, toRel: string, expectHash: string | undefined): Promise<string | null> => {
    const data = await fsp.readFile(abs(fromRoot, fromRel));
    const hash = sha256(data);
    if (expectHash && hash !== expectHash) return null;
    await writeAtomic(abs(toRoot, toRel), data);
    return hash;
  };

  for (const p of plans) {
    const l = L.get(p.key);
    const r = R.get(p.key);
    try {
      switch (p.kind) {
        case 'keep':
        case 'adopt':
          await record(r!.rel, (p.rHash ?? p.lHash)!);
          if (r!.rel !== l!.rel) next[p.key].rel = r!.rel;
          break;
        case 'forget':
          break;
        case 'carry':
          if (files[p.key]) next[p.key] = files[p.key];
          break;
        case 'pull': {
          if (!(await unchanged(local, l?.rel ?? r!.rel, l))) {
            report.skipped.push({ rel: p.rel, reason: '내 PC에서 쓰는 중' });
            if (files[p.key]) next[p.key] = files[p.key];
            break;
          }
          const h = await copy(remote, local, r!.rel, l?.rel ?? r!.rel, p.rHash);
          if (!h) {
            report.skipped.push({ rel: p.rel, reason: 'NAS에서 바뀌는 중' });
            if (files[p.key]) next[p.key] = files[p.key];
            break;
          }
          await record(l?.rel ?? r!.rel, h);
          report.pulled.push(p.rel);
          break;
        }
        case 'push': {
          const target = r?.rel ?? l!.rel;
          if (!(await unchanged(remote, target, r))) {
            report.skipped.push({ rel: p.rel, reason: 'NAS에서 다른 사람이 바꾸는 중' });
            if (files[p.key]) next[p.key] = files[p.key];
            break;
          }
          const h = await copy(local, remote, l!.rel, target, p.lHash);
          if (!h) {
            report.skipped.push({ rel: p.rel, reason: '내 PC에서 쓰는 중' });
            if (files[p.key]) next[p.key] = files[p.key];
            break;
          }
          await record(target, h);
          report.pushed.push(p.rel);
          break;
        }
        case 'deleteRemote': {
          if (!(await unchanged(remote, r!.rel, r))) {
            report.skipped.push({ rel: p.rel, reason: 'NAS에서 다른 사람이 바꾸는 중' });
            next[p.key] = files[p.key];
            break;
          }
          await moveToTrash(remote, r!.rel, now);
          report.deletedRemote.push(p.rel);
          break;
        }
        case 'deleteLocal': {
          if (!(await unchanged(local, l!.rel, l))) {
            report.skipped.push({ rel: p.rel, reason: '내 PC에서 쓰는 중' });
            next[p.key] = files[p.key];
            break;
          }
          await moveToTrash(local, l!.rel, now);
          report.deletedLocal.push(p.rel);
          break;
        }
        case 'conflict': {
          // 내 PC 쪽 내용을 충돌 사본으로 양쪽에 남기고, 본문은 NAS 쪽으로 맞춘다
          let copyRel = conflictName(l!.rel, who, now);
          for (let i = 2; (await exists(abs(local, copyRel))) || (await exists(abs(remote, copyRel))); i++) {
            copyRel = conflictName(l!.rel, `${who} ${i}`, now);
          }
          const lh = await copy(local, local, l!.rel, copyRel, p.lHash);
          if (!lh) {
            report.skipped.push({ rel: p.rel, reason: '내 PC에서 쓰는 중' });
            if (files[p.key]) next[p.key] = files[p.key];
            break;
          }
          await copy(local, remote, copyRel, copyRel, lh);
          await record(copyRel, lh);
          const rh = await copy(remote, local, r!.rel, l!.rel, p.rHash);
          if (rh) await record(l!.rel, rh);
          else report.skipped.push({ rel: p.rel, reason: 'NAS에서 바뀌는 중' });
          report.conflicts.push(copyRel);
          break;
        }
      }
    } catch (err) {
      report.skipped.push({ rel: p.rel, reason: errText(err) });
      if (files[p.key]) next[p.key] = files[p.key];
    }
  }

  const marker = path.join(local, LOCAL_MARKER);
  if (!(await exists(marker))) {
    // 없을 때만 쓴다 — 매번 쓰면 내 PC 폴더 감시가 그것을 변경으로 보고 동기화를 끝없이 다시 부른다
    try {
      await fsp.writeFile(marker, '이 폴더는 wiki-radar 팀 위키 동기화 사본입니다.\n');
    } catch {
      // 표시 파일을 못 써도 동기화는 끝났다 — 다음부터는 기준 상태가 있어 처음 동기화 검사를 하지 않는다
    }
  }
  report.state = { remote, local, files: next, at: now.toISOString() };
  return report;
}
