// 코드로 그린 아이콘(2.12단계 명세 §1-1·§2·§12-1): PNG 서명·IHDR 크기·CRC 가 맞음(직접 푼다 — zlib.inflateSync) ·
// 단계별 오른쪽 아래 배지 색(코랄·앰버·중립) · 평소엔 배지 없음 · 밝음/어두움 글리프 색 · 오버레이 숫자 1~9·9+ 의 픽셀이 원 안.
import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  COLORS,
  PNG_SIGNATURE,
  TRAY_SIZES,
  badgeGeometry,
  crc32,
  encodePng,
  overlayCanvas,
  overlayIconSet,
  overlayTextBox,
  trayIconCanvas,
  trayIconSet,
  type Canvas,
  type Rgb,
} from '../../src/main/shell/icons';
import type { TrayLevel } from '../../src/shared/types';

/** PNG 을 직접 푼다: 청크 CRC 를 확인하고 IHDR 크기와 RGBA 픽셀을 돌려준다 */
function decodePng(png: Buffer): { width: number; height: number; rgba: Buffer } {
  expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
  let off = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  const types: string[] = [];
  while (off < png.length) {
    const len = png.readUInt32BE(off);
    const type = png.subarray(off + 4, off + 8).toString('ascii');
    const data = png.subarray(off + 8, off + 8 + len);
    const crc = png.readUInt32BE(off + 8 + len);
    expect(crc32(png.subarray(off + 4, off + 8 + len))).toBe(crc);
    types.push(type);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      expect([...data.subarray(8)]).toEqual([8, 6, 0, 0, 0]);
    }
    if (type === 'IDAT') idat.push(data);
    off += 12 + len;
  }
  expect(types[0]).toBe('IHDR');
  expect(types[types.length - 1]).toBe('IEND');
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const rgba = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    expect(raw[y * (stride + 1)]).toBe(0);
    raw.copy(rgba, y * stride, y * (stride + 1) + 1, (y + 1) * (stride + 1));
  }
  return { width, height, rgba };
}

const rgbOf = (cv: Canvas, x: number, y: number): Rgb => cv.pixel(x, y).slice(0, 3) as unknown as Rgb;

describe('PNG 굽기', () => {
  it('서명·IHDR·CRC 가 맞고, 푼 픽셀이 캔버스와 같다', () => {
    for (const { size } of TRAY_SIZES) {
      const cv = trayIconCanvas('urgent', size, true);
      const { width, height, rgba } = decodePng(encodePng(cv));
      expect([width, height]).toEqual([size, size]);
      expect(rgba.equals(Buffer.from(cv.data))).toBe(true);
    }
    expect(crc32(Buffer.from('IEND', 'ascii'))).toBe(0xae426082);
  });

  it('트레이는 배율 넷(1·1.25·1.5·2), 오버레이는 둘(1·2) — dataURL 은 PNG', () => {
    const set = trayIconSet('today', false);
    expect(set.map((s) => s.scale)).toEqual([1, 1.25, 1.5, 2]);
    for (const s of set) expect(s.dataURL.startsWith('data:image/png;base64,')).toBe(true);
    const ov = overlayIconSet('9+');
    expect(ov.map((s) => s.scale)).toEqual([1, 2]);
    expect(decodePng(Buffer.from(ov[1].dataURL.split(',')[1], 'base64')).width).toBe(32);
  });
});

describe('트레이 아이콘 픽셀(§1-1)', () => {
  const center = (size: number) => {
    const { cx, cy } = badgeGeometry(size);
    return [Math.floor(cx), Math.floor(cy)] as const;
  };

  it('단계별 오른쪽 아래 배지: 긴급 코랄 · 오늘 앰버 · 문제 중립(+ 어두운 느낌표) · 평소엔 배지 없음', () => {
    for (const { size } of TRAY_SIZES) {
      const [x, y] = center(size);
      expect(rgbOf(trayIconCanvas('urgent', size, true), x, y)).toEqual(COLORS.coral);
      expect(rgbOf(trayIconCanvas('today', size, true), x, y)).toEqual(COLORS.amber);
      const problem = trayIconCanvas('problem', size, true);
      const { cx, cy, r } = badgeGeometry(size);
      // 배지 속(테두리 안)에 중립 색 픽셀이 있고, 코랄·앰버는 없다
      let neutral = 0;
      for (let py = 0; py < size; py++) {
        for (let px = 0; px < size; px++) {
          if ((px + 0.5 - cx) ** 2 + (py + 0.5 - cy) ** 2 > (r - 1) ** 2) continue;
          const c = rgbOf(problem, px, py);
          if (c.join() === COLORS.neutral.join()) neutral++;
          expect(c).not.toEqual(COLORS.coral);
        }
      }
      expect(neutral).toBeGreaterThan(0);
      // 느낌표 막대 자리는 어두운 잉크가 섞인다(중립보다 어둡다)
      const bang = problem.pixel(Math.floor(cx), Math.floor(cy - r * 0.3));
      expect(bang[0]).toBeLessThan(COLORS.neutral[0]);
      // 평소: 배지 자리에 코랄·앰버·중립이 없다
      const normal = trayIconCanvas('normal' as TrayLevel, size, true);
      for (const c of [COLORS.coral, COLORS.amber, COLORS.neutral]) expect(rgbOf(normal, x, y)).not.toEqual(c);
    }
  });

  it('글리프 색: 어두운 작업 표시줄 #c9d6e2, 밝은 작업 표시줄 #3a4a5a(중심 점)', () => {
    for (const { size } of TRAY_SIZES) {
      const c = Math.floor(size / 2);
      expect(rgbOf(trayIconCanvas('normal', size, true), c, c)).toEqual(COLORS.glyphDark);
      expect(rgbOf(trayIconCanvas('normal', size, false), c, c)).toEqual(COLORS.glyphLight);
    }
  });

  it('배지 테두리: 어두우면 #14202b, 밝으면 #ffffff', () => {
    const size = 32;
    const { cx, cy, r } = badgeGeometry(size);
    // 배지 맨 위 테두리(중심 위로 r-0.5)
    const y = Math.floor(cy - r + 0.5);
    expect(rgbOf(trayIconCanvas('urgent', size, true), Math.floor(cx), y)).toEqual(COLORS.borderDark);
    expect(rgbOf(trayIconCanvas('urgent', size, false), Math.floor(cx), y)).toEqual(COLORS.borderLight);
  });
});

describe('작업 표시줄 오버레이(§2)', () => {
  it('1~9·9+ 의 흰 픽셀은 모두 코랄 원 안에 있고, 글자 상자 밖은 흰색이 없다', () => {
    for (const text of ['1', '5', '9', '9+']) {
      for (const size of [16, 32]) {
        const cv = overlayCanvas(text, size);
        const box = overlayTextBox(text, size);
        let white = 0;
        for (let y = 0; y < size; y++) {
          for (let x = 0; x < size; x++) {
            const [r, g, b, a] = cv.pixel(x, y);
            if (r === 255 && g === 255 && b === 255 && a === 255) {
              white++;
              expect((x + 0.5 - size / 2) ** 2 + (y + 0.5 - size / 2) ** 2).toBeLessThan((size / 2) ** 2);
              expect(x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height).toBe(true);
            }
          }
        }
        expect(white).toBeGreaterThan(0);
      }
    }
    // 32px 은 2배 — 흰 픽셀 수가 4배
    const count = (cv: Canvas) => {
      let n = 0;
      for (let i = 0; i < cv.data.length; i += 4) if (cv.data[i] === 255 && cv.data[i + 1] === 255 && cv.data[i + 2] === 255) n++;
      return n;
    };
    expect(count(overlayCanvas('9+', 32))).toBe(count(overlayCanvas('9+', 16)) * 4);
    expect(rgbOf(overlayCanvas('1', 16), 1, 8)).toEqual(COLORS.coral);
  });
});
