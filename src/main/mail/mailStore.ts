// 메일 보관소(docs/stage2.15-contract.md §A-1~3 — 2026-10-20 고침). electron 을 import 하지 않는 순수 모듈이다.
//
// - 보관소: <데이터>/mail-store/raw/mail/… — 메일은 여기에만 있다. 옛 위키 raw/mail 과 같은 모양이라 메일 경로(`raw/mail/…`)·
//   색인·상태 키·위키 문서의 옛 링크가 그대로다. Radar 는 위키 raw/mail 을 읽지 않는다(2026-10-20 소유자가 옛 메일을 손으로 옮김).
// - 수집 상태 mail-collect.json: 받은 UIDL(seen)·마지막 회차.
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from '../queue';
import { errCode, stripBom } from '../wiki/fsutil';

export const MAIL_STORE_DIR = 'mail-store';
export const MAIL_COLLECT_FILE = 'mail-collect.json';
export const MAIL_RULES_FILE = 'mail-rules.txt';
/** 위키 쪽 수집기 파일(볼트 기준, 읽기만) */
export const WIKI_INGEST_STATE = '_mail-ingest/state.json';
export const WIKI_INGEST_RULES = '_mail-ingest/rules.txt';

/** 보관소 기준 폴더(그 안에 raw/mail) */
export function mailStoreBase(dataDir: string): string {
  return path.join(dataDir, MAIL_STORE_DIR);
}

export function storeMailRoot(dataDir: string): string {
  return path.join(mailStoreBase(dataDir), 'raw', 'mail');
}

export function wikiMailRoot(wikiRoot: string): string {
  return path.join(path.resolve(wikiRoot), 'raw', 'mail');
}

export function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// ---- 수집 상태 -----------------------------------------------------------------------------

export interface MailCollectFile {
  version: 1;
  seen: string[];
  /** 처음 수집을 켠 날(YYYY-MM-DD — firstDate 기본값의 기준) */
  firstOn?: string;
  /** 위키 수집기의 받은 기록·분류 규칙을 이어받은 때 */
  adoptedAt?: string;
  lastRun?: string;
  lastOk?: string;
  lastCount?: number;
  lastError?: string;
}

function isStrArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

export class MailCollectState {
  private readonly file: string;
  private data: MailCollectFile;
  private seenSet: Set<string>;

  constructor(dataDir: string, private readonly warn: (m: string) => void = () => {}) {
    this.file = path.join(dataDir, MAIL_COLLECT_FILE);
    this.data = this.load();
    this.seenSet = new Set(this.data.seen);
  }

  private load(): MailCollectFile {
    let text: string;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (errCode(err) !== 'ENOENT') this.warn(`${MAIL_COLLECT_FILE} 를 읽지 못함(${errCode(err)}) — 새로 시작`);
      return { version: 1, seen: [] };
    }
    try {
      const raw = JSON.parse(stripBom(text)) as Partial<MailCollectFile>;
      if (!raw || typeof raw !== 'object') throw new Error('객체 아님');
      const out: MailCollectFile = { version: 1, seen: isStrArray(raw.seen) ? raw.seen : [] };
      for (const k of ['firstOn', 'adoptedAt', 'lastRun', 'lastOk', 'lastError'] as const) if (typeof raw[k] === 'string') out[k] = raw[k];
      if (typeof raw.lastCount === 'number') out.lastCount = raw.lastCount;
      return out;
    } catch (err) {
      // 깨진 파일은 옆에 남기고 새로 — seen 을 잃으면 서버 메일을 다시 받지만 같은 파일 이름이라 덮어쓰지 않는다
      try {
        fs.copyFileSync(this.file, `${this.file}.broken-${Date.now()}`);
      } catch {
        // 남기기 실패는 무시
      }
      this.warn(`${MAIL_COLLECT_FILE} 가 깨져 새로 시작함(옆에 사본을 남김): ${err instanceof Error ? err.message : String(err)}`);
      return { version: 1, seen: [] };
    }
  }

  get(): Readonly<MailCollectFile> {
    return this.data;
  }

  hasSeen(uid: string): boolean {
    return this.seenSet.has(uid);
  }

  seenCount(): number {
    return this.seenSet.size;
  }

  addSeen(uids: Iterable<string>): number {
    let n = 0;
    for (const u of uids) {
      if (typeof u !== 'string' || u === '' || this.seenSet.has(u)) continue;
      this.seenSet.add(u);
      n++;
    }
    return n;
  }

  update(patch: Partial<Omit<MailCollectFile, 'version' | 'seen'>>): void {
    this.data = { ...this.data, ...patch };
  }

  save(): void {
    this.data.seen = [...this.seenSet].sort();
    writeJsonAtomic(this.file, this.data);
  }
}

/** 메일함에 주는 기준 폴더 목록 — 앱 데이터 메일 보관소 하나 */
export function mailBaseList(dataDir: string): string[] {
  return [mailStoreBase(dataDir)];
}

/** 위키 수집기 state.json 의 seen(받은 UIDL). 없거나 깨졌으면 [] */
export function readWikiSeen(wikiRoot: string): string[] {
  try {
    const raw = JSON.parse(stripBom(fs.readFileSync(path.join(wikiRoot, ...WIKI_INGEST_STATE.split('/')), 'utf8'))) as { seen?: unknown };
    return isStrArray(raw.seen) ? raw.seen : [];
  } catch {
    return [];
  }
}

/** 분류 규칙 글: 앱 데이터 mail-rules.txt → 위키 _mail-ingest/rules.txt → 없음('') */
export function readRulesText(dataDir: string, wikiRoot: string | null): { text: string; from: 'app' | 'wiki' | 'none' } {
  try {
    return { text: fs.readFileSync(path.join(dataDir, MAIL_RULES_FILE), 'utf8'), from: 'app' };
  } catch {
    // 다음
  }
  if (wikiRoot) {
    try {
      return { text: fs.readFileSync(path.join(wikiRoot, ...WIKI_INGEST_RULES.split('/')), 'utf8'), from: 'wiki' };
    } catch {
      // 다음
    }
  }
  return { text: '', from: 'none' };
}

/** 위키 rules.txt 를 앱 데이터로(없을 때만 — 파일 하나). 옮겼으면 true */
export function adoptWikiRules(dataDir: string, wikiRoot: string): boolean {
  const to = path.join(dataDir, MAIL_RULES_FILE);
  if (fs.existsSync(to)) return false;
  const from = path.join(wikiRoot, ...WIKI_INGEST_RULES.split('/'));
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
    return true;
  } catch {
    return false;
  }
}
