import type {
  PDFDict as PdfDict,
  PDFDocument as PdfDocument,
  PDFName as PdfName,
  PDFObject as PdfObject,
  PDFPage as PdfPage,
  PDFPageLeaf as PdfPageLeaf,
  PDFRef as PdfRef,
} from 'pdf-lib';
import { plural } from '@/lib/format';
import { PdfToolsError } from './errors';
import { tick, type LoadedPdf } from './pdf';

type PdfLib = typeof import('pdf-lib');

/** Clockwise, in degrees: the only steps a PDF page can turn by. */
export type Turn = 0 | 90 | 180 | 270;
export type Direction = 'left' | 'right';

export interface PageInfo {
  /** Visible size in points, before the page's own rotation. */
  width: number;
  height: number;
  rotation: Turn;
}

export interface SourcePage {
  kind: 'source';
  key: string;
  /** 1-based, in the original file. */
  page: number;
  /** On top of whatever rotation the page already has. */
  turn: Turn;
}

export interface BlankPage {
  kind: 'blank';
  key: string;
  width: number;
  height: number;
  turn: Turn;
}

export type OrganisedPage = SourcePage | BlankPage;

export interface Layout {
  pages: OrganisedPage[];
  /** Original pages with no copy left in `pages`. */
  removed: SourcePage[];
}

export type OrganiseStage = 'reading' | 'arranging' | 'saving';

export interface LayoutSummary {
  pages: number;
  rotated: number;
  deleted: number;
  duplicated: number;
  blanks: number;
  reordered: boolean;
  changed: boolean;
}

/** pdf.js shows a page with no usable MediaBox at US Letter size, so the output does too. */
const LETTER: readonly [number, number, number, number] = [0, 0, 612, 792];
/** The largest page side the PDF format allows, in points. */
const MAX_SIDE = 14400;
const PAGE_MARK = 'Docsphin-page-';

let nextKey = 1;

function freshKey(prefix: string): string {
  return `${prefix}${nextKey++}`;
}

export function normaliseTurn(degrees: number): Turn {
  // pdf.js ignores a /Rotate that is not a quarter turn, so the previews and the output agree.
  if (!Number.isFinite(degrees) || degrees % 90 !== 0) return 0;
  return (((degrees % 360) + 360) % 360) as Turn;
}

export function turned(turn: Turn, direction: Direction): Turn {
  return normaliseTurn(turn + (direction === 'right' ? 90 : -90));
}

export function initialLayout(pageCount: number): Layout {
  return {
    pages: Array.from({ length: pageCount }, (_, i) => ({
      kind: 'source' as const,
      key: `s${i + 1}`,
      page: i + 1,
      turn: 0 as const,
    })),
    removed: [],
  };
}

function indexOfKey(layout: Layout, key: string): number {
  return layout.pages.findIndex((page) => page.key === key);
}

export function movePage(layout: Layout, key: string, to: number): Layout {
  const from = indexOfKey(layout, key);
  const target = Math.max(0, Math.min(layout.pages.length - 1, to));
  if (from < 0 || from === target) return layout;
  const pages = layout.pages.slice();
  const [moved] = pages.splice(from, 1);
  pages.splice(target, 0, moved);
  return { ...layout, pages };
}

export function rotatePage(layout: Layout, key: string, direction: Direction): Layout {
  const at = indexOfKey(layout, key);
  if (at < 0) return layout;
  const pages = layout.pages.slice();
  pages[at] = { ...pages[at], turn: turned(pages[at].turn, direction) };
  return { ...layout, pages };
}

export function rotateAll(layout: Layout, direction: Direction): Layout {
  if (layout.pages.length === 0) return layout;
  return {
    ...layout,
    pages: layout.pages.map((page) => ({ ...page, turn: turned(page.turn, direction) })),
  };
}

export function deletePage(layout: Layout, key: string): Layout {
  const at = indexOfKey(layout, key);
  if (at < 0) return layout;
  const gone = layout.pages[at];
  const pages = layout.pages.filter((_, i) => i !== at);
  const lastCopy =
    gone.kind === 'source' &&
    !pages.some((page) => page.kind === 'source' && page.page === gone.page);
  return { pages, removed: lastCopy ? [...layout.removed, gone] : layout.removed };
}

export function duplicatePage(layout: Layout, key: string): Layout {
  const at = indexOfKey(layout, key);
  if (at < 0) return layout;
  const original = layout.pages[at];
  const pages = layout.pages.slice();
  pages.splice(at + 1, 0, { ...original, key: freshKey(original.kind === 'blank' ? 'b' : 'c') });
  return { ...layout, pages };
}

/** The page's size as it shows now, with its own rotation and any turn added here. */
export function shownSize(
  page: OrganisedPage,
  info: readonly PageInfo[],
): { width: number; height: number } {
  if (page.kind === 'blank') {
    return page.turn % 180 === 0
      ? { width: page.width, height: page.height }
      : { width: page.height, height: page.width };
  }
  const meta = info[page.page - 1] ?? { width: LETTER[2], height: LETTER[3], rotation: 0 };
  return (meta.rotation + page.turn) % 180 === 0
    ? { width: meta.width, height: meta.height }
    : { width: meta.height, height: meta.width };
}

export function addBlankAfter(layout: Layout, key: string, info: readonly PageInfo[]): Layout {
  const at = indexOfKey(layout, key);
  if (at < 0) return layout;
  const { width, height } = shownSize(layout.pages[at], info);
  const pages = layout.pages.slice();
  pages.splice(at + 1, 0, { kind: 'blank', key: freshKey('b'), width, height, turn: 0 });
  return { ...layout, pages };
}

/** Puts pages back where they sat in the original, relative to the pages still here. */
export function restorePages(layout: Layout, keys: readonly string[]): Layout {
  const wanted = new Set(keys);
  const waiting = layout.removed
    .filter((page) => wanted.has(page.key))
    .sort((a, b) => a.page - b.page);
  if (waiting.length === 0) return layout;

  const pages: OrganisedPage[] = [];
  let next = 0;
  for (const page of layout.pages) {
    if (page.kind === 'source') {
      while (next < waiting.length && waiting[next].page < page.page) pages.push(waiting[next++]);
    }
    pages.push(page);
  }
  while (next < waiting.length) pages.push(waiting[next++]);

  return { pages, removed: layout.removed.filter((page) => !wanted.has(page.key)) };
}

export function summariseLayout(layout: Layout, pageCount: number): LayoutSummary {
  let rotated = 0;
  let blanks = 0;
  let duplicated = 0;
  let reordered = false;
  let lastFirstSeen = 0;
  const seen = new Set<number>();

  for (const page of layout.pages) {
    if (page.turn !== 0) rotated++;
    if (page.kind === 'blank') {
      blanks++;
      continue;
    }
    if (seen.has(page.page)) {
      duplicated++;
      continue;
    }
    seen.add(page.page);
    if (page.page < lastFirstSeen) reordered = true;
    lastFirstSeen = page.page;
  }

  const deleted = Math.max(0, pageCount - seen.size);
  return {
    pages: layout.pages.length,
    rotated,
    deleted,
    duplicated,
    blanks,
    reordered,
    changed: reordered || rotated > 0 || deleted > 0 || duplicated > 0 || blanks > 0,
  };
}

/** "12 pages · 2 rotated · 1 deleted · 1 blank added" */
export function describeLayout(summary: LayoutSummary): string {
  const parts = [plural(summary.pages, 'page')];
  if (summary.reordered) parts.push('reordered');
  if (summary.rotated > 0) parts.push(`${summary.rotated.toLocaleString()} rotated`);
  if (summary.deleted > 0) parts.push(`${summary.deleted.toLocaleString()} deleted`);
  if (summary.duplicated > 0) parts.push(`${summary.duplicated.toLocaleString()} duplicated`);
  if (summary.blanks > 0) parts.push(`${plural(summary.blanks, 'blank')} added`);
  if (!summary.changed) parts.push('nothing changed yet');
  return parts.join(' · ');
}

function inherited(node: PdfPageLeaf, key: string, lib: PdfLib): PdfObject | undefined {
  try {
    return node.context.lookup(node.getInheritableAttribute(lib.PDFName.of(key)));
  } catch {
    return undefined;
  }
}

function readBox(
  node: PdfPageLeaf,
  key: string,
  lib: PdfLib,
): [number, number, number, number] | null {
  const box = inherited(node, key, lib);
  if (!(box instanceof lib.PDFArray) || box.size() !== 4) return null;
  const n = box.asArray().map((entry) => {
    const value = node.context.lookup(entry);
    return value instanceof lib.PDFNumber ? value.asNumber() : NaN;
  });
  if (n.some((value) => !Number.isFinite(value))) return null;
  const rect: [number, number, number, number] = [
    Math.min(n[0], n[2]),
    Math.min(n[1], n[3]),
    Math.max(n[0], n[2]),
    Math.max(n[1], n[3]),
  ];
  return rect[2] > rect[0] && rect[3] > rect[1] ? rect : null;
}

function readTurn(node: PdfPageLeaf, lib: PdfLib): Turn {
  const rotate = inherited(node, 'Rotate', lib);
  return rotate instanceof lib.PDFNumber ? normaliseTurn(rotate.asNumber()) : 0;
}

/** The visible area the way pdf.js works it out: the CropBox clipped to the MediaBox. */
function describePage(node: PdfPageLeaf, lib: PdfLib): PageInfo {
  const media = readBox(node, 'MediaBox', lib) ?? LETTER;
  const crop = readBox(node, 'CropBox', lib);
  let box = media;
  if (crop) {
    const clipped = [
      Math.max(media[0], crop[0]),
      Math.max(media[1], crop[1]),
      Math.min(media[2], crop[2]),
      Math.min(media[3], crop[3]),
    ] as const;
    if (clipped[2] > clipped[0] && clipped[3] > clipped[1]) box = clipped;
  }
  return { width: box[2] - box[0], height: box[3] - box[1], rotation: readTurn(node, lib) };
}

export async function readPageInfo(source: LoadedPdf): Promise<PageInfo[]> {
  const lib = await import('pdf-lib');
  const doc = await lib.PDFDocument.load(source.bytes.slice(), { updateMetadata: false });
  return doc.getPages().map((page) => describePage(page.node, lib));
}

function checkPages(source: LoadedPdf, pages: readonly OrganisedPage[]): void {
  if (pages.length === 0) {
    throw new PdfToolsError('Every page has been deleted — put at least one back first.');
  }
  for (const page of pages) {
    if (page.kind !== 'source') continue;
    if (!Number.isInteger(page.page) || page.page < 1 || page.page > source.pageCount) {
      throw new PdfToolsError(
        `“${source.name}” has ${source.pageCount} ${source.pageCount === 1 ? 'page' : 'pages'}, so page ${page.page} can’t be used.`,
      );
    }
  }
}

function side(points: number): number {
  return Number.isFinite(points) ? Math.min(MAX_SIDE, Math.max(1, points)) : LETTER[3];
}

/** The 0-based source page a placeholder stands for, -1 for a non-page tree node, null if it is no placeholder. */
function markOf(value: PdfObject | undefined, lib: PdfLib): number | null {
  if (!(value instanceof lib.PDFName)) return null;
  const name = value.asString();
  if (!name.startsWith(`/${PAGE_MARK}`)) return null;
  const index = Number(name.slice(PAGE_MARK.length + 1));
  return Number.isInteger(index) ? index : -1;
}

/** What to do with one value: undefined looks inside it, 'keep' leaves it, 'drop' removes it. */
type Rewrite = PdfObject | 'keep' | 'drop' | undefined;

function rewriteValues(
  doc: PdfDocument,
  lib: PdfLib,
  skip: (obj: PdfObject) => boolean,
  rewrite: (value: PdfObject, key: PdfName | null, inPageTree: boolean) => Rewrite,
): void {
  const { PDFArray, PDFDict, PDFNull, PDFPageLeaf, PDFPageTree, PDFStream } = lib;
  const seen = new Set<PdfObject>();

  const visit = (obj: PdfObject, inPageTree: boolean): void => {
    if (seen.has(obj)) return;
    seen.add(obj);
    const dict = obj instanceof PDFStream ? obj.dict : obj instanceof PDFDict ? obj : null;
    if (dict) {
      for (const [key, value] of dict.entries()) {
        const outcome = rewrite(value, key, inPageTree);
        if (outcome === undefined) visit(value, false);
        else if (outcome === 'drop') dict.delete(key);
        else if (outcome !== 'keep') dict.set(key, outcome);
      }
    } else if (obj instanceof PDFArray) {
      for (let i = 0; i < obj.size(); i++) {
        const value = obj.get(i);
        const outcome = rewrite(value, null, false);
        if (outcome === undefined) visit(value, false);
        else if (outcome === 'drop') obj.set(i, PDFNull);
        else if (outcome !== 'keep') obj.set(i, outcome);
      }
    }
  };

  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!skip(obj)) visit(obj, obj instanceof PDFPageLeaf || obj instanceof PDFPageTree);
  }
}

/** Swaps every reference to a page for a placeholder, so copying one page never drags in another, deleted or not. */
function detachPageReferences(doc: PdfDocument, lib: PdfLib): void {
  const { PDFName, PDFPageLeaf, PDFPageTree, PDFRef } = lib;
  const pageIndex = new Map<string, number>();
  doc.getPages().forEach((page, i) => pageIndex.set(page.ref.tag, i));
  const nodes = new Set(pageIndex.keys());
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFPageLeaf || obj instanceof PDFPageTree) nodes.add(ref.tag);
  }
  const parent = PDFName.of('Parent');
  const kids = PDFName.of('Kids');

  rewriteValues(
    doc,
    lib,
    (obj) => obj === doc.catalog,
    (value, key, inPageTree) => {
      if (inPageTree && (key === parent || key === kids)) return 'keep';
      if (!(value instanceof PDFRef) || !nodes.has(value.tag)) return undefined;
      return PDFName.of(`${PAGE_MARK}${pageIndex.get(value.tag) ?? 'none'}`);
    },
  );
}

function reattachPageReferences(
  doc: PdfDocument,
  placed: ReadonlyMap<number, PdfRef>,
  lib: PdfLib,
): void {
  rewriteValues(
    doc,
    lib,
    () => false,
    (value) => {
      const index = markOf(value, lib);
      if (index === null) return undefined;
      return placed.get(index) ?? 'drop';
    },
  );
}

function linkTarget(annot: PdfDict, lib: PdfLib): PdfObject | undefined {
  const { PDFDict, PDFName } = lib;
  const ctx = annot.context;
  if (annot.get(PDFName.of('Subtype')) !== PDFName.of('Link')) return undefined;
  const dest = annot.get(PDFName.of('Dest'));
  if (dest) return dest;
  const action = ctx.lookup(annot.get(PDFName.of('A')));
  if (action instanceof PDFDict && action.get(PDFName.of('S')) === PDFName.of('GoTo')) {
    return action.get(PDFName.of('D'));
  }
  return undefined;
}

function bytesKey(value: { asBytes(): Uint8Array }): string {
  return Array.from(value.asBytes(), (byte) => String.fromCharCode(byte)).join('');
}

/** Named destinations live in the catalog, which is not copied, so each link gets its target written out. */
function spellOutNamedLinks(doc: PdfDocument, used: ReadonlySet<number>, lib: PdfLib): void {
  const { PDFArray, PDFDict, PDFHexString, PDFName, PDFString } = lib;
  const ctx = doc.context;
  const pages = doc.getPages();
  let lookupName: ((name: PdfObject) => PdfObject | undefined) | null = null;

  const buildLookup = () => {
    const tree = new Map<string, PdfObject>();
    const names = ctx.lookup(doc.catalog.get(PDFName.of('Names')));
    const stack: (PdfObject | undefined)[] =
      names instanceof PDFDict ? [ctx.lookup(names.get(PDFName.of('Dests')))] : [];
    const visited = new Set<PdfObject>();
    while (stack.length > 0) {
      const node = stack.pop();
      if (!(node instanceof PDFDict) || visited.has(node)) continue;
      visited.add(node);
      const pairs = ctx.lookup(node.get(PDFName.of('Names')));
      if (pairs instanceof PDFArray) {
        for (let i = 0; i + 1 < pairs.size(); i += 2) {
          const key = ctx.lookup(pairs.get(i));
          if (key instanceof PDFString || key instanceof PDFHexString) {
            tree.set(bytesKey(key), pairs.get(i + 1));
          }
        }
      }
      const children = ctx.lookup(node.get(PDFName.of('Kids')));
      if (children instanceof PDFArray) {
        for (const child of children.asArray()) stack.push(ctx.lookup(child));
      }
    }
    const legacy = ctx.lookup(doc.catalog.get(PDFName.of('Dests')));

    return (name: PdfObject): PdfObject | undefined => {
      let found: PdfObject | undefined;
      if (name instanceof PDFName) {
        found =
          (legacy instanceof PDFDict ? legacy.get(name) : undefined) ?? tree.get(name.decodeText());
      } else if (name instanceof PDFString || name instanceof PDFHexString) {
        found =
          tree.get(bytesKey(name)) ??
          (legacy instanceof PDFDict ? legacy.get(PDFName.of(name.decodeText())) : undefined);
      }
      const target = ctx.lookup(found);
      return target instanceof PDFDict ? target.get(PDFName.of('D')) : found;
    };
  };

  for (const index of used) {
    const annots = ctx.lookup(pages[index].node.get(PDFName.of('Annots')));
    if (!(annots instanceof PDFArray)) continue;
    for (const entry of annots.asArray()) {
      const annot = ctx.lookup(entry);
      if (!(annot instanceof PDFDict)) continue;
      const target = linkTarget(annot, lib);
      const named = ctx.lookup(target);
      if (!(named instanceof PDFName || named instanceof PDFString || named instanceof PDFHexString)) {
        continue;
      }
      lookupName ??= buildLookup();
      const explicit = lookupName(named);
      if (!explicit || !(ctx.lookup(explicit) instanceof PDFArray)) continue;
      if (annot.get(PDFName.of('Dest'))) {
        annot.set(PDFName.of('Dest'), explicit);
      } else {
        const action = ctx.lookup(annot.get(PDFName.of('A')));
        if (action instanceof PDFDict) action.set(PDFName.of('D'), explicit);
      }
    }
  }
}

/** A page used twice would otherwise share its annotations, and an annotation belongs to one page. */
function separateAnnotations(page: PdfPage, lib: PdfLib): void {
  const { PDFArray, PDFDict, PDFName, PDFRef } = lib;
  const ctx = page.doc.context;
  const annots = ctx.lookup(page.node.get(PDFName.of('Annots')));
  if (!(annots instanceof PDFArray)) return;

  const fresh = new Map<string, PdfRef>();
  const clones: PdfDict[] = [];
  const entries = annots.asArray().map((entry) => {
    const annot = ctx.lookup(entry);
    if (!(annot instanceof PDFDict)) return entry;
    const clone = annot.clone(ctx);
    clones.push(clone);
    if (!(entry instanceof PDFRef)) return clone;
    const ref = ctx.register(clone);
    fresh.set(entry.tag, ref);
    return ref;
  });

  for (const clone of clones) {
    for (const key of ['Popup', 'Parent', 'IRT']) {
      const value = clone.get(PDFName.of(key));
      const swapped = value instanceof PDFRef ? fresh.get(value.tag) : undefined;
      if (swapped) clone.set(PDFName.of(key), swapped);
    }
  }
  page.node.set(PDFName.of('Annots'), ctx.obj(entries));
}

/** Claims each annotation for its page and drops links whose target page is gone. */
function settleAnnotations(page: PdfPage, placed: ReadonlyMap<number, PdfRef>, lib: PdfLib): void {
  const { PDFArray, PDFDict, PDFName } = lib;
  const ctx = page.doc.context;
  const annots = ctx.lookup(page.node.get(PDFName.of('Annots')));
  if (!(annots instanceof PDFArray)) return;

  const kept: PdfObject[] = [];
  for (const entry of annots.asArray()) {
    const annot = ctx.lookup(entry);
    if (annot instanceof PDFDict) {
      if (annot.has(PDFName.of('P'))) annot.set(PDFName.of('P'), page.ref);
      const dest = ctx.lookup(linkTarget(annot, lib));
      const index = dest instanceof PDFArray ? markOf(dest.get(0), lib) : null;
      if (index !== null && !placed.has(index)) continue;
    }
    kept.push(entry);
  }
  if (kept.length !== annots.size()) page.node.set(PDFName.of('Annots'), ctx.obj(kept));
}

function pruneUnreachable(doc: PdfDocument, lib: PdfLib): void {
  const { PDFArray, PDFDict, PDFRef, PDFStream } = lib;
  const ctx = doc.context;
  const reachable = new Set<string>();
  const stack: PdfObject[] = [];
  if (ctx.trailerInfo.Root) stack.push(ctx.trailerInfo.Root);
  if (ctx.trailerInfo.Info) stack.push(ctx.trailerInfo.Info);
  if (stack.length === 0) return;

  while (stack.length > 0) {
    const obj = stack.pop();
    if (obj instanceof PDFRef) {
      if (reachable.has(obj.tag)) continue;
      reachable.add(obj.tag);
      const target = ctx.lookup(obj);
      if (target) stack.push(target);
    } else if (obj instanceof PDFStream) {
      stack.push(obj.dict);
    } else if (obj instanceof PDFDict) {
      for (const value of obj.values()) stack.push(value);
    } else if (obj instanceof PDFArray) {
      for (const value of obj.asArray()) stack.push(value);
    }
  }

  for (const [ref] of ctx.enumerateIndirectObjects()) {
    if (!reachable.has(ref.tag)) ctx.delete(ref);
  }
}

export async function organisePdf(
  source: LoadedPdf,
  pages: readonly OrganisedPage[],
  onStage: (stage: OrganiseStage) => void = () => undefined,
): Promise<Uint8Array> {
  checkPages(source, pages);
  const lib = await import('pdf-lib');
  const { PDFDocument, PDFName, degrees } = lib;

  onStage('reading');
  await tick();
  const src = await PDFDocument.load(source.bytes.slice(), { updateMetadata: false });

  onStage('arranging');
  await tick();
  const sourcePages = src.getPages();
  const wanted = pages.flatMap((page) => (page.kind === 'source' ? [page.page - 1] : []));
  const used = new Set(wanted);
  for (const index of used) sourcePages[index].node.delete(PDFName.of('B'));
  spellOutNamedLinks(src, used, lib);
  detachPageReferences(src, lib);

  const out = await PDFDocument.create();
  const copies = await out.copyPages(src, wanted);
  const placed = new Map<number, PdfRef>();
  const added: PdfPage[] = [];
  let next = 0;

  for (const page of pages) {
    if (page.kind === 'blank') {
      const blank = out.addPage([side(page.width), side(page.height)]);
      blank.setRotation(degrees(page.turn));
      continue;
    }
    const copy = copies[next++];
    out.addPage(copy);
    if (placed.has(page.page - 1)) separateAnnotations(copy, lib);
    else placed.set(page.page - 1, copy.ref);
    if (!readBox(copy.node, 'MediaBox', lib)) {
      copy.node.set(PDFName.of('MediaBox'), out.context.obj([...LETTER]));
    }
    copy.setRotation(degrees(normaliseTurn(readTurn(copy.node, lib) + page.turn)));
    added.push(copy);
  }

  for (const copy of added) settleAnnotations(copy, placed, lib);
  reattachPageReferences(out, placed, lib);
  pruneUnreachable(out, lib);

  try {
    const title = src.getTitle();
    if (title) out.setTitle(title);
  } catch {
    // A malformed title is not worth failing the whole document over.
  }
  out.setProducer('Docsphin');

  onStage('saving');
  await tick();
  return out.save({ useObjectStreams: true, addDefaultPage: false });
}
