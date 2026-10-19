import { DocxError, PKG, deepAll, parseXml } from './xml';

export interface Relationship {
  type: string;
  target: string;
  external: boolean;
}

const MAX_MEDIA_BYTES = 80 * 1024 * 1024;

/** The parts of a .docx we care about, already unzipped. */
export class DocxPackage {
  private constructor(
    private readonly texts: Map<string, string>,
    readonly media: Map<string, Uint8Array>,
  ) {}

  static async open(file: File, wantMedia: boolean): Promise<DocxPackage> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
      throw new DocxError(
        bytes[0] === 0xd0
          ? `“${file.name}” is an old .doc file, not a .docx. Open it in Word or LibreOffice and save it as .docx first.`
          : `“${file.name}” doesn’t look like a Word file. It may be corrupt, or another kind of file with a .docx name.`,
      );
    }

    const { default: JSZip } = await import('jszip');
    let zip;
    try {
      zip = await JSZip.loadAsync(bytes);
    } catch {
      throw new DocxError(`“${file.name}” could not be unpacked. It is probably corrupt.`);
    }

    const texts = new Map<string, string>();
    const media = new Map<string, Uint8Array>();
    let mediaBytes = 0;

    for (const path of Object.keys(zip.files)) {
      const entry = zip.files[path];
      if (entry.dir) continue;

      if (path.endsWith('.xml') || path.endsWith('.rels')) {
        texts.set(path, await entry.async('string'));
        continue;
      }
      if (wantMedia && /^word\/media\//i.test(path)) {
        const data = await entry.async('uint8array');
        mediaBytes += data.byteLength;
        if (mediaBytes > MAX_MEDIA_BYTES) continue;
        media.set(path, data);
      }
    }

    if (!texts.has('word/document.xml')) {
      throw new DocxError(
        `“${file.name}” is missing the document itself. It may be a template or a damaged file.`,
      );
    }

    return new DocxPackage(texts, media);
  }

  xml(path: string, what: string): Document | null {
    const text = this.texts.get(path);
    return text === undefined ? null : parseXml(text, what);
  }

  has(path: string): boolean {
    return this.texts.has(path);
  }

  /** Relationships declared for one part, keyed by r:id. */
  relationships(partPath: string): Map<string, Relationship> {
    const out = new Map<string, Relationship>();
    const slash = partPath.lastIndexOf('/');
    const folder = slash === -1 ? '' : partPath.slice(0, slash);
    const name = slash === -1 ? partPath : partPath.slice(slash + 1);
    const doc = this.xml(`${folder}/_rels/${name}.rels`, 'list of linked parts');
    if (!doc) return out;

    for (const element of deepAll(doc, PKG, 'Relationship')) {
      const id = element.getAttribute('Id');
      const target = element.getAttribute('Target');
      if (!id || !target) continue;
      out.set(id, {
        type: element.getAttribute('Type') ?? '',
        target,
        external: element.getAttribute('TargetMode') === 'External',
      });
    }
    return out;
  }
}

/** Turns a relationship target into the path it has inside the zip. */
export function resolvePart(fromPart: string, target: string): string {
  if (/^[a-z]+:/i.test(target)) return target;
  const slash = fromPart.lastIndexOf('/');
  const folder = slash === -1 ? '' : fromPart.slice(0, slash);
  const parts = target.replace(/^\//, '').split('/');
  const stack = folder ? folder.split('/') : [];

  for (const part of parts) {
    if (part === '.' || part === '') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  return stack.join('/');
}
