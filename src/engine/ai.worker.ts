/**
 * Background worker for the Cutout tool. Runs the AI models (Segment Anything to find
 * which person/object you clicked, plus a matting model for fine hair edges) and all the
 * heavy edge math, so the editor stays responsive. Models download once from Hugging Face
 * and are cached by the browser.
 */
import { AutoModel, AutoProcessor, RawImage, SamModel, Tensor, env } from '@huggingface/transformers';
import { GPU_FAIL, TOO_BIG, type FromWorker, type PickPoint, type Quality, type ToWorker } from './aiProtocol';
import { adjustEdges, refineMatte, upsampleMatte, type EdgeSettings } from './cutoutPipeline';
import {
  boxBlur,
  estimateForeground,
  expandRect,
  fillHoles,
  floatToHalf,
  halfToFloat,
  morph,
  planesFromRGBA,
  removeSpecks,
  resizeBilinear,
  toBytes,
  type Planes,
  type Rect,
} from './matte';

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyModel = any;

const scope = self as unknown as {
  postMessage(msg: FromWorker, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<ToWorker>) => void) | null;
};
const post = (msg: FromWorker, transfer: Transferable[] = []) => scope.postMessage(msg, transfer);

interface Img {
  id: string;
  w: number;
  h: number;
  bitmap: ImageBitmap;
  rgba: Uint8ClampedArray;
}

const MATTE: Record<Quality, { id: string; label: string; gpu: string; cpu: string | null; norm: 'imagenet' | 'half'; config?: object }> = {
  fast: { id: 'briaai/RMBG-1.4', label: 'fast cutout model', gpu: 'fp16', cpu: 'q8', norm: 'half', config: { model_type: 'custom' } },
  best: { id: 'onnx-community/BiRefNet_lite-ONNX', label: 'cutout model', gpu: 'fp16', cpu: 'fp32', norm: 'imagenet' },
  max: { id: 'onnx-community/BiRefNet-portrait-ONNX', label: 'max-quality people model', gpu: 'fp16', cpu: null, norm: 'imagenet' },
};
const SAM_ID = 'Xenova/slimsam-77-uniform';

let device: 'webgpu' | 'wasm' | null = null;
/** Whether the graphics card can run half-precision (smaller, faster) models. */
let gpuF16 = false;
let img: Img | null = null;
const matteModels = new Map<string, Promise<AnyModel>>();
let sam: { model: AnyModel; processor: AnyModel } | null = null;
let samLoading: Promise<void> | null = null;
let samEmb: { imageId: string; inputs: AnyModel; emb: AnyModel; sw: number; sh: number; scale: number } | null = null;

/** Work rectangle (layer pixels) and everything computed for it. */
let wr: Rect | null = null;
let planes: Planes | null = null;
let base: Float32Array | null = null;
let userRefine: Uint8Array | null = null;
let refineVersion = 0;
let refined: { key: string; a: Float32Array } | null = null;
let lastMatte: { key: string; roi: Rect; coarse: Float32Array; cw: number; ch: number } | null = null;

/* ---------------- helpers ---------------- */

function progressReporter(id: number, label: string) {
  const files = new Map<string, { loaded: number; total: number }>();
  let lastSent = 0;
  return (p: any) => {
    if (!p) return;
    if (p.status === 'progress_total' && p.total) {
      send(p.loaded, p.total);
      return;
    }
    if (p.status === 'progress' && p.file) {
      files.set(p.file, { loaded: p.loaded ?? 0, total: p.total ?? 0 });
      let L = 0;
      let T = 0;
      files.forEach((f) => {
        L += f.loaded;
        T += f.total;
      });
      if (T > 0) send(L, T);
    }
  };
  function send(L: number, T: number) {
    const now = performance.now();
    if (now - lastSent < 150 && L < T) return;
    lastSent = now;
    const mb = (b: number) => `${Math.round(b / 1e6)} MB`;
    post({ type: 'progress', id, text: `Downloading ${label} (first time only) — ${mb(L)} of ${mb(T)}`, progress: L / T });
  }
}

async function detectDevice(): Promise<'webgpu' | 'wasm'> {
  if (device) return device;
  try {
    const gpu = (navigator as any).gpu;
    const adapter = gpu ? await gpu.requestAdapter() : null;
    device = adapter ? 'webgpu' : 'wasm';
    gpuF16 = !!adapter?.features?.has?.('shader-f16');
  } catch {
    device = 'wasm';
  }
  return device;
}

/** Models whose GPU run failed on this machine; they run on the CPU from then on. */
const cpuOnly = new Set<string>();

function loadMatte(id: number, q: Quality, dtypeOverride?: string, devOverride?: 'webgpu' | 'wasm'): Promise<AnyModel> {
  const spec = MATTE[q];
  const dev = devOverride ?? (cpuOnly.has(q) ? 'wasm' : device!);
  const dtype = dtypeOverride ?? (dev === 'webgpu' ? (gpuF16 ? spec.gpu : 'fp32') : spec.cpu);
  if (!dtype) throw new Error('Max quality needs a graphics card with WebGPU. Use Best instead.');
  const key = `${q}|${dev}|${dtype}`;
  let p = matteModels.get(key);
  if (!p) {
    post({ type: 'progress', id, text: `Loading ${spec.label}…`, progress: null });
    p = AutoModel.from_pretrained(spec.id, {
      device: dev,
      dtype: dtype as any,
      progress_callback: progressReporter(id, spec.label),
      ...(spec.config ? { config: spec.config as any } : {}),
    });
    matteModels.set(key, p);
    p.catch(() => matteModels.delete(key));
  }
  return p;
}

async function ensureSam(id: number) {
  if (sam) return;
  if (!samLoading) {
    samLoading = (async () => {
      const dev = cpuOnly.has('sam') ? 'wasm' : await detectDevice();
      const progress_callback = progressReporter(id, 'object finder');
      const model = await SamModel.from_pretrained(SAM_ID, {
        device: dev === 'webgpu' ? ({ vision_encoder: 'webgpu', prompt_encoder_mask_decoder: 'wasm' } as any) : 'wasm',
        dtype: dev === 'webgpu' ? ({ vision_encoder: 'fp32', prompt_encoder_mask_decoder: 'q8' } as any) : 'q8',
        progress_callback,
      });
      const processor = await AutoProcessor.from_pretrained(SAM_ID, { progress_callback });
      sam = { model, processor };
    })();
    samLoading.catch(() => {
      samLoading = null;
    });
  }
  await samLoading;
}

async function ensureSamEmbeddings(id: number) {
  await ensureSam(id);
  if (!img) throw new Error('No image');
  if (samEmb && samEmb.imageId === img.id) return samEmb;
  post({ type: 'progress', id, text: 'Looking at the photo…', progress: null });
  const scale = Math.min(1, 1024 / Math.max(img.w, img.h));
  const sw = Math.max(1, Math.round(img.w * scale));
  const sh = Math.max(1, Math.round(img.h * scale));
  const oc = new OffscreenCanvas(sw, sh);
  const ctx = oc.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img.bitmap, 0, 0, sw, sh);
  const data = ctx.getImageData(0, 0, sw, sh).data;
  const rgb = new Uint8ClampedArray(sw * sh * 3);
  for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
    rgb[j] = data[i];
    rgb[j + 1] = data[i + 1];
    rgb[j + 2] = data[i + 2];
  }
  const raw = new RawImage(rgb, sw, sh, 3);
  const inputs = await sam!.processor(raw);
  let emb: AnyModel;
  try {
    emb = await sam!.model.get_image_embeddings(inputs);
  } catch (err) {
    if (device === 'webgpu' && !cpuOnly.has('sam')) throw new Error(`${GPU_FAIL}sam:${String(err).slice(0, 200)}`);
    throw err;
  }
  samEmb = { imageId: img.id, inputs, emb, sw, sh, scale };
  return samEmb;
}

/** Soft object mask at small resolution (sw×sh) for the clicked points / box. */
async function runSam(id: number, points: PickPoint[]) {
  const e = await ensureSamEmbeddings(id);
  post({ type: 'progress', id, text: 'Finding the object…', progress: null });
  const [rh, rw] = e.inputs.reshaped_input_sizes[0];
  const [oh, ow] = e.inputs.original_sizes[0];
  const kx = (e.scale * rw) / ow;
  const ky = (e.scale * rh) / oh;
  const feeds: Record<string, unknown> = { ...e.emb };
  feeds.input_points = new Tensor('float32', Float32Array.from(points.flatMap((p) => [p.x * kx, p.y * ky])), [1, 1, points.length, 2]);
  feeds.input_labels = new Tensor('int64', BigInt64Array.from(points.map((p) => BigInt(p.label))), [1, 1, points.length]);
  const out = await sam!.model(feeds);
  const masks = await sam!.processor.post_process_masks(out.pred_masks, e.inputs.original_sizes, e.inputs.reshaped_input_sizes, { binarize: false });
  const m = masks[0];
  const scores: Float32Array = out.iou_scores.data;
  const [, , mh, mw] = m.dims as number[];
  const plane = mh * mw;
  const src = m.data as Float32Array | Uint8Array;
  const isBoolMask = !(src instanceof Float32Array);
  let best = 0;
  for (let i = 1; i < scores.length; i++) if (scores[i] > scores[best]) best = i;
  // SAM offers part / sub-part / whole-object masks. A plain click on a person usually means the
  // whole person, so take the biggest confident mask unless the user is excluding things.
  if (points.every((p) => p.label === 1)) {
    const area = (k: number) => {
      let n = 0;
      for (let i = 0; i < plane; i++) if ((src[k * plane + i] as number) > 0) n++;
      return n;
    };
    let pick = best;
    let pickArea = area(best);
    for (let k = 0; k < scores.length; k++) {
      if (k === best || scores[k] < scores[best] * 0.8) continue;
      const a = area(k);
      if (a > pickArea && a < plane * 0.85) {
        pick = k;
        pickArea = a;
      }
    }
    best = pick;
  }
  const soft = new Float32Array(plane);
  for (let i = 0; i < plane; i++) {
    const v = src[best * plane + i] as number;
    soft[i] = isBoolMask ? (v ? 1 : 0) : 1 / (1 + Math.exp(-v));
  }
  return { soft, w: mw, h: mh, scale: e.scale };
}

function bboxOf(a: Float32Array, w: number, h: number, thr: number): Rect | null {
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (a[y * w + x] >= thr) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** Run the matting model on one rectangle of the image; returns its raw matte (model resolution). */
async function matteRect(id: number, q: Quality, roi: Rect): Promise<{ coarse: Float32Array; cw: number; ch: number }> {
  const key = `${img!.id}|${q}|${roi.x},${roi.y},${roi.w},${roi.h}`;
  if (lastMatte && lastMatte.key === key) return lastMatte;
  await detectDevice();
  post({ type: 'device', id, device: device! });
  let model = await loadMatte(id, q);
  const onGpu = device === 'webgpu' && !cpuOnly.has(q);
  post({ type: 'progress', id, text: onGpu ? 'Cutting out (GPU)…' : 'Cutting out (CPU — this can take a minute)…', progress: null });
  const S = 1024;
  const oc = new OffscreenCanvas(S, S);
  const ctx = oc.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, S, S);
  ctx.drawImage(img!.bitmap, roi.x, roi.y, roi.w, roi.h, 0, 0, S, S);
  const d = ctx.getImageData(0, 0, S, S).data;
  const t = new Float32Array(3 * S * S);
  const spec = MATTE[q];
  const mean = spec.norm === 'imagenet' ? [0.485, 0.456, 0.406] : [0.5, 0.5, 0.5];
  const std = spec.norm === 'imagenet' ? [0.229, 0.224, 0.225] : [1, 1, 1];
  for (let i = 0, p = 0; p < S * S; i += 4, p++) {
    t[p] = (d[i] / 255 - mean[0]) / std[0];
    t[S * S + p] = (d[i + 1] / 255 - mean[1]) / std[1];
    t[2 * S * S + p] = (d[i + 2] / 255 - mean[2]) / std[2];
  }

  const run = async (m: AnyModel) => {
    const sess = m.sessions?.model ?? Object.values(m.sessions ?? {})[0];
    const inName: string = sess?.inputNames?.[0] ?? 'input_image';
    let out: Record<string, any>;
    try {
      out = await m({ [inName]: new Tensor('float32', t, [1, 3, S, S]) });
    } catch (err) {
      if (!/float16|type/i.test(String(err))) throw err;
      out = await m({ [inName]: new Tensor('float16', floatToHalf(t), [1, 3, S, S]) });
    }
    const outName: string | undefined = sess?.outputNames?.[0];
    const o = (outName && out[outName]) || Object.values(out)[0];
    const dims = o.dims as number[];
    const ch = dims[dims.length - 2];
    const cw = dims[dims.length - 1];
    const raw = o.data;
    const data = raw instanceof Float32Array ? Float32Array.from(raw.subarray(0, cw * ch)) : raw instanceof Uint16Array ? halfToFloat(raw.subarray(0, cw * ch)) : Float32Array.from(raw as ArrayLike<number>).subarray(0, cw * ch);
    let mn = Infinity;
    let mx = -Infinity;
    let bad = false;
    for (let i = 0; i < data.length; i++) {
      const v = data[i];
      if (Number.isNaN(v)) {
        bad = true;
        break;
      }
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    if (bad || mx - mn < 1e-6) throw new Error('degenerate');
    if (mn < -0.01 || mx > 1.01) {
      for (let i = 0; i < data.length; i++) data[i] = 1 / (1 + Math.exp(-data[i]));
      mn = Infinity;
      mx = -Infinity;
      for (let i = 0; i < data.length; i++) {
        if (data[i] < mn) mn = data[i];
        if (data[i] > mx) mx = data[i];
      }
    }
    if (spec.norm === 'half' && mx > mn) for (let i = 0; i < data.length; i++) data[i] = (data[i] - mn) / (mx - mn);
    return { coarse: data, cw, ch };
  };

  // A failed GPU run leaves the AI library unable to run anything else in this worker,
  // so report it and let the page restart the worker with this model on the CPU.
  const gpuFail = (err: unknown): Error =>
    MATTE[q].cpu ? new Error(`${GPU_FAIL}${q}:${String(err).slice(0, 200)}`) : new Error("Your graphics card can't run Max quality. Use Best instead.");
  let res: { coarse: Float32Array; cw: number; ch: number };
  try {
    res = await run(model);
  } catch (err) {
    // half-precision models occasionally produce garbage on some GPUs — retry in full precision
    if (onGpu && String(err).includes('degenerate')) {
      // half-precision produced garbage (the run itself succeeded) — retry in full precision
      post({ type: 'progress', id, text: 'Retrying in full precision…', progress: null });
      model = await loadMatte(id, q, 'fp32');
      try {
        res = await run(model);
      } catch (e2) {
        throw gpuFail(e2);
      }
    } else if (onGpu) {
      throw gpuFail(err);
    } else if (/bad_alloc|memory|allocation|OOM/i.test(String(err))) {
      throw new Error(`${TOO_BIG}${q}`);
    } else throw err;
  }
  lastMatte = { key, roi, ...res };
  return res;
}

function setWorkRect(r: Rect) {
  if (wr && wr.x === r.x && wr.y === r.y && wr.w === r.w && wr.h === r.h && planes) return;
  wr = r;
  planes = planesFromRGBA(img!.rgba, img!.w, r);
  userRefine = null;
  refineVersion++;
}

/** Build the base matte for `roi`, optionally limited to a SAM object mask. */
async function buildBase(id: number, q: Quality, roi: Rect, samMask: { soft: Float32Array; w: number; h: number; scale: number } | null, boxOnly: boolean) {
  const W = img!.w;
  const H = img!.h;
  const margin = Math.max(24, Math.round(0.03 * Math.max(roi.w, roi.h)));
  setWorkRect(expandRect(roi, margin, W, H));
  const { coarse, cw, ch } = await matteRect(id, q, roi);
  post({ type: 'progress', id, text: 'Refining edges…', progress: null });
  // full-res matte for the roi, following the photo's real edges
  const roiPlanes: Planes = planesFromRGBA(img!.rgba, W, roi);
  const up = upsampleMatte(roiPlanes, coarse, cw, ch, roi.w, roi.h);
  const b = new Float32Array(wr!.w * wr!.h);
  const ox = roi.x - wr!.x;
  const oy = roi.y - wr!.y;
  for (let y = 0; y < roi.h; y++) b.set(up.subarray(y * roi.w, (y + 1) * roi.w), (y + oy) * wr!.w + ox);

  if (samMask) {
    // keep only what's near the object SAM found; the matte decides the fine edge
    const { soft, w: sw, h: sh, scale } = samMask;
    const bin = new Float32Array(sw * sh);
    for (let i = 0; i < bin.length; i++) bin[i] = soft[i] >= 0.35 ? 1 : 0;
    // the object finder often misses patches inside a person (white clothing, pale skin) or a limb;
    // the gate only needs to keep other objects out, so fill its holes and grow it generously
    const r = Math.max(4, Math.round(0.06 * Math.max(sw, sh)));
    const gate = boxBlur(morph(fillHoles(bin, sw, sh), sw, sh, r, true), sw, sh, Math.ceil(r / 2));
    // sample gate into work-rect pixels
    const gx0 = wr!.x * scale;
    const gy0 = wr!.y * scale;
    const gw = Math.max(1, Math.round(wr!.w * scale));
    const gh = Math.max(1, Math.round(wr!.h * scale));
    const sub = new Float32Array(gw * gh);
    for (let y = 0; y < gh; y++) {
      const sy = Math.min(sh - 1, Math.max(0, Math.round(gy0 + y)));
      for (let x = 0; x < gw; x++) {
        const sx = Math.min(sw - 1, Math.max(0, Math.round(gx0 + x)));
        sub[y * gw + x] = gate[sy * sw + sx];
      }
    }
    const g = resizeBilinear(sub, gw, gh, wr!.w, wr!.h);
    for (let i = 0; i < b.length; i++) b[i] *= Math.min(1, g[i] * 1.6);
  }
  const reach = Math.max(8, Math.round(0.04 * Math.hypot(roi.w, roi.h)));
  base = removeSpecks(b, wr!.w, wr!.h, boxOnly ? 0.08 : 0.004, reach);
  refined = null;
}

function finalAlpha(edges: EdgeSettings): Uint8Array {
  const key = `${edges.edgeRadius}|${edges.refineBrush}|${refineVersion}`;
  if (!refined || refined.key !== key) {
    refined = { key, a: refineMatte(planes!, base!, wr!.w, wr!.h, edges.edgeRadius, edges.refineBrush, userRefine) };
  }
  return toBytes(adjustEdges(refined.a, wr!.w, wr!.h, edges));
}

function sendAlpha(id: number, edges: EdgeSettings) {
  if (!base || !wr) return;
  const data = finalAlpha(edges);
  post({ type: 'alpha', id, wr: { ...wr }, data }, [data.buffer]);
}

/* ---------------- message loop ---------------- */

let queue: Promise<void> = Promise.resolve();
let latestEdgesId = 0;

async function handle(m: ToWorker) {
  switch (m.type) {
    case 'init': {
      env.allowLocalModels = false;
      env.useBrowserCache = true;
      if (m.remoteHost) env.remoteHost = m.remoteHost;
      m.cpuOnly.forEach((q) => cpuOnly.add(q));
      const onnx = env.backends.onnx as any;
      if (onnx?.wasm) {
        onnx.wasm.wasmPaths = {
          mjs: `${m.wasmBase}ort-wasm-simd-threaded.asyncify.mjs`,
          wasm: `${m.wasmBase}ort-wasm-simd-threaded.asyncify.wasm`,
        };
      }
      post({ type: 'device', id: m.id, device: await detectDevice() });
      break;
    }
    case 'setImage': {
      const { bitmap } = m;
      const oc = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = oc.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(bitmap, 0, 0);
      img = { id: m.imageId, w: bitmap.width, h: bitmap.height, bitmap, rgba: ctx.getImageData(0, 0, bitmap.width, bitmap.height).data };
      wr = null;
      planes = null;
      base = null;
      refined = null;
      userRefine = null;
      lastMatte = null;
      break;
    }
    case 'warmSam':
      if (img) await ensureSamEmbeddings(m.id);
      break;
    case 'pick': {
      if (!img) throw new Error('No image');
      const W = img.w;
      const H = img.h;
      let samMask: Awaited<ReturnType<typeof runSam>> | null = null;
      let roi: Rect | null = null;
      // a dragged box goes straight to the matting model (cropping to the box is what isolates the person);
      // clicked points use the object finder to work out which person you meant
      const useSam = m.points.length > 0;
      if (useSam) {
        samMask = await runSam(m.id, m.points);
        const prev = new Uint8Array(samMask.soft.length);
        for (let i = 0; i < prev.length; i++) prev[i] = samMask.soft[i] >= 0.5 ? 255 : 0;
        post({ type: 'samPreview', id: m.id, w: samMask.w, h: samMask.h, data: prev }, [prev.buffer]);
        const bb = bboxOf(samMask.soft, samMask.w, samMask.h, 0.5);
        if (!bb) throw new Error("Couldn't find an object there — try clicking the middle of the person.");
        const k = 1 / samMask.scale;
        const full = { x: bb.x * k, y: bb.y * k, w: bb.w * k, h: bb.h * k };
        roi = expandRect(full, 0.12 * Math.max(full.w, full.h), W, H);
      }
      if (m.box) {
        const b = expandRect(m.box, 0.03 * Math.max(m.box.w, m.box.h), W, H);
        roi = roi ? expandRect({ x: Math.min(roi.x, b.x), y: Math.min(roi.y, b.y), w: Math.max(roi.x + roi.w, b.x + b.w) - Math.min(roi.x, b.x), h: Math.max(roi.y + roi.h, b.y + b.h) - Math.min(roi.y, b.y) }, 0, W, H) : b;
      }
      if (!roi) throw new Error('Click a person or drag a box around them.');
      // snap the roi so small extra clicks reuse the same model run
      roi = snapRect(roi, W, H);
      await buildBase(m.id, m.quality, roi, samMask, !samMask);
      sendAlpha(m.id, m.edges);
      break;
    }
    case 'subject': {
      if (!img) throw new Error('No image');
      await buildBase(m.id, m.quality, { x: 0, y: 0, w: img.w, h: img.h }, null, false);
      sendAlpha(m.id, m.edges);
      break;
    }
    case 'edges':
      if (m.id < latestEdgesId) break;
      sendAlpha(m.id, m.edges);
      break;
    case 'refine':
      if (!wr) break;
      userRefine = m.data;
      refineVersion++;
      sendAlpha(m.id, m.edges);
      break;
    case 'decontam': {
      if (!wr || !planes) throw new Error('Nothing to clean up yet');
      post({ type: 'progress', id: m.id, text: 'Cleaning edge colors…', progress: null });
      const a = new Float32Array(m.alpha.length);
      for (let i = 0; i < a.length; i++) a[i] = m.alpha[i] / 255;
      const F = estimateForeground(planes, a, wr.w, wr.h);
      const out = new Uint8ClampedArray(wr.w * wr.h * 4);
      const amt = Math.max(0, Math.min(1, m.amount));
      for (let y = 0; y < wr.h; y++) {
        for (let x = 0; x < wr.w; x++) {
          const i = y * wr.w + x;
          const s = ((wr.y + y) * img!.w + wr.x + x) * 4;
          const o = i * 4;
          const av = a[i];
          const t = av > 0.004 && av < 0.996 ? amt : 0;
          out[o] = img!.rgba[s] + (F[0][i] * 255 - img!.rgba[s]) * t;
          out[o + 1] = img!.rgba[s + 1] + (F[1][i] * 255 - img!.rgba[s + 1]) * t;
          out[o + 2] = img!.rgba[s + 2] + (F[2][i] * 255 - img!.rgba[s + 2]) * t;
          out[o + 3] = img!.rgba[s + 3];
        }
      }
      post({ type: 'decontam', id: m.id, wr: { ...wr }, data: out }, [out.buffer]);
      break;
    }
    case 'reset':
      img?.bitmap.close();
      img = null;
      wr = null;
      planes = null;
      base = null;
      refined = null;
      userRefine = null;
      lastMatte = null;
      samEmb = null;
      break;
  }
}

function snapRect(r: Rect, W: number, H: number): Rect {
  const g = 16;
  const x = Math.max(0, Math.floor(r.x / g) * g);
  const y = Math.max(0, Math.floor(r.y / g) * g);
  const x2 = Math.min(W, Math.ceil((r.x + r.w) / g) * g);
  const y2 = Math.min(H, Math.ceil((r.y + r.h) / g) * g);
  return { x, y, w: x2 - x, h: y2 - y };
}

scope.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'edges') latestEdgesId = Math.max(latestEdgesId, m.id);
  queue = queue.then(async () => {
    try {
      await handle(m);
      post({ type: 'done', id: m.id });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      post({ type: 'error', id: m.id, message: friendly(msg) });
    }
  });
};

function friendly(msg: string): string {
  if (msg.startsWith(GPU_FAIL) || msg.startsWith(TOO_BIG)) return msg;
  if (/fetch|network|Failed to load|404|ERR_/i.test(msg)) return `Couldn't download the AI model. Check your internet connection and try again. (${msg.slice(0, 120)})`;
  if (/memory|allocation|OOM/i.test(msg)) return 'Ran out of memory. Try Fast quality, or drag a box around just the person.';
  return msg;
}
