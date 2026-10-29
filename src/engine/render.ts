import { applyAdjustments, computeStats, despill, isIdentity, keyOutColor, processEdges, hexToRgb, type ChannelStats } from './adjust';
import { createCanvas, type BlendIf, type Doc, type Layer, type TextProps, type FillProps } from './types';
import { MESH_N, drawMesh, isIdentityMesh, meshGrid } from './mesh';
import { renderSwirl } from './swirl';
import { renderFire } from './fire';
import { renderFog } from './fog';

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
const swirlCache = new Map<string, { key: string; canvas: HTMLCanvasElement }>();
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
    if (t.midEnabled && t.midColor) {
      const m = Math.min(0.98, Math.max(0.02, (t.midPos ?? 50) / 100));
      const half = (1 - Math.min(100, Math.max(0, t.midSharp ?? 0)) / 100) * Math.min(m, 1 - m) * 0.9;
      if (half > 0.001) {
        g.addColorStop(Math.max(0, m - half), t.color);
        g.addColorStop(m, t.midColor);
        g.addColorStop(Math.min(1, m + half), t.color2);
      } else {
        g.addColorStop(m, t.midColor);
      }
    }
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
  if (f.type === 'fog') {
    return renderFog({ color: f.color1, density: f.alpha1, height: f.fogHeight ?? 0.3, wisp: f.wisp ?? 0.7, seed: f.seed ?? 7 }, w, h);
  }
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
  if (layer.kind === 'swirl' && layer.swirl) {
    const key = JSON.stringify(layer.swirl);
    const hit = swirlCache.get(layer.id);
    if (hit && hit.key === key) return hit.canvas;
    const canvas = layer.swirl.style === 'fire' ? renderFire(layer.swirl) : renderSwirl(layer.swirl);
    swirlCache.set(layer.id, { key, canvas });
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
  // fills, gradients and fog cover the page, so clicks pass through them (pick them in the Layers list)
  if (!layer.visible || layer.kind === 'adjust' || layer.kind === 'fill') return false;
  const src = getSource(layer, doc);
  if (!src) return false;
  const p = docToLocal(layer, doc, x, y);
  if (p.x < 0 || p.y < 0 || p.x >= src.width || p.y >= src.height) return false;
  const px = src.getContext('2d')!.getImageData(Math.floor(p.x), Math.floor(p.y), 1, 1).data;
  if (layer.fx.key?.enabled) {
    keyOutColor(px, hexToRgb(layer.fx.key.color), layer.fx.key.tolerance, layer.fx.key.softness);
    despill(px, hexToRgb(layer.fx.key.color), layer.fx.key.despill ?? 0);
  }
  if (px[3] < 20) return false;
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
  return !isIdentity(layer.adj) || layer.fx.shrinkEdge > 0 || layer.fx.softenEdge > 0 || !!layer.fx.key?.enabled;
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
    JSON.stringify(layer.fx.key ?? null),
    layer.fx.softenEdge,
    tStats ? tStats.mean.join(',') + tStats.std.join(',') : '',
    src === layer.canvas ? '' : JSON.stringify(layer.text ?? layer.fill ?? layer.swirl) + fontEpoch,
  ].join('|');
  const hit = adjustedCache.get(layer.id);
  if (hit && hit.key === key) return hit.canvas;
  const c = hit?.canvas && hit.canvas.width === w && hit.canvas.height === h ? hit.canvas : createCanvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(src, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  if (layer.fx.key?.enabled) {
    keyOutColor(img.data, hexToRgb(layer.fx.key.color), layer.fx.key.tolerance, layer.fx.key.softness);
    despill(img.data, hexToRgb(layer.fx.key.color), layer.fx.key.despill ?? 0);
  }
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
  swirlCache.delete(layerId);
  fillCache.delete(layerId);
}

/* ---------------- main render ---------------- */
/** Temporary masks shown while the Cutout tool is open (never exported). Keyed by layer id. */
export const previewMasks = new Map<string, HTMLCanvasElement>();
let usePreview = false;

export interface RenderOptions {
  /** Draw the doc background color (otherwise transparent). */
  background?: boolean;
  /** Show only this layer's mask as grayscale. */
  showMaskOf?: string | null;
  /** Apply Cutout-tool preview masks (viewport only). */
  preview?: boolean;
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

  usePreview = !!opts.preview;
  if (opts.showMaskOf) {
    const l = doc.layers.find((x) => x.id === opts.showMaskOf);
    const pm = usePreview ? previewMasks.get(opts.showMaskOf) : undefined;
    if (l && (l.mask || pm)) {
      const { w, h } = sourceSize(l, doc);
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, H);
      const m = layerMatrix(l, w, h);
      ctx.setTransform(new DOMMatrix().scale(k, k).multiply(m));
      ctx.drawImage((pm ?? l.mask)!, 0, 0, w, h);
      usePreview = false;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      return;
    }
  }

  const layers = doc.layers;
  let i = 0;
  while (i < layers.length) {
    const base = layers[i];
    let j = i + 1;
    while (j < layers.length && layers[j].clip) j++;
    const clipped = base.kind === 'adjust' ? [] : layers.slice(i + 1, j);
    if (!clipped.length || base.kind === 'adjust') {
      if (base.visible && base.opacity > 0) {
        if (base.kind === 'adjust') drawAdjustLayer(doc, base, ctx, W, H, k);
        else drawPixelLayer(doc, base, ctx, W, H, k);
      }
      i += 1;
      continue;
    }
    // clipping group: clipped layers only show where the base layer has pixels
    if (base.visible && base.opacity > 0) {
      const G = temp('group', W, H);
      drawPixelLayer(doc, { ...base, opacity: 1, blend: 'source-over', blendIf: undefined }, G, W, H, k);
      for (const c of clipped) {
        if (!c.visible || c.opacity <= 0) continue;
        if (c.kind === 'adjust') {
          drawAdjustLayer(doc, c, G, W, H, k);
          continue;
        }
        const fin = renderPixelLayer(doc, c, W, H, k);
        if (fin) compositeFinal(G, fin, c, W, H, G.canvas);
      }
      compositeFinal(ctx, G.canvas, base, W, H, null);
    }
    i = j;
  }
  usePreview = false;
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
  const fin = renderPixelLayer(doc, layer, W, H, k);
  if (fin) compositeFinal(ctx, fin, layer, W, H, null);
}

const lum8 = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;

function rampFactor(v: number, lo: [number, number], hi: [number, number]): number {
  let f = 1;
  if (v < lo[1]) f = lo[1] > lo[0] ? Math.max(0, (v - lo[0]) / (lo[1] - lo[0])) : v < lo[0] ? 0 : 1;
  if (v > hi[0]) f *= hi[1] > hi[0] ? Math.max(0, (hi[1] - v) / (hi[1] - hi[0])) : v > hi[1] ? 0 : 1;
  return f;
}

export function blendIfActive(b: BlendIf | undefined): b is BlendIf {
  return !!b && b.enabled && (b.thisLo[1] > 0 || b.thisHi[0] < 255 || b.underLo[1] > 0 || b.underHi[0] < 255);
}

/** Draw a rendered layer onto `target` using its opacity, blend mode, Blend If, and optional clipping base. */
function compositeFinal(target: CanvasRenderingContext2D, src: HTMLCanvasElement, layer: Layer, W: number, H: number, clipTo: HTMLCanvasElement | null) {
  let img: HTMLCanvasElement = src;
  if (blendIfActive(layer.blendIf) || clipTo) {
    const T = temp('compose', W, H);
    T.drawImage(src, 0, 0);
    if (blendIfActive(layer.blendIf)) {
      const bi = layer.blendIf;
      const top = T.getImageData(0, 0, W, H);
      const under = target.getImageData(0, 0, W, H);
      const d = top.data;
      const u = under.data;
      for (let p = 0; p < d.length; p += 4) {
        if (d[p + 3] === 0) continue;
        const f = rampFactor(lum8(d[p], d[p + 1], d[p + 2]), bi.thisLo, bi.thisHi) * rampFactor(lum8(u[p], u[p + 1], u[p + 2]), bi.underLo, bi.underHi);
        if (f < 1) d[p + 3] = Math.round(d[p + 3] * f);
      }
      T.putImageData(top, 0, 0);
    }
    if (clipTo) {
      T.globalCompositeOperation = 'destination-in';
      T.drawImage(clipTo, 0, 0);
      T.globalCompositeOperation = 'source-over';
    }
    img = T.canvas;
  }
  target.globalAlpha = layer.opacity;
  target.globalCompositeOperation = clipTo && layer.blend === 'source-over' ? 'source-atop' : layer.blend;
  target.drawImage(img, 0, 0);
  target.globalAlpha = 1;
  target.globalCompositeOperation = 'source-over';
}

/** Render one image/text/fill/swirl layer with its mask and effects into a doc-sized canvas (not yet composited). */
function renderPixelLayer(doc: Doc, layer: Layer, W: number, H: number, k: number): HTMLCanvasElement | null {
  const src = getSource(layer, doc);
  if (!src) return null;
  if (layer.kind === 'text' || layer.kind === 'swirl') syncMaskSize(layer, doc);
  const w = src.width;
  const h = src.height;
  const f = Math.min(1, Math.max(0.02, k * layer.scale));
  const adj = adjustedSource(layer, doc, f);
  if (!adj) return null;
  const m = new DOMMatrix().scale(k, k).multiply(layerMatrix(layer, w, h));
  const fx = layer.fx;

  // 1. layer pixels (+ blur) into L
  const L = temp('layer', W, H);
  const pm = usePreview ? previewMasks.get(layer.id) : undefined;
  const warped = !!layer.mesh && !isIdentityMesh(layer.mesh);
  if (warped) {
    // mask first (in the layer's own space), then bend the result
    const M = temp('meshSrc', adj.width, adj.height);
    M.drawImage(adj, 0, 0);
    M.globalCompositeOperation = 'destination-in';
    if (layer.mask && layer.maskEnabled) M.drawImage(layer.mask, 0, 0, adj.width, adj.height);
    if (pm) M.drawImage(pm, 0, 0, adj.width, adj.height);
    M.globalCompositeOperation = 'source-over';
    L.setTransform(m);
    if (fx.blur > 0) L.filter = `blur(${fx.blur * k}px)`;
    const scaleOut = Math.max(1e-3, Math.abs(layer.scale) * k);
    drawMesh(L, M.canvas, w, h, meshGrid(layer.mesh!, MESH_N), MESH_N, 0.6 / scaleOut);
    L.filter = 'none';
    L.setTransform(1, 0, 0, 1, 0, 0);
  } else {
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
    if (pm) {
      L.globalCompositeOperation = 'destination-in';
      L.drawImage(pm, 0, 0, w, h);
      L.globalCompositeOperation = 'source-over';
    }
    L.setTransform(1, 0, 0, 1, 0, 0);
  }

  // 2b. color overlay
  if (fx.overlay?.enabled && fx.overlay.opacity > 0) {
    L.globalCompositeOperation = 'source-atop';
    L.fillStyle = rgba(fx.overlay.color, fx.overlay.opacity);
    L.fillRect(0, 0, W, H);
    L.globalCompositeOperation = 'source-over';
  }

  // 2c. title styles: gradient overlay, inner shadow, inner glow, bevel
  innerEffects(L, layer, doc, W, H, k);

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
  const outlineOn = !!fx.outline?.enabled && fx.outline.opacity > 0 && fx.outline.size > 0;
  if ((fx.shadow.enabled && fx.shadow.opacity > 0) || (fx.glow.enabled && fx.glow.opacity > 0) || outlineOn) {
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
    if (outlineOn) {
      // tinted silhouette stamped in a ring around the layer
      const T = temp('outline', W, H);
      T.drawImage(L.canvas, 0, 0);
      T.globalCompositeOperation = 'source-in';
      T.fillStyle = fx.outline.color;
      T.fillRect(0, 0, W, H);
      const O = temp('outline2', W, H);
      const r = fx.outline.size * k;
      const steps = Math.min(32, Math.max(12, Math.round(r * 2)));
      for (let i = 0; i < steps; i++) {
        const a = (i / steps) * Math.PI * 2;
        O.drawImage(T.canvas, Math.cos(a) * r, Math.sin(a) * r);
      }
      O.drawImage(T.canvas, 0, 0);
      F.globalAlpha = fx.outline.opacity;
      F.drawImage(O.canvas, 0, 0);
      F.globalAlpha = 1;
    }
    F.drawImage(L.canvas, 0, 0);
    final = F.canvas;
  }
  return final;
}

/** Bounding box of a layer on the output canvas (pixels), padded and clamped. */
function outBox(layer: Layer, doc: Doc, k: number, W: number, H: number, pad: number) {
  const pts = layerCorners(layer, doc);
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of pts) {
    x0 = Math.min(x0, p.x * k);
    y0 = Math.min(y0, p.y * k);
    x1 = Math.max(x1, p.x * k);
    y1 = Math.max(y1, p.y * k);
  }
  if (layer.mesh) {
    // bent layers can reach past their box
    const grow = Math.max(x1 - x0, y1 - y0);
    x0 -= grow;
    y0 -= grow;
    x1 += grow;
    y1 += grow;
  }
  const bx = Math.max(0, Math.floor(x0 - pad));
  const by = Math.max(0, Math.floor(y0 - pad));
  const bw = Math.min(W, Math.ceil(x1 + pad)) - bx;
  const bh = Math.min(H, Math.ceil(y1 + pad)) - by;
  return bw > 0 && bh > 0 ? { x: bx, y: by, w: bw, h: bh } : null;
}

function innerEffects(L: CanvasRenderingContext2D, layer: Layer, doc: Doc, W: number, H: number, k: number) {
  const fx = layer.fx;
  const go = fx.gradOverlay;
  const is = fx.innerShadow;
  const ig = fx.innerGlow;
  const bv = fx.bevel;
  const anyOn = (go?.enabled && go.opacity > 0) || (is?.enabled && is.opacity > 0) || (ig?.enabled && ig.opacity > 0) || (bv?.enabled && bv.opacity > 0);
  if (!anyOn) return;
  const box = outBox(layer, doc, k, W, H, 4);
  if (!box) return;

  if (go?.enabled && go.opacity > 0) {
    const G = temp('gradOverlay', W, H);
    const a = (go.angle * Math.PI) / 180;
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;
    const dx = Math.cos(a);
    const dy = -Math.sin(a);
    const half = Math.abs((box.w / 2) * dx) + Math.abs((box.h / 2) * dy);
    const g = G.createLinearGradient(cx - dx * half, cy - dy * half, cx + dx * half, cy + dy * half);
    g.addColorStop(0, go.color2);
    g.addColorStop(1, go.color1);
    G.fillStyle = g;
    G.fillRect(box.x, box.y, box.w, box.h);
    G.globalCompositeOperation = 'destination-in';
    G.drawImage(L.canvas, 0, 0);
    L.globalAlpha = go.opacity;
    L.globalCompositeOperation = go.blend === 'source-over' ? 'source-atop' : go.blend;
    L.drawImage(G.canvas, 0, 0);
    L.globalAlpha = 1;
    L.globalCompositeOperation = 'source-over';
  }

  if (is?.enabled && is.opacity > 0) {
    const a = (is.angle * Math.PI) / 180;
    const ox = -Math.cos(a) * is.distance * k;
    const oy = Math.sin(a) * is.distance * k;
    const S = temp('innerShadow', W, H);
    S.fillStyle = is.color;
    S.fillRect(0, 0, W, H);
    S.globalCompositeOperation = 'destination-out';
    S.drawImage(L.canvas, ox, oy);
    const S2 = temp('innerShadow2', W, H);
    if (is.size > 0) S2.filter = `blur(${(is.size * k) / 2}px)`;
    S2.drawImage(S.canvas, 0, 0);
    S2.filter = 'none';
    S2.globalCompositeOperation = 'destination-in';
    S2.drawImage(L.canvas, 0, 0);
    L.globalAlpha = is.opacity;
    L.globalCompositeOperation = 'source-atop';
    L.drawImage(S2.canvas, 0, 0);
    L.globalAlpha = 1;
    L.globalCompositeOperation = 'source-over';
  }

  if (ig?.enabled && ig.opacity > 0) {
    const S = temp('innerGlow', W, H);
    S.fillStyle = ig.color;
    S.fillRect(0, 0, W, H);
    S.globalCompositeOperation = 'destination-out';
    S.drawImage(L.canvas, 0, 0);
    const S2 = temp('innerGlow2', W, H);
    if (ig.size > 0) S2.filter = `blur(${(ig.size * k) / 2}px)`;
    S2.drawImage(S.canvas, 0, 0);
    S2.drawImage(S.canvas, 0, 0);
    S2.filter = 'none';
    S2.globalCompositeOperation = 'destination-in';
    S2.drawImage(L.canvas, 0, 0);
    L.globalAlpha = ig.opacity;
    L.globalCompositeOperation = 'screen';
    L.drawImage(S2.canvas, 0, 0);
    L.globalAlpha = 1;
    L.globalCompositeOperation = 'source-over';
  }

  if (bv?.enabled && bv.opacity > 0) {
    // height map = blurred alpha; light it from `angle` to get highlights and shadows
    const A = temp('bevelA', W, H);
    A.filter = `blur(${Math.max(0.5, (bv.size * k) / 2)}px)`;
    A.drawImage(L.canvas, 0, 0);
    A.filter = 'none';
    const { x: bx, y: by, w: bw, h: bh } = box;
    const hm = A.getImageData(bx, by, bw, bh).data;
    const base = L.getImageData(bx, by, bw, bh).data;
    const hi = new ImageData(bw, bh);
    const sh = new ImageData(bw, bh);
    const [hr, hg, hb] = hexToRgb(bv.highlight);
    const [sr, sg, sb] = hexToRgb(bv.shadow);
    const a = (bv.angle * Math.PI) / 180;
    const lx = Math.cos(a);
    const ly = -Math.sin(a);
    const gain = ((bv.depth / 100) * 9) / Math.max(1, bv.size * k * 0.25);
    for (let y = 1; y < bh - 1; y++) {
      for (let x = 1; x < bw - 1; x++) {
        const i = (y * bw + x) * 4;
        if (base[i + 3] === 0) continue;
        const dx = (hm[i + 4 + 3] - hm[i - 4 + 3]) / 255;
        const dy = (hm[i + bw * 4 + 3] - hm[i - bw * 4 + 3]) / 255;
        const shade = (dx * lx + dy * ly) * gain;
        const cover = base[i + 3] / 255;
        if (shade > 0) {
          hi.data[i] = hr;
          hi.data[i + 1] = hg;
          hi.data[i + 2] = hb;
          hi.data[i + 3] = Math.min(255, shade * 255 * cover);
        } else if (shade < 0) {
          sh.data[i] = sr;
          sh.data[i + 1] = sg;
          sh.data[i + 2] = sb;
          sh.data[i + 3] = Math.min(255, -shade * 255 * cover);
        }
      }
    }
    const B = temp('bevelB', bw, bh);
    B.putImageData(hi, 0, 0);
    L.globalAlpha = bv.opacity;
    L.globalCompositeOperation = 'screen';
    L.drawImage(B.canvas, bx, by);
    B.clearRect(0, 0, bw, bh);
    B.putImageData(sh, 0, 0);
    L.globalCompositeOperation = 'multiply';
    L.drawImage(B.canvas, bx, by);
    L.globalAlpha = 1;
    L.globalCompositeOperation = 'source-over';
  }
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
