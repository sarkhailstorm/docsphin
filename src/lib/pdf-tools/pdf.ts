import type {
  PDFContext as PdfContext,
  PDFDict as PdfDict,
  PDFObject as PdfObject,
  PDFPage as PdfPage,
  PDFRawStream as PdfRawStream,
  PDFRef as PdfRef,
} from 'pdf-lib';
import { PdfToolsError } from './errors';
import { describeGroup } from './ranges';
import { baseName } from '@/lib/format';
import { safeFilename } from '@/lib/download';

export interface LoadedPdf {
  id: string;
  name: string;
  size: number;
  pageCount: number;
  /** Original file bytes; every operation works from a copy of these. */
  bytes: Uint8Array;
}

export interface NamedFile {
  name: string;
  bytes: Uint8Array;
}

export interface NamedPdf extends NamedFile {
  pages: number[];
}

let nextId = 1;

/** Let the browser paint before we hog the main thread again. */
export function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Truncates the base name, never the extension. */
export function downloadName(base: string, extension: string, fallback: string): string {
  const chars = [...base];
  const capped = chars.length > 120 ? `${chars.slice(0, 120).join('').trimEnd()}…` : base;
  return safeFilename(`${capped}.${extension}`, fallback);
}

/** "pages 4-9", falling back to a plain count once the list gets too scattered. */
export function groupLabel(pages: readonly number[]): string {
  const described = describeGroup([...pages]);
  return described.length > 48 ? `${pages.length} pages` : described;
}

export async function readPdf(file: File): Promise<LoadedPdf> {
  const { PDFDocument } = await import('pdf-lib');
  const bytes = new Uint8Array(await file.arrayBuffer());
  // No `ignoreEncryption`: without it pdf-lib throws for a password-protected file, which is what we want here.
  const doc = await PDFDocument.load(bytes.slice(), { updateMetadata: false });
  let pageCount: number;
  try {
    pageCount = doc.getPageCount();
  } catch {
    // pdf-lib accepts a PDF header with no readable catalog behind it, then fails here
    throw new Error('Invalid PDF: there is no page tree to read');
  }
  if (pageCount === 0) {
    throw new PdfToolsError(
      `“${file.name}” opened, but it contains no pages at all.`,
    );
  }
  return {
    id: `pdf-${nextId++}`,
    name: file.name,
    size: file.size,
    pageCount,
    bytes,
  };
}

/** One page of one queued file; `page` is 1-based. */
export interface PageRef {
  fileId: string;
  page: number;
}

export function planKey(ref: PageRef): string {
  return `${ref.fileId}:${ref.page}`;
}

export function allPages(items: readonly LoadedPdf[]): PageRef[] {
  return items.flatMap((file) =>
    Array.from({ length: file.pageCount }, (_, i) => ({ fileId: file.id, page: i + 1 })),
  );
}

function checkPlan(items: readonly LoadedPdf[], plan: readonly PageRef[]): void {
  if (items.length === 0) {
    throw new PdfToolsError('There are no PDFs queued up to merge.');
  }
  if (plan.length === 0) {
    throw new PdfToolsError('Every page has been left out — put at least one back first.');
  }

  const byId = new Map(items.map((file) => [file.id, file]));
  const seen = new Set<string>();

  for (const ref of plan) {
    const file = byId.get(ref.fileId);
    if (!file) {
      throw new PdfToolsError(
        'This page order still refers to a file that has been removed. Reset the page order and try again.',
      );
    }
    if (!Number.isInteger(ref.page) || ref.page < 1 || ref.page > file.pageCount) {
      throw new PdfToolsError(
        `“${file.name}” has ${file.pageCount} ${file.pageCount === 1 ? 'page' : 'pages'}, so page ${ref.page} can’t be pulled out of it.`,
      );
    }
    const key = planKey(ref);
    if (seen.has(key)) {
      throw new PdfToolsError(`Page ${ref.page} of “${file.name}” is listed more than once.`);
    }
    seen.add(key);
  }
}

/** One copyPages call per source: copying page by page re-embeds shared fonts and images. */
export async function mergePdfPages(
  items: readonly LoadedPdf[],
  plan: readonly PageRef[],
  onProgress: (done: number, total: number) => void,
): Promise<Uint8Array> {
  checkPlan(items, plan);

  const { PDFDocument } = await import('pdf-lib');
  const out = await PDFDocument.create();
  const sources = items.filter((file) => plan.some((ref) => ref.fileId === file.id));
  const copied = new Map<string, PdfPage>();

  for (let i = 0; i < sources.length; i++) {
    const file = sources[i];
    onProgress(i, sources.length);
    await tick();

    const wanted = [...new Set(plan.filter((ref) => ref.fileId === file.id).map((r) => r.page))]
      .sort((a, b) => a - b);
    const src = await PDFDocument.load(file.bytes.slice(), { updateMetadata: false });
    const pages = await out.copyPages(
      src,
      wanted.map((page) => page - 1),
    );
    wanted.forEach((page, n) => copied.set(planKey({ fileId: file.id, page }), pages[n]));
  }

  for (const ref of plan) {
    const page = copied.get(planKey(ref));
    if (page) out.addPage(page);
  }

  onProgress(sources.length, sources.length);
  out.setProducer('Docsphin');
  return out.save({ useObjectStreams: true, addDefaultPage: false });
}

function checkPages(source: LoadedPdf, pages: readonly number[]): void {
  if (pages.length === 0) {
    throw new PdfToolsError('Choose at least one page first — an empty PDF is not much use.');
  }
  for (const page of pages) {
    if (!Number.isInteger(page) || page < 1 || page > source.pageCount) {
      throw new PdfToolsError(
        `“${source.name}” has ${source.pageCount} ${source.pageCount === 1 ? 'page' : 'pages'}, so page ${page} can’t be pulled out of it.`,
      );
    }
  }
}

export async function extractPages(
  source: LoadedPdf,
  pages: readonly number[],
): Promise<Uint8Array> {
  checkPages(source, pages);
  const { PDFDocument } = await import('pdf-lib');
  const src = await PDFDocument.load(source.bytes.slice(), { updateMetadata: false });
  const out = await PDFDocument.create();
  const copied = await out.copyPages(
    src,
    pages.map((p) => p - 1),
  );
  for (const page of copied) out.addPage(page);
  out.setProducer('Docsphin');
  return out.save({ useObjectStreams: true, addDefaultPage: false });
}

export async function splitIntoFiles(
  source: LoadedPdf,
  groups: readonly number[][],
  onProgress: (done: number, total: number) => void,
): Promise<NamedPdf[]> {
  for (const group of groups) checkPages(source, group);

  const { PDFDocument } = await import('pdf-lib');
  const src = await PDFDocument.load(source.bytes.slice(), { updateMetadata: false });
  const stem = baseName(source.name);
  const files: NamedPdf[] = [];

  for (let i = 0; i < groups.length; i++) {
    onProgress(i, groups.length);
    await tick();
    const pages = groups[i];
    const out = await PDFDocument.create();
    const copied = await out.copyPages(
      src,
      pages.map((p) => p - 1),
    );
    for (const page of copied) out.addPage(page);
    out.setProducer('Docsphin');
    files.push({
      name: downloadName(`${stem} - ${groupLabel(pages)}`, 'pdf', `part-${i + 1}.pdf`),
      bytes: await out.save({ useObjectStreams: true, addDefaultPage: false }),
      pages,
    });
  }

  onProgress(groups.length, groups.length);
  return files;
}

/** Stored rather than deflated: PDFs are already compressed, so deflating buys nothing. */
export async function zipFiles(
  files: readonly NamedFile[],
  onProgress: (done: number, total: number) => void,
): Promise<Blob> {
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  const used = new Set<string>();

  for (const file of files) {
    let name = file.name;
    let n = 2;
    while (used.has(name.toLowerCase())) {
      const ext = file.name.split('.').pop() || 'bin';
      name = downloadName(`${baseName(file.name)} (${n++})`, ext, `part-${n}.${ext}`);
    }
    used.add(name.toLowerCase());
    zip.file(name, file.bytes);
  }

  // Kept as parts: generateAsync would first copy the whole archive into one array.
  const parts: Uint8Array[] = [];
  await new Promise<void>((resolve, reject) => {
    zip
      .generateInternalStream({ type: 'uint8array', compression: 'STORE' })
      .on('data', (chunk, meta) => {
        parts.push(chunk);
        onProgress(Math.round(meta.percent), 100);
      })
      .on('error', reject)
      .on('end', () => resolve())
      .resume();
  });
  return new Blob(parts, { type: 'application/zip' });
}

export type CompressStage = 'reading' | 'images' | 'saving';

export interface CompressProgress {
  stage: CompressStage;
  done: number;
  total: number;
}

export interface CompressOptions {
  /** Longest side, in pixels, a re-encoded JPEG may keep. It still fills the same space on the page. */
  maxEdge?: number;
}

export interface CompressReport {
  /** The bytes the user should actually download. */
  bytes: Uint8Array;
  originalSize: number;
  /** Size of our re-saved document, even when that turned out to be bigger. */
  rebuiltSize: number;
  /** True when re-saving gained nothing, so we hand back the original file. */
  keptOriginal: boolean;
  pageCount: number;
  imagesFound: number;
  jpegImages: number;
  imagesRewritten: number;
  /** Rewritten images that were also scaled down to `maxEdge`. */
  imagesResized: number;
  imageBytesBefore: number;
  imageBytesAfter: number;
  /** Re-encodable JPEG data in the rebuilt file. */
  jpegBytes: number;
  /** Image data this can never re-encode: masks, other formats, print or spot colours, and tiny JPEGs. */
  otherImageBytes: number;
}

const CARRY_OVER = ['SMask', 'Mask', 'Intent', 'Interpolate', 'OC', 'StructParent'];

/** Grey and RGB survive a canvas round trip; CMYK, spot colours, palettes and Lab come back as the wrong colours. */
const CANVAS_COLOUR_SPACES = new Set(['DeviceGray', 'DeviceRGB', 'CalGray', 'CalRGB', 'G', 'RGB']);

/** Below this an image is not worth the round trip through a canvas. */
const MIN_IMAGE_BYTES = 4 * 1024;
/** Only swap an image in when the new one is a real improvement. */
const MIN_IMAGE_GAIN = 0.97;
/** iOS caps a canvas at this many pixels and hands back a blank one rather than throwing. */
export const MAX_CANVAS_PIXELS = 16_777_216;

function nameOf(obj: PdfObject | undefined): string | null {
  // PDFName#asString() includes the leading slash: "/DCTDecode".
  const asString = (obj as { asString?: () => string } | undefined)?.asString;
  if (typeof asString !== 'function') return null;
  const value = asString.call(obj);
  return typeof value === 'string' && value.startsWith('/') ? value.slice(1) : null;
}

/** Re-encodes plain JPEGs and takes the free structural wins; every other image is left alone, and all of them when quality is null. */
export async function compressPdf(
  source: LoadedPdf,
  quality: number | null,
  onProgress: (progress: CompressProgress) => void,
  options: CompressOptions = {},
): Promise<CompressReport> {
  const lib = await import('pdf-lib');
  const { PDFDocument, PDFName, PDFNumber, PDFDict, PDFArray, PDFRawStream, PDFBool, PDFRef } = lib;

  onProgress({ stage: 'reading', done: 0, total: 0 });
  await tick();

  const originalSize = source.bytes.byteLength;
  const doc = await PDFDocument.load(source.bytes.slice(), { updateMetadata: false });
  const ctx = doc.context;
  const pageCount = doc.getPageCount();

  doc.catalog.delete(PDFName.of('Metadata'));
  doc.catalog.delete(PDFName.of('PieceInfo'));
  for (const page of doc.getPages()) {
    page.node.delete(PDFName.of('PieceInfo'));
  }
  doc.setProducer('Docsphin');

  const resolve = (dict: PdfDict, key: string): PdfObject | undefined =>
    ctx.lookup(dict.get(PDFName.of(key)));

  const keepsColour = (dict: PdfDict): boolean => {
    const space = resolve(dict, 'ColorSpace');
    const family = space instanceof PDFArray ? nameOf(ctx.lookup(space.get(0))) : nameOf(space);
    if (family && CANVAS_COLOUR_SPACES.has(family)) return true;
    if (family !== 'ICCBased' || !(space instanceof PDFArray)) return false;
    const profile = ctx.lookup(space.get(1));
    const channels = profile instanceof PDFRawStream ? resolve(profile.dict, 'N') : undefined;
    return channels instanceof PDFNumber && [1, 3].includes(channels.asNumber());
  };

  // With ColorTransform 0 a PDF reader shows the samples as stored, where a browser converts them from YCbCr.
  const untransformed = (dict: PdfDict): boolean => {
    const parms = resolve(dict, 'DecodeParms');
    const first = parms instanceof PDFArray ? ctx.lookup(parms.get(0)) : parms;
    const transform = first instanceof PDFDict ? resolve(first, 'ColorTransform') : undefined;
    return transform instanceof PDFNumber && transform.asNumber() === 0;
  };

  const images: { ref: PdfRef; stream: PdfRawStream }[] = [];
  const masks = new Set<string>();

  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    if (nameOf(resolve(obj.dict, 'Subtype')) !== 'Image') continue;
    images.push({ ref, stream: obj });
    for (const key of ['SMask', 'Mask']) {
      const mask = obj.dict.get(PDFName.of(key));
      if (mask instanceof PDFRef) masks.add(mask.tag);
    }
  }

  const candidates: { ref: PdfRef; stream: PdfRawStream; resizable: boolean }[] = [];
  const imagesFound = images.length;

  for (const { ref, stream: obj } of images) {
    const dict = obj.dict;
    // A mask has to stay greyscale, and a canvas only hands back RGB.
    if (masks.has(ref.tag)) continue;

    // A stencil mask or an inverting Decode array would be silently corrupted by a canvas round trip.
    const imageMask = resolve(dict, 'ImageMask');
    if (imageMask instanceof PDFBool && imageMask.asBoolean()) continue;
    if (resolve(dict, 'Decode')) continue;
    // A colour-key mask is expressed in the original colour space, which becomes DeviceRGB below.
    if (resolve(dict, 'Mask') instanceof PDFArray) continue;

    const filter = resolve(dict, 'Filter');
    let isJpeg = nameOf(filter) === 'DCTDecode';
    if (!isJpeg && filter instanceof PDFArray) {
      const names = filter.asArray().map((entry) => nameOf(ctx.lookup(entry)));
      isJpeg = names.length === 1 && names[0] === 'DCTDecode';
    }
    if (!isJpeg) continue;
    if (!keepsColour(dict) || untransformed(dict)) continue;
    if (obj.getContentsSize() < MIN_IMAGE_BYTES) continue;

    const softMask = resolve(dict, 'SMask');
    // Pre-blended (Matte) colours are worked out pixel for pixel against the mask, so keep the sizes matched.
    const resizable = !(softMask instanceof PDFRawStream && softMask.dict.has(PDFName.of('Matte')));
    candidates.push({ ref, stream: obj, resizable });
  }

  const jpegImages = candidates.length;
  let imagesRewritten = 0;
  let imagesResized = 0;
  let imageBytesBefore = 0;
  let imageBytesAfter = 0;

  if (quality !== null) {
    onProgress({ stage: 'images', done: 0, total: jpegImages });

    for (let i = 0; i < candidates.length; i++) {
      const { ref, stream, resizable } = candidates[i];
      const before = stream.getContents();

      try {
        const reencoded = await reencodeJpeg(before, quality, resizable ? options.maxEdge : undefined);
        if (reencoded && reencoded.byteLength < before.byteLength * MIN_IMAGE_GAIN) {
          const dict = PDFDict.withContext(ctx);
          dict.set(PDFName.of('Type'), PDFName.of('XObject'));
          dict.set(PDFName.of('Subtype'), PDFName.of('Image'));
          dict.set(PDFName.of('Width'), PDFNumber.of(reencoded.width));
          dict.set(PDFName.of('Height'), PDFNumber.of(reencoded.height));
          // A canvas always hands back 8-bit RGB, whatever went in.
          dict.set(PDFName.of('ColorSpace'), PDFName.of('DeviceRGB'));
          dict.set(PDFName.of('BitsPerComponent'), PDFNumber.of(8));
          dict.set(PDFName.of('Filter'), PDFName.of('DCTDecode'));
          for (const key of CARRY_OVER) {
            const value = stream.dict.get(PDFName.of(key));
            if (value) dict.set(PDFName.of(key), value);
          }
          ctx.assign(ref, PDFRawStream.of(dict, reencoded.bytes));
          imagesRewritten++;
          if (reencoded.resized) imagesResized++;
          imageBytesBefore += before.byteLength;
          imageBytesAfter += reencoded.byteLength;
        }
      } catch {
        // An image the browser cannot decode just stays as it was; never fatal.
      }

      onProgress({ stage: 'images', done: i + 1, total: jpegImages });
    }
  }

  onProgress({ stage: 'saving', done: 0, total: 0 });
  await tick();

  // pdf-lib would otherwise write the objects we just unlinked straight back out.
  dropUnreachableObjects(ctx, lib);

  const editable = new Set(candidates.map(({ ref }) => ref.tag));
  let jpegBytes = 0;
  let otherImageBytes = 0;
  for (const { ref } of images) {
    const live = ctx.lookup(ref);
    if (!(live instanceof PDFRawStream)) continue;
    if (editable.has(ref.tag)) jpegBytes += live.getContentsSize();
    else otherImageBytes += live.getContentsSize();
  }

  const rebuilt = await doc.save({ useObjectStreams: true, addDefaultPage: false });
  const rebuiltSize = rebuilt.byteLength;
  const keptOriginal = rebuiltSize >= originalSize;

  return {
    bytes: keptOriginal ? source.bytes : rebuilt,
    originalSize,
    rebuiltSize,
    keptOriginal,
    pageCount,
    imagesFound,
    jpegImages,
    imagesRewritten,
    imagesResized,
    imageBytesBefore,
    imageBytesAfter,
    jpegBytes,
    otherImageBytes,
  };
}

function dropUnreachableObjects(
  ctx: PdfContext,
  lib: typeof import('pdf-lib'),
): number {
  const { PDFRef, PDFDict, PDFArray, PDFStream } = lib;
  const root = ctx.trailerInfo.Root;
  // Without a catalog we have no idea what is live. Do nothing.
  if (!root) return 0;

  const reachable = new Set<string>();

  try {
    const stack: PdfObject[] = [root];
    for (const seed of [ctx.trailerInfo.Info, ctx.trailerInfo.ID, ctx.trailerInfo.Encrypt]) {
      if (seed) stack.push(seed);
    }

    let steps = 0;
    while (stack.length > 0) {
      // Step cap so a pathological file degrades to "change nothing" instead of hanging.
      if (++steps > 4_000_000) return 0;
      const obj = stack.pop();
      if (!obj) continue;

      if (obj instanceof PDFRef) {
        if (reachable.has(obj.tag)) continue;
        reachable.add(obj.tag);
        const target = ctx.lookup(obj);
        if (target) stack.push(target);
      } else if (obj instanceof PDFStream) {
        stack.push(obj.dict);
      } else if (obj instanceof PDFDict) {
        for (const value of obj.values()) stack.push(value);
      } else if (obj instanceof PDFArray) {
        for (const value of obj.asArray()) stack.push(value);
      }
    }
  } catch {
    return 0;
  }

  let removed = 0;
  for (const [ref] of ctx.enumerateIndirectObjects()) {
    if (!reachable.has(ref.tag)) {
      ctx.delete(ref);
      removed++;
    }
  }
  return removed;
}

interface Reencoded {
  bytes: Uint8Array;
  byteLength: number;
  width: number;
  height: number;
  resized: boolean;
}

async function reencodeJpeg(
  jpeg: Uint8Array,
  quality: number,
  maxEdge?: number,
): Promise<Reencoded | null> {
  // A PDF positions an image itself, so honouring an EXIF orientation tag here would rotate it.
  const bitmap = await createImageBitmap(new Blob([jpeg], { type: 'image/jpeg' }), {
    imageOrientation: 'none',
  });

  try {
    const longest = Math.max(bitmap.width, bitmap.height);
    const scale = maxEdge && longest > maxEdge ? maxEdge / longest : 1;
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const bytes = await encodeJpeg(bitmap, width, height, quality);
    if (!bytes) return null;
    return { bytes, byteLength: bytes.byteLength, width, height, resized: scale < 1 };
  } finally {
    bitmap.close();
  }
}

/** Paints the bitmap onto white at the given size, closing it once drawn, and saves a JPEG; null if the browser declines. */
export async function encodeJpeg(
  bitmap: ImageBitmap,
  width: number,
  height: number,
  quality: number,
): Promise<Uint8Array | null> {
  const canvas = document.createElement('canvas');
  let blob: Blob | null = null;

  try {
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return null;

    // JPEG has no alpha; painting white first keeps any transparency sane.
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    if (width === bitmap.width && height === bitmap.height) {
      context.drawImage(bitmap, 0, 0);
    } else {
      drawReduced(context, bitmap, width, height);
    }
    bitmap.close();

    blob = await new Promise<Blob | null>((res) => {
      canvas.toBlob(res, 'image/jpeg', quality);
    });
  } finally {
    // Release the backing store straight away; scanned pages are enormous.
    canvas.width = 0;
    canvas.height = 0;
  }

  return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
}

/** Halves towards the target first: one big step aliases in browsers that only smooth bilinearly. */
function drawReduced(
  context: CanvasRenderingContext2D,
  bitmap: ImageBitmap,
  width: number,
  height: number,
): void {
  const steps: { width: number; height: number }[] = [];
  for (
    let w = width * 2, h = height * 2;
    w < bitmap.width && h < bitmap.height && w * h <= MAX_CANVAS_PIXELS;
    w *= 2, h *= 2
  ) {
    steps.unshift({ width: w, height: h });
  }

  let source: CanvasImageSource = bitmap;
  let previous: HTMLCanvasElement | null = null;
  for (const step of steps) {
    const canvas = document.createElement('canvas');
    canvas.width = step.width;
    canvas.height = step.height;
    const stepContext = canvas.getContext('2d');
    if (!stepContext) {
      canvas.width = 0;
      canvas.height = 0;
      break;
    }
    stepContext.imageSmoothingQuality = 'high';
    stepContext.drawImage(source, 0, 0, step.width, step.height);
    if (previous) {
      previous.width = 0;
      previous.height = 0;
    }
    previous = canvas;
    source = canvas;
  }

  context.imageSmoothingQuality = 'high';
  context.drawImage(source, 0, 0, width, height);
  if (previous) {
    previous.width = 0;
    previous.height = 0;
  }
}

export function summariseCompression(report: CompressReport): {
  tone: 'good' | 'flat';
  headline: string;
  detail: string;
} {
  const outputSize = report.bytes.byteLength;
  const saved = report.originalSize - outputSize;
  const ratio = report.originalSize > 0 ? saved / report.originalSize : 0;

  if (report.keptOriginal) {
    return {
      tone: 'flat',
      headline: 'Nothing to gain here — your original is already smaller.',
      detail:
        'Rebuilding this PDF produced a larger file, so the download below is your original, untouched. That usually means it was already well optimised.',
    };
  }

  if (ratio >= 0.03) {
    return {
      tone: 'good',
      headline: `${Math.round(ratio * 100)}% smaller.`,
      detail:
        report.imagesRewritten > 0
          ? `Re-encoded ${report.imagesRewritten} of ${report.imagesFound} ${report.imagesFound === 1 ? 'image' : 'images'}, plus structural savings.`
          : 'Savings came from rebuilding the file structure and dropping unused metadata.',
    };
  }

  if (report.imagesFound === 0) {
    return {
      tone: 'flat',
      headline: 'This PDF is mostly text, so there was little to compress.',
      detail:
        'There are no embedded images to re-encode. Text and vector artwork are already stored compactly, and nothing here can shrink them further without losing the text.',
    };
  }

  if (report.jpegImages === 0) {
    return {
      tone: 'flat',
      headline: 'The images in this PDF were left alone.',
      detail: `Found ${report.imagesFound} ${report.imagesFound === 1 ? 'image' : 'images'}, but ${report.imagesFound === 1 ? 'it is' : 'each is'} either stored in a way a browser can’t safely re-encode or too small to be worth it.`,
    };
  }

  return {
    tone: 'flat',
    headline: 'Barely any saving on this one.',
    detail: `Its ${report.jpegImages} JPEG ${report.jpegImages === 1 ? 'image is' : 'images are'} already compressed at least as hard as this quality setting. Lowering the slider further may help a little.`,
  };
}
