import { createCanvas, type SwirlProps } from './types';
import { hexToRgb } from './adjust';

interface Sample {
  x: number;
  y: number;
  nx: number;
  ny: number;
  s: number;
}

/** Seeded PRNG so sparkles stay put between renders. */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Catmull-Rom smooth the path, then resample at even arc-length spacing with normals. */
export function samplePath(points: [number, number][], spacing: number): { samples: Sample[]; length: number } {
  if (points.length < 2) return { samples: [], length: 0 };
  const dense: [number, number][] = [];
  const P = (i: number) => points[Math.max(0, Math.min(points.length - 1, i))];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = P(i - 1);
    const p1 = P(i);
    const p2 = P(i + 1);
    const p3 = P(i + 2);
    const seg = Math.max(2, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / Math.max(1, spacing / 2)));
    for (let j = 0; j < seg; j++) {
      const t = j / seg;
      const t2 = t * t;
      const t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) =>
        0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      dense.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  dense.push(points[points.length - 1]);

  const out: Sample[] = [];
  let acc = 0;
  let next = 0;
  for (let i = 1; i < dense.length; i++) {
    const [ax, ay] = dense[i - 1];
    const [bx, by] = dense[i];
    const d = Math.hypot(bx - ax, by - ay);
    if (d === 0) continue;
    while (next <= acc + d) {
      const t = (next - acc) / d;
      const tx = (bx - ax) / d;
      const ty = (by - ay) / d;
      out.push({ x: ax + (bx - ax) * t, y: ay + (by - ay) * t, nx: -ty, ny: tx, s: next });
      next += spacing;
    }
    acc += d;
  }
  // smooth normals a little so tight corners don't kink the ribbon
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 1; i < out.length - 1; i++) {
      const nx = out[i - 1].nx + out[i].nx * 2 + out[i + 1].nx;
      const ny = out[i - 1].ny + out[i].ny * 2 + out[i + 1].ny;
      const l = Math.hypot(nx, ny) || 1;
      out[i].nx = nx / l;
      out[i].ny = ny / l;
    }
  }
  return { samples: out, length: acc };
}

function paletteAt(pal: [number, number, number][], t: number): [number, number, number] {
  if (pal.length === 1) return pal[0];
  const x = (((t % 1) + 1) % 1) * (pal.length - 1);
  const i = Math.min(pal.length - 2, Math.floor(x));
  const f = x - i;
  const a = pal[i];
  const b = pal[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

const smooth = (e0: number, e1: number, x: number) => {
  if (e1 <= e0) return x >= e1 ? 1 : 0;
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

export function swirlMargin(p: SwirlProps) {
  return Math.ceil(p.amplitude + p.width * 2 + p.glow * 2.5 + 12);
}

/** Render the swirl into its own canvas; the path's center sits at the canvas center. */
export function renderSwirl(p: SwirlProps): HTMLCanvasElement {
  let ex = 1;
  let ey = 1;
  for (const [x, y] of p.points) {
    ex = Math.max(ex, Math.abs(x));
    ey = Math.max(ey, Math.abs(y));
  }
  const m = swirlMargin(p);
  const W = Math.min(8000, Math.ceil((ex + m) * 2));
  const H = Math.min(8000, Math.ceil((ey + m) * 2));
  const ox = W / 2;
  const oy = H / 2;

  const { samples, length } = samplePath(p.points, Math.max(1.5, p.width / 4));
  const out = createCanvas(W, H);
  if (samples.length < 2 || length < 1) return out;
  const pal = (p.palette.length ? p.palette : ['#ffffff']).map(hexToRgb);

  const ribbon = createCanvas(W, H);
  const rc = ribbon.getContext('2d')!;
  rc.lineCap = 'round';
  rc.lineJoin = 'round';
  const strands = Math.max(1, Math.round(p.strands));
  const taper = Math.min(0.5, Math.max(0, p.taper));
  const rand = mulberry32(p.seed);
  const sparkleSpots: { x: number; y: number; c: [number, number, number]; front: number }[] = [];

  // draw back halves first, then front halves, so fronts overlap backs
  for (const pass of ['back', 'front'] as const) {
    for (let k = 0; k < strands; k++) {
      const phase = (k / strands) * Math.PI * 2;
      const colorShift = k / strands / 2;
      let prev: { x: number; y: number } | null = null;
      for (let i = 0; i < samples.length; i++) {
        const sm = samples[i];
        const t = sm.s / length;
        const env = smooth(0, taper, t) * smooth(0, taper, 1 - t);
        const ang = Math.PI * 2 * p.wraps * t + phase;
        const off = p.amplitude * Math.sin(ang) * (0.35 + 0.65 * env);
        const depthVal = Math.cos(ang); // >0 = in front
        const x = ox + sm.x + sm.nx * off;
        const y = oy + sm.y + sm.ny * off;
        const isFront = depthVal >= 0;
        if (prev && (pass === 'front') === isFront) {
          const front = (depthVal + 1) / 2;
          const alpha = Math.max(0.05, 1 - p.depth * (1 - front)) * (0.15 + 0.85 * env);
          const lw = Math.max(0.5, p.width * (0.25 + 0.75 * env) * (0.6 + 0.4 * front));
          const [r, g, b] = paletteAt(pal, t + colorShift);
          rc.strokeStyle = `rgba(${r | 0},${g | 0},${b | 0},${alpha})`;
          rc.lineWidth = lw;
          rc.beginPath();
          rc.moveTo(prev.x, prev.y);
          rc.lineTo(x, y);
          rc.stroke();
          if (isFront && env > 0.3) {
            // bright core on the front side
            rc.strokeStyle = `rgba(255,255,255,${0.55 * alpha * front})`;
            rc.lineWidth = lw * 0.28;
            rc.stroke();
          }
        }
        if (pass === 'front' && env > 0.15 && rand() < 0.04) sparkleSpots.push({ x, y, c: paletteAt(pal, t + colorShift), front: (depthVal + 1) / 2 });
        prev = { x, y };
      }
    }
  }

  const oc = out.getContext('2d')!;
  if (p.glow > 0) {
    oc.globalCompositeOperation = 'lighter';
    oc.filter = `blur(${p.glow}px)`;
    oc.drawImage(ribbon, 0, 0);
    oc.filter = `blur(${p.glow / 3}px)`;
    oc.drawImage(ribbon, 0, 0);
    oc.filter = 'none';
    oc.globalCompositeOperation = 'source-over';
  }
  oc.drawImage(ribbon, 0, 0);

  // sparkles: a few along the strands plus some scattered nearby
  const count = Math.max(0, Math.round(p.sparkles));
  oc.globalCompositeOperation = 'lighter';
  for (let i = 0; i < count; i++) {
    let x: number;
    let y: number;
    let c: [number, number, number];
    if (sparkleSpots.length && rand() < 0.6) {
      const s = sparkleSpots[Math.floor(rand() * sparkleSpots.length)];
      x = s.x;
      y = s.y;
      c = s.c;
    } else {
      const sm = samples[Math.floor(rand() * samples.length)];
      const spread = p.amplitude * 1.6 + p.width * 2;
      const o = (rand() * 2 - 1) * spread;
      x = ox + sm.x + sm.nx * o + (rand() * 2 - 1) * p.width;
      y = oy + sm.y + sm.ny * o + (rand() * 2 - 1) * p.width;
      c = paletteAt(pal, sm.s / length);
    }
    const r = Math.max(1.5, p.width * (0.25 + rand() * 0.6));
    drawSparkle(oc, x, y, r, c, 0.5 + rand() * 0.5);
  }
  oc.globalCompositeOperation = 'source-over';
  return out;
}

function drawSparkle(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, c: [number, number, number], a: number) {
  const col = `${c[0] | 0},${c[1] | 0},${c[2] | 0}`;
  const g = ctx.createRadialGradient(x, y, 0, x, y, r * 2.2);
  g.addColorStop(0, `rgba(255,255,255,${a})`);
  g.addColorStop(0.25, `rgba(${col},${a * 0.8})`);
  g.addColorStop(1, `rgba(${col},0)`);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r * 2.2, 0, Math.PI * 2);
  ctx.fill();
  // 4-point star rays
  ctx.strokeStyle = `rgba(255,255,255,${a * 0.85})`;
  ctx.lineCap = 'round';
  ctx.lineWidth = Math.max(0.6, r * 0.18);
  ctx.beginPath();
  ctx.moveTo(x - r * 3, y);
  ctx.lineTo(x + r * 3, y);
  ctx.moveTo(x, y - r * 3);
  ctx.lineTo(x, y + r * 3);
  ctx.stroke();
}

/** Turn a drawn doc-space path into swirl points centered on the path's bounding box. */
export function centerPath(pts: { x: number; y: number }[]): { center: { x: number; y: number }; points: [number, number][] } {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of pts) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  return { center: { x: cx, y: cy }, points: pts.map((p) => [p.x - cx, p.y - cy] as [number, number]) };
}
