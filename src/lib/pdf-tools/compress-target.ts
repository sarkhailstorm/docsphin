import { formatBytes, plural } from '@/lib/format';
import { PdfToolsError } from './errors';
import {
  compressPdf,
  encodeJpeg,
  MAX_CANVAS_PIXELS,
  tick,
  type CompressProgress,
  type CompressReport,
  type LoadedPdf,
} from './pdf';

export type SizeUnit = 'KB' | 'MB';

export interface SizeTarget {
  amount: number;
  unit: SizeUnit;
}

export const QUICK_TARGETS: readonly SizeTarget[] = [
  { amount: 100, unit: 'KB' },
  { amount: 200, unit: 'KB' },
  { amount: 500, unit: 'KB' },
  { amount: 1, unit: 'MB' },
  { amount: 2, unit: 'MB' },
];

/** Upload forms disagree on 1,000 or 1,024 bytes to the KB; staying under 1,000 passes either check. */
const STRICT_UNIT: Record<SizeUnit, number> = { KB: 1_000, MB: 1_000_000 };
const LOOSE_UNIT: Record<SizeUnit, number> = { KB: 1_024, MB: 1_048_576 };
const STRICT_WORDS: Record<SizeUnit, string> = { KB: '1,000 bytes to the KB', MB: '1,000 KB to the MB' };
const LOOSE_WORDS: Record<SizeUnit, string> = { KB: '1,024 bytes to the KB', MB: '1,024 KB to the MB' };

const MIN_TARGET_BYTES = 10_000;
const MAX_TARGET_BYTES = 1_000_000_000;

const TYPED_UNITS: Record<string, SizeUnit> = {
  k: 'KB',
  kb: 'KB',
  kib: 'KB',
  m: 'MB',
  mb: 'MB',
  mib: 'MB',
};

export function targetBytes(target: SizeTarget): number {
  return Math.round(target.amount * STRICT_UNIT[target.unit]);
}

export function formatTarget(target: SizeTarget): string {
  return `${target.amount.toLocaleString('en-GB', { maximumFractionDigits: 2 })} ${target.unit}`;
}

export type TargetParse = { ok: true; target: SizeTarget } | { ok: false; message: string };

/** Reads "750", "1.5 MB" or "1,5". A unit typed into the box wins over the one picked beside it. */
export function parseTarget(text: string, unit: SizeUnit): TargetParse {
  const [, typedFigure = '', typedUnit = ''] = /^(.*?)\s*([a-z]*)$/i.exec(text.trim()) ?? [];
  let figure = typedFigure.replace(/\s/g, '');
  const chosen = typedUnit ? TYPED_UNITS[typedUnit.toLowerCase()] : unit;

  if (!figure) return { ok: false, message: 'Type a number, like 750 or 1.5.' };
  if (!chosen) return { ok: false, message: 'Use KB or MB, like 750 KB or 1.5 MB.' };

  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(figure)) figure = figure.replace(/,/g, '');
  else if (/^\d*,\d+$/.test(figure)) figure = figure.replace(',', '.');
  if (!/^(\d+\.?\d*|\.\d+)$/.test(figure)) {
    return { ok: false, message: 'Type a number, like 750 or 1.5.' };
  }

  // Two decimals at most, rounded down so the limit never ends up looser than typed; 1e-6 absorbs float error.
  const target: SizeTarget = { amount: Math.floor(Number(figure) * 100 + 1e-6) / 100, unit: chosen };
  const bytes = targetBytes(target);
  if (bytes < MIN_TARGET_BYTES) {
    return { ok: false, message: 'A PDF can’t usually get that small. Try 10 KB or more.' };
  }
  if (bytes > MAX_TARGET_BYTES) {
    return { ok: false, message: 'That’s far more than this needs. Try 1,000 MB or less.' };
  }
  return { ok: true, target };
}

export function limitHint(target: SizeTarget, currentSize: number): string {
  const bytes = targetBytes(target);
  const unit = target.unit === 'KB' ? 'a KB' : 'an MB';
  const already = currentSize <= bytes ? ' Your PDF already does.' : '';
  return `Aims for ${bytesText(bytes)} or less, so it passes whichever way the site counts ${unit}.${already}`;
}

/** Over the limit for a site counting in 1,000s, but within it for one counting in 1,024s. */
function closeCall(bytes: number, target: SizeTarget): boolean {
  return bytes > targetBytes(target) && bytes <= target.amount * LOOSE_UNIT[target.unit];
}

function bytesText(bytes: number): string {
  return `${bytes.toLocaleString('en-GB')} bytes`;
}

/** formatBytes counts in 1,024s and rounds, so a size over the limit can still read as “1.0 MB”. */
function looksOver(bytes: number, target: SizeTarget): boolean {
  const [figure, unit] = formatBytes(bytes).split(' ');
  const scale: Record<string, number> = { B: 1, KB: 1_000, MB: 1_000_000 };
  return Number(figure) * (scale[unit] ?? Infinity) > targetBytes(target);
}

/** The size as a site counting in 1,000s shows it, rounded up so it never reads smaller than it is. */
function strictSize(bytes: number, unit: SizeUnit): string {
  const places = unit === 'KB' ? 1 : 2;
  const figure = Math.ceil(bytes / (STRICT_UNIT[unit] / 10 ** places)) / 10 ** places;
  return `${figure.toLocaleString('en-GB', { maximumFractionDigits: places })} ${unit}`;
}

function pixels(edge: number): string {
  return `${edge.toLocaleString('en-GB')} px`;
}

export interface CompressStep {
  /** JPEG quality as a percentage, or null to leave every image exactly as it is. */
  quality: number | null;
  /** Longest side, in pixels, an image may keep. */
  maxEdge: number;
}

/** Full size in practice, and as many pixels as iOS will put on one canvas. */
const FULL_SIZE = 4096;

/** Gentlest first, each step roughly a fifth to a third smaller; quality and size never go back up. */
export const COMPRESS_LADDER: readonly CompressStep[] = [
  { quality: null, maxEdge: FULL_SIZE },
  { quality: 85, maxEdge: FULL_SIZE },
  { quality: 80, maxEdge: FULL_SIZE },
  { quality: 75, maxEdge: FULL_SIZE },
  { quality: 70, maxEdge: FULL_SIZE },
  { quality: 65, maxEdge: FULL_SIZE },
  { quality: 65, maxEdge: 3600 },
  { quality: 65, maxEdge: 3200 },
  { quality: 60, maxEdge: 2800 },
  { quality: 60, maxEdge: 2400 },
  { quality: 60, maxEdge: 2100 },
  { quality: 55, maxEdge: 1800 },
  { quality: 55, maxEdge: 1600 },
  { quality: 55, maxEdge: 1400 },
  { quality: 50, maxEdge: 1250 },
  { quality: 50, maxEdge: 1100 },
  { quality: 45, maxEdge: 1000 },
  { quality: 45, maxEdge: 900 },
  { quality: 40, maxEdge: 800 },
  { quality: 40, maxEdge: 700 },
  { quality: 35, maxEdge: 700 },
  { quality: 30, maxEdge: 700 },
];

export interface FlattenStep {
  dpi: number;
  /** JPEG quality as a percentage. */
  quality: number;
}

/** Every attempt is scaled down from one render per page at this resolution. */
const MASTER_DPI = 150;
const MASTER_QUALITY = 0.92;

export const FLATTEN_LADDER: readonly FlattenStep[] = [
  { dpi: 150, quality: 75 },
  { dpi: 150, quality: 60 },
  { dpi: 125, quality: 60 },
  { dpi: 110, quality: 55 },
  { dpi: 96, quality: 50 },
  { dpi: 85, quality: 45 },
  { dpi: 72, quality: 40 },
  { dpi: 60, quality: 35 },
];

export interface LadderOutcome<R> {
  result: R;
  index: number;
  fits: boolean;
  attempts: number;
}

/** The most attempts searchLadder makes on a ladder this long. */
export function maxAttempts(length: number): number {
  return length < 1 ? 0 : 1 + Math.ceil(Math.log2(length));
}

/** Gentlest step within the limit; strongest first, so a hopeless file costs one try. Sizes may bounce: the answer was always tried. */
export async function searchLadder<S, R extends { size: number }>(
  ladder: readonly S[],
  limit: number,
  probe: (step: S, attempt: number) => Promise<R>,
): Promise<LadderOutcome<R>> {
  if (ladder.length === 0) throw new RangeError('There are no settings to try.');

  const strongest = ladder.length - 1;
  const first = await probe(ladder[strongest], 1);
  if (first.size > limit) return { result: first, index: strongest, fits: false, attempts: 1 };

  let best = { result: first, index: strongest };
  let attempts = 1;
  let lo = 0;
  let hi = strongest;
  while (lo < hi) {
    const index = Math.floor((lo + hi) / 2);
    attempts++;
    const result = await probe(ladder[index], attempts);
    if (result.size <= limit) {
      best = { result, index };
      hi = index;
    } else {
      lo = index + 1;
    }
  }
  return { ...best, fits: true, attempts };
}

interface TargetBase {
  target: SizeTarget;
  originalSize: number;
  pageCount: number;
  /** What to hand over: within the limit unless `kind` is 'over'. */
  bytes: Uint8Array;
  /** True when `bytes` is the original file, exactly as it came in. */
  untouched: boolean;
  attempts: number;
}

export type TargetResult =
  | (TargetBase & {
      kind: 'already';
      method: 'compress';
      /** Null when the tidy-up failed and the file, which fitted anyway, is handed back as it was. */
      report: CompressReport | null;
    })
  | (TargetBase & {
      kind: 'fits' | 'over';
      method: 'compress';
      step: CompressStep;
      report: CompressReport;
    })
  | (TargetBase & { kind: 'fits' | 'over'; method: 'images'; step: FlattenStep });

export type TargetProgress =
  | ({ phase: 'tidy' } & CompressProgress)
  | ({ phase: 'compress'; attempt: number; attempts: number; step: CompressStep } & CompressProgress)
  | { phase: 'render'; done: number; total: number }
  | {
      phase: 'images';
      attempt: number;
      attempts: number;
      step: FlattenStep;
      done: number;
      total: number;
    };

/** Gentlest setting that brings the PDF within the limit, or the smallest it can get if none does. */
export async function fitUnderSize(
  source: LoadedPdf,
  target: SizeTarget,
  onProgress: (progress: TargetProgress) => void,
): Promise<TargetResult> {
  const limit = targetBytes(target);
  const originalSize = source.bytes.byteLength;

  if (originalSize <= limit) {
    let report: CompressReport | null = null;
    try {
      report = await compressPdf(source, null, (progress) => onProgress({ phase: 'tidy', ...progress }));
    } catch {
      // It fits already, so the tidy-up was only ever a bonus.
    }
    return {
      kind: 'already',
      method: 'compress',
      target,
      originalSize,
      pageCount: report?.pageCount ?? source.pageCount,
      bytes: report?.bytes ?? source.bytes,
      untouched: report?.keptOriginal ?? true,
      attempts: 1,
      report,
    };
  }

  const attempts = maxAttempts(COMPRESS_LADDER.length);
  const outcome = await searchLadder(COMPRESS_LADDER, limit, async (step, attempt) => {
    const report = await compressPdf(
      source,
      step.quality === null ? null : step.quality / 100,
      (progress) => onProgress({ phase: 'compress', attempt, attempts, step, ...progress }),
      { maxEdge: step.maxEdge },
    );
    return { size: report.bytes.byteLength, step, report };
  });
  const { report, step } = outcome.result;

  return {
    kind: outcome.fits ? 'fits' : 'over',
    method: 'compress',
    target,
    originalSize,
    pageCount: report.pageCount,
    bytes: report.bytes,
    untouched: report.keptOriginal,
    attempts: outcome.attempts,
    step,
    report,
  };
}

/** Turns every page into a JPEG and rebuilds the PDF at the same page sizes. Text stops being text. */
export async function flattenUnderSize(
  source: LoadedPdf,
  target: SizeTarget,
  onProgress: (progress: TargetProgress) => void,
): Promise<TargetResult> {
  const pages = await renderPages(source, (done, total) =>
    onProgress({ phase: 'render', done, total }),
  );
  const attempts = maxAttempts(FLATTEN_LADDER.length);
  const outcome = await searchLadder(FLATTEN_LADDER, targetBytes(target), async (step, attempt) => {
    const bytes = await pagesFromImages(pages, step, (done) =>
      onProgress({ phase: 'images', attempt, attempts, step, done, total: pages.length }),
    );
    return { size: bytes.byteLength, step, bytes };
  });

  return {
    kind: outcome.fits ? 'fits' : 'over',
    method: 'images',
    target,
    originalSize: source.bytes.byteLength,
    pageCount: pages.length,
    bytes: outcome.result.bytes,
    untouched: false,
    attempts: outcome.attempts,
    step: outcome.result.step,
  };
}

interface PageImage {
  /** Size in points as displayed, rotation included. */
  width: number;
  height: number;
  master: Blob;
  pixelWidth: number;
  pixelHeight: number;
}

async function renderPages(
  source: LoadedPdf,
  onProgress: (done: number, total: number) => void,
): Promise<PageImage[]> {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
  const task = pdfjs.getDocument({ data: source.bytes.slice() });
  const pages: PageImage[] = [];

  try {
    const doc = await task.promise;
    for (let number = 1; number <= doc.numPages; number++) {
      onProgress(number - 1, doc.numPages);
      await tick();

      const page = await doc.getPage(number);
      const canvas = document.createElement('canvas');
      try {
        const size = page.getViewport({ scale: 1 });
        let scale = MASTER_DPI / 72;
        const area = size.width * size.height * scale * scale;
        if (area > MAX_CANVAS_PIXELS) scale *= Math.sqrt(MAX_CANVAS_PIXELS / area);
        const viewport = page.getViewport({ scale });

        canvas.width = Math.max(1, Math.floor(viewport.width));
        canvas.height = Math.max(1, Math.floor(viewport.height));
        const context = canvas.getContext('2d');
        if (!context) throw new PdfToolsError('This browser would not provide a 2D canvas.');

        // A PDF page has no background of its own, and JPEG has no alpha.
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: context, viewport }).promise;

        const master = await new Promise<Blob | null>((resolve) => {
          canvas.toBlob(resolve, 'image/jpeg', MASTER_QUALITY);
        });
        if (!master) throw new PdfToolsError(`Page ${number} could not be turned into an image.`);
        pages.push({
          width: size.width,
          height: size.height,
          master,
          pixelWidth: canvas.width,
          pixelHeight: canvas.height,
        });
      } finally {
        page.cleanup();
        canvas.width = 0;
        canvas.height = 0;
      }
    }
  } finally {
    void task.destroy().catch(() => undefined);
  }

  onProgress(pages.length, pages.length);
  return pages;
}

async function pagesFromImages(
  pages: readonly PageImage[],
  step: FlattenStep,
  onProgress: (done: number) => void,
): Promise<Uint8Array> {
  const { PDFDocument } = await import('pdf-lib');
  const out = await PDFDocument.create();

  for (let i = 0; i < pages.length; i++) {
    onProgress(i);
    await tick();

    const page = pages[i];
    const shrink = Math.min(1, step.dpi / 72 / (page.pixelWidth / page.width));
    const bitmap = await createImageBitmap(page.master);
    const jpeg = await encodeJpeg(
      bitmap,
      Math.max(1, Math.round(page.pixelWidth * shrink)),
      Math.max(1, Math.round(page.pixelHeight * shrink)),
      step.quality / 100,
    ).finally(() => bitmap.close());
    if (!jpeg) throw new PdfToolsError(`Page ${i + 1} could not be turned into an image.`);

    const image = await out.embedJpg(jpeg);
    out
      .addPage([page.width, page.height])
      .drawImage(image, { x: 0, y: 0, width: page.width, height: page.height });
  }

  onProgress(pages.length);
  out.setProducer('Docsphin');
  return out.save({ useObjectStreams: true, addDefaultPage: false });
}

/** How far along the whole job is, from 0 to 1. */
export function progressShare(progress: TargetProgress): number {
  switch (progress.phase) {
    case 'tidy':
      return stageShare(progress);
    case 'compress':
      return (progress.attempt - 1 + stageShare(progress)) / progress.attempts;
    case 'render':
      // Drawing every page takes far longer than any one attempt at re-saving them.
      return progress.total > 0 ? (0.6 * progress.done) / progress.total : 0;
    case 'images':
      return (
        0.6 +
        (0.4 * (progress.attempt - 1 + (progress.total > 0 ? progress.done / progress.total : 0))) /
          progress.attempts
      );
  }
}

function stageShare({ stage, done, total }: CompressProgress): number {
  if (stage === 'reading') return 0;
  if (stage === 'saving') return 0.9;
  return 0.1 + (total > 0 ? (0.8 * done) / total : 0.8);
}

export function describeProgress(progress: TargetProgress): string {
  switch (progress.phase) {
    case 'tidy':
      return 'It already fits. Tidying it up…';
    case 'compress':
      return progress.attempt === 1
        ? 'Seeing how small it can go…'
        : `Trying ${stepLabel(progress.step)}…`;
    case 'render':
      return `Turning page ${Math.min(progress.done + 1, progress.total)} of ${progress.total} into an image…`;
    case 'images':
      return progress.attempt === 1
        ? 'Seeing how small the pages can go…'
        : `Trying ${progress.step.dpi} DPI at ${progress.step.quality}% quality…`;
  }
}

function stepLabel(step: CompressStep): string {
  if (step.quality === null) return 'a tidy-up on its own';
  return step.maxEdge >= FULL_SIZE
    ? `${step.quality}% quality`
    : `${step.quality}% quality at ${pixels(step.maxEdge)}`;
}

export type Shortfall = 'no-images' | 'text' | 'other-images' | 'photos';

/** Why even the strongest setting left the file over the limit. */
export function explainShortfall(report: CompressReport, limit: number): Shortfall {
  if (report.imagesFound === 0) return 'no-images';
  const rest = report.rebuiltSize - report.jpegBytes;
  if (rest <= limit) return 'photos';
  return report.otherImageBytes * 2 > rest ? 'other-images' : 'text';
}

function shortfallText(report: CompressReport, step: CompressStep, target: SizeTarget): string {
  const limit = formatTarget(target);
  switch (explainShortfall(report, targetBytes(target))) {
    case 'no-images':
      return 'There are no photos or scans in it to shrink: it’s text, fonts and drawings, which are already stored compactly.';
    case 'other-images':
      return 'Most of it is images this tool can’t shrink safely, such as lossless pictures (screenshots and some scans), print colours (CMYK), masks or JPEG 2000, so they were left as they were.';
    case 'text':
      return `Even with every image squeezed right down, the rest of the file (text, fonts and drawings) comes to more than ${limit} on its own.`;
    case 'photos': {
      const images =
        report.jpegImages === 1 ? 'its one image takes' : `its ${report.jpegImages} images take`;
      const setting =
        step.quality === null ? 'full quality' : `${step.quality}% quality and ${pixels(step.maxEdge)}`;
      return `Even at ${setting}, ${images} up too much room for ${limit}.`;
    }
  }
}

function describeChanges(step: CompressStep, report: CompressReport): string {
  if (step.quality === null || report.imagesRewritten === 0) {
    return 'Images left exactly as they were: tidying up the file’s structure was enough.';
  }
  const saved = `${plural(report.imagesRewritten, 'image')} re-saved at ${step.quality}% quality`;
  const resized = report.imagesResized;
  const changed =
    resized === 0
      ? `${saved}, at full size.`
      : resized === report.imagesRewritten
        ? `${saved} and reduced to ${pixels(step.maxEdge)}.`
        : `${saved}; the ${resized === 1 ? 'largest' : `${resized} largest`} reduced to ${pixels(step.maxEdge)}.`;
  return `${changed} That’s the gentlest setting it found that fits.`;
}

export interface TargetSummary {
  tone: 'good' | 'flat';
  headline: string;
  detail: string;
  aside: string | null;
}

export function summariseTarget(result: TargetResult): TargetSummary {
  const limit = formatTarget(result.target);
  const { unit } = result.target;
  const size = result.bytes.byteLength;

  if (result.kind === 'already') {
    return {
      tone: 'good',
      headline: `Already under your ${limit} limit`,
      detail: result.untouched
        ? `At ${formatBytes(size)} it fits as it is, so nothing needed squeezing. The download is your original file, untouched.`
        : 'It fitted already, and tidying up the file’s structure made it smaller still, without touching any images or text.',
      aside: null,
    };
  }

  if (result.kind === 'fits') {
    return {
      tone: 'good',
      headline: `Under your ${limit} limit`,
      detail:
        result.method === 'images'
          ? `Each page was turned into an image at ${result.step.dpi} DPI and ${result.step.quality}% quality, so its text can’t be selected or searched any more.`
          : describeChanges(result.step, result.report),
      aside: closeCall(result.originalSize, result.target)
        ? `It showed as ${formatBytes(result.originalSize)} before, but at ${bytesText(result.originalSize)} it was over ${limit} for sites that count ${STRICT_WORDS[unit]}, so it was trimmed to be safe.`
        : null,
    };
  }

  const reason =
    result.method === 'images'
      ? `Even as images at ${result.step.dpi} DPI and ${result.step.quality}% quality, ${result.pageCount === 1 ? 'the page needs' : `its ${result.pageCount} pages need`} more room than that, and any smaller would be hard to read.`
      : shortfallText(result.report, result.step, result.target);

  if (closeCall(size, result.target)) {
    return {
      tone: 'flat',
      headline: `Couldn’t get it safely under ${limit}`,
      detail: `The smallest it would go is ${formatBytes(size)}, which is ${bytesText(size)}. A site that counts ${LOOSE_WORDS[unit]} will take it, but one that counts 1,000 will see ${strictSize(size, unit)} and turn it away.`,
      aside: reason,
    };
  }

  const smallest = looksOver(size, result.target)
    ? formatBytes(size)
    : `${formatBytes(size)} (${bytesText(size)})`;
  return {
    tone: 'flat',
    headline: `Couldn’t get it under ${limit}`,
    detail: `The smallest it would go is ${smallest}. ${reason}`,
    aside: null,
  };
}
