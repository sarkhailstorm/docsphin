import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { CircleCheckBig, Download, Hash, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { Dropzone } from '@/components/ui/Dropzone';
import { useToast } from '@/components/ToastProvider';
import { cn } from '@/lib/cn';
import { downloadBlob } from '@/lib/download';
import { baseName, formatBytes, plural } from '@/lib/format';
import { describePdfError, looksLikePdf } from '@/lib/pdf-tools/errors';
import { downloadName, readPdf, tick, type LoadedPdf } from '@/lib/pdf-tools/pdf';
import { formatPageRanges } from '@/lib/pdf-tools/ranges';
import {
  DEFAULT_PAGE_NUMBERS,
  formatPageNumber,
  pageNumberPlan,
  stampPdf,
  type NumberFormat,
  type NumberPosition,
  type NumberSize,
} from '@/lib/pdf-tools/stamp';
import { ALL_PAGES, PageRangeField, resolvePageRange, type PageRange } from './PageRangeField';
import { Choice, ErrorNote, FileLine, Note, Progress, SelectField, Stat } from './shared';
import { StampPreview } from './StampPreview';

const POSITIONS: readonly { value: NumberPosition; label: string }[] = [
  { value: 'top-left', label: 'Top left' },
  { value: 'top-centre', label: 'Top centre' },
  { value: 'top-right', label: 'Top right' },
  { value: 'bottom-left', label: 'Bottom left' },
  { value: 'bottom-centre', label: 'Bottom centre' },
  { value: 'bottom-right', label: 'Bottom right' },
];

const FORMATS: readonly NumberFormat[] = ['n', 'page-n', 'page-n-of-total', 'n-of-total'];

const SIZE_OPTIONS: readonly { value: NumberSize; label: string }[] = [
  { value: 'small', label: 'Small' },
  { value: 'medium', label: 'Medium' },
  { value: 'large', label: 'Large' },
];

const SKIP_COVER: PageRange = { scope: 'some', text: '2-' };

function toggleCover(range: PageRange, pageCount: number, skip: boolean): PageRange {
  const chosen = resolvePageRange(range, pageCount);
  const rest = chosen.ok ? chosen.pages.filter((page) => page !== 1) : [];
  if (skip) {
    return range.scope === 'some' && rest.length > 0
      ? { scope: 'some', text: formatPageRanges(rest) }
      : SKIP_COVER;
  }
  return rest.length + 1 === pageCount
    ? ALL_PAGES
    : { scope: 'some', text: formatPageRanges([1, ...rest]) };
}

function readStart(text: string): number | null {
  const trimmed = text.trim();
  return /^\d{1,5}$/.test(trimmed) ? Number(trimmed) : null;
}

interface Result {
  bytes: Uint8Array;
  name: string;
  count: number;
  skipped: number;
  first: { page: number; number: number; label: string };
  last: { page: number; number: number; label: string };
}

export function PageNumbersPanel() {
  const toast = useToast();
  const startId = useId();

  const [file, setFile] = useState<LoadedPdf | null>(null);
  const [reading, setReading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [position, setPosition] = useState<NumberPosition>(DEFAULT_PAGE_NUMBERS.position);
  const [format, setFormat] = useState<NumberFormat>(DEFAULT_PAGE_NUMBERS.format);
  const [size, setSize] = useState<NumberSize>(DEFAULT_PAGE_NUMBERS.size);
  const [range, setRange] = useState<PageRange>(ALL_PAGES);
  const [startText, setStartText] = useState(String(DEFAULT_PAGE_NUMBERS.start));

  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [result, setResult] = useState<Result | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const downloadButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (result) downloadButton.current?.focus();
  }, [result]);

  const start = readStart(startText);
  const chosen = useMemo(
    () => (file ? resolvePageRange(range, file.pageCount) : null),
    [file, range],
  );
  const pages = useMemo(() => (chosen?.ok ? chosen.pages : []), [chosen]);
  const plan = useMemo(
    () =>
      start === null || pages.length === 0
        ? null
        : pageNumberPlan(pages, { position, format, size, start }),
    [pages, start, position, format, size],
  );

  const firstPage = pages.length > 0 ? pages[0] : null;
  const previewStamp = plan && firstPage !== null ? (plan.get(firstPage) ?? null) : null;
  const skipsCover = pages.length > 0 && !pages.includes(1);

  const exampleStart = start ?? 1;
  const exampleCount = pages.length > 0 ? pages.length : (file?.pageCount ?? 1);
  const formatOptions = FORMATS.map((value) => ({
    value,
    label: formatPageNumber(value, exampleStart, exampleStart + exampleCount - 1),
  }));

  const touched = useCallback(() => {
    setResult(null);
    setActionError(null);
  }, []);

  const pick = useCallback(async (files: File[]) => {
    const candidate = files[0];
    if (!candidate) return;
    setLoadError(null);
    setActionError(null);
    setResult(null);

    if (!looksLikePdf(candidate)) {
      setLoadError(`“${candidate.name}” isn’t a PDF. Pick a .pdf file to number.`);
      return;
    }

    setReading(true);
    try {
      await tick();
      setFile(await readPdf(candidate));
      setRange(ALL_PAGES);
    } catch (err) {
      setLoadError(describePdfError(err, candidate.name));
      setFile(null);
    } finally {
      setReading(false);
    }
  }, []);

  async function run() {
    if (!file || !plan || start === null || busy) return;
    setBusy(true);
    setResult(null);
    setActionError(null);
    setProgress({ done: 0, total: 0 });

    try {
      await tick();
      const bytes = await stampPdf(file, plan, (done, total) => setProgress({ done, total }));
      const lastNumber = start + pages.length - 1;
      setResult({
        bytes,
        name: downloadName(`${baseName(file.name)} - numbered`, 'pdf', 'numbered.pdf'),
        count: pages.length,
        skipped: file.pageCount - pages.length,
        first: {
          page: pages[0],
          number: start,
          label: formatPageNumber(format, start, lastNumber),
        },
        last: {
          page: pages[pages.length - 1],
          number: lastNumber,
          label: formatPageNumber(format, lastNumber, lastNumber),
        },
      });
    } catch (err) {
      setActionError(describePdfError(err, file.name));
      toast.error('Numbering failed.');
    } finally {
      setBusy(false);
    }
  }

  function save() {
    if (!result) return;
    downloadBlob(new Blob([result.bytes], { type: 'application/pdf' }), result.name);
    toast.celebrate(`Saved ${result.name}`);
  }

  const progressLabel =
    progress.total === 0
      ? 'Opening your PDF…'
      : progress.done < progress.total
        ? `Numbering page ${progress.done + 1} of ${progress.total}…`
        : 'Saving your PDF…';

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader
          title="PDF to number"
          description="One document at a time. The file is opened here in your browser."
          actions={
            file ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setFile(null);
                  setRange(ALL_PAGES);
                  setResult(null);
                  setActionError(null);
                  setLoadError(null);
                }}
              >
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
              hint="Reports, handouts, anything you print or hand in"
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
          Add a PDF and number its pages in whichever corner you like. Leave the cover out, or
          start counting from any number.
        </Note>
      ) : (
        <Card>
          <CardHeader
            title="Where the numbers go"
            description="The preview shows the first numbered page as it will be saved."
          />

          <div className="grid gap-6 p-5 lg:grid-cols-[minmax(0,1fr)_16.5rem]">
            <fieldset disabled={busy} className="min-w-0">
              <legend className="sr-only">Page number settings</legend>
              <div className="flex flex-col gap-5">
                <div className="flex flex-wrap items-start gap-x-8 gap-y-5">
                  <PositionPicker
                    value={position}
                    disabled={busy}
                    onChange={(value) => {
                      setPosition(value);
                      touched();
                    }}
                  />

                  <div className="grid min-w-[14rem] flex-1 gap-3 sm:grid-cols-2">
                    <div className="sm:col-span-2">
                      <SelectField
                        label="Format"
                        value={format}
                        options={formatOptions}
                        disabled={busy}
                        onChange={(value) => {
                          setFormat(value);
                          touched();
                        }}
                      />
                    </div>
                    <SelectField
                      label="Text size"
                      value={size}
                      options={SIZE_OPTIONS}
                      disabled={busy}
                      onChange={(value) => {
                        setSize(value);
                        touched();
                      }}
                    />
                    <div className="min-w-0">
                      <label htmlFor={startId} className="block text-[13px] font-medium text-ink">
                        Start counting at
                      </label>
                      <input
                        id={startId}
                        type="text"
                        inputMode="numeric"
                        autoComplete="off"
                        maxLength={5}
                        value={startText}
                        onChange={(e) => {
                          setStartText(e.target.value);
                          touched();
                        }}
                        aria-invalid={start === null ? true : undefined}
                        aria-describedby={`${startId}-help`}
                        className={cn(
                          'mt-1.5 h-9 w-full rounded-lg border bg-bg px-2.5 font-mono text-[13px] text-ink outline-none transition-colors focus:border-accent/60 disabled:opacity-50',
                          start === null ? 'border-danger' : 'border-line',
                        )}
                      />
                      {start === null ? (
                        <p id={`${startId}-help`} role="alert" className="mt-1 text-[12px] text-danger">
                          Type a whole number, like 1.
                        </p>
                      ) : (
                        <p id={`${startId}-help`} className="mt-1 text-[12px] text-faint">
                          Given to the first numbered page
                        </p>
                      )}
                    </div>
                  </div>
                </div>

                <div className="border-t border-line pt-4">
                  <PageRangeField
                    label="Pages to number"
                    value={range}
                    pageCount={file.pageCount}
                    disabled={busy}
                    onChange={(value) => {
                      setRange(value);
                      touched();
                    }}
                  />
                  {file.pageCount > 1 ? (
                    <div className="mt-2">
                      <Choice
                        label="Leave the first page unnumbered"
                        hint="Usually a cover or title page."
                        checked={skipsCover}
                        disabled={busy}
                        onChange={(checked) => {
                          setRange(toggleCover(range, file.pageCount, checked));
                          touched();
                        }}
                      />
                    </div>
                  ) : null}
                </div>
              </div>
            </fieldset>

            <StampPreview
              source={file}
              page={firstPage}
              stamp={previewStamp}
              idle={
                start === null
                  ? 'Fix the starting number to see a preview.'
                  : 'Choose the pages to number to see a preview.'
              }
              caption={
                previewStamp && previewStamp.kind === 'number' && firstPage !== null
                  ? `Page ${firstPage}, numbered “${previewStamp.text}”`
                  : null
              }
            />
          </div>

          <div className="flex flex-col gap-3 border-t border-line px-5 py-4">
            {busy ? (
              <Progress
                label={progressLabel}
                done={progress.done}
                total={progress.done < progress.total ? progress.total : 0}
              />
            ) : null}

            {actionError ? <ErrorNote message={actionError} /> : null}

            <div className="flex flex-wrap items-center gap-3">
              <Button variant="primary" disabled={busy || !plan} onClick={() => void run()}>
                <Hash className="h-4 w-4" aria-hidden />
                {busy
                  ? 'Numbering…'
                  : pages.length > 0
                    ? `Number ${plural(pages.length, 'page')}`
                    : 'Add page numbers'}
              </Button>
              {range.scope === 'some' && range.text.trim() === '' ? (
                <p className="text-[13px] text-faint">Type the pages to number first.</p>
              ) : null}
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
                <p className="text-sm font-medium text-ink">Numbered {plural(result.count, 'page')}.</p>
                <p className="mt-1 text-[13px] leading-relaxed text-muted">
                  {result.count === 1
                    ? `Page ${result.first.page} now reads “${result.first.label}”.`
                    : `From “${result.first.label}” on page ${result.first.page} to “${result.last.label}” on page ${result.last.page}.`}
                </p>
              </div>
            </div>

            <dl className="grid grid-cols-2 gap-4 border-t border-line pt-4 sm:grid-cols-4">
              <Stat label="Numbered" value={plural(result.count, 'page')} />
              <Stat label="Left alone" value={plural(result.skipped, 'page')} />
              <Stat
                label="Numbers"
                value={
                  result.count === 1
                    ? result.first.number
                    : `${result.first.number}–${result.last.number}`
                }
              />
              <Stat label="File size" value={formatBytes(result.bytes.byteLength)} />
            </dl>

            <div>
              <Button ref={downloadButton} variant="primary" onClick={save}>
                <Download className="h-4 w-4" aria-hidden />
                Download numbered PDF
              </Button>
            </div>
          </div>
        </Card>
      ) : null}
    </div>
  );
}

function PositionPicker({
  value,
  onChange,
  disabled = false,
}: {
  value: NumberPosition;
  onChange: (value: NumberPosition) => void;
  disabled?: boolean;
}) {
  const name = useId();
  const current = POSITIONS.find((spot) => spot.value === value);

  return (
    <fieldset disabled={disabled} className="shrink-0">
      <legend className="text-[13px] font-medium text-ink">Position</legend>
      <div className="mt-1.5 flex items-center gap-3">
        <div className="relative grid h-[7.5rem] w-[5.75rem] grid-cols-3 content-between rounded-lg border border-line bg-bg p-1">
          <span
            aria-hidden
            className="pointer-events-none absolute inset-x-4 top-1/2 flex -translate-y-1/2 flex-col gap-1.5"
          >
            <span className="h-1 rounded-full bg-line" />
            <span className="h-1 rounded-full bg-line" />
            <span className="h-1 w-2/3 rounded-full bg-line" />
          </span>
          {POSITIONS.map((spot) => {
            const active = spot.value === value;
            const side = spot.value.split('-')[1];
            return (
              <label
                key={spot.value}
                title={spot.label}
                className={cn(
                  'flex h-7 cursor-pointer items-center rounded-md px-1 transition-colors focus-within:ring-2 focus-within:ring-accent',
                  side === 'left' ? 'justify-start' : side === 'right' ? 'justify-end' : 'justify-center',
                  !active && 'hover:bg-line/50',
                  disabled && 'cursor-not-allowed opacity-60',
                )}
              >
                <input
                  type="radio"
                  name={name}
                  value={spot.value}
                  checked={active}
                  onChange={() => onChange(spot.value)}
                  className="sr-only"
                />
                <span
                  aria-hidden
                  className={cn(
                    'h-1.5 w-3.5 rounded-full transition-colors',
                    active ? 'bg-accent' : 'bg-faint/40',
                  )}
                />
                <span className="sr-only">{spot.label}</span>
              </label>
            );
          })}
        </div>
        <p className="text-[13px] text-muted" aria-hidden>
          {current?.label}
        </p>
      </div>
    </fieldset>
  );
}
