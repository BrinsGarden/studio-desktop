import { useCallback, useEffect, useRef } from 'react';
import { store, useStore } from '../store';
import { createCanvas, type Doc, type Layer } from '../engine/types';
import { docToLocal, hitTest, layerCorners, renderDoc, onFontsChanged } from '../engine/render';
import { Stroke, type StrokeMode } from '../engine/brush';
import { addImages, createSwirl } from '../actions';
import { addShape, drawAnts, ellipsePts, polyArea, rectPts, selectionMaskForLayer, simplify, type Pt } from '../engine/selection';
import { SWIRL_PRESETS } from '../engine/types';

interface View {
  zoom: number;
  panX: number;
  panY: number;
}

type Gesture =
  | { kind: 'pan'; sx: number; sy: number; px: number; py: number }
  | { kind: 'move'; key: string; dx: number; dy: number; id: string }
  | { kind: 'scale'; key: string; id: string; cx: number; cy: number; d0: number; s0: number }
  | { kind: 'rotate'; key: string; id: string; cx: number; cy: number; a0: number; r0: number }
  | { kind: 'stroke'; stroke: Stroke; layerId: string; target: 'canvas' | 'mask' }
  | { kind: 'select'; mode: 'lasso' | 'rect' | 'ellipse'; op: SelOp; start: Pt; pts: Pt[]; end: Pt }
  | { kind: 'swirl'; pts: Pt[] };

type SelOp = 'new' | 'add' | 'sub';

function shapeFor(g: { mode: 'lasso' | 'rect' | 'ellipse'; start: Pt; pts: Pt[]; end: Pt }): Pt[] {
  if (g.mode === 'rect') return rectPts(g.start, g.end);
  if (g.mode === 'ellipse') return ellipsePts(g.start, g.end);
  return g.pts;
}

const HANDLE = 7;

export function previewScale(doc: Doc, hq: boolean) {
  return Math.min(1, (hq ? 4200 : 2000) / Math.max(doc.width, doc.height));
}

export default function Viewport() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const compRef = useRef<HTMLCanvasElement>(createCanvas(1, 1));
  const view = useRef<View>({ zoom: 1, panX: 0, panY: 0 });
  const gesture = useRef<Gesture | null>(null);
  const pointer = useRef<{ x: number; y: number; inside: boolean }>({ x: 0, y: 0, inside: false });
  const spaceDown = useRef(false);
  const rafComp = useRef(0);
  const rafBlit = useRef(0);
  const docKey = useRef('');
  const checker = useRef<CanvasPattern | null>(null);
  /** In-progress polygon selection (click to add points). */
  const polyDraft = useRef<{ pts: Pt[]; op: SelOp } | null>(null);

  const doc = useStore((s) => s.doc);
  const rev = useStore((s) => s.rev);
  const tool = useStore((s) => s.tool);
  const previewHQ = useStore((s) => s.previewHQ);
  const showMask = useStore((s) => s.showMask);
  const selectedId = useStore((s) => s.selectedId);
  const brushSize = useStore((s) => s.brush.size);
  const selection = useStore((s) => s.selection);
  const selectMode = useStore((s) => s.selectMode);

  /* ---------- drawing ---------- */
  const blit = useCallback(() => {
    cancelAnimationFrame(rafBlit.current);
    rafBlit.current = requestAnimationFrame(() => {
      const c = canvasRef.current;
      const st = store.state;
      if (!c) return;
      const ctx = c.getContext('2d')!;
      const dpr = window.devicePixelRatio || 1;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, c.width, c.height);
      const d = st.doc;
      if (!d) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const { zoom, panX, panY } = view.current;
      const w = d.width * zoom;
      const h = d.height * zoom;
      // drop shadow + checkerboard
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(panX + 4, panY + 4, w, h);
      if (!checker.current) {
        const p = createCanvas(16, 16);
        const pc = p.getContext('2d')!;
        pc.fillStyle = '#3a3a40';
        pc.fillRect(0, 0, 16, 16);
        pc.fillStyle = '#2c2c31';
        pc.fillRect(0, 0, 8, 8);
        pc.fillRect(8, 8, 8, 8);
        checker.current = ctx.createPattern(p, 'repeat');
      }
      ctx.fillStyle = checker.current!;
      ctx.fillRect(panX, panY, w, h);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(compRef.current, panX, panY, w, h);

      // overlay
      const sel = d.layers.find((l) => l.id === st.selectedId);
      if (sel && st.tool === 'move' && sel.kind !== 'adjust' && sel.visible) {
        const pts = layerCorners(sel, d).map((p) => ({ x: panX + p.x * zoom, y: panY + p.y * zoom }));
        ctx.strokeStyle = '#b98aff';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
        ctx.closePath();
        ctx.stroke();
        const top = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
        const rot = rotateHandle(pts);
        ctx.beginPath();
        ctx.moveTo(top.x, top.y);
        ctx.lineTo(rot.x, rot.y);
        ctx.stroke();
        ctx.fillStyle = '#fff';
        for (const p of pts) {
          ctx.fillRect(p.x - HANDLE / 2, p.y - HANDLE / 2, HANDLE, HANDLE);
          ctx.strokeRect(p.x - HANDLE / 2, p.y - HANDLE / 2, HANDLE, HANDLE);
        }
        ctx.beginPath();
        ctx.arc(rot.x, rot.y, HANDLE / 2 + 1, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      if ((st.tool === 'brush' || st.tool === 'eraser') && pointer.current.inside) {
        const r = (st.brush.size / 2) * zoom;
        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(0,0,0,0.8)';
        ctx.beginPath();
        ctx.arc(pointer.current.x, pointer.current.y, r + 1, 0, Math.PI * 2);
        ctx.stroke();
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.beginPath();
        ctx.arc(pointer.current.x, pointer.current.y, r, 0, Math.PI * 2);
        ctx.stroke();
      }

      // selection outlines (marching ants)
      const toScreen = (p: Pt) => ({ x: panX + p.x * zoom, y: panY + p.y * zoom });
      const ants = (performance.now() / 60) % 8;
      if (st.selection) drawAnts(ctx, st.selection.shapes.map((s) => s.pts.map(toScreen)), true, ants);
      const g = gesture.current;
      if (g?.kind === 'select') drawAnts(ctx, [shapeFor(g).map(toScreen)], g.mode !== 'lasso', ants);
      const draft = polyDraft.current;
      if (draft) {
        const pts = draft.pts.map(toScreen);
        if (pointer.current.inside) pts.push({ x: pointer.current.x, y: pointer.current.y });
        drawAnts(ctx, [pts], false, ants);
        ctx.fillStyle = '#fff';
        ctx.strokeStyle = '#000';
        const f = pts[0];
        ctx.beginPath();
        ctx.arc(f.x, f.y, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      if (g?.kind === 'swirl' && g.pts.length > 1) {
        const pal = SWIRL_PRESETS.find((p) => p.id === st.swirl.preset)?.palette ?? ['#b04cff'];
        ctx.save();
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.shadowColor = pal[0];
        ctx.shadowBlur = 12;
        ctx.strokeStyle = pal[0];
        ctx.lineWidth = 3;
        ctx.beginPath();
        g.pts.map(toScreen).forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
        ctx.stroke();
        ctx.restore();
      }
    });
  }, []);

  const recomposite = useCallback(() => {
    cancelAnimationFrame(rafComp.current);
    rafComp.current = requestAnimationFrame(() => {
      const st = store.state;
      const d = st.doc;
      if (!d) {
        blit();
        return;
      }
      const k = previewScale(d, st.previewHQ);
      const comp = compRef.current;
      const W = Math.max(1, Math.round(d.width * k));
      const H = Math.max(1, Math.round(d.height * k));
      if (comp.width !== W || comp.height !== H) {
        comp.width = W;
        comp.height = H;
      }
      renderDoc(d, comp, comp.width / d.width, {
        background: true,
        showMaskOf: st.showMask ? st.selectedId : null,
      });
      blit();
    });
  }, [blit]);

  const fit = useCallback(() => {
    const d = store.state.doc;
    const wrap = wrapRef.current;
    if (!d || !wrap) return;
    const r = wrap.getBoundingClientRect();
    const zoom = Math.min((r.width - 60) / d.width, (r.height - 60) / d.height);
    view.current = { zoom, panX: (r.width - d.width * zoom) / 2, panY: (r.height - d.height * zoom) / 2 };
    window.dispatchEvent(new CustomEvent('sd:zoom', { detail: zoom }));
    blit();
  }, [blit]);

  const setZoom = useCallback(
    (zoom: number, cx?: number, cy?: number) => {
      const wrap = wrapRef.current;
      if (!wrap) return;
      const r = wrap.getBoundingClientRect();
      const x = cx ?? r.width / 2;
      const y = cy ?? r.height / 2;
      const v = view.current;
      const z = Math.min(32, Math.max(0.02, zoom));
      const docX = (x - v.panX) / v.zoom;
      const docY = (y - v.panY) / v.zoom;
      view.current = { zoom: z, panX: x - docX * z, panY: y - docY * z };
      window.dispatchEvent(new CustomEvent('sd:zoom', { detail: z }));
      blit();
    },
    [blit],
  );

  // resize canvas to container
  useEffect(() => {
    const wrap = wrapRef.current!;
    const ro = new ResizeObserver(() => {
      const c = canvasRef.current!;
      const r = wrap.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      c.width = Math.round(r.width * dpr);
      c.height = Math.round(r.height * dpr);
      c.style.width = `${r.width}px`;
      c.style.height = `${r.height}px`;
      blit();
    });
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [blit]);

  // fit when a different document is opened
  useEffect(() => {
    const key = doc ? `${doc.width}x${doc.height}:${doc.name}` : '';
    if (key && key !== docKey.current) {
      docKey.current = key;
      requestAnimationFrame(fit);
    }
  }, [doc, fit]);

  useEffect(() => {
    recomposite();
  }, [rev, doc, previewHQ, showMask, selectedId, recomposite]);

  useEffect(() => {
    blit();
  }, [tool, brushSize, selection, blit]);

  // animate marching ants while something is selected
  useEffect(() => {
    if (!selection && tool !== 'select') return;
    const id = window.setInterval(() => {
      if (store.state.selection || polyDraft.current || gesture.current) blit();
    }, 140);
    return () => window.clearInterval(id);
  }, [selection, tool, blit]);

  // leaving the select tool drops an unfinished polygon
  useEffect(() => {
    if (tool !== 'select' || selectMode !== 'polygon') polyDraft.current = null;
  }, [tool, selectMode]);

  // Enter closes a polygon, Escape cancels it (or drops the selection)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e)) return;
      if (e.key === 'Escape') {
        if (polyDraft.current) polyDraft.current = null;
        else if (store.state.selection) store.set({ selection: null });
        if (store.state.swirlRedrawId) store.set({ swirlRedrawId: null });
        blit();
      } else if (e.key === 'Enter' && polyDraft.current) {
        commitPolygon();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blit]);

  useEffect(() => onFontsChanged(() => recomposite()), [recomposite]);

  // external commands
  useEffect(() => {
    const onFit = () => fit();
    const onActual = () => setZoom(1);
    const onZoomBy = (e: Event) => setZoom(view.current.zoom * (e as CustomEvent).detail);
    window.addEventListener('sd:fit', onFit);
    window.addEventListener('sd:actual', onActual);
    window.addEventListener('sd:zoomby', onZoomBy);
    return () => {
      window.removeEventListener('sd:fit', onFit);
      window.removeEventListener('sd:actual', onActual);
      window.removeEventListener('sd:zoomby', onZoomBy);
    };
  }, [fit, setZoom]);

  // space-to-pan
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !isTyping(e)) {
        spaceDown.current = true;
        if (wrapRef.current) wrapRef.current.dataset.pan = '1';
        e.preventDefault();
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        spaceDown.current = false;
        if (wrapRef.current) delete wrapRef.current.dataset.pan;
      }
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  /* ---------- pointer handling ---------- */
  const toDoc = (sx: number, sy: number) => {
    const v = view.current;
    return { x: (sx - v.panX) / v.zoom, y: (sy - v.panY) / v.zoom };
  };

  const local = (e: React.PointerEvent | React.WheelEvent) => {
    const r = wrapRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const st = store.state;
    const d = st.doc;
    if (!d) return;
    (e.target as Element).setPointerCapture(e.pointerId);
    const p = local(e);
    const v = view.current;
    if (st.tool === 'hand' || spaceDown.current || e.button === 1) {
      gesture.current = { kind: 'pan', sx: p.x, sy: p.y, px: v.panX, py: v.panY };
      return;
    }
    if (e.button !== 0) return;
    const dp = toDoc(p.x, p.y);
    const gkey = `g${Date.now()}`;

    if (st.tool === 'eyedropper') {
      pickColor(dp.x, dp.y);
      return;
    }

    if (st.tool === 'move') {
      let sel = d.layers.find((l) => l.id === st.selectedId) ?? null;
      if (sel && sel.kind !== 'adjust' && sel.visible) {
        const pts = layerCorners(sel, d).map((q) => ({ x: v.panX + q.x * v.zoom, y: v.panY + q.y * v.zoom }));
        const rot = rotateHandle(pts);
        const c = { x: sel.x, y: sel.y };
        if (Math.hypot(p.x - rot.x, p.y - rot.y) <= HANDLE + 3) {
          gesture.current = { kind: 'rotate', key: gkey, id: sel.id, cx: c.x, cy: c.y, a0: Math.atan2(dp.y - c.y, dp.x - c.x), r0: sel.rotation };
          return;
        }
        if (pts.some((q) => Math.abs(q.x - p.x) <= HANDLE + 2 && Math.abs(q.y - p.y) <= HANDLE + 2)) {
          gesture.current = { kind: 'scale', key: gkey, id: sel.id, cx: c.x, cy: c.y, d0: Math.max(1, Math.hypot(dp.x - c.x, dp.y - c.y)), s0: sel.scale };
          return;
        }
      }
      if (st.autoSelect) {
        const hit = [...d.layers].reverse().find((l) => hitTest(l, d, dp.x, dp.y));
        if (hit && hit.id !== st.selectedId) {
          store.set({ selectedId: hit.id, editMask: false, showMask: false });
          sel = hit;
        }
      }
      if (sel && sel.kind !== 'adjust') {
        gesture.current = { kind: 'move', key: gkey, id: sel.id, dx: dp.x - sel.x, dy: dp.y - sel.y };
      }
      return;
    }

    if (st.tool === 'select') {
      const op: SelOp = e.shiftKey ? 'add' : e.altKey ? 'sub' : 'new';
      if (st.selectMode === 'polygon') {
        const draft = polyDraft.current;
        if (!draft) {
          polyDraft.current = { pts: [dp], op };
        } else {
          const first = draft.pts[0];
          const close = Math.hypot((first.x - dp.x) * v.zoom, (first.y - dp.y) * v.zoom) < 10;
          if (close && draft.pts.length >= 3) commitPolygon();
          else draft.pts.push(dp);
        }
        blit();
        return;
      }
      gesture.current = { kind: 'select', mode: st.selectMode, op, start: dp, pts: [dp], end: dp };
      return;
    }

    if (st.tool === 'swirl') {
      gesture.current = { kind: 'swirl', pts: [dp] };
      return;
    }

    if (st.tool === 'brush' || st.tool === 'eraser') {
      const sel = d.layers.find((l) => l.id === st.selectedId);
      if (!sel) {
        store.toast('Select a layer to paint on');
        return;
      }
      const res = paintTarget(sel, st.editMask);
      if (typeof res === 'string') {
        store.toast(res);
        return;
      }
      const lp = docToLocal(sel, d, dp.x, dp.y);
      const diameter = st.brush.size / (sel.kind === 'adjust' ? 1 : sel.scale);
      let mode: StrokeMode;
      if (res.target === 'mask') {
        const hide = st.maskPaint === 'hide';
        mode = st.tool === 'brush' ? (hide ? 'hide' : 'reveal') : hide ? 'reveal' : 'hide';
      } else {
        mode = st.tool === 'brush' ? 'paint' : 'erase';
      }
      const clip = st.selection ? selectionMaskForLayer(st.selection, sel, d, st.feather) : null;
      const stroke = new Stroke(res.canvas, mode, st.brush.color, diameter, st.brush.hardness, st.brush.opacity, clip);
      stroke.to(lp.x, lp.y);
      gesture.current = { kind: 'stroke', stroke, layerId: sel.id, target: res.target };
      if (res.target === 'canvas') sel.version++;
      recomposite();
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const p = local(e);
    pointer.current = { x: p.x, y: p.y, inside: true };
    const g = gesture.current;
    const st = store.state;
    const d = st.doc;
    if (!g || !d) {
      if (st.tool === 'brush' || st.tool === 'eraser' || polyDraft.current) blit();
      return;
    }
    const dp = toDoc(p.x, p.y);
    switch (g.kind) {
      case 'pan':
        view.current.panX = g.px + (p.x - g.sx);
        view.current.panY = g.py + (p.y - g.sy);
        blit();
        break;
      case 'move': {
        let nx = dp.x - g.dx;
        let ny = dp.y - g.dy;
        if (e.shiftKey) {
          // snap center to canvas center lines
          const snap = 12 / view.current.zoom;
          if (Math.abs(nx - d.width / 2) < snap) nx = d.width / 2;
          if (Math.abs(ny - d.height / 2) < snap) ny = d.height / 2;
        }
        store.updateLayer(g.id, (l) => {
          l.x = nx;
          l.y = ny;
        }, 'Move', g.key);
        break;
      }
      case 'scale': {
        const dist = Math.hypot(dp.x - g.cx, dp.y - g.cy);
        const s = Math.max(0.01, (g.s0 * dist) / g.d0);
        store.updateLayer(g.id, (l) => {
          l.scale = s;
        }, 'Scale', g.key);
        break;
      }
      case 'rotate': {
        const a = Math.atan2(dp.y - g.cy, dp.x - g.cx);
        let r = g.r0 + ((a - g.a0) * 180) / Math.PI;
        if (e.shiftKey) r = Math.round(r / 15) * 15;
        r = ((r % 360) + 540) % 360 - 180;
        store.updateLayer(g.id, (l) => {
          l.rotation = r;
        }, 'Rotate', g.key);
        break;
      }
      case 'select': {
        g.end = dp;
        const last = g.pts[g.pts.length - 1];
        if (Math.hypot(dp.x - last.x, dp.y - last.y) * view.current.zoom >= 2) g.pts.push(dp);
        blit();
        break;
      }
      case 'swirl': {
        const last = g.pts[g.pts.length - 1];
        if (Math.hypot(dp.x - last.x, dp.y - last.y) * view.current.zoom >= 3) g.pts.push(dp);
        blit();
        break;
      }
      case 'stroke': {
        const sel = d.layers.find((l) => l.id === g.layerId);
        if (!sel) break;
        const events = (e.nativeEvent as PointerEvent).getCoalescedEvents?.() ?? [e.nativeEvent];
        const r = wrapRef.current!.getBoundingClientRect();
        for (const ev of events) {
          const q = toDoc(ev.clientX - r.left, ev.clientY - r.top);
          const lp = docToLocal(sel, d, q.x, q.y);
          g.stroke.to(lp.x, lp.y);
        }
        if (g.target === 'canvas') sel.version++;
        recomposite();
        break;
      }
    }
  };

  const commitSelection = (pts: Pt[], op: SelOp) => {
    const st = store.state;
    const minArea = 9 / (view.current.zoom * view.current.zoom);
    if (pts.length < 3 || polyArea(pts) < minArea) {
      if (op === 'new') store.set({ selection: null });
      blit();
      return;
    }
    const shape = { op: (op === 'sub' ? 'sub' : 'add') as 'add' | 'sub', pts: simplify(pts, 0.75 / view.current.zoom) };
    store.set({ selection: addShape(st.selection, shape, op === 'new') });
  };

  function commitPolygon() {
    const draft = polyDraft.current;
    polyDraft.current = null;
    if (draft) commitSelection(draft.pts, draft.op);
    blit();
  }

  const onPointerUp = () => {
    const g = gesture.current;
    gesture.current = null;
    if (g?.kind === 'select') {
      commitSelection(shapeFor(g), g.op);
      return;
    }
    if (g?.kind === 'swirl') {
      const len = g.pts.reduce((a, p, i) => (i ? a + Math.hypot(p.x - g.pts[i - 1].x, p.y - g.pts[i - 1].y) : 0), 0);
      if (len * view.current.zoom < 15) {
        store.toast('Drag along a path to draw a swirl');
      } else {
        createSwirl(simplify(g.pts, 4 / view.current.zoom));
      }
      blit();
      return;
    }
    if (g?.kind === 'stroke') {
      const patch = g.stroke.finish();
      if (patch) store.pushPixels(g.layerId, g.target, patch, g.target === 'mask' ? 'Paint mask' : 'Paint');
    }
  };

  const onWheel = (e: React.WheelEvent) => {
    if (!store.state.doc) return;
    const p = local(e);
    if (e.shiftKey) {
      view.current.panX -= e.deltaY;
      blit();
      return;
    }
    const factor = Math.pow(1.0015, -e.deltaY * (e.deltaMode === 1 ? 30 : 1));
    setZoom(view.current.zoom * factor, p.x, p.y);
  };

  function pickColor(x: number, y: number) {
    const d = store.state.doc!;
    const comp = compRef.current;
    const k = comp.width / d.width;
    const px = Math.floor(x * k);
    const py = Math.floor(y * k);
    if (px < 0 || py < 0 || px >= comp.width || py >= comp.height) return;
    const [r, g, b] = comp.getContext('2d')!.getImageData(px, py, 1, 1).data;
    const hex = '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
    store.set({ brush: { ...store.state.brush, color: hex } });
    navigator.clipboard?.writeText(hex).catch(() => {});
    store.toast(`Picked ${hex} (copied)`);
  }

  // drag & drop images
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    addImages(Array.from(e.dataTransfer.files));
  };

  const cursor =
    tool === 'hand' ? 'grab' : tool === 'move' ? 'move' : tool === 'eyedropper' || tool === 'select' || tool === 'swirl' ? 'crosshair' : 'none';

  return (
    <div
      ref={wrapRef}
      className="viewport"
      style={{ cursor }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
    >
      <canvas
        ref={canvasRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={() => {
          pointer.current.inside = false;
          blit();
        }}
        onWheel={onWheel}
        onDoubleClick={() => polyDraft.current && commitPolygon()}
        aria-label="Canvas"
      />
      {!doc && (
        <div className="viewport-empty">
          <p>Drop images here, or start from File › New.</p>
        </div>
      )}
    </div>
  );
}

function rotateHandle(pts: { x: number; y: number }[]) {
  const top = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
  const bottom = { x: (pts[3].x + pts[2].x) / 2, y: (pts[3].y + pts[2].y) / 2 };
  const dx = top.x - bottom.x;
  const dy = top.y - bottom.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: top.x + (dx / len) * 28, y: top.y + (dy / len) * 28 };
}

function paintTarget(l: Layer, editMask: boolean): { canvas: HTMLCanvasElement; target: 'canvas' | 'mask' } | string {
  if (editMask || l.kind === 'adjust') {
    if (!l.mask) return 'Add a mask to this layer first (mask button in the Layers panel)';
    return { canvas: l.mask, target: 'mask' };
  }
  if (l.kind !== 'image' || !l.canvas) {
    return l.mask
      ? 'Click the mask thumbnail to paint the mask, or Rasterize this layer to paint pixels'
      : 'Add a mask to hide parts, or Rasterize this layer to paint on it';
  }
  return { canvas: l.canvas, target: 'canvas' };
}

function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement;
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

