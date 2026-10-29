import { createCanvas } from './types';

export type StrokeMode = 'paint' | 'erase' | 'reveal' | 'hide';

export interface PixelPatch {
  x: number;
  y: number;
  before: ImageData;
  after: ImageData;
}

/** One brush stroke painted directly into a target canvas (layer pixels or mask). */
export class Stroke {
  private ctx: CanvasRenderingContext2D;
  private backup: HTMLCanvasElement;
  private stamp: HTMLCanvasElement;
  private radius: number;
  private spacing: number;
  private last: { x: number; y: number } | null = null;
  private minX = Infinity;
  private minY = Infinity;
  private maxX = -Infinity;
  private maxY = -Infinity;
  private mode: StrokeMode;
  private clip: HTMLCanvasElement | null;
  private dabCanvas: HTMLCanvasElement | null = null;
  readonly target: HTMLCanvasElement;

  /** `clip` (same size as target) limits painting to its opaque area, e.g. the active selection. */
  constructor(
    target: HTMLCanvasElement,
    mode: StrokeMode,
    color: string,
    diameter: number,
    hardness: number,
    opacity: number,
    clip: HTMLCanvasElement | null = null,
  ) {
    this.target = target;
    this.clip = clip;
    this.mode = mode;
    this.ctx = target.getContext('2d', { willReadFrequently: true })!;
    this.backup = createCanvas(target.width, target.height);
    this.backup.getContext('2d')!.drawImage(target, 0, 0);
    this.radius = Math.max(0.5, diameter / 2);
    this.spacing = Math.max(0.5, diameter * 0.1);
    // per-dab alpha so ~10 overlapping dabs reach the chosen opacity
    const overlaps = Math.max(1, (this.radius * 2) / this.spacing);
    const op = Math.min(1, Math.max(0.01, opacity / 100));
    const dabAlpha = op >= 1 ? 1 : 1 - Math.pow(1 - op, 1 / overlaps);
    this.stamp = makeStamp(this.radius, hardness / 100, mode === 'reveal' ? '#ffffff' : color, dabAlpha);
  }

  private dab(x: number, y: number) {
    const r = this.radius;
    this.ctx.globalCompositeOperation = this.mode === 'erase' || this.mode === 'hide' ? 'destination-out' : 'source-over';
    const sx = x - this.stamp.width / 2;
    const sy = y - this.stamp.height / 2;
    if (this.clip) {
      if (!this.dabCanvas) this.dabCanvas = createCanvas(this.stamp.width, this.stamp.height);
      const d = this.dabCanvas.getContext('2d')!;
      d.globalCompositeOperation = 'copy';
      d.drawImage(this.stamp, 0, 0);
      d.globalCompositeOperation = 'destination-in';
      d.drawImage(this.clip, -sx, -sy);
      this.ctx.drawImage(this.dabCanvas, sx, sy);
    } else {
      this.ctx.drawImage(this.stamp, sx, sy);
    }
    this.ctx.globalCompositeOperation = 'source-over';
    this.minX = Math.min(this.minX, x - r - 2);
    this.minY = Math.min(this.minY, y - r - 2);
    this.maxX = Math.max(this.maxX, x + r + 2);
    this.maxY = Math.max(this.maxY, y + r + 2);
  }

  to(x: number, y: number) {
    if (!this.last) {
      this.dab(x, y);
      this.last = { x, y };
      return;
    }
    const dx = x - this.last.x;
    const dy = y - this.last.y;
    const dist = Math.hypot(dx, dy);
    if (dist < this.spacing) return;
    const steps = Math.floor(dist / this.spacing);
    for (let i = 1; i <= steps; i++) {
      this.dab(this.last.x + (dx * i) / steps, this.last.y + (dy * i) / steps);
    }
    this.last = { x, y };
  }

  /** Returns before/after pixels of the touched region for undo, or null if nothing changed. */
  finish(): PixelPatch | null {
    if (!isFinite(this.minX)) return null;
    const x = Math.max(0, Math.floor(this.minX));
    const y = Math.max(0, Math.floor(this.minY));
    const x2 = Math.min(this.target.width, Math.ceil(this.maxX));
    const y2 = Math.min(this.target.height, Math.ceil(this.maxY));
    if (x2 <= x || y2 <= y) return null;
    const after = this.ctx.getImageData(x, y, x2 - x, y2 - y);
    const before = this.backup.getContext('2d', { willReadFrequently: true })!.getImageData(x, y, x2 - x, y2 - y);
    return { x, y, before, after };
  }
}

function makeStamp(radius: number, hardness: number, color: string, alpha: number): HTMLCanvasElement {
  const size = Math.ceil(radius * 2) + 2;
  const c = createCanvas(size, size);
  const ctx = c.getContext('2d')!;
  const cx = size / 2;
  const g = ctx.createRadialGradient(cx, cx, 0, cx, cx, radius);
  const h = Math.min(0.99, Math.max(0, hardness));
  ctx.globalAlpha = alpha;
  g.addColorStop(0, color);
  g.addColorStop(h, color);
  g.addColorStop(1, hexAlpha(color, 0));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cx, radius, 0, Math.PI * 2);
  ctx.fill();
  return c;
}

function hexAlpha(hex: string, a: number): string {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export function applyPatch(target: HTMLCanvasElement, patch: PixelPatch, which: 'before' | 'after') {
  target.getContext('2d')!.putImageData(which === 'before' ? patch.before : patch.after, patch.x, patch.y);
}

/**
 * Clone-stamp stroke: copies pixels from `source` (a snapshot of the layer) shifted by (ox, oy)
 * into the target through a soft brush. Also records where it painted, for the healing step.
 */
export class CloneStroke {
  private ctx: CanvasRenderingContext2D;
  private backup: HTMLCanvasElement;
  private stamp: HTMLCanvasElement;
  private dabCanvas: HTMLCanvasElement;
  readonly coverage: HTMLCanvasElement;
  private covCtx: CanvasRenderingContext2D;
  private radius: number;
  private spacing: number;
  private last: { x: number; y: number } | null = null;
  minX = Infinity;
  minY = Infinity;
  maxX = -Infinity;
  maxY = -Infinity;
  readonly target: HTMLCanvasElement;
  readonly source: HTMLCanvasElement;
  readonly ox: number;
  readonly oy: number;

  constructor(target: HTMLCanvasElement, source: HTMLCanvasElement, ox: number, oy: number, diameter: number, hardness: number, opacity: number) {
    this.target = target;
    this.source = source;
    this.ox = ox;
    this.oy = oy;
    this.ctx = target.getContext('2d', { willReadFrequently: true })!;
    this.backup = createCanvas(target.width, target.height);
    this.backup.getContext('2d')!.drawImage(target, 0, 0);
    this.radius = Math.max(0.5, diameter / 2);
    this.spacing = Math.max(0.5, diameter * 0.1);
    const overlaps = Math.max(1, (this.radius * 2) / this.spacing);
    const op = Math.min(1, Math.max(0.01, opacity / 100));
    const dabAlpha = op >= 1 ? 1 : 1 - Math.pow(1 - op, 1 / overlaps);
    this.stamp = makeStamp(this.radius, hardness / 100, '#ffffff', dabAlpha);
    this.dabCanvas = createCanvas(this.stamp.width, this.stamp.height);
    this.coverage = createCanvas(target.width, target.height);
    this.covCtx = this.coverage.getContext('2d')!;
  }

  private dab(x: number, y: number) {
    const r = this.radius;
    const sx = x - this.stamp.width / 2;
    const sy = y - this.stamp.height / 2;
    const d = this.dabCanvas.getContext('2d')!;
    d.globalCompositeOperation = 'copy';
    d.drawImage(this.source, -(sx + this.ox), -(sy + this.oy));
    d.globalCompositeOperation = 'destination-in';
    d.drawImage(this.stamp, 0, 0);
    this.ctx.drawImage(this.dabCanvas, sx, sy);
    this.covCtx.drawImage(this.stamp, sx, sy);
    this.minX = Math.min(this.minX, x - r - 2);
    this.minY = Math.min(this.minY, y - r - 2);
    this.maxX = Math.max(this.maxX, x + r + 2);
    this.maxY = Math.max(this.maxY, y + r + 2);
  }

  to(x: number, y: number) {
    if (!this.last) {
      this.dab(x, y);
      this.last = { x, y };
      return;
    }
    const dx = x - this.last.x;
    const dy = y - this.last.y;
    const dist = Math.hypot(dx, dy);
    if (dist < this.spacing) return;
    const steps = Math.floor(dist / this.spacing);
    for (let i = 1; i <= steps; i++) this.dab(this.last.x + (dx * i) / steps, this.last.y + (dy * i) / steps);
    this.last = { x, y };
  }

  bounds() {
    if (!isFinite(this.minX)) return null;
    const x = Math.max(0, Math.floor(this.minX));
    const y = Math.max(0, Math.floor(this.minY));
    const x2 = Math.min(this.target.width, Math.ceil(this.maxX));
    const y2 = Math.min(this.target.height, Math.ceil(this.maxY));
    return x2 > x && y2 > y ? { x, y, w: x2 - x, h: y2 - y } : null;
  }

  /** Before/after pixels for undo. */
  finish(): PixelPatch | null {
    const b = this.bounds();
    if (!b) return null;
    const after = this.ctx.getImageData(b.x, b.y, b.w, b.h);
    const before = this.backup.getContext('2d', { willReadFrequently: true })!.getImageData(b.x, b.y, b.w, b.h);
    return { x: b.x, y: b.y, before, after };
  }

  /** The original (pre-stroke) pixels. */
  original(): HTMLCanvasElement {
    return this.backup;
  }
}

/** A soft round white dab, useful for painting masks and coverage. */
export function softStamp(radius: number, hardness: number, alpha = 1): HTMLCanvasElement {
  return makeStamp(radius, hardness, '#ffffff', alpha);
}
