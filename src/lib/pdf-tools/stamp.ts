import type { PDFDocument, PDFFont, PDFOperator, PDFPage, PDFRef } from 'pdf-lib';
import { plural } from '@/lib/format';
import { isWinAnsi } from '@/lib/make-pdf/text';
import { PdfToolsError } from './errors';
import { tick, type LoadedPdf } from './pdf';

type PdfLib = typeof import('pdf-lib');

export type NumberPosition =
  | 'top-left'
  | 'top-centre'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-centre'
  | 'bottom-right';

export type NumberFormat = 'n' | 'page-n' | 'page-n-of-total' | 'n-of-total';
export type NumberSize = 'small' | 'medium' | 'large';

export type WatermarkAngle = 'diagonal' | 'horizontal';
export type WatermarkColour = 'grey' | 'red' | 'blue' | 'black';
export type WatermarkSize = 'fit' | 'small' | 'medium' | 'large';

export interface PageNumberOptions {
  position: NumberPosition;
  format: NumberFormat;
  size: NumberSize;
  /** The number the first numbered page gets. */
  start: number;
}

export interface WatermarkOptions {
  text: string;
  angle: WatermarkAngle;
  /** From 0 to 1. */
  opacity: number;
  colour: WatermarkColour;
  size: WatermarkSize;
}

export const DEFAULT_PAGE_NUMBERS: PageNumberOptions = {
  position: 'bottom-centre',
  format: 'n',
  size: 'medium',
  start: 1,
};

export const DEFAULT_WATERMARK: WatermarkOptions = {
  text: 'CONFIDENTIAL',
  angle: 'diagonal',
  opacity: 0.25,
  colour: 'grey',
  size: 'fit',
};

export const WATERMARK_MAX_LENGTH = 40;

export type Stamp =
  | { kind: 'number'; text: string; position: NumberPosition; size: NumberSize }
  | ({ kind: 'watermark' } & WatermarkOptions);

/** What to draw on each 1-based page. Pages left out are not touched. */
export type StampPlan = ReadonlyMap<number, Stamp>;

const NUMBER_POINTS: Record<NumberSize, number> = { small: 9, medium: 11, large: 14 };

const WATERMARK_POINTS: Record<Exclude<WatermarkSize, 'fit'>, number> = {
  small: 28,
  medium: 48,
  large: 72,
};

const INKS: Record<WatermarkColour, [number, number, number]> = {
  grey: [0.5, 0.5, 0.5],
  red: [0.82, 0.1, 0.1],
  blue: [0.1, 0.3, 0.8],
  black: [0, 0, 0],
};

/** Half an inch, where a printed page number usually sits. */
const NUMBER_MARGIN = 36;
/** A watermark that fits the page spans at most this share of it each way. */
const FIT_SHARE = 0.8;
/** Spare q/Q pairs round the page's content, for content that leaves q open or has a Q too many. */
const SPARE_SAVES = 4;
/** What pdf.js assumes when a page has no usable MediaBox. */
const LETTER: Box = { left: 0, bottom: 0, right: 612, top: 792 };

const INVISIBLE = /[\p{Cc}\p{Cf}\uFE00-\uFE0F]/gu;

export function formatPageNumber(format: NumberFormat, n: number, last: number): string {
  switch (format) {
    case 'page-n':
      return `Page ${n}`;
    case 'page-n-of-total':
      return `Page ${n} of ${last}`;
    case 'n-of-total':
      return `${n} of ${last}`;
    default:
      return String(n);
  }
}

/** Counting runs over the chosen pages only, so “of N” is the last number shown. */
export function pageNumberPlan(pages: readonly number[], options: PageNumberOptions): StampPlan {
  const ordered = [...new Set(pages)].sort((a, b) => a - b);
  const last = options.start + ordered.length - 1;
  return new Map(
    ordered.map((page, i): [number, Stamp] => [
      page,
      {
        kind: 'number',
        text: formatPageNumber(options.format, options.start + i, last),
        position: options.position,
        size: options.size,
      },
    ]),
  );
}

export function watermarkPlan(pages: readonly number[], options: WatermarkOptions): StampPlan {
  const stamp: Stamp = { kind: 'watermark', ...options };
  return new Map(pages.map((page): [number, Stamp] => [page, stamp]));
}

/** One line, single spaces, and nothing invisible left in it. */
export function cleanWatermarkText(text: string): string {
  return text
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .replace(INVISIBLE, '')
    .replace(/ {2,}/g, ' ')
    .trim();
}

/** Why the text can’t be drawn, or null when it can. */
export function watermarkProblem(text: string): string | null {
  const chars = [...cleanWatermarkText(text)];
  if (chars.length === 0) return 'Type the words for your watermark.';
  if (chars.length > WATERMARK_MAX_LENGTH) {
    return `Keep it to ${WATERMARK_MAX_LENGTH} characters or fewer so it fits on the page.`;
  }

  const missing = [...new Set(chars.filter((char) => !isWinAnsi(char.codePointAt(0) ?? 0)))];
  if (missing.length === 0) return null;

  const named = missing.slice(0, 3).map((char) => `“${char}”`);
  const list =
    missing.length > 3
      ? `${named.join(', ')} and ${missing.length - 3} more`
      : named.length === 1
        ? named[0]
        : `${named.slice(0, -1).join(', ')} or ${named[named.length - 1]}`;
  return `The standard PDF fonts can’t draw ${list}. Use letters, numbers and common symbols.`;
}

export async function stampPdf(
  source: LoadedPdf,
  plan: StampPlan,
  onProgress: (done: number, total: number) => void,
): Promise<Uint8Array> {
  if (plan.size === 0) throw new PdfToolsError('Choose at least one page first.');
  for (const [page, stamp] of plan) {
    if (!Number.isInteger(page) || page < 1 || page > source.pageCount) {
      throw new PdfToolsError(
        `“${source.name}” has ${plural(source.pageCount, 'page')}, so page ${page} doesn’t exist.`,
      );
    }
    checkStamp(stamp);
  }

  const lib = await import('pdf-lib');
  const doc = await lib.PDFDocument.load(source.bytes.slice(), { updateMetadata: false });
  const pages = doc.getPages();
  const fonts = fontsFor(doc, lib);
  const wrap = wrapFor(doc, lib);
  const entries = [...plan].sort(([a], [b]) => a - b);
  let breather = performance.now();

  for (let i = 0; i < entries.length; i++) {
    const [page, stamp] = entries[i];
    stampPage(pages[page - 1], stamp, fonts, wrap, lib);
    if (performance.now() - breather > 50) {
      onProgress(i + 1, entries.length);
      await tick();
      breather = performance.now();
    }
  }

  onProgress(entries.length, entries.length);
  await tick();
  doc.setProducer('Docsphin');
  return doc.save({ useObjectStreams: true, addDefaultPage: false });
}

/** Stamps the first page of a one-page PDF, for the preview. */
export async function stampOnePage(bytes: Uint8Array, stamp: Stamp): Promise<Uint8Array> {
  checkStamp(stamp);
  const lib = await import('pdf-lib');
  const doc = await lib.PDFDocument.load(bytes.slice(), { updateMetadata: false });
  stampPage(doc.getPage(0), stamp, fontsFor(doc, lib), wrapFor(doc, lib), lib);
  return doc.save({ useObjectStreams: false });
}

function checkStamp(stamp: Stamp): void {
  if (stamp.kind !== 'watermark') return;
  const problem = watermarkProblem(stamp.text);
  if (problem) throw new PdfToolsError(problem);
}

interface Fonts {
  regular: () => PDFFont;
  bold: () => PDFFont;
}

interface Wrap {
  open: PDFRef;
  close: PDFRef;
}

function fontsFor(doc: PDFDocument, lib: PdfLib): Fonts {
  let regular: PDFFont | undefined;
  let bold: PDFFont | undefined;
  return {
    regular: () => (regular ??= doc.embedStandardFont(lib.StandardFonts.Helvetica)),
    bold: () => (bold ??= doc.embedStandardFont(lib.StandardFonts.HelveticaBold)),
  };
}

interface Box {
  left: number;
  bottom: number;
  right: number;
  top: number;
}

interface View extends Box {
  /** Clockwise turn applied when the page is shown. */
  rotation: 0 | 90 | 180 | 270;
  /** Size as shown, after that turn. */
  width: number;
  height: number;
}

interface Placement {
  text: string;
  font: PDFFont;
  size: number;
  /** Where the baseline starts, measured from the left and bottom edges of the page as shown. */
  u: number;
  v: number;
  /** Anticlockwise, in degrees, on the page as shown. */
  angle: number;
  colour: [number, number, number];
  opacity?: number;
}

function stampPage(page: PDFPage, stamp: Stamp, fonts: Fonts, wrap: Wrap, lib: PdfLib): void {
  ownContents(page, wrap, lib);
  ownResources(page, lib);
  const view = viewOf(page, lib);

  if (stamp.kind === 'number') {
    const font = fonts.regular();
    const margin = Math.min(NUMBER_MARGIN, Math.min(view.width, view.height) / 10);
    // On a very narrow page the number shrinks rather than running off the edge.
    const size = Math.min(
      NUMBER_POINTS[stamp.size],
      (view.width - 2 * margin) / advance(font, stamp.text, 1),
    );
    const width = advance(font, stamp.text, size);
    const capHeight = font.heightAtSize(size, { descender: false });
    const [vertical, horizontal] = stamp.position.split('-');

    place(page, view, lib, {
      text: stamp.text,
      font,
      size,
      u:
        horizontal === 'left'
          ? margin
          : horizontal === 'right'
            ? view.width - margin - width
            : (view.width - width) / 2,
      v: vertical === 'top' ? view.height - margin - capHeight : margin,
      angle: 0,
      colour: [0, 0, 0],
    });
    return;
  }

  const text = cleanWatermarkText(stamp.text);
  const font = fonts.bold();
  const angle = stamp.angle === 'diagonal' ? 45 : 0;
  const cos = Math.cos((angle * Math.PI) / 180);
  const sin = Math.sin((angle * Math.PI) / 180);
  const unitWidth = advance(font, text, 1);
  const unitHeight = font.heightAtSize(1, { descender: false });
  // The largest size whose turned bounding box still fits inside the page.
  const fit = Math.min(
    (FIT_SHARE * view.width) / (unitWidth * cos + unitHeight * sin),
    (FIT_SHARE * view.height) / (unitWidth * sin + unitHeight * cos),
  );
  const size = stamp.size === 'fit' ? fit : Math.min(WATERMARK_POINTS[stamp.size], fit);
  const width = unitWidth * size;
  const height = unitHeight * size;

  place(page, view, lib, {
    text,
    font,
    size,
    // Back from the centre by half the text, along the text's own axes.
    u: view.width / 2 - (width / 2) * cos + (height / 2) * sin,
    v: view.height / 2 - (width / 2) * sin - (height / 2) * cos,
    angle,
    colour: INKS[stamp.colour],
    opacity: Math.min(1, Math.max(0, stamp.opacity)),
  });
}

/** pdf-lib's own measure takes kerning off, but drawText never kerns. */
function advance(font: PDFFont, text: string, size: number): number {
  let width = 0;
  for (const char of text) width += font.widthOfTextAtSize(char, size);
  return width;
}

function place(page: PDFPage, view: View, lib: PdfLib, at: Placement): void {
  const { x, y } = toUserSpace(view, at.u, at.v);
  // An artifact, so screen readers skip it in tagged PDFs instead of reading it as body text.
  page.pushOperators(lib.beginMarkedContent('Artifact'));
  page.drawText(at.text, {
    x,
    y,
    font: at.font,
    size: at.size,
    color: lib.rgb(...at.colour),
    opacity: at.opacity,
    // Viewers turn the page clockwise by its rotation, so the text turns back the other way.
    rotate: lib.degrees(view.rotation + at.angle),
  });
  page.pushOperators(lib.endMarkedContent());
}

function toUserSpace(view: View, u: number, v: number): { x: number; y: number } {
  switch (view.rotation) {
    case 90:
      return { x: view.right - v, y: view.bottom + u };
    case 180:
      return { x: view.right - u, y: view.top - v };
    case 270:
      return { x: view.left + v, y: view.top - u };
    default:
      return { x: view.left + u, y: view.bottom + v };
  }
}

/** Content streams of the spare q and the spare Q, shared by every page in the document. */
function wrapFor(doc: PDFDocument, lib: PdfLib): Wrap {
  const { context } = doc;
  const spares = (op: () => PDFOperator) => Array.from({ length: SPARE_SAVES }, op);
  return {
    open: context.register(context.contentStream(spares(lib.pushGraphicsState))),
    close: context.register(context.contentStream(spares(lib.popGraphicsState))),
  };
}

/** A Contents array of its own: pdf-lib edits a shared one in place, so every page would get every stamp. */
function ownContents(page: PDFPage, wrap: Wrap, lib: PdfLib): void {
  const { PDFArray, PDFName, PDFStream } = lib;
  const { node } = page;
  const key = PDFName.of('Contents');
  const contents = node.get(key);
  const target = node.context.lookup(contents);
  if (!contents || !(target instanceof PDFArray || target instanceof PDFStream)) return;
  const streams = target instanceof PDFArray ? target.asArray() : [contents];
  node.set(key, node.context.obj([wrap.open, ...streams, wrap.close]));
}

/** Resources of its own too: pdf-lib adds to a shared dict, so every page would carry every page's entries. */
function ownResources(page: PDFPage, lib: PdfLib): void {
  const { PDFDict, PDFName } = lib;
  const { node } = page;
  const { context } = node;
  const current = context.lookup(node.getInheritableAttribute(PDFName.of('Resources')));
  const own = current instanceof PDFDict ? current.clone(context) : context.obj({});
  for (const key of ['Font', 'ExtGState']) {
    const entry = context.lookup(own.get(PDFName.of(key)));
    if (entry instanceof PDFDict) own.set(PDFName.of(key), entry.clone(context));
  }
  node.set(PDFName.of('Resources'), own);
}

/** The crop box and rotation, read the way pdf.js reads them, so the stamp lands where viewers show it. */
function viewOf(page: PDFPage, lib: PdfLib): View {
  const { PDFArray, PDFName, PDFNumber } = lib;
  const { node } = page;
  const inherited = (key: string) =>
    node.context.lookup(node.getInheritableAttribute(PDFName.of(key)));

  const box = (key: string): Box | null => {
    const value = inherited(key);
    if (!(value instanceof PDFArray) || value.size() !== 4) return null;
    const [x1, y1, x2, y2] = value.asArray().map((item) => {
      const n = node.context.lookup(item);
      return n instanceof PDFNumber ? n.asNumber() : NaN;
    });
    const rect = {
      left: Math.min(x1, x2),
      bottom: Math.min(y1, y2),
      right: Math.max(x1, x2),
      top: Math.max(y1, y2),
    };
    return rect.right > rect.left && rect.top > rect.bottom ? rect : null;
  };

  const media = box('MediaBox') ?? LETTER;
  const crop = box('CropBox');
  let shown = media;
  if (crop) {
    const overlap = {
      left: Math.max(crop.left, media.left),
      bottom: Math.max(crop.bottom, media.bottom),
      right: Math.min(crop.right, media.right),
      top: Math.min(crop.top, media.top),
    };
    if (overlap.right > overlap.left && overlap.top > overlap.bottom) shown = overlap;
  }

  const turn = inherited('Rotate');
  const degrees = turn instanceof PDFNumber ? turn.asNumber() : 0;
  const rotation = (degrees % 90 === 0 ? ((degrees % 360) + 360) % 360 : 0) as View['rotation'];
  const sideways = rotation === 90 || rotation === 270;
  const width = shown.right - shown.left;
  const height = shown.top - shown.bottom;

  return { ...shown, rotation, width: sideways ? height : width, height: sideways ? width : height };
}
