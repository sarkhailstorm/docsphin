import { bytesOutstanding, loadAssets } from '@/lib/assets';
import { PdfToolsError } from './errors';

type Qpdf = {
  FS: {
    writeFile(path: string, data: Uint8Array): void;
    readFile(path: string): Uint8Array;
    unlink(path: string): void;
  };
  callMain(args: string[]): number | undefined;
};

type QpdfOptions = {
  noInitialRun: boolean;
  print(text: string): void;
  printErr(text: string): void;
  instantiateWasm(
    imports: WebAssembly.Imports,
    done: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void,
  ): Record<string, never>;
};

const IN = '/in.pdf';
const OUT = '/out.pdf';
const JOB = '/job.json';

/** qpdf says 0 for success and 3 when it succeeded but had something to say. */
const OK = new Set([0, 3]);

const NOT_A_PDF = 'That file is not a PDF. It may have been renamed, or only half downloaded.';

const OUT_OF_MEMORY =
  'The browser ran out of memory. Close a few other tabs, or reload the page, then try again.';

let compiled: Promise<WebAssembly.Module> | null = null;

async function compile(): Promise<WebAssembly.Module> {
  if (compiled) return compiled;
  compiled = (async () => {
    const assets = await loadAssets(['qpdf'], () => {});
    const bytes = assets.qpdf;
    if (!bytes) {
      throw new PdfToolsError(
        'The unlocker couldn’t be downloaded. Check your connection and try again.',
      );
    }
    // A fresh copy: the cached Uint8Array is reused, and compiling can detach it.
    return WebAssembly.compile(bytes.slice().buffer);
  })();
  try {
    return await compiled;
  } catch (err) {
    compiled = null;
    throw err;
  }
}

interface Run {
  code: number;
  output: Uint8Array | null;
}

async function run(
  args: string[],
  bytes: Uint8Array,
  wantsOutput: boolean,
  files: Record<string, string> = {},
): Promise<Run> {
  const wasm = await compile();
  // qpdf's .mjs entry hands its factory over through globalThis, which the bundler rewrites away; the CJS build exports it properly.
  const loaded = (await import('@jspawn/qpdf-wasm/qpdf.js')) as unknown as {
    default?: (options: QpdfOptions) => Promise<Qpdf>;
  };
  const createModule = loaded.default ?? (loaded as unknown as (options: QpdfOptions) => Promise<Qpdf>);

  const qpdf = await new Promise<Qpdf>((resolve, reject) => {
    createModule({
      noInitialRun: true,
      // qpdf's messages never reach these in the browser build; the exit code and output file decide.
      print: () => {},
      printErr: () => {},
      instantiateWasm(imports, done) {
        // qpdf.js never hears about a failed instantiate, so its own promise would wait forever.
        WebAssembly.instantiate(wasm, imports).then(
          (instance) => done(instance, wasm),
          () => reject(new PdfToolsError(OUT_OF_MEMORY)),
        );
        return {};
      },
    }).then(resolve, reject);
  });

  qpdf.FS.writeFile(IN, bytes);
  for (const [path, text] of Object.entries(files)) {
    qpdf.FS.writeFile(path, new TextEncoder().encode(text));
  }
  let code = 0;
  try {
    code = qpdf.callMain(args) ?? 0;
  } catch (thrown) {
    // Emscripten throws an ExitStatus rather than returning, for a non-zero exit.
    const status = (thrown as { status?: number }).status;
    code = typeof status === 'number' ? status : -1;
  }

  let output: Uint8Array | null = null;
  if (wantsOutput && OK.has(code)) {
    try {
      output = qpdf.FS.readFile(OUT);
    } catch {
      output = null;
    }
  }
  return { code, output };
}

export type UnlockOutcome =
  | { kind: 'not-protected' }
  | { kind: 'needs-password' }
  | { kind: 'wrong-password' }
  | {
      kind: 'unlocked';
      bytes: Uint8Array;
      removed: 'password' | 'restrictions';
    };

function looksLikePdfBytes(bytes: Uint8Array): boolean {
  return (
    bytes.length > 8 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d
  );
}

function hasEncryptDictionary(bytes: Uint8Array): boolean {
  const needle = [0x2f, 0x45, 0x6e, 0x63, 0x72, 0x79, 0x70, 0x74]; // "/Encrypt"
  outer: for (let at = 0; at <= bytes.length - needle.length; at++) {
    for (let i = 0; i < needle.length; i++) {
      if (bytes[at + i] !== needle[i]) continue outer;
    }
    return true;
  }
  return false;
}

/** Pass an empty password to probe: a restrictions-only file comes back unlocked. */
export async function unlockPdf(bytes: Uint8Array, password: string): Promise<UnlockOutcome> {
  if (!looksLikePdfBytes(bytes)) throw new PdfToolsError(NOT_A_PDF);

  const encrypted = hasEncryptDictionary(bytes);
  const result = await run(['--decrypt', `--password=${password}`, IN, OUT], bytes, true);

  if (OK.has(result.code) && result.output) {
    if (!encrypted) return { kind: 'not-protected' };
    return {
      kind: 'unlocked',
      bytes: result.output,
      removed: password === '' ? 'restrictions' : 'password',
    };
  }

  if (encrypted) {
    return password === '' ? { kind: 'needs-password' } : { kind: 'wrong-password' };
  }

  throw new PdfToolsError(
    'That PDF could not be opened. It may be damaged, or only half downloaded.',
  );
}

/** Null when the PDF has no protection yet, otherwise why a new password cannot go on as it is. */
export async function describeExistingProtection(
  bytes: Uint8Array,
  filename?: string,
): Promise<string | null> {
  if (!hasEncryptDictionary(bytes)) return null;
  const label = filename ? `“${filename}”` : 'This PDF';

  if ((await run(['--requires-password', IN], bytes, false)).code === 3) {
    return `${label} already has restrictions on it, such as no printing or copying. Take them off in the Unlock tab first, then come back.`;
  }
  // This build exits 2 both for "needs a password" and for "not encrypted after all"; only the first stops a plain rewrite.
  if (OK.has((await run([IN, OUT], bytes, false)).code)) return null;
  return `${label} already has a password. Take it off in the Unlock tab first, then come back.`;
}

// What SASLprep maps or refuses beyond NFKC's changes: RFC 3454 tables B.1, C.1.2 and C.2 to C.9.
const SASLPREP_CHANGES =
  /[^\S ]|[\p{Cc}\p{Cf}\p{Co}\p{Noncharacter_Code_Point}\u034F\u1806\u180B-\u180D\u2FF0-\u2FFB\uFE00-\uFE0F\uFFFC\uFFFD]/u;

// Unicode's blocks for right-to-left scripts, as JS regexes can't test a character's bidi class.
const RIGHT_TO_LEFT = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF\u{10800}-\u{10FFF}\u{1E800}-\u{1EFFF}]/u;

/** SASLprep's bidi rule: with any right-to-left writing, it must start and end with a right-to-left letter and have no left-to-right ones. */
function breaksBidiRule(password: string): boolean {
  const chars = Array.from(password);
  const rtlLetter = (char: string) => RIGHT_TO_LEFT.test(char) && /\p{L}/u.test(char);
  if (!chars.some((char) => RIGHT_TO_LEFT.test(char) && /[\p{L}\p{P}\p{S}]/u.test(char))) return false;
  if (!rtlLetter(chars[0]) || !rtlLetter(chars[chars.length - 1])) return true;
  return chars.some((char) => /\p{L}/u.test(char) && !RIGHT_TO_LEFT.test(char));
}

/** Why a password cannot go on a PDF as typed, or null when it can. */
export function passwordProblem(password: string): string | null {
  const bytes = new TextEncoder().encode(password);
  // qpdf refuses a lone surrogate, and quietly cuts a password off at a NUL.
  if (password.includes('\0') || new TextDecoder().decode(bytes) !== password) {
    return 'That password has a character in it that a PDF can’t store. Try another.';
  }
  // AES-256 passwords stop at 127 bytes, and qpdf 11.0 writes a file nobody can open past that.
  if (bytes.length > 127) return 'That’s longer than a PDF password can be. Try a shorter one.';
  // ISO 32000-2 readers SASLprep a typed password before hashing it and pdf.js doesn't, so only one SASLprep leaves alone opens in both.
  if (password.normalize('NFKC') !== password || SASLPREP_CHANGES.test(password)) {
    return 'That password has a character in it, such as ² or a non-breaking space, that some PDF readers read differently. Try another.';
  }
  if (breaksBidiRule(password)) {
    return 'Some PDF readers refuse a password with right-to-left letters, such as Arabic or Hebrew, unless it starts and ends with one and has no left-to-right letters. Try another.';
  }
  return null;
}

function randomPassword(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** A clean copy written by pdf-lib, or null when pdf-lib cannot read the file either. */
async function rebuildWithPdfLib(bytes: Uint8Array): Promise<Uint8Array | null> {
  try {
    const { PDFDocument } = await import('pdf-lib');
    const doc = await PDFDocument.load(bytes.slice(), { updateMetadata: false });
    doc.setProducer('Docsphin');
    return await doc.save({ useObjectStreams: true, addDefaultPage: false });
  } catch {
    return null;
  }
}

async function encryptCopy(bytes: Uint8Array, password: string): Promise<Uint8Array | null> {
  // qpdf 11.0 has no --user-password=; --encrypt takes bare arguments, which it can read as options or @files.
  const job = JSON.stringify({
    inputFile: IN,
    outputFile: OUT,
    encrypt: {
      userPassword: password,
      // Random, never empty: with an empty owner password, qpdf opens the file without asking for any password.
      ownerPassword: randomPassword(),
      '256bit': {},
    },
  });
  const { output } = await run([`--job-json-file=${JOB}`], bytes, true, { [JOB]: job });
  const verify = ['--requires-password', `--password=${password}`, IN];
  // Exit 3 means encrypted, and this password opens it; nothing else is handed back.
  if (output && (await run(verify, output, false)).code === 3) return output;
  return null;
}

/** Adds an open password with AES-256. Nothing is restricted once the file is open. */
export async function protectPdf(bytes: Uint8Array, password: string): Promise<Uint8Array> {
  // pdf-lib, and so the panel, accepts a PDF with stray bytes before its header.
  const source = looksLikePdfBytes(bytes) ? bytes : await rebuildWithPdfLib(bytes);
  if (!source) throw new PdfToolsError(NOT_A_PDF);
  if (password === '') throw new PdfToolsError('Choose a password first.');
  const unusable = passwordProblem(password);
  if (unusable) throw new PdfToolsError(unusable);

  try {
    await compile();
  } catch {
    throw new PdfToolsError(
      'Adding a password needs a one-time download, and it didn’t come through. Check your connection and try again.',
    );
  }

  const problem = await describeExistingProtection(source);
  if (problem) throw new PdfToolsError(problem);

  let output = await encryptCopy(source, password);
  if (!output && source === bytes) {
    // This qpdf build never runs its own repair, so a broken cross-reference table stops it; pdf-lib reads past one.
    const rebuilt = await rebuildWithPdfLib(source);
    if (rebuilt) output = await encryptCopy(rebuilt, password);
  }
  if (output) return output;
  throw new PdfToolsError(
    'That PDF could not be protected. It may be damaged, or only half downloaded.',
  );
}

export async function isUnlockerReady(): Promise<boolean> {
  return (await bytesOutstanding(['qpdf'])) === 0;
}

/** "about 330 KB", or null when there is nothing left to fetch. */
export async function unlockerDownloadSize(): Promise<string | null> {
  const bytes = await bytesOutstanding(['qpdf']);
  if (bytes === 0) return null;
  // Served compressed; this one comes down to roughly a quarter of its size.
  const over = bytes * 0.26;
  return over < 1_000_000
    ? `about ${Math.round(over / 10_000) * 10} KB`
    : `about ${(over / 1_000_000).toFixed(1)} MB`;
}
