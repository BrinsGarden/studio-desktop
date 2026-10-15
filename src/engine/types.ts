export type BlendMode =
  | 'source-over'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'darken'
  | 'lighten'
  | 'color-dodge'
  | 'color-burn'
  | 'hard-light'
  | 'soft-light'
  | 'difference'
  | 'exclusion'
  | 'hue'
  | 'saturation'
  | 'color'
  | 'luminosity';

export const BLEND_MODES: { value: BlendMode; label: string }[] = [
  { value: 'source-over', label: 'Normal' },
  { value: 'multiply', label: 'Multiply' },
  { value: 'screen', label: 'Screen' },
  { value: 'overlay', label: 'Overlay' },
  { value: 'soft-light', label: 'Soft Light' },
  { value: 'hard-light', label: 'Hard Light' },
  { value: 'darken', label: 'Darken' },
  { value: 'lighten', label: 'Lighten' },
  { value: 'color-dodge', label: 'Color Dodge' },
  { value: 'color-burn', label: 'Color Burn' },
  { value: 'difference', label: 'Difference' },
  { value: 'exclusion', label: 'Exclusion' },
  { value: 'hue', label: 'Hue' },
  { value: 'saturation', label: 'Saturation' },
  { value: 'color', label: 'Color' },
  { value: 'luminosity', label: 'Luminosity' },
];

/** A curve point: [input, output], both 0..255. */
export type CurvePoint = [number, number];

export interface Curves {
  rgb: CurvePoint[];
  r: CurvePoint[];
  g: CurvePoint[];
  b: CurvePoint[];
}

export interface Levels {
  inBlack: number;
  inWhite: number;
  gamma: number;
  outBlack: number;
  outWhite: number;
}

/** Cyan-Red, Magenta-Green, Yellow-Blue, each -100..100 */
export type BalanceTriple = [number, number, number];

export interface Adjustments {
  brightness: number;
  contrast: number;
  levels: Levels;
  curves: Curves;
  hue: number;
  saturation: number;
  lightness: number;
  balance: { shadows: BalanceTriple; midtones: BalanceTriple; highlights: BalanceTriple };
  tint: { color: string; amount: number };
  match: { layerId: string | null; strength: number };
}

export interface Effects {
  blur: number;
  /** Make one background color transparent (e.g. a cutout shot on black). */
  key: { enabled: boolean; color: string; tolerance: number; softness: number };
  shrinkEdge: number;
  softenEdge: number;
  shadow: { enabled: boolean; color: string; opacity: number; angle: number; distance: number; size: number };
  glow: { enabled: boolean; color: string; opacity: number; size: number; strength: number };
  rim: { enabled: boolean; color: string; opacity: number; angle: number; width: number; softness: number };
  outline: { enabled: boolean; color: string; size: number; opacity: number };
  overlay: { enabled: boolean; color: string; opacity: number };
}

/** A glowing ribbon swirl drawn along a path. Points are relative to the path's center. */
export interface SwirlProps {
  points: [number, number][];
  palette: string[];
  width: number;
  strands: number;
  wraps: number;
  amplitude: number;
  glow: number;
  sparkles: number;
  /** 0..1 — how much the "behind" half of each loop fades, for a 3D wrap look. */
  depth: number;
  /** 0..0.5 — fraction of the length that tapers in/out at each end. */
  taper: number;
  seed: number;
}

export const SWIRL_PRESETS: { id: string; label: string; palette: string[] }[] = [
  { id: 'witchy', label: 'Witchy', palette: ['#b04cff', '#ff3df2', '#39ff88'] },
  { id: 'rainbow', label: 'Rainbow', palette: ['#ff3b3b', '#ffb13b', '#fff23b', '#3bff6e', '#3bc4ff', '#a83bff'] },
  { id: 'fire', label: 'Fire', palette: ['#ff2a00', '#ff8c1a', '#ffe066'] },
  { id: 'toxic', label: 'Toxic', palette: ['#39ff14', '#d6ff3b', '#2affc8'] },
  { id: 'ice', label: 'Ice', palette: ['#7af0ff', '#3b8cff', '#e0f7ff'] },
  { id: 'blood', label: 'Blood moon', palette: ['#8b0000', '#ff2a2a', '#ff9a3c'] },
];

export interface TextProps {
  text: string;
  font: string;
  size: number;
  weight: number;
  italic: boolean;
  letterSpacing: number;
  lineHeight: number;
  align: 'left' | 'center' | 'right';
  fillType: 'solid' | 'gradient';
  color: string;
  color2: string;
  gradientDir: 'horizontal' | 'vertical';
  strokeColor: string;
  strokeWidth: number;
}

export interface FillProps {
  type: 'solid' | 'linear' | 'radial' | 'fog';
  color1: string;
  alpha1: number;
  color2: string;
  alpha2: number;
  angle: number;
  /** fog only: how far up the page it reaches (0..1) */
  fogHeight?: number;
  /** fog only: how wispy / broken up (0..1) */
  wisp?: number;
  seed?: number;
}

export type LayerKind = 'image' | 'text' | 'fill' | 'adjust' | 'swirl';

export interface Layer {
  id: string;
  kind: LayerKind;
  name: string;
  visible: boolean;
  opacity: number;
  blend: BlendMode;
  /** Center of the layer in document pixels. */
  x: number;
  y: number;
  scale: number;
  rotation: number;
  flipX: boolean;
  flipY: boolean;
  /** Pixel source for image layers (mutable; bump `version` after painting). */
  canvas: HTMLCanvasElement | null;
  /** Layer mask in layer-local (source) space; opaque = visible. */
  mask: HTMLCanvasElement | null;
  maskEnabled: boolean;
  adj: Adjustments;
  fx: Effects;
  text?: TextProps;
  fill?: FillProps;
  swirl?: SwirlProps;
  /** Bumped whenever the pixels in `canvas` change. */
  version: number;
}

export interface Doc {
  width: number;
  height: number;
  dpi: number;
  name: string;
  background: string;
  layers: Layer[]; // bottom -> top
}

export const IDENTITY_CURVE: CurvePoint[] = [
  [0, 0],
  [255, 255],
];

export function defaultAdjustments(): Adjustments {
  return {
    brightness: 0,
    contrast: 0,
    levels: { inBlack: 0, inWhite: 255, gamma: 1, outBlack: 0, outWhite: 255 },
    curves: {
      rgb: IDENTITY_CURVE.map((p) => [...p] as CurvePoint),
      r: IDENTITY_CURVE.map((p) => [...p] as CurvePoint),
      g: IDENTITY_CURVE.map((p) => [...p] as CurvePoint),
      b: IDENTITY_CURVE.map((p) => [...p] as CurvePoint),
    },
    hue: 0,
    saturation: 0,
    lightness: 0,
    balance: { shadows: [0, 0, 0], midtones: [0, 0, 0], highlights: [0, 0, 0] },
    tint: { color: '#ff8c1a', amount: 0 },
    match: { layerId: null, strength: 70 },
  };
}

export function defaultEffects(): Effects {
  return {
    blur: 0,
    key: { enabled: false, color: '#000000', tolerance: 12, softness: 8 },
    shrinkEdge: 0,
    softenEdge: 0,
    shadow: { enabled: false, color: '#000000', opacity: 0.6, angle: 120, distance: 12, size: 24 },
    glow: { enabled: false, color: '#b04cff', opacity: 0.8, size: 30, strength: 2 },
    rim: { enabled: false, color: '#ff9a3c', opacity: 0.8, angle: 45, width: 6, softness: 6 },
    outline: { enabled: false, color: '#39ff88', size: 6, opacity: 1 },
    overlay: { enabled: false, color: '#7a4cff', opacity: 0.5 },
  };
}

export function defaultText(): TextProps {
  return {
    text: 'Your Text',
    font: 'Creepster',
    size: 200,
    weight: 400,
    italic: false,
    letterSpacing: 0,
    lineHeight: 1.1,
    align: 'center',
    fillType: 'solid',
    color: '#b04cff',
    color2: '#7dff4a',
    gradientDir: 'horizontal',
    strokeColor: '#1a0526',
    strokeWidth: 0,
  };
}

export function defaultFill(): FillProps {
  return { type: 'linear', color1: '#000000', alpha1: 0, color2: '#000000', alpha2: 0.85, angle: 90 };
}

export const FONTS = [
  'Creepster',
  'Nosifer',
  'Butcherman',
  'Metal Mania',
  'Eater',
  'Griffy',
  'Cinzel Decorative',
  'Bebas Neue',
  'Anton',
  'Oswald',
  'Montserrat',
  'Playfair Display',
  'Arial',
  'Georgia',
  'Impact',
];

let idCounter = 0;
export function newId(): string {
  idCounter += 1;
  return `L${Date.now().toString(36)}${idCounter}`;
}

export function makeLayer(kind: LayerKind, name: string, init: Partial<Layer> = {}): Layer {
  return {
    id: newId(),
    kind,
    name,
    visible: true,
    opacity: 1,
    blend: 'source-over',
    x: 0,
    y: 0,
    scale: 1,
    rotation: 0,
    flipX: false,
    flipY: false,
    canvas: null,
    mask: null,
    maskEnabled: true,
    adj: defaultAdjustments(),
    fx: defaultEffects(),
    version: 0,
    ...init,
  };
}

export function createCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}
