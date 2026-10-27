import { useCallback, useEffect, useRef, useState } from 'react';
import type { PDFWorker } from 'pdfjs-dist';
import { FileWarning, Loader2 } from 'lucide-react';
import { extractPages, type LoadedPdf } from '@/lib/pdf-tools/pdf';
import { stampOnePage, type Stamp } from '@/lib/pdf-tools/stamp';

/** The page is drawn to fit this box, in CSS pixels. */
const BOX_WIDTH = 240;
const BOX_HEIGHT = 300;
/** Long enough to skip the in-between values while a slider is dragged. */
const SETTLE_MS = 200;

interface Picture {
  url: string;
  width: number;
  height: number;
}

/** The latest finished drawing; a null picture means it failed. */
interface Shown {
  key: string;
  picture: Picture | null;
}

interface Job {
  key: string;
  source: LoadedPdf;
  page: number;
  stamp: Stamp;
  generation: number;
}

/** One page with the stamp drawn by the same code that saves the file, so what you see is what you get. */
export function StampPreview({
  source,
  page,
  stamp,
  caption,
  idle,
}: {
  source: LoadedPdf;
  /** 1-based page to show, or null when no page is chosen yet. */
  page: number | null;
  /** What goes on it, or null while the options can’t be used. */
  stamp: Stamp | null;
  caption?: React.ReactNode;
  /** Shown instead of the page when there is nothing to draw. */
  idle: string;
}) {
  const [shown, setShown] = useState<Shown | null>(null);
  const generation = useRef(0);
  const next = useRef<Job | null>(null);
  const draining = useRef(false);
  const drawnKey = useRef<string | null>(null);
  const pageCache = useRef<{ key: string; bytes: Uint8Array } | null>(null);
  const worker = useRef<PDFWorker | null>(null);
  const liveUrl = useRef<string | null>(null);

  const wanted = page !== null && stamp !== null ? JSON.stringify([source.id, page, stamp]) : null;

  // One drawing at a time, always of the newest request, so a large PDF is never opened twice at once.
  const drain = useCallback(async () => {
    if (draining.current) return;
    draining.current = true;
    try {
      for (let job = next.current; job !== null; job = next.current) {
        next.current = null;
        let picture: Picture | null = null;
        try {
          const pageKey = `${job.source.id}:${job.page}`;
          let cached = pageCache.current;
          if (cached?.key !== pageKey) {
            cached = { key: pageKey, bytes: await extractPages(job.source, [job.page]) };
            pageCache.current = cached;
          }
          const stamped = await stampOnePage(cached.bytes, job.stamp);
          const pdfjs = await import('pdfjs-dist');
          if (job.generation !== generation.current) continue;
          pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
          worker.current ??= new pdfjs.PDFWorker();
          picture = await drawFirstPage(pdfjs, stamped, worker.current);
        } catch {
          picture = null;
        }

        if (job.generation !== generation.current) {
          if (picture) URL.revokeObjectURL(picture.url);
          continue;
        }
        if (liveUrl.current) URL.revokeObjectURL(liveUrl.current);
        liveUrl.current = picture?.url ?? null;
        drawnKey.current = job.key;
        setShown({ key: job.key, picture });
      }
    } finally {
      draining.current = false;
    }
  }, []);

  useEffect(() => {
    generation.current += 1;
    if (page === null || stamp === null) return;
    const key = JSON.stringify([source.id, page, stamp]);
    if (key === drawnKey.current) return;

    const job: Job = { key, source, page, stamp, generation: generation.current };
    const timer = window.setTimeout(() => {
      next.current = job;
      void drain();
    }, SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [source, page, stamp, drain]);

  useEffect(() => {
    return () => {
      generation.current += 1;
      next.current = null;
      if (liveUrl.current) URL.revokeObjectURL(liveUrl.current);
      liveUrl.current = null;
      worker.current?.destroy();
      worker.current = null;
    };
  }, []);

  const settled = shown !== null && shown.key === wanted;
  const picture = shown?.picture ?? null;

  return (
    <figure className="flex w-full min-w-0 flex-col items-center gap-2">
      <div className="relative flex min-h-[12.5rem] w-full items-center justify-center rounded-xl border border-line bg-bg p-3">
        {wanted === null ? (
          <p className="px-2 text-center text-[13px] leading-relaxed text-faint">{idle}</p>
        ) : settled && !picture ? (
          <div className="flex flex-col items-center gap-2 px-2 text-center">
            <FileWarning className="h-4 w-4 text-faint" aria-hidden />
            <p className="text-[13px] leading-relaxed text-faint">
              The preview couldn’t be drawn. Saving should still work.
            </p>
          </div>
        ) : picture ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={picture.url}
            width={picture.width}
            height={picture.height}
            alt="Preview of the page with the stamp added"
            className="h-auto max-w-full rounded-sm shadow-card"
          />
        ) : (
          <span
            className="block aspect-[1/1.414] w-[10.5rem] animate-pulse rounded-sm bg-line/60"
            aria-hidden
          />
        )}

        {wanted !== null && !settled ? (
          <Loader2
            className="absolute right-2 top-2 h-3.5 w-3.5 animate-spin text-faint"
            aria-hidden
          />
        ) : null}
      </div>

      {caption && wanted !== null ? (
        <figcaption className="text-center text-[12px] leading-snug text-muted">{caption}</figcaption>
      ) : null}
    </figure>
  );
}

async function drawFirstPage(
  pdfjs: typeof import('pdfjs-dist'),
  bytes: Uint8Array,
  worker: PDFWorker,
): Promise<Picture> {
  const task = pdfjs.getDocument({ data: bytes, worker });
  try {
    const doc = await task.promise;
    const page = await doc.getPage(1);
    const natural = page.getViewport({ scale: 1 });
    const fit = Math.min(BOX_WIDTH / natural.width, BOX_HEIGHT / natural.height);
    const density = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    const viewport = page.getViewport({ scale: fit * density });

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    try {
      const context = canvas.getContext('2d');
      if (!context) throw new Error('This browser would not provide a 2D canvas.');
      await page.render({ canvasContext: context, viewport }).promise;
      const blob = await new Promise<Blob | null>((resolve) => {
        canvas.toBlob(resolve, 'image/png');
      });
      if (!blob) throw new Error('The preview could not be encoded.');
      return {
        url: URL.createObjectURL(blob),
        width: Math.round(natural.width * fit),
        height: Math.round(natural.height * fit),
      };
    } finally {
      page.cleanup();
      canvas.width = 0;
      canvas.height = 0;
    }
  } finally {
    void task.destroy().catch(() => undefined);
  }
}
