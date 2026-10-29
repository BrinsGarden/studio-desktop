/**
 * Cutout tool controller: talks to the AI worker, keeps the in-progress cutout
 * (preview mask + Add/Remove/Refine brush canvases) and applies the result as a layer mask.
 */
import { store, DEFAULT_CUTOUT, type CutoutState } from './store';
import { createCanvas, newId, type Layer } from './engine/types';
import { dropCaches, previewMasks } from './engine/render';
import { Stroke, applyPatch, type PixelPatch } from './engine/brush';
import { GPU_FAIL, TOO_BIG, type FromWorker, type Quality, type PickPoint, type ToWorker } from './engine/aiProtocol';
import type { Rect } from './engine/matte';
import { capCanvas } from './engine/resample';

type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type Req = DistOmit<ToWorker, 'id'>;

interface Pending {
  resolve: (msgs: FromWorker[]) => void;
  reject: (e: Error) => void;
  got: FromWorker[];
}

type BrushCanvas = 'add' | 'remove' | 'refine';

interface Session {
  layerId: string;
  version: number;
  w: number;
  h: number;
  ready: Promise<void>;
  preview: HTMLCanvasElement;
  add: HTMLCanvasElement;
  remove: HTMLCanvasElement;
  refine: HTMLCanvasElement;
  red: HTMLCanvasElement | null;
  redDirty: boolean;
  wr: Rect | null;
  alpha: Uint8Array | null;
  edits: boolean;
  refineRadius: number;
  undo: { canvas: BrushCanvas; patch: PixelPatch }[][];
  redo: { canvas: BrushCanvas; patch: PixelPatch }[][];
  imgData: ImageData | null;
}

let worker: Worker | null = null;

/** Models that crashed on this computer's graphics card; they run on the CPU (remembered across visits). */
const CPU_KEY = 'sd-cutout-cpu-only';
function loadCpuOnly(): string[] {
  try {
    return JSON.parse(localStorage.getItem(CPU_KEY) ?? '[]');
  } catch {
    return [];
  }
}
let cpuOnly: string[] = loadCpuOnly();

/** Quality levels that ran out of memory on this computer. */
const BIG_KEY = 'sd-cutout-too-big';
let tooBig: string[] = (() => {
  try {
    return JSON.parse(localStorage.getItem(BIG_KEY) ?? '[]');
  } catch {
    return [];
  }
})();

export function cutoutTooBig(q: Quality): boolean {
  return tooBig.includes(q);
}
let seq = 0;
const pending = new Map<number, Pending>();
let sess: Session | null = null;
/** Ignore stale results from requests that were superseded. */
let latestPickId = 0;
let latestAlphaId = 0;

/* ---------------- worker plumbing ---------------- */

function setCut(patch: Partial<CutoutState>) {
  store.set({ cutout: { ...store.state.cutout, ...patch } });
}

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./engine/ai.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e: MessageEvent<FromWorker>) => onWorker(e.data);
  worker.onerror = (e) => {
    setCut({ status: 'error', message: `The AI helper crashed: ${e.message || 'unknown error'}. Reload the page and try again.`, progress: null });
    pending.forEach((p) => p.reject(new Error('worker crashed')));
    pending.clear();
    worker = null;
  };
  const params = new URLSearchParams(location.search);
  request({ type: 'init', wasmBase: new URL('ort/', document.baseURI).href, remoteHost: params.get('hf') ?? undefined, cpuOnly }).catch(() => {});
  return worker;
}

/** A model failed on the GPU: remember it, restart the worker (its AI runtime is stuck after a GPU error) and re-send the photo. */
function handleGpuFail(message: string) {
  const key = message.slice(GPU_FAIL.length).split(':')[0];
  if (key && !cpuOnly.includes(key)) {
    cpuOnly = [...cpuOnly, key];
    try {
      localStorage.setItem(CPU_KEY, JSON.stringify(cpuOnly));
    } catch {
      /* private mode — fine, it only lasts this visit */
    }
  }
  restartWorker();
}

/** The AI runtime can't recover from a failed run, so start a fresh worker and re-send the photo. */
function restartWorker() {
  worker?.terminate();
  worker = null;
  pending.forEach((p) => p.reject(new Error('restarted')));
  pending.clear();
  if (sess) sess.ready = uploadImage(sess);
}

function uploadImage(s: Session): Promise<void> {
  const layer = store.state.doc?.layers.find((l) => l.id === s.layerId);
  if (!layer?.canvas) return Promise.reject(new Error('The layer is gone'));
  const src = layer.canvas;
  const p = (async () => {
    const bitmap = await createImageBitmap(src);
    await request({ type: 'setImage', imageId: newId(), bitmap }, [bitmap]);
  })();
  p.catch(() => {});
  return p;
}

function request(msg: Req, transfer: Transferable[] = []): Promise<FromWorker[]> {
  const w = getWorker();
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, got: [] });
    w.postMessage({ ...msg, id } as ToWorker, transfer);
  });
}

function onWorker(m: FromWorker) {
  const p = pending.get(m.id);
  switch (m.type) {
    case 'progress':
      if (store.state.cutout.status !== 'idle' || m.id >= latestPickId) setCut({ status: 'working', message: m.text, progress: m.progress });
      break;
    case 'device':
      setCut({ device: m.device });
      break;
    case 'samPreview':
      if (sess && m.id === latestPickId && !sess.alpha) showSamPreview(m.w, m.h, m.data);
      break;
    case 'alpha':
      if (sess && m.id >= latestAlphaId && m.id >= latestPickId) {
        latestAlphaId = m.id;
        sess.wr = m.wr;
        sess.alpha = m.data;
        rebuildPreview();
        setCut({ hasResult: true });
      }
      break;
    case 'decontam':
      break;
    case 'done':
      if (p) {
        pending.delete(m.id);
        p.resolve(p.got);
      }
      if (store.state.cutout.status === 'working' && pending.size === 0) {
        setCut({ status: sess?.alpha || sess?.edits ? 'ready' : 'idle', message: '', progress: null });
      }
      return;
    case 'error':
      if (p) {
        pending.delete(m.id);
        p.reject(new Error(m.message));
      }
      if (!m.message.startsWith(GPU_FAIL)) setCut({ status: 'error', message: m.message, progress: null });
      return;
  }
  p?.got.push(m);
}

/* ---------------- session ---------------- */

function canvasLike(w: number, h: number) {
  return createCanvas(w, h);
}

/** Long side the cutout works at. Bigger photos are shrunk first: the AI sees 1024px anyway, and full-size
 * upscaled photos need several GB for the edge math, which can freeze or crash the computer. */
const CUT_MAX = 3000;

function shrinkForCutout(layer: Layer): Layer {
  const c = layer.canvas!;
  const long = Math.max(c.width, c.height);
  if (long <= CUT_MAX) return layer;
  const shown = long * layer.scale;
  const target = Math.round(Math.min(long, Math.max(CUT_MAX, Math.min(shown * 1.2, 4096))));
  if (target >= long) return layer;
  const { canvas, factor } = capCanvas(c, target);
  const mask = layer.mask ? capCanvas(layer.mask, target).canvas : null;
  store.mutate('Resize photo for cutout', (d) => {
    const l = d.layers.find((x) => x.id === layer.id);
    if (!l) return;
    l.canvas = canvas;
    if (mask) l.mask = mask;
    l.scale = l.scale / factor;
    l.version++;
  });
  dropCaches(layer.id);
  store.toast(`Photo reduced from ${c.width}×${c.height} to ${canvas.width}×${canvas.height} for the cutout — looks the same on the poster`);
  return store.state.doc!.layers.find((x) => x.id === layer.id) ?? layer;
}

/** Start (or reuse) a cutout on the selected layer. Synchronous so brushes work right away. */
function ensureSession(): Session | null {
  const doc = store.state.doc;
  let layer = store.selected();
  if (!doc || !layer) {
    store.toast('Select the photo layer you want to cut out');
    return null;
  }
  if (layer.kind !== 'image' || !layer.canvas) {
    store.toast('Cutout works on photo layers — pick an image layer (or Rasterize this one first)');
    return null;
  }
  if (sess) {
    if (sess.layerId === layer.id && sess.version === layer.version) return sess;
    if (sess.layerId !== layer.id && (sess.edits || sess.alpha)) {
      store.toast('Apply or cancel the cutout you started first');
      return null;
    }
    endSession();
  }
  layer = shrinkForCutout(layer);
  const src = layer.canvas!;
  const w = src.width;
  const h = src.height;
  const s: Session = {
    layerId: layer.id,
    version: layer.version,
    w,
    h,
    ready: Promise.resolve(),
    preview: canvasLike(w, h),
    add: canvasLike(w, h),
    remove: canvasLike(w, h),
    refine: canvasLike(w, h),
    red: null,
    redDirty: true,
    wr: null,
    alpha: null,
    edits: false,
    refineRadius: 0,
    undo: [],
    redo: [],
    imgData: null,
  };
  sess = s;
  s.ready = uploadImage(s);
  setCut({ layerId: layer.id, hasResult: false, points: [], status: 'idle', message: '', progress: null });
  return s;
}

export function cutoutSessionLayerId(): string | null {
  return sess?.layerId ?? null;
}

function endSession() {
  if (sess) previewMasks.delete(sess.layerId);
  sess = null;
  latestPickId = ++seq;
  if (worker) request({ type: 'reset' }).catch(() => {});
  const c = store.state.cutout;
  setCut({ ...DEFAULT_CUTOUT, mode: c.mode === 'pick' ? 'pick' : c.mode, view: c.view, quality: c.quality, edges: { ...c.edges, refineBrush: 0 }, brush: c.brush, decontam: c.decontam, decontamAmount: c.decontamAmount, device: c.device });
  store.bump();
}

/** Called when the Cutout tool is chosen: load the object finder in the background. */
export function cutoutToolActivated() {
  if (cutoutTooBig(store.state.cutout.quality)) setCut({ quality: 'fast' });
  const layer = store.selected();
  if (!layer || layer.kind !== 'image' || !layer.canvas) return;
  if (sess && sess.layerId !== layer.id) return;
  const s = ensureSession();
  if (!s) return;
  s.ready
    .then(() => request({ type: 'warmSam' }))
    .catch((e: Error) => {
      if (e.message.startsWith(GPU_FAIL)) handleGpuFail(e.message);
    });
}

/* ---------------- AI picks ---------------- */

async function runPick(msg: Req, retried = false, downgraded = false) {
  const s = sess;
  if (!s) return;
  setCut({ status: 'working', message: 'Getting ready…', progress: null });
  try {
    await s.ready;
    getWorker();
    const id = seq + 1;
    latestPickId = id;
    await request(msg);
  } catch (e) {
    const message = (e as Error).message;
    if (message.startsWith(GPU_FAIL) && !retried) {
      setCut({ status: 'working', message: "Your graphics card can't run this model — switching to the CPU (slower)…", progress: null, device: 'wasm' });
      handleGpuFail(message);
      return runPick(msg, true, downgraded);
    }
    if (message.startsWith(TOO_BIG) && !downgraded && (msg.type === 'pick' || msg.type === 'subject') && msg.quality !== 'fast') {
      const q = msg.quality;
      if (!tooBig.includes(q)) {
        tooBig = [...tooBig, q];
        try {
          localStorage.setItem(BIG_KEY, JSON.stringify(tooBig));
        } catch {
          /* fine */
        }
      }
      setCut({ status: 'working', message: `${q === 'max' ? 'Max' : 'Best'} quality is too big for this computer — using Fast instead…`, progress: null, quality: 'fast' });
      restartWorker();
      return runPick({ ...msg, quality: 'fast' }, retried, true);
    }
    setCut({ status: 'error', message: message.startsWith(GPU_FAIL) ? "The AI model couldn't run on this computer." : message, progress: null });
  }
}

function inside(s: Session, p: { x: number; y: number }) {
  return p.x >= 0 && p.y >= 0 && p.x < s.w && p.y < s.h;
}

/** Click on the photo (layer pixels). label 1 adds, 0 excludes. */
export function cutoutPickPoint(p: { x: number; y: number }, label: 0 | 1, additive: boolean) {
  const s = ensureSession();
  if (!s) return;
  if (!inside(s, p)) {
    store.toast('Click on the photo itself');
    return;
  }
  const c = store.state.cutout;
  const pt: PickPoint = { x: Math.round(p.x), y: Math.round(p.y), label };
  const points = additive && c.points.length ? [...c.points, pt] : [{ ...pt, label: 1 as const }];
  setCut({ points });
  runPick({ type: 'pick', points, box: null, quality: c.quality, edges: edgesFor(s) });
}

export function cutoutPickBox(r: Rect) {
  const s = ensureSession();
  if (!s) return;
  const x = Math.max(0, Math.floor(r.x));
  const y = Math.max(0, Math.floor(r.y));
  const box = { x, y, w: Math.min(s.w, Math.ceil(r.x + r.w)) - x, h: Math.min(s.h, Math.ceil(r.y + r.h)) - y };
  if (box.w < 8 || box.h < 8) {
    store.toast('Drag a bigger box around the person');
    return;
  }
  const c = store.state.cutout;
  setCut({ points: [] });
  runPick({ type: 'pick', points: [], box, quality: c.quality, edges: edgesFor(s) });
}

/** Cut out the main subject of the whole photo. */
export function cutoutSubject() {
  const s = ensureSession();
  if (!s) return;
  const c = store.state.cutout;
  setCut({ points: [] });
  runPick({ type: 'subject', quality: c.quality, edges: edgesFor(s) });
}

function edgesFor(s: Session) {
  return { ...store.state.cutout.edges, refineBrush: s.refineRadius };
}

let edgeTimer = 0;
export function setCutoutEdges(patch: Partial<CutoutState['edges']>) {
  setCut({ edges: { ...store.state.cutout.edges, ...patch } });
  window.clearTimeout(edgeTimer);
  edgeTimer = window.setTimeout(() => {
    const s = sess;
    if (!s?.wr) return;
    request({ type: 'edges', edges: edgesFor(s) }).catch(() => {});
  }, 140);
}

/* ---------------- preview ---------------- */

function showSamPreview(w: number, h: number, data: Uint8Array) {
  const s = sess!;
  const small = createCanvas(w, h);
  const sc = small.getContext('2d')!;
  const img = sc.createImageData(w, h);
  for (let i = 0; i < data.length; i++) {
    img.data[i * 4] = 255;
    img.data[i * 4 + 1] = 255;
    img.data[i * 4 + 2] = 255;
    img.data[i * 4 + 3] = data[i];
  }
  sc.putImageData(img, 0, 0);
  const ctx = s.preview.getContext('2d')!;
  ctx.clearRect(0, 0, s.w, s.h);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(small, 0, 0, s.w, s.h);
  previewMasks.set(s.layerId, s.preview);
  s.redDirty = true;
  store.bump();
}

function rebuildPreview() {
  const s = sess;
  if (!s) return;
  const ctx = s.preview.getContext('2d')!;
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, s.w, s.h);
  if (s.alpha && s.wr) {
    const { wr } = s;
    if (!s.imgData || s.imgData.width !== wr.w || s.imgData.height !== wr.h) {
      s.imgData = ctx.createImageData(wr.w, wr.h);
      const d = s.imgData.data;
      for (let i = 0; i < d.length; i += 4) {
        d[i] = 255;
        d[i + 1] = 255;
        d[i + 2] = 255;
      }
    }
    const d = s.imgData.data;
    const a = s.alpha;
    for (let i = 0; i < a.length; i++) d[i * 4 + 3] = a[i];
    ctx.putImageData(s.imgData, wr.x, wr.y);
  } else if (s.edits) {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, s.w, s.h);
  } else {
    previewMasks.delete(s.layerId);
    store.bump();
    return;
  }
  ctx.drawImage(s.add, 0, 0);
  ctx.globalCompositeOperation = 'destination-out';
  ctx.drawImage(s.remove, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  previewMasks.set(s.layerId, s.preview);
  s.redDirty = true;
  store.bump();
}

let rebuildRaf = 0;
function scheduleRebuild() {
  cancelAnimationFrame(rebuildRaf);
  rebuildRaf = requestAnimationFrame(rebuildPreview);
}

/** Red "not selected" overlay in layer pixels, for the Overlay view. */
export function cutoutOverlayCanvas(): HTMLCanvasElement | null {
  const s = sess;
  if (!s || !previewMasks.has(s.layerId)) return null;
  if (!s.red) s.red = createCanvas(s.w, s.h);
  if (s.redDirty) {
    const ctx = s.red.getContext('2d')!;
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, s.w, s.h);
    ctx.fillStyle = 'rgba(255, 30, 70, 0.55)';
    ctx.fillRect(0, 0, s.w, s.h);
    ctx.globalCompositeOperation = 'destination-out';
    ctx.drawImage(s.preview, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    s.redDirty = false;
  }
  return s.red;
}

/** The refine-brush canvas (purple strokes), drawn faintly while painting. */
export function cutoutRefineCanvas(): HTMLCanvasElement | null {
  return sess?.refine ?? null;
}

export function cutoutHasPreview(): boolean {
  return !!sess && previewMasks.has(sess.layerId);
}

/* ---------------- brushes ---------------- */

export class CutoutStroke {
  private strokes: { stroke: Stroke; canvas: BrushCanvas }[];
  readonly mode: 'add' | 'remove' | 'refine';
  readonly layerId: string;

  constructor(s: Session, mode: 'add' | 'remove' | 'refine', diameter: number) {
    this.mode = mode;
    this.layerId = s.layerId;
    const make = (canvas: BrushCanvas, kind: 'paint' | 'erase', color = '#ffffff', hard = 70) => ({
      stroke: new Stroke(s[canvas], kind, color, diameter, hard, 100),
      canvas,
    });
    if (mode === 'add') this.strokes = [make('add', 'paint'), make('remove', 'erase')];
    else if (mode === 'remove') this.strokes = [make('remove', 'paint'), make('add', 'erase')];
    else {
      this.strokes = [make('refine', 'paint', '#b98aff', 85)];
      s.refineRadius = Math.max(s.refineRadius, Math.round(diameter / 2));
    }
  }

  to(x: number, y: number) {
    for (const s of this.strokes) s.stroke.to(x, y);
    if (this.mode !== 'refine') scheduleRebuild();
    else store.bump();
  }

  end() {
    const s = sess;
    if (!s || s.layerId !== this.layerId) return;
    const patches = this.strokes.map((x) => ({ canvas: x.canvas, patch: x.stroke.finish() })).filter((x): x is { canvas: BrushCanvas; patch: PixelPatch } => !!x.patch);
    if (!patches.length) return;
    s.undo.push(patches);
    if (s.undo.length > 40) s.undo.shift();
    s.redo = [];
    if (this.mode === 'refine') sendRefine();
    else {
      s.edits = true;
      rebuildPreview();
      setCut({ hasResult: true, status: store.state.cutout.status === 'idle' ? 'ready' : store.state.cutout.status });
    }
  }
}

/** Begin an Add/Remove/Refine stroke at layer-pixel point (diameter in layer pixels). */
export function cutoutBeginStroke(x: number, y: number, diameter: number): CutoutStroke | null {
  const mode = store.state.cutout.mode;
  if (mode === 'pick') return null;
  const s = ensureSession();
  if (!s) return null;
  if (mode === 'refine' && !s.alpha) {
    store.toast('Refine edge works on an AI cutout — click the person first');
    return null;
  }
  const st = new CutoutStroke(s, mode, diameter);
  st.to(x, y);
  return st;
}

function sendRefine() {
  const s = sess;
  if (!s?.wr) return;
  const { wr } = s;
  const d = s.refine.getContext('2d', { willReadFrequently: true })!.getImageData(wr.x, wr.y, wr.w, wr.h).data;
  const data = new Uint8Array(wr.w * wr.h);
  let any = false;
  for (let i = 0; i < data.length; i++) {
    if (d[i * 4 + 3] > 20) {
      data[i] = 1;
      any = true;
    }
  }
  setCut({ status: 'working', message: 'Refining edges…', progress: null });
  request({ type: 'refine', data: any ? data : new Uint8Array(0), edges: edgesFor(s) }, any ? [data.buffer] : []).catch(() => {});
}

export function cutoutUndo(redo = false) {
  const s = sess;
  if (!s) return false;
  const from = redo ? s.redo : s.undo;
  const to = redo ? s.undo : s.redo;
  const entry = from.pop();
  if (!entry) return true;
  to.push(entry);
  let refine = false;
  for (const { canvas, patch } of redo ? entry : [...entry].reverse()) {
    applyPatch(s[canvas], patch, redo ? 'after' : 'before');
    if (canvas === 'refine') refine = true;
  }
  if (refine) sendRefine();
  rebuildPreview();
  store.toast(redo ? 'Redo brush' : 'Undo brush');
  return true;
}

/* ---------------- apply / cancel ---------------- */

function copyCanvas(c: HTMLCanvasElement) {
  const n = createCanvas(c.width, c.height);
  n.getContext('2d')!.drawImage(c, 0, 0);
  return n;
}

export async function cutoutApply(asNewLayer: boolean) {
  const s = sess;
  const doc = store.state.doc;
  const layer = doc?.layers.find((l) => l.id === s?.layerId);
  if (!s || !doc || !layer || !layer.canvas) return;
  if (!s.alpha && !s.edits) {
    store.toast('Nothing cut out yet — click the person first');
    return;
  }
  const c = store.state.cutout;
  setCut({ status: 'working', message: 'Applying…', progress: null });
  try {
    rebuildPreview();
    const mask = copyCanvas(s.preview);
    if (layer.mask && layer.maskEnabled) {
      const mc = mask.getContext('2d')!;
      mc.globalCompositeOperation = 'destination-in';
      mc.drawImage(layer.mask, 0, 0, s.w, s.h);
    }
    let pixels: HTMLCanvasElement | null = null;
    if (c.decontam && c.decontamAmount > 0 && s.wr && s.alpha) {
      const { wr } = s;
      const d = s.preview.getContext('2d', { willReadFrequently: true })!.getImageData(wr.x, wr.y, wr.w, wr.h).data;
      const alpha = new Uint8Array(wr.w * wr.h);
      for (let i = 0; i < alpha.length; i++) alpha[i] = d[i * 4 + 3];
      const msgs = await request({ type: 'decontam', alpha, amount: c.decontamAmount / 100 }, [alpha.buffer]);
      const res = msgs.find((m): m is Extract<FromWorker, { type: 'decontam' }> => m.type === 'decontam');
      if (res) {
        pixels = copyCanvas(layer.canvas);
        pixels.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(res.data), res.wr.w, res.wr.h), res.wr.x, res.wr.y);
      }
    }
    const id = layer.id;
    if (asNewLayer) {
      const copy: Layer = {
        ...layer,
        id: newId(),
        name: `${layer.name} cutout`,
        canvas: pixels ?? copyCanvas(layer.canvas),
        mask,
        maskEnabled: true,
        visible: true,
        adj: JSON.parse(JSON.stringify(layer.adj)),
        fx: JSON.parse(JSON.stringify(layer.fx)),
        version: 0,
      };
      endSession();
      store.mutate('Cutout to new layer', (d) => {
        const i = d.layers.findIndex((l) => l.id === id);
        if (i < 0) return;
        d.layers[i].visible = false;
        d.layers.splice(i + 1, 0, copy);
        return copy.id;
      });
      store.toast(`Cut out as "${copy.name}" — the original is hidden underneath`);
    } else {
      endSession();
      store.updateLayer(
        id,
        (l) => {
          l.mask = mask;
          l.maskEnabled = true;
          if (pixels) {
            l.canvas = pixels;
            l.version++;
          }
        },
        'Cutout mask',
        `cut${Date.now()}`,
      );
      if (pixels) dropCaches(id);
      store.toast('Cutout applied as this layer’s mask — paint the mask to touch it up');
    }
  } catch (e) {
    setCut({ status: 'error', message: (e as Error).message, progress: null });
  }
}

export function cutoutCancel() {
  if (!sess) return;
  endSession();
  store.toast('Cutout cancelled');
}
