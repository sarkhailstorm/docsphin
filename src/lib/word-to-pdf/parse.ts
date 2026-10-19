import { pageSize } from '@/lib/make-pdf/paper';
import { DocxPackage, resolvePart, type Relationship } from './package';
import { Numbering } from './numbering';
import { readBorder, readBorderSet, StyleSheet, type TableBorderSet } from './styles';
import {
  A,
  DocxError,
  R,
  VML,
  W,
  WP,
  attr,
  deep,
  emu,
  flag,
  kid,
  kids,
  number,
  twips,
  wVal,
} from './xml';
import type {
  Block,
  Cell,
  CellBorders,
  Marker,
  ParaStyle,
  Piece,
  Row,
  RunStyle,
  Section,
  Table,
  TableWidth,
  WordDocument,
  WordPdfOptions,
} from './types';

const MAX_TABLE_DEPTH = 4;
const MAX_BLOCKS = 80_000;
const DEFAULT_WIDTH = 595.28;
const DEFAULT_HEIGHT = 841.89;
const DEFAULT_MARGIN = 72;

interface Part {
  path: string;
  rels: Map<string, Relationship>;
}

/** Tracks where we are inside a Word field, which wraps its own stale result. */
interface FieldState {
  skipping: boolean;
  suppress: boolean;
}

class Parser {
  private blockCount = 0;
  readonly notes = new Set<string>();

  constructor(
    private readonly pkg: DocxPackage,
    private readonly styles: StyleSheet,
    private readonly numbering: Numbering,
    private readonly options: WordPdfOptions,
  ) {}

  blocks(container: Element | null, part: Part, depth = 0): Block[] {
    if (!container) return [];
    const nodes: Element[] = [];
    for (let node = container.firstElementChild; node; node = node.nextElementSibling) {
      nodes.push(node);
    }
    return this.blocksOf(nodes, part, depth);
  }

  blocksOf(nodes: readonly Element[], part: Part, depth = 0): Block[] {
    const out: Block[] = [];

    for (const node of nodes) {
      if (node.namespaceURI !== W) continue;
      if (this.blockCount > MAX_BLOCKS) {
        this.notes.add('This document was too long to draw in full, so the PDF stops part-way.');
        break;
      }

      if (node.localName === 'p') {
        out.push(this.paragraph(node, part));
        this.blockCount += 1;
      } else if (node.localName === 'tbl') {
        if (depth < MAX_TABLE_DEPTH) {
          out.push({ kind: 'table', table: this.table(node, part, depth) });
          this.blockCount += 1;
        } else {
          this.notes.add('A table nested very deeply inside another was left out.');
        }
      } else if (node.localName === 'sdt') {
        out.push(...this.blocks(kid(node, W, 'sdtContent'), part, depth));
      }
    }

    return out;
  }

  private paragraph(p: Element, part: Part): Block {
    const pPr = kid(p, W, 'pPr');
    const styleId = wVal(kid(pPr, W, 'pStyle')) ?? this.styles.defaultParagraphStyle;
    const para = this.styles.applyParaProps(pPr, this.styles.paraOfStyle(styleId));
    const runBase = this.styles.runOfStyle(styleId);

    const marker = this.markerFor(pPr, styleId, runBase, para);
    const pieces: Piece[] = [];
    this.inline(p, part, runBase, null, pieces, { skipping: false, suppress: false });

    return { kind: 'para', pieces, para, marker, base: runBase };
  }

  private markerFor(
    pPr: Element | null,
    styleId: string | null,
    runBase: RunStyle,
    para: ParaStyle,
  ): Marker | null {
    const numPr = kid(pPr, W, 'numPr');
    const direct = wVal(kid(numPr, W, 'numId'));
    const fromStyle = direct === null ? this.styles.numberingOfStyle(styleId) : null;
    const numId = direct ?? fromStyle?.numId ?? null;
    if (!numId || numId === '0') return null;

    const level = direct !== null ? number(wVal(kid(numPr, W, 'ilvl')), 0) : (fromStyle?.level ?? 0);
    const marker = this.numbering.next(numId, level, runBase);
    if (!marker) return null;

    // A level's own indents only apply where the paragraph did not set its own
    const indent = kid(pPr, W, 'ind');
    const hasLeft = attr(indent, W, 'left') !== null || attr(indent, W, 'start') !== null;
    const hasFirst = attr(indent, W, 'hanging') !== null || attr(indent, W, 'firstLine') !== null;
    if (!hasLeft && marker.indentLeft > 0) para.indentLeft = marker.indentLeft;
    if (!hasFirst && marker.hanging > 0) para.firstLine = -marker.hanging;

    return { text: marker.text, style: marker.style };
  }

  /** Walks everything inside a paragraph that can produce something to draw. */
  private inline(
    container: Element,
    part: Part,
    base: RunStyle,
    link: string | null,
    out: Piece[],
    field: FieldState,
  ): void {
    for (let node = container.firstElementChild; node; node = node.nextElementSibling) {
      if (node.namespaceURI !== W) continue;

      switch (node.localName) {
        case 'r':
          this.run(node, part, base, link, out, field);
          break;
        case 'hyperlink': {
          const id = attr(node, R, 'id');
          const target = id ? part.rels.get(id) : undefined;
          const url = target?.external ? target.target : null;
          this.inline(node, part, base, this.options.links ? url : link, out, field);
          break;
        }
        case 'fldSimple': {
          const named = fieldName(attr(node, W, 'instr') ?? '');
          if (named) out.push({ kind: 'field', field: named, style: base });
          else this.inline(node, part, base, link, out, field);
          break;
        }
        case 'ins':
        case 'smartTag':
          this.inline(node, part, base, link, out, field);
          break;
        case 'sdt':
          this.inline(kid(node, W, 'sdtContent') ?? node, part, base, link, out, field);
          break;
        default:
          break;
      }
    }
  }

  private run(
    r: Element,
    part: Part,
    base: RunStyle,
    link: string | null,
    out: Piece[],
    field: FieldState,
  ): void {
    const style = { ...this.styles.applyRunProps(kid(r, W, 'rPr'), base), link };
    if (style.hidden) return;

    for (let node = r.firstElementChild; node; node = node.nextElementSibling) {
      if (node.namespaceURI !== W && node.namespaceURI !== VML) continue;
      const name = node.localName;

      if (name === 'fldChar') {
        const kind = attr(node, W, 'fldCharType');
        if (kind === 'begin') {
          field.skipping = true;
          field.suppress = false;
        } else if (kind === 'separate') {
          field.skipping = field.suppress;
        } else if (kind === 'end') {
          field.skipping = false;
          field.suppress = false;
        }
        continue;
      }

      if (name === 'instrText') {
        const named = fieldName(node.textContent ?? '');
        if (named) {
          out.push({ kind: 'field', field: named, style });
          // We work the number out ourselves, so Word's stale copy is dropped
          field.suppress = true;
        }
        continue;
      }

      if (field.skipping) continue;

      switch (name) {
        case 't':
          this.words(node.textContent ?? '', style, out);
          break;
        case 'tab':
          out.push({ kind: 'tab', style });
          break;
        case 'br':
          out.push(attr(node, W, 'type') === 'page' ? { kind: 'pageBreak' } : { kind: 'break', style });
          break;
        case 'cr':
          out.push({ kind: 'break', style });
          break;
        case 'noBreakHyphen':
          out.push({ kind: 'text', text: '-', style });
          break;
        case 'sym': {
          const code = parseInt(attr(node, W, 'char') ?? '', 16);
          if (Number.isFinite(code)) out.push({ kind: 'text', text: String.fromCharCode(code), style });
          break;
        }
        case 'drawing':
          this.picture(node, part, style, out);
          break;
        case 'pict':
          this.vmlPicture(node, part, style, out);
          break;
        case 'object':
          this.notes.add('An embedded object, such as a chart or an equation, was left out.');
          break;
        default:
          break;
      }
    }
  }

  /** Some writers put real tabs and newlines inside w:t rather than marking them up. */
  private words(text: string, style: RunStyle, out: Piece[]): void {
    if (!text) return;
    const value = style.caps ? text.toUpperCase() : text;
    if (!/[\t\r\n]/.test(value)) {
      out.push({ kind: 'text', text: value, style });
      return;
    }
    for (const part of value.split(/(\t|\r?\n)/)) {
      if (part === '') continue;
      if (part === '\t') out.push({ kind: 'tab', style });
      else if (part === '\n' || part === '\r\n') out.push({ kind: 'break', style });
      else out.push({ kind: 'text', text: part, style });
    }
  }

  private picture(drawing: Element, part: Part, style: RunStyle, out: Piece[]): void {
    if (!this.options.images) return;
    const blip = deep(drawing, A, 'blip');
    const id = blip ? attr(blip, R, 'embed') : null;
    const target = id ? part.rels.get(id) : undefined;
    if (!target || target.external) {
      this.notes.add('A picture stored outside the document could not be included.');
      return;
    }

    const path = resolvePart(part.path, target.target);
    if (!this.pkg.media.has(path)) return;

    const extent = deep(drawing, WP, 'extent');
    out.push({
      kind: 'image',
      id: path,
      width: Math.max(0, emu(extent?.getAttribute('cx') ?? null, 0)),
      height: Math.max(0, emu(extent?.getAttribute('cy') ?? null, 0)),
      link: style.link,
    });
  }

  private vmlPicture(pict: Element, part: Part, style: RunStyle, out: Piece[]): void {
    if (!this.options.images) return;
    const data = deep(pict, VML, 'imagedata');
    const id = data ? attr(data, R, 'id') : null;
    const target = id ? part.rels.get(id) : undefined;
    if (!target || target.external) return;

    const path = resolvePart(part.path, target.target);
    if (!this.pkg.media.has(path)) return;
    out.push({ kind: 'image', id: path, width: 0, height: 0, link: style.link });
  }

  private table(tbl: Element, part: Part, depth: number): Table {
    const tblPr = kid(tbl, W, 'tblPr');
    const styleId = wVal(kid(tblPr, W, 'tblStyle'));
    const borders =
      readBorderSet(kid(tblPr, W, 'tblBorders')) ?? this.styles.tableBordersOfStyle(styleId);

    const widths = kids(kid(tbl, W, 'tblGrid'), W, 'gridCol').map((col) => twips(attr(col, W, 'w')));
    const declared = tableWidth(kid(tblPr, W, 'tblW'));
    const indent = twips(attr(kid(tblPr, W, 'tblInd'), W, 'w'));
    const alignment = wVal(kid(tblPr, W, 'jc'));

    const rowElements = kids(tbl, W, 'tr');
    const rows: Row[] = rowElements.map((tr, rowIndex) => {
      const trPr = kid(tr, W, 'trPr');
      const cellElements = kids(tr, W, 'tc');
      const lastRow = rowIndex === rowElements.length - 1;

      let column = 0;
      const cells: Cell[] = cellElements.map((tc, cellIndex) => {
        const tcPr = kid(tc, W, 'tcPr');
        const span = Math.max(1, number(wVal(kid(tcPr, W, 'gridSpan')), 1));
        const first = column === 0;
        column += span;

        const merge = kid(tcPr, W, 'vMerge');
        const mergeValue = merge ? (wVal(merge) ?? 'continue') : null;

        return {
          blocks: this.blocks(tc, part, depth + 1),
          span,
          vMerge: mergeValue === 'restart' ? 'start' : mergeValue ? 'continue' : null,
          shading: shadingFill(tcPr),
          borders: cellBorders(borders, kid(tcPr, W, 'tcBorders'), {
            first,
            last: cellIndex === cellElements.length - 1,
            firstRow: rowIndex === 0,
            lastRow,
          }),
          align: verticalAlign(wVal(kid(tcPr, W, 'vAlign'))),
        };
      });

      return {
        cells,
        header: flag(kid(trPr, W, 'tblHeader')) === true,
        minHeight: twips(attr(kid(trPr, W, 'trHeight'), W, 'val')),
        keepWhole: flag(kid(trPr, W, 'cantSplit')) === true,
      };
    });

    return {
      rows,
      width: declared,
      widths,
      indent,
      align: alignment === 'center' ? 'centre' : alignment === 'right' ? 'right' : 'left',
    };
  }
}

/** w:tblW is a percentage, an absolute width, or "work it out from the grid". */
function tableWidth(element: Element | null): TableWidth {
  const raw = attr(element, W, 'w');
  const type = attr(element, W, 'type') ?? 'auto';
  if (raw === null) return { type: 'auto', value: 0 };

  if (type === 'pct') {
    // Either fiftieths of a percent, or a plain "100%"
    const value = raw.endsWith('%') ? number(raw.slice(0, -1)) / 100 : number(raw) / 5000;
    return value > 0 ? { type: 'pct', value: Math.min(value, 1) } : { type: 'auto', value: 0 };
  }
  if (type === 'dxa') {
    const value = twips(raw);
    return value > 0 ? { type: 'dxa', value } : { type: 'auto', value: 0 };
  }
  return { type: 'auto', value: 0 };
}

function verticalAlign(value: string | null): Cell['align'] {
  if (value === 'center') return 'centre';
  if (value === 'bottom') return 'bottom';
  return 'top';
}

function shadingFill(container: Element | null): string | null {
  const fill = attr(kid(container, W, 'shd'), W, 'fill');
  if (!fill || fill === 'auto') return null;
  const clean = fill.replace('#', '');
  return /^[0-9a-f]{6}$/i.test(clean) ? `#${clean}` : null;
}

function cellBorders(
  table: TableBorderSet | null,
  own: Element | null,
  at: { first: boolean; last: boolean; firstRow: boolean; lastRow: boolean },
): CellBorders {
  const base: CellBorders = {
    top: at.firstRow ? (table?.top ?? null) : (table?.insideH ?? null),
    bottom: at.lastRow ? (table?.bottom ?? null) : (table?.insideH ?? null),
    left: at.first ? (table?.left ?? null) : (table?.insideV ?? null),
    right: at.last ? (table?.right ?? null) : (table?.insideV ?? null),
  };
  if (!own) return base;

  const override = (side: keyof CellBorders, name: string, alternative?: string): void => {
    const element = kid(own, W, name) ?? (alternative ? kid(own, W, alternative) : null);
    if (element) base[side] = readBorder(element);
  };
  override('top', 'top');
  override('bottom', 'bottom');
  override('left', 'left', 'start');
  override('right', 'right', 'end');
  return base;
}

function fieldName(instruction: string): 'page' | 'pages' | null {
  const trimmed = instruction.trim().toUpperCase();
  if (/^NUMPAGES\b/.test(trimmed)) return 'pages';
  if (/^PAGE\b/.test(trimmed)) return 'page';
  return null;
}

function sectionFrom(
  sectPr: Element | null,
  parser: Parser,
  pkg: DocxPackage,
  documentRels: Map<string, Relationship>,
  blocks: Block[],
  options: WordPdfOptions,
): Section {
  const size = kid(sectPr, W, 'pgSz');
  let width = twips(attr(size, W, 'w'), DEFAULT_WIDTH);
  let height = twips(attr(size, W, 'h'), DEFAULT_HEIGHT);
  if (!(width > 50 && height > 50)) {
    width = DEFAULT_WIDTH;
    height = DEFAULT_HEIGHT;
  }

  if (options.paper !== 'document') {
    const forced = pageSize(options.paper, width > height ? 'landscape' : 'portrait');
    width = forced.width;
    height = forced.height;
  }

  const margin = kid(sectPr, W, 'pgMar');
  const margins = {
    top: twips(attr(margin, W, 'top'), DEFAULT_MARGIN),
    right: twips(attr(margin, W, 'right'), DEFAULT_MARGIN),
    bottom: twips(attr(margin, W, 'bottom'), DEFAULT_MARGIN),
    left: twips(attr(margin, W, 'left'), DEFAULT_MARGIN),
  };
  // Word allows negative margins for bleed, and we have nowhere to draw that
  margins.top = clamp(margins.top, height / 3);
  margins.bottom = clamp(margins.bottom, height / 3);
  margins.left = clamp(margins.left, width / 3);
  margins.right = clamp(margins.right, width / 3);

  const banner = (kind: 'headerReference' | 'footerReference', type: string): Block[] | null => {
    if (!options.headersFooters) return null;
    for (const reference of kids(sectPr, W, kind)) {
      if ((attr(reference, W, 'type') ?? 'default') !== type) continue;
      const id = attr(reference, R, 'id');
      const target = id ? documentRels.get(id) : undefined;
      if (!target || target.external) continue;

      const path = resolvePart('word/document.xml', target.target);
      const doc = pkg.xml(path, kind === 'headerReference' ? 'page header' : 'page footer');
      if (!doc) continue;
      const found = parser.blocks(doc.documentElement, { path, rels: pkg.relationships(path) });
      if (found.length > 0) return found;
    }
    return null;
  };

  return {
    width,
    height,
    margins,
    headerAt: twips(attr(margin, W, 'header'), 36),
    footerAt: twips(attr(margin, W, 'footer'), 36),
    blocks,
    header: banner('headerReference', 'default'),
    firstHeader: banner('headerReference', 'first'),
    footer: banner('footerReference', 'default'),
    firstFooter: banner('footerReference', 'first'),
    titlePage: flag(kid(sectPr, W, 'titlePg')) === true,
    columns: Math.max(1, number(attr(kid(sectPr, W, 'cols'), W, 'num'), 1)),
  };
}

const clamp = (value: number, ceiling: number): number =>
  Math.min(Math.max(value, 0), Math.max(0, ceiling));

export async function parseDocx(file: File, options: WordPdfOptions): Promise<WordDocument> {
  const pkg = await DocxPackage.open(file, options.images);
  const body = deep(pkg.xml('word/document.xml', 'document'), W, 'body');
  if (!body) throw new DocxError(`“${file.name}” has no readable body text.`);

  const styles = new StyleSheet(
    pkg.xml('word/styles.xml', 'styles'),
    pkg.xml('word/theme/theme1.xml', 'theme'),
  );
  const numbering = new Numbering(pkg.xml('word/numbering.xml', 'list numbering'), styles);
  const parser = new Parser(pkg, styles, numbering, options);
  const documentRels = pkg.relationships('word/document.xml');
  const part: Part = { path: 'word/document.xml', rels: documentRels };

  const sections: Section[] = [];
  let pending: Element[] = [];

  const close = (sectPr: Element | null): void => {
    sections.push(
      sectionFrom(sectPr, parser, pkg, documentRels, parser.blocksOf(pending, part), options),
    );
    pending = [];
  };

  for (let node = body.firstElementChild; node; node = node.nextElementSibling) {
    if (node.namespaceURI !== W) continue;

    if (node.localName === 'sectPr') {
      close(node);
      continue;
    }

    pending.push(node);
    const breakHere = node.localName === 'p' ? kid(kid(node, W, 'pPr'), W, 'sectPr') : null;
    if (breakHere) close(breakHere);
  }

  if (pending.length > 0) close(null);

  if (sections.length === 0 || sections.every((section) => section.blocks.length === 0)) {
    throw new DocxError(`“${file.name}” opened, but there is nothing in it to draw.`);
  }

  if (sections.some((section) => section.columns > 1)) {
    parser.notes.add('Text laid out in newspaper columns is drawn as a single column instead.');
  }

  return {
    filename: file.name,
    sections,
    media: pkg.media,
    notes: [...parser.notes],
  };
}
