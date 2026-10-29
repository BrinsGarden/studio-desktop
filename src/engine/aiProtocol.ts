import type { EdgeSettings } from './cutoutPipeline';
import type { Rect } from './matte';

export type Quality = 'fast' | 'best' | 'max';

/** Error prefix meaning "this model can't run on this graphics card": the page restarts the worker on CPU. */
export const GPU_FAIL = 'GPU_FAIL:';

export interface PickPoint {
  x: number;
  y: number;
  /** 1 = include this spot, 0 = exclude it */
  label: 0 | 1;
}

/** Messages from the page to the AI worker. Every request has an id; replies echo it. */
export type ToWorker =
  | { type: 'init'; id: number; wasmBase: string; remoteHost?: string; cpuOnly: string[] }
  | { type: 'setImage'; id: number; imageId: string; bitmap: ImageBitmap }
  | { type: 'warmSam'; id: number }
  | { type: 'pick'; id: number; points: PickPoint[]; box: Rect | null; quality: Quality; edges: EdgeSettings }
  | { type: 'subject'; id: number; quality: Quality; edges: EdgeSettings }
  | { type: 'edges'; id: number; edges: EdgeSettings }
  | { type: 'refine'; id: number; data: Uint8Array; edges: EdgeSettings }
  | { type: 'decontam'; id: number; alpha: Uint8Array; amount: number }
  | { type: 'reset'; id: number };

export type FromWorker =
  | { type: 'progress'; id: number; text: string; progress: number | null }
  | { type: 'device'; id: number; device: 'webgpu' | 'wasm' }
  | { type: 'samPreview'; id: number; w: number; h: number; data: Uint8Array }
  /** Final matte for the work rectangle (in layer pixels). */
  | { type: 'alpha'; id: number; wr: Rect; data: Uint8Array }
  | { type: 'decontam'; id: number; wr: Rect; data: Uint8ClampedArray }
  | { type: 'done'; id: number }
  | { type: 'error'; id: number; message: string };
