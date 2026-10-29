import {
  colorRefine,
  edgeBand,
  edgeContrast,
  featherEdge,
  guidedInBand,
  resizeBilinear,
  shiftEdge,
  smoothEdge,
  type Planes,
} from './matte';

/** User-tunable edge settings (all in source pixels unless noted). */
export interface EdgeSettings {
  /** Width of the automatic "smart radius" band where edges are re-solved from colours. 0 = off. */
  edgeRadius: number;
  /** Rounds off jagged edges. */
  smooth: number;
  /** Softens the edge. */
  feather: number;
  /** 0..100 — hardens soft edges. */
  contrast: number;
  /** Negative pulls the edge in, positive pushes it out. */
  shift: number;
  /** Radius of the largest Refine-edge brush used, so colour samples reach past it. */
  refineBrush: number;
}

export const DEFAULT_EDGES: EdgeSettings = { edgeRadius: 0, smooth: 0, feather: 0, contrast: 0, shift: 0, refineBrush: 0 };

/**
 * Turn a model's low-resolution matte into a full-resolution one that follows the photo's real edges.
 * `coarse` is cw×ch (usually 1024²), the image planes are w×h.
 */
export function upsampleMatte(I: Planes, coarse: Float32Array, cw: number, ch: number, w: number, h: number): Float32Array {
  const up = resizeBilinear(coarse, cw, ch, w, h);
  const s = Math.max(w / cw, h / ch, 1);
  const band = edgeBand(up, w, h, Math.round(2 * s) + 2);
  const r = Math.max(2, Math.round(2 * s));
  return guidedInBand(I, up, band, w, h, r, 1e-4);
}

/** Apply refinement and edge settings to a base matte. `userRefine` marks brushed areas (non-zero = refine). */
export function refineMatte(I: Planes, base: Float32Array, w: number, h: number, edgeRadius: number, refineBrush: number, userRefine: Uint8Array | null): Float32Array {
  const auto = edgeRadius > 0 ? edgeBand(base, w, h, Math.round(edgeRadius), 0.05, 0.95) : null;
  if (!auto && !userRefine) return base;
  const band = new Uint8Array(w * h);
  let any = false;
  for (let i = 0; i < band.length; i++) {
    if ((auto && auto[i]) || (userRefine && userRefine[i])) {
      band[i] = 1;
      any = true;
    }
  }
  if (!any) return base;
  return colorRefine(I, base, band, w, h, Math.max(edgeRadius, refineBrush) + 4);
}

export function adjustEdges(alpha: Float32Array, w: number, h: number, s: EdgeSettings): Float32Array {
  let a = alpha;
  a = shiftEdge(a, w, h, s.shift);
  a = smoothEdge(a, w, h, s.smooth);
  a = featherEdge(a, w, h, s.feather);
  a = edgeContrast(a, s.contrast);
  return a;
}
