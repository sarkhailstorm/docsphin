import type { Face, FontBook } from './fonts';

const ELLIPSIS = '…';

/** Greedy word wrap for text that is all one size and style. */
export function wrapPlain(
  text: string,
  width: number,
  size: number,
  font: Face,
  book: FontBook,
  maxLines = Number.POSITIVE_INFINITY,
): string[] {
  if (!text) return [''];
  const room = Math.max(1, width);
  const out: string[] = [];

  for (const paragraph of text.split('\n')) {
    if (out.length >= maxLines) break;
    if (paragraph === '') {
      out.push('');
      continue;
    }
    if (book.width(paragraph, size, font) <= room) {
      out.push(paragraph);
      continue;
    }

    let line = '';
    for (const word of paragraph.split(/(\s+)/)) {
      if (word === '') continue;
      const candidate = line + word;
      if (book.width(candidate, size, font) <= room) {
        line = candidate;
        continue;
      }
      if (line.trim() !== '') {
        out.push(line.trimEnd());
        line = '';
        if (out.length >= maxLines) break;
      }
      if (/^\s+$/.test(word)) continue;
      // A single word too long for the column has to be cut mid-way
      let rest = word;
      while (book.width(rest, size, font) > room && out.length < maxLines) {
        const cut = fitCharacters(rest, room, size, font, book);
        out.push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
      line = rest;
    }
    if (line.trim() !== '' && out.length < maxLines) out.push(line.trimEnd());
  }

  if (out.length === 0) out.push('');
  if (out.length > maxLines) {
    const kept = out.slice(0, maxLines);
    kept[kept.length - 1] = `${kept[kept.length - 1].slice(0, -1)}${ELLIPSIS}`;
    return kept;
  }
  return out;
}

/** How many characters of `text` fit in `room`; always at least one. */
export function fitCharacters(
  text: string,
  room: number,
  size: number,
  font: Face,
  book: FontBook,
): number {
  let low = 1;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (book.width(text.slice(0, mid), size, font) <= room) low = mid;
    else high = mid - 1;
  }
  return Math.max(1, low);
}
