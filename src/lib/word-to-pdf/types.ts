import type { Family } from '@/lib/make-pdf/fonts';
import type { Margins } from '@/lib/make-pdf/paper';

export interface RunStyle {
  family: Family;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  /** Points. */
  size: number;
  colour: string;
  highlight: string | null;
  shift: 'super' | 'sub' | null;
  caps: boolean;
  hidden: boolean;
  link: string | null;
}

export type Piece =
  | { kind: 'text'; text: string; style: RunStyle }
  | { kind: 'tab'; style: RunStyle }
  | { kind: 'break'; style: RunStyle }
  | { kind: 'pageBreak' }
  | { kind: 'field'; field: 'page' | 'pages'; style: RunStyle }
  | { kind: 'image'; id: string; width: number; height: number; link: string | null };

export type Align = 'left' | 'centre' | 'right' | 'justify';

export interface Border {
  /** Points. */
  size: number;
  colour: string;
}

export interface ParaStyle {
  align: Align;
  /** Points, all of them. */
  indentLeft: number;
  indentRight: number;
  firstLine: number;
  spaceBefore: number;
  spaceAfter: number;
  /** Multiplier when the document asks for proportional spacing. */
  lineFactor: number;
  /** Points, when the document pins the line height instead. */
  lineExact: number;
  shading: string | null;
  borderTop: Border | null;
  borderBottom: Border | null;
  pageBreakBefore: boolean;
  keepNext: boolean;
  /** 0 for body text, 1-9 for headings. */
  outline: number;
}

export interface Marker {
  text: string;
  style: RunStyle;
}

export interface CellBorders {
  top: Border | null;
  bottom: Border | null;
  left: Border | null;
  right: Border | null;
}

export interface Cell {
  blocks: Block[];
  /** Columns of the table grid this cell covers. */
  span: number;
  vMerge: 'start' | 'continue' | null;
  shading: string | null;
  borders: CellBorders;
  align: 'top' | 'centre' | 'bottom';
}

export interface Row {
  cells: Cell[];
  /** Word's "repeat as header row at the top of each page". */
  header: boolean;
  minHeight: number;
  /** Row must not be split across a page break. */
  keepWhole: boolean;
}

export interface TableWidth {
  /** 'pct' value is a fraction of the available width; 'dxa' is points. */
  type: 'pct' | 'dxa' | 'auto';
  value: number;
}

export interface Table {
  rows: Row[];
  width: TableWidth;
  /** Points, one per grid column. */
  widths: number[];
  indent: number;
  align: Align;
}

export type Block =
  | { kind: 'para'; pieces: Piece[]; para: ParaStyle; marker: Marker | null; base: RunStyle }
  | { kind: 'table'; table: Table };

export interface Section {
  width: number;
  height: number;
  margins: Margins;
  /** Distance from the paper edge to the header and footer bands. */
  headerAt: number;
  footerAt: number;
  blocks: Block[];
  header: Block[] | null;
  firstHeader: Block[] | null;
  footer: Block[] | null;
  firstFooter: Block[] | null;
  titlePage: boolean;
  columns: number;
}

export interface WordDocument {
  filename: string;
  sections: Section[];
  /** Media part name to raw bytes. */
  media: Map<string, Uint8Array>;
  notes: string[];
}

export interface WordPdfOptions {
  /** Ignore the page size in the document and use this one instead. */
  paper: 'document' | 'a4' | 'letter' | 'legal' | 'a3' | 'a5';
  images: boolean;
  links: boolean;
  headersFooters: boolean;
  signal?: AbortSignal;
}

export interface WordPdfProgress {
  stage: 'reading' | 'drawing';
  done: number;
  total: number;
}

export interface WordPdfReport {
  pageCount: number;
  paragraphs: number;
  tables: number;
  images: number;
  notes: string[];
}

export const DEFAULT_RUN: RunStyle = {
  family: 'sans',
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  size: 11,
  colour: '#000000',
  highlight: null,
  shift: null,
  caps: false,
  hidden: false,
  link: null,
};

export const DEFAULT_PARA: ParaStyle = {
  align: 'left',
  indentLeft: 0,
  indentRight: 0,
  firstLine: 0,
  spaceBefore: 0,
  spaceAfter: 0,
  lineFactor: 1,
  lineExact: 0,
  shading: null,
  borderTop: null,
  borderBottom: null,
  pageBreakBefore: false,
  keepNext: false,
  outline: 0,
};
