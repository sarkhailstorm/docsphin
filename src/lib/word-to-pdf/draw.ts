import type { PDFImage } from 'pdf-lib';
import { face, type Face, type FontBook } from '@/lib/make-pdf/fonts';
import type { Sheet } from '@/lib/make-pdf/sheet';
import { fitCharacters } from '@/lib/make-pdf/wrap';
import type { Folder } from '@/lib/make-pdf/text';
import { SHIFT_SCALE } from './styles';
import type { Block, Cell, Piece, Row, RunStyle, Table } from './types';

export interface Embedded {
  image: PDFImage;
  /** Natural size in points. */
  width: number;
  height: number;
}

export interface Pen {
  sheet: Sheet;
  book: FontBook;
  folder: Folder;
  images: Map<string, Embedded>;
  links: boolean;
  counts: { paragraphs: number; tables: number; images: number };
  /** Read when a PAGE field is painted. */
  page: { index: number; total: number };
}

/** A piece of a page that is placed as a whole, or not at all. */
export interface Atom {
  height: number;
  pageBreakBefore?: boolean;
  /** Spacing with nothing in it, which is dropped at the top of a page. */
  blank?: boolean;
  /** Set on table rows, so a row too tall for the page can be cut in two. */
  row?: RowPlan;
  rowOffset?: number;
  /** Header rows to draw again when this row lands on a new page. */
  repeat?: RowPlan[];
  paint(left: number, top: number): void;
}

const TAB = 36;
const CELL_PAD_X = 5.4;
const CELL_PAD_Y = 1;
const LINE_BOX = 1.2;
const DESCENDER = 0.24;
const UNDERLINE_DROP = 0.14;
const STRIKE_RISE = 0.26;
const SUPER_RISE = 0.33;
const SUB_DROP = 0.16;
const MIN_IMAGE = 2;

type Token =
  | { kind: 'word' | 'space'; text: string; style: RunStyle; size: number; font: Face; width: number }
  | { kind: 'field'; field: 'page' | 'pages'; style: RunStyle; size: number; font: Face; width: number }
  | { kind: 'tab' }
  | { kind: 'break' }
  | { kind: 'pageBreak' }
  | { kind: 'image'; embedded: Embedded; width: number; height: number; link: string | null };

interface Segment {
  token: Token;
  x: number;
  width: number;
}

const fontOf = (style: RunStyle): Face => face(style.family, style.bold, style.italic);
const fieldText = (field: 'page' | 'pages', pen: Pen): string =>
  String(field === 'pages' ? pen.page.total || pen.page.index : pen.page.index);
const sizeOf = (style: RunStyle): number =>
  style.shift ? Math.max(4, style.size * SHIFT_SCALE) : style.size;

function tokenise(pieces: readonly Piece[], pen: Pen): Token[] {
  const out: Token[] = [];

  for (const piece of pieces) {
    if (piece.kind === 'pageBreak') {
      out.push({ kind: 'pageBreak' });
      continue;
    }
    if (piece.kind === 'break') {
      out.push({ kind: 'break' });
      continue;
    }
    if (piece.kind === 'tab') {
      out.push({ kind: 'tab' });
      continue;
    }
    if (piece.kind === 'image') {
      const embedded = pen.images.get(piece.id);
      if (!embedded) continue;
      const width = piece.width > MIN_IMAGE ? piece.width : embedded.width;
      const height = piece.height > MIN_IMAGE ? piece.height : embedded.height;
      out.push({ kind: 'image', embedded, width, height, link: piece.link });
      pen.counts.images += 1;
      continue;
    }

    const style = piece.style;
    const size = sizeOf(style);
    const font = fontOf(style);

    if (piece.kind === 'field') {
      // Headers and footers are laid out page by page, so the real number is known
      out.push({
        kind: 'field',
        field: piece.field,
        style,
        size,
        font,
        width: pen.book.width(fieldText(piece.field, pen), size, font),
      });
      continue;
    }

    for (const part of pen.folder.fold(piece.text).split(/(\s+)/)) {
      if (part === '') continue;
      const space = /^\s+$/.test(part);
      const text = space ? ' ' : part;
      out.push({
        kind: space ? 'space' : 'word',
        text,
        style,
        size,
        font,
        width: pen.book.width(text, size, font),
      });
    }
  }

  return out;
}

function paintSegments(
  pen: Pen,
  segments: readonly Segment[],
  left: number,
  top: number,
  lineHeight: number,
  maxSize: number,
): void {
  const baseline = top + lineHeight - maxSize * DESCENDER;

  for (const segment of segments) {
    const token = segment.token;
    const x = left + segment.x;

    if (token.kind === 'image') {
      pen.sheet.image(token.embedded.image, x, top + (lineHeight - token.height), segment.width, token.height);
      if (token.link && pen.links) {
        pen.sheet.link(token.link, x, top + (lineHeight - token.height), segment.width, token.height);
      }
      continue;
    }
    if (token.kind === 'tab' || token.kind === 'break' || token.kind === 'pageBreak') continue;

    const text = token.kind === 'field' ? fieldText(token.field, pen) : token.text;
    if (text === '' || text === ' ') {
      if (token.kind !== 'field' && !token.style.underline && !token.style.highlight) continue;
    }

    const style = token.style;
    const shift = style.shift === 'super' ? -token.size * SUPER_RISE : style.shift === 'sub' ? token.size * SUB_DROP : 0;

    if (style.highlight) {
      pen.sheet.rect(x, top, segment.width, lineHeight, style.highlight);
    }

    pen.sheet.text(text, x, baseline + shift, token.size, token.font, pen.book, style.colour);

    if (style.underline) {
      const y = baseline + shift + token.size * UNDERLINE_DROP;
      pen.sheet.line(x, y, x + segment.width, y, Math.max(0.4, token.size * 0.055), style.colour);
    }
    if (style.strike) {
      const y = baseline + shift - token.size * STRIKE_RISE;
      pen.sheet.line(x, y, x + segment.width, y, Math.max(0.4, token.size * 0.05), style.colour);
    }
    if (style.link && pen.links && token.kind === 'word') {
      pen.sheet.link(style.link, x, top, segment.width, lineHeight);
    }
  }
}

interface LineDraft {
  segments: Segment[];
  width: number;
  maxSize: number;
  spaces: number;
  ended: 'wrap' | 'break' | 'last';
}

/** Greedy line breaking for one paragraph's worth of tokens. */
function breakIntoLines(
  tokens: readonly Token[],
  pen: Pen,
  firstWidth: number,
  restWidth: number,
  firstOffset: number,
): { lines: LineDraft[]; breaks: number[] } {
  const lines: LineDraft[] = [];
  const breaks: number[] = [];

  let segments: Segment[] = [];
  let cursor = 0;
  let maxSize = 0;
  let spaces = 0;
  let room = firstWidth;
  let offset = firstOffset;

  const flush = (ended: LineDraft['ended']): void => {
    lines.push({ segments, width: cursor, maxSize, spaces, ended });
    segments = [];
    cursor = 0;
    maxSize = 0;
    spaces = 0;
    room = restWidth;
    offset = 0;
  };

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];

    if (token.kind === 'pageBreak') {
      flush('break');
      breaks.push(lines.length);
      continue;
    }
    if (token.kind === 'break') {
      flush('break');
      continue;
    }

    if (token.kind === 'tab') {
      const at = offset + cursor;
      const next = Math.floor(at / TAB + 1.0001) * TAB;
      const step = Math.max(2, next - at);
      if (cursor + step > room && cursor > 0) {
        flush('wrap');
        continue;
      }
      segments.push({ token, x: cursor, width: step });
      cursor += step;
      continue;
    }

    if (token.kind === 'image') {
      let width = token.width;
      let height = token.height;
      if (width > restWidth) {
        height *= restWidth / width;
        width = restWidth;
      }
      if (cursor + width > room && cursor > 0) {
        flush('wrap');
        continue;
      }
      segments.push({ token, x: cursor, width });
      cursor += width;
      maxSize = Math.max(maxSize, height / LINE_BOX);
      continue;
    }

    if (token.kind === 'space') {
      // A space left stranded at the end of a line is dropped
      if (cursor === 0) continue;
      segments.push({ token, x: cursor, width: token.width });
      cursor += token.width;
      spaces += 1;
      maxSize = Math.max(maxSize, token.size);
      continue;
    }

    if (cursor + token.width <= room || cursor === 0) {
      if (token.width > room && cursor === 0 && token.kind === 'word') {
        // One unbroken run of characters wider than the column has to be cut
        let rest = token.text;
        while (pen.book.width(rest, token.size, token.font) > room && rest.length > 1) {
          const cut = fitCharacters(rest, room, token.size, token.font, pen.book);
          const head = rest.slice(0, cut);
          segments.push({
            token: { ...token, text: head, width: pen.book.width(head, token.size, token.font) },
            x: 0,
            width: pen.book.width(head, token.size, token.font),
          });
          maxSize = Math.max(maxSize, token.size);
          cursor = room;
          flush('wrap');
          rest = rest.slice(cut);
        }
        const width = pen.book.width(rest, token.size, token.font);
        segments.push({ token: { ...token, text: rest, width }, x: 0, width });
        cursor = width;
        maxSize = Math.max(maxSize, token.size);
        continue;
      }
      segments.push({ token, x: cursor, width: token.width });
      cursor += token.width;
      maxSize = Math.max(maxSize, token.size);
      continue;
    }

    flush('wrap');
    i -= 1;
  }

  flush('last');
  return { lines, breaks };
}

function compileParagraph(block: Extract<Block, { kind: 'para' }>, pen: Pen, width: number): Atom[] {
  pen.counts.paragraphs += 1;
  const { para, marker } = block;
  const atoms: Atom[] = [];

  const indentLeft = Math.max(0, Math.min(para.indentLeft, width - 20));
  const indentRight = Math.max(0, Math.min(para.indentRight, width - indentLeft - 20));
  const body = Math.max(20, width - indentLeft - indentRight);

  let markerX = indentLeft;
  let firstOffset = Math.max(-indentLeft, para.firstLine);

  if (marker) {
    const style = marker.style;
    const width = pen.book.width(pen.folder.fold(marker.text), sizeOf(style), fontOf(style));
    markerX = Math.max(0, indentLeft + firstOffset);
    // Text on the first line has to clear the bullet or number
    firstOffset = Math.max(0, markerX + width + 3 - indentLeft);
  }

  const firstWidth = Math.max(20, body - firstOffset);
  const tokens = tokenise(block.pieces, pen);
  const { lines, breaks } = breakIntoLines(tokens, pen, firstWidth, body, firstOffset);

  const base = block.base;
  const lineHeightOf = (maxSize: number): number => {
    const size = maxSize > 0 ? maxSize : base.size;
    return para.lineExact > 0 ? para.lineExact : size * LINE_BOX * para.lineFactor;
  };

  if (para.spaceBefore > 0) atoms.push({ height: para.spaceBefore, blank: true, paint: () => {} });

  lines.forEach((line, index) => {
    const first = index === 0;
    const last = index === lines.length - 1;
    const maxSize = line.maxSize > 0 ? line.maxSize : base.size;
    const height = lineHeightOf(line.maxSize);
    const start = indentLeft + (first ? firstOffset : 0);
    const room = first ? firstWidth : body;

    let shift = 0;
    let stretch = 0;
    if (para.align === 'right') shift = room - line.width;
    else if (para.align === 'centre') shift = (room - line.width) / 2;
    else if (para.align === 'justify' && line.ended === 'wrap' && line.spaces > 0) {
      stretch = (room - line.width) / line.spaces;
    }
    if (shift < 0) shift = 0;

    const segments = stretch > 0 ? spread(line.segments, stretch) : line.segments;
    const pageBreak = breaks.includes(index);

    atoms.push({
      height,
      pageBreakBefore: pageBreak || (first && para.pageBreakBefore),
      paint: (left, top) => {
        if (para.shading) pen.sheet.rect(left, top, width, height, para.shading);
        if (first && para.borderTop) {
          pen.sheet.line(left, top, left + width, top, para.borderTop.size, para.borderTop.colour);
        }
        if (marker && first) {
          const style = marker.style;
          pen.sheet.text(
            pen.folder.fold(marker.text),
            left + markerX,
            top + height - maxSize * DESCENDER,
            sizeOf(style),
            fontOf(style),
            pen.book,
            style.colour,
          );
        }
        paintSegments(pen, segments, left + start + shift, top, height, maxSize);
        if (last && para.borderBottom) {
          const y = top + height;
          pen.sheet.line(left, y, left + width, y, para.borderBottom.size, para.borderBottom.colour);
        }
      },
    });
  });

  if (para.spaceAfter > 0) atoms.push({ height: para.spaceAfter, blank: true, paint: () => {} });
  return atoms;
}

function spread(segments: readonly Segment[], stretch: number): Segment[] {
  let extra = 0;
  return segments.map((segment) => {
    const moved = { ...segment, x: segment.x + extra };
    if (segment.token.kind === 'space') {
      moved.width = segment.width + stretch;
      extra += stretch;
    }
    return moved;
  });
}

export function compile(blocks: readonly Block[], pen: Pen, width: number, depth = 0): Atom[] {
  const atoms: Atom[] = [];
  for (const block of blocks) {
    if (block.kind === 'para') atoms.push(...compileParagraph(block, pen, width));
    else atoms.push(...compileTable(block.table, pen, width, depth));
  }
  return atoms;
}

interface CellPlan {
  cell: Cell;
  atoms: Atom[];
  x: number;
  width: number;
}

interface RowPlan {
  row: Row;
  cells: CellPlan[];
  height: number;
  width: number;
}

function columnWidths(table: Table, width: number, target: number): number[] {
  const grid = table.widths.filter((value) => value > 0);
  const needed = Math.max(...table.rows.map((row) => row.cells.reduce((n, c) => n + c.span, 0)), 1);

  let widths = grid.length >= needed ? grid.slice(0, needed) : grid.slice();
  while (widths.length < needed) widths.push(0);

  const known = widths.reduce((sum, value) => sum + value, 0);
  if (known <= 0) return new Array(needed).fill(width / needed);

  const blanks = widths.filter((value) => value <= 0).length;
  if (blanks > 0) {
    const spare = Math.max(0, width - known) / blanks;
    widths = widths.map((value) => (value > 0 ? value : Math.max(20, spare)));
  }

  const total = widths.reduce((sum, value) => sum + value, 0);
  // The grid is only a set of proportions once the table states its own width
  const wanted = target > 0 ? target : Math.min(total, width);
  const scale = total > 0 ? wanted / total : 1;
  return widths.map((value) => value * scale);
}

function planRow(row: Row, widths: number[], pen: Pen, depth: number): RowPlan {
  const cells: CellPlan[] = [];
  let column = 0;
  let x = 0;
  let tallest = 0;

  for (const cell of row.cells) {
    let width = 0;
    for (let i = column; i < Math.min(column + cell.span, widths.length); i += 1) width += widths[i];
    if (width <= 0) width = widths[Math.min(column, widths.length - 1)] ?? 40;

    const inner = Math.max(16, width - CELL_PAD_X * 2);
    const atoms = cell.vMerge === 'continue' ? [] : compile(cell.blocks, pen, inner, depth + 1);
    const height = atoms.reduce((sum, atom) => sum + atom.height, 0);
    if (height > tallest) tallest = height;

    cells.push({ cell, atoms, x, width });
    x += width;
    column += cell.span;
  }

  const total = widths.reduce((sum, value) => sum + value, 0);
  return {
    row,
    cells,
    height: Math.max(row.minHeight, tallest + CELL_PAD_Y * 2, 8),
    width: Math.max(total, x),
  };
}

function paintRow(plan: RowPlan, pen: Pen, left: number, top: number): void {
  for (const cell of plan.cells) {
    const x = left + cell.x;
    if (cell.cell.shading) pen.sheet.rect(x, top, cell.width, plan.height, cell.cell.shading);
  }

  for (const cell of plan.cells) {
    const x = left + cell.x;
    const content = cell.atoms.reduce((sum, atom) => sum + atom.height, 0);
    const spare = Math.max(0, plan.height - CELL_PAD_Y * 2 - content);
    const offset =
      cell.cell.align === 'centre' ? spare / 2 : cell.cell.align === 'bottom' ? spare : 0;

    let y = top + CELL_PAD_Y + offset;
    for (const atom of cell.atoms) {
      atom.paint(x + CELL_PAD_X, y);
      y += atom.height;
    }
  }

  for (const cell of plan.cells) {
    const x = left + cell.x;
    const borders = cell.cell.borders;
    const bottom = top + plan.height;
    if (borders.top && cell.cell.vMerge !== 'continue') {
      pen.sheet.line(x, top, x + cell.width, top, borders.top.size, borders.top.colour);
    }
    if (borders.bottom && cell.cell.vMerge !== 'start') {
      pen.sheet.line(x, bottom, x + cell.width, bottom, borders.bottom.size, borders.bottom.colour);
    }
    if (borders.left) pen.sheet.line(x, top, x, bottom, borders.left.size, borders.left.colour);
    if (borders.right) {
      const right = x + cell.width;
      pen.sheet.line(right, top, right, bottom, borders.right.size, borders.right.colour);
    }
  }
}

/** Takes as many atoms from each cell as will fit, leaving the rest for the next page. */
function splitRow(plan: RowPlan, available: number): [RowPlan, RowPlan | null] {
  const room = available - CELL_PAD_Y * 2;
  if (room <= 0) return [plan, null];

  const heads: CellPlan[] = [];
  const tails: CellPlan[] = [];
  let used = 0;
  let left = false;

  for (const cell of plan.cells) {
    let taken = 0;
    let at = 0;
    while (at < cell.atoms.length && taken + cell.atoms[at].height <= room) {
      taken += cell.atoms[at].height;
      at += 1;
    }
    if (at === 0 && cell.atoms.length > 0) {
      taken = cell.atoms[0].height;
      at = 1;
    }
    heads.push({ ...cell, atoms: cell.atoms.slice(0, at) });
    const rest = cell.atoms.slice(at);
    if (rest.length > 0) left = true;
    tails.push({ ...cell, atoms: rest });
    used = Math.max(used, taken);
  }

  if (!left) return [plan, null];

  const head: RowPlan = { ...plan, cells: heads, height: Math.max(used + CELL_PAD_Y * 2, 8) };
  const tallest = Math.max(
    0,
    ...tails.map((cell) => cell.atoms.reduce((sum, atom) => sum + atom.height, 0)),
  );
  const tail: RowPlan = { ...plan, cells: tails, height: Math.max(tallest + CELL_PAD_Y * 2, 8) };
  return [head, tail];
}

function targetWidth(table: Table, available: number): number {
  if (table.width.type === 'pct') return Math.min(available, available * table.width.value);
  if (table.width.type === 'dxa') return Math.min(available, table.width.value);
  return 0;
}

function compileTable(table: Table, pen: Pen, width: number, depth: number): Atom[] {
  pen.counts.tables += 1;
  const indent = Math.max(0, Math.min(table.indent, width / 2));
  const available = width - indent;
  const widths = columnWidths(table, available, targetWidth(table, available));
  const total = widths.reduce((sum, value) => sum + value, 0);
  const offset =
    indent +
    (table.align === 'centre'
      ? Math.max(0, (width - indent - total) / 2)
      : table.align === 'right'
        ? Math.max(0, width - indent - total)
        : 0);

  const plans = table.rows.map((row) => planRow(row, widths, pen, depth));
  // Word marks the rows it wants repeated at the top of every page
  const repeat: RowPlan[] = [];
  for (const plan of plans) {
    if (!plan.row.header) break;
    repeat.push(plan);
  }

  return plans.map((plan, index) => ({
    height: plan.height,
    row: plan,
    rowOffset: offset,
    repeat: index >= repeat.length && repeat.length > 0 ? repeat : undefined,
    paint: (left: number, top: number) => paintRow(plan, pen, left + offset, top),
  }));
}

/** Lays atoms down the page, starting new pages as needed. */
export function flow(atoms: readonly Atom[], pen: Pen, onPage: () => void): void {
  const sheet = pen.sheet;
  if (!sheet.started) {
    sheet.newPage();
    onPage();
  }

  const startPage = (atom?: Atom): void => {
    sheet.newPage();
    onPage();
    if (!atom?.repeat) return;
    for (const plan of atom.repeat) {
      paintRow(plan, pen, sheet.left + (atom.rowOffset ?? 0), sheet.y);
      sheet.y += plan.height;
    }
  };

  const queue = [...atoms];
  let movedOn: Atom | null = null;

  while (queue.length > 0) {
    const atom = queue.shift();
    if (!atom) break;

    if (atom.pageBreakBefore && sheet.y > sheet.top) startPage(atom);
    if (atom.blank && sheet.y <= sheet.top + 0.01) continue;

    if (atom.height <= sheet.floor - sheet.y + 0.01) {
      atom.paint(sheet.left, sheet.y);
      sheet.y += atom.height;
      continue;
    }

    if (atom.row && sheet.floor - sheet.y > 24) {
      const offset = atom.rowOffset ?? 0;
      const [head, tail] = splitRow(atom.row, sheet.floor - sheet.y);
      if (tail) {
        paintRow(head, pen, sheet.left + offset, sheet.y);
        sheet.y += head.height;
        queue.unshift({
          height: tail.height,
          row: tail,
          rowOffset: offset,
          repeat: atom.repeat,
          paint: (left, top) => paintRow(tail, pen, left + offset, top),
        });
        continue;
      }
    }

    if (sheet.y > sheet.top && movedOn !== atom) {
      movedOn = atom;
      startPage(atom);
      queue.unshift(atom);
      continue;
    }

    // Taller than a whole empty page: draw it and move on rather than loop
    atom.paint(sheet.left, sheet.y);
    sheet.y = sheet.floor;
  }
}
