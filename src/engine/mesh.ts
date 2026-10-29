import type { LayerMesh } from './types';

/** Bending layers: perspective distort (4 corners) and bezier warp (4x4 grid). Coordinates are normalized to the layer. */

export type P = [number, number];

export const MESH_N = 16;

export function identityMesh(kind: LayerMesh['kind']): LayerMesh {
  if (kind === 'distort') return { kind, pts: [[0, 0], [1, 0], [1, 1], [0, 1]] };
  const pts: P[] = [];
  for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) pts.push([i / 3, j / 3]);
  return { kind, pts };
}

export function isIdentityMesh(m: LayerMesh | undefined): boolean {
  if (!m) return true;
  const id = identityMesh(m.kind).pts;
  return m.pts.every((p, i) => Math.abs(p[0] - id[i][0]) < 1e-4 && Math.abs(p[1] - id[i][1]) < 1e-4);
}

/** Homography mapping the unit square corners to the 4 given points (TL, TR, BR, BL). */
export function squareToQuad(q: P[]): number[] {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q;
  const dx1 = x1 - x2;
  const dx2 = x3 - x2;
  const dx3 = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2;
  const dy2 = y3 - y2;
  const dy3 = y0 - y1 + y2 - y3;
  let g = 0;
  let h = 0;
  if (Math.abs(dx3) > 1e-12 || Math.abs(dy3) > 1e-12) {
    const den = dx1 * dy2 - dx2 * dy1 || 1e-12;
    g = (dx3 * dy2 - dx2 * dy3) / den;
    h = (dx1 * dy3 - dx3 * dy1) / den;
  }
  const a = x1 - x0 + g * x1;
  const b = x3 - x0 + h * x3;
  const c = x0;
  const d = y1 - y0 + g * y1;
  const e = y3 - y0 + h * y3;
  const f = y0;
  return [a, b, c, d, e, f, g, h];
}

function applyH(H: number[], u: number, v: number): P {
  const [a, b, c, d, e, f, g, h] = H;
  const w = g * u + h * v + 1 || 1e-12;
  return [(a * u + b * v + c) / w, (d * u + e * v + f) / w];
}

function bern(t: number): [number, number, number, number] {
  const s = 1 - t;
  return [s * s * s, 3 * s * s * t, 3 * s * t * t, t * t * t];
}

/** Sample the mesh into an (n+1)x(n+1) grid of normalized destination points, row-major. */
export function meshGrid(m: LayerMesh, n = MESH_N): P[] {
  const out: P[] = [];
  if (m.kind === 'distort') {
    const H = squareToQuad(m.pts);
    for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) out.push(applyH(H, i / n, j / n));
    return out;
  }
  for (let j = 0; j <= n; j++) {
    const bv = bern(j / n);
    for (let i = 0; i <= n; i++) {
      const bu = bern(i / n);
      let x = 0;
      let y = 0;
      for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 4; c++) {
          const wgt = bv[r] * bu[c];
          const p = m.pts[r * 4 + c];
          x += p[0] * wgt;
          y += p[1] * wgt;
        }
      }
      out.push([x, y]);
    }
  }
  return out;
}

/** Bounding box of a mesh in normalized coords. */
export function meshBounds(m: LayerMesh): { x0: number; y0: number; x1: number; y1: number } {
  const g = meshGrid(m, 8);
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of g) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return { x0, y0, x1, y1 };
}

/** Ready-made warps. `bend` is -100..100. */
export const WARP_PRESETS = ['arc', 'arch', 'bulge', 'flag', 'rise', 'squeeze'] as const;
export type WarpPreset = (typeof WARP_PRESETS)[number];

export function warpPreset(kind: WarpPreset, bend: number): LayerMesh {
  const b = bend / 100;
  const m = identityMesh('warp');
  m.pts = m.pts.map(([u, v], idx) => {
    const c = idx % 4;
    const r = Math.floor(idx / 4);
    const xc = u - 0.5;
    switch (kind) {
      case 'arc': {
        // whole shape bends along a circle (classic arched title)
        const lift = -b * 0.5 * (1 - 4 * xc * xc);
        return [u, v + lift];
      }
      case 'arch': {
        const lift = -b * 0.5 * (1 - 4 * xc * xc) * (1 - v * 0.6);
        return [u, v + lift];
      }
      case 'bulge': {
        const k = b * 0.35 * (1 - 4 * xc * xc);
        return [u, 0.5 + (v - 0.5) * (1 + k * 2)];
      }
      case 'flag': {
        const wave = b * 0.18 * Math.sin((c / 3) * Math.PI * 2);
        return [u, v + wave];
      }
      case 'rise': {
        return [u, v - b * 0.35 * u + b * 0.175];
      }
      case 'squeeze': {
        const k = -b * 0.3 * (1 - 4 * (v - 0.5) * (v - 0.5));
        return [0.5 + xc * (1 + k), v];
      }
    }
    void r;
    return [u, v];
  });
  return m;
}

/**
 * Draw `src` (covering the layer's w×h local box) bent by `grid` (normalized, (n+1)² points)
 * into `ctx`, whose current transform maps layer-local pixels to output pixels.
 */
export function drawMesh(ctx: CanvasRenderingContext2D, src: CanvasImageSource & { width: number; height: number }, w: number, h: number, grid: P[], n: number, padLocal: number) {
  const sw = src.width;
  const sh = src.height;
  const tri = (s0: P, s1: P, s2: P, d0: P, d1: P, d2: P) => {
    // grow the destination triangle slightly to hide hairline seams between triangles
    const cx = (d0[0] + d1[0] + d2[0]) / 3;
    const cy = (d0[1] + d1[1] + d2[1]) / 3;
    const grow = (p: P): P => {
      const dx = p[0] - cx;
      const dy = p[1] - cy;
      const len = Math.hypot(dx, dy) || 1;
      return [p[0] + (dx / len) * padLocal, p[1] + (dy / len) * padLocal];
    };
    const e0 = grow(d0);
    const e1 = grow(d1);
    const e2 = grow(d2);
    // affine from source triangle to destination triangle
    const [x0, y0] = s0;
    const [x1, y1] = s1;
    const [x2, y2] = s2;
    const den = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if (Math.abs(den) < 1e-9) return;
    const a = ((d1[0] - d0[0]) * (y2 - y0) - (d2[0] - d0[0]) * (y1 - y0)) / den;
    const c = ((d2[0] - d0[0]) * (x1 - x0) - (d1[0] - d0[0]) * (x2 - x0)) / den;
    const b = ((d1[1] - d0[1]) * (y2 - y0) - (d2[1] - d0[1]) * (y1 - y0)) / den;
    const d = ((d2[1] - d0[1]) * (x1 - x0) - (d1[1] - d0[1]) * (x2 - x0)) / den;
    const e = d0[0] - a * x0 - c * y0;
    const f = d0[1] - b * x0 - d * y0;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(e0[0], e0[1]);
    ctx.lineTo(e1[0], e1[1]);
    ctx.lineTo(e2[0], e2[1]);
    ctx.closePath();
    ctx.clip();
    ctx.transform(a, b, c, d, e, f);
    ctx.drawImage(src, 0, 0);
    ctx.restore();
  };
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const s00: P = [(i / n) * sw, (j / n) * sh];
      const s10: P = [((i + 1) / n) * sw, (j / n) * sh];
      const s01: P = [(i / n) * sw, ((j + 1) / n) * sh];
      const s11: P = [((i + 1) / n) * sw, ((j + 1) / n) * sh];
      const g = (ii: number, jj: number): P => {
        const p = grid[jj * (n + 1) + ii];
        return [p[0] * w, p[1] * h];
      };
      const d00 = g(i, j);
      const d10 = g(i + 1, j);
      const d01 = g(i, j + 1);
      const d11 = g(i + 1, j + 1);
      tri(s00, s10, s11, d00, d10, d11);
      tri(s00, s11, s01, d00, d11, d01);
    }
  }
}
