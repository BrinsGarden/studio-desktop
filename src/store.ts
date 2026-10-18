import { useSyncExternalStore } from 'react';
import type { Doc, Layer } from './engine/types';
import { applyPatch, type PixelPatch } from './engine/brush';
import type { SelectMode, Selection } from './engine/selection';

export type Tool = 'move' | 'select' | 'brush' | 'eraser' | 'swirl' | 'fire' | 'eyedropper' | 'hand';

export interface FireDefaults {
  preset: string;
  height: number;
  width: number;
  wild: number;
}

export interface SwirlDefaults {
  preset: string;
  width: number;
  amplitude: number;
  strands: number;
  style: 'helix' | 'trail';
}

export interface BrushSettings {
  size: number;
  hardness: number;
  opacity: number;
  color: string;
}

export interface AppState {
  doc: Doc | null;
  selectedId: string | null;
  /** When true, brush/eraser paint the selected layer's mask instead of its pixels. */
  editMask: boolean;
  tool: Tool;
  brush: BrushSettings;
  /** Brush on a mask hides (black) or reveals (white). Eraser always does the opposite. */
  maskPaint: 'hide' | 'reveal';
  autoSelect: boolean;
  /** Active selection in document coordinates. */
  selection: Selection | null;
  selectMode: SelectMode;
  feather: number;
  swirl: SwirlDefaults;
  fire: FireDefaults;
  /** When set, the next swirl drawn replaces this swirl layer's path. */
  swirlRedrawId: string | null;
  previewHQ: boolean;
  showMask: boolean;
  rev: number;
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  toast: string | null;
}

type Entry =
  | { type: 'doc'; label: string; key?: string; time: number; before: Snapshot; after: Snapshot }
  | { type: 'pixels'; label: string; layerId: string; target: 'canvas' | 'mask'; patch: PixelPatch };

interface Snapshot {
  doc: Doc;
  selectedId: string | null;
}

function cloneLayer(l: Layer): Layer {
  return {
    ...l,
    adj: JSON.parse(JSON.stringify(l.adj)),
    fx: JSON.parse(JSON.stringify(l.fx)),
    text: l.text ? { ...l.text } : undefined,
    fill: l.fill ? { ...l.fill } : undefined,
    swirl: l.swirl ? JSON.parse(JSON.stringify(l.swirl)) : undefined,
  };
}

function cloneDoc(d: Doc): Doc {
  return { ...d, layers: d.layers.map(cloneLayer) };
}

const MAX_HISTORY = 80;

class Store {
  state: AppState = {
    doc: null,
    selectedId: null,
    editMask: false,
    tool: 'move',
    brush: { size: 60, hardness: 50, opacity: 100, color: '#ffffff' },
    maskPaint: 'hide',
    autoSelect: true,
    selection: null,
    selectMode: 'lasso',
    feather: 0,
    swirl: { preset: 'witchy', width: 14, amplitude: 40, strands: 4, style: 'trail' },
    swirlRedrawId: null,
    fire: { preset: 'hell', height: 420, width: 70, wild: 45 },
    previewHQ: false,
    showMask: false,
    rev: 0,
    dirty: false,
    canUndo: false,
    canRedo: false,
    toast: null,
  };
  private listeners = new Set<() => void>();
  private undoStack: Entry[] = [];
  private redoStack: Entry[] = [];
  private toastTimer: number | undefined;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  get = () => this.state;

  set(partial: Partial<AppState>) {
    this.state = { ...this.state, ...partial };
    this.listeners.forEach((f) => f());
  }

  /** Ask the viewport to re-render without changing history (e.g. during a brush stroke). */
  bump() {
    this.set({ rev: this.state.rev + 1 });
  }

  toast(msg: string) {
    window.clearTimeout(this.toastTimer);
    this.set({ toast: msg });
    this.toastTimer = window.setTimeout(() => this.set({ toast: null }), 2600);
  }

  selected(): Layer | null {
    const { doc, selectedId } = this.state;
    return doc?.layers.find((l) => l.id === selectedId) ?? null;
  }

  private syncFlags(extra: Partial<AppState> = {}) {
    this.set({
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
      rev: this.state.rev + 1,
      ...extra,
    });
  }

  /** Load a document, clearing history. */
  load(doc: Doc, selectedId: string | null = null) {
    this.undoStack = [];
    this.redoStack = [];
    this.syncFlags({ doc, selectedId: selectedId ?? doc.layers[doc.layers.length - 1]?.id ?? null, dirty: false, editMask: false, selection: null });
  }

  /**
   * Change the document with undo support. `fn` receives a fresh copy it may mutate.
   * Changes with the same `key` within 1.5s merge into one undo step (slider drags).
   */
  mutate(label: string, fn: (doc: Doc) => void | string | null, key?: string) {
    const cur = this.state.doc;
    if (!cur) return;
    const next = cloneDoc(cur);
    const ret = fn(next);
    const selectedId = typeof ret === 'string' || ret === null ? ret : this.state.selectedId;
    const now = Date.now();
    const last = this.undoStack[this.undoStack.length - 1];
    const after: Snapshot = { doc: next, selectedId };
    if (key && last && last.type === 'doc' && last.key === key && now - last.time < 1500) {
      last.after = after;
      last.time = now;
    } else {
      this.undoStack.push({ type: 'doc', label, key, time: now, before: { doc: cur, selectedId: this.state.selectedId }, after });
      if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    }
    this.redoStack = [];
    this.syncFlags({ doc: next, selectedId, dirty: true });
  }

  updateLayer(id: string, fn: (l: Layer) => void, label = 'Edit layer', key?: string) {
    this.mutate(
      label,
      (d) => {
        const l = d.layers.find((x) => x.id === id);
        if (l) fn(l);
      },
      key ?? `${label}:${id}`,
    );
  }

  pushPixels(layerId: string, target: 'canvas' | 'mask', patch: PixelPatch, label: string) {
    this.undoStack.push({ type: 'pixels', label, layerId, target, patch });
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    this.redoStack = [];
    // bump version so caches refresh
    const doc = this.state.doc;
    if (doc && target === 'canvas') {
      const l = doc.layers.find((x) => x.id === layerId);
      if (l) l.version++;
    }
    this.syncFlags({ dirty: true });
  }

  private applyEntry(e: Entry, dir: 'undo' | 'redo') {
    if (e.type === 'doc') {
      const snap = dir === 'undo' ? e.before : e.after;
      this.syncFlags({ doc: snap.doc, selectedId: snap.selectedId, dirty: true });
    } else {
      const l = this.state.doc?.layers.find((x) => x.id === e.layerId);
      const t = l ? (e.target === 'mask' ? l.mask : l.canvas) : null;
      if (l && t) {
        applyPatch(t, e.patch, dir === 'undo' ? 'before' : 'after');
        l.version++;
      }
      this.syncFlags({ dirty: true });
    }
  }

  undo() {
    const e = this.undoStack.pop();
    if (!e) return;
    this.redoStack.push(e);
    this.applyEntry(e, 'undo');
    this.toast(`Undo ${e.label}`);
  }

  redo() {
    const e = this.redoStack.pop();
    if (!e) return;
    this.undoStack.push(e);
    this.applyEntry(e, 'redo');
    this.toast(`Redo ${e.label}`);
  }
}

export const store = new Store();

export function useStore<T>(sel: (s: AppState) => T): T {
  return useSyncExternalStore(store.subscribe, () => sel(store.state));
}
