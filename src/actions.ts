import { store } from './store';
import {
  createCanvas,
  defaultFill,
  defaultText,
  makeLayer,
  newId,
  type Doc,
  type Layer,
} from './engine/types';
import { download, exportImage, imageLayer, loadImageFile, parseProject, pickFile, serializeProject } from './engine/io';
import { dropCaches, getSource, sourceSize, syncMaskSize } from './engine/render';

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
  if (!doc || !l || (l.kind !== 'text' && l.kind !== 'fill')) return;
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
  doc.layers.forEach((l) => l.kind === 'text' && syncMaskSize(l, doc));
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
