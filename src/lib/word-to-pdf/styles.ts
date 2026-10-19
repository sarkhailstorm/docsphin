import { familyFor } from '@/lib/make-pdf/fonts';
import {
  A,
  W,
  attr,
  deep,
  deepAll,
  flag,
  halfPoints,
  hexColour,
  kid,
  number,
  twips,
  wVal,
} from './xml';
import {
  DEFAULT_PARA,
  DEFAULT_RUN,
  type Align,
  type Border,
  type ParaStyle,
  type RunStyle,
} from './types';

const HIGHLIGHTS: Record<string, string> = {
  black: '#000000',
  blue: '#0000ff',
  cyan: '#00ffff',
  darkBlue: '#000080',
  darkCyan: '#008080',
  darkGray: '#808080',
  darkGreen: '#008000',
  darkMagenta: '#800080',
  darkRed: '#800000',
  darkYellow: '#808000',
  green: '#00ff00',
  lightGray: '#c0c0c0',
  magenta: '#ff00ff',
  red: '#ff0000',
  white: '#ffffff',
  yellow: '#ffff00',
};

const ALIGNMENTS: Record<string, Align> = {
  left: 'left',
  start: 'left',
  center: 'centre',
  centre: 'centre',
  right: 'right',
  end: 'right',
  both: 'justify',
  justify: 'justify',
  distribute: 'justify',
};

/** Superscript and subscript are drawn smaller, the way Word does it. */
export const SHIFT_SCALE = 0.62;

export interface TableBorderSet {
  top: Border | null;
  bottom: Border | null;
  left: Border | null;
  right: Border | null;
  insideH: Border | null;
  insideV: Border | null;
}

export function readBorder(element: Element | null): Border | null {
  if (!element) return null;
  const kind = wVal(element);
  if (!kind || kind === 'nil' || kind === 'none') return null;
  // w:sz is in eighths of a point, and zero still draws a hairline
  const size = Math.max(0.4, number(attr(element, W, 'sz'), 4) / 8);
  return { size: Math.min(size, 6), colour: hexColour(attr(element, W, 'color'), '#000000') };
}

export function readBorderSet(container: Element | null): TableBorderSet | null {
  if (!container) return null;
  return {
    top: readBorder(kid(container, W, 'top')),
    bottom: readBorder(kid(container, W, 'bottom')),
    left: readBorder(kid(container, W, 'left') ?? kid(container, W, 'start')),
    right: readBorder(kid(container, W, 'right') ?? kid(container, W, 'end')),
    insideH: readBorder(kid(container, W, 'insideH')),
    insideV: readBorder(kid(container, W, 'insideV')),
  };
}

function shadingOf(element: Element | null): string | null {
  const shd = kid(element, W, 'shd');
  if (!shd) return null;
  const pattern = wVal(shd);
  if (pattern === 'clear' || pattern === 'nil' || pattern === null) {
    const fill = attr(shd, W, 'fill');
    if (!fill || fill === 'auto') return null;
    return hexColour(fill, '#ffffff');
  }
  const fill = attr(shd, W, 'fill');
  return fill && fill !== 'auto' ? hexColour(fill, '#ffffff') : null;
}

interface StyleEntry {
  type: string;
  basedOn: string | null;
  pPr: Element | null;
  rPr: Element | null;
  tblPr: Element | null;
  isDefault: boolean;
}

const MAX_CHAIN = 12;

export class StyleSheet {
  private readonly entries = new Map<string, StyleEntry>();
  private readonly themeFonts = new Map<string, string>();
  private readonly runCache = new Map<string, RunStyle>();
  private readonly paraCache = new Map<string, ParaStyle>();

  readonly baseRun: RunStyle;
  readonly basePara: ParaStyle;
  readonly defaultParagraphStyle: string | null;

  constructor(styles: Document | null, theme: Document | null) {
    this.readTheme(theme);

    const root = styles?.documentElement ?? null;
    for (const style of deepAll(root, W, 'style')) {
      const id = attr(style, W, 'styleId');
      if (!id) continue;
      this.entries.set(id, {
        type: attr(style, W, 'type') ?? 'paragraph',
        basedOn: wVal(kid(style, W, 'basedOn')),
        pPr: kid(style, W, 'pPr'),
        rPr: kid(style, W, 'rPr'),
        tblPr: kid(style, W, 'tblPr'),
        isDefault: attr(style, W, 'default') === '1',
      });
    }

    const defaults = deep(root, W, 'docDefaults');
    this.baseRun = this.applyRunProps(
      kid(kid(defaults, W, 'rPrDefault'), W, 'rPr'),
      DEFAULT_RUN,
    );
    this.basePara = this.applyParaProps(
      kid(kid(defaults, W, 'pPrDefault'), W, 'pPr'),
      DEFAULT_PARA,
    );

    let fallback: string | null = null;
    for (const [id, entry] of this.entries) {
      if (entry.type === 'paragraph' && entry.isDefault) {
        fallback = id;
        break;
      }
    }
    this.defaultParagraphStyle = fallback;
  }

  private readTheme(theme: Document | null): void {
    if (!theme) return;
    const scheme = deep(theme.documentElement, A, 'fontScheme');
    for (const [key, name] of [
      ['minor', 'minorFont'],
      ['major', 'majorFont'],
    ] as const) {
      const latin = kid(kid(scheme, A, name), A, 'latin');
      const typeface = latin?.getAttribute('typeface');
      if (typeface) this.themeFonts.set(key, typeface);
    }
  }

  /** Font named by a theme reference such as minorHAnsi. */
  private themeFont(reference: string | null): string | null {
    if (!reference) return null;
    const key = reference.startsWith('major') ? 'major' : 'minor';
    return this.themeFonts.get(key) ?? null;
  }

  /** Run style of a named style, with its basedOn chain folded in. */
  runOfStyle(styleId: string | null): RunStyle {
    if (!styleId) return this.baseRun;
    const cached = this.runCache.get(styleId);
    if (cached) return cached;

    let style = this.baseRun;
    for (const entry of this.chain(styleId)) style = this.applyRunProps(entry.rPr, style);
    this.runCache.set(styleId, style);
    return style;
  }

  paraOfStyle(styleId: string | null): ParaStyle {
    if (!styleId) return this.basePara;
    const cached = this.paraCache.get(styleId);
    if (cached) return cached;

    let style = this.basePara;
    for (const entry of this.chain(styleId)) style = this.applyParaProps(entry.pPr, style);
    this.paraCache.set(styleId, style);
    return style;
  }

  /** Numbering a paragraph style carries, which is how most list styles work. */
  numberingOfStyle(styleId: string | null): { numId: string; level: number } | null {
    if (!styleId) return null;
    const chain = this.chain(styleId);
    for (let i = chain.length - 1; i >= 0; i -= 1) {
      const numPr = kid(chain[i].pPr, W, 'numPr');
      const numId = wVal(kid(numPr, W, 'numId'));
      if (numId) return { numId, level: number(wVal(kid(numPr, W, 'ilvl')), 0) };
    }
    return null;
  }

  tableBordersOfStyle(styleId: string | null): TableBorderSet | null {
    if (!styleId) return null;
    for (const entry of this.chain(styleId).reverse()) {
      const borders = readBorderSet(kid(entry.tblPr, W, 'tblBorders'));
      if (borders) return borders;
    }
    return null;
  }

  /** Root ancestor first, so the nearest style wins. */
  private chain(styleId: string): StyleEntry[] {
    const out: StyleEntry[] = [];
    let current: string | null = styleId;
    for (let i = 0; i < MAX_CHAIN && current; i += 1) {
      const entry: StyleEntry | undefined = this.entries.get(current);
      if (!entry) break;
      out.unshift(entry);
      current = entry.basedOn;
    }
    return out;
  }

  applyRunProps(rPr: Element | null, base: RunStyle): RunStyle {
    if (!rPr) return base;
    let style = { ...base };

    const rStyle = wVal(kid(rPr, W, 'rStyle'));
    if (rStyle) style = { ...this.runOfStyle(rStyle) };

    const fonts = kid(rPr, W, 'rFonts');
    if (fonts) {
      const name =
        attr(fonts, W, 'ascii') ??
        attr(fonts, W, 'hAnsi') ??
        this.themeFont(attr(fonts, W, 'asciiTheme') ?? attr(fonts, W, 'hAnsiTheme')) ??
        attr(fonts, W, 'cs');
      if (name) style.family = familyFor(name);
    }

    const bold = flag(kid(rPr, W, 'b'));
    if (bold !== null) style.bold = bold;
    const italic = flag(kid(rPr, W, 'i'));
    if (italic !== null) style.italic = italic;

    const underline = kid(rPr, W, 'u');
    if (underline) style.underline = (wVal(underline) ?? 'single') !== 'none';

    const strike = flag(kid(rPr, W, 'strike'));
    const doubleStrike = flag(kid(rPr, W, 'dstrike'));
    if (strike !== null || doubleStrike !== null) style.strike = strike === true || doubleStrike === true;

    const size = kid(rPr, W, 'sz');
    if (size) style.size = Math.min(400, Math.max(1, halfPoints(wVal(size), base.size)));

    const colour = kid(rPr, W, 'color');
    if (colour) style.colour = hexColour(wVal(colour), base.colour);

    const highlight = kid(rPr, W, 'highlight');
    if (highlight) {
      const name = wVal(highlight) ?? 'none';
      style.highlight = name === 'none' ? null : (HIGHLIGHTS[name] ?? null);
    }
    const shaded = shadingOf(rPr);
    if (shaded) style.highlight = shaded;

    const vertical = kid(rPr, W, 'vertAlign');
    if (vertical) {
      const value = wVal(vertical);
      style.shift = value === 'superscript' ? 'super' : value === 'subscript' ? 'sub' : null;
    }

    const caps = flag(kid(rPr, W, 'caps')) ?? flag(kid(rPr, W, 'smallCaps'));
    if (caps !== null) style.caps = caps;

    const hidden = flag(kid(rPr, W, 'vanish'));
    if (hidden !== null) style.hidden = hidden;

    return style;
  }

  applyParaProps(pPr: Element | null, base: ParaStyle): ParaStyle {
    if (!pPr) return base;
    let style = { ...base };

    const pStyle = wVal(kid(pPr, W, 'pStyle'));
    if (pStyle) style = { ...this.paraOfStyle(pStyle) };

    const jc = wVal(kid(pPr, W, 'jc'));
    if (jc) style.align = ALIGNMENTS[jc] ?? style.align;

    const indent = kid(pPr, W, 'ind');
    if (indent) {
      const left = attr(indent, W, 'left') ?? attr(indent, W, 'start');
      const right = attr(indent, W, 'right') ?? attr(indent, W, 'end');
      if (left !== null) style.indentLeft = twips(left);
      if (right !== null) style.indentRight = twips(right);
      const hanging = attr(indent, W, 'hanging');
      const firstLine = attr(indent, W, 'firstLine');
      if (hanging !== null) style.firstLine = -twips(hanging);
      else if (firstLine !== null) style.firstLine = twips(firstLine);
    }

    const spacing = kid(pPr, W, 'spacing');
    if (spacing) {
      const before = attr(spacing, W, 'before');
      const after = attr(spacing, W, 'after');
      if (before !== null) style.spaceBefore = twips(before);
      if (after !== null) style.spaceAfter = twips(after);
      const line = attr(spacing, W, 'line');
      if (line !== null) {
        const rule = attr(spacing, W, 'lineRule') ?? 'auto';
        if (rule === 'auto') {
          style.lineFactor = Math.max(0.5, number(line, 240) / 240);
          style.lineExact = 0;
        } else {
          style.lineExact = twips(line);
        }
      }
    }

    const breakBefore = flag(kid(pPr, W, 'pageBreakBefore'));
    if (breakBefore !== null) style.pageBreakBefore = breakBefore;
    const keepNext = flag(kid(pPr, W, 'keepNext'));
    if (keepNext !== null) style.keepNext = keepNext;

    const shading = shadingOf(pPr);
    if (shading !== null) style.shading = shading;

    const borders = kid(pPr, W, 'pBdr');
    if (borders) {
      style.borderTop = readBorder(kid(borders, W, 'top'));
      style.borderBottom = readBorder(kid(borders, W, 'bottom'));
    }

    const outline = kid(pPr, W, 'outlineLvl');
    if (outline) style.outline = Math.min(9, number(wVal(outline), 9) + 1);

    return style;
  }
}
