/**
 * Autosave: keeps a copy of the open project in the browser (IndexedDB) so a crash, a closed tab or a
 * frozen laptop doesn't lose work. Saves a little while after changes stop, and at least every couple
 * of minutes while editing. Only layers whose pixels changed are re-encoded.
 */
import { store, pixelEdits } from './store';
import { defaultAdjustments, defaultEffects, makeLayer, createCanvas, type Doc, type Layer } from './engine/types';

const DB = 'studio-desktop';
const STORE = 'autosave';
const KEY = 'current';
const QUIET_MS = 15_000;
const MAX_WAIT_MS = 120_000;

export interface AutosaveRecord {
  time: number;
  name: string;
  layerCount: number;
  doc: string;
  blobs: Record<string, Blob>;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => {
      resolve(req.result);
      db.close();
    };
    t.onerror = () => {
      reject(t.error);
      db.close();
    };
  });
}

export function readAutosave(): Promise<AutosaveRecord | undefined> {
  return tx('readonly', (s) => s.get(KEY) as IDBRequest<AutosaveRecord | undefined>).catch(() => undefined);
}

export function clearAutosave(): Promise<void> {
  return tx('readwrite', (s) => s.delete(KEY)).then(() => undefined, () => undefined);
}

/* ---------- encoding with a per-canvas cache ---------- */
const cache = new WeakMap<HTMLCanvasElement, { stamp: string; blob: Blob }>();

function encode(c: HTMLCanvasElement, version: number): Promise<Blob> {
  const stamp = `${c.width}x${c.height}|${version}|${pixelEdits.get(c) ?? 0}`;
  const hit = cache.get(c);
  if (hit && hit.stamp === stamp) return Promise.resolve(hit.blob);
  return new Promise((resolve, reject) =>
    c.toBlob((b) => {
      if (!b) return reject(new Error('encode failed'));
      cache.set(c, { stamp, blob: b });
      resolve(b);
    }, 'image/png'),
  );
}

let saving = false;
let seen: { doc: Doc | null; top: unknown; undo: number; redo: number } = { doc: null, top: null, undo: 0, redo: 0 };
const sig = () => ({ doc: store.state.doc, ...store.historyMark() });

async function saveNow() {
  const doc = store.state.doc;
  if (!doc || saving) return;
  saving = true;
  try {
    const blobs: Record<string, Blob> = {};
    const layers = [];
    for (const l of doc.layers) {
      const ck = l.canvas ? `${l.id}:c` : null;
      const mk = l.mask ? `${l.id}:m` : null;
      if (l.canvas && ck) blobs[ck] = await encode(l.canvas, l.version);
      if (l.mask && mk) blobs[mk] = await encode(l.mask, 0);
      layers.push({ ...l, canvas: ck, mask: mk });
    }
    // a newer document was opened while encoding — that one will save itself
    if (store.state.doc?.width !== doc.width || store.state.doc?.height !== doc.height) return;
    const rec: AutosaveRecord = { time: Date.now(), name: doc.name, layerCount: doc.layers.length, doc: JSON.stringify({ ...doc, layers }), blobs };
    await tx('readwrite', (s) => s.put(rec, KEY));
    lastSaved = Date.now();
  } catch (e) {
    console.warn('[autosave] failed', e);
  } finally {
    saving = false;
  }
}

let quietTimer = 0;
let firstChange = 0;
let lastSaved = 0;
let enabled = false;

/** Start watching the store. Call after any recovery prompt is resolved, so an old save isn't overwritten. */
export function startAutosave() {
  if (enabled) return;
  enabled = true;
  seen = sig();
  store.subscribe(() => {
    const now_ = sig();
    if (!now_.doc || (now_.doc === seen.doc && now_.top === seen.top && now_.undo === seen.undo && now_.redo === seen.redo)) return;
    seen = now_;
    const now = Date.now();
    if (!firstChange) firstChange = now;
    window.clearTimeout(quietTimer);
    const wait = Math.max(0, Math.min(QUIET_MS, firstChange + MAX_WAIT_MS - now));
    quietTimer = window.setTimeout(() => {
      firstChange = 0;
      void saveNow();
    }, wait);
  });
  // leaving the page or hiding the tab: save right away
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && firstChange) {
      firstChange = 0;
      window.clearTimeout(quietTimer);
      void saveNow();
    }
  });
}

export function lastAutosaveTime() {
  return lastSaved;
}

async function blobToCanvas(b: Blob): Promise<HTMLCanvasElement> {
  const bmp = await createImageBitmap(b);
  const c = createCanvas(bmp.width, bmp.height);
  c.getContext('2d')!.drawImage(bmp, 0, 0);
  bmp.close();
  return c;
}

export async function restoreAutosave(rec: AutosaveRecord): Promise<Doc> {
  const d = JSON.parse(rec.doc);
  const layers: Layer[] = [];
  for (const l of d.layers) {
    layers.push({
      ...makeLayer(l.kind, l.name),
      ...l,
      adj: { ...defaultAdjustments(), ...l.adj },
      fx: { ...defaultEffects(), ...l.fx },
      canvas: l.canvas && rec.blobs[l.canvas] ? await blobToCanvas(rec.blobs[l.canvas]) : null,
      mask: l.mask && rec.blobs[l.mask] ? await blobToCanvas(rec.blobs[l.mask]) : null,
      version: 0,
    });
  }
  return { ...d, layers };
}
