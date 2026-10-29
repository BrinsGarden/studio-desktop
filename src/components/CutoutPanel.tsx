import { useState } from 'react';
import { store, useStore } from '../store';
import { cutoutApply, cutoutCancel, cutoutSubject, setCutoutEdges } from '../cutout';
import { Slider } from './ui';
import { Icon } from './icons';

/** Floating "Select and Mask"-style panel shown over the canvas while the Cutout tool is active. */
export default function CutoutPanel() {
  const cut = useStore((s) => s.cutout);
  const doc = useStore((s) => s.doc);
  const selectedId = useStore((s) => s.selectedId);
  const [collapsed, setCollapsed] = useState(false);
  if (!doc) return null;
  const layer = doc.layers.find((l) => l.id === (cut.layerId ?? selectedId));
  const working = cut.status === 'working';
  const set = (patch: Partial<typeof cut>) => store.set({ cutout: { ...store.state.cutout, ...patch } });

  return (
    <div className="cutout-panel" role="region" aria-label="Cutout">
      <div className="cutout-head">
        <strong>Cutout</strong>
        <span className="muted">{layer ? layer.name : 'No layer'}</span>
        {cut.device && <span className={`chip ${cut.device === 'webgpu' ? 'ok' : ''}`}>{cut.device === 'webgpu' ? 'GPU' : 'CPU'}</span>}
        <button type="button" className="icon-btn" aria-expanded={!collapsed} aria-label={collapsed ? 'Show cutout panel' : 'Hide cutout panel'} onClick={() => setCollapsed(!collapsed)}>
          <Icon name={collapsed ? 'up' : 'down'} size={14} />
        </button>
      </div>
      {!collapsed && (
        <>

      {!cut.hasResult && !working && cut.status !== 'error' && (
        <ol className="cutout-steps">
          <li>
            <b>Click the person</b> you want — or drag a box around them.
          </li>
          <li>
            <b>Shift+click</b> to add a missed part, <b>Alt+click</b> to leave something out.
          </li>
          <li>
            Touch up with <b>Add</b>, <b>Remove</b> and <b>Refine edge</b> (paint over hair), then <b>Apply</b>.
          </li>
        </ol>
      )}

      {(working || cut.status === 'error' || cut.message) && (
        <div className={`cutout-status ${cut.status === 'error' ? 'err' : ''}`} role="status">
          {working && <span className="spinner" aria-hidden="true" />}
          <span>{cut.message || (working ? 'Working…' : '')}</span>
          {cut.progress != null && (
            <div className="bar">
              <div style={{ width: `${Math.round(cut.progress * 100)}%` }} />
            </div>
          )}
        </div>
      )}

      <div className="row">
        <button type="button" className="btn small" disabled={working} onClick={cutoutSubject} title="Let the AI find the main subject of the whole photo">
          Whole photo
        </button>
        <label className="field inline">
          <span>Quality</span>
          <select value={cut.quality} disabled={working} onChange={(e) => set({ quality: e.target.value as typeof cut.quality })}>
            <option value="fast">Fast (45–90 MB)</option>
            <option value="best">Best (115 MB)</option>
            <option value="max">Max — people (490 MB, GPU)</option>
          </select>
        </label>
      </div>

      {cut.hasResult && (
        <>
          <div className="cutout-sliders">
            <Slider label="Smart edge" value={cut.edges.edgeRadius} min={0} max={40} unit="px" defaultValue={0} onChange={(v) => setCutoutEdges({ edgeRadius: v })} />
            <Slider label="Shift edge" value={cut.edges.shift} min={-20} max={20} unit="px" defaultValue={0} onChange={(v) => setCutoutEdges({ shift: v })} />
            <Slider label="Smooth" value={cut.edges.smooth} min={0} max={20} defaultValue={0} onChange={(v) => setCutoutEdges({ smooth: v })} />
            <Slider label="Feather" value={cut.edges.feather} min={0} max={30} unit="px" defaultValue={0} onChange={(v) => setCutoutEdges({ feather: v })} />
            <Slider label="Contrast" value={cut.edges.contrast} min={0} max={100} unit="%" defaultValue={0} onChange={(v) => setCutoutEdges({ contrast: v })} />
          </div>
          <p className="hint">Smart edge re-solves fuzzy edges from the photo's colors. Raise it for hair and feathers; leave it at 0 for clean edges.</p>
          <label className="check">
            <input type="checkbox" checked={cut.decontam} onChange={(e) => set({ decontam: e.target.checked })} />
            Decontaminate colors (removes the old background's color from hair and edges)
          </label>
          {cut.decontam && (
            <Slider label="Amount" value={cut.decontamAmount} min={0} max={100} unit="%" defaultValue={100} onChange={(v) => set({ decontamAmount: v })} />
          )}
        </>
      )}

      <div className="cutout-actions">
        <button type="button" className="btn small primary" disabled={!cut.hasResult || working} onClick={() => cutoutApply(true)} title="Enter">
          Apply as new layer
        </button>
        <button type="button" className="btn small" disabled={!cut.hasResult || working} onClick={() => cutoutApply(false)}>
          Apply to mask
        </button>
        <button type="button" className="btn small ghost" disabled={!cut.layerId || working} onClick={cutoutCancel} title="Esc">
          Cancel
        </button>
      </div>
        </>
      )}
    </div>
  );
}
