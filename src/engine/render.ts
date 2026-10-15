import { applyAdjustments, computeStats, isIdentity, processEdges, hexToRgb, type ChannelStats } from './adjust';
import { createCanvas, type Doc, type Layer, type TextProps, type FillProps } from './types';

/* ------------------------------------------------------------------ */
/* Font epoch: bumped when web fonts finish loading so text re-renders */
/* ------------------------------------------------------------------ */
export let fontEpoch = 0;
const fontListeners = new Set<() => void>();
export function onFontsChanged(fn: () => void) {
  fontListeners.add(fn);
  return () => {
    fontListeners.delete(fn);
  };
}
if (typeof document !== 'undefined' && document.fonts) {
  document.fonts.addEventListener('loadingdone', () => {
    fontEpoch++;
    fontListeners.forEach((f) => f());
  });
}

/* ---------------- temp canvas pool ---------------- */
const pool = new Map<string, HTMLCanvasElement>();
function temp(name: string, w: number, h: number): CanvasRenderingContext2D {
  let c = pool.get(name);
  if (!c) {
    c = createCanvas(w, h);
    pool.set(name, c);
  }
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
  }
  const ctx = c.getContext('2d', { willReadFrequently: name === 'adjustLayer' })!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.filter = 'none';
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
  ctx.clearRect(0, 0, w, h);
  return ctx;
}

export function rgba(hex: string, a: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}

/* ---------------- sources ---------------- */
const textCache = new Map<string, { key: string; canvas: HTMLCanvasElement }>();
const fillCache = new Map<string, { key: string; canvas: HTMLCanvasElement }>();

export function fontString(t: TextProps): string {
  return `${t.italic ? 'italic ' : ''}${t.weight} ${t.size}px "${t.font}", sans-serif`;
}

function renderText(t: TextProps): HTMLCanvasElement {
  const meas = createCanvas(4, 4).getContext('2d')!;
  meas.font = fontString(t);
  meas.letterSpacing = `${t.letterSpacing}px`;
  const lines = (t.text || ' ').split('\n');
  const widths = lines.map((l) => meas.measureText(l || ' ').width);
  const maxW = Math.max(1, ...widths);
  const lineH = t.size * t.lineHeight;
  const pad = Math.ceil(t.strokeWidth + t.size * 0.3);
  const w = Math.ceil(maxW + pad * 2);
  const h = Math.ceil(lines.length * lineH + pad * 2);
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d')!;
  ctx.font = fontString(t);
  ctx.letterSpacing = `${t.letterSpacing}px`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  let fill: string | CanvasGradient = t.color;
  if (t.fillType === 'gradient') {
    const g =
      t.gradientDir === 'horizontal'
        ? ctx.createLinearGradient(pad, 0, w - pad, 0)
        : ctx.createLinearGradient(0, pad, 0, h - pad);
    g.addColorStop(0, t.color);
    g.addColorStop(1, t.color2);
    fill = g;
  }
  lines.forEach((line, i) => {
    const lw = widths[i];
    const x = t.align === 'left' ? pad : t.align === 'right' ? w - pad - lw : (w - lw) / 2;
    const y = pad + lineH * (i + 0.5);
    if (t.strokeWidth > 0) {
      ctx.lineJoin = 'round';
      ctx.lineWidth = t.strokeWidth * 2;
      ctx.strokeStyle = t.strokeColor;
      ctx.strokeText(line, x, y);
    }
    ctx.fillStyle = fill;
    ctx.fillText(line, x, y);
  });
  return c;
}

function renderFill(f: FillProps, w: number, h: number): HTMLCanvasElement {
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d')!;
  if (f.type === 'solid') {
    ctx.fillStyle = rgba(f.color1, f.alpha1);
    ctx.fillRect(0, 0, w, h);
    return c;
  }
  let g: CanvasGradient;
  if (f.type === 'linear') {
    const a = (f.angle * Math.PI) / 180;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    const half = Math.abs((w / 2) * dx) + Math.abs((h / 2) * dy);
    g = ctx.createLinearGradient(w / 2 - dx * half, h / 2 - dy * half, w / 2 + dx * half, h / 2 + dy * half);
  } else {
    g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.hypot(w, h) / 2);
  }
  g.addColorStop(0, rgba(f.color1, f.alpha1));
  g.addColorStop(1, rgba(f.color2, f.alpha2));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  return c;
}

/** The layer's pixel source in its own local space. Null for adjustment layers. */
export function getSource(layer: Layer, doc: Doc): HTMLCanvasElement | null {
  if (layer.kind === 'image') return layer.canvas;
  if (layer.kind === 'text' && layer.text) {
    const key = JSON.stringify(layer.text) + '|' + fontEpoch;
    const hit = textCache.get(layer.id);
    if (hit && hit.key === key) return hit.canvas;
    const canvas = renderText(layer.text);
    textCache.set(layer.id, { key, canvas });
    return canvas;
  }
  if (layer.kind === 'fill' && layer.fill) {
    const key = JSON.stringify(layer.fill) + `|${doc.width}x${doc.height}`;
    const hit = fillCache.get(layer.id);
    if (hit && hit.key === key) return hit.canvas;
    const canvas = renderFill(layer.fill, doc.width, doc.height);
    fillCache.set(layer.id, { key, canvas });
    return canvas;
  }
  return null;
}

export function sourceSize(layer: Layer, doc: Doc): { w: number; h: number } {
  if (layer.kind === 'adjust') return { w: doc.width, h: doc.height };
  const s = getSource(layer, doc);
  return s ? { w: s.width, h: s.height } : { w: doc.width, h: doc.height };
}

/** Keep a mask the same size as the layer source (text layers resize when edited). */
export function syncMaskSize(layer: Layer, doc: Doc) {
  if (!layer.mask) return;
  const { w, h } = sourceSize(layer, doc);
  if (layer.mask.width === w && layer.mask.height === h) return;
  const nm = createCanvas(w, h);
  const ctx = nm.getContext('2d')!;
  // areas outside the old mask stay visible; old mask is re-centered
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  const ox = Math.round((w - layer.mask.width) / 2);
  const oy = Math.round((h - layer.mask.height) / 2);
  ctx.clearRect(ox, oy, layer.mask.width, layer.mask.height);
  ctx.drawImage(layer.mask, ox, oy);
  layer.mask = nm;
}

/* ---------------- transforms ---------------- */
export function layerMatrix(layer: Layer, w: number, h: number): DOMMatrix {
  if (layer.kind === 'adjust') return new DOMMatrix();
  return new DOMMatrix()
    .translate(layer.x, layer.y)
    .rotate(layer.rotation)
    .scale(layer.scale * (layer.flipX ? -1 : 1), layer.scale * (layer.flipY ? -1 : 1))
    .translate(-w / 2, -h / 2);
}

export function docToLocal(layer: Layer, doc: Doc, x: number, y: number): { x: number; y: number } {
  const { w, h } = sourceSize(layer, doc);
  const p = layerMatrix(layer, w, h).inverse().transformPoint(new DOMPoint(x, y));
  return { x: p.x, y: p.y };
}

export function layerCorners(layer: Layer, doc: Doc): { x: number; y: number }[] {
  const { w, h } = sourceSize(layer, doc);
  const m = layerMatrix(layer, w, h);
  return [
    [0, 0],
    [w, 0],
    [w, h],
    [0, h],
  ].map(([x, y]) => {
    const p = m.transformPoint(new DOMPoint(x, y));
    return { x: p.x, y: p.y };
  });
}

/** True if the layer has a visible pixel at doc point (x, y). */
export function hitTest(layer: Layer, doc: Doc, x: number, y: number): boolean {
  if (!layer.visible || layer.kind === 'adjust') return false;
  const src = getSource(layer, doc);
  if (!src) return false;
  const p = docToLocal(layer, doc, x, y);
  if (p.x < 0 || p.y < 0 || p.x >= src.width || p.y >= src.height) return false;
  const a = src.getContext('2d')!.getImageData(Math.floor(p.x), Math.floor(p.y), 1, 1).data[3];
  if (a < 20) return false;
  if (layer.mask && layer.maskEnabled) {
    const m = layer.mask.getContext('2d')!.getImageData(Math.floor(p.x), Math.floor(p.y), 1, 1).data[3];
    if (m < 20) return false;
  }
  return true;
}

/* ---------------- stats & adjusted cache ---------------- */
const statsCache = new Map<string, { key: string; stats: ChannelStats }>();

export function layerStats(layer: Layer, doc: Doc): ChannelStats | null {
  const src = getSource(layer, doc);
  if (!src) return null;
  const key = `${layer.version}|${src.width}x${src.height}|${layer.kind === 'text' ? JSON.stringify(layer.text) : ''}|${layer.kind === 'fill' ? JSON.stringify(layer.fill) : ''}`;
  const hit = statsCache.get(layer.id);
  if (hit && hit.key === key) return hit.stats;
  const f = Math.min(1, 256 / Math.max(src.width, src.height));
  const w = Math.max(1, Math.round(src.width * f));
  const h = Math.max(1, Math.round(src.height * f));
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(src, 0, 0, w, h);
  const stats = computeStats(ctx.getImageData(0, 0, w, h).data);
  statsCache.set(layer.id, { key, stats });
  return stats;
}

const adjustedCache = new Map<string, { key: string; canvas: HTMLCanvasElement }>();

function needsPixelWork(layer: Layer): boolean {
  return !isIdentity(layer.adj) || layer.fx.shrinkEdge > 0 || layer.fx.softenEdge > 0;
}

/** Source with adjustments and edge processing baked, at resolution factor f (<=1). */
function adjustedSource(layer: Layer, doc: Doc, f: number): HTMLCanvasElement | null {
  const src = getSource(layer, doc);
  if (!src) return null;
  if (!needsPixelWork(layer)) return src;
  const target = layer.adj.match.layerId ? doc.layers.find((l) => l.id === layer.adj.match.layerId) : null;
  const tStats = target ? layerStats(target, doc) : null;
  const sStats = target ? layerStats(layer, doc) : null;
  const w = Math.max(1, Math.round(src.width * f));
  const h = Math.max(1, Math.round(src.height * f));
  const key = [
    layer.version,
    w,
    h,
    JSON.stringify(layer.adj),
    layer.fx.shrinkEdge,
    layer.fx.softenEdge,
    tStats ? tStats.mean.join(',') + tStats.std.join(',') : '',
    src === layer.canvas ? '' : JSON.stringify(layer.text ?? layer.fill) + fontEpoch,
  ].join('|');
  const hit = adjustedCache.get(layer.id);
  if (hit && hit.key === key) return hit.canvas;
  const c = hit?.canvas && hit.canvas.width === w && hit.canvas.height === h ? hit.canvas : createCanvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(src, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  if (!isIdentity(layer.adj)) applyAdjustments(img.data, layer.adj, sStats, tStats);
  if (layer.fx.shrinkEdge > 0 || layer.fx.softenEdge > 0) {
    processEdges(img.data, w, h, layer.fx.shrinkEdge * f, layer.fx.softenEdge * f);
  }
  ctx.putImageData(img, 0, 0);
  adjustedCache.set(layer.id, { key, canvas: c });
  return c;
}

export function dropCaches(layerId: string) {
  adjustedCache.delete(layerId);
  statsCache.delete(layerId);
  textCache.delete(layerId);
  fillCache.delete(layerId);
}

/* ---------------- main render ---------------- */
export interface RenderOptions {
  /** Draw the doc background color (otherwise transparent). */
  background?: boolean;
  /** Show only this layer's mask as grayscale. */
  showMaskOf?: string | null;
}

/** Composite the whole document into `out` at scale k (out must be docW*k x docH*k). */
export function renderDoc(doc: Doc, out: HTMLCanvasElement, k: number, opts: RenderOptions = {}) {
  const W = out.width;
  const H = out.height;
  const ctx = out.getContext('2d')!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, W, H);
  if (opts.background && doc.background) {
    ctx.fillStyle = doc.background;
    ctx.fillRect(0, 0, W, H);
  }

  if (opts.showMaskOf) {
    const l = doc.layers.find((x) => x.id === opts.showMaskOf);
    if (l && l.mask) {
      const { w, h } = sourceSize(l, doc);
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, H);
      const m = layerMatrix(l, w, h);
      ctx.setTransform(new DOMMatrix().scale(k, k).multiply(m));
      ctx.drawImage(l.mask, 0, 0, w, h);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      return;
    }
  }

  for (const layer of doc.layers) {
    if (!layer.visible || layer.opacity <= 0) continue;
    if (layer.kind === 'adjust') drawAdjustLayer(doc, layer, ctx, W, H, k);
    else drawPixelLayer(doc, layer, ctx, W, H, k);
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}

function drawAdjustLayer(doc: Doc, layer: Layer, ctx: CanvasRenderingContext2D, W: number, H: number, k: number) {
  if (isIdentity(layer.adj)) return;
  const tctx = temp('adjustLayer', W, H);
  tctx.drawImage(ctx.canvas, 0, 0);
  const img = tctx.getImageData(0, 0, W, H);
  const target = layer.adj.match.layerId ? doc.layers.find((l) => l.id === layer.adj.match.layerId) : null;
  const tStats = target ? layerStats(target, doc) : null;
  const sStats = target ? computeStats(downsample(ctx.canvas)) : null;
  applyAdjustments(img.data, layer.adj, sStats, tStats);
  tctx.putImageData(img, 0, 0);
  if (layer.mask && layer.maskEnabled) {
    tctx.globalCompositeOperation = 'destination-in';
    tctx.drawImage(layer.mask, 0, 0, W, H);
  }
  ctx.globalAlpha = layer.opacity;
  ctx.globalCompositeOperation = layer.blend;
  ctx.drawImage(tctx.canvas, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  void k;
}

function downsample(c: HTMLCanvasElement): Uint8ClampedArray {
  const f = Math.min(1, 256 / Math.max(c.width, c.height));
  const w = Math.max(1, Math.round(c.width * f));
  const h = Math.max(1, Math.round(c.height * f));
  const t = temp('statsSmall', w, h);
  t.drawImage(c, 0, 0, w, h);
  return t.getImageData(0, 0, w, h).data;
}

function drawPixelLayer(doc: Doc, layer: Layer, ctx: CanvasRenderingContext2D, W: number, H: number, k: number) {
  const src = getSource(layer, doc);
  if (!src) return;
  if (layer.kind === 'text') syncMaskSize(layer, doc);
  const w = src.width;
  const h = src.height;
  const f = Math.min(1, Math.max(0.02, k * layer.scale));
  const adj = adjustedSource(layer, doc, f);
  if (!adj) return;
  const m = new DOMMatrix().scale(k, k).multiply(layerMatrix(layer, w, h));
  const fx = layer.fx;

  // 1. layer pixels (+ blur) into L
  const L = temp('layer', W, H);
  L.setTransform(m);
  if (fx.blur > 0) L.filter = `blur(${fx.blur * k}px)`;
  L.drawImage(adj, 0, 0, w, h);
  L.filter = 'none';

  // 2. mask
  if (layer.mask && layer.maskEnabled) {
    L.globalCompositeOperation = 'destination-in';
    L.drawImage(layer.mask, 0, 0, w, h);
    L.globalCompositeOperation = 'source-over';
  }
  L.setTransform(1, 0, 0, 1, 0, 0);

  // 3. rim light (painted onto the layer itself)
  if (fx.rim.enabled && fx.rim.opacity > 0) {
    const a = (fx.rim.angle * Math.PI) / 180;
    const dx = Math.cos(a) * fx.rim.width * k;
    const dy = -Math.sin(a) * fx.rim.width * k;
    const R = temp('rim', W, H);
    R.drawImage(L.canvas, 0, 0);
    R.globalCompositeOperation = 'source-in';
    R.fillStyle = fx.rim.color;
    R.fillRect(0, 0, W, H);
    R.globalCompositeOperation = 'destination-out';
    R.drawImage(L.canvas, -dx, -dy);
    const R2 = temp('rim2', W, H);
    if (fx.rim.softness > 0) R2.filter = `blur(${fx.rim.softness * k}px)`;
    R2.drawImage(R.canvas, 0, 0);
    R2.filter = 'none';
    R2.globalCompositeOperation = 'destination-in';
    R2.drawImage(L.canvas, 0, 0);
    L.globalCompositeOperation = 'screen';
    L.globalAlpha = fx.rim.opacity;
    L.drawImage(R2.canvas, 0, 0);
    L.globalAlpha = 1;
    L.globalCompositeOperation = 'source-over';
  }

  let final: HTMLCanvasElement = L.canvas;

  // 4. drop shadow / outer glow underneath
  if ((fx.shadow.enabled && fx.shadow.opacity > 0) || (fx.glow.enabled && fx.glow.opacity > 0)) {
    const F = temp('fx', W, H);
    const OFF = W + 1000;
    if (fx.shadow.enabled && fx.shadow.opacity > 0) {
      const a = (fx.shadow.angle * Math.PI) / 180;
      F.shadowColor = rgba(fx.shadow.color, fx.shadow.opacity);
      F.shadowBlur = fx.shadow.size * k;
      F.shadowOffsetX = -Math.cos(a) * fx.shadow.distance * k + OFF;
      F.shadowOffsetY = Math.sin(a) * fx.shadow.distance * k;
      F.drawImage(L.canvas, -OFF, 0);
    }
    if (fx.glow.enabled && fx.glow.opacity > 0) {
      F.shadowColor = rgba(fx.glow.color, fx.glow.opacity);
      F.shadowBlur = fx.glow.size * k;
      F.shadowOffsetX = OFF;
      F.shadowOffsetY = 0;
      const n = Math.max(1, Math.round(fx.glow.strength));
      for (let i = 0; i < n; i++) F.drawImage(L.canvas, -OFF, 0);
    }
    F.shadowColor = 'transparent';
    F.shadowBlur = 0;
    F.shadowOffsetX = 0;
    F.shadowOffsetY = 0;
    F.drawImage(L.canvas, 0, 0);
    final = F.canvas;
  }

  ctx.globalAlpha = layer.opacity;
  ctx.globalCompositeOperation = layer.blend;
  ctx.drawImage(final, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}

/** Render a small thumbnail of a single layer source. */
export function drawThumb(layer: Layer, doc: Doc, c: HTMLCanvasElement, which: 'source' | 'mask') {
  const ctx = c.getContext('2d')!;
  ctx.clearRect(0, 0, c.width, c.height);
  const src = which === 'mask' ? layer.mask : getSource(layer, doc);
  if (!src) return;
  const s = Math.min(c.width / src.width, c.height / src.height);
  const w = src.width * s;
  const h = src.height * s;
  if (which === 'mask') {
    ctx.fillStyle = '#000';
    ctx.fillRect((c.width - w) / 2, (c.height - h) / 2, w, h);
  }
  ctx.drawImage(src, (c.width - w) / 2, (c.height - h) / 2, w, h);
}
