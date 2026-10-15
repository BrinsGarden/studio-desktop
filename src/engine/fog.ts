import { createCanvas } from './types';
import { hexToRgb } from './adjust';
import { mulberry32 } from './swirl';

export interface FogOptions {
  color: string;
  /** 0..1 overall thickness */
  density: number;
  /** 0..1 fraction of the page height (from the bottom) the fog reaches */
  height: number;
  /** 0..1 how broken-up / wispy it is (0 = smooth band) */
  wisp: number;
  seed: number;
}

/** Smooth value noise on a random lattice. */
function makeNoise(rand: () => number, cx: number, cy: number) {
  const gw = cx + 1;
  const g = new Float32Array(gw * (cy + 1));
  for (let i = 0; i < g.length; i++) g[i] = rand();
  return (x: number, y: number) => {
    // x, y in 0..1
    const fx = x * cx;
    const fy = y * cy;
    const x0 = Math.min(cx - 1, Math.floor(fx));
    const y0 = Math.min(cy - 1, Math.floor(fy));
    let tx = fx - x0;
    let ty = fy - y0;
    tx = tx * tx * (3 - 2 * tx);
    ty = ty * ty * (3 - 2 * ty);
    const a = g[y0 * gw + x0];
    const b = g[y0 * gw + x0 + 1];
    const c = g[(y0 + 1) * gw + x0];
    const d = g[(y0 + 1) * gw + x0 + 1];
    return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
  };
}

/** Low-lying wispy ground fog, transparent above `height`. Rendered small, then scaled up smoothly. */
export function renderFog(o: FogOptions, w: number, h: number): HTMLCanvasElement {
  const sw = Math.min(640, w);
  const sh = Math.max(2, Math.round((sw * h) / w));
  const rand = mulberry32(o.seed || 1);
  // features are much wider than tall, like real drifting fog banks
  const aspect = sh / sw;
  const octaves = [
    { amp: 1, n: makeNoise(rand, 3, Math.max(2, Math.round(3 * aspect * 3))) },
    { amp: 0.5, n: makeNoise(rand, 7, Math.max(3, Math.round(7 * aspect * 3))) },
    { amp: 0.25, n: makeNoise(rand, 16, Math.max(6, Math.round(16 * aspect * 3))) },
    { amp: 0.12, n: makeNoise(rand, 36, Math.max(12, Math.round(36 * aspect * 3))) },
  ];
  const total = octaves.reduce((s, oc) => s + oc.amp, 0);
  const [r, g, b] = hexToRgb(o.color);
  const small = createCanvas(sw, sh);
  const sctx = small.getContext('2d')!;
  const img = sctx.createImageData(sw, sh);
  const top = Math.max(0.02, Math.min(1, o.height));
  const wisp = Math.min(1, Math.max(0, o.wisp));
  for (let y = 0; y < sh; y++) {
    const fromBottom = (sh - 1 - y) / (sh - 1); // 0 at bottom, 1 at top
    for (let x = 0; x < sw; x++) {
      const u = x / (sw - 1);
      const v = y / (sh - 1);
      let n = 0;
      for (const oc of octaves) n += oc.amp * oc.n(u, v);
      n /= total; // ~0..1, centered ~0.5
      // the top edge of the fog bank rolls up and down with the noise
      const edge = top * (0.65 + 0.7 * n);
      let mask = 1 - smoothstep(edge * 0.35, edge, fromBottom);
      // denser near the ground
      mask *= 0.55 + 0.45 * (1 - smoothstep(0, top, fromBottom));
      // break it into wisps
      const breakup = Math.min(1, Math.max(0, (n - 0.28) / 0.44));
      const a = o.density * mask * (1 - wisp + wisp * breakup);
      const i = (y * sw + x) * 4;
      img.data[i] = r;
      img.data[i + 1] = g;
      img.data[i + 2] = b;
      img.data[i + 3] = Math.round(Math.min(1, a) * 255);
    }
  }
  sctx.putImageData(img, 0, 0);
  const out = createCanvas(w, h);
  const octx = out.getContext('2d')!;
  octx.imageSmoothingEnabled = true;
  octx.imageSmoothingQuality = 'high';
  octx.filter = `blur(${Math.max(1, w / sw)}px)`;
  octx.drawImage(small, 0, 0, w, h);
  return out;
}

function smoothstep(e0: number, e1: number, x: number) {
  if (e1 <= e0) return x >= e1 ? 1 : 0;
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}
