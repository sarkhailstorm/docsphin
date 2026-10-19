export const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
export const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
export const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
export const WP = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
export const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';
export const VML = 'urn:schemas-microsoft-com:vml';

export class DocxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocxError';
  }
}

export function parseXml(text: string, what: string): Document {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) {
    throw new DocxError(`The ${what} inside that .docx file is damaged, so it cannot be read.`);
  }
  return doc;
}

/** Direct children with this name, ignoring whatever prefix the file happens to use. */
export function kids(parent: Element | null, ns: string, name: string): Element[] {
  if (!parent) return [];
  const out: Element[] = [];
  for (let node = parent.firstElementChild; node; node = node.nextElementSibling) {
    if (node.localName === name && node.namespaceURI === ns) out.push(node);
  }
  return out;
}

export function kid(parent: Element | null, ns: string, name: string): Element | null {
  if (!parent) return null;
  for (let node = parent.firstElementChild; node; node = node.nextElementSibling) {
    if (node.localName === name && node.namespaceURI === ns) return node;
  }
  return null;
}

/** First match anywhere below, which is what most of the one-off lookups want. */
export function deep(parent: Element | Document | null, ns: string, name: string): Element | null {
  if (!parent) return null;
  return parent.getElementsByTagNameNS(ns, name)[0] ?? null;
}

export function deepAll(
  parent: Element | Document | null,
  ns: string,
  name: string,
): Element[] {
  if (!parent) return [];
  return [...parent.getElementsByTagNameNS(ns, name)];
}

export function attr(element: Element | null, ns: string, name: string): string | null {
  if (!element) return null;
  return element.getAttributeNS(ns, name) ?? element.getAttribute(name);
}

export const wVal = (element: Element | null): string | null => attr(element, W, 'val');

/** A w:b style flag: present means on, unless it says otherwise. */
export function flag(element: Element | null): boolean | null {
  if (!element) return null;
  const value = wVal(element);
  if (value === null) return true;
  return value !== '0' && value !== 'false' && value !== 'off';
}

export function number(value: string | null, fallback = 0): number {
  if (value === null) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Word measures most things in twentieths of a point. */
export const twips = (value: string | null, fallback = 0): number => number(value, fallback * 20) / 20;

/** English Metric Units, used by anything drawing-related. */
export const emu = (value: string | null, fallback = 0): number => number(value, fallback * 12700) / 12700;

/** Half-points, used only by font sizes. */
export const halfPoints = (value: string | null, fallback = 0): number =>
  number(value, fallback * 2) / 2;

export function hexColour(value: string | null, fallback: string): string {
  if (!value || value === 'auto') return fallback;
  const clean = value.replace('#', '').trim();
  return /^[0-9a-f]{6}$/i.test(clean) ? `#${clean}` : fallback;
}
