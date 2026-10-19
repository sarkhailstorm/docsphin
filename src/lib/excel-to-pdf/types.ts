import type { Orientation, PaperId } from '@/lib/make-pdf/paper';

export type Align = 'left' | 'centre' | 'right';

export interface GridCell {
  text: string;
  align: Align;
  bold: boolean;
  /** Set on the top-left cell of a merge; 1 everywhere else. */
  colSpan: number;
  rowSpan: number;
  /** True for the cells a merge swallowed, which are skipped when drawing. */
  covered: boolean;
  /** Top-left of the merge this cell was swallowed by, or -1. */
  anchorRow: number;
  anchorColumn: number;
}

export interface SheetGrid {
  name: string;
  index: number;
  hidden: boolean;
  rows: GridCell[][];
  /** Points, one per column. */
  columnWidths: number[];
  /** Points, one per row; 0 means "work it out from the text". */
  rowHeights: number[];
  hiddenRows: boolean[];
  columnCount: number;
  /** True when the sheet had more rows or columns than we will draw. */
  truncated: boolean;
}

export interface Workbook {
  filename: string;
  sheets: SheetGrid[];
}

export type TextSize = 'small' | 'normal' | 'large';

export interface ExcelPdfOptions {
  paper: PaperId;
  /** 'auto' picks landscape for sheets too wide to read upright. */
  orientation: Orientation | 'auto';
  textSize: TextSize;
  /** Shrink the columns until a row fits the page width. */
  fitWidth: boolean;
  gridlines: boolean;
  repeatHeader: boolean;
  footer: boolean;
  /** Sheet names to include, in workbook order. */
  sheets: readonly string[];
  signal?: AbortSignal;
}

export interface ExcelPdfProgress {
  stage: 'reading' | 'laying-out' | 'drawing';
  done: number;
  total: number;
  sheet?: string;
}

export interface ExcelPdfReport {
  pageCount: number;
  sheetCount: number;
  rowCount: number;
  columnCount: number;
  notes: string[];
}

export const TEXT_SIZES: Record<TextSize, number> = {
  small: 7.5,
  normal: 9,
  large: 11,
};
