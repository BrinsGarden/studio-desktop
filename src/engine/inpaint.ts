/**
 * Content-aware fill: fills the masked hole with patches copied from the rest of the image
 * (multi-scale PatchMatch + voting, after Wexler et al. / Barnes et al.). Pure JS, no DOM.
 */

const R = 3; // patch radius → 7x7 patches
const BIG = 1e30;

interface Level {
  w: number;
  h: number;
  img: Float32Array; // r,g,b interleaved, 0..255
  hole: Uint8Array;
}

function downsample(l: Level): Level {
  const w = Math.max(1, Math.floor(l.w / 2));
  const h = Math.max(1, Math.floor(l.h / 2));
  const img = new Float32Array(w * h * 3);
  const hole = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let n = 0;
      let r = 0;
      let g = 0;
      let b = 0;
      let anyHole = 0;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const sx = Math.min(l.w - 1, x * 2 + dx);
          const sy = Math.min(l.h - 1, y * 2 + dy);
          const si = sy * l.w + sx;
          if (l.hole[si]) {
            anyHole = 1;
            continue;
          }
          r += l.img[si * 3];
          g += l.img[si * 3 + 1];
          b += l.img[si * 3 + 2];
          n++;
        }
      }
      const di = y * w + x;
      hole[di] = anyHole;
      if (n) {
        img[di * 3] = r / n;
        img[di * 3 + 1] = g / n;
        img[di * 3 + 2] = b / n;
      }
    }
  }
  return { w, h, img, hole };
}

/** Fill holes by repeatedly averaging known neighbours (onion peel). */
function diffuseFill(l: Level) {
  const { w, h, img } = l;
  const known = new Uint8Array(w * h);
  for (let i = 0; i < known.length; i++) known[i] = l.hole[i] ? 0 : 1;
  let remaining = known.reduce((a, v) => a + (v ? 0 : 1), 0);
  let guard = w + h + 4;
  while (remaining > 0 && guard-- > 0) {
    const next = known.slice();
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (known[i]) continue;
        let n = 0;
        let r = 0;
        let g = 0;
        let b = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
            const j = yy * w + xx;
            if (!known[j]) continue;
            r += img[j * 3];
            g += img[j * 3 + 1];
            b += img[j * 3 + 2];
            n++;
          }
        }
        if (n) {
          img[i * 3] = r / n;
          img[i * 3 + 1] = g / n;
          img[i * 3 + 2] = b / n;
          next[i] = 1;
          remaining--;
        }
      }
    }
    known.set(next);
  }
}

/** Pixels whose whole patch is inside the image and outside the hole can be copied from. */
function validSources(l: Level): Uint8Array {
  const { w, h, hole } = l;
  const v = new Uint8Array(w * h);
  // distance-to-hole via dilation by R
  const near = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!hole[y * w + x]) continue;
      for (let dy = -R; dy <= R; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -R; dx <= R; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          near[yy * w + xx] = 1;
        }
      }
    }
  }
  for (let y = R; y < h - R; y++) for (let x = R; x < w - R; x++) if (!near[y * w + x]) v[y * w + x] = 1;
  return v;
}

/** Pixels whose patch touches the hole (these get matched and voted). */
function targetPixels(l: Level): Int32Array {
  const { w, h, hole } = l;
  const mark = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!hole[y * w + x]) continue;
      for (let dy = -R; dy <= R; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -R; dx <= R; dx++) {
          const xx = x + dx;
          if (xx >= 0 && xx < w) mark[yy * w + xx] = 1;
        }
      }
    }
  }
  const out: number[] = [];
  for (let i = 0; i < mark.length; i++) if (mark[i]) out.push(i);
  return Int32Array.from(out);
}

function patchDist(l: Level, tx: number, ty: number, sx: number, sy: number, cutoff: number): number {
  const { w, h, img } = l;
  let d = 0;
  let n = 0;
  for (let dy = -R; dy <= R; dy++) {
    const ty2 = ty + dy;
    if (ty2 < 0 || ty2 >= h) continue;
    const sy2 = sy + dy;
    for (let dx = -R; dx <= R; dx++) {
      const tx2 = tx + dx;
      if (tx2 < 0 || tx2 >= w) continue;
      const ti = (ty2 * w + tx2) * 3;
      const si = (sy2 * w + sx + dx) * 3;
      const a = img[ti] - img[si];
      const b = img[ti + 1] - img[si + 1];
      const c = img[ti + 2] - img[si + 2];
      d += a * a + b * b + c * c;
      n++;
    }
    if (d > cutoff * 49) return BIG;
  }
  return n ? d / n : BIG;
}

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

function solveLevel(l: Level, nnf: Int32Array, iters: number, rand: () => number) {
  const { w, h } = l;
  const valid = validSources(l);
  const validList: number[] = [];
  for (let i = 0; i < valid.length; i++) if (valid[i]) validList.push(i);
  if (!validList.length) return;
  const targets = targetPixels(l);
  const tset = new Uint8Array(w * h);
  for (const t of targets) tset[t] = 1;
  const dist = new Float32Array(w * h).fill(BIG);

  // make every target's match valid
  for (const t of targets) {
    if (nnf[t] < 0 || !valid[nnf[t]]) nnf[t] = validList[Math.floor(rand() * validList.length)];
  }

  for (let em = 0; em < iters; em++) {
    for (const t of targets) dist[t] = patchDist(l, t % w, Math.floor(t / w), nnf[t] % w, Math.floor(nnf[t] / w), BIG);
    // PatchMatch: propagation + random search, alternating scan direction
    for (let pass = 0; pass < 2; pass++) {
      const fwd = pass % 2 === 0;
      for (let k = 0; k < targets.length; k++) {
        const t = targets[fwd ? k : targets.length - 1 - k];
        const tx = t % w;
        const ty = (t - tx) / w;
        const step = fwd ? -1 : 1;
        let best = nnf[t];
        let bestD = dist[t];
        // propagate from left/right and up/down neighbours
        for (const [nx, ny] of [
          [tx + step, ty],
          [tx, ty + step],
        ]) {
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const nb = ny * w + nx;
          if (!tset[nb]) continue;
          const cx = (nnf[nb] % w) + (tx - nx);
          const cy = Math.floor(nnf[nb] / w) + (ty - ny);
          if (cx < 0 || cx >= w) continue;
          const cand = cy * w + cx;
          if (cy < 0 || cy >= h || cand < 0 || cand >= w * h || !valid[cand]) continue;
          const d = patchDist(l, tx, ty, cand % w, Math.floor(cand / w), bestD);
          if (d < bestD) {
            bestD = d;
            best = cand;
          }
        }
        // random search around the current best
        let radius = Math.max(w, h);
        const bx = best % w;
        const by = Math.floor(best / w);
        while (radius >= 1) {
          const rx = Math.round(bx + (rand() * 2 - 1) * radius);
          const ry = Math.round(by + (rand() * 2 - 1) * radius);
          if (rx >= 0 && ry >= 0 && rx < w && ry < h) {
            const cand = ry * w + rx;
            if (valid[cand]) {
              const d = patchDist(l, tx, ty, rx, ry, bestD);
              if (d < bestD) {
                bestD = d;
                best = cand;
              }
            }
          }
          radius = Math.floor(radius / 2);
        }
        nnf[t] = best;
        dist[t] = bestD;
      }
    }
    // vote: every hole pixel becomes the weighted average of the patches covering it
    const acc = new Float32Array(w * h * 4);
    let meanD = 0;
    for (const t of targets) meanD += dist[t] < BIG ? dist[t] : 0;
    meanD = Math.max(1, meanD / Math.max(1, targets.length));
    for (const t of targets) {
      const tx = t % w;
      const ty = (t - tx) / w;
      const s = nnf[t];
      const sx = s % w;
      const sy = (s - sx) / w;
      const wgt = Math.exp(-dist[t] / (2 * meanD));
      for (let dy = -R; dy <= R; dy++) {
        const qy = ty + dy;
        if (qy < 0 || qy >= h) continue;
        for (let dx = -R; dx <= R; dx++) {
          const qx = tx + dx;
          if (qx < 0 || qx >= w) continue;
          const q = qy * w + qx;
          if (!l.hole[q]) continue;
          const si = ((sy + dy) * w + sx + dx) * 3;
          acc[q * 4] += l.img[si] * wgt;
          acc[q * 4 + 1] += l.img[si + 1] * wgt;
          acc[q * 4 + 2] += l.img[si + 2] * wgt;
          acc[q * 4 + 3] += wgt;
        }
      }
    }
    for (let q = 0; q < w * h; q++) {
      if (!l.hole[q] || acc[q * 4 + 3] <= 0) continue;
      l.img[q * 3] = acc[q * 4] / acc[q * 4 + 3];
      l.img[q * 3 + 1] = acc[q * 4 + 1] / acc[q * 4 + 3];
      l.img[q * 3 + 2] = acc[q * 4 + 2] / acc[q * 4 + 3];
    }
  }
}

/**
 * Fill `hole` (1 = fill) in an RGBA image. Returns new RGBA bytes; alpha is kept.
 * Works best when the image includes a generous margin of surroundings around the hole.
 */
export function inpaint(rgba: Uint8ClampedArray, w: number, h: number, hole: Uint8Array, seed = 1): Uint8ClampedArray {
  const rand = rng(seed);
  const img = new Float32Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    img[i * 3] = rgba[i * 4];
    img[i * 3 + 1] = rgba[i * 4 + 1];
    img[i * 3 + 2] = rgba[i * 4 + 2];
  }
  const levels: Level[] = [{ w, h, img, hole: hole.slice() }];
  while (Math.min(levels[levels.length - 1].w, levels[levels.length - 1].h) > 4 * (2 * R + 1) && levels.length < 8) {
    levels.push(downsample(levels[levels.length - 1]));
  }
  const top = levels[levels.length - 1];
  diffuseFill(top);
  let nnf = new Int32Array(top.w * top.h).fill(-1);
  for (let li = levels.length - 1; li >= 0; li--) {
    const l = levels[li];
    const iters = li === levels.length - 1 ? 6 : li === 0 ? 2 : 3;
    solveLevel(l, nnf, iters, rand);
    if (li > 0) {
      // carry the filled colours and matches up to the next finer level
      const f = levels[li - 1];
      for (let y = 0; y < f.h; y++) {
        for (let x = 0; x < f.w; x++) {
          const i = y * f.w + x;
          if (!f.hole[i]) continue;
          const cx = Math.min(l.w - 1, x >> 1);
          const cy = Math.min(l.h - 1, y >> 1);
          const ci = cy * l.w + cx;
          f.img[i * 3] = l.img[ci * 3];
          f.img[i * 3 + 1] = l.img[ci * 3 + 1];
          f.img[i * 3 + 2] = l.img[ci * 3 + 2];
        }
      }
      const up = new Int32Array(f.w * f.h).fill(-1);
      for (let y = 0; y < f.h; y++) {
        for (let x = 0; x < f.w; x++) {
          const cx = Math.min(l.w - 1, x >> 1);
          const cy = Math.min(l.h - 1, y >> 1);
          const m = nnf[cy * l.w + cx];
          if (m < 0) continue;
          const sx = Math.min(f.w - 1, (m % l.w) * 2 + (x & 1));
          const sy = Math.min(f.h - 1, Math.floor(m / l.w) * 2 + (y & 1));
          up[y * f.w + x] = sy * f.w + sx;
        }
      }
      nnf = up;
    }
  }
  const out = new Uint8ClampedArray(rgba);
  for (let i = 0; i < w * h; i++) {
    if (!hole[i]) continue;
    out[i * 4] = img[i * 3];
    out[i * 4 + 1] = img[i * 3 + 1];
    out[i * 4 + 2] = img[i * 3 + 2];
  }
  return out;
}
