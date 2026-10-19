import type { PDFDocument, PDFFont } from 'pdf-lib';

export type Family = 'sans' | 'serif' | 'mono';

export interface Face {
  family: Family;
  bold: boolean;
  italic: boolean;
}

export const faceKey = (face: Face): string =>
  `${face.family}${face.bold ? 'b' : ''}${face.italic ? 'i' : ''}`;

export const face = (family: Family, bold = false, italic = false): Face => ({
  family,
  bold,
  italic,
});

const STANDARD: Record<string, string> = {
  sans: 'Helvetica',
  sansb: 'Helvetica-Bold',
  sansi: 'Helvetica-Oblique',
  sansbi: 'Helvetica-BoldOblique',
  serif: 'Times-Roman',
  serifb: 'Times-Bold',
  serifi: 'Times-Italic',
  serifbi: 'Times-BoldItalic',
  mono: 'Courier',
  monob: 'Courier-Bold',
  monoi: 'Courier-Oblique',
  monobi: 'Courier-BoldOblique',
};

const SERIF =
  /times|georgia|garamond|cambria|constantia|palatino|book antiqua|bookman|century|baskerville|minion|caslon|didot|utopia|charter|merriweather|playfair|libre baskerville|pt serif|noto serif|liberation serif|droid serif|dejavu serif|free serif|roman|serif/i;

const MONO =
  /courier|consolas|monaco|menlo|inconsolata|andale mono|lucida console|lucida sans typewriter|cascadia|fira code|fira mono|source code|roboto mono|ubuntu mono|dejavu sans mono|liberation mono|sf mono|ibm plex mono|jetbrains|mono(space)?$/i;

/** Rounds a document's font name down to one of the three families PDF readers always have. */
export function familyFor(name: string | undefined): Family {
  if (!name) return 'sans';
  const clean = name.trim();
  if (MONO.test(clean)) return 'mono';
  if (SERIF.test(clean)) return 'serif';
  return 'sans';
}

/** Rough per-character width when pdf-lib refuses to measure a string. */
const FALLBACK_WIDTH = 0.5;
const CACHE_LIMIT = 50_000;

export class FontBook {
  private readonly fonts = new Map<string, PDFFont>();
  private readonly widths = new Map<string, number>();

  constructor(private readonly doc: PDFDocument) {}

  async prepare(faces: Iterable<Face>): Promise<void> {
    const wanted = new Set<string>();
    for (const item of faces) wanted.add(faceKey(item));
    if (wanted.size === 0) wanted.add('sans');

    for (const key of wanted) {
      if (this.fonts.has(key)) continue;
      const name = STANDARD[key] ?? STANDARD.sans;
      this.fonts.set(key, await this.doc.embedFont(name as Parameters<PDFDocument['embedFont']>[0]));
    }
  }

  get(wanted: Face): PDFFont {
    const font = this.fonts.get(faceKey(wanted)) ?? this.fonts.get('sans');
    if (!font) throw new Error('FontBook.prepare was never called');
    return font;
  }

  /** Widths scale with size, so everything is measured once at size 1. */
  width(text: string, size: number, wanted: Face): number {
    if (!text) return 0;
    const key = `${faceKey(wanted)}\u0000${text}`;
    let unit = this.widths.get(key);
    if (unit === undefined) {
      unit = this.measure(text, wanted);
      if (this.widths.size >= CACHE_LIMIT) this.widths.clear();
      this.widths.set(key, unit);
    }
    return unit * size;
  }

  /** Full line box for a font size: ascender to descender. */
  height(size: number, wanted: Face): number {
    try {
      return this.get(wanted).heightAtSize(size, { descender: true });
    } catch {
      return size * 1.2;
    }
  }

  private measure(text: string, wanted: Face): number {
    try {
      return this.get(wanted).widthOfTextAtSize(text, 1);
    } catch {
      return text.length * FALLBACK_WIDTH;
    }
  }
}
