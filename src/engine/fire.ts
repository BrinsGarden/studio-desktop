import { type SwirlProps, createCanvas } from './types';
import { hexToRgb } from './adjust';
import { mulberry32, samplePath } from './swirl';

/*
 * Hellfire: flames that rise straight up (layer-local "up") from every point of a drawn path.
 *
 * Field mapping on SwirlProps when style === 'fire':
 *   amplitude = flame height (px)        width   = flame thickness (px)
 *   wraps     = wildness 0..100          strands = density 1..10
 *   glow      = glow size (px)           sparkles = ember count
 *   taper     = how much the ends die down   palette = [smoke/dark, deep, mid, hot, core]
 *
 * Flames are drawn as a grayscale "heat" field, then colorized through the palette ramp, which
 * gives the white-hot base → orange body → dark red licking tips look of real fire.
 */

const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const smooth = (e0: number, e1: number, x: number) => {
  const t = clamp((x - e0) / Math.max(1e-6, e1 - e0));
  return t * t * (3 - 2 * t);
};

export function fireMargin(p: SwirlProps) {
  return Math.ceil(p.width * 2 + p.glow * 2 + (p.wraps / 100) * p.width * 2 + 16);
}

function buildRamp(palette: string[]): Uint8ClampedArray {
  const pal = (palette.length ? palette : ['#2a0000', '#a30a00', '#ff4a00', '#ffb020', '#fff4c0']).map(hexToRgb);
  const lut = new Uint8ClampedArray(256 * 4);
  for (let i = 0; i < 256; i++) {
    const v = i / 255;
    // heat → palette position; first stop is the dark licking edge
    const x = clamp(Math.pow(v, 0.8)) * (pal.length - 1);
    const k = Math.min(pal.length - 2, Math.floor(x));
    const f = x - k;
    const a = pal[k];
    const b = pal[Math.min(pal.length - 1, k + 1)];
    lut[i * 4] = a[0] + (b[0] - a[0]) * f;
    lut[i * 4 + 1] = a[1] + (b[1] - a[1]) * f;
    lut[i * 4 + 2] = a[2] + (b[2] - a[2]) * f;
    lut[i * 4 + 3] = 255 * smooth(0.01, 0.22, v);
  }
  return lut;
}

export function renderFire(p: SwirlProps): HTMLCanvasElement {
  const height = Math.max(10, p.amplitude);
  const thick = Math.max(4, p.width);
  const wild = clamp(p.wraps / 100);
  const density = Math.max(1, p.strands);
  const taper = clamp(p.taper, 0, 0.5);

  let ex = 1;
  let ey = 1;
  for (const [x, y] of p.points) {
    ex = Math.max(ex, Math.abs(x));
    ey = Math.max(ey, Math.abs(y));
  }
  const m = fireMargin(p);
  const W = Math.min(8000, Math.ceil((ex + m) * 2));
  const H = Math.min(8000, Math.ceil((ey + height * 1.5 + m) * 2));
  const ox = W / 2;
  const oy = H / 2;
  const out = createCanvas(W, H);

  const { samples, length } = samplePath(p.points, Math.max(2, thick / 6));
  if (samples.length < 2 || length < 1) return out;
  const rand = mulberry32(p.seed);
  const envAt = (s: number) => {
    const t = s / length;
    return taper <= 0 ? 1 : smooth(0, taper, t) * smooth(0, taper, 1 - t);
  };
  const sampleAt = (s: number) => samples[Math.min(samples.length - 1, Math.max(0, Math.round((s / length) * (samples.length - 1))))];

  // ---- heat field ----
  // each tongue adds only a little heat so overlaps build up instead of clipping to white
  const heatScale = 0.6 / Math.sqrt(density);
  const heat = createCanvas(W, H);
  const hc = heat.getContext('2d')!;
  hc.globalCompositeOperation = 'lighter';

  const tongue = (bx: number, by: number, h: number, w: number, strength: number) => {
    const N = 28;
    const phase = rand() * Math.PI * 2;
    const phase2 = rand() * Math.PI * 2;
    const freq = 0.6 + rand() * 1.1;
    const sway = (0.25 + wild * 1.6) * w * (0.6 + rand() * 0.8);
    const lean = (rand() * 2 - 1) * wild * w * 0.8;
    const L: [number, number][] = [];
    const R: [number, number][] = [];
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const cx = bx + Math.sin(phase + t * freq * Math.PI * 2) * sway * Math.pow(t, 1.3) + lean * t * t;
      const cy = by + w * 0.18 - (h + w * 0.18) * t;
      const prof = Math.sin(Math.PI * Math.pow(t, 0.45)) * (1 - 0.35 * t);
      const ragged = 1 + Math.sin(t * 17 + phase2) * 0.22 * wild;
      const hw = Math.max(0, (w / 2) * prof * ragged);
      L.push([cx - hw, cy]);
      R.push([cx + hw, cy]);
    }
    const g = hc.createLinearGradient(0, by + w * 0.2, 0, by - h);
    const k = strength * heatScale;
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.07, `rgba(255,255,255,${0.9 * k})`);
    g.addColorStop(0.3, `rgba(255,255,255,${0.7 * k})`);
    g.addColorStop(0.7, `rgba(255,255,255,${0.3 * k})`);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    hc.fillStyle = g;
    hc.beginPath();
    hc.moveTo(L[0][0], L[0][1]);
    for (let i = 1; i < L.length; i++) hc.lineTo(L[i][0], L[i][1]);
    for (let i = R.length - 1; i >= 0; i--) hc.lineTo(R[i][0], R[i][1]);
    hc.closePath();
    hc.fill();
  };

  // 1) broad body tongues, 2) tall licking tongues, 3) small hot cores at the base
  const passes = [
    { per: 0.55, hMin: 0.35, hMax: 0.75, wMul: [0.9, 1.6], str: 0.8 },
    { per: 0.25, hMin: 0.6, hMax: 1.0, wMul: [0.5, 0.9], str: 0.75 },
    { per: 0.45, hMin: 0.12, hMax: 0.35, wMul: [0.5, 1.0], str: 1.0 },
  ];
  for (const ps of passes) {
    const count = Math.ceil((length / thick) * density * ps.per) + 1;
    for (let i = 0; i < count; i++) {
      const s = ((i + rand() * 0.9) / count) * length;
      const env = envAt(s);
      if (env < 0.03) continue;
      const sm = sampleAt(s);
      const bx = ox + sm.x + (rand() * 2 - 1) * thick * 0.15;
      const by = oy + sm.y + (rand() * 2 - 1) * thick * 0.2;
      const hh = height * (ps.hMin + (ps.hMax - ps.hMin) * Math.pow(rand(), 0.8)) * (0.25 + 0.75 * env);
      const ww = thick * (ps.wMul[0] + rand() * (ps.wMul[1] - ps.wMul[0])) * (0.5 + 0.5 * env);
      tongue(bx, by, hh, ww, ps.str * (0.4 + 0.6 * env));
    }
  }
  // a few detached flicker wisps above the main body
  const wisps = Math.round((length / thick) * density * 0.12 * (0.3 + wild));
  for (let i = 0; i < wisps; i++) {
    const s = rand() * length;
    const env = envAt(s);
    if (env < 0.1) continue;
    const sm = sampleAt(s);
    const lift = height * (0.55 + rand() * 0.45) * env;
    tongue(ox + sm.x + (rand() * 2 - 1) * thick * 0.6, oy + sm.y - lift, height * 0.22 * env, thick * (0.25 + rand() * 0.3), 0.55);
  }

  // soften the heat a touch so the tongues melt together
  const soft = createCanvas(W, H);
  const sc = soft.getContext('2d', { willReadFrequently: true })!;
  sc.filter = `blur(${Math.max(1, thick * 0.12)}px)`;
  sc.drawImage(heat, 0, 0);
  sc.filter = 'none';

  // ---- colorize ----
  const lut = buildRamp(p.palette);
  // soft-clip the heat so dense areas reach "hot" but only the very core goes white
  const tone = new Uint8Array(256);
  for (let i = 0; i < 256; i++) tone[i] = Math.round(255 * (1 - Math.exp((-i / 255) * 2.2)) / (1 - Math.exp(-2.2)));
  const img = sc.getImageData(0, 0, W, H);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = tone[d[i + 3]]; // heat lives in alpha (canvas data is un-premultiplied)
    if (v === 0) {
      d[i + 3] = 0;
      continue;
    }
    const j = v * 4;
    d[i] = lut[j];
    d[i + 1] = lut[j + 1];
    d[i + 2] = lut[j + 2];
    d[i + 3] = lut[j + 3];
  }
  const flames = createCanvas(W, H);
  flames.getContext('2d')!.putImageData(img, 0, 0);

  const oc = out.getContext('2d')!;
  if (p.glow > 0) {
    oc.filter = `blur(${p.glow}px)`;
    oc.globalAlpha = 0.9;
    oc.drawImage(flames, 0, 0);
    oc.filter = `blur(${p.glow / 3}px)`;
    oc.globalAlpha = 0.6;
    oc.drawImage(flames, 0, 0);
    oc.filter = 'none';
    oc.globalAlpha = 1;
  }
  oc.drawImage(flames, 0, 0);
  // extra bloom on the hottest parts
  oc.globalCompositeOperation = 'lighter';
  oc.globalAlpha = 0.18;
  oc.filter = `blur(${Math.max(2, thick * 0.25)}px)`;
  oc.drawImage(flames, 0, 0);
  oc.filter = 'none';
  oc.globalAlpha = 1;

  // ---- embers ----
  const pal = (p.palette.length ? p.palette : ['#ffb020']).map(hexToRgb);
  const hot = pal[Math.max(0, pal.length - 2)];
  const mid = pal[Math.max(0, pal.length - 3)];
  const embers = Math.max(0, Math.round(p.sparkles));
  for (let i = 0; i < embers; i++) {
    const s = rand() * length;
    const env = envAt(s);
    const sm = sampleAt(s);
    const rise = height * (0.2 + Math.pow(rand(), 0.6) * 1.3) * (0.4 + 0.6 * env);
    const x = ox + sm.x + (rand() * 2 - 1) * (thick + wild * height * 0.35);
    const y = oy + sm.y - rise;
    const r = Math.max(1, thick * (0.04 + rand() * 0.08));
    const c = rand() < 0.5 ? hot : mid;
    const a = 0.5 + rand() * 0.5;
    const col = `${c[0] | 0},${c[1] | 0},${c[2] | 0}`;
    // short rising streak
    const sl = r * (2 + rand() * 5);
    const sx = (rand() * 2 - 1) * sl * 0.5;
    const sg = oc.createLinearGradient(x, y, x + sx, y + sl);
    sg.addColorStop(0, `rgba(${col},${a})`);
    sg.addColorStop(1, `rgba(${col},0)`);
    oc.strokeStyle = sg;
    oc.lineCap = 'round';
    oc.lineWidth = r * 1.2;
    oc.beginPath();
    oc.moveTo(x, y);
    oc.lineTo(x + sx, y + sl);
    oc.stroke();
    const g = oc.createRadialGradient(x, y, 0, x, y, r * 3);
    g.addColorStop(0, `rgba(255,250,220,${a})`);
    g.addColorStop(0.3, `rgba(${col},${a * 0.8})`);
    g.addColorStop(1, `rgba(${col},0)`);
    oc.fillStyle = g;
    oc.beginPath();
    oc.arc(x, y, r * 3, 0, Math.PI * 2);
    oc.fill();
  }
  oc.globalCompositeOperation = 'source-over';
  return out;
}
