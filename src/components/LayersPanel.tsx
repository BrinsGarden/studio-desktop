import { useEffect, useRef, useState } from 'react';
import { store, useStore } from '../store';
import type { Doc, Layer } from '../engine/types';
import { drawThumb } from '../engine/render';
import { Icon } from './icons';
import {
  addAdjustLayer,
  addFill,
  addFog,
  addMask,
  addText,
  deleteLayer,
  duplicateLayer,
  moveLayer,
  nudgeLayer,
  openImagesDialog,
} from '../actions';

function Thumb({ layer, doc, which, rev }: { layer: Layer; doc: Doc; which: 'source' | 'mask'; rev: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    if (which === 'source' && layer.kind === 'adjust') return;
    const id = requestAnimationFrame(() => ref.current && drawThumb(layer, doc, ref.current, which));
    return () => cancelAnimationFrame(id);
  }, [layer, doc, which, rev]);
  if (which === 'source' && layer.kind === 'adjust') {
    return (
      <span className="thumb adjust-thumb" aria-hidden="true">
        <Icon name="adjust" size={20} />
      </span>
    );
  }
  return <canvas ref={ref} className="thumb" width={40} height={40} aria-hidden="true" />;
}

export default function LayersPanel() {
  const doc = useStore((s) => s.doc);
  const selectedId = useStore((s) => s.selectedId);
  const editMask = useStore((s) => s.editMask);
  const rev = useStore((s) => s.rev);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropIdx, setDropIdx] = useState<number | null>(null);

  if (!doc) return null;
  const rows = [...doc.layers].reverse();

  return (
    <div className="layers">
      <div className="panel-head layers-head">
        <span>Layers</span>
        <div className="layer-ops">
          <button type="button" className="icon-btn" title="Move layer up (Ctrl+])" aria-label="Move layer up" onClick={() => nudgeLayer(1)} disabled={!selectedId}>
            <Icon name="up" size={16} />
          </button>
          <button type="button" className="icon-btn" title="Move layer down (Ctrl+[)" aria-label="Move layer down" onClick={() => nudgeLayer(-1)} disabled={!selectedId}>
            <Icon name="down" size={16} />
          </button>
          <button type="button" className="icon-btn" title="Duplicate (Ctrl+J)" aria-label="Duplicate layer" onClick={() => duplicateLayer()} disabled={!selectedId}>
            <Icon name="copy" size={16} />
          </button>
          <button type="button" className="icon-btn danger" title="Delete layer (Del)" aria-label="Delete layer" onClick={() => deleteLayer()} disabled={!selectedId}>
            <Icon name="trash" size={16} />
          </button>
        </div>
      </div>
      <ul className="layer-list" role="listbox" aria-label="Layers">
        {rows.length === 0 && <li className="empty-row">No layers yet — add an image below.</li>}
        {rows.map((l, ri) => {
          const realIdx = doc.layers.length - 1 - ri;
          const selected = l.id === selectedId;
          return (
            <li
              key={l.id}
              role="option"
              aria-selected={selected}
              className={`layer-row ${selected ? 'selected' : ''} ${dropIdx === realIdx && dragId ? 'drop' : ''}`}
              draggable={renaming !== l.id}
              onDragStart={(e) => {
                setDragId(l.id);
                e.dataTransfer.effectAllowed = 'move';
              }}
              onDragOver={(e) => {
                if (!dragId) return;
                e.preventDefault();
                setDropIdx(realIdx);
              }}
              onDragEnd={() => {
                setDragId(null);
                setDropIdx(null);
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragId && dragId !== l.id) moveLayer(dragId, realIdx);
                setDragId(null);
                setDropIdx(null);
              }}
              onClick={() => store.set({ selectedId: l.id, editMask: l.kind === 'adjust' ? true : selected ? editMask : false, showMask: false })}
            >
              <button
                type="button"
                className="icon-btn eye"
                aria-label={l.visible ? `Hide ${l.name}` : `Show ${l.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  store.updateLayer(l.id, (x) => (x.visible = !x.visible), 'Visibility', `vis${Date.now()}`);
                }}
              >
                <Icon name={l.visible ? 'eye' : 'eyeOff'} size={16} />
              </button>
              <button
                type="button"
                className={`thumb-btn ${selected && !editMask ? 'target' : ''}`}
                aria-label={`Edit ${l.name} pixels`}
                onClick={(e) => {
                  e.stopPropagation();
                  store.set({ selectedId: l.id, editMask: l.kind === 'adjust', showMask: false });
                }}
              >
                <Thumb layer={l} doc={doc} which="source" rev={rev} />
              </button>
              {l.mask && (
                <button
                  type="button"
                  className={`thumb-btn ${selected && editMask ? 'target' : ''} ${l.maskEnabled ? '' : 'disabled'}`}
                  aria-label={`Edit ${l.name} mask`}
                  title="Click to paint the mask"
                  onClick={(e) => {
                    e.stopPropagation();
                    store.set({ selectedId: l.id, editMask: true });
                    if (store.state.tool === 'move') store.set({ tool: 'brush' });
                  }}
                >
                  <Thumb layer={l} doc={doc} which="mask" rev={rev} />
                </button>
              )}
              {renaming === l.id ? (
                <input
                  className="rename"
                  autoFocus
                  defaultValue={l.name}
                  aria-label="Layer name"
                  onClick={(e) => e.stopPropagation()}
                  onBlur={(e) => {
                    const v = e.target.value.trim();
                    if (v && v !== l.name) store.updateLayer(l.id, (x) => (x.name = v), 'Rename');
                    setRenaming(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                    if (e.key === 'Escape') setRenaming(null);
                  }}
                />
              ) : (
                <span className="layer-name" onDoubleClick={() => setRenaming(l.id)} title="Double-click to rename">
                  {l.name}
                  {(l.blend !== 'source-over' || l.opacity < 1) && (
                    <small>
                      {l.blend !== 'source-over' ? l.blend.replace('source-over', 'normal') : ''}
                      {l.opacity < 1 ? ` ${Math.round(l.opacity * 100)}%` : ''}
                    </small>
                  )}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      <div className="layer-actions">
        <button type="button" className="icon-btn" title="Add image (or drop files on the canvas)" aria-label="Add image" onClick={openImagesDialog}>
          <Icon name="image" />
        </button>
        <button type="button" className="icon-btn" title="Add text" aria-label="Add text" onClick={addText}>
          <Icon name="text" />
        </button>
        <button type="button" className="icon-btn" title="Add gradient / color fill" aria-label="Add gradient" onClick={addFill}>
          <Icon name="gradient" />
        </button>
        <button type="button" className="icon-btn" title="Add fog" aria-label="Add fog" onClick={addFog}>
          <Icon name="fog" />
        </button>
        <button type="button" className="icon-btn" title="Add color adjustment layer (affects everything below)" aria-label="Add adjustment layer" onClick={addAdjustLayer}>
          <Icon name="adjust" />
        </button>
        <button type="button" className="icon-btn" title="Add mask to selected layer" aria-label="Add mask" onClick={addMask} disabled={!selectedId}>
          <Icon name="mask" />
        </button>
      </div>
    </div>
  );
}
