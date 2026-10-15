import { useState } from 'react';
import { newDocument, openImagesDialog, openProject } from '../actions';
import { store } from '../store';

interface Preset {
  id: string;
  label: string;
  note?: string;
  inches?: [number, number];
  px?: [number, number];
  dpi: number;
}

const PRESETS: Preset[] = [
  { id: 'p1824-150', label: 'Poster 18×24 in', note: '150 DPI · 2700×3600 · best for this laptop', inches: [18, 24], dpi: 150 },
  { id: 'p1824-300', label: 'Poster 18×24 in', note: '300 DPI · 5400×7200 · needs lots of memory', inches: [18, 24], dpi: 300 },
  { id: 'p2436-150', label: 'Poster 24×36 in', note: '150 DPI · 3600×5400', inches: [24, 36], dpi: 150 },
  { id: 'p1117-300', label: 'Poster 11×17 in', note: '300 DPI · 3300×5100', inches: [11, 17], dpi: 300 },
  { id: 'letter', label: 'Letter 8.5×11 in', note: '300 DPI', inches: [8.5, 11], dpi: 300 },
  { id: 'photo46', label: 'Photo 4×6 in', note: '300 DPI', inches: [4, 6], dpi: 300 },
  { id: 'ig-post', label: 'Instagram post', note: '1080×1350', px: [1080, 1350], dpi: 72 },
  { id: 'ig-story', label: 'Story / phone wallpaper', note: '1080×1920', px: [1080, 1920], dpi: 72 },
  { id: 'hd', label: 'Widescreen HD', note: '1920×1080', px: [1920, 1080], dpi: 72 },
];

export default function NewDocDialog({ onClose, canCancel }: { onClose: () => void; canCancel: boolean }) {
  const [presetId, setPresetId] = useState('p1824-150');
  const [name, setName] = useState('Poster');
  const [bg, setBg] = useState('#000000');
  const [custom, setCustom] = useState({ unit: 'in' as 'in' | 'px', w: 18, h: 24, dpi: 150 });
  const [orient, setOrient] = useState<'portrait' | 'landscape'>('portrait');

  const preset = PRESETS.find((p) => p.id === presetId);
  let w: number, h: number, dpi: number;
  if (preset) {
    dpi = preset.dpi;
    [w, h] = preset.px ?? [Math.round(preset.inches![0] * dpi), Math.round(preset.inches![1] * dpi)];
  } else {
    dpi = custom.dpi;
    w = custom.unit === 'in' ? Math.round(custom.w * dpi) : Math.round(custom.w);
    h = custom.unit === 'in' ? Math.round(custom.h * dpi) : Math.round(custom.h);
  }
  if (preset?.inches && orient === 'landscape') [w, h] = [h, w];
  const mp = (w * h) / 1e6;

  const create = () => {
    newDocument(w, h, dpi, name.trim() || 'Untitled', bg === 'transparent' ? '' : bg);
    onClose();
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="newdoc-title">
      <div className="modal">
        <h2 id="newdoc-title">New document</h2>
        <div className="preset-grid">
          {PRESETS.map((p) => (
            <button
              type="button"
              key={p.id}
              className={`preset ${presetId === p.id ? 'on' : ''}`}
              aria-pressed={presetId === p.id}
              onClick={() => setPresetId(p.id)}
            >
              <strong>{p.label}</strong>
              <span>{p.note}</span>
            </button>
          ))}
          <button
            type="button"
            className={`preset ${presetId === 'custom' ? 'on' : ''}`}
            aria-pressed={presetId === 'custom'}
            onClick={() => setPresetId('custom')}
          >
            <strong>Custom size</strong>
            <span>Inches or pixels</span>
          </button>
        </div>

        {presetId === 'custom' && (
          <div className="custom-size">
            <label className="field">
              <span>Width</span>
              <input type="number" value={custom.w} min={1} onChange={(e) => setCustom({ ...custom, w: Number(e.target.value) })} />
            </label>
            <label className="field">
              <span>Height</span>
              <input type="number" value={custom.h} min={1} onChange={(e) => setCustom({ ...custom, h: Number(e.target.value) })} />
            </label>
            <label className="field">
              <span>Units</span>
              <select value={custom.unit} onChange={(e) => setCustom({ ...custom, unit: e.target.value as 'in' | 'px' })}>
                <option value="in">inches</option>
                <option value="px">pixels</option>
              </select>
            </label>
            <label className="field">
              <span>DPI</span>
              <input type="number" value={custom.dpi} min={30} max={600} onChange={(e) => setCustom({ ...custom, dpi: Number(e.target.value) })} />
            </label>
          </div>
        )}

        <div className="newdoc-row">
          <label className="field">
            <span>Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="field">
            <span>Background</span>
            <select value={bg} onChange={(e) => setBg(e.target.value)}>
              <option value="#000000">Black</option>
              <option value="#ffffff">White</option>
              <option value="transparent">Transparent</option>
            </select>
          </label>
          {preset?.inches && (
            <label className="field">
              <span>Orientation</span>
              <select value={orient} onChange={(e) => setOrient(e.target.value as 'portrait' | 'landscape')}>
                <option value="portrait">Portrait</option>
                <option value="landscape">Landscape</option>
              </select>
            </label>
          )}
        </div>
        <p className={`hint ${mp > 30 ? 'warn' : ''}`}>
          {w} × {h} px · {dpi} DPI · {mp.toFixed(1)} megapixels
          {mp > 30 && ' — large documents can be slow on a lighter laptop. 150 DPI prints great at poster size.'}
        </p>

        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={() => openImagesDialog().then(() => store.state.doc && onClose())}>
            Open image…
          </button>
          <button type="button" className="btn ghost" onClick={() => openProject().then(() => store.state.doc && onClose())}>
            Open project…
          </button>
          <span className="spacer" />
          {canCancel && (
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
          )}
          <button type="button" className="btn primary" onClick={create}>
            Create
          </button>
        </div>
      </div>
    </div>
  );
}
