/**
 * Image-matting helpers used by the Cutout tool.
 *
 * Conventions: an alpha matte is a Float32Array in [0, 1], row-major, w*h long.
 * Colour images are three Float32Array planes (r, g, b) in [0, 1].
 * Everything here is plain math (no DOM) so it runs in a worker and in unit tests.
 */

export type Planes = [Float32Array, Float32Array, Float32Array];

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Mean filter over a (2r+1)² window; edges average only the pixels that exist. O(n) for any r. */
export function boxBlur(src: Float32Array, w: number, h: number, r: number, out: Float32Array = new Float32Array(w * h)): Float32Array {
  r = Math.max(0, Math.floor(r));
  if (r === 0) {
    if (out !== src) out.set(src);
    return out;
  }
  const tmp = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    const lim = Math.min(r, w - 1);
    for (let x = 0; x <= lim; x++) sum += src[row + x];
    for (let x = 0; x < w; x++) {
      const a = x - r < 0 ? 0 : x - r;
      const b = x + r > w - 1 ? w - 1 : x + r;
      tmp[row + x] = sum / (b - a + 1);
      if (x + r + 1 < w) sum += src[row + x + r + 1];
      if (x - r >= 0) sum -= src[row + x - r];
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    const lim = Math.min(r, h - 1);
    for (let y = 0; y <= lim; y++) sum += tmp[y * w + x];
    for (let y = 0; y < h; y++) {
      const a = y - r < 0 ? 0 : y - r;
      const b = y + r > h - 1 ? h - 1 : y + r;
      out[y * w + x] = sum / (b - a + 1);
      if (y + r + 1 < h) sum += tmp[(y + r + 1) * w + x];
      if (y - r >= 0) sum -= tmp[(y - r) * w + x];
    }
  }
  return out;
}

/** Approximate gaussian blur (three box passes). `sigma` in pixels. */
export function gaussBlur(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  if (sigma < 0.5) return Float32Array.from(src);
  const r = Math.max(1, Math.round(sigma * 0.85));
  let a = boxBlur(src, w, h, r);
  a = boxBlur(a, w, h, r, a);
  return boxBlur(a, w, h, r, a);
}

/* ---------------- grayscale morphology (van Herk / Gil-Werman, O(n)) ---------------- */

function morphLine(src: Float32Array, dst: Float32Array, n: number, r: number, isMax: boolean, g: Float32Array, L: Float32Array, R: Float32Array) {
  const k = 2 * r + 1;
  const pad = isMax ? -Infinity : Infinity;
  const len = n + 2 * r;
  for (let i = 0; i < len; i++) g[i] = i < r || i >= n + r ? pad : src[i - r];
  for (let start = 0; start < len; start += k) {
    const end = Math.min(len, start + k);
    let acc = pad;
    for (let i = start; i < end; i++) {
      acc = isMax ? (g[i] > acc ? g[i] : acc) : g[i] < acc ? g[i] : acc;
      L[i] = acc;
    }
    acc = pad;
    for (let i = end - 1; i >= start; i--) {
      acc = isMax ? (g[i] > acc ? g[i] : acc) : g[i] < acc ? g[i] : acc;
      R[i] = acc;
    }
  }
  for (let j = 0; j < n; j++) {
    const a = R[j];
    const b = L[j + k - 1];
    dst[j] = isMax ? (a > b ? a : b) : a < b ? a : b;
  }
}

/** Grayscale dilation (isMax) or erosion over a square of radius r. */
export function morph(src: Float32Array, w: number, h: number, r: number, isMax: boolean): Float32Array {
  r = Math.max(0, Math.round(r));
  const out = Float32Array.from(src);
  if (r === 0) return out;
  const n = Math.max(w, h);
  const g = new Float32Array(n + 2 * r + 2 * r + 1);
  const L = new Float32Array(g.length);
  const R = new Float32Array(g.length);
  const line = new Float32Array(n);
  const res = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) line[x] = out[row + x];
    morphLine(line, res, w, r, isMax, g, L, R);
    for (let x = 0; x < w; x++) out[row + x] = res[x];
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) line[y] = out[y * w + x];
    morphLine(line, res, h, r, isMax, g, L, R);
    for (let y = 0; y < h; y++) out[y * w + x] = res[y];
  }
  return out;
}

/* ---------------- resampling ---------------- */

/** Bilinear resize with pixel-centre alignment. */
export function resizeBilinear(src: Float32Array, sw: number, sh: number, dw: number, dh: number): Float32Array {
  const out = new Float32Array(dw * dh);
  const fx = sw / dw;
  const fy = sh / dh;
  for (let y = 0; y < dh; y++) {
    let sy = (y + 0.5) * fy - 0.5;
    if (sy < 0) sy = 0;
    const y0 = Math.min(sh - 1, Math.floor(sy));
    const y1 = Math.min(sh - 1, y0 + 1);
    const ty = sy - y0;
    for (let x = 0; x < dw; x++) {
      let sx = (x + 0.5) * fx - 0.5;
      if (sx < 0) sx = 0;
      const x0 = Math.min(sw - 1, Math.floor(sx));
      const x1 = Math.min(sw - 1, x0 + 1);
      const tx = sx - x0;
      const a = src[y0 * sw + x0] + (src[y0 * sw + x1] - src[y0 * sw + x0]) * tx;
      const b = src[y1 * sw + x0] + (src[y1 * sw + x1] - src[y1 * sw + x0]) * tx;
      out[y * dw + x] = a + (b - a) * ty;
    }
  }
  return out;
}

/** Copy a sub-rectangle out of a w-wide plane. */
export function crop(src: Float32Array, w: number, r: Rect): Float32Array {
  const out = new Float32Array(r.w * r.h);
  for (let y = 0; y < r.h; y++) out.set(src.subarray((r.y + y) * w + r.x, (r.y + y) * w + r.x + r.w), y * r.w);
  return out;
}

/** RGBA bytes → three float planes for the given rectangle of an image `iw` wide. */
export function planesFromRGBA(rgba: Uint8ClampedArray | Uint8Array, iw: number, r: Rect): Planes {
  const n = r.w * r.h;
  const R = new Float32Array(n);
  const G = new Float32Array(n);
  const B = new Float32Array(n);
  for (let y = 0; y < r.h; y++) {
    let s = ((r.y + y) * iw + r.x) * 4;
    let d = y * r.w;
    for (let x = 0; x < r.w; x++, s += 4, d++) {
      R[d] = rgba[s] / 255;
      G[d] = rgba[s + 1] / 255;
      B[d] = rgba[s + 2] / 255;
    }
  }
  return [R, G, B];
}

/* ---------------- bands & tiles ---------------- */

/** Pixels within `r` of the alpha's 50% boundary, plus any already-soft pixels. */
export function edgeBand(alpha: Float32Array, w: number, h: number, r: number, softLo = 0.02, softHi = 0.98): Uint8Array {
  const n = w * h;
  const band = new Uint8Array(n);
  const bin = new Float32Array(n);
  for (let i = 0; i < n; i++) bin[i] = alpha[i] >= 0.5 ? 1 : 0;
  const b = r > 0 ? boxBlur(bin, w, h, r) : bin;
  for (let i = 0; i < n; i++) {
    const a = alpha[i];
    if ((b[i] > 0.0005 && b[i] < 0.9995) || (a > softLo && a < softHi)) band[i] = 1;
  }
  return band;
}

/**
 * Run `fn` on padded tiles that contain at least one band pixel.
 * `fn(rect, inner)` gets the padded tile rect and the inner (unpadded) rect, both in image coords.
 */
export function forBandTiles(w: number, h: number, band: Uint8Array, tile: number, pad: number, fn: (outer: Rect, inner: Rect) => void) {
  for (let ty = 0; ty < h; ty += tile) {
    for (let tx = 0; tx < w; tx += tile) {
      const iw = Math.min(tile, w - tx);
      const ih = Math.min(tile, h - ty);
      let any = false;
      for (let y = ty; y < ty + ih && !any; y++) {
        const row = y * w;
        for (let x = tx; x < tx + iw; x++) {
          if (band[row + x]) {
            any = true;
            break;
          }
        }
      }
      if (!any) continue;
      const ox = Math.max(0, tx - pad);
      const oy = Math.max(0, ty - pad);
      const ow = Math.min(w, tx + iw + pad) - ox;
      const oh = Math.min(h, ty + ih + pad) - oy;
      fn({ x: ox, y: oy, w: ow, h: oh }, { x: tx, y: ty, w: iw, h: ih });
    }
  }
}

/* ---------------- guided filter ---------------- */

/** Colour guided filter (He et al.) on a whole small image: edges of `I` are transferred into `p`. */
export function guidedFilterColor(I: Planes, p: Float32Array, w: number, h: number, r: number, eps: number): Float32Array {
  const n = w * h;
  const bl = (a: Float32Array) => boxBlur(a, w, h, r);
  const [Ir, Ig, Ib] = I;
  const mr = bl(Ir);
  const mg = bl(Ig);
  const mb = bl(Ib);
  const mp = bl(p);
  const prod = new Float32Array(n);
  const mul = (a: Float32Array, b: Float32Array) => {
    for (let i = 0; i < n; i++) prod[i] = a[i] * b[i];
    return bl(prod);
  };
  const mrp = mul(Ir, p);
  const mgp = mul(Ig, p);
  const mbp = mul(Ib, p);
  const vrr = mul(Ir, Ir);
  const vrg = mul(Ir, Ig);
  const vrb = mul(Ir, Ib);
  const vgg = mul(Ig, Ig);
  const vgb = mul(Ig, Ib);
  const vbb = mul(Ib, Ib);
  const ar = new Float32Array(n);
  const ag = new Float32Array(n);
  const ab = new Float32Array(n);
  const bb = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const cr = mrp[i] - mr[i] * mp[i];
    const cg = mgp[i] - mg[i] * mp[i];
    const cb = mbp[i] - mb[i] * mp[i];
    const s00 = vrr[i] - mr[i] * mr[i] + eps;
    const s01 = vrg[i] - mr[i] * mg[i];
    const s02 = vrb[i] - mr[i] * mb[i];
    const s11 = vgg[i] - mg[i] * mg[i] + eps;
    const s12 = vgb[i] - mg[i] * mb[i];
    const s22 = vbb[i] - mb[i] * mb[i] + eps;
    // inverse of symmetric 3x3
    const i00 = s11 * s22 - s12 * s12;
    const i01 = s02 * s12 - s01 * s22;
    const i02 = s01 * s12 - s02 * s11;
    const i11 = s00 * s22 - s02 * s02;
    const i12 = s01 * s02 - s00 * s12;
    const i22 = s00 * s11 - s01 * s01;
    const det = s00 * i00 + s01 * i01 + s02 * i02;
    const inv = det > 1e-12 ? 1 / det : 0;
    const a0 = (cr * i00 + cg * i01 + cb * i02) * inv;
    const a1 = (cr * i01 + cg * i11 + cb * i12) * inv;
    const a2 = (cr * i02 + cg * i12 + cb * i22) * inv;
    ar[i] = a0;
    ag[i] = a1;
    ab[i] = a2;
    bb[i] = mp[i] - a0 * mr[i] - a1 * mg[i] - a2 * mb[i];
  }
  const mar = bl(ar);
  const mag = bl(ag);
  const mab = bl(ab);
  const mbb = bl(bb);
  const q = new Float32Array(n);
  for (let i = 0; i < n; i++) q[i] = mar[i] * Ir[i] + mag[i] * Ig[i] + mab[i] * Ib[i] + mbb[i];
  return q;
}

/** Guided filter applied only inside `band`, tile by tile (fast and memory-light on big images). */
export function guidedInBand(I: Planes, p: Float32Array, band: Uint8Array, w: number, h: number, r: number, eps: number): Float32Array {
  const out = Float32Array.from(p);
  forBandTiles(w, h, band, 256, 2 * r + 2, (o, inner) => {
    const tI: Planes = [crop(I[0], w, o), crop(I[1], w, o), crop(I[2], w, o)];
    const q = guidedFilterColor(tI, crop(p, w, o), o.w, o.h, r, eps);
    for (let y = inner.y; y < inner.y + inner.h; y++) {
      for (let x = inner.x; x < inner.x + inner.w; x++) {
        const i = y * w + x;
        if (band[i]) out[i] = clamp01(q[(y - o.y) * o.w + (x - o.x)]);
      }
    }
  });
  return out;
}

/* ---------------- edge refinement from local colours ---------------- */

/**
 * Re-estimate alpha inside `band` from nearby known foreground and background colours:
 * alpha = projection of the pixel onto the line between local F and B colours.
 * Works best on hair, fur, feathers and fuzzy edges against a contrasting background.
 * `sampleR` should reach past the band into known pixels.
 */
export function colorRefine(I: Planes, alpha: Float32Array, band: Uint8Array, w: number, h: number, sampleR: number): Float32Array {
  const out = Float32Array.from(alpha);
  const rs = Math.max(2, Math.round(sampleR));
  const rl = rs * 3;
  forBandTiles(w, h, band, 256, rl + 2, (o, inner) => {
    const n = o.w * o.h;
    const fg = new Float32Array(n);
    const bg = new Float32Array(n);
    for (let y = 0; y < o.h; y++) {
      for (let x = 0; x < o.w; x++) {
        const gi = (o.y + y) * w + o.x + x;
        if (band[gi]) continue;
        const a = alpha[gi];
        if (a >= 0.97) fg[y * o.w + x] = 1;
        else if (a <= 0.03) bg[y * o.w + x] = 1;
      }
    }
    const tI = [crop(I[0], w, o), crop(I[1], w, o), crop(I[2], w, o)];
    const est = (mask: Float32Array, r: number) => {
      const wsum = boxBlur(mask, o.w, o.h, r);
      const ch = tI.map((c) => {
        const t = new Float32Array(n);
        for (let i = 0; i < n; i++) t[i] = c[i] * mask[i];
        return boxBlur(t, o.w, o.h, r, t);
      });
      return { wsum, ch };
    };
    const fS = est(fg, rs);
    const bS = est(bg, rs);
    const fL = est(fg, rl);
    const bL = est(bg, rl);
    const tA = crop(alpha, w, o);
    const tBand = new Uint8Array(n);
    for (let y = 0; y < o.h; y++) for (let x = 0; x < o.w; x++) tBand[y * o.w + x] = band[(o.y + y) * w + o.x + x];
    const res = Float32Array.from(tA);
    for (let i = 0; i < n; i++) {
      if (!tBand[i]) continue;
      const F = fS.wsum[i] > 0.01 ? fS : fL.wsum[i] > 0.002 ? fL : null;
      const B = bS.wsum[i] > 0.01 ? bS : bL.wsum[i] > 0.002 ? bL : null;
      if (!F || !B) continue;
      const fr = F.ch[0][i] / F.wsum[i];
      const fgc = F.ch[1][i] / F.wsum[i];
      const fb = F.ch[2][i] / F.wsum[i];
      const br = B.ch[0][i] / B.wsum[i];
      const bgc = B.ch[1][i] / B.wsum[i];
      const bbc = B.ch[2][i] / B.wsum[i];
      const dr = fr - br;
      const dg = fgc - bgc;
      const db = fb - bbc;
      const d2 = dr * dr + dg * dg + db * db;
      const dist = Math.sqrt(d2);
      const conf = clamp01((dist - 0.05) / 0.15);
      if (conf <= 0) continue;
      const a = clamp01(((tI[0][i] - br) * dr + (tI[1][i] - bgc) * dg + (tI[2][i] - bbc) * db) / Math.max(d2, 1e-4));
      res[i] = conf * a + (1 - conf) * tA[i];
    }
    // light edge-aware smoothing to remove per-pixel noise
    const sm = guidedFilterColor(tI as Planes, res, o.w, o.h, 2, 1e-3);
    for (let y = inner.y; y < inner.y + inner.h; y++) {
      for (let x = inner.x; x < inner.x + inner.w; x++) {
        const gi = y * w + x;
        if (band[gi]) out[gi] = clamp01(sm[(y - o.y) * o.w + (x - o.x)]);
      }
    }
  });
  return out;
}

/* ---------------- global edge adjustments ---------------- */

export function shiftEdge(alpha: Float32Array, w: number, h: number, px: number): Float32Array {
  if (Math.abs(px) < 0.5) return alpha;
  return morph(alpha, w, h, Math.abs(px), px > 0);
}

/** Round off jaggies while keeping the edge where it was. */
export function smoothEdge(alpha: Float32Array, w: number, h: number, r: number): Float32Array {
  if (r < 1) return alpha;
  const rr = Math.round(r);
  let b = boxBlur(alpha, w, h, rr);
  b = boxBlur(b, w, h, rr, b);
  const gain = 1 + rr * 0.6;
  for (let i = 0; i < b.length; i++) b[i] = clamp01((b[i] - 0.5) * gain + 0.5);
  return b;
}

export function featherEdge(alpha: Float32Array, w: number, h: number, px: number): Float32Array {
  if (px < 0.5) return alpha;
  return gaussBlur(alpha, w, h, px / 2);
}

/** 0 = unchanged, 100 = nearly hard-edged. */
export function edgeContrast(alpha: Float32Array, amount: number): Float32Array {
  if (amount <= 0) return alpha;
  const k = 1 / Math.max(0.01, 1 - Math.min(100, amount) * 0.0099);
  const out = new Float32Array(alpha.length);
  for (let i = 0; i < alpha.length; i++) out[i] = clamp01((alpha[i] - 0.5) * k + 0.5);
  return out;
}

/* ---------------- connected pieces ---------------- */

/** Label 8-connected regions where alpha >= thr. Returns labels (0 = none) and region sizes (index = label). */
export function labelRegions(alpha: Float32Array, w: number, h: number, thr = 0.5): { labels: Int32Array; sizes: number[] } {
  const n = w * h;
  const labels = new Int32Array(n);
  const sizes: number[] = [0];
  const stack = new Int32Array(n);
  let next = 0;
  for (let s = 0; s < n; s++) {
    if (labels[s] || alpha[s] < thr) continue;
    next++;
    let top = 0;
    let size = 0;
    stack[top++] = s;
    labels[s] = next;
    while (top) {
      const i = stack[--top];
      size++;
      const x = i % w;
      const y = (i - x) / w;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w || (dx === 0 && dy === 0)) continue;
          const j = yy * w + xx;
          if (!labels[j] && alpha[j] >= thr) {
            labels[j] = next;
            stack[top++] = j;
          }
        }
      }
    }
    sizes.push(size);
  }
  return { labels, sizes };
}

/**
 * Drop disconnected bits smaller than `minFrac` of the biggest piece, and any faint haze
 * farther than `reach` px from the pieces that stay. Hair wisps near the subject survive.
 */
export function removeSpecks(alpha: Float32Array, w: number, h: number, minFrac: number, reach: number): Float32Array {
  const { labels, sizes } = labelRegions(alpha, w, h, 0.5);
  if (sizes.length <= 1) return alpha;
  const biggest = Math.max(...sizes);
  const keepLabel = sizes.map((s) => s >= biggest * minFrac);
  const kept = new Float32Array(w * h);
  for (let i = 0; i < kept.length; i++) if (labels[i] && keepLabel[labels[i]]) kept[i] = 1;
  const near = morph(kept, w, h, Math.max(1, Math.round(reach)), true);
  const out = new Float32Array(alpha.length);
  for (let i = 0; i < out.length; i++) {
    const l = labels[i];
    if (l && !keepLabel[l]) continue;
    out[i] = alpha[i] * near[i];
  }
  return out;
}

/* ---------------- colour decontamination ---------------- */

function blurFusionPass(I: Planes, F: Planes, B: Planes, alpha: Float32Array, w: number, h: number, r: number): { F: Planes; B: Planes } {
  const n = w * h;
  const ba = boxBlur(alpha, w, h, r);
  const t = new Float32Array(n);
  const outF: Float32Array[] = [];
  const outB: Float32Array[] = [];
  for (let c = 0; c < 3; c++) {
    for (let i = 0; i < n; i++) t[i] = F[c][i] * alpha[i];
    const bF = boxBlur(t, w, h, r);
    for (let i = 0; i < n; i++) t[i] = B[c][i] * (1 - alpha[i]);
    const bB = boxBlur(t, w, h, r);
    const nf = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = alpha[i];
      const fb = bF[i] / (ba[i] + 1e-5);
      const bbv = bB[i] / (1 - ba[i] + 1e-5);
      bB[i] = bbv;
      nf[i] = clamp01(fb + a * (I[c][i] - a * fb - (1 - a) * bbv));
    }
    outF.push(nf);
    outB.push(bB);
  }
  return { F: outF as Planes, B: outB as Planes };
}

/**
 * Estimate the true foreground colour of soft edge pixels (Forte & Pitié "blur fusion"),
 * so hair and edges stop carrying the old background's colour onto the new scene.
 */
export function estimateForeground(I: Planes, alpha: Float32Array, w: number, h: number): Planes {
  const p1 = blurFusionPass(I, I, I, alpha, w, h, 45);
  const p2 = blurFusionPass(I, p1.F, p1.B, alpha, w, h, 3);
  return p2.F;
}

/* ---------------- misc ---------------- */

export function sigmoidInPlace(a: Float32Array) {
  for (let i = 0; i < a.length; i++) a[i] = 1 / (1 + Math.exp(-a[i]));
}

export function toBytes(alpha: Float32Array): Uint8Array {
  const out = new Uint8Array(alpha.length);
  for (let i = 0; i < alpha.length; i++) out[i] = Math.round(clamp01(alpha[i]) * 255);
  return out;
}

/** Decode IEEE half floats. */
export function halfToFloat(src: Uint16Array): Float32Array {
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i++) {
    const hv = src[i];
    const s = hv & 0x8000 ? -1 : 1;
    const e = (hv >> 10) & 0x1f;
    const f = hv & 0x3ff;
    out[i] = e === 0 ? s * 2 ** -14 * (f / 1024) : e === 31 ? (f ? NaN : s * Infinity) : s * 2 ** (e - 15) * (1 + f / 1024);
  }
  return out;
}

export function floatToHalf(src: Float32Array): Uint16Array {
  const out = new Uint16Array(src.length);
  const f32 = new Float32Array(1);
  const u32 = new Uint32Array(f32.buffer);
  for (let i = 0; i < src.length; i++) {
    f32[0] = src[i];
    const x = u32[0];
    const sign = (x >> 16) & 0x8000;
    let e = ((x >> 23) & 0xff) - 127 + 15;
    let m = x & 0x7fffff;
    if (e <= 0) {
      if (e < -10) {
        out[i] = sign;
        continue;
      }
      m = (m | 0x800000) >> (1 - e);
      out[i] = sign | ((m + 0x1000) >> 13);
      continue;
    }
    if (e >= 31) {
      out[i] = sign | 0x7c00;
      continue;
    }
    m += 0x1000;
    if (m & 0x800000) {
      m = 0;
      e++;
    }
    out[i] = sign | (e << 10) | (m >> 13);
  }
  return out;
}

export function expandRect(r: Rect, m: number, w: number, h: number): Rect {
  const x = Math.max(0, Math.floor(r.x - m));
  const y = Math.max(0, Math.floor(r.y - m));
  const x2 = Math.min(w, Math.ceil(r.x + r.w + m));
  const y2 = Math.min(h, Math.ceil(r.y + r.h + m));
  return { x, y, w: Math.max(1, x2 - x), h: Math.max(1, y2 - y) };
}

/**
 * "Solid inside": the matting model sometimes leaves see-through patches inside a person where
 * clothing or skin is close in colour to the background (white corsets, pale legs, gloves).
 * Anything well inside the subject's outline is made fully opaque, and small enclosed holes are filled;
 * the outer edge (hair, fringe) keeps its soft matte. `amount` 0..100, 0 = off.
 */
export function solidInside(alpha: Float32Array, w: number, h: number, amount: number): Float32Array {
  if (amount <= 0) return alpha;
  const k = Math.min(1, amount / 100);
  const n = w * h;
  const thr = 0.5 - 0.4 * k;
  // 1. subject = confidently-ish foreground
  const fg = new Uint8Array(n);
  let area = 0;
  let x0 = w;
  let y0 = h;
  let x1 = 0;
  let y1 = 0;
  for (let i = 0; i < n; i++) {
    if (alpha[i] > thr) {
      fg[i] = 1;
      area++;
      const x = i % w;
      const y = (i / w) | 0;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (!area) return alpha;
  // 2. background reachable from the border (4-connected flood fill)
  const outside = new Uint8Array(n);
  const stack = new Int32Array(n);
  let sp = 0;
  const seed = (i: number) => {
    if (!fg[i] && !outside[i]) {
      outside[i] = 1;
      stack[sp++] = i;
    }
  };
  for (let x = 0; x < w; x++) {
    seed(x);
    seed((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    seed(y * w);
    seed(y * w + w - 1);
  }
  while (sp) {
    const i = stack[--sp];
    const x = i % w;
    if (x > 0) seed(i - 1);
    if (x < w - 1) seed(i + 1);
    if (i >= w) seed(i - w);
    if (i < n - w) seed(i + w);
  }
  // 3. enclosed holes: fill the small ones (big ones are real gaps, e.g. between arm and body)
  const solid = new Float32Array(n);
  for (let i = 0; i < n; i++) solid[i] = fg[i];
  const maxHole = area * 0.04 * k;
  const seen = new Uint8Array(n);
  const comp: number[] = [];
  for (let i = 0; i < n; i++) {
    if (fg[i] || outside[i] || seen[i]) continue;
    comp.length = 0;
    seen[i] = 1;
    stack[0] = i;
    sp = 1;
    while (sp) {
      const j = stack[--sp];
      comp.push(j);
      const x = j % w;
      const nb = [x > 0 ? j - 1 : -1, x < w - 1 ? j + 1 : -1, j >= w ? j - w : -1, j < n - w ? j + w : -1];
      for (const q of nb) {
        if (q >= 0 && !fg[q] && !outside[q] && !seen[q]) {
          seen[q] = 1;
          stack[sp++] = q;
        }
      }
    }
    if (comp.length <= maxHole) for (const j of comp) solid[j] = 1;
  }
  // 4. core = solid region shrunk away from the outline; soft ramp so there's no seam
  const diag = Math.hypot(x1 - x0, y1 - y0);
  const r = Math.max(3, Math.round(diag * 0.012));
  const core = boxBlur(morph(solid, w, h, r, false), w, h, Math.ceil(r / 2));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const c = Math.min(1, core[i] * 1.25);
    out[i] = alpha[i] > c ? alpha[i] : c;
  }
  return out;
}

/** Fill every region of a 0/1 mask that isn't connected to the image border (holes inside the object). */
export function fillHoles(bin: Float32Array, w: number, h: number): Float32Array {
  const n = w * h;
  const outside = new Uint8Array(n);
  const stack = new Int32Array(n);
  let sp = 0;
  const seed = (i: number) => {
    if (bin[i] < 0.5 && !outside[i]) {
      outside[i] = 1;
      stack[sp++] = i;
    }
  };
  for (let x = 0; x < w; x++) {
    seed(x);
    seed((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    seed(y * w);
    seed(y * w + w - 1);
  }
  while (sp) {
    const i = stack[--sp];
    const x = i % w;
    if (x > 0) seed(i - 1);
    if (x < w - 1) seed(i + 1);
    if (i >= w) seed(i - w);
    if (i < n - w) seed(i + w);
  }
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = outside[i] ? 0 : 1;
  return out;
}
