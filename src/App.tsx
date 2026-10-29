import { useEffect, useRef, useState } from 'react';
import { store, useStore, type Tool } from './store';
import Viewport from './components/Viewport';
import LayersPanel from './components/LayersPanel';
import Properties from './components/Properties';
import NewDocDialog from './components/NewDocDialog';
import CutoutPanel from './components/CutoutPanel';
import { cutoutSessionLayerId, cutoutToolActivated, cutoutUndo } from './cutout';
import { Icon } from './components/icons';
import { Slider, Segmented } from './components/ui';
import {
  addImages,
  addMask,
  deleteLayer,
  deleteSelectedPixels,
  deselect,
  invertSel,
  maskFromSelection,
  selectAll,
  selectionToLayer,
  duplicateLayer,
  nudgeLayer,
  exportAs,
  openImagesDialog,
  openProject,
  saveProject,
  toggleClip,
  alignLayer,
  setTransformMode,
  resetMesh,
} from './actions';
import { fontString } from './engine/render';
import { SWIRL_PRESETS, FIRE_PRESETS } from './engine/types';

const TOOLS: { id: Tool; label: string; key: string; icon: string }[] = [
  { id: 'move', label: 'Move & resize', key: 'V', icon: 'move' },
  { id: 'select', label: 'Select (lasso, shapes)', key: 'L', icon: 'select' },
  { id: 'cutout', label: 'AI Cutout — click a person', key: 'W', icon: 'wand' },
  { id: 'brush', label: 'Brush', key: 'B', icon: 'brush' },
  { id: 'eraser', label: 'Eraser', key: 'E', icon: 'eraser' },
  { id: 'dodge', label: 'Dodge & Burn — paint light and shadow', key: 'O', icon: 'dodge' },
  { id: 'clone', label: 'Clone stamp — Alt+click a source, then paint', key: 'C', icon: 'clone' },
  { id: 'heal', label: 'Healing brush — like clone, but blends in', key: 'J', icon: 'heal' },
  { id: 'remove', label: 'Remove — paint over something to make it disappear', key: 'R', icon: 'remove' },
  { id: 'swirl', label: 'Magic swirl', key: 'S', icon: 'swirl' },
  { id: 'fire', label: 'Hellfire', key: 'F', icon: 'fire' },
  { id: 'eyedropper', label: 'Eyedropper', key: 'I', icon: 'eyedropper' },
  { id: 'hand', label: 'Hand (or hold Space)', key: 'H', icon: 'hand' },
];

function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement;
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

function setTool(t: Tool) {
  const was = store.state.tool;
  store.set({ tool: t });
  if (t === 'cutout' && was !== 'cutout') cutoutToolActivated();
  if (was === 'cutout' && t !== 'cutout' && cutoutSessionLayerId() && store.state.cutout.hasResult) {
    store.toast('Cutout not applied yet — switch back to the Cutout tool (W) to finish it');
  }
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
  const selection = useStore((s) => s.selection);
  const selectMode = useStore((s) => s.selectMode);
  const feather = useStore((s) => s.feather);
  const swirl = useStore((s) => s.swirl);
  const swirlRedrawId = useStore((s) => s.swirlRedrawId);
  const fire = useStore((s) => s.fire);
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
      const inCutout = st.tool === 'cutout' && !!cutoutSessionLayerId();
      if (ctrl && k === 'z' && !e.shiftKey) {
        e.preventDefault();
        if (!(inCutout && cutoutUndo(false))) store.undo();
      } else if (ctrl && ((k === 'z' && e.shiftKey) || k === 'y')) {
        e.preventDefault();
        if (!(inCutout && cutoutUndo(true))) store.redo();
      } else if (ctrl && k === 's') {
        e.preventDefault();
        saveProject();
      } else if (ctrl && k === 'o') {
        e.preventDefault();
        openImagesDialog();
      } else if (ctrl && k === 'j') {
        e.preventDefault();
        if (st.selection) selectionToLayer(e.shiftKey);
        else duplicateLayer();
      } else if (ctrl && k === 'd') {
        e.preventDefault();
        deselect();
      } else if (ctrl && k === 'a') {
        e.preventDefault();
        selectAll();
      } else if (ctrl && e.altKey && k === 'g') {
        e.preventDefault();
        toggleClip();
      } else if (ctrl && k === 'i' && e.shiftKey) {
        e.preventDefault();
        invertSel();
      } else if (ctrl && k === 'e' && e.shiftKey) {
        e.preventDefault();
        exportAs('png');
      } else if (ctrl && (k === ']' || k === '[')) {
        e.preventDefault();
        nudgeLayer(k === ']' ? 1 : -1);
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
      } else if (e.altKey) {
        return;
      } else if (k === 'v') store.set({ tool: 'move' });
      else if (k === 'l' || k === 'm') store.set({ tool: 'select' });
      else if (k === 'w') setTool('cutout');
      else if (k === 'o') setTool('dodge');
      else if (k === 'c') setTool('clone');
      else if (k === 'j') setTool('heal');
      else if (k === 'r') setTool('remove');
      else if (k === 's') store.set({ tool: 'swirl' });
      else if (k === 'f') store.set({ tool: 'fire' });
      else if (k === 'b') store.set({ tool: 'brush' });
      else if (k === 'e') store.set({ tool: 'eraser' });
      else if (k === 'i') store.set({ tool: 'eyedropper' });
      else if (k === 'h') store.set({ tool: 'hand' });
      else if (k === 'x') store.set({ maskPaint: st.maskPaint === 'hide' ? 'reveal' : 'hide' });
      else if (k === '\\') store.set({ showMask: !st.showMask });
      else if (k === '[' && st.tool === 'cutout') store.set({ cutout: { ...st.cutout, brush: Math.max(2, Math.round(st.cutout.brush * 0.85)) } });
      else if (k === ']' && st.tool === 'cutout') store.set({ cutout: { ...st.cutout, brush: Math.min(1000, Math.round(st.cutout.brush * 1.18) + 1) } });
      else if (k === '[') store.set({ brush: { ...st.brush, size: Math.max(1, Math.round(st.brush.size * 0.85)) } });
      else if (k === ']') store.set({ brush: { ...st.brush, size: Math.min(2000, Math.round(st.brush.size * 1.18) + 1) } });
      else if (k === 'delete' || k === 'backspace') {
        if (st.selection) {
          e.preventDefault();
          deleteSelectedPixels();
        } else if (st.selectedId) {
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
  const cut = useStore((s) => s.cutout);
  const retouch = useStore((s) => s.retouch);
  const snap = useStore((s) => s.snap);
  const transformMode = useStore((s) => s.transformMode);
  const setRetouch = (patch: Partial<typeof retouch>) => store.set({ retouch: { ...store.state.retouch, ...patch } });
  const setCut = (patch: Partial<typeof cut>) => store.set({ cutout: { ...store.state.cutout, ...patch } });

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
            { label: 'Bring layer forward', hint: 'Ctrl+]', run: () => nudgeLayer(1), disabled: !selectedId },
            { label: 'Send layer backward', hint: 'Ctrl+[', run: () => nudgeLayer(-1), disabled: !selectedId },
            { label: 'Duplicate layer', hint: 'Ctrl+J', run: () => duplicateLayer(), disabled: !selectedId },
            { label: 'Add mask', run: addMask, disabled: !selectedId },
            { label: 'Clip to layer below', hint: 'Ctrl+Alt+G', run: () => toggleClip(), disabled: !selectedId },
            { label: 'Perspective (distort corners)', run: () => setTransformMode('distort'), disabled: !selectedId },
            { label: 'Warp', run: () => setTransformMode('warp'), disabled: !selectedId },
            { label: 'Delete layer', hint: 'Del', run: () => deleteLayer(), disabled: !selectedId },
          ]}
        />
        <Menu
          label="Select"
          items={[
            { label: 'Select all', hint: 'Ctrl+A', run: selectAll, disabled: !doc },
            { label: 'Deselect', hint: 'Ctrl+D', run: deselect, disabled: !selection },
            { label: 'Invert selection', hint: 'Ctrl+Shift+I', run: invertSel, disabled: !doc },
            '-',
            { label: 'Copy to new layer', hint: 'Ctrl+J', run: () => selectionToLayer(false), disabled: !selection },
            { label: 'Cut to new layer', hint: 'Ctrl+Shift+J', run: () => selectionToLayer(true), disabled: !selection },
            { label: 'Delete selected pixels', hint: 'Del', run: deleteSelectedPixels, disabled: !selection },
            '-',
            { label: 'Mask: show only selection', run: () => maskFromSelection('reveal'), disabled: !selection },
            { label: 'Mask: hide selection', run: () => maskFromSelection('hide'), disabled: !selection },
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
            <Segmented
              label="Transform mode"
              value={transformMode}
              onChange={(v) => setTransformMode(v)}
              options={[
                { value: 'free', label: 'Move & scale' },
                { value: 'distort', label: 'Perspective', title: 'Drag the 4 corners' },
                { value: 'warp', label: 'Warp', title: 'Drag the grid points to bend the layer' },
              ]}
            />
            {transformMode !== 'free' && selected?.mesh && (
              <button type="button" className="btn small ghost" onClick={resetMesh}>
                Reset shape
              </button>
            )}
            <label className="check">
              <input type="checkbox" checked={autoSelect} onChange={(e) => store.set({ autoSelect: e.target.checked })} />
              Auto-select
            </label>
            <label className="check" title="Hold Ctrl while dragging to move freely">
              <input type="checkbox" checked={snap} onChange={(e) => store.set({ snap: e.target.checked })} />
              Snap
            </label>
            <div className="align-btns" role="group" aria-label="Align to page">
              {(
                [
                  ['left', '⇤', 'Align left edge to page'],
                  ['hcenter', '↔', 'Center horizontally on page'],
                  ['right', '⇥', 'Align right edge to page'],
                  ['top', '⤒', 'Align top to page'],
                  ['vcenter', '↕', 'Center vertically on page'],
                  ['bottom', '⤓', 'Align bottom to page'],
                ] as const
              ).map(([id, glyph, title]) => (
                <button type="button" key={id} className="btn small ghost" title={title} aria-label={title} disabled={!selectedId} onClick={() => alignLayer(id)}>
                  {glyph}
                </button>
              ))}
            </div>
            <span className="muted">{transformMode === 'free' ? 'Corners resize · top dot rotates · Ctrl = no snap' : 'Drag the purple points to bend the layer'}</span>
          </>
        )}
        {(tool === 'dodge' || tool === 'clone' || tool === 'heal' || tool === 'remove') && (
          <>
            {tool === 'dodge' && (
              <Segmented
                label="Dodge or burn"
                value={retouch.dodgeMode}
                onChange={(v) => setRetouch({ dodgeMode: v })}
                options={[
                  { value: 'dodge', label: 'Dodge (lighten)' },
                  { value: 'burn', label: 'Burn (darken)' },
                ]}
              />
            )}
            <div className="opt-slider">
              <Slider label="Size" value={brush.size} min={1} max={1000} unit="px" onChange={(v) => setBrush({ size: v })} />
            </div>
            {tool === 'dodge' ? (
              <div className="opt-slider">
                <Slider label="Strength" value={retouch.strength} min={1} max={100} unit="%" onChange={(v) => setRetouch({ strength: v })} />
              </div>
            ) : tool !== 'remove' ? (
              <div className="opt-slider">
                <Slider label="Hardness" value={brush.hardness} min={0} max={100} unit="%" onChange={(v) => setBrush({ hardness: v })} />
              </div>
            ) : null}
            {(tool === 'clone' || tool === 'heal') && (
              <label className="check" title="Keep the same distance to the source between strokes">
                <input type="checkbox" checked={retouch.aligned} onChange={(e) => setRetouch({ aligned: e.target.checked, offset: null })} />
                Aligned
              </label>
            )}
            <span className="muted">
              {tool === 'dodge'
                ? 'Paints on a separate soft-light layer clipped to this one — the photo is never changed'
                : tool === 'remove'
                  ? 'Paint over the thing to remove; it fills from the surroundings when you let go'
                  : retouch.source
                    ? 'Paint to copy from the + mark · Alt+click to pick a new source'
                    : 'Alt+click a clean spot to copy from, then paint'}
            </span>
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
        {tool === 'select' && (
          <>
            <Segmented
              label="Selection shape"
              value={selectMode}
              onChange={(v) => store.set({ selectMode: v })}
              options={[
                { value: 'lasso', label: 'Lasso', title: 'Drag around the area' },
                { value: 'polygon', label: 'Polygon', title: 'Click points; click the first point, double-click or Enter to finish' },
                { value: 'ellipse', label: 'Ellipse', title: 'Drag an oval — good for heads' },
                { value: 'rect', label: 'Rectangle' },
              ]}
            />
            <div className="opt-slider">
              <Slider label="Feather" value={feather} min={0} max={100} unit="px" defaultValue={0} onChange={(v) => store.set({ feather: v })} />
            </div>
            {selection ? (
              <div className="opt-btns">
                <button type="button" className="btn small primary" onClick={() => selectionToLayer(false)} title="Ctrl+J">
                  Copy to new layer
                </button>
                <button type="button" className="btn small" onClick={() => selectionToLayer(true)} title="Ctrl+Shift+J">
                  Cut to new layer
                </button>
                <button type="button" className="btn small" onClick={() => maskFromSelection('reveal')}>
                  Mask: keep only this
                </button>
                <button type="button" className="btn small" onClick={() => maskFromSelection('hide')}>
                  Mask: hide this
                </button>
                <button type="button" className="btn small ghost" onClick={invertSel} title="Ctrl+Shift+I">
                  Invert
                </button>
                <button type="button" className="btn small ghost" onClick={deselect} title="Ctrl+D">
                  Deselect
                </button>
              </div>
            ) : (
              <span className="muted">
                {selectMode === 'polygon'
                  ? 'Click points around the area · click the first point or press Enter to close · Esc cancels'
                  : 'Drag around what you want · Shift adds · Alt subtracts'}
              </span>
            )}
          </>
        )}
        {tool === 'swirl' && (
          <>
            <span className="target-pill">{swirlRedrawId ? 'Redrawing selected swirl' : 'Drag to draw a swirl'}</span>
            <Segmented
              label="Swirl style"
              value={swirl.style}
              onChange={(v) => store.set({ swirl: { ...swirl, style: v } })}
              options={[
                { value: 'trail', label: 'Energy trail' },
                { value: 'helix', label: 'Twisted ribbon' },
              ]}
            />
            <div className="row" role="group" aria-label="Swirl colors">
              {SWIRL_PRESETS.map((p) => (
                <button
                  type="button"
                  key={p.id}
                  className={`preset-chip ${swirl.preset === p.id ? 'on' : ''}`}
                  title={p.label}
                  aria-label={`${p.label} colors`}
                  aria-pressed={swirl.preset === p.id}
                  style={{ background: `linear-gradient(90deg, ${p.palette.join(',')})` }}
                  onClick={() => store.set({ swirl: { ...swirl, preset: p.id } })}
                />
              ))}
            </div>
            <div className="opt-slider">
              <Slider label="Thickness" value={swirl.width} min={1} max={80} unit="px" onChange={(v) => store.set({ swirl: { ...swirl, width: v } })} />
            </div>
            <div className="opt-slider">
              <Slider label="Spread" value={swirl.amplitude} min={0} max={400} unit="px" onChange={(v) => store.set({ swirl: { ...swirl, amplitude: v } })} />
            </div>
            <div className="opt-slider">
              <Slider label="Strands" value={swirl.strands} min={1} max={6} onChange={(v) => store.set({ swirl: { ...swirl, strands: v } })} />
            </div>
          </>
        )}
        {tool === 'fire' && (
          <>
            <span className="target-pill">{swirlRedrawId ? 'Redrawing selected fire' : 'Drag along the ground — flames rise up'}</span>
            <div className="row" role="group" aria-label="Fire colors">
              {FIRE_PRESETS.map((p) => (
                <button
                  type="button"
                  key={p.id}
                  className={`preset-chip ${fire.preset === p.id ? 'on' : ''}`}
                  title={p.label}
                  aria-label={`${p.label} colors`}
                  aria-pressed={fire.preset === p.id}
                  style={{ background: `linear-gradient(90deg, ${p.palette.slice(1).join(',')})` }}
                  onClick={() => store.set({ fire: { ...fire, preset: p.id } })}
                />
              ))}
            </div>
            <div className="opt-slider">
              <Slider label="Flame height" value={fire.height} min={40} max={2000} unit="px" onChange={(v) => store.set({ fire: { ...fire, height: v } })} />
            </div>
            <div className="opt-slider">
              <Slider label="Thickness" value={fire.width} min={8} max={300} unit="px" onChange={(v) => store.set({ fire: { ...fire, width: v } })} />
            </div>
            <div className="opt-slider">
              <Slider label="Wildness" value={fire.wild} min={0} max={100} unit="%" onChange={(v) => store.set({ fire: { ...fire, wild: v } })} />
            </div>
          </>
        )}
        {tool === 'cutout' && (
          <>
            <Segmented
              label="Cutout tool"
              value={cut.mode}
              onChange={(v) => setCut({ mode: v })}
              options={[
                { value: 'pick', label: 'Pick', title: 'Click a person or drag a box · Shift+click adds · Alt+click excludes' },
                { value: 'add', label: '+ Add', title: 'Paint to keep more' },
                { value: 'remove', label: '− Remove', title: 'Paint to cut away' },
                { value: 'refine', label: 'Refine edge', title: 'Paint over hair or fuzzy edges to re-solve them' },
              ]}
            />
            {cut.mode !== 'pick' && (
              <div className="opt-slider">
                <Slider label="Size" value={cut.brush} min={2} max={1000} unit="px" onChange={(v) => setCut({ brush: v })} />
              </div>
            )}
            <Segmented
              label="View"
              value={cut.view}
              onChange={(v) => setCut({ view: v })}
              options={[
                { value: 'overlay', label: 'Overlay', title: 'Red shows what will be cut away' },
                { value: 'black', label: 'On black' },
                { value: 'white', label: 'On white' },
                { value: 'layers', label: 'On layers', title: 'See it in the poster' },
              ]}
            />
            <span className="muted">{cut.mode === 'pick' ? 'Click a person · drag a box · Shift+click adds · Alt+click excludes' : '[ ] size · Ctrl+Z undoes a stroke'}</span>
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
              onClick={() => setTool(t.id)}
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
          {tool === 'cutout' && <CutoutPanel />}
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
