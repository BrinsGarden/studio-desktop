import { useEffect, useState } from 'react';
import { store, useStore } from '../store';
import {
  BLEND_MODES,
  FONTS,
  defaultAdjustments,
  defaultEffects,
  type Adjustments,
  type BalanceTriple,
  type Effects,
  type Layer,
  type TextProps,
  type FillProps,
  type SwirlProps,
  SWIRL_PRESETS,
} from '../engine/types';
import { ColorField, Section, Segmented, Select, Slider } from './ui';
import { CurvesEditor } from './CurvesEditor';
import { Icon } from './icons';
import { addMask, deleteMask, fitLayerToCanvas, invertMask, rasterize } from '../actions';
import { fontString } from '../engine/render';

type Tab = 'layer' | 'color' | 'effects';

export default function Properties() {
  const doc = useStore((s) => s.doc);
  const selectedId = useStore((s) => s.selectedId);
  const [tab, setTab] = useState<Tab>('layer');
  const layer = doc?.layers.find((l) => l.id === selectedId);
  const kind = layer?.kind;
  // text & gradient settings live on the Layer tab — jump there when one is selected
  useEffect(() => {
    if (kind === 'text' || kind === 'fill' || kind === 'swirl') setTab('layer');
    if (kind === 'adjust') setTab('color');
  }, [selectedId, kind]);

  if (!doc) return <div className="props empty">Create or open a document to begin.</div>;
  if (!layer) return <div className="props empty">Select a layer to edit it.</div>;

  const isAdjust = layer.kind === 'adjust';
  const tabs: { value: Tab; label: string }[] = isAdjust
    ? [
        { value: 'color', label: 'Color' },
        { value: 'layer', label: 'Layer' },
      ]
    : [
        { value: 'layer', label: 'Layer' },
        { value: 'color', label: 'Color' },
        { value: 'effects', label: 'Effects' },
      ];
  const active = tabs.some((t) => t.value === tab) ? tab : tabs[0].value;

  return (
    <div className="props">
      <div className="props-title">
        <strong>{layer.name}</strong>
        <span className="kind">{kindLabel(layer)}</span>
      </div>
      <div className="tabs" role="tablist">
        {tabs.map((t) => (
          <button
            type="button"
            role="tab"
            aria-selected={active === t.value}
            key={t.value}
            className={active === t.value ? 'on' : ''}
            onClick={() => setTab(t.value)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="props-scroll">
        {active === 'layer' && <LayerTab layer={layer} />}
        {active === 'color' && <ColorTab layer={layer} />}
        {active === 'effects' && <EffectsTab layer={layer} />}
      </div>
    </div>
  );
}

function kindLabel(l: Layer) {
  return { image: 'Image', text: 'Text', fill: 'Gradient / Fill', adjust: 'Adjustment', swirl: 'Magic swirl' }[l.kind];
}

function up(layer: Layer, label: string, fn: (l: Layer) => void) {
  store.updateLayer(layer.id, fn, label);
}

/* ------------------------------------------------------------------ */
function LayerTab({ layer }: { layer: Layer }) {
  const editMask = useStore((s) => s.editMask);
  const showMask = useStore((s) => s.showMask);
  return (
    <>
      {layer.kind === 'text' && layer.text && <TextSection layer={layer} t={layer.text} />}
      {layer.kind === 'fill' && layer.fill && <FillSection layer={layer} f={layer.fill} />}
      {layer.kind === 'swirl' && layer.swirl && <SwirlSection layer={layer} s={layer.swirl} />}

      <Section title="Blending">
        <Select
          label="Blend mode"
          value={layer.blend}
          options={BLEND_MODES}
          onChange={(v) => up(layer, 'Blend mode', (l) => (l.blend = v))}
        />
        <Slider
          label="Opacity"
          value={Math.round(layer.opacity * 100)}
          min={0}
          max={100}
          unit="%"
          defaultValue={100}
          onChange={(v) => up(layer, 'Opacity', (l) => (l.opacity = v / 100))}
        />
      </Section>

      {layer.kind !== 'adjust' && (
        <Section title="Transform">
          <div className="grid2">
            <label className="field">
              <span>X</span>
              <input
                type="number"
                value={Math.round(layer.x)}
                onChange={(e) => up(layer, 'Move', (l) => (l.x = Number(e.target.value)))}
              />
            </label>
            <label className="field">
              <span>Y</span>
              <input
                type="number"
                value={Math.round(layer.y)}
                onChange={(e) => up(layer, 'Move', (l) => (l.y = Number(e.target.value)))}
              />
            </label>
          </div>
          <Slider
            label="Scale"
            value={Math.round(layer.scale * 1000) / 10}
            min={1}
            max={400}
            step={0.1}
            unit="%"
            defaultValue={100}
            onChange={(v) => up(layer, 'Scale', (l) => (l.scale = Math.max(0.001, v / 100)))}
          />
          <Slider
            label="Rotate"
            value={layer.rotation}
            min={-180}
            max={180}
            step={0.5}
            unit="°"
            defaultValue={0}
            onChange={(v) => up(layer, 'Rotate', (l) => (l.rotation = v))}
          />
          <div className="row">
            <button type="button" className="btn small" onClick={() => up(layer, 'Flip', (l) => (l.flipX = !l.flipX))}>
              <Icon name="flipH" size={14} /> Flip H
            </button>
            <button type="button" className="btn small" onClick={() => up(layer, 'Flip', (l) => (l.flipY = !l.flipY))}>
              <Icon name="flipV" size={14} /> Flip V
            </button>
            <button type="button" className="btn small" onClick={() => fitLayerToCanvas('fit')}>
              Fit
            </button>
            <button type="button" className="btn small" onClick={() => fitLayerToCanvas('fill')}>
              Fill
            </button>
          </div>
          {(layer.kind === 'text' || layer.kind === 'fill' || layer.kind === 'swirl') && (
            <button type="button" className="btn small ghost" onClick={() => rasterize(layer.id)}>
              Rasterize (turn into paintable pixels)
            </button>
          )}
        </Section>
      )}

      <Section title="Mask">
        {!layer.mask ? (
          <>
            <p className="hint">A mask hides parts of this layer without deleting anything. Paint black to hide, white to bring back.</p>
            <button type="button" className="btn" onClick={addMask}>
              <Icon name="mask" size={16} /> Add mask
            </button>
          </>
        ) : (
          <>
            <Segmented
              label="Paint target"
              value={editMask || layer.kind === 'adjust' ? 'mask' : 'pixels'}
              onChange={(v) => store.set({ editMask: v === 'mask' })}
              options={[
                { value: 'mask', label: 'Paint mask' },
                { value: 'pixels', label: 'Paint pixels' },
              ]}
            />
            <label className="check">
              <input
                type="checkbox"
                checked={layer.maskEnabled}
                onChange={(e) => up(layer, 'Toggle mask', (l) => (l.maskEnabled = e.target.checked))}
              />
              Mask on
            </label>
            <label className="check">
              <input type="checkbox" checked={showMask} onChange={(e) => store.set({ showMask: e.target.checked })} />
              Show mask as black &amp; white <kbd>\</kbd>
            </label>
            <div className="row">
              <button type="button" className="btn small" onClick={invertMask}>
                Invert
              </button>
              <button type="button" className="btn small danger" onClick={deleteMask}>
                Delete mask
              </button>
            </div>
          </>
        )}
      </Section>

      {layer.kind === 'image' && <KeySection layer={layer} />}

      {layer.kind !== 'adjust' && (
        <Section title="Edges & blur" defaultOpen={layer.kind === 'image'}>
          <p className="hint">Clean up cutout halos: shrink pulls the edge in, soften feathers it.</p>
          <Slider
            label="Shrink edge"
            value={layer.fx.shrinkEdge}
            min={0}
            max={12}
            unit="px"
            defaultValue={0}
            onChange={(v) => up(layer, 'Shrink edge', (l) => (l.fx.shrinkEdge = v))}
          />
          <Slider
            label="Soften edge"
            value={layer.fx.softenEdge}
            min={0}
            max={20}
            unit="px"
            defaultValue={0}
            onChange={(v) => up(layer, 'Soften edge', (l) => (l.fx.softenEdge = v))}
          />
          <Slider
            label="Blur"
            value={layer.fx.blur}
            min={0}
            max={60}
            step={0.5}
            unit="px"
            defaultValue={0}
            onChange={(v) => up(layer, 'Blur', (l) => (l.fx.blur = v))}
          />
        </Section>
      )}
    </>
  );
}

function KeySection({ layer }: { layer: Layer }) {
  const brushColor = useStore((s) => s.brush.color);
  const key = layer.fx.key ?? defaultEffects().key;
  const set = (fn: (k: Effects['key']) => void) =>
    up(layer, 'Remove background color', (l) => {
      const k = { ...(l.fx.key ?? defaultEffects().key) };
      fn(k);
      l.fx.key = k;
    });
  return (
    <Section
      title="Remove background color"
      defaultOpen={key.enabled}
      enabled={key.enabled}
      onToggle={(v) => set((k) => (k.enabled = v))}
    >
      <p className="hint">
        For images shot on a plain background (like a cage on black). Makes that color see-through, including gaps between bars.
        Raise Tolerance until the background is gone, then Softness to smooth the edges.
      </p>
      <ColorField label="Background" value={key.color} onChange={(v) => set((k) => { k.color = v; k.enabled = true; })} />
      <div className="row">
        <button type="button" className="btn small" onClick={() => set((k) => { k.color = '#000000'; k.enabled = true; })}>
          Black
        </button>
        <button type="button" className="btn small" onClick={() => set((k) => { k.color = '#ffffff'; k.enabled = true; })}>
          White
        </button>
        <button
          type="button"
          className="btn small"
          title="Use the color picked with the Eyedropper tool (I)"
          onClick={() => set((k) => { k.color = brushColor; k.enabled = true; })}
        >
          <span className="dot" style={{ background: brushColor }} aria-hidden="true" /> Eyedropper color
        </button>
      </div>
      <Slider label="Tolerance" value={key.tolerance} min={0} max={60} unit="%" defaultValue={12} onChange={(v) => set((k) => { k.tolerance = v; k.enabled = true; })} />
      <Slider label="Softness" value={key.softness} min={0} max={40} unit="%" defaultValue={8} onChange={(v) => set((k) => { k.softness = v; k.enabled = true; })} />
    </Section>
  );
}

function SwirlSection({ layer, s }: { layer: Layer; s: SwirlProps }) {
  const set = (label: string, patch: Partial<SwirlProps>) =>
    up(layer, label, (l) => {
      l.swirl = { ...l.swirl!, ...patch };
    });
  const setColor = (i: number, c: string) => {
    const pal = [...s.palette];
    pal[i] = c;
    set('Swirl colors', { palette: pal });
  };
  return (
    <Section title="Magic swirl">
      <div className="row">
        {SWIRL_PRESETS.map((p) => (
          <button
            type="button"
            key={p.id}
            className="preset-chip"
            title={p.label}
            aria-label={`${p.label} colors`}
            style={{ background: `linear-gradient(90deg, ${p.palette.join(',')})` }}
            onClick={() => set('Swirl colors', { palette: [...p.palette] })}
          />
        ))}
      </div>
      <div className="row">
        {s.palette.map((c, i) => (
          <input
            key={i}
            type="color"
            className="mini-color"
            aria-label={`Swirl color ${i + 1}`}
            value={c}
            onChange={(e) => setColor(i, e.target.value)}
          />
        ))}
        {s.palette.length < 6 && (
          <button type="button" className="btn small" onClick={() => set('Swirl colors', { palette: [...s.palette, s.palette[s.palette.length - 1] ?? '#ffffff'] })}>
            + color
          </button>
        )}
        {s.palette.length > 1 && (
          <button type="button" className="btn small ghost" onClick={() => set('Swirl colors', { palette: s.palette.slice(0, -1) })}>
            − color
          </button>
        )}
      </div>
      <Slider label="Strands" value={s.strands} min={1} max={6} onChange={(v) => set('Strands', { strands: v })} />
      <Slider label="Twists" value={s.wraps} min={0} max={40} step={0.5} onChange={(v) => set('Twists', { wraps: v })} />
      <Slider label="Spread" value={s.amplitude} min={0} max={400} unit="px" onChange={(v) => set('Spread', { amplitude: v })} />
      <Slider label="Thickness" value={s.width} min={1} max={80} unit="px" onChange={(v) => set('Thickness', { width: v })} />
      <Slider label="Glow" value={s.glow} min={0} max={120} unit="px" onChange={(v) => set('Glow', { glow: v })} />
      <Slider label="Sparkles" value={s.sparkles} min={0} max={200} onChange={(v) => set('Sparkles', { sparkles: v })} />
      <Slider label="Depth" value={Math.round(s.depth * 100)} min={0} max={100} unit="%" onChange={(v) => set('Depth', { depth: v / 100 })} />
      <Slider label="Taper ends" value={Math.round(s.taper * 100)} min={0} max={50} unit="%" onChange={(v) => set('Taper', { taper: v / 100 })} />
      <div className="row">
        <button type="button" className="btn small" onClick={() => set('Shuffle sparkles', { seed: Math.floor(Math.random() * 1e9) })}>
          Shuffle sparkles
        </button>
        <button
          type="button"
          className="btn small"
          onClick={() => {
            store.set({ tool: 'swirl', swirlRedrawId: layer.id });
            store.toast('Draw the new path on the canvas');
          }}
        >
          Redraw path
        </button>
      </div>
      <p className="hint">
        Depth fades the half of each loop that goes "behind". To wrap it around an arm, add a mask and paint out the parts that should pass behind her.
      </p>
    </Section>
  );
}

function TextSection({ layer, t }: { layer: Layer; t: TextProps }) {
  const set = (label: string, patch: Partial<TextProps>) => {
    if (patch.font || patch.weight || patch.italic !== undefined) {
      const next = { ...t, ...patch };
      document.fonts?.load(fontString(next)).catch(() => {});
    }
    up(layer, label, (l) => {
      l.text = { ...l.text!, ...patch };
    });
  };
  return (
    <Section title="Text">
      <label className="field col">
        <span>Text</span>
        <textarea rows={2} value={t.text} onChange={(e) => set('Edit text', { text: e.target.value })} />
      </label>
      <label className="field">
        <span>Font</span>
        <select value={t.font} onChange={(e) => set('Font', { font: e.target.value })} style={{ fontFamily: t.font }}>
          {FONTS.map((f) => (
            <option key={f} value={f} style={{ fontFamily: f }}>
              {f}
            </option>
          ))}
        </select>
      </label>
      <Slider label="Size" value={t.size} min={8} max={1200} unit="px" onChange={(v) => set('Font size', { size: v })} />
      <Slider label="Weight" value={t.weight} min={100} max={900} step={100} onChange={(v) => set('Weight', { weight: v })} />
      <Slider
        label="Spacing"
        value={t.letterSpacing}
        min={-50}
        max={200}
        unit="px"
        defaultValue={0}
        onChange={(v) => set('Letter spacing', { letterSpacing: v })}
      />
      <Slider
        label="Line height"
        value={t.lineHeight}
        min={0.6}
        max={2.5}
        step={0.05}
        defaultValue={1.1}
        onChange={(v) => set('Line height', { lineHeight: v })}
      />
      <div className="row">
        <Segmented
          label="Alignment"
          value={t.align}
          onChange={(v) => set('Align', { align: v })}
          options={[
            { value: 'left', label: 'Left' },
            { value: 'center', label: 'Center' },
            { value: 'right', label: 'Right' },
          ]}
        />
        <label className="check">
          <input type="checkbox" checked={t.italic} onChange={(e) => set('Italic', { italic: e.target.checked })} />
          Italic
        </label>
      </div>
      <Segmented
        label="Text fill"
        value={t.fillType}
        onChange={(v) => set('Text fill', { fillType: v })}
        options={[
          { value: 'solid', label: 'Solid color' },
          { value: 'gradient', label: 'Two-color gradient' },
        ]}
      />
      <ColorField label={t.fillType === 'gradient' ? 'Start color' : 'Color'} value={t.color} onChange={(v) => set('Text color', { color: v })} />
      {t.fillType === 'gradient' && (
        <>
          <ColorField label="End color" value={t.color2} onChange={(v) => set('Text color', { color2: v })} />
          <Segmented
            label="Gradient direction"
            value={t.gradientDir}
            onChange={(v) => set('Gradient direction', { gradientDir: v })}
            options={[
              { value: 'horizontal', label: 'Left → right' },
              { value: 'vertical', label: 'Top → bottom' },
            ]}
          />
        </>
      )}
      <Slider
        label="Outline"
        value={t.strokeWidth}
        min={0}
        max={60}
        unit="px"
        defaultValue={0}
        onChange={(v) => set('Outline', { strokeWidth: v })}
      />
      {t.strokeWidth > 0 && (
        <ColorField label="Outline color" value={t.strokeColor} onChange={(v) => set('Outline color', { strokeColor: v })} />
      )}
    </Section>
  );
}

function FillSection({ layer, f }: { layer: Layer; f: FillProps }) {
  const set = (label: string, patch: Partial<FillProps>) =>
    up(layer, label, (l) => {
      l.fill = { ...l.fill!, ...patch };
    });
  return (
    <Section title="Fill">
      <Segmented
        label="Fill type"
        value={f.type}
        onChange={(v) => set('Fill type', { type: v })}
        options={[
          { value: 'solid', label: 'Solid' },
          { value: 'linear', label: 'Linear' },
          { value: 'radial', label: 'Vignette' },
        ]}
      />
      <ColorField
        label={f.type === 'solid' ? 'Color' : f.type === 'radial' ? 'Center color' : 'Start color'}
        value={f.color1}
        onChange={(v) => set('Fill color', { color1: v })}
      />
      <Slider
        label={f.type === 'solid' ? 'Strength' : 'Start strength'}
        value={Math.round(f.alpha1 * 100)}
        min={0}
        max={100}
        unit="%"
        onChange={(v) => set('Fill strength', { alpha1: v / 100 })}
      />
      {f.type !== 'solid' && (
        <>
          <ColorField label={f.type === 'radial' ? 'Edge color' : 'End color'} value={f.color2} onChange={(v) => set('Fill color', { color2: v })} />
          <Slider
            label="End strength"
            value={Math.round(f.alpha2 * 100)}
            min={0}
            max={100}
            unit="%"
            onChange={(v) => set('Fill strength', { alpha2: v / 100 })}
          />
        </>
      )}
      {f.type === 'linear' && (
        <Slider
          label="Angle"
          value={f.angle}
          min={0}
          max={360}
          unit="°"
          defaultValue={90}
          onChange={(v) => set('Gradient angle', { angle: v })}
        />
      )}
      <p className="hint">90° fades top to bottom. Add a mask to limit where the gradient shows.</p>
    </Section>
  );
}

/* ------------------------------------------------------------------ */
function ColorTab({ layer }: { layer: Layer }) {
  const doc = useStore((s) => s.doc)!;
  const a = layer.adj;
  const [tone, setTone] = useState<'shadows' | 'midtones' | 'highlights'>('midtones');
  const set = (label: string, fn: (a: Adjustments) => void) => up(layer, label, (l) => fn(l.adj));
  const matchOptions = [
    { value: '', label: '— none —' },
    ...doc.layers
      .filter((l) => l.id !== layer.id && l.kind !== 'adjust')
      .map((l) => ({ value: l.id, label: l.name })),
  ];
  const bal = a.balance[tone];
  const setBal = (i: number, v: number) =>
    set('Color balance', (x) => {
      const t = [...x.balance[tone]] as BalanceTriple;
      t[i] = v;
      x.balance[tone] = t;
    });

  return (
    <>
      <div className="row end">
        <button
          type="button"
          className="btn small ghost"
          onClick={() => up(layer, 'Reset color', (l) => (l.adj = defaultAdjustments()))}
        >
          Reset all color
        </button>
      </div>

      {layer.kind !== 'adjust' && (
        <Section title="Match color">
          <p className="hint">Pull this layer's colors and brightness toward another layer — pick your background to blend people into the scene.</p>
          <Select
            label="Match to"
            value={a.match.layerId ?? ''}
            options={matchOptions}
            onChange={(v) => set('Match color', (x) => (x.match.layerId = v || null))}
          />
          {a.match.layerId && (
            <Slider
              label="Strength"
              value={a.match.strength}
              min={0}
              max={100}
              unit="%"
              defaultValue={70}
              onChange={(v) => set('Match strength', (x) => (x.match.strength = v))}
            />
          )}
        </Section>
      )}
      {layer.kind === 'adjust' && (
        <p className="hint">This layer recolors everything below it. Add a mask to limit where it applies.</p>
      )}

      <Section title="Brightness / Contrast">
        <Slider label="Brightness" value={a.brightness} min={-100} max={100} defaultValue={0} onChange={(v) => set('Brightness', (x) => (x.brightness = v))} />
        <Slider label="Contrast" value={a.contrast} min={-100} max={100} defaultValue={0} onChange={(v) => set('Contrast', (x) => (x.contrast = v))} />
      </Section>

      <Section title="Levels" defaultOpen={false}>
        <Slider label="Shadows in" value={a.levels.inBlack} min={0} max={254} defaultValue={0} onChange={(v) => set('Levels', (x) => (x.levels.inBlack = Math.min(v, x.levels.inWhite - 1)))} />
        <Slider label="Midtones" value={a.levels.gamma} min={0.1} max={3} step={0.01} defaultValue={1} onChange={(v) => set('Levels', (x) => (x.levels.gamma = v))} />
        <Slider label="Highlights in" value={a.levels.inWhite} min={1} max={255} defaultValue={255} onChange={(v) => set('Levels', (x) => (x.levels.inWhite = Math.max(v, x.levels.inBlack + 1)))} />
        <Slider label="Output black" value={a.levels.outBlack} min={0} max={255} defaultValue={0} onChange={(v) => set('Levels', (x) => (x.levels.outBlack = v))} />
        <Slider label="Output white" value={a.levels.outWhite} min={0} max={255} defaultValue={255} onChange={(v) => set('Levels', (x) => (x.levels.outWhite = v))} />
      </Section>

      <Section title="Curves" defaultOpen={false}>
        <CurvesEditor curves={a.curves} onChange={(c) => set('Curves', (x) => (x.curves = c))} />
      </Section>

      <Section title="Hue / Saturation">
        <Slider label="Hue" value={a.hue} min={-180} max={180} unit="°" defaultValue={0} onChange={(v) => set('Hue', (x) => (x.hue = v))} />
        <Slider label="Saturation" value={a.saturation} min={-100} max={100} defaultValue={0} onChange={(v) => set('Saturation', (x) => (x.saturation = v))} />
        <Slider label="Lightness" value={a.lightness} min={-100} max={100} defaultValue={0} onChange={(v) => set('Lightness', (x) => (x.lightness = v))} />
      </Section>

      <Section title="Color balance" defaultOpen={false}>
        <Segmented
          label="Tones"
          value={tone}
          onChange={setTone}
          options={[
            { value: 'shadows', label: 'Shadows' },
            { value: 'midtones', label: 'Midtones' },
            { value: 'highlights', label: 'Highlights' },
          ]}
        />
        <Slider label="Cyan ↔ Red" value={bal[0]} min={-100} max={100} defaultValue={0} onChange={(v) => setBal(0, v)} />
        <Slider label="Magenta ↔ Green" value={bal[1]} min={-100} max={100} defaultValue={0} onChange={(v) => setBal(1, v)} />
        <Slider label="Yellow ↔ Blue" value={bal[2]} min={-100} max={100} defaultValue={0} onChange={(v) => setBal(2, v)} />
      </Section>

      <Section title="Tint (photo filter)">
        <ColorField label="Tint color" value={a.tint.color} onChange={(v) => set('Tint', (x) => (x.tint.color = v))} />
        <Slider label="Amount" value={a.tint.amount} min={0} max={100} unit="%" defaultValue={0} onChange={(v) => set('Tint', (x) => (x.tint.amount = v))} />
        <div className="row">
          {[
            ['#7a4cff', 'Night purple'],
            ['#2f6bff', 'Moonlight blue'],
            ['#ff8c1a', 'Firelight'],
            ['#3dff7a', 'Witch green'],
          ].map(([c, name]) => (
            <button
              type="button"
              key={c}
              className="swatch"
              title={name}
              aria-label={`Tint ${name}`}
              style={{ background: c }}
              onClick={() => set('Tint', (x) => {
                x.tint.color = c;
                if (x.tint.amount === 0) x.tint.amount = 30;
              })}
            />
          ))}
        </div>
      </Section>
    </>
  );
}

/* ------------------------------------------------------------------ */
function EffectsTab({ layer }: { layer: Layer }) {
  const fx = layer.fx;
  const set = (label: string, fn: (f: Effects) => void) => up(layer, label, (l) => fn(l.fx));
  return (
    <>
      <div className="row end">
        <button
          type="button"
          className="btn small ghost"
          onClick={() =>
            up(layer, 'Reset effects', (l) => {
              const d = defaultEffects();
              l.fx = { ...d, key: l.fx.key, shrinkEdge: l.fx.shrinkEdge, softenEdge: l.fx.softenEdge, blur: l.fx.blur };
            })
          }
        >
          Reset effects
        </button>
      </div>
      <Section title="Outline" enabled={!!fx.outline?.enabled} onToggle={(v) => set('Outline', (f) => (f.outline = { ...(f.outline ?? defaultEffects().outline), enabled: v }))}>
        <p className="hint">A solid edge around the layer's shape — great with a glow for a magical aura.</p>
        <ColorField label="Color" value={fx.outline?.color ?? '#39ff88'} onChange={(v) => set('Outline', (f) => (f.outline = { ...(f.outline ?? defaultEffects().outline), color: v, enabled: true }))} />
        <Slider label="Size" value={fx.outline?.size ?? 6} min={1} max={60} unit="px" onChange={(v) => set('Outline', (f) => (f.outline = { ...(f.outline ?? defaultEffects().outline), size: v, enabled: true }))} />
        <Slider label="Opacity" value={Math.round((fx.outline?.opacity ?? 1) * 100)} min={0} max={100} unit="%" onChange={(v) => set('Outline', (f) => (f.outline = { ...(f.outline ?? defaultEffects().outline), opacity: v / 100, enabled: true }))} />
      </Section>
      <Section title="Color overlay" enabled={!!fx.overlay?.enabled} onToggle={(v) => set('Color overlay', (f) => (f.overlay = { ...(f.overlay ?? defaultEffects().overlay), enabled: v }))}>
        <p className="hint">Washes the whole layer in one color. Low amounts tint; 100% makes a solid silhouette.</p>
        <ColorField label="Color" value={fx.overlay?.color ?? '#7a4cff'} onChange={(v) => set('Color overlay', (f) => (f.overlay = { ...(f.overlay ?? defaultEffects().overlay), color: v, enabled: true }))} />
        <Slider label="Amount" value={Math.round((fx.overlay?.opacity ?? 0.5) * 100)} min={0} max={100} unit="%" onChange={(v) => set('Color overlay', (f) => (f.overlay = { ...(f.overlay ?? defaultEffects().overlay), opacity: v / 100, enabled: true }))} />
      </Section>
      <Section title="Rim light" enabled={fx.rim.enabled} onToggle={(v) => set('Rim light', (f) => (f.rim.enabled = v))}>
        <p className="hint">A glowing edge on the side facing a light — match it to the moon.</p>
        <ColorField label="Color" value={fx.rim.color} onChange={(v) => set('Rim light', (f) => { f.rim.color = v; f.rim.enabled = true; })} />
        <Slider label="Light angle" value={fx.rim.angle} min={-180} max={180} unit="°" onChange={(v) => set('Rim light', (f) => { f.rim.angle = v; f.rim.enabled = true; })} />
        <Slider label="Width" value={fx.rim.width} min={1} max={60} unit="px" onChange={(v) => set('Rim light', (f) => { f.rim.width = v; f.rim.enabled = true; })} />
        <Slider label="Softness" value={fx.rim.softness} min={0} max={40} unit="px" onChange={(v) => set('Rim light', (f) => { f.rim.softness = v; f.rim.enabled = true; })} />
        <Slider label="Opacity" value={Math.round(fx.rim.opacity * 100)} min={0} max={100} unit="%" onChange={(v) => set('Rim light', (f) => { f.rim.opacity = v / 100; f.rim.enabled = true; })} />
      </Section>
      <Section title="Outer glow" enabled={fx.glow.enabled} onToggle={(v) => set('Outer glow', (f) => (f.glow.enabled = v))}>
        <ColorField label="Color" value={fx.glow.color} onChange={(v) => set('Outer glow', (f) => { f.glow.color = v; f.glow.enabled = true; })} />
        <Slider label="Size" value={fx.glow.size} min={1} max={250} unit="px" onChange={(v) => set('Outer glow', (f) => { f.glow.size = v; f.glow.enabled = true; })} />
        <Slider label="Strength" value={fx.glow.strength} min={1} max={6} onChange={(v) => set('Outer glow', (f) => { f.glow.strength = v; f.glow.enabled = true; })} />
        <Slider label="Opacity" value={Math.round(fx.glow.opacity * 100)} min={0} max={100} unit="%" onChange={(v) => set('Outer glow', (f) => { f.glow.opacity = v / 100; f.glow.enabled = true; })} />
      </Section>
      <Section title="Drop shadow" enabled={fx.shadow.enabled} onToggle={(v) => set('Drop shadow', (f) => (f.shadow.enabled = v))}>
        <ColorField label="Color" value={fx.shadow.color} onChange={(v) => set('Drop shadow', (f) => { f.shadow.color = v; f.shadow.enabled = true; })} />
        <Slider label="Light angle" value={fx.shadow.angle} min={-180} max={180} unit="°" onChange={(v) => set('Drop shadow', (f) => { f.shadow.angle = v; f.shadow.enabled = true; })} />
        <Slider label="Distance" value={fx.shadow.distance} min={0} max={200} unit="px" onChange={(v) => set('Drop shadow', (f) => { f.shadow.distance = v; f.shadow.enabled = true; })} />
        <Slider label="Size" value={fx.shadow.size} min={0} max={200} unit="px" onChange={(v) => set('Drop shadow', (f) => { f.shadow.size = v; f.shadow.enabled = true; })} />
        <Slider label="Opacity" value={Math.round(fx.shadow.opacity * 100)} min={0} max={100} unit="%" onChange={(v) => set('Drop shadow', (f) => { f.shadow.opacity = v / 100; f.shadow.enabled = true; })} />
      </Section>
    </>
  );
}
