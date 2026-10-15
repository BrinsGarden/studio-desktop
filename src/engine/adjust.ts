import type { Adjustments, CurvePoint, BalanceTriple } from './types';

export interface ChannelStats {
  mean: [number, number, number];
  std: [number, number, number];
}

const clamp255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

/** Monotone cubic (Fritsch–Carlson) interpolation through curve points -> 256-entry LUT. */
export function curveLut(points: CurvePoint[]): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256);
  const pts = [...points].sort((a, b) => a[0] - b[0]);
  // dedupe x
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [x, y] of pts) {
    if (xs.length && x === xs[xs.length - 1]) {
      ys[ys.length - 1] = y;
    } else {
      xs.push(x);
      ys.push(y);
    }
  }
  const n = xs.length;
  if (n === 0) {
    for (let i = 0; i < 256; i++) lut[i] = i;
    return lut;
  }
  if (n === 1) {
    lut.fill(clamp255(ys[0]));
    return lut;
  }
  const d: number[] = [];
  const m: number[] = new Array(n).fill(0);
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i] || 1));
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] <= 0) m[i] = 0;
    else m[i] = (d[i - 1] + d[i]) / 2;
  }
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }
  for (let x = 0; x < 256; x++) {
    if (x <= xs[0]) {
      lut[x] = clamp255(ys[0]);
      continue;
    }
    if (x >= xs[n - 1]) {
      lut[x] = clamp255(ys[n - 1]);
      continue;
    }
    let i = 0;
    while (i < n - 2 && x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i];
    const t = (x - xs[i]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;
    lut[x] = clamp255(Math.round(h00 * ys[i] + h10 * h * m[i] + h01 * ys[i + 1] + h11 * h * m[i + 1]));
  }
  return lut;
}

function isIdentityCurve(p: CurvePoint[]): boolean {
  return p.length === 2 && p[0][0] === 0 && p[0][1] === 0 && p[1][0] === 255 && p[1][1] === 255;
}

function balanceIsZero(b: Adjustments['balance']): boolean {
  return [...b.shadows, ...b.midtones, ...b.highlights].every((v) => v === 0);
}

export function isIdentity(a: Adjustments): boolean {
  const l = a.levels;
  return (
    a.brightness === 0 &&
    a.contrast === 0 &&
    l.inBlack === 0 &&
    l.inWhite === 255 &&
    l.gamma === 1 &&
    l.outBlack === 0 &&
    l.outWhite === 255 &&
    isIdentityCurve(a.curves.rgb) &&
    isIdentityCurve(a.curves.r) &&
    isIdentityCurve(a.curves.g) &&
    isIdentityCurve(a.curves.b) &&
    a.hue === 0 &&
    a.saturation === 0 &&
    a.lightness === 0 &&
    balanceIsZero(a.balance) &&
    (a.tint.amount === 0) &&
    (!a.match.layerId || a.match.strength === 0)
  );
}

/** Tonal weights (GIMP-style) for shadows / midtones / highlights at value v (0..255). */
function toneWeights(v: number): [number, number, number] {
  const x = v / 255;
  const shadows = Math.max(0, 1 - x / 0.5) ** 1.2;
  const highlights = Math.max(0, (x - 0.5) / 0.5) ** 1.2;
  const mid = Math.max(0, 1 - Math.abs(x - 0.5) / 0.5) ** 0.8;
  return [shadows, mid, highlights];
}

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.padEnd(6, '0');
  const n = parseInt(full.slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * Build one LUT per channel that bakes every per-channel operation:
 * match color -> levels -> curves (master, then channel) -> brightness/contrast -> color balance.
 */
export function buildChannelLuts(
  a: Adjustments,
  matchSelf?: ChannelStats | null,
  matchTarget?: ChannelStats | null,
): [Uint8ClampedArray, Uint8ClampedArray, Uint8ClampedArray] {
  const master = curveLut(a.curves.rgb);
  const per = [curveLut(a.curves.r), curveLut(a.curves.g), curveLut(a.curves.b)];
  const L = a.levels;
  const inRange = Math.max(1, L.inWhite - L.inBlack);
  const gammaInv = 1 / Math.max(0.01, L.gamma);
  const bright = a.brightness * 1.28;
  const cf = Math.tan(((a.contrast / 100 + 1) * Math.PI) / 4);
  const strength = a.match.layerId && matchSelf && matchTarget ? a.match.strength / 100 : 0;

  const luts: Uint8ClampedArray[] = [];
  for (let c = 0; c < 3; c++) {
    const lut = new Uint8ClampedArray(256);
    const bal = [a.balance.shadows[c], a.balance.midtones[c], a.balance.highlights[c]];
    for (let v = 0; v < 256; v++) {
      let x = v;
      if (strength > 0 && matchSelf && matchTarget) {
        const sd = matchSelf.std[c] || 1;
        const matched = ((x - matchSelf.mean[c]) / sd) * matchTarget.std[c] + matchTarget.mean[c];
        x = x + (matched - x) * strength;
      }
      // levels
      let t = (clamp255(x) - L.inBlack) / inRange;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      t = Math.pow(t, gammaInv);
      x = L.outBlack + t * (L.outWhite - L.outBlack);
      // curves
      x = master[Math.round(clamp255(x))];
      x = per[c][Math.round(clamp255(x))];
      // brightness / contrast
      x = x + bright;
      x = (x - 128) * cf + 128;
      // color balance
      if (bal[0] || bal[1] || bal[2]) {
        const w = toneWeights(clamp255(x));
        x = x + (bal[0] * w[0] + bal[1] * w[1] + bal[2] * w[2]) * 0.9;
      }
      lut[v] = clamp255(Math.round(x));
    }
    luts.push(lut);
  }
  return luts as [Uint8ClampedArray, Uint8ClampedArray, Uint8ClampedArray];
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, s, l];
}

function hue2rgb(p: number, q: number, t: number): number {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue2rgb(p, q, h + 1 / 3) * 255, hue2rgb(p, q, h) * 255, hue2rgb(p, q, h - 1 / 3) * 255];
}

const lum = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;

/** Apply adjustments in place to RGBA pixel data. Alpha is untouched. */
export function applyAdjustments(
  data: Uint8ClampedArray,
  a: Adjustments,
  matchSelf?: ChannelStats | null,
  matchTarget?: ChannelStats | null,
): void {
  const [lr, lg, lb] = buildChannelLuts(a, matchSelf, matchTarget);
  const doHsl = a.hue !== 0 || a.saturation !== 0 || a.lightness !== 0;
  const hueShift = a.hue / 360;
  const satF = 1 + a.saturation / 100;
  const lightF = a.lightness / 100;
  const tintAmt = a.tint.amount / 100;
  const tint = hexToRgb(a.tint.color);
  const tintLum = Math.max(1, lum(tint[0], tint[1], tint[2]));

  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    let r = lr[data[i]];
    let g = lg[data[i + 1]];
    let b = lb[data[i + 2]];
    if (doHsl) {
      let [h, s, l] = rgbToHsl(r, g, b);
      h = (h + hueShift + 1) % 1;
      s = Math.min(1, s * satF);
      l = lightF > 0 ? l + (1 - l) * lightF : l * (1 + lightF);
      [r, g, b] = hslToRgb(h, s, l);
    }
    if (tintAmt > 0) {
      const y = lum(r, g, b);
      r = r + ((y * tint[0]) / tintLum - r) * tintAmt;
      g = g + ((y * tint[1]) / tintLum - g) * tintAmt;
      b = b + ((y * tint[2]) / tintLum - b) * tintAmt;
    }
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
  }
}

/** Mean / std-dev per RGB channel over pixels whose alpha > 128. */
export function computeStats(data: Uint8ClampedArray): ChannelStats {
  const sum = [0, 0, 0];
  const sq = [0, 0, 0];
  let n = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] <= 128) continue;
    n++;
    for (let c = 0; c < 3; c++) {
      const v = data[i + c];
      sum[c] += v;
      sq[c] += v * v;
    }
  }
  if (n === 0) return { mean: [128, 128, 128], std: [64, 64, 64] };
  const mean = sum.map((s) => s / n) as [number, number, number];
  const std = sq.map((s, c) => Math.sqrt(Math.max(0, s / n - mean[c] * mean[c]))) as [number, number, number];
  return { mean, std };
}

/** Erode alpha by radius r (separable min filter), then box-blur alpha twice by radius f. In place. */
export function processEdges(data: Uint8ClampedArray, w: number, h: number, shrink: number, soften: number): void {
  const r = Math.round(shrink);
  const f = Math.round(soften);
  if (r <= 0 && f <= 0) return;
  const alpha = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) alpha[i] = data[i * 4 + 3];
  const tmp = new Float32Array(w * h);

  if (r > 0) {
    // horizontal min
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        let m = 255;
        const x0 = Math.max(0, x - r);
        const x1 = Math.min(w - 1, x + r);
        if (x - r < 0 || x + r > w - 1) m = 0;
        for (let k = x0; k <= x1 && m > 0; k++) if (alpha[row + k] < m) m = alpha[row + k];
        tmp[row + x] = m;
      }
    }
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) {
        let m = 255;
        const y0 = Math.max(0, y - r);
        const y1 = Math.min(h - 1, y + r);
        if (y - r < 0 || y + r > h - 1) m = 0;
        for (let k = y0; k <= y1 && m > 0; k++) if (tmp[k * w + x] < m) m = tmp[k * w + x];
        alpha[y * w + x] = m;
      }
    }
  }

  if (f > 0) {
    for (let pass = 0; pass < 2; pass++) {
      boxBlur1D(alpha, tmp, w, h, f, true);
      boxBlur1D(tmp, alpha, w, h, f, false);
    }
  }

  // never add alpha where there was none originally
  for (let i = 0; i < w * h; i++) {
    const orig = data[i * 4 + 3];
    data[i * 4 + 3] = Math.min(orig, alpha[i]);
  }
}

function boxBlur1D(src: Float32Array, dst: Float32Array, w: number, h: number, r: number, horizontal: boolean) {
  const len = horizontal ? w : h;
  const lines = horizontal ? h : w;
  const win = 2 * r + 1;
  for (let line = 0; line < lines; line++) {
    const idx = (i: number) => {
      const j = i < 0 ? 0 : i >= len ? len - 1 : i;
      return horizontal ? line * w + j : j * w + line;
    };
    let acc = 0;
    for (let i = -r; i <= r; i++) acc += src[idx(i)];
    for (let i = 0; i < len; i++) {
      dst[idx(i)] = acc / win;
      acc += src[idx(i + r + 1)] - src[idx(i - r)];
    }
  }
}

export function balanceTriple(v: BalanceTriple): BalanceTriple {
  return [v[0], v[1], v[2]];
}
