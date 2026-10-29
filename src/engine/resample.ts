import { createCanvas } from './types';

/** High-quality downscale: halve repeatedly, then one final smooth step. */
export function downscaleCanvas(src: HTMLCanvasElement, w: number, h: number): HTMLCanvasElement {
  let cur: HTMLCanvasElement = src;
  while (cur.width / 2 >= w && cur.height / 2 >= h) {
    const half = createCanvas(Math.max(w, Math.round(cur.width / 2)), Math.max(h, Math.round(cur.height / 2)));
    const ctx = half.getContext('2d')!;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(cur, 0, 0, half.width, half.height);
    if (cur !== src) {
      cur.width = 0;
      cur.height = 0;
    }
    cur = half;
  }
  if (cur.width === w && cur.height === h) return cur;
  const out = createCanvas(w, h);
  const ctx = out.getContext('2d')!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(cur, 0, 0, w, h);
  if (cur !== src) {
    cur.width = 0;
    cur.height = 0;
  }
  return out;
}

/** Shrink so the long side is at most `maxLong`. Returns the same canvas if it already fits. */
export function capCanvas(src: HTMLCanvasElement, maxLong: number): { canvas: HTMLCanvasElement; factor: number } {
  const long = Math.max(src.width, src.height);
  if (long <= maxLong) return { canvas: src, factor: 1 };
  const f = maxLong / long;
  return { canvas: downscaleCanvas(src, Math.max(1, Math.round(src.width * f)), Math.max(1, Math.round(src.height * f))), factor: f };
}
