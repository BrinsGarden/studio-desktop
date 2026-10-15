import { createCanvas, type Doc, type Layer } from './types';
import { layerMatrix, sourceSize } from './render';

export interface Pt {
  x: number;
  y: number;
}

/** One closed shape in document coordinates, added to or subtracted from the selection. */
export interface SelShape {
  op: 'add' | 'sub';
  pts: Pt[];
}

export interface Selection {
  shapes: SelShape[];
}

export type SelectMode = 'lasso' | 'polygon' | 'rect' | 'ellipse';

export function rectPts(a: Pt, b: Pt): Pt[] {
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
}

export function ellipsePts(a: Pt, b: Pt, n = 96): Pt[] {
  const cx = (a.x + b.x) / 2;
  const cy = (a.y + b.y) / 2;
  const rx = Math.abs(b.x - a.x) / 2;
  const ry = Math.abs(b.y - a.y) / 2;
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    out.push({ x: cx + Math.cos(t) * rx, y: cy + Math.sin(t) * ry });
  }
  return out;
}

export function polyArea(pts: Pt[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a / 2);
}

/** Drop points closer than `min` to the previous kept point. */
export function simplify(pts: Pt[], min: number): Pt[] {
  if (pts.length < 3) return pts.slice();
  const out: Pt[] = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const l = out[out.length - 1];
    if (Math.hypot(pts[i].x - l.x, pts[i].y - l.y) >= min) out.push(pts[i]);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

export function addShape(sel: Selection | null, shape: SelShape, replace: boolean): Selection | null {
  if (shape.pts.length < 3) return sel;
  if (replace || !sel) return shape.op === 'sub' ? null : { shapes: [{ op: 'add', pts: shape.pts }] };
  return { shapes: [...sel.shapes, shape] };
}

export function selectAll(doc: Doc): Selection {
  return { shapes: [{ op: 'add', pts: rectPts({ x: 0, y: 0 }, { x: doc.width, y: doc.height }) }] };
}

/** Everything outside the current selection. */
export function invertSelection(sel: Selection | null, doc: Doc): Selection | null {
  if (!sel) return selectAll(doc);
  return {
    shapes: [
      { op: 'add', pts: rectPts({ x: -1, y: -1 }, { x: doc.width + 1, y: doc.height + 1 }) },
      ...sel.shapes.map((s) => ({ op: (s.op === 'add' ? 'sub' : 'add') as SelShape['op'], pts: s.pts })),
    ],
  };
}

function tracePath(ctx: CanvasRenderingContext2D, pts: Pt[]) {
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.closePath();
}

/**
 * Rasterize the selection into a layer's local (source) pixel space.
 * Opaque white = selected. `feather` is in document pixels.
 */
export function selectionMaskForLayer(sel: Selection, layer: Layer, doc: Doc, feather: number): HTMLCanvasElement {
  const { w, h } = sourceSize(layer, doc);
  const inv = layerMatrix(layer, w, h).inverse();
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d')!;
  ctx.setTransform(inv);
  ctx.fillStyle = '#fff';
  for (const s of sel.shapes) {
    ctx.globalCompositeOperation = s.op === 'add' ? 'source-over' : 'destination-out';
    tracePath(ctx, s.pts);
    ctx.fill();
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  const scale = layer.kind === 'adjust' ? 1 : Math.abs(layer.scale);
  const r = feather / Math.max(0.001, scale);
  if (r <= 0.3) return c;
  const out = createCanvas(w, h);
  const octx = out.getContext('2d')!;
  octx.filter = `blur(${r / 2}px)`;
  octx.drawImage(c, 0, 0);
  return out;
}

/** Bounding box of the selection in a layer's local space (clamped to the source), or null if empty. */
export function selectionLocalBounds(sel: Selection, layer: Layer, doc: Doc, feather: number) {
  const { w, h } = sourceSize(layer, doc);
  const inv = layerMatrix(layer, w, h).inverse();
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const s of sel.shapes) {
    if (s.op !== 'add') continue;
    for (const p of s.pts) {
      const q = inv.transformPoint(new DOMPoint(p.x, p.y));
      x0 = Math.min(x0, q.x);
      y0 = Math.min(y0, q.y);
      x1 = Math.max(x1, q.x);
      y1 = Math.max(y1, q.y);
    }
  }
  const scale = layer.kind === 'adjust' ? 1 : Math.abs(layer.scale);
  const pad = feather / Math.max(0.001, scale) + 2;
  x0 = Math.max(0, Math.floor(x0 - pad));
  y0 = Math.max(0, Math.floor(y0 - pad));
  x1 = Math.min(w, Math.ceil(x1 + pad));
  y1 = Math.min(h, Math.ceil(y1 + pad));
  if (!(x1 > x0 && y1 > y0)) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Draw marching ants for a list of shapes (already in screen coordinates). */
export function drawAnts(ctx: CanvasRenderingContext2D, shapes: Pt[][], closed: boolean, offset: number) {
  ctx.save();
  ctx.lineWidth = 1;
  for (const [color, dashOffset] of [
    ['#000', offset],
    ['#fff', offset + 4],
  ] as const) {
    ctx.strokeStyle = color;
    ctx.setLineDash([4, 4]);
    ctx.lineDashOffset = dashOffset;
    for (const pts of shapes) {
      if (pts.length < 2) continue;
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      if (closed) ctx.closePath();
      ctx.stroke();
    }
  }
  ctx.restore();
}
