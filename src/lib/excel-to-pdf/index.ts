import type { PDFDocument } from 'pdf-lib';
import { face, FontBook } from '@/lib/make-pdf/fonts';
import { pageSize, uniformMargins, type Orientation } from '@/lib/make-pdf/paper';
import { Sheet } from '@/lib/make-pdf/sheet';
import { describeFolding, Folder } from '@/lib/make-pdf/text';
import { baseName } from '@/lib/format';
import { tick } from '@/lib/pdf-tools/pdf';
import { drawSheet } from './render';
import {
  TEXT_SIZES,
  type ExcelPdfOptions,
  type ExcelPdfProgress,
  type ExcelPdfReport,
  type SheetGrid,
  type Workbook,
} from './types';

export * from './types';
export {
  ACCEPT_ATTRIBUTE,
  ACCEPTED,
  looksLikeSpreadsheet,
  MAX_ROWS,
  readWorkbook,
  SpreadsheetError,
} from './read';

const MARGIN = 36;
const FOOTER_GAP = 16;
const FOOTER_SIZE = 7.5;
const FOOTER = face('sans');

export const DEFAULT_OPTIONS: Omit<ExcelPdfOptions, 'sheets'> = {
  paper: 'a4',
  orientation: 'auto',
  textSize: 'normal',
  fitWidth: true,
  gridlines: true,
  repeatHeader: true,
  footer: true,
};

function naturalWidth(grid: SheetGrid): number {
  let total = 0;
  for (let c = 0; c < grid.columnCount; c += 1) total += grid.columnWidths[c];
  return total;
}

function orientationFor(grid: SheetGrid, options: ExcelPdfOptions, margins: number): Orientation {
  if (options.orientation !== 'auto') return options.orientation;
  const portrait = pageSize(options.paper, 'portrait');
  return naturalWidth(grid) > portrait.width - margins * 2 ? 'landscape' : 'portrait';
}

export async function excelToPdf(
  workbook: Workbook,
  options: ExcelPdfOptions,
  onProgress: (progress: ExcelPdfProgress) => void,
): Promise<{ bytes: Uint8Array; report: ExcelPdfReport }> {
  const wanted = new Set(options.sheets);
  const chosen = workbook.sheets.filter((grid) => wanted.has(grid.name));
  if (chosen.length === 0) throw new Error('Pick at least one sheet to put in the PDF.');

  const lib = await import('pdf-lib');
  const doc = await lib.PDFDocument.create();
  const book = new FontBook(doc);
  await book.prepare([face('sans'), face('sans', true)]);

  const folder = new Folder();
  const size = TEXT_SIZES[options.textSize];
  const labels: string[] = [];

  let shrunk = false;
  let tight = false;
  let split = false;
  let truncated = false;
  let rowTotal = 0;
  let columnTotal = 0;
  let drawn = 0;

  const bottomMargin = options.footer ? MARGIN + FOOTER_GAP : MARGIN;

  for (let i = 0; i < chosen.length; i += 1) {
    const grid = chosen[i];
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    onProgress({ stage: 'drawing', done: i, total: chosen.length, sheet: grid.name });
    await tick();

    const orientation = orientationFor(grid, options, MARGIN);
    const { width, height } = pageSize(options.paper, orientation);
    const sheet = new Sheet(doc, lib, {
      width,
      height,
      margins: { ...uniformMargins(MARGIN), bottom: bottomMargin },
    });

    const result = drawSheet(
      grid,
      sheet,
      book,
      folder,
      {
        size,
        gridlines: options.gridlines,
        repeatHeader: options.repeatHeader,
        fitWidth: options.fitWidth,
      },
      () => labels.push(grid.name),
    );

    shrunk = shrunk || result.shrunk;
    tight = tight || result.tight;
    split = split || result.split;
    truncated = truncated || grid.truncated;
    rowTotal += result.rows;
    columnTotal = Math.max(columnTotal, result.columns);
    if (result.rows > 0) drawn += 1;
  }

  if (doc.getPageCount() === 0) {
    throw new Error('Every sheet you picked turned out to be empty, so there was nothing to draw.');
  }

  if (options.footer) drawFooters(doc, lib, book, labels, chosen.length > 1);

  onProgress({ stage: 'drawing', done: chosen.length, total: chosen.length });
  await tick();

  doc.setProducer('FreeSecureKit');
  doc.setTitle(baseName(workbook.filename));
  const bytes = await doc.save({ useObjectStreams: true, addDefaultPage: false });

  return {
    bytes,
    report: {
      pageCount: doc.getPageCount(),
      sheetCount: drawn,
      rowCount: rowTotal,
      columnCount: columnTotal,
      notes: notesFor({ folder, shrunk, tight, split, truncated, workbook }),
    },
  };
}

function drawFooters(
  doc: PDFDocument,
  lib: typeof import('pdf-lib'),
  book: FontBook,
  labels: string[],
  withNames: boolean,
): void {
  const pages = doc.getPages();
  const font = book.get(FOOTER);
  const grey = lib.rgb(0.42, 0.45, 0.5);

  pages.forEach((page, i) => {
    const { width } = page.getSize();
    const number = `Page ${i + 1} of ${pages.length}`;
    const y = MARGIN - 8;

    if (withNames && labels[i]) {
      page.drawText(labels[i].slice(0, 60), { x: MARGIN, y, size: FOOTER_SIZE, font, color: grey });
    }
    page.drawText(number, {
      x: width - MARGIN - font.widthOfTextAtSize(number, FOOTER_SIZE),
      y,
      size: FOOTER_SIZE,
      font,
      color: grey,
    });
  });
}

function notesFor(input: {
  folder: Folder;
  shrunk: boolean;
  tight: boolean;
  split: boolean;
  truncated: boolean;
  workbook: Workbook;
}): string[] {
  const notes: string[] = [];

  notes.push(
    'Cell colours, fonts and borders are not carried over. The text, the column widths and the merged cells are.',
  );
  if (input.shrunk) {
    notes.push('Columns and text were made smaller so a whole row fits across the page.');
  }
  if (input.tight) {
    notes.push(
      'One sheet had to shrink a long way to fit, so its text is small. Untick “squeeze the columns” to spread it over more pages at full size instead.',
    );
  }
  if (input.split) {
    notes.push('A sheet was wider than the page, so the columns that did not fit carry on overleaf.');
  }
  if (input.truncated) {
    notes.push('Only the first 20,000 rows and 256 columns of a sheet were drawn.');
  }

  const hidden = input.workbook.sheets.filter((s) => s.hidden).length;
  if (hidden > 0) {
    notes.push(
      `This workbook has ${hidden} hidden ${hidden === 1 ? 'sheet' : 'sheets'}. Hidden sheets, rows and columns are left out unless you tick them.`,
    );
  }

  const folding = describeFolding(input.folder.tally());
  if (folding) notes.push(folding);

  return notes;
}
