// 2.13단계 §A-2 secrets.bin — 가짜 codec(되돌릴 수 있는 뒤섞기)으로 저장·읽기·지우기, 암호화 불가 → 메모리, 풀기 실패 → .broken-, 평문 없음.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SECRETS_BROKEN_PROBLEM, SecretStore, secretValueProblem, type SecretCodec } from '../../src/main/settings/secrets';

const dirs: string[] = [];
function tempDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-secrets-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop() as string, { recursive: true, force: true });
});

/** 가짜 암호화: 바이트마다 0x5a 를 XOR 하고 머리 'ENC1' */
const codec: SecretCodec = {
  encrypt: (text) => Buffer.concat([Buffer.from('ENC1'), Buffer.from(Buffer.from(text, 'utf8').map((b) => b ^ 0x5a))]),
  decrypt: (data) => {
    if (data.subarray(0, 4).toString() !== 'ENC1') throw new Error('풀 수 없음');
    return Buffer.from(data.subarray(4).map((b) => b ^ 0x5a)).toString('utf8');
  },
};

const PASS = 'Very-Secret-Pass-777';

describe('SecretStore', () => {
  it('저장·읽기·지우기 — 다른 인스턴스(다음 실행)에서도 읽힌다. 파일 바이트에 평문이 없다', () => {
    const dir = tempDir();
    const a = new SecretStore(dir, codec);
    expect(a.storage()).toBe('file');
    expect(a.set('mailIn.pass', PASS)).toBe('file');
    a.set('ai.llmKey', 'key-abcdef-123');
    const bytes = fs.readFileSync(path.join(dir, 'secrets.bin'));
    expect(bytes.includes(Buffer.from(PASS))).toBe(false);
    expect(bytes.toString('latin1')).not.toContain('mailIn.pass');
    const b = new SecretStore(dir, codec);
    expect(b.get('mailIn.pass')).toBe(PASS);
    expect(b.has('ai.llmKey')).toBe(true);
    expect(b.has('mailOut.pass')).toBe(false);
    b.clear('mailIn.pass');
    b.clear('ai.llmKey');
    expect(fs.existsSync(path.join(dir, 'secrets.bin'))).toBe(false);
    expect(new SecretStore(dir, codec).has('mailIn.pass')).toBe(false);
  });

  it('암호화를 쓸 수 없으면 메모리에만 — 파일을 쓰지 않는다(평문 예비 저장 없음)', () => {
    const dir = tempDir();
    const s = new SecretStore(dir, codec, { available: () => false });
    expect(s.set('mailIn.pass', PASS)).toBe('memory');
    expect(s.storage()).toBe('memory');
    expect(s.get('mailIn.pass')).toBe(PASS);
    expect(fs.readdirSync(dir)).toEqual([]);
    const none = new SecretStore(dir, null);
    expect(none.set('mailOut.pass', PASS)).toBe('memory');
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('암호화가 나중에 되면(앱 준비 뒤) 그때 파일을 읽고, 그 사이 메모리 값이 이긴다', () => {
    const dir = tempDir();
    new SecretStore(dir, codec).set('mailIn.pass', 'file-pass-000');
    let ready = false;
    const s = new SecretStore(dir, codec, { available: () => ready });
    expect(s.has('mailIn.pass')).toBe(false);
    ready = true;
    expect(s.get('mailIn.pass')).toBe('file-pass-000');
  });

  it('풀지 못하면 빈 것 + .broken-<시각> 으로 옮기고 문제를 알린다', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'secrets.bin'), Buffer.from('다른 PC 의 파일'));
    const warns: string[] = [];
    const s = new SecretStore(dir, codec, { warn: (m) => warns.push(m) });
    expect(s.has('mailIn.pass')).toBe(false);
    expect(s.loadProblem()).toBe(SECRETS_BROKEN_PROBLEM);
    expect(fs.readdirSync(dir).some((n) => n.startsWith('secrets.bin.broken-'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'secrets.bin'))).toBe(false);
    expect(warns.join('\n')).toContain('풀지 못해');
    // 다시 저장하면 문제가 사라진다
    s.set('mailIn.pass', PASS);
    expect(s.loadProblem()).toBeNull();
  });

  it('키 목록 밖·틀린 값은 읽을 때 버린다', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'secrets.bin'), codec.encrypt(JSON.stringify({ version: 1, values: { 'mailIn.pass': PASS, other: 'x-other-123', 'ai.llmKey': 'a\nb-123456' } })));
    const s = new SecretStore(dir, codec);
    expect(s.all()).toEqual([PASS]);
  });

  it('값 검사: 빈 값·너무 긴 값·제어 문자 — 문장에 값이 없다', () => {
    expect(secretValueProblem('mailIn.pass', '')).toMatch(/넣으세요/);
    expect(secretValueProblem('mailIn.pass', 'x'.repeat(257))).toMatch(/256자/);
    expect(secretValueProblem('ai.llmKey', 'x'.repeat(512))).toBeNull();
    expect(secretValueProblem('ai.llmKey', 'x'.repeat(513))).toMatch(/512자/);
    const p = secretValueProblem('mailIn.pass', 'abc\r\ndef');
    expect(p).toMatch(/쓸 수 없는/);
    expect(p).not.toContain('abc');
    const s = new SecretStore(tempDir(), codec);
    expect(() => s.set('mailIn.pass', 'bad\npass')).toThrow(/쓸 수 없는/);
  });
});
