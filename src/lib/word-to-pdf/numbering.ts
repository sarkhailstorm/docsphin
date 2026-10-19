import { W, attr, deepAll, kid, number, twips, wVal } from './xml';
import type { StyleSheet } from './styles';
import type { RunStyle } from './types';

/** Word writes list bullets either as Unicode shapes or as Symbol and Wingdings code points. */
const BULLETS: Record<string, string> = {
  '\u25cf': '\u2022',
  '\u2022': '\u2022',
  '\u25cb': 'o',
  '\u25e6': 'o',
  '\u25a0': '-',
  '\u25aa': '-',
  '\u25ab': '-',
  '\u2043': '-',
  '\u2212': '-',
  '\u00b7': '\u00b7',
  '\u25c6': '-',
  '\u25ba': '>',
  '\uf0b7': '\u2022',
  '\uf0a7': '-',
  '\uf0d8': '>',
  '\uf0fc': 'v',
  '\uf06c': '\u2022',
  '\uf075': '-',
  '\uf0a8': '-',
  '\uf02d': '-',
  '\uf0e8': '>',
};

interface Level {
  start: number;
  format: string;
  text: string;
  indentLeft: number;
  hanging: number;
  rPr: Element | null;
}

interface ListDefinition {
  abstractId: string;
  startOverrides: Map<number, number>;
}

const ROMAN: readonly [number, string][] = [
  [1000, 'm'],
  [900, 'cm'],
  [500, 'd'],
  [400, 'cd'],
  [100, 'c'],
  [90, 'xc'],
  [50, 'l'],
  [40, 'xl'],
  [10, 'x'],
  [9, 'ix'],
  [5, 'v'],
  [4, 'iv'],
  [1, 'i'],
];

function roman(value: number): string {
  if (value <= 0 || value > 3999) return String(value);
  let left = value;
  let out = '';
  for (const [amount, letters] of ROMAN) {
    while (left >= amount) {
      out += letters;
      left -= amount;
    }
  }
  return out;
}

function letters(value: number): string {
  if (value <= 0) return '';
  let left = value;
  let out = '';
  while (left > 0) {
    const index = (left - 1) % 26;
    out = String.fromCharCode(97 + index) + out;
    left = Math.floor((left - 1) / 26);
  }
  return out;
}

function formatCount(value: number, format: string): string {
  switch (format) {
    case 'decimalZero':
      return value < 10 ? `0${value}` : String(value);
    case 'lowerLetter':
      return letters(value);
    case 'upperLetter':
      return letters(value).toUpperCase();
    case 'lowerRoman':
      return roman(value);
    case 'upperRoman':
      return roman(value).toUpperCase();
    case 'none':
      return '';
    default:
      return String(value);
  }
}

export interface ListMarker {
  text: string;
  style: RunStyle;
  indentLeft: number;
  hanging: number;
}

export class Numbering {
  private readonly abstracts = new Map<string, Map<number, Level>>();
  private readonly lists = new Map<string, ListDefinition>();
  private readonly counters = new Map<string, number[]>();

  constructor(
    doc: Document | null,
    private readonly styles: StyleSheet,
  ) {
    const root = doc?.documentElement ?? null;
    if (!root) return;

    for (const element of deepAll(root, W, 'abstractNum')) {
      const id = attr(element, W, 'abstractNumId');
      if (!id) continue;
      const levels = new Map<number, Level>();
      for (const lvl of deepAll(element, W, 'lvl')) {
        const index = number(attr(lvl, W, 'ilvl'), 0);
        const indent = kid(kid(lvl, W, 'pPr'), W, 'ind');
        levels.set(index, {
          start: number(wVal(kid(lvl, W, 'start')), 1),
          format: wVal(kid(lvl, W, 'numFmt')) ?? 'decimal',
          text: wVal(kid(lvl, W, 'lvlText')) ?? '',
          indentLeft: twips(attr(indent, W, 'left') ?? attr(indent, W, 'start')),
          hanging: twips(attr(indent, W, 'hanging')),
          rPr: kid(lvl, W, 'rPr'),
        });
      }
      this.abstracts.set(id, levels);
    }

    for (const element of deepAll(root, W, 'num')) {
      const id = attr(element, W, 'numId');
      const abstractId = wVal(kid(element, W, 'abstractNumId'));
      if (!id || !abstractId) continue;
      const startOverrides = new Map<number, number>();
      for (const override of deepAll(element, W, 'lvlOverride')) {
        const level = number(attr(override, W, 'ilvl'), 0);
        const start = wVal(kid(override, W, 'startOverride'));
        if (start !== null) startOverrides.set(level, number(start, 1));
      }
      this.lists.set(id, { abstractId, startOverrides });
    }
  }

  /** Counts the paragraph into its list and returns the bullet or number to draw. */
  next(numId: string, level: number, base: RunStyle): ListMarker | null {
    const list = this.lists.get(numId);
    if (!list) return null;
    const levels = this.abstracts.get(list.abstractId);
    const here = levels?.get(level);
    if (!here) return null;

    const counts = this.counters.get(numId) ?? [];
    const startOf = (index: number): number =>
      list.startOverrides.get(index) ?? levels?.get(index)?.start ?? 1;

    while (counts.length <= level) counts.push(startOf(counts.length) - 1);
    counts[level] += 1;
    for (let deeper = level + 1; deeper < counts.length; deeper += 1) {
      counts[deeper] = startOf(deeper) - 1;
    }
    this.counters.set(numId, counts);

    if (here.format === 'none' && here.text === '') return null;

    const style = this.styles.applyRunProps(here.rPr, base);
    const bullet = here.format === 'bullet';
    const text = bullet
      ? bulletText(here.text)
      : here.text.replace(/%(\d)/g, (whole, digit: string) => {
          const index = Number(digit) - 1;
          const at = counts[index];
          if (at === undefined) return whole;
          const format = levels?.get(index)?.format ?? 'decimal';
          return formatCount(Math.max(at, 0), format);
        });

    return {
      text,
      // A Symbol or Wingdings bullet is replaced, so its font must not come with it
      style: bullet ? { ...style, family: base.family, italic: false } : style,
      indentLeft: here.indentLeft,
      hanging: here.hanging,
    };
  }
}

function bulletText(raw: string): string {
  const first = raw.trim().charAt(0);
  if (!first) return '•';
  const mapped = BULLETS[first];
  if (mapped) return mapped;
  const code = first.codePointAt(0) ?? 0;
  // Anything else out of the private-use block is a font-specific dingbat
  return code >= 0xe000 && code <= 0xf8ff ? '•' : first;
}
