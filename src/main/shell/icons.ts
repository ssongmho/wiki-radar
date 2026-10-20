// 트레이 아이콘·작업 표시줄 오버레이를 코드로 그린다(2.12단계 명세 §1-1·§2): RGBA 픽셀 → PNG(node:zlib deflate + CRC32).
// electron 없음 — 순수 함수라 픽셀을 단위 시험으로 본다. 저장소에 이미지 파일을 두지 않는다(상태 넷 × 크기 넷 × 밝음/어두움을 손으로 관리하지 않게).
import zlib from 'node:zlib';
import type { TrayLevel } from '../../shared/types';

export type Rgb = readonly [number, number, number];

function hex(h: string): Rgb {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** 1단계 §6 토큰 */
export const COLORS = {
  coral: hex('#f2735f'),
  amber: hex('#f2b04a'),
  neutral: hex('#e6edf3'),
  /** 어두운 작업 표시줄의 글리프 */
  glyphDark: hex('#c9d6e2'),
  /** 밝은 작업 표시줄의 글리프 */
  glyphLight: hex('#3a4a5a'),
  /** 점·배지를 글리프와 떼는 테두리 */
  borderDark: hex('#14202b'),
  borderLight: hex('#ffffff'),
  white: hex('#ffffff'),
} as const;

/** 트레이 크기와 DPI 배율(100%·125%·150%·200%) */
export const TRAY_SIZES: readonly { size: number; scale: number }[] = [
  { size: 16, scale: 1 },
  { size: 20, scale: 1.25 },
  { size: 24, scale: 1.5 },
  { size: 32, scale: 2 },
];

/** 오버레이 크기와 배율 */
export const OVERLAY_SIZES: readonly { size: number; scale: number }[] = [
  { size: 16, scale: 1 },
  { size: 32, scale: 2 },
];

/** RGBA 캔버스(투명으로 시작) */
export class Canvas {
  readonly data: Uint8Array;

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.data = new Uint8Array(width * height * 4);
  }

  /** (x, y) 픽셀 RGBA */
  pixel(x: number, y: number): [number, number, number, number] {
    const i = (y * this.width + x) * 4;
    return [this.data[i], this.data[i + 1], this.data[i + 2], this.data[i + 3]];
  }

  /** 색을 alpha(0~1) 만큼 위에 얹는다(source-over) */
  blend(x: number, y: number, color: Rgb, alpha: number): void {
    if (alpha <= 0 || x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const a = Math.min(1, alpha);
    const i = (y * this.width + x) * 4;
    const da = this.data[i + 3] / 255;
    const oa = a + da * (1 - a);
    for (let c = 0; c < 3; c++) {
      const v = oa === 0 ? 0 : (color[c] * a + this.data[i + c] * da * (1 - a)) / oa;
      this.data[i + c] = Math.round(v);
    }
    this.data[i + 3] = Math.round(oa * 255);
  }

  /** 모양(연속 좌표 판정)을 4×4 표본으로 덮인 만큼 칠한다 */
  fill(inside: (x: number, y: number) => boolean, color: Rgb): void {
    const S = 4;
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        let hit = 0;
        for (let sy = 0; sy < S; sy++) {
          for (let sx = 0; sx < S; sx++) {
            if (inside(x + (sx + 0.5) / S, y + (sy + 0.5) / S)) hit++;
          }
        }
        if (hit > 0) this.blend(x, y, color, hit / (S * S));
      }
    }
  }
}

const circle = (cx: number, cy: number, r: number) => (x: number, y: number) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;

function segment(ax: number, ay: number, bx: number, by: number, half: number) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  return (x: number, y: number): boolean => {
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2));
    const px = ax + t * dx - x;
    const py = ay + t * dy - y;
    return px * px + py * py <= half * half;
  };
}

/** 오른쪽 아래 배지(점)의 중심·반지름(테두리 포함) */
export function badgeGeometry(size: number): { cx: number; cy: number; r: number } {
  const r = Math.max(3, Math.round(size * 0.27));
  return { cx: size - r, cy: size - r, r };
}

/** 기본 글리프: 관제 스코프 — 원 테두리 + 중심 점 + 1시 방향 스윕 선 */
function drawGlyph(cv: Canvas, color: Rgb): void {
  const size = cv.width;
  const c = size / 2;
  const t = Math.max(1.25, size / 11);
  const R = size / 2 - 0.5;
  const rin = R - t;
  cv.fill((x, y) => {
    const d2 = (x - c) ** 2 + (y - c) ** 2;
    return d2 <= R * R && d2 >= rin * rin;
  }, color);
  cv.fill(circle(c, c, Math.max(1, size * 0.1)), color);
  // 1시 방향 = 12시에서 시계 방향 30도
  const ang = Math.PI / 6;
  const len = rin - t * 0.3;
  cv.fill(segment(c, c, c + Math.sin(ang) * len, c - Math.cos(ang) * len, t / 2), color);
}

/** 배지: 테두리 원 + 속 원(+ 문제면 느낌표) */
function drawBadge(cv: Canvas, fillColor: Rgb, border: Rgb, bang: boolean): void {
  const { cx, cy, r } = badgeGeometry(cv.width);
  // 테두리 자리의 글리프를 먼저 지운다(투명) — 테두리가 투명 위에 또렷하게
  for (let y = 0; y < cv.height; y++) {
    for (let x = 0; x < cv.width; x++) {
      if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= (r + 0.5) ** 2) {
        const i = (y * cv.width + x) * 4;
        cv.data[i] = cv.data[i + 1] = cv.data[i + 2] = cv.data[i + 3] = 0;
      }
    }
  }
  cv.fill(circle(cx, cy, r), border);
  cv.fill(circle(cx, cy, r - 1), fillColor);
  if (bang) {
    const ink = COLORS.borderDark;
    const w = Math.max(0.6, r * 0.22);
    cv.fill(segment(cx, cy - r * 0.55, cx, cy + r * 0.05, w), ink);
    cv.fill(circle(cx, cy + r * 0.45, Math.max(0.6, r * 0.16)), ink);
  }
}

/** 트레이 아이콘 픽셀. dark: 어두운 작업 표시줄(Windows 기본) */
export function trayIconCanvas(level: TrayLevel, size: number, dark: boolean): Canvas {
  const cv = new Canvas(size, size);
  drawGlyph(cv, dark ? COLORS.glyphDark : COLORS.glyphLight);
  const border = dark ? COLORS.borderDark : COLORS.borderLight;
  if (level === 'urgent') drawBadge(cv, COLORS.coral, border, false);
  else if (level === 'today') drawBadge(cv, COLORS.amber, border, false);
  else if (level === 'problem') drawBadge(cv, COLORS.neutral, border, true);
  return cv;
}

// ---- 오버레이 숫자(3×5 비트맵 글꼴) ---------------------------------------------------

const FONT: Record<string, readonly string[]> = {
  '0': ['111', '101', '101', '101', '111'],
  '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'],
  '7': ['111', '001', '001', '001', '001'],
  '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111'],
  '+': ['000', '010', '111', '010', '000'],
};

/** 오버레이 글자의 픽셀 상자(시험이 원 안인지 본다) */
export function overlayTextBox(text: string, size: number): { x: number; y: number; width: number; height: number; scale: number } {
  const scale = size >= 32 ? 2 : 1;
  const width = (text.length * 3 + (text.length - 1)) * scale;
  const height = 5 * scale;
  return { x: Math.floor((size - width) / 2), y: Math.floor((size - height) / 2), width, height, scale };
}

/** 작업 표시줄 오버레이: 코랄 원에 흰 숫자(1~9, 10 이상은 9+) */
export function overlayCanvas(text: string, size: number): Canvas {
  const cv = new Canvas(size, size);
  cv.fill(circle(size / 2, size / 2, size / 2), COLORS.coral);
  const box = overlayTextBox(text, size);
  let x0 = box.x;
  for (const ch of text) {
    const rows = FONT[ch];
    if (rows) {
      rows.forEach((row, ry) => {
        for (let rx = 0; rx < 3; rx++) {
          if (row[rx] !== '1') continue;
          for (let sy = 0; sy < box.scale; sy++) {
            for (let sx = 0; sx < box.scale; sx++) cv.blend(x0 + rx * box.scale + sx, box.y + ry * box.scale + sy, COLORS.white, 1);
          }
        }
      });
    }
    x0 += 4 * box.scale;
  }
  return cv;
}

// ---- PNG ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), Buffer.from(data)]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** RGBA 캔버스 → PNG(8비트 RGBA, 필터 없음) */
export function encodePng(cv: Canvas): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(cv.width, 0);
  ihdr.writeUInt32BE(cv.height, 4);
  ihdr[8] = 8; // 비트 깊이
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const stride = cv.width * 4;
  const raw = Buffer.alloc((stride + 1) * cv.height);
  for (let y = 0; y < cv.height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(cv.data.buffer, cv.data.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  return Buffer.concat([PNG_SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', new Uint8Array(0))]);
}

export function pngDataUrl(png: Buffer): string {
  return `data:image/png;base64,${png.toString('base64')}`;
}

/** 트레이 아이콘 네 장(배율별 dataURL) */
export function trayIconSet(level: TrayLevel, dark: boolean): { scale: number; dataURL: string }[] {
  return TRAY_SIZES.map(({ size, scale }) => ({ scale, dataURL: pngDataUrl(encodePng(trayIconCanvas(level, size, dark))) }));
}

/** 오버레이 두 장(배율별 dataURL) */
export function overlayIconSet(text: string): { scale: number; dataURL: string }[] {
  return OVERLAY_SIZES.map(({ size, scale }) => ({ scale, dataURL: pngDataUrl(encodePng(overlayCanvas(text, size))) }));
}
