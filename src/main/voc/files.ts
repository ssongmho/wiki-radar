// VOC 첨부 받기(명세 §14): voc-cli `file download` 결과 확인·이미지 data URL·열기 전 검사. electron 을 import 하지 않는다.
//
// - 받는 곳은 앱 데이터 폴더의 voc-files/<ticketId>/ 뿐이다(cli.ts vocDownloadProblem 이 인자를, 여기서 결과 경로를 한 번 더 본다).
// - 파일 이름은 voc-cli 가 거른 것 그대로 쓴다(경로 조각·예약 이름·금지 글자를 voc-cli 가 바꾼다). 앱은 그 이름으로 다시 만들지 않고
//   voc-cli 가 알려 준 경로가 그 폴더 바로 아래인지·크기가 맞는지만 본다. 맞지 않으면 지운다.
// - 이미지는 확장자가 아니라 파일 머리(매직 바이트)로 형식을 정한다. SVG 는 받지 않는다(스크립트를 품을 수 있다).
// - 열기(shell.openPath)는 허용 확장자(VOC_OPEN_EXTS)만. 그 밖은 폴더에서 보기만 — ipc.ts 가 이 모듈의 판정으로 고른다.
import fs from 'node:fs';
import path from 'node:path';
import { VOC_IMAGE_MAX_BYTES, vocCanOpenFile } from '../../shared/voc';

/** voc-cli 가 알려 준 내려받기 결과 */
export interface VocDownloadOutput {
  path: string;
  filename: string;
  size: number;
}

/** 확인을 마친 내려받은 파일 */
export interface VocDownloadedFile {
  /** 절대경로 */
  path: string;
  /** voc-cli 가 거른 저장 이름(경로의 마지막 조각) */
  fileName: string;
  size: number;
}

/** 티켓의 첨부 폴더: <root>/<ticketId> */
export function ticketFilesDir(root: string, ticketId: number): string {
  return path.join(root, String(ticketId));
}

/** 같은 경로인가(Windows 는 대소문자 무시) */
function samePath(a: string, b: string): boolean {
  const x = path.resolve(a);
  const y = path.resolve(b);
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/** root 아래(같은 곳은 아님)인가 */
export function isInside(root: string, p: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(p));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** `file download --json` 표준출력 → {path, filename, size}. 형식이 틀리면 한국어 Error */
export function parseDownloadOutput(stdout: string): VocDownloadOutput {
  let v: unknown;
  try {
    v = JSON.parse(stdout.replace(/^﻿/, '').trim());
  } catch {
    throw new Error('VOC file download 응답을 읽지 못했습니다');
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('VOC file download 응답 형식이 맞지 않습니다');
  const r = v as Record<string, unknown>;
  if (typeof r.path !== 'string' || r.path.trim() === '') throw new Error('VOC file download 응답에 경로가 없습니다');
  const size = typeof r.size === 'number' ? r.size : Number.NaN;
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('VOC file download 응답에 크기가 없습니다');
  return { path: r.path.trim(), filename: typeof r.filename === 'string' ? r.filename : '', size };
}

/** 지운다(실패는 무시 — 다음 받기가 덮는다) */
function removeQuietly(p: string): void {
  try {
    fs.rmSync(p, { force: true });
  } catch {
    // 지우지 못해도 결과는 이미 실패다
  }
}

/**
 * 내려받은 파일 확인: 경로가 dir 바로 아래 · 보통 파일(바로가기·링크 아님) · 실제 크기 = voc-cli 가 알린 크기 = 첨부 목록의 크기(알면).
 * 맞지 않으면 파일을 지우고 한국어 Error
 */
export function checkDownloaded(out: VocDownloadOutput, dir: string, expectedSize?: number): VocDownloadedFile {
  const abs = path.resolve(out.path);
  if (!samePath(path.dirname(abs), dir)) {
    // 폴더 밖이면 지우지도 않는다(앱이 만든 파일이 아닐 수 있다)
    throw new Error('VOC 가 알려 준 저장 위치가 첨부 폴더 밖입니다 — 받지 않았습니다');
  }
  let st: fs.Stats;
  try {
    st = fs.lstatSync(abs);
  } catch {
    throw new Error('내려받은 파일을 찾지 못했습니다');
  }
  if (!st.isFile()) {
    throw new Error('내려받은 것이 보통 파일이 아닙니다 — 받지 않았습니다');
  }
  if (st.size !== out.size || (expectedSize !== undefined && st.size !== expectedSize)) {
    removeQuietly(abs);
    const want = expectedSize ?? out.size;
    throw new Error(`내려받은 파일 크기가 맞지 않아 지웠습니다(받은 ${st.size}바이트 · 기대 ${want}바이트) — 다시 받아 보세요`);
  }
  return { path: abs, fileName: path.basename(abs), size: st.size };
}

/**
 * 인터넷에서 받은 파일 표시(Mark of the Web — NTFS 대체 데이터 스트림 Zone.Identifier, ZoneId=3)를 붙인다. voc-cli 는 붙이지 않는다 —
 * 붙여 두면 Office·한글이 [열기]한 문서를 제한된 보기(매크로 꺼짐)로 연다. Windows 밖이거나 붙이지 못하면(FAT·권한) 조용히 넘어간다
 */
export function markFromInternet(file: string): void {
  if (process.platform !== 'win32') return;
  try {
    fs.writeFileSync(`${file}:Zone.Identifier`, '[ZoneTransfer]\r\nZoneId=3\r\n', 'utf8');
  } catch {
    // 표시는 덤이다 — 열기 허용 확장자 검사는 그대로 막는다
  }
}

/** 파일 머리로 정한 이미지 형식(png·jpeg·gif·webp·bmp). 아니면 null */
export function imageMimeOf(head: Uint8Array): string | null {
  const at = (i: number): number => (i < head.length ? head[i] : -1);
  const ascii = (from: number, text: string): boolean => [...text].every((c, i) => at(from + i) === c.charCodeAt(0));
  if (at(0) === 0x89 && ascii(1, 'PNG') && at(4) === 0x0d && at(5) === 0x0a && at(6) === 0x1a && at(7) === 0x0a) return 'image/png';
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg';
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return 'image/gif';
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp';
  if (ascii(0, 'BM') && head.length >= 26) return 'image/bmp';
  return null;
}

/** 이미지 파일 → data URL(10MB 이하·머리가 이미지일 때만). 아니면 한국어 Error */
export function imageDataUrl(file: VocDownloadedFile): string {
  if (file.size > VOC_IMAGE_MAX_BYTES) throw new Error('이미지가 10MB 를 넘어 앱 안에서 보지 않습니다 — 내려받아 보세요');
  const bytes = fs.readFileSync(file.path);
  if (bytes.length !== file.size) throw new Error('이미지를 읽는 사이 크기가 바뀌었습니다 — 다시 받아 보세요');
  const mime = imageMimeOf(bytes.subarray(0, 32));
  if (!mime) throw new Error('이미지 형식(png·jpg·gif·webp·bmp)이 아니라 앱 안에서 보지 않습니다');
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

/**
 * 열기·폴더에서 보기 전 검사: root 아래 · 지금도 있는 보통 파일 · (열기면) 허용 확장자. 맞으면 절대경로, 아니면 한국어 Error
 */
export function checkOpenable(root: string, file: VocDownloadedFile, how: 'open' | 'reveal'): string {
  const abs = path.resolve(file.path);
  if (!isInside(root, abs)) throw new Error('첨부 폴더 밖의 파일은 열지 않습니다');
  let st: fs.Stats;
  try {
    st = fs.lstatSync(abs);
  } catch {
    throw new Error('내려받은 파일이 없습니다 — 다시 내려받으세요');
  }
  if (!st.isFile()) throw new Error('보통 파일이 아니라 열지 않습니다');
  if (st.size !== file.size) throw new Error('내려받은 뒤 파일이 바뀌었습니다 — 다시 내려받으세요');
  if (how === 'open' && !vocCanOpenFile(path.basename(abs))) {
    throw new Error('이 형식은 앱에서 열지 않습니다 — 폴더에서 보기로 확인하세요');
  }
  return abs;
}
