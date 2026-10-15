import { useEffect, useRef, useState } from 'react';
import { store, useStore, type Tool } from './store';
import Viewport from './components/Viewport';
import LayersPanel from './components/LayersPanel';
import Properties from './components/Properties';
import NewDocDialog from './components/NewDocDialog';
import { Icon } from './components/icons';
import { Slider, Segmented } from './components/ui';
import {
  addImages,
  addMask,
  deleteLayer,
  duplicateLayer,
  exportAs,
  openImagesDialog,
  openProject,
  saveProject,
} from './actions';
import { fontString } from './engine/render';

const TOOLS: { id: Tool; label: string; key: string; icon: string }[] = [
  { id: 'move', label: 'Move & resize', key: 'V', icon: 'move' },
  { id: 'brush', label: 'Brush', key: 'B', icon: 'brush' },
  { id: 'eraser', label: 'Eraser', key: 'E', icon: 'eraser' },
  { id: 'eyedropper', label: 'Eyedropper', key: 'I', icon: 'eyedropper' },
  { id: 'hand', label: 'Hand (or hold Space)', key: 'H', icon: 'hand' },
];

function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement;
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

function Menu({ label, items }: { label: string; items: ({ label: string; hint?: string; run: () => void; disabled?: boolean } | '-')[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  return (
    <div className="menu" ref={ref}>
      <button type="button" className={`menu-btn ${open ? 'on' : ''}`} aria-expanded={open} onClick={() => setOpen(!open)}>
        {label}
      </button>
      {open && (
        <div className="menu-pop" role="menu">
          {items.map((it, i) =>
            it === '-' ? (
              <hr key={i} />
            ) : (
              <button
                type="button"
                role="menuitem"
                key={it.label}
                disabled={it.disabled}
                onClick={() => {
                  setOpen(false);
                  it.run();
                }}
              >
                <span>{it.label}</span>
                {it.hint && <kbd>{it.hint}</kbd>}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}

export default function App() {
  const doc = useStore((s) => s.doc);
  const tool = useStore((s) => s.tool);
  const brush = useStore((s) => s.brush);
  const editMask = useStore((s) => s.editMask);
  const maskPaint = useStore((s) => s.maskPaint);
  const autoSelect = useStore((s) => s.autoSelect);
  const previewHQ = useStore((s) => s.previewHQ);
  const canUndo = useStore((s) => s.canUndo);
  const canRedo = useStore((s) => s.canRedo);
  const toast = useStore((s) => s.toast);
  const dirty = useStore((s) => s.dirty);
  const selectedId = useStore((s) => s.selectedId);
  const [showNew, setShowNew] = useState(false);
  const [zoom, setZoom] = useState(1);

  const selected = doc?.layers.find((l) => l.id === selectedId);
  const paintingMask = !!selected && (editMask || selected.kind === 'adjust');

  useEffect(() => {
    const onZoom = (e: Event) => setZoom((e as CustomEvent).detail);
    window.addEventListener('sd:zoom', onZoom);
    return () => window.removeEventListener('sd:zoom', onZoom);
  }, []);

  // warn before losing work
  useEffect(() => {
    const fn = (e: BeforeUnloadEvent) => {
      if (store.state.dirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', fn);
    return () => window.removeEventListener('beforeunload', fn);
  }, []);

  // load fonts used by text layers (e.g. after opening a project)
  useEffect(() => {
    doc?.layers.forEach((l) => l.text && document.fonts?.load(fontString(l.text)).catch(() => {}));
  }, [doc]);

  // paste images
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files ?? []);
      if (files.length) {
        e.preventDefault();
        addImages(files);
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, []);

  // keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e)) return;
      const ctrl = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      const st = store.state;
      if (ctrl && k === 'z' && !e.shiftKey) {
        e.preventDefault();
        store.undo();
      } else if (ctrl && ((k === 'z' && e.shiftKey) || k === 'y')) {
        e.preventDefault();
        store.redo();
      } else if (ctrl && k === 's') {
        e.preventDefault();
        saveProject();
      } else if (ctrl && k === 'o') {
        e.preventDefault();
        openImagesDialog();
      } else if (ctrl && k === 'j') {
        e.preventDefault();
        duplicateLayer();
      } else if (ctrl && k === 'e' && e.shiftKey) {
        e.preventDefault();
        exportAs('png');
      } else if (ctrl && (k === '0')) {
        e.preventDefault();
        window.dispatchEvent(new Event('sd:fit'));
      } else if (ctrl && k === '1') {
        e.preventDefault();
        window.dispatchEvent(new Event('sd:actual'));
      } else if (ctrl && (k === '=' || k === '+')) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('sd:zoomby', { detail: 1.25 }));
      } else if (ctrl && k === '-') {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('sd:zoomby', { detail: 0.8 }));
      } else if (ctrl) {
        return;
      } else if (k === 'v') store.set({ tool: 'move' });
      else if (k === 'b') store.set({ tool: 'brush' });
      else if (k === 'e') store.set({ tool: 'eraser' });
      else if (k === 'i') store.set({ tool: 'eyedropper' });
      else if (k === 'h') store.set({ tool: 'hand' });
      else if (k === 'x') store.set({ maskPaint: st.maskPaint === 'hide' ? 'reveal' : 'hide' });
      else if (k === '\\') store.set({ showMask: !st.showMask });
      else if (k === '[') store.set({ brush: { ...st.brush, size: Math.max(1, Math.round(st.brush.size * 0.85)) } });
      else if (k === ']') store.set({ brush: { ...st.brush, size: Math.min(2000, Math.round(st.brush.size * 1.18) + 1) } });
      else if (k === 'delete' || k === 'backspace') {
        if (st.selectedId) {
          e.preventDefault();
          deleteLayer();
        }
      } else if (k.startsWith('arrow') && st.selectedId && st.tool === 'move') {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const dx = k === 'arrowleft' ? -step : k === 'arrowright' ? step : 0;
        const dy = k === 'arrowup' ? -step : k === 'arrowdown' ? step : 0;
        store.updateLayer(st.selectedId, (l) => {
          l.x += dx;
          l.y += dy;
        }, 'Nudge');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const setBrush = (patch: Partial<typeof brush>) => store.set({ brush: { ...store.state.brush, ...patch } });

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand" aria-label="Studio Desktop">
          <span className="brand-mark" aria-hidden="true" />
          Studio Desktop
        </div>
        <Menu
          label="File"
          items={[
            { label: 'New…', run: () => setShowNew(true) },
            { label: 'Add image…', hint: 'Ctrl+O', run: openImagesDialog, disabled: false },
            { label: 'Open project…', run: openProject },
            '-',
            { label: 'Save project', hint: 'Ctrl+S', run: saveProject, disabled: !doc },
            '-',
            { label: 'Export PNG (for print)', hint: 'Ctrl+Shift+E', run: () => exportAs('png'), disabled: !doc },
            { label: 'Export JPG', run: () => exportAs('jpeg'), disabled: !doc },
          ]}
        />
        <Menu
          label="Edit"
          items={[
            { label: 'Undo', hint: 'Ctrl+Z', run: () => store.undo(), disabled: !canUndo },
            { label: 'Redo', hint: 'Ctrl+Y', run: () => store.redo(), disabled: !canRedo },
            '-',
            { label: 'Duplicate layer', hint: 'Ctrl+J', run: () => duplicateLayer(), disabled: !selectedId },
            { label: 'Add mask', run: addMask, disabled: !selectedId },
            { label: 'Delete layer', hint: 'Del', run: () => deleteLayer(), disabled: !selectedId },
          ]}
        />
        <Menu
          label="View"
          items={[
            { label: 'Fit on screen', hint: 'Ctrl+0', run: () => window.dispatchEvent(new Event('sd:fit')) },
            { label: '100%', hint: 'Ctrl+1', run: () => window.dispatchEvent(new Event('sd:actual')) },
            '-',
            {
              label: previewHQ ? '✓ High-quality preview' : 'High-quality preview',
              run: () => store.set({ previewHQ: !store.state.previewHQ }),
            },
          ]}
        />
        <div className="topbar-mid">
          <button type="button" className="icon-btn" aria-label="Undo" title="Undo (Ctrl+Z)" disabled={!canUndo} onClick={() => store.undo()}>
            <Icon name="undo" />
          </button>
          <button type="button" className="icon-btn" aria-label="Redo" title="Redo (Ctrl+Y)" disabled={!canRedo} onClick={() => store.redo()}>
            <Icon name="redo" />
          </button>
        </div>
        <div className="topbar-right">
          {doc && (
            <span className="doc-info">
              {doc.name}
              {dirty ? ' •' : ''} — {doc.width}×{doc.height} · {(doc.width / doc.dpi).toFixed(1)}×{(doc.height / doc.dpi).toFixed(1)} in @ {doc.dpi} DPI · {Math.round(zoom * 100)}%
            </span>
          )}
          {doc && (
            <button type="button" className="btn primary small" onClick={() => exportAs('png')}>
              Export PNG
            </button>
          )}
        </div>
      </header>

      <div className="optionsbar">
        {tool === 'move' && (
          <>
            <label className="check">
              <input type="checkbox" checked={autoSelect} onChange={(e) => store.set({ autoSelect: e.target.checked })} />
              Auto-select layer on click
            </label>
            <span className="muted">Drag corners to resize · top dot to rotate (Shift snaps) · arrow keys nudge</span>
          </>
        )}
        {(tool === 'brush' || tool === 'eraser') && (
          <>
            <span className={`target-pill ${paintingMask ? 'mask' : ''}`}>
              {selected ? (paintingMask ? 'Painting mask' : 'Painting pixels') : 'No layer selected'}
            </span>
            {paintingMask && (
              <Segmented
                label="Mask brush"
                value={tool === 'eraser' ? (maskPaint === 'hide' ? 'reveal' : 'hide') : maskPaint}
                onChange={(v) => store.set({ maskPaint: tool === 'eraser' ? (v === 'hide' ? 'reveal' : 'hide') : v })}
                options={[
                  { value: 'hide', label: 'Hide (black)', title: 'Press X to swap' },
                  { value: 'reveal', label: 'Reveal (white)', title: 'Press X to swap' },
                ]}
              />
            )}
            <div className="opt-slider">
              <Slider label="Size" value={brush.size} min={1} max={1000} unit="px" onChange={(v) => setBrush({ size: v })} />
            </div>
            <div className="opt-slider">
              <Slider label="Hardness" value={brush.hardness} min={0} max={100} unit="%" onChange={(v) => setBrush({ hardness: v })} />
            </div>
            <div className="opt-slider">
              <Slider label="Opacity" value={brush.opacity} min={1} max={100} unit="%" onChange={(v) => setBrush({ opacity: v })} />
            </div>
            {!paintingMask && tool === 'brush' && (
              <label className="color-field inline">
                <span>Color</span>
                <input type="color" value={brush.color} onChange={(e) => setBrush({ color: e.target.value })} />
              </label>
            )}
            <span className="muted">[ ] size</span>
          </>
        )}
        {tool === 'eyedropper' && <span className="muted">Click the image to pick a color for the brush (also copied to clipboard).</span>}
        {tool === 'hand' && <span className="muted">Drag to pan · scroll to zoom · Ctrl+0 fits the page</span>}
      </div>

      <div className="workspace">
        <nav className="toolbar" aria-label="Tools">
          {TOOLS.map((t) => (
            <button
              type="button"
              key={t.id}
              className={`tool ${tool === t.id ? 'on' : ''}`}
              aria-pressed={tool === t.id}
              aria-label={`${t.label} (${t.key})`}
              title={`${t.label} (${t.key})`}
              onClick={() => store.set({ tool: t.id })}
            >
              <Icon name={t.icon} size={20} />
            </button>
          ))}
          <div className="tool-color" title="Brush color">
            <input type="color" aria-label="Brush color" value={brush.color} onChange={(e) => setBrush({ color: e.target.value })} />
          </div>
        </nav>
        <main className="stage">
          <Viewport />
        </main>
        <aside className="sidebar">
          <Properties />
          <LayersPanel />
        </aside>
      </div>

      {(!doc || showNew) && (
        <NewDocDialog canCancel={!!doc} onClose={() => setShowNew(false)} />
      )}
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}
