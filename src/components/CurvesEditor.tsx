import { useRef, useState } from 'react';
import { curveLut } from '../engine/adjust';
import type { CurvePoint, Curves } from '../engine/types';
import { Segmented } from './ui';

const SIZE = 220;
const CH_COLOR: Record<keyof Curves, string> = { rgb: '#e8e8ee', r: '#ff5a5a', g: '#5aff8a', b: '#5aa2ff' };

export function CurvesEditor(props: { curves: Curves; onChange: (c: Curves) => void }) {
  const [ch, setCh] = useState<keyof Curves>('rgb');
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<number | null>(null);
  const pts = props.curves[ch];

  const toVal = (e: React.PointerEvent): [number, number] => {
    const r = svgRef.current!.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * 255;
    const y = 255 - ((e.clientY - r.top) / r.height) * 255;
    return [Math.round(x), Math.round(y)];
  };

  const setPts = (next: CurvePoint[]) => props.onChange({ ...props.curves, [ch]: next });

  const lut = curveLut(pts);
  const path = Array.from(lut)
    .map((v, i) => `${i === 0 ? 'M' : 'L'}${(i / 255) * SIZE},${SIZE - (v / 255) * SIZE}`)
    .join(' ');

  const onDown = (e: React.PointerEvent) => {
    const [x, y] = toVal(e);
    const hitR = (8 / SIZE) * 255;
    let idx = pts.findIndex((p) => Math.hypot(p[0] - x, p[1] - y) < hitR);
    if (idx < 0) {
      const next = [...pts, [x, Math.max(0, Math.min(255, lut[Math.max(0, Math.min(255, x))]))] as CurvePoint].sort(
        (a, b) => a[0] - b[0],
      );
      idx = next.findIndex((p) => p[0] === x);
      setPts(next);
    }
    drag.current = idx;
    (e.target as Element).setPointerCapture(e.pointerId);
  };

  const onMove = (e: React.PointerEvent) => {
    const i = drag.current;
    if (i === null) return;
    let [x, y] = toVal(e);
    const next = pts.map((p) => [...p] as CurvePoint);
    const isEnd = i === 0 || i === next.length - 1;
    // drag an interior point far outside to delete it
    if (!isEnd && (y < -40 || y > 295)) {
      next.splice(i, 1);
      drag.current = null;
      setPts(next);
      return;
    }
    const lo = i > 0 ? next[i - 1][0] + 1 : 0;
    const hi = i < next.length - 1 ? next[i + 1][0] - 1 : 255;
    x = Math.max(lo, Math.min(hi, x));
    y = Math.max(0, Math.min(255, y));
    next[i] = [x, y];
    setPts(next);
  };

  return (
    <div className="curves">
      <Segmented
        label="Curve channel"
        value={ch}
        onChange={setCh}
        options={[
          { value: 'rgb', label: 'RGB' },
          { value: 'r', label: 'Red' },
          { value: 'g', label: 'Green' },
          { value: 'b', label: 'Blue' },
        ]}
      />
      <svg
        ref={svgRef}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        role="img"
        aria-label="Curves graph: click to add a point, drag to bend, drag a point off the graph to remove it"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={() => (drag.current = null)}
      >
        <rect width={SIZE} height={SIZE} fill="#141417" />
        {[1, 2, 3].map((i) => (
          <g key={i} stroke="#2e2e35" strokeWidth="1">
            <line x1={(SIZE / 4) * i} y1="0" x2={(SIZE / 4) * i} y2={SIZE} />
            <line y1={(SIZE / 4) * i} x1="0" y2={(SIZE / 4) * i} x2={SIZE} />
          </g>
        ))}
        <line x1="0" y1={SIZE} x2={SIZE} y2="0" stroke="#3a3a42" strokeDasharray="4 4" />
        <path d={path} fill="none" stroke={CH_COLOR[ch]} strokeWidth="2" />
        {pts.map((p, i) => (
          <circle
            key={i}
            cx={(p[0] / 255) * SIZE}
            cy={SIZE - (p[1] / 255) * SIZE}
            r="5"
            fill="#141417"
            stroke={CH_COLOR[ch]}
            strokeWidth="2"
          />
        ))}
      </svg>
      <div className="row">
        <button
          type="button"
          className="btn small"
          onClick={() =>
            setPts([
              [0, 0],
              [255, 255],
            ])
          }
        >
          Reset {ch === 'rgb' ? 'RGB' : ch.toUpperCase()}
        </button>
        <button
          type="button"
          className="btn small"
          title="Gentle S-curve for more contrast"
          onClick={() =>
            setPts([
              [0, 0],
              [64, 50],
              [192, 206],
              [255, 255],
            ])
          }
        >
          S-curve
        </button>
        <button
          type="button"
          className="btn small"
          title="Lift the blacks for a faded, foggy look"
          onClick={() =>
            setPts([
              [0, 28],
              [128, 124],
              [255, 245],
            ])
          }
        >
          Fade
        </button>
      </div>
    </div>
  );
}
