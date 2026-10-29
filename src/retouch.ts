/** Remove tool (content-aware fill) and Healing brush finishing steps. */
import { store } from './store';
import { createCanvas } from './engine/types';
import { dropCaches } from './engine/render';
import type { CloneStroke, PixelPatch } from './engine/brush';
import { healPixels } from './engine/heal';

let worker: Worker | null = null;
let seq = 0;
const waiting = new Map<number, (r: { rgba?: Uint8ClampedArray; error?: string }) => void>();

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('./engine/retouch.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const cb = waiting.get(e.data.id);
      waiting.delete(e.data.id);
      cb?.(e.data);
    };
  }
  return worker;
}

function fillHole(rgba: Uint8ClampedArray, w: number, h: number, hole: Uint8Array): Promise<Uint8ClampedArray> {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    waiting.set(id, (r) => (r.rgba ? resolve(r.rgba) : reject(new Error(r.error || 'Fill failed'))));
    getWorker().postMessage({ id, rgba, w, h, hole }, [rgba.buffer, hole.buffer]);
  });
}

/** While a Remove is running, the painted area stays visible so you can see what's being filled. */
export const removePending = { canvas: null as HTMLCanvasElement | null, layerId: '' };

/**
 * Fill everything painted on `coverage` (same size as the layer, alpha = painted) from the
 * surrounding image, then record it for undo.
 */
export async function runRemove(layerId: string, coverage: HTMLCanvasElement) {
  const doc = store.state.doc;
  const layer = doc?.layers.find((l) => l.id === layerId);
  if (!layer?.canvas) return;
  const W = layer.canvas.width;
  const H = layer.canvas.height;
  const cov = coverage.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, W, H).data;
  let x0 = W;
  let y0 = H;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (cov[(y * W + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return;
  // give the fill plenty of surroundings to borrow from, but keep it quick
  const size = Math.max(x1 - x0, y1 - y0);
  const margin = Math.round(Math.min(400, Math.max(48, size * 0.9)));
  const rx = Math.max(0, x0 - margin);
  const ry = Math.max(0, y0 - margin);
  const rw = Math.min(W, x1 + margin + 1) - rx;
  const rh = Math.min(H, y1 + margin + 1) - ry;
  // big areas are filled at reduced size, then scaled back up
  const scale = Math.min(1, 900 / Math.max(rw, rh));
  const sw = Math.max(1, Math.round(rw * scale));
  const sh = Math.max(1, Math.round(rh * scale));
  const ctx = layer.canvas.getContext('2d', { willReadFrequently: true })!;
  const before = ctx.getImageData(rx, ry, rw, rh);
  const small = createCanvas(sw, sh);
  const sc = small.getContext('2d', { willReadFrequently: true })!;
  sc.imageSmoothingQuality = 'high';
  sc.drawImage(layer.canvas, rx, ry, rw, rh, 0, 0, sw, sh);
  const smallCov = createCanvas(sw, sh);
  const cc = smallCov.getContext('2d', { willReadFrequently: true })!;
  cc.drawImage(coverage, rx, ry, rw, rh, 0, 0, sw, sh);
  const cd = cc.getImageData(0, 0, sw, sh).data;
  const hole = new Uint8Array(sw * sh);
  // grow the hole a touch so no edge of the removed thing survives
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      if (cd[(y * sw + x) * 4 + 3] <= 8) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < sw && yy < sh) hole[yy * sw + xx] = 1;
        }
      }
    }
  }
  store.set({ toast: 'Removing… (filling from the surroundings)' });
  removePending.canvas = coverage;
  removePending.layerId = layerId;
  store.bump();
  try {
    const filled = await fillHole(sc.getImageData(0, 0, sw, sh).data, sw, sh, hole.slice());
    const fc = createCanvas(sw, sh);
    fc.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(filled), sw, sh), 0, 0);
    // paste back only inside the (softened) painted area
    const patch = createCanvas(rw, rh);
    const pc = patch.getContext('2d', { willReadFrequently: true })!;
    pc.imageSmoothingQuality = 'high';
    pc.drawImage(fc, 0, 0, rw, rh);
    const maskC = createCanvas(rw, rh);
    const mc = maskC.getContext('2d')!;
    mc.filter = `blur(${Math.max(1, 1.5 / scale)}px)`;
    const holeC = createCanvas(sw, sh);
    const hc = holeC.getContext('2d')!;
    const hi = hc.createImageData(sw, sh);
    for (let i = 0; i < hole.length; i++) hi.data[i * 4 + 3] = hole[i] ? 255 : 0;
    hc.putImageData(hi, 0, 0);
    mc.drawImage(holeC, 0, 0, rw, rh);
    pc.globalCompositeOperation = 'destination-in';
    pc.drawImage(maskC, 0, 0);
    const live = store.state.doc?.layers.find((l) => l.id === layerId);
    if (!live?.canvas) return;
    const lctx = live.canvas.getContext('2d', { willReadFrequently: true })!;
    lctx.save();
    lctx.globalCompositeOperation = 'source-atop';
    lctx.drawImage(patch, rx, ry);
    lctx.restore();
    const after = lctx.getImageData(rx, ry, rw, rh);
    const p: PixelPatch = { x: rx, y: ry, before, after };
    dropCaches(layerId);
    store.pushPixels(layerId, 'canvas', p, 'Remove');
    store.toast('Removed');
  } catch (e) {
    store.toast(`Couldn't remove that: ${(e as Error).message}`);
  } finally {
    removePending.canvas = null;
    store.bump();
  }
}

/** Finish a Healing-brush stroke: match the cloned texture to the tone around the repaired spot. */
export function finishHeal(layerId: string, stroke: CloneStroke, radius: number): PixelPatch | null {
  const b = stroke.bounds();
  const layer = store.state.doc?.layers.find((l) => l.id === layerId);
  if (!b || !layer?.canvas) return stroke.finish();
  const W = layer.canvas.width;
  const H = layer.canvas.height;
  const pad = Math.ceil(radius * 2);
  const x = Math.max(0, b.x - pad);
  const y = Math.max(0, b.y - pad);
  const w = Math.min(W, b.x + b.w + pad) - x;
  const h = Math.min(H, b.y + b.h + pad) - y;
  const orig = stroke.original().getContext('2d', { willReadFrequently: true })!.getImageData(x, y, w, h);
  const srcC = createCanvas(w, h);
  srcC.getContext('2d')!.drawImage(stroke.source, -(x + stroke.ox), -(y + stroke.oy));
  const src = srcC.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, w, h);
  const cov = stroke.coverage.getContext('2d', { willReadFrequently: true })!.getImageData(x, y, w, h);
  const healed = healPixels(src.data, orig.data, cov.data, w, h, radius);
  const ctx = layer.canvas.getContext('2d', { willReadFrequently: true })!;
  // keep the layer's own transparency
  for (let i = 0; i < healed.length; i += 4) healed[i + 3] = orig.data[i + 3];
  ctx.putImageData(new ImageData(new Uint8ClampedArray(healed), w, h), x, y);
  return { x, y, before: orig, after: ctx.getImageData(x, y, w, h) };
}
