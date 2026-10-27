import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { CircleCheckBig, Download, RotateCcw, Stamp as StampIcon } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { Dropzone } from '@/components/ui/Dropzone';
import { Slider } from '@/components/ui/Slider';
import { useToast } from '@/components/ToastProvider';
import { cn } from '@/lib/cn';
import { downloadBlob } from '@/lib/download';
import { baseName, formatBytes, plural } from '@/lib/format';
import { describePdfError, looksLikePdf } from '@/lib/pdf-tools/errors';
import { downloadName, readPdf, tick, type LoadedPdf } from '@/lib/pdf-tools/pdf';
import {
  cleanWatermarkText,
  DEFAULT_WATERMARK,
  stampPdf,
  WATERMARK_MAX_LENGTH,
  watermarkPlan,
  watermarkProblem,
  type Stamp,
  type WatermarkAngle,
  type WatermarkColour,
  type WatermarkSize,
} from '@/lib/pdf-tools/stamp';
import { ALL_PAGES, PageRangeField, resolvePageRange, type PageRange } from './PageRangeField';
import { ErrorNote, FileLine, Note, Progress, SelectField, Stat } from './shared';
import { StampPreview } from './StampPreview';

const ANGLE_OPTIONS: readonly { value: WatermarkAngle; label: string }[] = [
  { value: 'diagonal', label: 'Diagonal' },
  { value: 'horizontal', label: 'Horizontal' },
];

const COLOUR_OPTIONS: readonly { value: WatermarkColour; label: string }[] = [
  { value: 'grey', label: 'Grey' },
  { value: 'red', label: 'Red' },
  { value: 'blue', label: 'Blue' },
  { value: 'black', label: 'Black' },
];

const SIZE_OPTIONS: readonly { value: WatermarkSize; label: string }[] = [
  { value: 'fit', label: 'Fit across the page' },
  { value: 'small', label: 'Small' },
  { value: 'medium', label: 'Medium' },
  { value: 'large', label: 'Large' },
];

interface Result {
  bytes: Uint8Array;
  name: string;
  text: string;
  count: number;
  skipped: number;
}

export function WatermarkPanel() {
  const toast = useToast();
  const textId = useId();

  const [file, setFile] = useState<LoadedPdf | null>(null);
  const [reading, setReading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [text, setText] = useState(DEFAULT_WATERMARK.text);
  const [angle, setAngle] = useState<WatermarkAngle>(DEFAULT_WATERMARK.angle);
  const [opacity, setOpacity] = useState(Math.round(DEFAULT_WATERMARK.opacity * 100));
  const [colour, setColour] = useState<WatermarkColour>(DEFAULT_WATERMARK.colour);
  const [size, setSize] = useState<WatermarkSize>(DEFAULT_WATERMARK.size);
  const [range, setRange] = useState<PageRange>(ALL_PAGES);

  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [result, setResult] = useState<Result | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const downloadButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (result) downloadButton.current?.focus();
  }, [result]);

  const problem = watermarkProblem(text);
  const chosen = useMemo(
    () => (file ? resolvePageRange(range, file.pageCount) : null),
    [file, range],
  );
  const pages = useMemo(() => (chosen?.ok ? chosen.pages : []), [chosen]);
  const stamp = useMemo<Stamp | null>(
    () =>
      problem
        ? null
        : { kind: 'watermark', text, angle, opacity: opacity / 100, colour, size },
    [problem, text, angle, opacity, colour, size],
  );
  const firstPage = pages.length > 0 ? pages[0] : null;

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
      setLoadError(`“${candidate.name}” isn’t a PDF. Pick a .pdf file to watermark.`);
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
    if (!file || !stamp || pages.length === 0 || busy) return;
    setBusy(true);
    setResult(null);
    setActionError(null);
    setProgress({ done: 0, total: 0 });

    try {
      await tick();
      const plan = watermarkPlan(pages, { text, angle, opacity: opacity / 100, colour, size });
      const bytes = await stampPdf(file, plan, (done, total) => setProgress({ done, total }));
      setResult({
        bytes,
        name: downloadName(`${baseName(file.name)} - watermarked`, 'pdf', 'watermarked.pdf'),
        text: cleanWatermarkText(text),
        count: pages.length,
        skipped: file.pageCount - pages.length,
      });
    } catch (err) {
      setActionError(describePdfError(err, file.name));
      toast.error('The watermark could not be added.');
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
        ? `Watermarking page ${progress.done + 1} of ${progress.total}…`
        : 'Saving your PDF…';

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader
          title="PDF to watermark"
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
              hint="Mark a copy as a draft, a sample or confidential"
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
          Add a PDF and stamp words such as DRAFT or CONFIDENTIAL across its pages, faint enough
          to read through.
        </Note>
      ) : (
        <Card>
          <CardHeader
            title="Your watermark"
            description="The preview shows the first page it goes on, as it will be saved."
          />

          <div className="grid gap-6 p-5 lg:grid-cols-[minmax(0,1fr)_16.5rem]">
            <fieldset disabled={busy} className="min-w-0">
              <legend className="sr-only">Watermark settings</legend>
              <div className="flex flex-col gap-5">
                <div>
                  <div className="flex items-baseline justify-between gap-2">
                    <label htmlFor={textId} className="text-[13px] font-medium text-ink">
                      Text
                    </label>
                    <span className="font-mono text-[12px] tabular-nums text-faint">
                      {[...text].length}/{WATERMARK_MAX_LENGTH}
                    </span>
                  </div>
                  <input
                    id={textId}
                    type="text"
                    autoComplete="off"
                    maxLength={WATERMARK_MAX_LENGTH}
                    value={text}
                    placeholder="e.g. DRAFT"
                    onChange={(e) => {
                      setText(e.target.value);
                      touched();
                    }}
                    aria-invalid={problem ? true : undefined}
                    aria-describedby={problem ? `${textId}-error` : undefined}
                    className={cn(
                      'mt-1.5 h-10 w-full rounded-xl border bg-surface px-3 text-sm text-ink',
                      'placeholder:text-faint disabled:opacity-60',
                      problem ? 'border-danger' : 'border-line',
                    )}
                  />
                  {problem ? (
                    <p id={`${textId}-error`} role="alert" className="mt-1.5 text-[13px] text-danger">
                      {problem}
                    </p>
                  ) : null}
                </div>

                <div className="grid gap-3 sm:grid-cols-3">
                  <SelectField
                    label="Angle"
                    value={angle}
                    options={ANGLE_OPTIONS}
                    disabled={busy}
                    onChange={(value) => {
                      setAngle(value);
                      touched();
                    }}
                  />
                  <SelectField
                    label="Colour"
                    value={colour}
                    options={COLOUR_OPTIONS}
                    disabled={busy}
                    onChange={(value) => {
                      setColour(value);
                      touched();
                    }}
                  />
                  <SelectField
                    label="Size"
                    value={size}
                    options={SIZE_OPTIONS}
                    disabled={busy}
                    hint={size === 'fit' ? undefined : 'Shrinks if the words won’t fit'}
                    onChange={(value) => {
                      setSize(value);
                      touched();
                    }}
                  />
                </div>

                <Slider
                  label="Opacity"
                  value={opacity}
                  min={5}
                  max={100}
                  step={5}
                  suffix="%"
                  disabled={busy}
                  hint="Lower lets more of the page show through."
                  onChange={(value) => {
                    setOpacity(value);
                    touched();
                  }}
                />

                <div className="border-t border-line pt-4">
                  <PageRangeField
                    label="Pages to watermark"
                    value={range}
                    pageCount={file.pageCount}
                    disabled={busy}
                    onChange={(value) => {
                      setRange(value);
                      touched();
                    }}
                  />
                </div>
              </div>
            </fieldset>

            <StampPreview
              source={file}
              page={firstPage}
              stamp={stamp}
              idle={
                problem
                  ? 'Fix the text to see a preview.'
                  : 'Choose the pages to watermark to see a preview.'
              }
              caption={firstPage !== null ? `Page ${firstPage}, as it will look` : null}
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
              <Button
                variant="primary"
                disabled={busy || !stamp || pages.length === 0}
                onClick={() => void run()}
              >
                <StampIcon className="h-4 w-4" aria-hidden />
                {busy
                  ? 'Watermarking…'
                  : pages.length > 0
                    ? `Watermark ${plural(pages.length, 'page')}`
                    : 'Add the watermark'}
              </Button>
              {range.scope === 'some' && range.text.trim() === '' ? (
                <p className="text-[13px] text-faint">Type the pages to watermark first.</p>
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
                <p className="text-sm font-medium text-ink">
                  Watermarked {plural(result.count, 'page')}.
                </p>
                <p className="mt-1 break-words text-[13px] leading-relaxed text-muted">
                  “{result.text}” now sits across{' '}
                  {result.skipped === 0
                    ? result.count === 1
                      ? 'the page'
                      : 'every page'
                    : `${plural(result.count, 'page')} of ${result.count + result.skipped}`}
                  .
                </p>
              </div>
            </div>

            <dl className="grid grid-cols-2 gap-4 border-t border-line pt-4 sm:grid-cols-3">
              <Stat label="Watermarked" value={plural(result.count, 'page')} />
              <Stat label="Left alone" value={plural(result.skipped, 'page')} />
              <Stat label="File size" value={formatBytes(result.bytes.byteLength)} />
            </dl>

            <div>
              <Button ref={downloadButton} variant="primary" onClick={save}>
                <Download className="h-4 w-4" aria-hidden />
                Download watermarked PDF
              </Button>
            </div>
          </div>
        </Card>
      ) : null}
    </div>
  );
}
