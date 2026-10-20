// 비밀 저장소(<데이터 폴더>/secrets.bin — 2.13단계 명세 §A-2). electron 을 import 하지 않는다(암호화는 주입).
//
// - 내용: codec.encrypt(JSON.stringify({ version: 1, values: { [key]: string } })). 키는 SECRET_KEYS 셋만 — 그 밖은 읽을 때 버린다.
// - codec 은 VocSessionStore 와 같은 꼴 — main 이 Electron safeStorage 로 만든다(쓸 수 없으면 encrypt 가 던진다).
// - 암호화를 쓸 수 없으면 파일에 쓰지 않고 메모리에만 둔다(storage()='memory'). 평문 예비 저장은 하지 않는다.
// - 풀지 못하면(다른 Windows 계정·다른 PC 에서 가져온 파일·깨짐) 빈 것으로 보고 secrets.bin.broken-<시각> 으로 옮긴다(loadProblem).
// - 값은 get() 으로 main 안에서만 꺼낸다(연결·발송 때). 어떤 IPC 응답·로그·오류 문장에도 넣지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import type { SecretKey } from '../../shared/types';
import { setAsideBroken, writeFileAtomic } from '../queue';
import { errCode } from '../wiki/fsutil';

export const SECRETS_FILE = 'secrets.bin';
export const SECRET_KEYS: readonly SecretKey[] = ['mailIn.pass', 'mailOut.pass', 'ai.llmKey'];
/** 값 한도: 비밀번호 256자, 키 512자 */
const SECRET_MAX: Readonly<Record<SecretKey, number>> = { 'mailIn.pass': 256, 'mailOut.pass': 256, 'ai.llmKey': 512 };
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

export const SECRETS_BROKEN_PROBLEM = '저장된 비밀번호를 읽지 못했습니다 — 설정에서 다시 넣으세요';

/** 암호화(main 이 safeStorage 로 만든다) */
export interface SecretCodec {
  encrypt(text: string): Buffer;
  decrypt(data: Buffer): string;
}

export function isSecretKey(value: unknown): value is SecretKey {
  return typeof value === 'string' && (SECRET_KEYS as readonly string[]).includes(value);
}

/** 비밀 값 검사. 문제가 있으면 한국어 문장(값은 문장에 넣지 않는다) */
export function secretValueProblem(key: SecretKey, value: unknown): string | null {
  const what = key === 'ai.llmKey' ? '키' : '비밀번호';
  if (typeof value !== 'string' || value === '') return `${what}를 넣으세요`;
  if (value.length > SECRET_MAX[key]) return `${what}가 너무 깁니다(${SECRET_MAX[key]}자까지)`;
  if (CONTROL_RE.test(value)) return `${what}에 쓸 수 없는 글자(줄바꿈·제어 문자)가 있습니다`;
  return null;
}

export interface SecretStoreOptions {
  /** 암호화를 지금 쓸 수 있는가(safeStorage.isEncryptionAvailable). 없으면 codec 이 있으면 참 */
  available?: () => boolean;
  warn?: (message: string) => void;
}

export class SecretStore {
  readonly file: string;
  private values = new Map<SecretKey, string>();
  private loaded = false;
  /** 마지막 쓰기가 파일까지 갔는가(아니면 메모리에만) */
  private persisted = true;
  private problem: string | null = null;

  constructor(
    dataDirOrFile: string,
    private readonly codec: SecretCodec | null,
    private readonly opts: SecretStoreOptions = {},
  ) {
    this.file = dataDirOrFile.toLowerCase().endsWith('.bin') ? dataDirOrFile : path.join(dataDirOrFile, SECRETS_FILE);
  }

  private canEncrypt(): boolean {
    if (!this.codec) return false;
    try {
      return this.opts.available ? this.opts.available() : true;
    } catch {
      return false;
    }
  }

  /** file = secrets.bin 에 암호화해 둠 · memory = 이번 실행 동안만 */
  storage(): 'file' | 'memory' {
    this.load();
    return this.canEncrypt() && this.persisted ? 'file' : 'memory';
  }

  /** 파일을 풀지 못해 옮겼으면 그 문장(점검 줄) */
  loadProblem(): string | null {
    this.load();
    return this.problem;
  }

  has(key: SecretKey): boolean {
    this.load();
    return this.values.has(key);
  }

  /** main 안에서만(연결·발송 때). 없으면 undefined */
  get(key: SecretKey): string | undefined {
    this.load();
    return this.values.get(key);
  }

  /** 비교용 — 저장된 값 전부(knownSecrets) */
  all(): string[] {
    this.load();
    return [...this.values.values()];
  }

  /** 검사 후 저장. 틀리면 한국어 Error(값은 넣지 않는다) */
  set(key: SecretKey, value: string): 'file' | 'memory' {
    if (!isSecretKey(key)) throw new Error('잘못된 요청입니다: 비밀 키');
    const problem = secretValueProblem(key, value);
    if (problem) throw new Error(problem);
    this.load();
    this.values.set(key, value);
    return this.persist();
  }

  clear(key: SecretKey): 'file' | 'memory' {
    this.load();
    if (!this.values.delete(key)) return this.storage();
    return this.persist();
  }

  private load(): void {
    if (this.loaded) return;
    // 암호화를 (아직) 쓸 수 없으면 파일을 건드리지 않는다 — 앱 준비 전일 수 있어 다음에 다시 본다(그 사이 메모리에 넣은 값이 이긴다)
    if (!this.canEncrypt() || !this.codec) return;
    this.loaded = true;
    const inMemory = new Map(this.values);
    let data: Buffer;
    try {
      data = fs.readFileSync(this.file);
    } catch (err) {
      if (errCode(err) !== 'ENOENT') this.opts.warn?.(`비밀 저장소(${SECRETS_FILE})를 읽지 못했습니다 (${errCode(err)})`);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(this.codec.decrypt(data));
    } catch {
      parsed = undefined;
    }
    const values = parsed && typeof parsed === 'object' ? (parsed as { version?: unknown; values?: unknown }) : null;
    if (!values || values.version !== 1 || !values.values || typeof values.values !== 'object' || Array.isArray(values.values)) {
      const moved = setAsideBroken(this.file, 'move');
      this.problem = SECRETS_BROKEN_PROBLEM;
      this.opts.warn?.(
        `비밀 저장소(${SECRETS_FILE})를 풀지 못해 비운 채 시작합니다` + (moved ? ` — 원래 파일은 ${path.basename(moved)}` : ''),
      );
      return;
    }
    for (const [key, value] of Object.entries(values.values as Record<string, unknown>)) {
      if (isSecretKey(key) && typeof value === 'string' && secretValueProblem(key, value) === null && !inMemory.has(key)) this.values.set(key, value);
    }
  }

  private persist(): 'file' | 'memory' {
    if (!this.canEncrypt() || !this.codec) {
      this.persisted = false;
      return 'memory';
    }
    const body: Record<string, string> = {};
    for (const key of SECRET_KEYS) {
      const v = this.values.get(key);
      if (v !== undefined) body[key] = v;
    }
    try {
      if (Object.keys(body).length === 0) {
        fs.rmSync(this.file, { force: true });
      } else {
        writeFileAtomic(this.file, this.codec.encrypt(JSON.stringify({ version: 1, values: body })));
      }
      this.persisted = true;
      this.problem = null;
      return 'file';
    } catch (err) {
      // 파일에 남기지 못했다 — 이번 실행 동안은 메모리 값으로 쓰고, 옛 파일(지운 비밀이 남은)은 지운다
      this.persisted = false;
      this.opts.warn?.(`비밀 저장소(${SECRETS_FILE})에 쓰지 못해 이번 실행 동안만 기억합니다 (${errCode(err) || '암호화 실패'})`);
      try {
        fs.rmSync(this.file, { force: true });
      } catch {
        // 지우지도 못하면 다음 실행에서 옛 값이 보인다 — 사람이 다시 저장한다
      }
      return 'memory';
    }
  }
}
