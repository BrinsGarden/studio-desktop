import { store } from './store';
import {
  SWIRL_PRESETS,
  createCanvas,
  defaultFill,
  defaultText,
  makeLayer,
  newId,
  type Doc,
  type Layer,
} from './engine/types';
import { download, exportImage, imageLayer, loadImageFile, parseProject, pickFile, serializeProject } from './engine/io';
import { dropCaches, getSource, layerMatrix, sourceSize, syncMaskSize } from './engine/render';
import { invertSelection, selectAll as selAll, selectionLocalBounds, selectionMaskForLayer, type Pt } from './engine/selection';
import { centerPath } from './engine/swirl';

export function newDocument(width: number, height: number, dpi: number, name: string, background: string) {
  const doc: Doc = { width, height, dpi, name, background, layers: [] };
  store.load(doc, null);
}

function baseName(file: File) {
  return file.name.replace(/\.[^.]+$/, '') || 'Image';
}

export async function addImages(files: File[]) {
  const images = files.filter((f) => f.type.startsWith('image/'));
  if (!images.length) return;
  try {
    for (const file of images) {
      const canvas = await loadImageFile(file);
      if (!store.state.doc) {
        newDocument(canvas.width, canvas.height, 300, baseName(file), '');
      }
      const doc = store.state.doc!;
      const layer = imageLayer(doc, canvas, baseName(file));
      store.mutate('Add image', (d) => {
        d.layers.push(layer);
        return layer.id;
      });
    }
  } catch (e) {
    store.toast((e as Error).message);
  }
}

export async function openImagesDialog() {
  const files = await pickFile('image/*', true);
  await addImages(files);
}

function insertAboveSelected(d: Doc, layer: Layer) {
  const idx = d.layers.findIndex((l) => l.id === store.state.selectedId);
  if (idx < 0) d.layers.push(layer);
  else d.layers.splice(idx + 1, 0, layer);
}

export function addText() {
  const doc = store.state.doc;
  if (!doc) return;
  const t = defaultText();
  t.size = Math.round(doc.width / 8);
  const layer = makeLayer('text', 'Text', { text: t, x: doc.width / 2, y: doc.height * 0.15 });
  store.mutate('Add text', (d) => {
    insertAboveSelected(d, layer);
    return layer.id;
  });
}

export function addFill() {
  const doc = store.state.doc;
  if (!doc) return;
  const layer = makeLayer('fill', 'Gradient', { fill: defaultFill(), x: doc.width / 2, y: doc.height / 2 });
  store.mutate('Add fill', (d) => {
    insertAboveSelected(d, layer);
    return layer.id;
  });
}

export function addFog() {
  const doc = store.state.doc;
  if (!doc) return;
  const layer = makeLayer('fill', 'Fog', {
    blend: 'screen',
    fill: {
      type: 'fog',
      color1: '#c9bedf',
      alpha1: 0.75,
      color2: '#000000',
      alpha2: 0,
      angle: 90,
      fogHeight: 0.3,
      wisp: 0.7,
      seed: Math.floor(Math.random() * 1e9),
    },
    x: doc.width / 2,
    y: doc.height / 2,
  });
  store.mutate('Add fog', (d) => {
    insertAboveSelected(d, layer);
    return layer.id;
  });
  store.toast('Fog added above the selected layer — drag it in the Layers list to set what it covers');
}

export function addAdjustLayer() {
  const doc = store.state.doc;
  if (!doc) return;
  const layer = makeLayer('adjust', 'Color Adjust', { x: doc.width / 2, y: doc.height / 2 });
  store.mutate('Add adjustment', (d) => {
    insertAboveSelected(d, layer);
    return layer.id;
  });
}

export function addMask() {
  const sel = store.selected();
  const doc = store.state.doc;
  if (!sel || !doc) return;
  if (sel.mask) {
    store.set({ editMask: true });
    return;
  }
  const { w, h } = sourceSize(sel, doc);
  const mask = createCanvas(w, h);
  const ctx = mask.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  store.updateLayer(sel.id, (l) => {
    l.mask = mask;
    l.maskEnabled = true;
  }, 'Add mask');
  store.set({ editMask: true, tool: 'brush', maskPaint: 'hide' });
  store.toast('Mask added — paint to hide, press X to switch to reveal');
}

export function deleteMask() {
  const sel = store.selected();
  if (!sel?.mask) return;
  store.updateLayer(sel.id, (l) => {
    l.mask = null;
  }, 'Delete mask');
  store.set({ editMask: false, showMask: false });
}

export function invertMask() {
  const sel = store.selected();
  if (!sel?.mask) return;
  const old = sel.mask;
  const inv = createCanvas(old.width, old.height);
  const ctx = inv.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, inv.width, inv.height);
  ctx.globalCompositeOperation = 'destination-out';
  ctx.drawImage(old, 0, 0);
  store.updateLayer(sel.id, (l) => {
    l.mask = inv;
  }, 'Invert mask');
}

export function deleteLayer(id = store.state.selectedId) {
  if (!id) return;
  store.mutate('Delete layer', (d) => {
    const i = d.layers.findIndex((l) => l.id === id);
    if (i < 0) return;
    d.layers.splice(i, 1);
    d.layers.forEach((l) => {
      if (l.adj.match.layerId === id) l.adj.match.layerId = null;
    });
    return d.layers[Math.min(i, d.layers.length - 1)]?.id ?? null;
  });
}

export function duplicateLayer(id = store.state.selectedId) {
  const doc = store.state.doc;
  const src = doc?.layers.find((l) => l.id === id);
  if (!doc || !src) return;
  const copyCanvas = (c: HTMLCanvasElement | null) => {
    if (!c) return null;
    const n = createCanvas(c.width, c.height);
    n.getContext('2d')!.drawImage(c, 0, 0);
    return n;
  };
  const copy: Layer = {
    ...src,
    id: newId(),
    name: `${src.name} copy`,
    canvas: copyCanvas(src.canvas),
    mask: copyCanvas(src.mask),
    adj: JSON.parse(JSON.stringify(src.adj)),
    fx: JSON.parse(JSON.stringify(src.fx)),
    text: src.text ? { ...src.text } : undefined,
    fill: src.fill ? { ...src.fill } : undefined,
    swirl: src.swirl ? JSON.parse(JSON.stringify(src.swirl)) : undefined,
    version: 0,
  };
  store.mutate('Duplicate layer', (d) => {
    const i = d.layers.findIndex((l) => l.id === id);
    d.layers.splice(i + 1, 0, copy);
    return copy.id;
  });
}

export function moveLayer(id: string, toIndex: number) {
  store.mutate('Reorder layers', (d) => {
    const i = d.layers.findIndex((l) => l.id === id);
    if (i < 0) return;
    const [l] = d.layers.splice(i, 1);
    d.layers.splice(Math.max(0, Math.min(d.layers.length, toIndex)), 0, l);
  });
}

export function nudgeLayer(dir: 1 | -1) {
  const doc = store.state.doc;
  const id = store.state.selectedId;
  if (!doc || !id) return;
  const i = doc.layers.findIndex((l) => l.id === id);
  moveLayer(id, i + dir);
}

/** Bake a text or fill layer into an image layer so it can be painted on. */
export function rasterize(id = store.state.selectedId) {
  const doc = store.state.doc;
  const l = doc?.layers.find((x) => x.id === id);
  if (!doc || !l || (l.kind !== 'text' && l.kind !== 'fill' && l.kind !== 'swirl')) return;
  const src = getSource(l, doc);
  if (!src) return;
  const c = createCanvas(src.width, src.height);
  c.getContext('2d')!.drawImage(src, 0, 0);
  dropCaches(l.id);
  store.updateLayer(l.id, (x) => {
    x.kind = 'image';
    x.canvas = c;
    x.text = undefined;
    x.fill = undefined;
    x.swirl = undefined;
    x.version++;
  }, 'Rasterize');
}

export function fitLayerToCanvas(mode: 'fit' | 'fill') {
  const doc = store.state.doc;
  const l = store.selected();
  if (!doc || !l || l.kind === 'adjust') return;
  const { w, h } = sourceSize(l, doc);
  const s = mode === 'fit' ? Math.min(doc.width / w, doc.height / h) : Math.max(doc.width / w, doc.height / h);
  store.updateLayer(l.id, (x) => {
    x.scale = s;
    x.rotation = 0;
    x.x = doc.width / 2;
    x.y = doc.height / 2;
  }, mode === 'fit' ? 'Fit to canvas' : 'Fill canvas');
}

export function ensureMasksSynced() {
  const doc = store.state.doc;
  if (!doc) return;
  doc.layers.forEach((l) => (l.kind === 'text' || l.kind === 'swirl') && syncMaskSize(l, doc));
}

/* ---------------- files ---------------- */
export async function saveProject() {
  const doc = store.state.doc;
  if (!doc) return;
  store.toast('Saving project…');
  const blob = await serializeProject(doc);
  download(blob, `${doc.name || 'poster'}.sdproj`);
  store.set({ dirty: false });
}

export async function openProject() {
  const [file] = await pickFile('.sdproj,application/json');
  if (!file) return;
  try {
    const doc = await parseProject(await file.text());
    store.load(doc);
    store.toast(`Opened ${doc.name}`);
  } catch (e) {
    store.toast((e as Error).message);
  }
}

export async function exportAs(format: 'png' | 'jpeg') {
  const doc = store.state.doc;
  if (!doc) return;
  store.toast(`Exporting ${doc.width}×${doc.height} ${format.toUpperCase()}…`);
  await new Promise((r) => setTimeout(r, 50));
  try {
    const blob = await exportImage(doc, format);
    download(blob, `${doc.name || 'poster'}.${format === 'png' ? 'png' : 'jpg'}`);
    store.toast(`Exported at ${doc.dpi} DPI`);
  } catch (e) {
    store.toast((e as Error).message);
  }
}

/* ---------------- selection ---------------- */
function copyCanvas(c: HTMLCanvasElement): HTMLCanvasElement {
  const n = createCanvas(c.width, c.height);
  n.getContext('2d')!.drawImage(c, 0, 0);
  return n;
}

export function deselect() {
  if (store.state.selection) store.set({ selection: null });
}

export function selectAll() {
  const doc = store.state.doc;
  if (doc) store.set({ selection: selAll(doc), tool: store.state.tool === 'move' ? 'select' : store.state.tool });
}

export function invertSel() {
  const doc = store.state.doc;
  if (doc) store.set({ selection: invertSelection(store.state.selection, doc) });
}

function needSelection(): { doc: Doc; layer: Layer } | null {
  const { doc, selection } = store.state;
  const layer = store.selected();
  if (!doc || !selection) {
    store.toast('Make a selection first (Select tool, L)');
    return null;
  }
  if (!layer) {
    store.toast('Pick the layer to work on in the Layers panel');
    return null;
  }
  return { doc, layer };
}

/** Copy (or cut) the selected part of the current layer into a new layer above it. */
export function selectionToLayer(cut: boolean) {
  const ctx = needSelection();
  if (!ctx) return;
  const { doc, layer } = ctx;
  const sel = store.state.selection!;
  const feather = store.state.feather;
  if (layer.kind === 'adjust') {
    store.toast('Adjustment layers have no pixels to copy — pick an image layer');
    return;
  }
  if (cut && layer.kind !== 'image') {
    store.toast('Cut works on image layers — use Copy, or Rasterize this layer first');
    return;
  }
  const src = getSource(layer, doc);
  if (!src) return;
  const box = selectionLocalBounds(sel, layer, doc, feather);
  if (!box) {
    store.toast('The selection does not overlap this layer');
    return;
  }
  const selMask = selectionMaskForLayer(sel, layer, doc, feather);
  const piece = createCanvas(box.w, box.h);
  const pc = piece.getContext('2d')!;
  pc.drawImage(src, -box.x, -box.y);
  pc.globalCompositeOperation = 'destination-in';
  pc.drawImage(selMask, -box.x, -box.y);
  if (layer.mask && layer.maskEnabled) pc.drawImage(layer.mask, -box.x, -box.y);
  pc.globalCompositeOperation = 'source-over';

  const { w, h } = sourceSize(layer, doc);
  const center = layerMatrix(layer, w, h).transformPoint(new DOMPoint(box.x + box.w / 2, box.y + box.h / 2));
  const piecLayer: Layer = {
    ...makeLayer('image', `${layer.name} ${cut ? 'cut' : 'copy'}`),
    canvas: piece,
    x: center.x,
    y: center.y,
    scale: layer.scale,
    rotation: layer.rotation,
    flipX: layer.flipX,
    flipY: layer.flipY,
    blend: layer.blend,
    opacity: layer.opacity,
    adj: JSON.parse(JSON.stringify(layer.adj)),
    fx: JSON.parse(JSON.stringify(layer.fx)),
  };

  let remaining: HTMLCanvasElement | null = null;
  if (cut && layer.canvas) {
    remaining = copyCanvas(layer.canvas);
    const rc = remaining.getContext('2d')!;
    rc.globalCompositeOperation = 'destination-out';
    rc.drawImage(selMask, 0, 0);
  }
  store.mutate(cut ? 'Cut to new layer' : 'Copy to new layer', (d) => {
    const i = d.layers.findIndex((l) => l.id === layer.id);
    if (remaining) {
      d.layers[i].canvas = remaining;
      d.layers[i].version++;
    }
    d.layers.splice(i + 1, 0, piecLayer);
    return piecLayer.id;
  });
  if (remaining) dropCaches(layer.id);
  store.set({ selection: null, tool: 'move', editMask: false });
  store.toast(`${cut ? 'Cut' : 'Copied'} to new layer "${piecLayer.name}" — drag it where you want it`);
}

/** Erase the selected pixels from the current image layer. */
export function deleteSelectedPixels() {
  const ctx = needSelection();
  if (!ctx) return;
  const { doc, layer } = ctx;
  if (layer.kind !== 'image' || !layer.canvas) {
    store.toast('Delete works on image layers — use "Mask: hide selection" for other layers');
    return;
  }
  const selMask = selectionMaskForLayer(store.state.selection!, layer, doc, store.state.feather);
  const next = copyCanvas(layer.canvas);
  const nc = next.getContext('2d')!;
  nc.globalCompositeOperation = 'destination-out';
  nc.drawImage(selMask, 0, 0);
  dropCaches(layer.id);
  store.updateLayer(layer.id, (l) => {
    l.canvas = next;
    l.version++;
  }, 'Delete pixels', `del${Date.now()}`);
}

/** Make (or update) the current layer's mask from the selection. */
export function maskFromSelection(mode: 'reveal' | 'hide') {
  const ctx = needSelection();
  if (!ctx) return;
  const { doc, layer } = ctx;
  const { w, h } = sourceSize(layer, doc);
  const selMask = selectionMaskForLayer(store.state.selection!, layer, doc, store.state.feather);
  const mask = createCanvas(w, h);
  const mc = mask.getContext('2d')!;
  if (layer.mask) mc.drawImage(layer.mask, 0, 0, w, h);
  else {
    mc.fillStyle = '#fff';
    mc.fillRect(0, 0, w, h);
  }
  mc.globalCompositeOperation = mode === 'reveal' ? 'destination-in' : 'destination-out';
  mc.drawImage(selMask, 0, 0);
  store.updateLayer(layer.id, (l) => {
    l.mask = mask;
    l.maskEnabled = true;
  }, mode === 'reveal' ? 'Mask to selection' : 'Hide selection', `mask${Date.now()}`);
  store.set({ selection: null });
  store.toast(mode === 'reveal' ? 'Only the selected area shows now (mask added)' : 'Selected area hidden (mask added) — paint white to bring parts back');
}

/* ---------------- swirls ---------------- */
export function swirlPalette(presetId: string): string[] {
  return [...(SWIRL_PRESETS.find((p) => p.id === presetId) ?? SWIRL_PRESETS[0]).palette];
}

/** Create a swirl layer from a path drawn in document coordinates (or redraw an existing one). */
export function createSwirl(pts: Pt[]) {
  const doc = store.state.doc;
  if (!doc || pts.length < 2) return;
  const redrawId = store.state.swirlRedrawId;
  const target = redrawId ? doc.layers.find((l) => l.id === redrawId && l.kind === 'swirl') : null;
  if (target && target.swirl) {
    // express the new path in the existing layer's local space so its transform still applies
    const { w, h } = sourceSize(target, doc);
    const m = layerMatrix(target, w, h);
    const inv = m.inverse();
    const local = pts.map((p) => {
      const q = inv.transformPoint(new DOMPoint(p.x, p.y));
      return { x: q.x - w / 2, y: q.y - h / 2 };
    });
    const { center, points } = centerPath(local);
    const c = m.transformPoint(new DOMPoint(center.x + w / 2, center.y + h / 2));
    store.updateLayer(target.id, (l) => {
      l.swirl = { ...l.swirl!, points };
      l.x = c.x;
      l.y = c.y;
    }, 'Redraw swirl', `swirl${Date.now()}`);
    store.set({ swirlRedrawId: null });
    return;
  }
  const d = store.state.swirl;
  const { center, points } = centerPath(pts);
  const layer = makeLayer('swirl', 'Magic swirl', {
    x: center.x,
    y: center.y,
    blend: 'source-over',
    swirl: {
      points,
      palette: swirlPalette(d.preset),
      width: d.width,
      strands: d.strands,
      wraps: d.style === 'trail' ? 3 : Math.max(2, Math.round(Math.hypot(...pts.reduce((acc, p, i) => (i ? [acc[0] + Math.abs(p.x - pts[i - 1].x), acc[1] + Math.abs(p.y - pts[i - 1].y)] : acc), [0, 0])) / (Math.max(10, d.amplitude) * 5))),
      amplitude: d.amplitude,
      glow: Math.round(d.width * (d.style === 'trail' ? 2.5 : 1.6)),
      sparkles: d.style === 'trail' ? 10 : 30,
      depth: 0.6,
      taper: d.style === 'trail' ? 0.3 : 0.15,
      style: d.style,
      seed: Math.floor(Math.random() * 1e9),
    },
  });
  store.mutate('Add swirl', (dd) => {
    insertAboveSelected(dd, layer);
    return layer.id;
  });
}
