import type { CellObject, WorkSheet } from 'xlsx';
import { extension } from '@/lib/format';
import type { Align, GridCell, SheetGrid, Workbook } from './types';

export const MAX_BYTES = 60 * 1024 * 1024;
export const MAX_ROWS = 20_000;
export const MAX_COLUMNS = 256;

export const ACCEPTED: readonly string[] = [
  'xlsx',
  'xlsm',
  'xlsb',
  'xls',
  'ods',
  'fods',
  'csv',
  'tsv',
  'dbf',
];

export const ACCEPT_ATTRIBUTE = ACCEPTED.map((e) => `.${e}`).join(',');

export class SpreadsheetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpreadsheetError';
  }
}

/** Excel's default column, 8.43 characters wide, in points. */
const DEFAULT_COLUMN = 48;
const MIN_COLUMN = 8;
const MAX_COLUMN = 400;
const PX_TO_PT = 0.75;

interface CellStyle {
  font?: { bold?: boolean };
  alignment?: { horizontal?: string };
}

interface ColInfo {
  wch?: number;
  wpx?: number;
  width?: number;
  hidden?: boolean;
}

interface RowInfo {
  hpt?: number;
  hpx?: number;
  hidden?: boolean;
}

const blank = (): GridCell => ({
  text: '',
  align: 'left',
  bold: false,
  colSpan: 1,
  rowSpan: 1,
  covered: false,
  anchorRow: -1,
  anchorColumn: -1,
});

function alignOf(cell: CellObject, style: CellStyle | undefined): Align {
  const declared = style?.alignment?.horizontal;
  if (declared === 'left') return 'left';
  if (declared === 'right') return 'right';
  if (declared === 'center' || declared === 'centre') return 'centre';
  if (cell.t === 'n' || cell.t === 'd') return 'right';
  if (cell.t === 'b' || cell.t === 'e') return 'centre';
  return 'left';
}

function textOf(cell: CellObject): string {
  if (typeof cell.w === 'string' && cell.w !== '') return cell.w;
  if (cell.v === undefined || cell.v === null) return '';
  if (cell.t === 'b') return cell.v ? 'TRUE' : 'FALSE';
  if (cell.v instanceof Date) return cell.v.toLocaleDateString();
  return String(cell.v);
}

function columnPoints(info: ColInfo | undefined): number {
  if (info?.hidden) return 0;
  let points = DEFAULT_COLUMN;
  if (typeof info?.wpx === 'number' && info.wpx > 0) points = info.wpx * PX_TO_PT;
  else if (typeof info?.wch === 'number' && info.wch > 0) points = (info.wch * 7 + 5) * PX_TO_PT;
  else if (typeof info?.width === 'number' && info.width > 0) {
    points = (info.width * 7 + 5) * PX_TO_PT;
  }
  return Math.min(MAX_COLUMN, Math.max(MIN_COLUMN, points));
}

function rowPoints(info: RowInfo | undefined): number {
  if (typeof info?.hpt === 'number' && info.hpt > 0) return info.hpt;
  if (typeof info?.hpx === 'number' && info.hpx > 0) return info.hpx * PX_TO_PT;
  return 0;
}

/** The stated range can be far bigger than the cells that exist, so measure instead. */
function usedBounds(sheet: WorkSheet): { rows: number; columns: number } {
  let rows = 0;
  let columns = 0;
  for (const key in sheet) {
    if (key.charCodeAt(0) === 33) continue;
    const comma = key.search(/\d/);
    if (comma <= 0) continue;
    const row = Number(key.slice(comma));
    if (!Number.isFinite(row)) continue;
    let column = 0;
    for (let i = 0; i < comma; i += 1) column = column * 26 + (key.charCodeAt(i) - 64);
    if (row > rows) rows = row;
    if (column > columns) columns = column;
  }
  return { rows, columns };
}

export async function readWorkbook(file: File): Promise<Workbook> {
  if (file.size === 0) throw new SpreadsheetError('That file is empty.');
  if (file.size > MAX_BYTES) {
    throw new SpreadsheetError(
      'That file is larger than 60 MB. Everything runs in this tab, so a file that big would freeze it.',
    );
  }

  const XLSX = await import('xlsx');
  const bytes = new Uint8Array(await file.arrayBuffer());

  let book;
  try {
    book = XLSX.read(bytes, {
      type: 'array',
      cellNF: true,
      cellText: true,
      cellStyles: true,
      cellDates: false,
    });
  } catch {
    throw new SpreadsheetError(
      'That spreadsheet could not be opened. It may be password-protected, or not really a spreadsheet.',
    );
  }

  const declared = book.Workbook?.Sheets ?? [];
  const sheets: SheetGrid[] = [];

  book.SheetNames.forEach((name, index) => {
    const sheet = book.Sheets[name];
    if (!sheet) return;

    const bounds = usedBounds(sheet);
    const columnCount = Math.min(bounds.columns, MAX_COLUMNS);
    const rowCount = Math.min(bounds.rows, MAX_ROWS);

    const cols = (sheet['!cols'] as ColInfo[] | undefined) ?? [];
    const rowInfo = (sheet['!rows'] as RowInfo[] | undefined) ?? [];
    const columnWidths = Array.from({ length: columnCount }, (_, c) => columnPoints(cols[c]));
    const rowHeights = Array.from({ length: rowCount }, (_, r) => rowPoints(rowInfo[r]));
    const hiddenRows = Array.from({ length: rowCount }, (_, r) => rowInfo[r]?.hidden === true);

    const rows: GridCell[][] = Array.from({ length: rowCount }, () =>
      Array.from({ length: columnCount }, blank),
    );

    for (const key in sheet) {
      if (key.charCodeAt(0) === 33) continue;
      const at = XLSX.utils.decode_cell(key);
      if (at.r >= rowCount || at.c >= columnCount) continue;
      const cell = sheet[key] as CellObject;
      const style = cell.s as CellStyle | undefined;
      const target = rows[at.r][at.c];
      target.text = textOf(cell);
      target.align = alignOf(cell, style);
      target.bold = style?.font?.bold === true;
    }

    for (const merge of sheet['!merges'] ?? []) {
      const { s, e } = merge;
      if (s.r >= rowCount || s.c >= columnCount) continue;
      const lastRow = Math.min(e.r, rowCount - 1);
      const lastColumn = Math.min(e.c, columnCount - 1);
      rows[s.r][s.c].colSpan = lastColumn - s.c + 1;
      rows[s.r][s.c].rowSpan = lastRow - s.r + 1;
      for (let r = s.r; r <= lastRow; r += 1) {
        for (let c = s.c; c <= lastColumn; c += 1) {
          if (r === s.r && c === s.c) continue;
          rows[r][c].covered = true;
          rows[r][c].anchorRow = s.r;
          rows[r][c].anchorColumn = s.c;
          rows[r][c].text = '';
        }
      }
    }

    sheets.push({
      name,
      index,
      hidden: (declared[index]?.Hidden ?? 0) !== 0,
      rows,
      columnWidths,
      rowHeights,
      hiddenRows,
      columnCount,
      truncated: bounds.rows > rowCount || bounds.columns > columnCount,
    });
  });

  if (sheets.length === 0) throw new SpreadsheetError('That workbook has no sheets in it.');
  if (sheets.every((s) => s.rows.length === 0)) {
    throw new SpreadsheetError('Every sheet in that workbook is empty.');
  }

  return { filename: file.name, sheets };
}

export function looksLikeSpreadsheet(file: File): boolean {
  const ext = extension(file.name);
  return ACCEPTED.includes(ext);
}
