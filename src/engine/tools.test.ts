import { describe, expect, it } from 'vitest';
import { gradientMapLut, isIdentity, applyAdjustments } from './adjust';
import { defaultAdjustments } from './types';
import { identityMesh, isIdentityMesh, meshGrid, squareToQuad, warpPreset } from './mesh';
import { inpaint } from './inpaint';
import { healPixels } from './heal';

describe('gradient map', () => {
  it('maps black to the first color and white to the last', () => {
    const lut = gradientMapLut(['#ff0000', '#0000ff']);
    expect([lut[0], lut[1], lut[2]]).toEqual([255, 0, 0]);
    expect([lut[255 * 3], lut[255 * 3 + 1], lut[255 * 3 + 2]]).toEqual([0, 0, 255]);
  });

  it('recolors pixels and counts as a non-identity adjustment', () => {
    const a = defaultAdjustments();
    expect(isIdentity(a)).toBe(true);
    a.gradMap = { enabled: true, colors: ['#000000', '#ff0000'], amount: 100 };
    expect(isIdentity(a)).toBe(false);
    const px = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]);
    applyAdjustments(px, a);
    expect(Array.from(px.slice(0, 3))).toEqual([255, 0, 0]);
    expect(Array.from(px.slice(4, 7))).toEqual([0, 0, 0]);
  });
});

describe('mesh', () => {
  it('identity meshes are detected and sample to a regular grid', () => {
    for (const kind of ['distort', 'warp'] as const) {
      const m = identityMesh(kind);
      expect(isIdentityMesh(m)).toBe(true);
      const g = meshGrid(m, 4);
      expect(g[0][0]).toBeCloseTo(0);
      expect(g[24][0]).toBeCloseTo(1);
      expect(g[24][1]).toBeCloseTo(1);
      expect(g[12][0]).toBeCloseTo(0.5);
      expect(g[12][1]).toBeCloseTo(0.5);
    }
  });

  it('perspective maps the unit square corners onto the chosen corners', () => {
    const q: [number, number][] = [
      [0.1, 0],
      [0.9, 0.2],
      [1, 1],
      [0, 0.8],
    ];
    const g = meshGrid({ kind: 'distort', pts: q }, 2);
    expect(g[0][0]).toBeCloseTo(0.1);
    expect(g[2][1]).toBeCloseTo(0.2);
    expect(g[8][0]).toBeCloseTo(1);
    expect(g[6][1]).toBeCloseTo(0.8);
    expect(squareToQuad(q)).toHaveLength(8);
  });

  it('arc warp lifts the middle of the layer', () => {
    const g = meshGrid(warpPreset('arc', 60), 4);
    const midTop = g[2][1];
    const cornerTop = g[0][1];
    expect(midTop).toBeLessThan(cornerTop - 0.1);
  });
});

describe('inpaint', () => {
  it('continues a stripe pattern into a hole', () => {
    const w = 64;
    const h = 64;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const v = Math.floor(x / 4) % 2 ? 220 : 30;
        const i = (y * w + x) * 4;
        rgba[i] = v;
        rgba[i + 1] = v;
        rgba[i + 2] = v;
        rgba[i + 3] = 255;
      }
    }
    const hole = new Uint8Array(w * h);
    for (let y = 24; y < 40; y++) for (let x = 24; x < 40; x++) hole[y * w + x] = 1;
    // scribble garbage into the hole so we know it was really filled
    for (let i = 0; i < hole.length; i++) if (hole[i]) rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = 128;
    const out = inpaint(rgba, w, h, hole, 3);
    let err = 0;
    let n = 0;
    for (let y = 24; y < 40; y++) {
      for (let x = 24; x < 40; x++) {
        const expect = Math.floor(x / 4) % 2 ? 220 : 30;
        err += Math.abs(out[(y * w + x) * 4] - expect);
        n++;
      }
    }
    expect(err / n).toBeLessThan(40);
  });
});

describe('healing', () => {
  it('takes texture from the source but tone from the target area', () => {
    const w = 40;
    const h = 40;
    const src = new Uint8ClampedArray(w * h * 4);
    const orig = new Uint8ClampedArray(w * h * 4);
    const cov = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const x = i % w;
      const tex = x % 2 ? 10 : -10;
      src[i * 4] = src[i * 4 + 1] = src[i * 4 + 2] = 60 + tex; // dark textured source
      orig[i * 4] = orig[i * 4 + 1] = orig[i * 4 + 2] = 200; // bright target
      src[i * 4 + 3] = orig[i * 4 + 3] = 255;
      const y = Math.floor(i / w);
      if (x > 14 && x < 26 && y > 14 && y < 26) cov[i * 4 + 3] = 255;
    }
    // a dark blemish in the target where we paint
    for (let i = 0; i < w * h; i++) if (cov[i * 4 + 3]) orig[i * 4] = orig[i * 4 + 1] = orig[i * 4 + 2] = 40;
    const out = healPixels(src, orig, cov, w, h, 6);
    const c = (20 * w + 20) * 4;
    // healed pixel is bright like the surroundings, not dark like the source or the blemish
    expect(out[c]).toBeGreaterThan(170);
    // and keeps the source's texture (neighbouring columns differ)
    expect(Math.abs(out[c] - out[c + 4])).toBeGreaterThan(10);
  });
});
