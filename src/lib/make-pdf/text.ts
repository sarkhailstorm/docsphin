// The 14 fonts built into every PDF reader only speak WinAnsi, so anything
// outside it has to be folded down to something close or dropped. Both are
// counted and reported rather than done quietly.

/** The 27 printable characters CP1252 puts in 0x80-0x9F. */
const CP1252_HIGH: ReadonlySet<number> = new Set([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152,
  0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a,
  0x0153, 0x017e, 0x0178,
]);

/** Letters with no accent to strip, so NFD leaves them exactly as they were. */
const LETTER_FOLDS: ReadonlyMap<string, string> = new Map(
  Object.entries({
    'ł': 'l', // ł
    'Ł': 'L', // Ł
    'đ': 'd', // đ
    'Đ': 'D', // Đ
    'ħ': 'h', // ħ
    'Ħ': 'H', // Ħ
    'ı': 'i', // ı
    'ŀ': 'l', // ŀ
    'Ŀ': 'L', // Ŀ
    'ŉ': 'n', // ŉ
    'ŧ': 't', // ŧ
    'Ŧ': 'T', // Ŧ
    'ſ': 's', // ſ
    'ȷ': 'j', // ȷ
    'ŋ': 'ng', // ŋ
    'Ŋ': 'NG', // Ŋ
    'ĳ': 'ij', // ĳ
    'Ĳ': 'IJ', // Ĳ
  }),
);

/** Punctuation and symbols with an obvious plain-text stand-in. */
const SYMBOL_FOLDS: ReadonlyMap<string, string> = new Map(
  Object.entries({
    ' ': ' ',
    ' ': ' ',
    ' ': ' ',
    ' ': ' ',
    '​': '',
    '﻿': '',
    '‐': '-',
    '‑': '-',
    '‒': '-',
    '―': '-',
    '−': '-',
    '⁃': '-',
    '′': "'",
    '″': '"',
    '‵': "'",
    '‶': '"',
    'ʼ': "'",
    '⁄': '/',
    '∕': '/',
    '∖': '\\',
    '․': '.',
    '‥': '..',
    '‧': '.',
    '∙': '·',
    '●': '·',
    '▪': '·',
    '■': '·',
    '○': 'o',
    '◦': 'o',
    '‣': '>',
    '→': '->',
    '←': '<-',
    '↔': '<->',
    '⇒': '=>',
    '⇔': '<=>',
    '≠': '!=',
    '≤': '<=',
    '≥': '>=',
    '≈': '~',
    '✓': 'v',
    '✔': 'v',
    '✗': 'x',
    '✘': 'x',
    '★': '*',
    '☆': '*',
    '₹': 'Rs.',
    '₽': 'RUB',
    '₩': 'KRW',
    '₦': 'NGN',
    '₺': 'TRY',
    '℠': '(SM)',
    '℗': '(P)',
    'Ω': 'Ohm',
  }),
);

const COMBINING = /\p{M}+/gu;

/** Folds nobody needs telling about: an odd space becomes an ordinary one. */
const SILENT: ReadonlySet<string> = new Set([
  '\u00a0',
  '\u2007',
  '\u2009',
  '\u202f',
  '\u200b',
  '\ufeff',
  '\u2010',
  '\u2011',
]);

/** Stands for "nothing could replace this" in the cache, which cannot hold undefined. */
const NOTHING = '\u0000';

export function isWinAnsi(codePoint: number): boolean {
  if (codePoint >= 0x20 && codePoint <= 0x7e) return true;
  if (codePoint >= 0xa1 && codePoint <= 0xff) return true;
  return CP1252_HIGH.has(codePoint);
}

/** Script name for the "could not draw these" note, in words a reader will know. */
export function scriptOf(codePoint: number): string {
  if (codePoint >= 0x0400 && codePoint <= 0x052f) return 'Cyrillic';
  if (codePoint >= 0x0370 && codePoint <= 0x03ff) return 'Greek';
  if (codePoint >= 0x0590 && codePoint <= 0x05ff) return 'Hebrew';
  if (codePoint >= 0x0600 && codePoint <= 0x06ff) return 'Arabic';
  if (codePoint >= 0x0900 && codePoint <= 0x097f) return 'Devanagari';
  if (codePoint >= 0x0980 && codePoint <= 0x0dff) return 'an Indian script';
  if (codePoint >= 0x0e00 && codePoint <= 0x0e7f) return 'Thai';
  if (codePoint >= 0x3040 && codePoint <= 0x30ff) return 'Japanese';
  if (codePoint >= 0x1100 && codePoint <= 0x11ff) return 'Korean';
  if (codePoint >= 0xac00 && codePoint <= 0xd7af) return 'Korean';
  if (codePoint >= 0x3400 && codePoint <= 0x9fff) return 'Chinese, Japanese or Korean';
  if (codePoint >= 0x1f000) return 'emoji';
  if (codePoint >= 0x0100 && codePoint <= 0x024f) return 'accented Latin';
  return 'symbols';
}

export interface FoldTally {
  /** Characters that survived only as a plainer stand-in, such as ł becoming l. */
  simplified: number;
  /** Characters with nothing close enough to put in their place. */
  dropped: number;
  /** Script names behind the dropped characters, most common first. */
  scripts: string[];
}

/** Rewrites text so every character left in it can be drawn, keeping a tally. */
export class Folder {
  private simplified = 0;
  private readonly droppedByScript = new Map<string, number>();
  private readonly cache = new Map<string, string>();

  fold(input: string): string {
    if (!input) return '';

    let plain = true;
    for (let i = 0; i < input.length; i += 1) {
      if (!isWinAnsi(input.charCodeAt(i))) {
        plain = false;
        break;
      }
    }
    if (plain) return input;

    let out = '';
    for (const char of input) {
      const codePoint = char.codePointAt(0) ?? 0;
      out += isWinAnsi(codePoint) ? char : this.replace(char, codePoint);
    }
    return out;
  }

  tally(): FoldTally {
    let dropped = 0;
    for (const count of this.droppedByScript.values()) dropped += count;
    const scripts = [...this.droppedByScript.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name]) => name);
    return { simplified: this.simplified, dropped, scripts };
  }

  private replace(char: string, codePoint: number): string {
    let stand = this.cache.get(char);
    if (stand === undefined) {
      stand = SYMBOL_FOLDS.get(char) ?? LETTER_FOLDS.get(char) ?? stripAccents(char) ?? NOTHING;
      this.cache.set(char, stand);
    }

    if (stand === NOTHING) {
      const script = scriptOf(codePoint);
      this.droppedByScript.set(script, (this.droppedByScript.get(script) ?? 0) + 1);
      return '';
    }

    if (!SILENT.has(char)) this.simplified += 1;
    return stand;
  }
}

function stripAccents(char: string): string | null {
  const bare = char.normalize('NFD').replace(COMBINING, '');
  if (!bare || bare === char) return null;
  for (const part of bare) {
    if (!isWinAnsi(part.codePointAt(0) ?? 0)) return null;
  }
  return bare;
}

/** Plain sentences for the report, or null when nothing was lost. */
export function describeFolding(tally: FoldTally): string | null {
  const parts: string[] = [];

  if (tally.simplified > 0) {
    const noun = tally.simplified === 1 ? 'character was' : 'characters were';
    parts.push(
      `${tally.simplified.toLocaleString()} ${noun} swapped for a plainer one — ł becomes l, for example — because the fonts built into PDF readers cannot draw them.`,
    );
  }

  if (tally.dropped > 0) {
    const noun = tally.dropped === 1 ? 'character' : 'characters';
    const scripts = tally.scripts.slice(0, 3).join(', ');
    parts.push(
      `${tally.dropped.toLocaleString()} ${noun} had to be left out${scripts ? ` (${scripts})` : ''}. This tool can only draw Latin letters so far.`,
    );
  }

  return parts.length > 0 ? parts.join(' ') : null;
}
