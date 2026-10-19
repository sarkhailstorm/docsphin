import type { PDFDocument, PDFPage, PDFImage } from 'pdf-lib';
import type { Face, FontBook } from './fonts';
import type { Margins } from './paper';

type PdfLib = typeof import('pdf-lib');

export interface SheetOptions {
  width: number;
  height: number;
  margins: Margins;
}

/** A page cursor counting down from the top, since PDF itself counts up from the bottom. */
export class Sheet {
  readonly pages: PDFPage[] = [];
  private current: PDFPage | null = null;
  private cursor = 0;

  constructor(
    private readonly doc: PDFDocument,
    private readonly lib: PdfLib,
    private readonly options: SheetOptions,
  ) {}

  get width(): number {
    return this.options.width;
  }

  get height(): number {
    return this.options.height;
  }

  get left(): number {
    return this.options.margins.left;
  }

  get right(): number {
    return this.options.width - this.options.margins.right;
  }

  get top(): number {
    return this.options.margins.top;
  }

  get floor(): number {
    return this.options.height - this.options.margins.bottom;
  }

  get contentWidth(): number {
    return Math.max(1, this.right - this.left);
  }

  get contentHeight(): number {
    return Math.max(1, this.floor - this.top);
  }

  get y(): number {
    return this.cursor;
  }

  set y(value: number) {
    this.cursor = value;
  }

  get pageCount(): number {
    return this.pages.length;
  }

  get started(): boolean {
    return this.current !== null;
  }

  newPage(): PDFPage {
    const page = this.doc.addPage([this.options.width, this.options.height]);
    this.pages.push(page);
    this.current = page;
    this.cursor = this.options.margins.top;
    return page;
  }

  /** Draw onto a page that already exists, without adding another. */
  on(page: PDFPage, top = this.options.margins.top): void {
    this.current = page;
    this.cursor = top;
  }

  private face(): PDFPage {
    return this.current ?? this.newPage();
  }

  fits(height: number): boolean {
    if (!this.current) return true;
    return this.cursor + height <= this.floor + 0.01;
  }

  /** Starts a new page when the next thing would not fit on this one. */
  ensure(height: number): void {
    if (!this.current) {
      this.newPage();
      return;
    }
    if (!this.fits(height) && this.cursor > this.options.margins.top) this.newPage();
  }

  text(
    value: string,
    x: number,
    baseline: number,
    size: number,
    font: Face,
    book: FontBook,
    colour: string,
  ): void {
    if (!value) return;
    try {
      this.face().drawText(value, {
        x,
        y: this.options.height - baseline,
        size,
        font: book.get(font),
        color: this.colour(colour),
      });
    } catch {
      // A character that slipped past the folder must not sink the whole file
    }
  }

  rect(x: number, top: number, width: number, height: number, fill: string): void {
    if (width <= 0 || height <= 0) return;
    this.face().drawRectangle({
      x,
      y: this.options.height - top - height,
      width,
      height,
      color: this.colour(fill),
    });
  }

  line(x1: number, top1: number, x2: number, top2: number, thickness: number, colour: string): void {
    this.face().drawLine({
      start: { x: x1, y: this.options.height - top1 },
      end: { x: x2, y: this.options.height - top2 },
      thickness,
      color: this.colour(colour),
    });
  }

  image(picture: PDFImage, x: number, top: number, width: number, height: number): void {
    this.face().drawImage(picture, {
      x,
      y: this.options.height - top - height,
      width,
      height,
    });
  }

  /** A clickable area. Anything but http, https and mailto is ignored on purpose. */
  link(url: string, x: number, top: number, width: number, height: number): void {
    if (!/^(https?|mailto):/i.test(url)) return;
    const { PDFName, PDFString, PDFArray } = this.lib;
    const page = this.face();

    const annotation = this.doc.context.obj({
      Type: 'Annot',
      Subtype: 'Link',
      Rect: [x, this.options.height - top - height, x + width, this.options.height - top],
      Border: [0, 0, 0],
      A: this.doc.context.obj({ Type: 'Action', S: 'URI', URI: PDFString.of(url) }),
    });
    const ref = this.doc.context.register(annotation);

    const existing = page.node.lookup(PDFName.of('Annots'));
    if (existing instanceof PDFArray) existing.push(ref);
    else page.node.set(PDFName.of('Annots'), this.doc.context.obj([ref]));
  }

  private colour(hex: string) {
    const value = parseHex(hex);
    return this.lib.rgb(value[0], value[1], value[2]);
  }
}

const BLACK: [number, number, number] = [0, 0, 0];

export function parseHex(hex: string): [number, number, number] {
  const clean = hex.replace('#', '').trim();
  if (clean.length === 3) {
    const r = parseInt(clean[0] + clean[0], 16);
    const g = parseInt(clean[1] + clean[1], 16);
    const b = parseInt(clean[2] + clean[2], 16);
    return Number.isNaN(r + g + b) ? BLACK : [r / 255, g / 255, b / 255];
  }
  if (clean.length !== 6) return BLACK;
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return Number.isNaN(r + g + b) ? BLACK : [r / 255, g / 255, b / 255];
}
