import { createCanvas, defaultAdjustments, defaultEffects, makeLayer, type Doc, type Layer } from './types';
import { renderDoc } from './render';

export function loadImageFile(file: Blob): Promise<HTMLCanvasElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const c = createCanvas(img.naturalWidth, img.naturalHeight);
      c.getContext('2d')!.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      resolve(c);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not read that image'));
    };
    img.src = url;
  });
}

function dataUrlToCanvas(url: string): Promise<HTMLCanvasElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = createCanvas(img.naturalWidth, img.naturalHeight);
      c.getContext('2d')!.drawImage(img, 0, 0);
      resolve(c);
    };
    img.onerror = () => reject(new Error('Bad image data in project'));
    img.src = url;
  });
}

/** New image layer, scaled to fit inside the doc and centered. */
export function imageLayer(doc: Doc, canvas: HTMLCanvasElement, name: string): Layer {
  const fit = Math.min(1, doc.width / canvas.width, doc.height / canvas.height);
  return makeLayer('image', name, { canvas, x: doc.width / 2, y: doc.height / 2, scale: fit });
}

/* ---------------- project files ---------------- */
const PROJECT_VERSION = 1;

export async function serializeProject(doc: Doc): Promise<Blob> {
  const layers = doc.layers.map((l) => ({
    ...l,
    canvas: l.canvas ? l.canvas.toDataURL('image/png') : null,
    mask: l.mask ? l.mask.toDataURL('image/png') : null,
  }));
  const json = JSON.stringify({ app: 'studio-desktop', version: PROJECT_VERSION, doc: { ...doc, layers } });
  return new Blob([json], { type: 'application/json' });
}

export async function parseProject(text: string): Promise<Doc> {
  const data = JSON.parse(text);
  if (data.app !== 'studio-desktop' || !data.doc) throw new Error('Not a Studio Desktop project file');
  const d = data.doc;
  const layers: Layer[] = [];
  for (const l of d.layers) {
    layers.push({
      ...makeLayer(l.kind, l.name),
      ...l,
      adj: { ...defaultAdjustments(), ...l.adj },
      fx: { ...defaultEffects(), ...l.fx },
      canvas: l.canvas ? await dataUrlToCanvas(l.canvas) : null,
      mask: l.mask ? await dataUrlToCanvas(l.mask) : null,
      version: 0,
    });
  }
  return { ...d, layers };
}

/* ---------------- export ---------------- */
export function renderFull(doc: Doc, background: boolean): HTMLCanvasElement {
  const c = createCanvas(doc.width, doc.height);
  renderDoc(doc, c, 1, { background });
  return c;
}

function toBlob(c: HTMLCanvasElement, type: string, q?: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    c.toBlob((b) => (b ? resolve(b) : reject(new Error('Export failed — image may be too large for this browser'))), type, q),
  );
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Insert a pHYs chunk so print shops see the intended DPI. */
export function setPngDpi(png: Uint8Array, dpi: number): Uint8Array {
  const ppm = Math.round(dpi / 0.0254);
  const chunk = new Uint8Array(21);
  const dv = new DataView(chunk.buffer);
  dv.setUint32(0, 9);
  chunk.set([0x70, 0x48, 0x59, 0x73], 4); // 'pHYs'
  dv.setUint32(8, ppm);
  dv.setUint32(12, ppm);
  chunk[16] = 1; // meters
  dv.setUint32(17, crc32(chunk.subarray(4, 17)));
  // IHDR is always first: 8 sig + 4 len + 4 type + 13 data + 4 crc = 33
  const at = 33;
  // drop an existing pHYs if present
  let src = png;
  let p = 8;
  while (p < src.length) {
    const len = new DataView(src.buffer, src.byteOffset).getUint32(p);
    const type = String.fromCharCode(...src.subarray(p + 4, p + 8));
    if (type === 'pHYs') {
      const out = new Uint8Array(src.length - (len + 12));
      out.set(src.subarray(0, p));
      out.set(src.subarray(p + len + 12), p);
      src = out;
      break;
    }
    if (type === 'IDAT') break;
    p += len + 12;
  }
  const out = new Uint8Array(src.length + chunk.length);
  out.set(src.subarray(0, at));
  out.set(chunk, at);
  out.set(src.subarray(at), at + chunk.length);
  return out;
}

/** Patch the JFIF APP0 density fields so the JPEG reports the DPI. */
export function setJpegDpi(jpg: Uint8Array, dpi: number): Uint8Array {
  const out = new Uint8Array(jpg);
  if (out[2] === 0xff && out[3] === 0xe0 && String.fromCharCode(...out.subarray(6, 10)) === 'JFIF') {
    out[13] = 1;
    out[14] = (dpi >> 8) & 255;
    out[15] = dpi & 255;
    out[16] = (dpi >> 8) & 255;
    out[17] = dpi & 255;
  }
  return out;
}

export async function exportImage(doc: Doc, format: 'png' | 'jpeg', quality = 0.95): Promise<Blob> {
  const c = renderFull(doc, format === 'jpeg' || !!doc.background);
  const blob = await toBlob(c, format === 'png' ? 'image/png' : 'image/jpeg', quality);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const fixed = format === 'png' ? setPngDpi(bytes, doc.dpi) : setJpegDpi(bytes, doc.dpi);
  return new Blob([fixed as BlobPart], { type: blob.type });
}

export function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function pickFile(accept: string, multiple = false): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.onchange = () => resolve(input.files ? Array.from(input.files) : []);
    input.click();
  });
}
