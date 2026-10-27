import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CircleCheckBig, Download, FileImage, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { Dropzone } from '@/components/ui/Dropzone';
import { useToast } from '@/components/ToastProvider';
import { cn } from '@/lib/cn';
import { downloadBlob } from '@/lib/download';
import { baseName, formatBytes, plural } from '@/lib/format';
import { describePdfError, looksLikePdf } from '@/lib/pdf-tools/errors';
import { downloadName, readPdf, tick, zipFiles, type LoadedPdf } from '@/lib/pdf-tools/pdf';
import { formatPageRanges } from '@/lib/pdf-tools/ranges';
import {
  DEFAULT_EXPORT_OPTIONS,
  IMAGE_QUALITY_LABELS,
  estimateExport,
  imageExtension,
  pagesToImages,
  readPageSizes,
  type ImageExportOptions,
  type ImageFormat,
  type ImageQualityId,
  type PageSize,
} from '@/lib/pdf-tools/rasterize';
import { ALL_PAGES, PageRangeField, resolvePageRange, type PageRange } from './PageRangeField';
import { ErrorNote, FileLine, Note, Progress, SelectField, Stat } from './shared';

const FORMATS: readonly { id: ImageFormat; title: string; blurb: string }[] = [
  {
    id: 'jpeg',
    title: 'JPG',
    blurb: 'Smaller files that open anywhere. Best for photos and scans.',
  },
  {
    id: 'png',
    title: 'PNG',
    blurb: 'Sharper text and lines, but bigger files.',
  },
];

const QUALITY_OPTIONS = (Object.keys(IMAGE_QUALITY_LABELS) as ImageQualityId[]).map((value) => ({
  value,
  label: IMAGE_QUALITY_LABELS[value],
}));

const QUALITY_HINTS: Record<ImageQualityId, string> = {
  screen: 'Small files — fine on a screen',
  good: 'A good balance for most uses',
  print: 'Large files — best for printing',
};

// Split saves PNG by default, but people come here asking for “PDF to JPG”.
const DEFAULT_OPTIONS: ImageExportOptions = { ...DEFAULT_EXPORT_OPTIONS, format: 'jpeg' };

function formatName(format: ImageFormat): string {
  return imageExtension(format).toUpperCase();
}

function progressLabel(pages: readonly number[], done: number): string {
  const index = Math.min(done, pages.length - 1);
  const page = pages[index];
  // Sorted and unique, so this means pages 1 to n.
  return pages[pages.length - 1] === pages.length
    ? `Turning page ${page} of ${pages.length} into an image…`
    : `Turning page ${page} into an image (${index + 1} of ${pages.length})…`;
}

interface ImagesResult {
  name: string;
  blob: Blob;
  format: ImageFormat;
  pages: number[];
}

export function PdfToImagesPanel() {
  const toast = useToast();

  const [file, setFile] = useState<LoadedPdf | null>(null);
  const [sizes, setSizes] = useState<readonly PageSize[]>([]);
  const [reading, setReading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [range, setRange] = useState<PageRange>(ALL_PAGES);
  const [options, setOptions] = useState<ImageExportOptions>(DEFAULT_OPTIONS);

  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState({ label: '', done: 0, total: 0 });
  const [actionError, setActionError] = useState<string | null>(null);
  const [result, setResult] = useState<ImagesResult | null>(null);
  const downloadButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (result) downloadButton.current?.focus();
  }, [result]);

  const pages = useMemo(() => {
    if (!file) return [];
    const resolved = resolvePageRange(range, file.pageCount);
    return resolved.ok ? resolved.pages : [];
  }, [file, range]);

  const estimate = useMemo(
    () => estimateExport(sizes, pages, options.quality),
    [sizes, pages, options.quality],
  );

  const pick = useCallback(async (files: File[]) => {
    const candidate = files[0];
    if (!candidate) return;
    setLoadError(null);
    setActionError(null);
    setResult(null);

    if (!looksLikePdf(candidate)) {
      setLoadError(`“${candidate.name}” isn’t a PDF. Pick a .pdf file to turn into images.`);
      return;
    }

    setReading(true);
    try {
      await tick();
      const loaded = await readPdf(candidate);
      // Sizes only feed the hints, so never let them stop a conversion.
      const found = await readPageSizes(loaded).catch(() => []);
      setFile(loaded);
      setSizes(found);
      setRange(ALL_PAGES);
    } catch (err) {
      setLoadError(describePdfError(err, candidate.name));
      setFile(null);
    } finally {
      setReading(false);
    }
  }, []);

  function clearResult() {
    setResult(null);
    setActionError(null);
  }

  function startOver() {
    setFile(null);
    setSizes([]);
    setRange(ALL_PAGES);
    setLoadError(null);
    clearResult();
  }

  async function run() {
    if (!file || busy || pages.length === 0) return;
    const chosen = pages;
    const format = options.format;

    setBusy(true);
    clearResult();
    setStatus({ label: 'Getting started…', done: 0, total: chosen.length });

    try {
      await tick();
      const built = await pagesToImages(file, chosen, options, (done, total) => {
        setStatus({ label: progressLabel(chosen, done), done, total });
      });

      if (built.length === 1) {
        const type = format === 'jpeg' ? 'image/jpeg' : 'image/png';
        setResult({
          name: built[0].name,
          blob: new Blob([built[0].bytes], { type }),
          format,
          pages: chosen,
        });
        return;
      }

      setStatus({ label: 'Packing the ZIP…', done: 0, total: 100 });
      const bundle = await zipFiles(built, (done, total) => {
        setStatus({ label: 'Packing the ZIP…', done, total });
      });
      const name = downloadName(
        `${baseName(file.name)} - ${imageExtension(format)} pages`,
        'zip',
        'pages.zip',
      );
      setResult({ name, blob: bundle, format, pages: chosen });
    } catch (err) {
      setActionError(describePdfError(err, file.name));
      toast.error('That conversion did not work.');
    } finally {
      setBusy(false);
    }
  }

  function save() {
    if (!result) return;
    downloadBlob(result.blob, result.name);
    toast.celebrate(`Saved ${result.name}`);
  }

  const label = formatName(options.format);
  const qualityHint = estimate.largest
    ? `${estimate.uniform ? '' : 'Up to '}${estimate.largest.width} × ${estimate.largest.height} pixels a page`
    : QUALITY_HINTS[options.quality];
  const resultLabel = result ? formatName(result.format) : '';

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader
          title="PDF to turn into images"
          description="One PDF at a time. Each page you choose becomes a JPG or PNG."
          actions={
            file ? (
              <Button variant="ghost" size="sm" disabled={busy} onClick={startOver}>
                <RotateCcw className="h-3.5 w-3.5" aria-hidden />
                Start over
              </Button>
            ) : null
          }
        />
        <div className="p-5">
          {file ? (
            <FileLine name={file.name} size={file.size} pageCount={file.pageCount} />
          ) : (
            <Dropzone
              accept=".pdf,application/pdf"
              disabled={reading}
              title="Drop a PDF here"
              hint="Nothing is uploaded — the file is read in this tab"
              onFiles={(files) => {
                void pick(files);
              }}
            />
          )}

          {reading ? (
            <Progress className="mt-4" label="Opening your PDF…" done={0} total={0} />
          ) : null}

          {loadError ? <ErrorNote className="mt-4" message={loadError} /> : null}
        </div>
      </Card>

      {!file ? (
        <Note>
          Add a PDF and each page comes back as a picture you can drop into a slide, a chat or a
          website.
        </Note>
      ) : (
        <Card>
          <CardHeader
            title="Image settings"
            description="Pick the pages, the format and how much detail to keep."
          />

          <div className="flex flex-col gap-5 p-5">
            <PageRangeField
              label="Pages to convert"
              value={range}
              pageCount={file.pageCount}
              disabled={busy}
              onChange={(next) => {
                setRange(next);
                clearResult();
              }}
            />

            <fieldset disabled={busy} className="min-w-0">
              <legend className="text-[13px] font-medium text-ink">Format</legend>
              <div className="mt-1.5 grid gap-2 sm:grid-cols-2">
                {FORMATS.map((option) => {
                  const active = options.format === option.id;
                  return (
                    <label
                      key={option.id}
                      className={cn(
                        'flex cursor-pointer gap-2.5 rounded-xl border p-3 transition-colors',
                        'focus-within:ring-2 focus-within:ring-accent',
                        active
                          ? 'border-accent bg-accent-soft'
                          : 'border-line bg-surface hover:bg-elevated',
                        busy && 'cursor-not-allowed opacity-60',
                      )}
                    >
                      <input
                        type="radio"
                        name="pdf-to-images-format"
                        value={option.id}
                        checked={active}
                        onChange={() => {
                          setOptions((previous) => ({ ...previous, format: option.id }));
                          clearResult();
                        }}
                        className="sr-only"
                      />
                      <span className="min-w-0">
                        <span className="block text-[13px] font-medium text-ink">
                          {option.title}
                        </span>
                        <span className="mt-0.5 block text-[13px] leading-snug text-muted">
                          {option.blurb}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </fieldset>

            <div className="max-w-xs">
              <SelectField
                label="Quality"
                value={options.quality}
                options={QUALITY_OPTIONS}
                disabled={busy}
                hint={qualityHint}
                onChange={(quality) => {
                  setOptions((previous) => ({ ...previous, quality }));
                  clearResult();
                }}
              />
            </div>

            {estimate.heavy ? (
              <Note>
                This is a big job, so it may take a while.
                {options.quality === 'print' ? ' Switching to Good is much quicker.' : ''}
              </Note>
            ) : null}

            <div className="flex flex-col gap-3 border-t border-line pt-4">
              {busy ? (
                <Progress label={status.label} done={status.done} total={status.total} />
              ) : null}

              {actionError ? <ErrorNote message={actionError} /> : null}

              <div className="flex flex-wrap items-center gap-3">
                <Button
                  variant="primary"
                  disabled={busy || pages.length === 0}
                  onClick={() => void run()}
                >
                  <FileImage className="h-4 w-4" aria-hidden />
                  {busy
                    ? 'Converting…'
                    : pages.length > 0
                      ? `Convert ${plural(pages.length, 'page')} to ${label}`
                      : `Convert to ${label}`}
                </Button>
                {!busy && pages.length > 1 ? (
                  <p className="text-[13px] text-faint">You’ll get them in one ZIP.</p>
                ) : null}
              </div>
            </div>
          </div>
        </Card>
      )}

      {result ? (
        <Card className="border-ok/30 bg-ok/5">
          <div className="flex flex-col gap-4 p-5">
            <div className="flex items-start gap-2.5">
              <CircleCheckBig className="mt-0.5 h-4 w-4 shrink-0 text-ok" aria-hidden />
              <div className="min-w-0">
                <p className="text-sm font-medium text-ink">
                  {result.pages.length === 1
                    ? `Your ${resultLabel} is ready.`
                    : `Your ${plural(result.pages.length, resultLabel)} are ready, in one ZIP.`}
                </p>
                <p className="mt-0.5 truncate text-[13px] text-muted" title={result.name}>
                  {result.name}
                </p>
              </div>
            </div>

            <dl className="grid grid-cols-2 gap-4 border-t border-line pt-4 sm:grid-cols-3">
              <Stat label="Images" value={result.pages.length} />
              <Stat label="Pages" value={formatPageRanges(result.pages)} />
              <Stat label="Total size" value={formatBytes(result.blob.size)} />
            </dl>

            <div>
              <Button ref={downloadButton} variant="primary" onClick={save}>
                <Download className="h-4 w-4" aria-hidden />
                {result.pages.length === 1 ? `Download ${resultLabel}` : 'Download ZIP'}
              </Button>
            </div>
          </div>
        </Card>
      ) : null}
    </div>
  );
}
