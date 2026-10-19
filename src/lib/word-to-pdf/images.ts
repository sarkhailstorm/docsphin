import type { PDFDocument } from 'pdf-lib';
import type { Embedded } from './draw';

/** Pixels in a Word document are 96 to the inch; PDF works in 72nds. */
const PX_TO_PT = 0.75;
/** Beyond this a single picture takes longer to redraw than the whole document. */
const MAX_PIXELS = 40_000_000;
const JPEG_QUALITY = 0.9;

type Route = 'png' | 'jpeg' | 'redraw' | 'unreadable';

interface Shape {
  route: Route;
  mime: string;
}

function shapeOf(bytes: Uint8Array): Shape {
  const [a, b, c, d] = bytes;

  if (a === 0x89 && b === 0x50 && c === 0x4e && d === 0x47) {
    const png = inspectPng(bytes);
    if (!png.sound) return { route: 'unreadable', mime: '' };
    // pdf-lib cannot unpick an interlaced PNG, so the browser redraws it first
    return { route: png.interlaced ? 'redraw' : 'png', mime: 'image/png' };
  }

  if (a === 0xff && b === 0xd8 && c === 0xff) {
    const jpeg = inspectJpeg(bytes);
    if (!jpeg.sound) return { route: 'unreadable', mime: '' };
    // Progressive JPEG is outside what a PDF reader has to support
    return { route: jpeg.progressive ? 'redraw' : 'jpeg', mime: 'image/jpeg' };
  }

  if (a === 0x47 && b === 0x49 && c === 0x46) return { route: 'redraw', mime: 'image/gif' };
  if (a === 0x42 && b === 0x4d) return { route: 'redraw', mime: 'image/bmp' };
  if (a === 0x52 && b === 0x49 && c === 0x46 && d === 0x46) {
    return { route: 'redraw', mime: 'image/webp' };
  }

  const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 300)).trim();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) {
    return { route: 'redraw', mime: 'image/svg+xml' };
  }
  return { route: 'unreadable', mime: '' };
}

const BIT_DEPTHS = new Set([1, 2, 4, 8, 16]);
const COLOUR_TYPES = new Set([0, 2, 3, 4, 6]);

/** A truncated PNG sends pdf-lib's decoder into a loop that never returns. */
function inspectPng(bytes: Uint8Array): { sound: boolean; interlaced: boolean } {
  const bad = { sound: false, interlaced: false };
  if (bytes.length < 57) return bad;
  if (bytes[4] !== 0x0d || bytes[5] !== 0x0a || bytes[6] !== 0x1a || bytes[7] !== 0x0a) return bad;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let first = true;
  let data = false;
  let end = false;
  let interlaced = false;

  while (at + 12 <= bytes.length) {
    const length = view.getUint32(at);
    if (length > bytes.length - at - 12) return bad;

    let type = '';
    for (let i = 0; i < 4; i += 1) {
      const code = bytes[at + 4 + i];
      if (code < 65 || (code > 90 && code < 97) || code > 122) return bad;
      type += String.fromCharCode(code);
    }

    if (first) {
      if (type !== 'IHDR' || length !== 13) return bad;
      const width = view.getUint32(at + 8);
      const height = view.getUint32(at + 12);
      if (width < 1 || height < 1 || width * height > MAX_PIXELS) return bad;
      if (!BIT_DEPTHS.has(bytes[at + 16]) || !COLOUR_TYPES.has(bytes[at + 17])) return bad;
      if (bytes[at + 20] > 1) return bad;
      interlaced = bytes[at + 20] === 1;
      first = false;
    }

    if (type === 'IDAT') data = true;
    if (type === 'IEND') {
      end = true;
      at += 12 + length;
      break;
    }
    at += 12 + length;
  }

  return { sound: data && end, interlaced };
}

function inspectJpeg(bytes: Uint8Array): { sound: boolean; progressive: boolean } {
  const bad = { sound: false, progressive: false };
  if (bytes.length < 125) return bad;

  let at = 2;
  let progressive = false;
  let frame = false;

  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) return bad;
    const marker = bytes[at + 1];
    // Padding bytes and standalone markers carry no length
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
      at += 2;
      continue;
    }
    const length = (bytes[at + 2] << 8) | bytes[at + 3];
    if (length < 2 || at + 2 + length > bytes.length) return bad;

    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = (bytes[at + 5] << 8) | bytes[at + 6];
      const width = (bytes[at + 7] << 8) | bytes[at + 8];
      if (width < 1 || height < 1 || width * height > MAX_PIXELS) return bad;
      progressive = marker === 0xc2 || marker === 0xc6 || marker === 0xca;
      frame = true;
    }
    // Everything after the scan header is entropy-coded, so stop reading markers
    if (marker === 0xda) return { sound: frame, progressive };

    at += 2 + length;
  }

  return { sound: frame, progressive };
}

async function decode(blob: Blob): Promise<ImageBitmap | HTMLImageElement | null> {
  try {
    return await createImageBitmap(blob);
  } catch {
    // Chrome refuses SVG here, so fall back to an ordinary <img>
  }
  const url = URL.createObjectURL(blob);
  try {
    const element = new Image();
    await new Promise<void>((resolve, reject) => {
      element.onload = () => resolve();
      element.onerror = () => reject(new Error('decode failed'));
      element.src = url;
    });
    return element;
  } catch {
    return null;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/** Repaints a picture the browser understands but pdf-lib does not. */
async function redraw(
  bytes: Uint8Array,
  mime: string,
): Promise<{ bytes: Uint8Array; jpeg: boolean } | null> {
  const source = await decode(new Blob([bytes as BlobPart], { type: mime }));
  if (!source) return null;

  const width = Math.max(1, Math.round(source.width || 1));
  const height = Math.max(1, Math.round(source.height || 1));
  if (width * height > MAX_PIXELS) return null;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return null;

  const asJpeg = mime === 'image/jpeg';
  if (asJpeg) {
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
  }
  context.drawImage(source as CanvasImageSource, 0, 0, width, height);
  if ('close' in source) source.close();

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, asJpeg ? 'image/jpeg' : 'image/png', asJpeg ? JPEG_QUALITY : undefined),
  );
  canvas.width = 0;
  canvas.height = 0;
  if (!blob) return null;
  return { bytes: new Uint8Array(await blob.arrayBuffer()), jpeg: asJpeg };
}

export async function embedImages(
  doc: PDFDocument,
  media: ReadonlyMap<string, Uint8Array>,
  paths: Iterable<string>,
  notes: Set<string>,
): Promise<Map<string, Embedded>> {
  const out = new Map<string, Embedded>();

  for (const path of new Set(paths)) {
    const bytes = media.get(path);
    if (!bytes || bytes.byteLength === 0) continue;

    try {
      const { route, mime } = shapeOf(bytes);

      if (route === 'unreadable') {
        notes.add(
          'A picture was left out: either it is damaged, or it is a Windows metafile (.emf or .wmf), which browsers cannot read.',
        );
        continue;
      }

      let image;
      if (route === 'png') image = await doc.embedPng(bytes);
      else if (route === 'jpeg') image = await doc.embedJpg(bytes);
      else {
        const redrawn = await redraw(bytes, mime);
        if (!redrawn) {
          notes.add('A picture in a format this browser cannot open was left out.');
          continue;
        }
        image = redrawn.jpeg
          ? await doc.embedJpg(redrawn.bytes)
          : await doc.embedPng(redrawn.bytes);
      }

      out.set(path, {
        image,
        width: image.width * PX_TO_PT,
        height: image.height * PX_TO_PT,
      });
    } catch {
      notes.add('A picture could not be read and was left out.');
    }
  }

  return out;
}
