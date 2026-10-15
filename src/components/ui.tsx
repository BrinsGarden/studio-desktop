import { useState, type ReactNode } from 'react';

export function Slider(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  defaultValue?: number;
  onChange: (v: number) => void;
}) {
  const { label, value, min, max, step = 1, unit = '', defaultValue, onChange } = props;
  const id = `s-${label.replace(/\W+/g, '-')}-${min}-${max}`;
  const shown = step < 1 ? Number(value.toFixed(2)) : Math.round(value);
  return (
    <div className="slider">
      <label
        htmlFor={id}
        title={defaultValue !== undefined ? 'Double-click to reset' : undefined}
        onDoubleClick={() => defaultValue !== undefined && onChange(defaultValue)}
      >
        {label}
      </label>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="slider-num">
        <input
          type="number"
          aria-label={`${label} value`}
          value={shown}
          step={step}
          min={min}
          max={max}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (!Number.isNaN(v)) onChange(Math.min(max, Math.max(min, v)));
          }}
        />
        {unit && <em>{unit}</em>}
      </span>
    </div>
  );
}

export function ColorField(props: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="color-field">
      <span>{props.label}</span>
      <input type="color" value={props.value} onChange={(e) => props.onChange(e.target.value)} />
      <code>{props.value}</code>
    </label>
  );
}

export function Section(props: {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
  right?: ReactNode;
  enabled?: boolean;
  onToggle?: (v: boolean) => void;
}) {
  const [open, setOpen] = useState(props.defaultOpen ?? true);
  return (
    <section className={`section ${open ? 'open' : ''}`}>
      <header>
        <button type="button" className="section-head" onClick={() => setOpen(!open)} aria-expanded={open}>
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <path d={open ? 'M3 6l5 5 5-5' : 'M6 3l5 5-5 5'} fill="none" stroke="currentColor" strokeWidth="2" />
          </svg>
          {props.title}
        </button>
        {props.onToggle && (
          <label className="switch" title={props.enabled ? 'Turn off' : 'Turn on'}>
            <input type="checkbox" checked={!!props.enabled} onChange={(e) => {
                props.onToggle!(e.target.checked);
                if (e.target.checked) setOpen(true);
              }}
            />
            <span />
            <span className="sr-only">{props.title} on</span>
          </label>
        )}
        {props.right}
      </header>
      {open && <div className="section-body">{props.children}</div>}
    </section>
  );
}

export function Select<T extends string>(props: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <label className="field">
      <span>{props.label}</span>
      <select value={props.value} onChange={(e) => props.onChange(e.target.value as T)}>
        {props.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function Segmented<T extends string>(props: {
  label?: string;
  value: T;
  options: { value: T; label: string; title?: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="segmented" role="group" aria-label={props.label}>
      {props.options.map((o) => (
        <button
          type="button"
          key={o.value}
          title={o.title}
          className={o.value === props.value ? 'on' : ''}
          aria-pressed={o.value === props.value}
          onClick={() => props.onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
