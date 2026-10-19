import { face, type FontBook } from '@/lib/make-pdf/fonts';
import type { Sheet } from '@/lib/make-pdf/sheet';
import type { Folder } from '@/lib/make-pdf/text';
import { wrapPlain } from '@/lib/make-pdf/wrap';
import type { Align, GridCell, SheetGrid } from './types';

const PAD_X = 3;
const PAD_Y = 2.5;
const LINE_FACTOR = 1.22;
/** Text never shrinks past this, however much squeezing is asked for. */
const MIN_SIZE = 4.5;
/** Below this the result is legible only when zoomed in, so say so. */
const TIGHT = 0.45;
const MAX_CELL_LINES = 12;
const GRID_COLOUR = '#c9ccd1';
const INK = '#17181a';
const RULE = 0.4;

const PLAIN = face('sans');
const STRONG = face('sans', true);

interface Band {
  /** Original column indices, left to right. */
  columns: number[];
  widths: number[];
  width: number;
}

interface CellPlan {
  slot: number;
  span: number;
  lines: string[];
  align: Align;
  bold: boolean;
}

interface RowPlan {
  row: number;
  height: number;
  cells: CellPlan[];
}

export interface RenderOptions {
  size: number;
  gridlines: boolean;
  repeatHeader: boolean;
  fitWidth: boolean;
}

export interface RenderResult {
  rows: number;
  columns: number;
  /** Columns and text were scaled down to fit the page width. */
  shrunk: boolean;
  /** Squeezed so hard that the text is barely readable. */
  tight: boolean;
  /** Too wide to fit, so the remaining columns went onto their own pages. */
  split: boolean;
}

// A hair of slack, or rounding alone pushes the last column onto its own page
const SLACK = 0.5;

function bandsFor(columns: number[], widths: number[], available: number): Band[] {
  const bands: Band[] = [];
  let current: Band = { columns: [], widths: [], width: 0 };

  for (let i = 0; i < columns.length; i += 1) {
    const width = Math.min(widths[i], available);
    if (current.columns.length > 0 && current.width + width > available + SLACK) {
      bands.push(current);
      current = { columns: [], widths: [], width: 0 };
    }
    current.columns.push(columns[i]);
    current.widths.push(width);
    current.width += width;
  }

  if (current.columns.length > 0) bands.push(current);
  return bands;
}

function planRow(
  grid: SheetGrid,
  row: number,
  band: Band,
  book: FontBook,
  folder: Folder,
  options: RenderOptions,
  ceiling: number,
): RowPlan {
  const lineHeight = options.size * LINE_FACTOR;
  const cells: CellPlan[] = [];
  let tallest = 1;

  for (let slot = 0; slot < band.columns.length; slot += 1) {
    const cell: GridCell | undefined = grid.rows[row]?.[band.columns[slot]];
    if (!cell || cell.covered) continue;

    const span = Math.min(cell.colSpan, band.columns.length - slot);
    let width = 0;
    for (let i = slot; i < slot + span; i += 1) width += band.widths[i];

    const font = cell.bold ? STRONG : PLAIN;
    const text = folder.fold(cell.text);
    const lines = text
      ? wrapPlain(text, width - PAD_X * 2, options.size, font, book, MAX_CELL_LINES)
      : [];

    if (lines.length > tallest) tallest = lines.length;
    if (lines.length > 0) {
      cells.push({ slot, span, lines, align: cell.align, bold: cell.bold });
    }
  }

  const natural = tallest * lineHeight + PAD_Y * 2;
  const height = Math.max(grid.rowHeights[row] || 0, natural);
  return { row, height: Math.min(height, ceiling), cells };
}

function drawRow(
  sheet: Sheet,
  book: FontBook,
  band: Band,
  plan: RowPlan,
  grid: SheetGrid,
  options: RenderOptions,
  top: number,
): void {
  const lineHeight = options.size * LINE_FACTOR;
  const xs: number[] = [];
  let x = sheet.left;
  for (const width of band.widths) {
    xs.push(x);
    x += width;
  }
  const rightEdge = x;

  for (const cell of plan.cells) {
    const font = cell.bold ? STRONG : PLAIN;
    let width = 0;
    for (let i = cell.slot; i < cell.slot + cell.span; i += 1) width += band.widths[i];
    const boxLeft = xs[cell.slot] + PAD_X;
    const boxWidth = width - PAD_X * 2;

    cell.lines.forEach((line, i) => {
      const baseline = top + PAD_Y + options.size + i * lineHeight;
      if (baseline > top + plan.height) return;
      const textWidth = book.width(line, options.size, font);
      let left = boxLeft;
      if (cell.align === 'right') left = boxLeft + Math.max(0, boxWidth - textWidth);
      else if (cell.align === 'centre') left = boxLeft + Math.max(0, (boxWidth - textWidth) / 2);
      sheet.text(line, left, baseline, options.size, font, book, INK);
    });
  }

  if (!options.gridlines) return;

  for (let slot = 0; slot < band.columns.length; slot += 1) {
    const cell = grid.rows[plan.row]?.[band.columns[slot]];
    // A cell carried down from a merge above has no line across its top
    if (cell?.covered && cell.anchorRow < plan.row) continue;
    sheet.line(xs[slot], top, xs[slot] + band.widths[slot], top, RULE, GRID_COLOUR);
  }

  for (let slot = 0; slot <= band.columns.length; slot += 1) {
    if (slot > 0 && slot < band.columns.length) {
      const cell = grid.rows[plan.row]?.[band.columns[slot]];
      // Inside a merge that runs left to right, so no line down its left
      if (cell?.covered && cell.anchorColumn < band.columns[slot]) continue;
    }
    const at = slot === band.columns.length ? rightEdge : xs[slot];
    sheet.line(at, top, at, top + plan.height, RULE, GRID_COLOUR);
  }
}

function headerRowOf(grid: SheetGrid): number {
  for (let r = 0; r < grid.rows.length; r += 1) {
    if (grid.hiddenRows[r]) continue;
    if (grid.rows[r].some((cell) => cell.text !== '')) return r;
  }
  return -1;
}

export function drawSheet(
  grid: SheetGrid,
  sheet: Sheet,
  book: FontBook,
  folder: Folder,
  options: RenderOptions,
  onPage: () => void,
): RenderResult {
  const columns: number[] = [];
  const widths: number[] = [];
  for (let c = 0; c < grid.columnCount; c += 1) {
    if (grid.columnWidths[c] > 0) {
      columns.push(c);
      widths.push(grid.columnWidths[c]);
    }
  }

  const rows: number[] = [];
  for (let r = 0; r < grid.rows.length; r += 1) {
    if (!grid.hiddenRows[r]) rows.push(r);
  }

  const empty = { rows: 0, columns: 0, shrunk: false, tight: false, split: false };
  if (columns.length === 0 || rows.length === 0) return empty;

  const available = sheet.contentWidth;
  const total = widths.reduce((sum, w) => sum + w, 0);
  let shrunk = false;
  let tight = false;
  let size = options.size;

  // Squeezing means squeezing: scale the text with the columns and keep one band
  if (options.fitWidth && total > available) {
    const scale = available / total;
    for (let i = 0; i < widths.length; i += 1) widths[i] *= scale;
    size = Math.max(MIN_SIZE, options.size * scale);
    shrunk = true;
    tight = scale < TIGHT;
  }

  const drawing = { ...options, size };
  const bands = bandsFor(columns, widths, available);
  const header = options.repeatHeader ? headerRowOf(grid) : -1;
  const ceiling = sheet.contentHeight;

  for (const band of bands) {
    sheet.newPage();
    onPage();

    const headerPlan =
      header >= 0 ? planRow(grid, header, band, book, folder, drawing, ceiling) : null;
    let bottom = sheet.top;

    if (headerPlan) {
      drawRow(sheet, book, band, headerPlan, grid, drawing, bottom);
      bottom += headerPlan.height;
    }

    for (const row of rows) {
      if (row === header && headerPlan) continue;
      const plan = planRow(grid, row, band, book, folder, drawing, ceiling);

      if (bottom + plan.height > sheet.floor && bottom > sheet.top) {
        if (options.gridlines) {
          sheet.line(sheet.left, bottom, sheet.left + band.width, bottom, RULE, GRID_COLOUR);
        }
        sheet.newPage();
        onPage();
        bottom = sheet.top;
        if (headerPlan) {
          drawRow(sheet, book, band, headerPlan, grid, drawing, bottom);
          bottom += headerPlan.height;
        }
      }

      drawRow(sheet, book, band, plan, grid, drawing, bottom);
      bottom += plan.height;
    }

    if (options.gridlines && bottom > sheet.top) {
      sheet.line(sheet.left, bottom, sheet.left + band.width, bottom, RULE, GRID_COLOUR);
    }
  }

  return { rows: rows.length, columns: columns.length, shrunk, tight, split: bands.length > 1 };
}
