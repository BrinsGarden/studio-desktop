import { boxBlur } from './matte';

/**
 * Healing: keep the texture from the source spot, but take the colour and brightness of the
 * spot being repaired, so the patch disappears into its surroundings.
 * `source` is the source area already shifted onto the target rectangle, `original` is the target
 * before painting, `coverage` is where the brush painted (alpha 0..255). All RGBA, same w×h.
 */
export function healPixels(source: Uint8ClampedArray, original: Uint8ClampedArray, coverage: Uint8ClampedArray, w: number, h: number, radius: number): Uint8ClampedArray {
  const n = w * h;
  const out = new Uint8ClampedArray(original);
  const r = Math.max(2, Math.round(radius));
  const cov = new Float32Array(n);
  for (let i = 0; i < n; i++) cov[i] = coverage[i * 4 + 3] / 255;
  // tone is measured just around the painted area (the blemish itself shouldn't count)
  const ring = new Float32Array(n);
  for (let i = 0; i < n; i++) ring[i] = cov[i] < 0.02 ? 1 : 0;
  const lp = (a: Float32Array) => boxBlur(boxBlur(a, w, h, r), w, h, r);
  const ringB = lp(ring);
  for (let c = 0; c < 3; c++) {
    const o = new Float32Array(n);
    const s = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      o[i] = original[i * 4 + c] * ring[i];
      s[i] = source[i * 4 + c] * ring[i];
    }
    const lo = lp(o);
    const ls = lp(s);
    for (let i = 0; i < n; i++) {
      if (cov[i] <= 0) continue;
      const k = ringB[i] > 0.02 ? 1 / ringB[i] : 0;
      const healed = source[i * 4 + c] + (lo[i] - ls[i]) * k;
      out[i * 4 + c] = original[i * 4 + c] + (healed - original[i * 4 + c]) * cov[i];
    }
  }
  return out;
}
