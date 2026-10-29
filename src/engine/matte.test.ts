import { describe, expect, it } from 'vitest';
import {
  boxBlur,
  colorRefine,
  edgeBand,
  edgeContrast,
  estimateForeground,
  expandRect,
  floatToHalf,
  guidedFilterColor,
  guidedInBand,
  halfToFloat,
  labelRegions,
  morph,
  removeSpecks,
  resizeBilinear,
  type Planes,
} from './matte';

function plane(w: number, h: number, f: (x: number, y: number) => number) {
  const a = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) a[y * w + x] = f(x, y);
  return a;
}

describe('boxBlur', () => {
  it('matches a brute-force mean with clamped edges', () => {
    const w = 9;
    const h = 7;
    const src = plane(w, h, (x, y) => ((x * 7 + y * 13) % 5) / 4);
    const r = 2;
    const out = boxBlur(src, w, h, r);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        // separable mean = mean of row-means
        let s = 0;
        let c = 0;
        for (let yy = Math.max(0, y - r); yy <= Math.min(h - 1, y + r); yy++) {
          let rs = 0;
          let rc = 0;
          for (let xx = Math.max(0, x - r); xx <= Math.min(w - 1, x + r); xx++) {
            rs += src[yy * w + xx];
            rc++;
          }
          s += rs / rc;
          c++;
        }
        expect(out[y * w + x]).toBeCloseTo(s / c, 5);
      }
    }
  });

  it('keeps a constant image constant', () => {
    const out = boxBlur(new Float32Array(40).fill(0.3), 8, 5, 3);
    out.forEach((v) => expect(v).toBeCloseTo(0.3, 6));
  });
});

describe('morph', () => {
  it('dilates and erodes a single pixel by a square radius', () => {
    const w = 11;
    const h = 11;
    const src = new Float32Array(w * h);
    src[5 * w + 5] = 1;
    const d = morph(src, w, h, 2, true);
    expect(d[3 * w + 3]).toBe(1);
    expect(d[7 * w + 7]).toBe(1);
    expect(d[2 * w + 5]).toBe(0);
    const e = morph(d, w, h, 2, false);
    expect(e[5 * w + 5]).toBe(1);
    expect(e[4 * w + 5]).toBe(0);
  });

  it('handles windows that cross image edges', () => {
    const src = plane(5, 1, (x) => x / 4);
    expect(Array.from(morph(src, 5, 1, 1, true))).toEqual([0.25, 0.5, 0.75, 1, 1]);
    expect(Array.from(morph(src, 5, 1, 1, false))).toEqual([0, 0, 0.25, 0.5, 0.75]);
  });
});

describe('resizeBilinear', () => {
  it('round-trips a smooth ramp', () => {
    const src = plane(16, 16, (x) => x / 15);
    const up = resizeBilinear(src, 16, 16, 64, 64);
    const down = resizeBilinear(up, 64, 64, 16, 16);
    for (let i = 0; i < 16; i++) expect(Math.abs(down[i] - src[i])).toBeLessThan(0.04);
  });
});

describe('guided filter', () => {
  it('snaps a blurry matte to a sharp colour edge', () => {
    const w = 40;
    const h = 20;
    const R = plane(w, h, (x) => (x < 20 ? 0.9 : 0.1));
    const I: Planes = [R, Float32Array.from(R), Float32Array.from(R)];
    const blurry = plane(w, h, (x) => Math.min(1, Math.max(0, (24 - x) / 8)));
    const q = guidedFilterColor(I, blurry, w, h, 4, 1e-4);
    expect(q[10 * w + 16]).toBeGreaterThan(0.85);
    expect(q[10 * w + 23]).toBeLessThan(0.2);
  });

  it('only touches band pixels', () => {
    const w = 30;
    const h = 30;
    const I: Planes = [plane(w, h, () => 0.5), plane(w, h, () => 0.5), plane(w, h, () => 0.5)];
    const p = plane(w, h, (x) => (x < 15 ? 1 : 0));
    const band = new Uint8Array(w * h);
    const out = guidedInBand(I, p, band, w, h, 3, 1e-3);
    expect(Array.from(out)).toEqual(Array.from(p));
  });
});

describe('colorRefine', () => {
  it('recovers a 50% mixed pixel between known colours', () => {
    const w = 60;
    const h = 20;
    // red subject on the left, blue background on the right, one column of 50/50 mix at x=30
    const R = plane(w, h, (x) => (x < 30 ? 1 : x === 30 ? 0.5 : 0));
    const B = plane(w, h, (x) => (x < 30 ? 0 : x === 30 ? 0.5 : 1));
    const G = plane(w, h, () => 0);
    const coarse = plane(w, h, (x) => (x < 26 ? 1 : x > 34 ? 0 : 0.5));
    const band = edgeBand(coarse, w, h, 4);
    const out = colorRefine([R, G, B], coarse, band, w, h, 6);
    expect(out[10 * w + 28]).toBeGreaterThan(0.9);
    expect(out[10 * w + 32]).toBeLessThan(0.1);
    expect(out[10 * w + 30]).toBeGreaterThan(0.3);
    expect(out[10 * w + 30]).toBeLessThan(0.7);
  });
});

describe('regions', () => {
  it('labels separate blobs and removes small specks', () => {
    const w = 20;
    const h = 10;
    const a = plane(w, h, (x, y) => ((x < 8 && y < 8) || (x === 15 && y === 5) ? 1 : 0));
    const { sizes } = labelRegions(a, w, h);
    expect(sizes.slice(1).sort((p, q) => q - p)).toEqual([64, 1]);
    const out = removeSpecks(a, w, h, 0.05, 2);
    expect(out[5 * w + 15]).toBe(0);
    expect(out[2 * w + 2]).toBe(1);
  });
});

describe('estimateForeground', () => {
  it('pulls soft edge colour toward the subject colour', () => {
    const w = 60;
    const h = 10;
    const alpha = plane(w, h, (x) => (x < 28 ? 1 : x > 32 ? 0 : (32 - x) / 4));
    // white subject over green background, composited
    const mix = (x: number, fg: number, bg: number) => {
      const a = alpha[x];
      return a * fg + (1 - a) * bg;
    };
    const I: Planes = [plane(w, h, (x) => mix(x, 1, 0)), plane(w, h, (x) => mix(x, 1, 1)), plane(w, h, (x) => mix(x, 1, 0))];
    const F = estimateForeground(I, alpha, w, h);
    const i = 5 * w + 30;
    // the composited pixel is greenish; the estimate should be much closer to white
    expect(F[0][i]).toBeGreaterThan(I[0][i] + 0.2);
    expect(F[2][i]).toBeGreaterThan(I[2][i] + 0.2);
  });
});

describe('misc', () => {
  it('converts half floats both ways', () => {
    const v = Float32Array.from([0, 1, -2.5, 0.333, 65504]);
    const back = halfToFloat(floatToHalf(v));
    v.forEach((x, i) => expect(back[i]).toBeCloseTo(x, 2));
  });

  it('edge contrast hardens toward 0/1', () => {
    const out = edgeContrast(Float32Array.from([0.3, 0.5, 0.7]), 80);
    expect(out[0]).toBeLessThan(0.3);
    expect(out[1]).toBeCloseTo(0.5);
    expect(out[2]).toBeGreaterThan(0.7);
  });

  it('expands and clamps rects', () => {
    expect(expandRect({ x: 5, y: 5, w: 10, h: 10 }, 10, 18, 30)).toEqual({ x: 0, y: 0, w: 18, h: 25 });
  });
});

import { solidInside as solidIn } from './matte';
describe('solid inside', () => {
  it('fills see-through patches and small holes inside the subject, keeps big gaps and soft edges', () => {
    const w = 200;
    const h = 200;
    const a = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const d = Math.hypot(x - 100, y - 100);
      a[y * w + x] = d < 80 ? 1 : d < 84 ? (84 - d) / 4 : 0;
    }
    const at = (x: number, y: number) => y * w + x;
    for (let y = 90; y < 100; y++) for (let x = 60; x < 70; x++) a[at(x, y)] = 0.3; // faint patch (pale corset)
    for (let y = 120; y < 124; y++) for (let x = 100; x < 104; x++) a[at(x, y)] = 0; // tiny hole
    for (let y = 70; y < 130; y++) for (let x = 110; x < 170; x++) if (x > 115 && x < 165 && y > 75 && y < 125) a[at(x, y)] = 0; // big gap
    const o = solidIn(a, w, h, 60);
    expect(o[at(65, 95)]).toBeGreaterThan(0.95);
    expect(o[at(102, 122)]).toBeGreaterThan(0.95);
    expect(o[at(140, 100)]).toBeLessThan(0.05);
    expect(o[at(100, 182)]).toBeCloseTo(a[at(100, 182)], 2); // soft rim untouched
    expect(solidIn(a, w, h, 0)).toBe(a);
  });
});

import { matteLooksValid } from './matte';
describe('matte sanity check', () => {
  it('accepts a solid subject and rejects noise or empty output', () => {
    const w = 128;
    const h = 128;
    const good = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) good[y * w + x] = Math.hypot(x - 64, y - 64) < 40 ? 1 : 0;
    expect(matteLooksValid(good, w, h)).toBe(true);
    let seed = 3;
    const noise = new Float32Array(w * h).map(() => ((seed = (seed * 16807) % 2147483647) / 2147483647));
    expect(matteLooksValid(noise, w, h)).toBe(false);
    const empty = new Float32Array(w * h);
    for (let i = 0; i < 40; i++) empty[i * 97] = 1;
    expect(matteLooksValid(empty, w, h)).toBe(false);
  });
});
