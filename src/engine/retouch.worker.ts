/** Background worker for the Remove tool's content-aware fill. */
import { inpaint } from './inpaint';

const scope = self as unknown as {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<{ id: number; rgba: Uint8ClampedArray; w: number; h: number; hole: Uint8Array }>) => void) | null;
};

scope.onmessage = (e) => {
  const { id, rgba, w, h, hole } = e.data;
  try {
    const out = inpaint(rgba, w, h, hole, id * 7919 + 1);
    scope.postMessage({ id, rgba: out }, [out.buffer]);
  } catch (err) {
    scope.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
