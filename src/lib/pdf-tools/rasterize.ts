import type { PDFArray as PdfArray, PDFPage as PdfPage } from 'pdf-lib';
import { PdfToolsError } from './errors';
import { downloadName, tick, type LoadedPdf, type NamedFile } from './pdf';
import { baseName } from '@/lib/format';

export type ImageFormat = 'png' | 'jpeg';
export type ImageQualityId = 'screen' | 'good' | 'print';

/** A PDF point is 1/72 inch, and pdf.js draws one point as one pixel at scale 1. */
const POINTS_PER_INCH = 72;
/** iOS caps total canvas area and hands back a blank canvas rather than throwing. */
const MAX_RASTER_PIXELS = 16_777_216;
const JPEG_QUALITY = 0.9;

export const IMAGE_FORMAT_LABELS: Record<ImageFormat, string> = {
  png: 'PNG — sharp text, bigger files',
  jpeg: 'JPG — smaller files, best for photos',
};

export const IMAGE_QUALITY_LABELS: Record<ImageQualityId, string> = {
  screen: 'Screen (96 DPI)',
  good: 'Good (150 DPI)',
  print: 'Print (300 DPI)',
};

const QUALITY_DPI: Record<ImageQualityId, number> = {
  screen: 96,
  good: 150,
  print: 300,
};

export interface ImageExportOptions {
  format: ImageFormat;
  quality: ImageQualityId;
}

export const DEFAULT_EXPORT_OPTIONS: ImageExportOptions = {
  format: 'png',
  quality: 'good',
};

export function imageExtension(format: ImageFormat): string {
  return format === 'jpeg' ? 'jpg' : 'png';
}

export function pixelsPerPage(widthPt: number, heightPt: number, quality: ImageQualityId): number {
  const scale = QUALITY_DPI[quality] / POINTS_PER_INCH;
  return Math.round(widthPt * scale) * Math.round(heightPt * scale);
}

/** JFIF 1.01 with no thumbnail; withDpi fills in the units and densities. */
const JFIF_APP0 = new Uint8Array([
  0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0,
]);

function crc32(bytes: Uint8Array): number {
  let crc = -1;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function spliced(bytes: Uint8Array, start: number, end: number, insert: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length - (end - start) + insert.length);
  out.set(bytes.subarray(0, start));
  out.set(insert, start);
  out.set(bytes.subarray(end), start + insert.length);
  return out;
}

/** toBlob has no way to set a resolution, so editors and upload checks would read 72 or 96 DPI. */
function withDpi(bytes: Uint8Array, dpi: number): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    // The JFIF header follows SOI and keeps its units and densities at bytes 13 to 17.
    const jfif =
      view.getUint16(2) === 0xffe0 && view.getUint16(4) >= 16 && view.getUint32(6) === 0x4a464946;
    const out = jfif ? bytes.slice() : spliced(bytes, 2, 2, JFIF_APP0);
    const fields = new DataView(out.buffer, 13, 5);
    fields.setUint8(0, 1);
    fields.setUint16(1, dpi);
    fields.setUint16(3, dpi);
    return out;
  }

  if (view.getUint32(0) !== 0x89504e47) return bytes;
  const perMetre = Math.round(dpi / 0.0254);
  const chunk = new Uint8Array(21);
  const fields = new DataView(chunk.buffer);
  fields.setUint32(0, 9);
  chunk.set(new TextEncoder().encode('pHYs'), 4);
  fields.setUint32(8, perMetre);
  fields.setUint32(12, perMetre);
  fields.setUint8(16, 1);
  fields.setUint32(17, crc32(chunk.subarray(4, 17)));

  // Replace a pHYs the encoder wrote (two are invalid), or add one after IHDR, at byte 33.
  for (let at = 8; at + 8 <= bytes.length; at += 12 + view.getUint32(at)) {
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    if (type === 'pHYs') return spliced(bytes, at, at + 12 + view.getUint32(at), chunk);
    if (type === 'IDAT') break;
  }
  return spliced(bytes, 33, 33, chunk);
}

export async function pagesToImages(
  source: LoadedPdf,
  pages: readonly number[],
  options: ImageExportOptions,
  onProgress: (done: number, total: number) => void,
): Promise<NamedFile[]> {
  if (pages.length === 0) {
    throw new PdfToolsError('Choose at least one page to save as an image.');
  }

  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
  const task = pdfjs.getDocument({ data: source.bytes.slice() });

  const stem = baseName(source.name);
  const extension = imageExtension(options.format);
  const type = options.format === 'jpeg' ? 'image/jpeg' : 'image/png';
  const out: NamedFile[] = [];

  try {
    const doc = await task.promise;
    for (let i = 0; i < pages.length; i++) {
      const number = pages[i];
      onProgress(i, pages.length);
      await tick();

      const page = await doc.getPage(number);
      const canvas = document.createElement('canvas');
      try {
        let scale = QUALITY_DPI[options.quality] / POINTS_PER_INCH;
        const base = page.getViewport({ scale });
        if (base.width * base.height > MAX_RASTER_PIXELS) {
          scale *= Math.sqrt(MAX_RASTER_PIXELS / (base.width * base.height));
        }
        const viewport = page.getViewport({ scale });

        canvas.width = Math.max(1, Math.floor(viewport.width));
        canvas.height = Math.max(1, Math.floor(viewport.height));
        const context = canvas.getContext('2d');
        if (!context) throw new PdfToolsError('This browser would not provide a 2D canvas.');

        // A PDF page has no background of its own, and JPEG has no alpha.
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: context, viewport }).promise;

        const blob = await new Promise<Blob | null>((resolve) => {
          canvas.toBlob(resolve, type, options.format === 'jpeg' ? JPEG_QUALITY : undefined);
        });
        if (!blob) throw new PdfToolsError(`Page ${number} could not be turned into an image.`);

        const dpi = Math.max(1, Math.round(scale * POINTS_PER_INCH));
        out.push({
          name: downloadName(`${stem} - page ${number}`, extension, `page-${number}.${extension}`),
          bytes: withDpi(new Uint8Array(await blob.arrayBuffer()), dpi),
        });
      } finally {
        page.cleanup();
        canvas.width = 0;
        canvas.height = 0;
      }
    }
  } finally {
    void task.destroy().catch(() => undefined);
  }

  onProgress(pages.length, pages.length);
  return out;
}

export interface PageSize {
  /** Points, already turned by the page’s /Rotate. */
  width: number;
  height: number;
}

type Box = readonly [number, number, number, number];

/** pdf.js draws a page with no usable MediaBox as US Letter. */
const LETTER_BOX: Box = [0, 0, 612, 792];
/** About 11 A4 pages at Print quality. */
const HEAVY_EXPORT_PIXELS = 100_000_000;

function sizeOf(box: Box): PageSize {
  return { width: box[2] - box[0], height: box[3] - box[1] };
}

function overlap(a: Box, b: Box): Box | null {
  const box: Box = [
    Math.max(a[0], b[0]),
    Math.max(a[1], b[1]),
    Math.min(a[2], b[2]),
    Math.min(a[3], b[3]),
  ];
  return box[2] - box[0] > 0 && box[3] - box[1] > 0 ? box : null;
}

function quarterTurned(page: PdfPage): boolean {
  try {
    const angle = page.getRotation().angle;
    // pdf.js ignores a /Rotate that is not a multiple of 90.
    return angle % 90 === 0 && angle % 180 !== 0;
  } catch {
    return false;
  }
}

/** Each page as pdf.js will draw it: the CropBox clipped to the MediaBox, then turned. */
export async function readPageSizes(source: LoadedPdf): Promise<PageSize[]> {
  const { PDFDocument, PDFNumber } = await import('pdf-lib');
  const doc = await PDFDocument.load(source.bytes.slice(), { updateMetadata: false });

  const readBox = (read: () => PdfArray | undefined): Box | null => {
    try {
      const array = read();
      if (!array || array.size() !== 4) return null;
      const [x1, y1, x2, y2] = [0, 1, 2, 3].map((i) => array.lookup(i, PDFNumber).asNumber());
      const box: Box = [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];
      return box[2] - box[0] > 0 && box[3] - box[1] > 0 ? box : null;
    } catch {
      return null;
    }
  };

  return doc.getPages().map((page) => {
    const media = readBox(() => page.node.MediaBox()) ?? LETTER_BOX;
    const crop = readBox(() => page.node.CropBox());
    const size = sizeOf((crop && overlap(crop, media)) ?? media);
    return quarterTurned(page) ? { width: size.height, height: size.width } : size;
  });
}

/** The canvas size pagesToImages gives a page; keep the two in step. */
function imageSize(page: PageSize, quality: ImageQualityId): { width: number; height: number } {
  let scale = QUALITY_DPI[quality] / POINTS_PER_INCH;
  const area = page.width * scale * (page.height * scale);
  if (area > MAX_RASTER_PIXELS) scale *= Math.sqrt(MAX_RASTER_PIXELS / area);
  return {
    width: Math.max(1, Math.floor(page.width * scale)),
    height: Math.max(1, Math.floor(page.height * scale)),
  };
}

export interface ExportEstimate {
  /** In pixels; null when none of the page sizes are known. */
  largest: { width: number; height: number } | null;
  uniform: boolean;
  heavy: boolean;
}

/** `sizes` comes from readPageSizes; a page missing from it counts as US Letter. */
export function estimateExport(
  sizes: readonly PageSize[],
  pages: readonly number[],
  quality: ImageQualityId,
): ExportEstimate {
  let largest: ExportEstimate['largest'] = null;
  let uniform = true;
  let pixels = 0;

  for (const page of pages) {
    const size = sizes[page - 1];
    const image = imageSize(size ?? sizeOf(LETTER_BOX), quality);
    pixels += image.width * image.height;
    if (!size) continue;
    if (largest && (image.width !== largest.width || image.height !== largest.height)) {
      uniform = false;
    }
    if (!largest || image.width * image.height > largest.width * largest.height) largest = image;
  }

  return { largest, uniform, heavy: pixels > HEAVY_EXPORT_PIXELS };
}
