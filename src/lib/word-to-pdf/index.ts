import type { PDFDocument, PDFPage } from 'pdf-lib';
import { face, FontBook, type Family } from '@/lib/make-pdf/fonts';
import { Sheet } from '@/lib/make-pdf/sheet';
import { describeFolding, Folder } from '@/lib/make-pdf/text';
import { baseName } from '@/lib/format';
import { tick } from '@/lib/pdf-tools/pdf';
import { compile, flow, type Atom, type Pen } from './draw';
import { embedImages } from './images';
import { parseDocx } from './parse';
import type {
  Block,
  Section,
  WordPdfOptions,
  WordPdfProgress,
  WordPdfReport,
} from './types';

export * from './types';
export { DocxError } from './xml';

export const DEFAULT_OPTIONS: WordPdfOptions = {
  paper: 'document',
  images: true,
  links: true,
  headersFooters: true,
};

const FAMILIES: readonly Family[] = ['sans', 'serif', 'mono'];

const ALL_FACES = FAMILIES.flatMap((family) => [
  face(family),
  face(family, true),
  face(family, false, true),
  face(family, true, true),
]);

export function looksLikeWord(file: File): boolean {
  return /\.(docx|docm)$/i.test(file.name);
}

function collectImages(blocks: readonly Block[], into: Set<string>): void {
  for (const block of blocks) {
    if (block.kind === 'para') {
      for (const piece of block.pieces) if (piece.kind === 'image') into.add(piece.id);
    } else {
      for (const row of block.table.rows) {
        for (const cell of row.cells) collectImages(cell.blocks, into);
      }
    }
  }
}

interface PageRecord {
  page: PDFPage;
  section: Section;
  first: boolean;
}

export async function wordToPdf(
  file: File,
  options: WordPdfOptions,
  onProgress: (progress: WordPdfProgress) => void,
): Promise<{ bytes: Uint8Array; report: WordPdfReport }> {
  onProgress({ stage: 'reading', done: 0, total: 1 });
  const document = await parseDocx(file, options);
  const notes = new Set(document.notes);

  const lib = await import('pdf-lib');
  const doc = await lib.PDFDocument.create();
  const book = new FontBook(doc);
  await book.prepare(ALL_FACES);

  const wanted = new Set<string>();
  if (options.images) {
    for (const section of document.sections) {
      collectImages(section.blocks, wanted);
      for (const banner of [section.header, section.firstHeader, section.footer, section.firstFooter]) {
        if (banner) collectImages(banner, wanted);
      }
    }
  }
  const images = await embedImages(doc, document.media, wanted, notes);
  const section0Margins = { top: 0, right: 0, bottom: 0, left: 0 };

  const pen: Pen = {
    // Replaced before anything is drawn; every section brings its own page size
    sheet: new Sheet(doc, lib, { width: 1, height: 1, margins: section0Margins }),
    book,
    folder: new Folder(),
    images,
    links: options.links,
    counts: { paragraphs: 0, tables: 0, images: 0 },
    page: { index: 1, total: 0 },
  };

  const records: PageRecord[] = [];

  for (let i = 0; i < document.sections.length; i += 1) {
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const section = document.sections[i];
    onProgress({ stage: 'drawing', done: i, total: document.sections.length });
    await tick();

    const sheet = new Sheet(doc, lib, {
      width: section.width,
      height: section.height,
      margins: section.margins,
    });
    pen.sheet = sheet;

    let firstOfSection = true;
    flow(compile(section.blocks, pen, sheet.contentWidth), pen, () => {
      const page = sheet.pages[sheet.pages.length - 1];
      pen.page.index = records.length + 1;
      records.push({ page, section, first: firstOfSection });
      firstOfSection = false;
    });
  }

  if (records.length === 0) {
    throw new Error('That document turned out to be empty, so there was nothing to draw.');
  }

  pen.page.total = records.length;
  if (options.headersFooters) drawBanners(doc, lib, records, pen);

  onProgress({ stage: 'drawing', done: document.sections.length, total: document.sections.length });
  await tick();

  doc.setProducer('FreeSecureKit');
  doc.setTitle(baseName(file.name));
  const bytes = await doc.save({ useObjectStreams: true, addDefaultPage: false });

  const folding = describeFolding(pen.folder.tally());
  if (folding) notes.add(folding);

  return {
    bytes,
    report: {
      pageCount: records.length,
      paragraphs: pen.counts.paragraphs,
      tables: pen.counts.tables,
      images: pen.counts.images,
      notes: [...notes],
    },
  };
}

function drawBanners(
  doc: PDFDocument,
  lib: typeof import('pdf-lib'),
  records: readonly PageRecord[],
  pen: Pen,
): void {
  records.forEach((record, index) => {
    const { section } = record;
    const useFirst = section.titlePage && record.first;
    const header = (useFirst ? section.firstHeader : null) ?? section.header;
    const footer = (useFirst ? section.firstFooter : null) ?? section.footer;
    pen.page.index = index + 1;

    if (header) {
      const sheet = new Sheet(doc, lib, {
        width: section.width,
        height: section.height,
        margins: { ...section.margins, top: section.headerAt, bottom: 0 },
      });
      sheet.on(record.page, section.headerAt);
      pen.sheet = sheet;
      paintBanner(compile(header, pen, sheet.contentWidth), pen, section.headerAt);
    }

    if (footer) {
      const sheet = new Sheet(doc, lib, {
        width: section.width,
        height: section.height,
        margins: { ...section.margins, top: 0, bottom: 0 },
      });
      sheet.on(record.page, 0);
      pen.sheet = sheet;
      const atoms = compile(footer, pen, sheet.contentWidth);
      const height = atoms.reduce((sum, atom) => sum + atom.height, 0);
      paintBanner(atoms, pen, Math.max(0, section.height - section.footerAt - height));
    }
  });
}

function paintBanner(atoms: readonly Atom[], pen: Pen, top: number): void {
  let y = top;
  for (const atom of atoms) {
    atom.paint(pen.sheet.left, y);
    y += atom.height;
  }
}
