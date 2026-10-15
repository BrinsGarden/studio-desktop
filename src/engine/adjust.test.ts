import { describe, expect, it } from 'vitest';
import { applyAdjustments, buildChannelLuts, computeStats, curveLut, isIdentity, keyOutColor, processEdges } from './adjust';
import { defaultAdjustments } from './types';
import { crc32, setPngDpi, setJpegDpi } from './io';

const px = (...rgba: number[]) => new Uint8ClampedArray(rgba);

describe('curves', () => {
  it('identity curve maps every value to itself', () => {
    const lut = curveLut([
      [0, 0],
      [255, 255],
    ]);
    for (let i = 0; i < 256; i++) expect(lut[i]).toBe(i);
  });
  it('passes through control points and stays monotone', () => {
    const lut = curveLut([
      [0, 0],
      [64, 40],
      [192, 220],
      [255, 255],
    ]);
    expect(lut[64]).toBe(40);
    expect(lut[192]).toBe(220);
    for (let i = 1; i < 256; i++) expect(lut[i]).toBeGreaterThanOrEqual(lut[i - 1]);
  });
});

describe('adjustments', () => {
  it('defaults are identity and leave pixels untouched', () => {
    const a = defaultAdjustments();
    expect(isIdentity(a)).toBe(true);
    const d = px(10, 128, 250, 255);
    applyAdjustments(d, a);
    expect([...d]).toEqual([10, 128, 250, 255]);
  });
  it('brightness raises values, alpha untouched', () => {
    const a = defaultAdjustments();
    a.brightness = 50;
    const d = px(100, 100, 100, 77);
    applyAdjustments(d, a);
    expect(d[0]).toBeGreaterThan(150);
    expect(d[3]).toBe(77);
  });
  it('desaturation makes channels equal', () => {
    const a = defaultAdjustments();
    a.saturation = -100;
    const d = px(200, 50, 90, 255);
    applyAdjustments(d, a);
    expect(Math.abs(d[0] - d[1])).toBeLessThanOrEqual(1);
    expect(Math.abs(d[1] - d[2])).toBeLessThanOrEqual(1);
  });
  it('match color moves the mean toward the target', () => {
    const a = defaultAdjustments();
    a.match = { layerId: 'bg', strength: 100 };
    const self = { mean: [200, 180, 160] as [number, number, number], std: [30, 30, 30] as [number, number, number] };
    const target = { mean: [40, 30, 70] as [number, number, number], std: [20, 20, 25] as [number, number, number] };
    const [r, g, b] = buildChannelLuts(a, self, target);
    expect(r[200]).toBe(40);
    expect(g[180]).toBe(30);
    expect(b[160]).toBe(70);
  });
  it('tint keeps brightness roughly the same', () => {
    const a = defaultAdjustments();
    a.tint = { color: '#ff8c1a', amount: 100 };
    const d = px(128, 128, 128, 255);
    applyAdjustments(d, a);
    const y = 0.299 * d[0] + 0.587 * d[1] + 0.114 * d[2];
    expect(Math.abs(y - 128)).toBeLessThan(4);
    expect(d[0]).toBeGreaterThan(d[2]);
  });
  it('levels clip blacks and whites', () => {
    const a = defaultAdjustments();
    a.levels = { inBlack: 50, inWhite: 200, gamma: 1, outBlack: 0, outWhite: 255 };
    const d = px(40, 125, 210, 255);
    applyAdjustments(d, a);
    expect(d[0]).toBe(0);
    expect(d[1]).toBeGreaterThan(120);
    expect(d[1]).toBeLessThan(135);
    expect(d[2]).toBe(255);
  });
});

describe('stats', () => {
  it('ignores transparent pixels', () => {
    const s = computeStats(px(100, 100, 100, 255, 0, 0, 0, 0, 200, 200, 200, 255));
    expect(s.mean[0]).toBe(150);
    expect(s.std[0]).toBe(50);
  });
});

describe('edges', () => {
  it('shrink removes a 1px border of alpha', () => {
    const w = 5;
    const h = 5;
    const d = new Uint8ClampedArray(w * h * 4);
    for (let y = 1; y < 4; y++) for (let x = 1; x < 4; x++) d[(y * w + x) * 4 + 3] = 255;
    processEdges(d, w, h, 1, 0);
    expect(d[(2 * w + 2) * 4 + 3]).toBe(255);
    expect(d[(1 * w + 1) * 4 + 3]).toBe(0);
  });
  it('never adds alpha where there was none', () => {
    const d = new Uint8ClampedArray(3 * 1 * 4);
    d[7] = 255;
    processEdges(d, 3, 1, 0, 2);
    expect(d[3]).toBe(0);
    expect(d[11]).toBe(0);
  });
});

describe('dpi metadata', () => {
  it('crc32 of "IEND" matches the PNG spec value', () => {
    expect(crc32(new TextEncoder().encode('IEND'))).toBe(0xae426082);
  });
  it('inserts a pHYs chunk after IHDR', () => {
    const sig = [137, 80, 78, 71, 13, 10, 26, 10];
    const ihdr = [0, 0, 0, 13, 73, 72, 68, 82, ...new Array(13).fill(0), 0, 0, 0, 0];
    const iend = [0, 0, 0, 0, 73, 69, 78, 68, 0xae, 0x42, 0x60, 0x82];
    const png = new Uint8Array([...sig, ...ihdr, ...iend]);
    const out = setPngDpi(png, 300);
    expect(String.fromCharCode(...out.subarray(37, 41))).toBe('pHYs');
    const ppm = new DataView(out.buffer).getUint32(41);
    expect(ppm).toBe(11811);
    expect(out.length).toBe(png.length + 21);
  });
  it('patches JFIF density', () => {
    const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
    const out = setJpegDpi(jpg, 150);
    expect(out[13]).toBe(1);
    expect((out[14] << 8) | out[15]).toBe(150);
  });
});

describe('remove background color', () => {
  it('clears black, keeps dark rust, feathers in between', () => {
    const d = px(5, 5, 5, 255, 90, 60, 40, 255, 30, 30, 30, 255);
    keyOutColor(d, [0, 0, 0], 8, 10);
    expect(d[3]).toBe(0);
    expect(d[7]).toBe(255);
    expect(d[11]).toBeGreaterThan(0);
    expect(d[11]).toBeLessThan(255);
  });
});
