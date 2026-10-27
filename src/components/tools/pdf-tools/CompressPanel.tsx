import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  Download,
  Gauge,
  Images,
  Minimize2,
  RotateCcw,
  SlidersHorizontal,
  Target,
  TriangleAlert,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { Dropzone } from '@/components/ui/Dropzone';
import { Slider } from '@/components/ui/Slider';
import { useToast } from '@/components/ToastProvider';
import { cn } from '@/lib/cn';
import { downloadBlob } from '@/lib/download';
import { baseName, formatBytes, plural } from '@/lib/format';
import {
  QUICK_TARGETS,
  describeProgress,
  fitUnderSize,
  flattenUnderSize,
  formatTarget,
  limitHint,
  parseTarget,
  progressShare,
  summariseTarget,
  type SizeTarget,
  type SizeUnit,
  type TargetProgress,
  type TargetResult,
} from '@/lib/pdf-tools/compress-target';
import { describePdfError, looksLikePdf } from '@/lib/pdf-tools/errors';
import {
  compressPdf,
  downloadName,
  readPdf,
  summariseCompression,
  tick,
  type CompressProgress,
  type CompressReport,
  type LoadedPdf,
} from '@/lib/pdf-tools/pdf';
import { ErrorNote, FileLine, Note, Progress, SizeChange, Stat } from './shared';

const STAGE_LABELS: Record<CompressProgress['stage'], string> = {
  reading: 'Reading the document…',
  images: 'Re-encoding images…',
  saving: 'Rebuilding the file…',
};

type Mode = 'quality' | 'target';

const MODES: readonly { id: Mode; title: string; blurb: string; icon: typeof Gauge }[] = [
  {
    id: 'quality',
    title: 'Choose the quality',
    blurb: 'Set how hard the images are squeezed, then see the size you get.',
    icon: SlidersHorizontal,
  },
  {
    id: 'target',
    title: 'Fit under a size',
    blurb: 'Give a limit, like 200 KB for an upload form, and get the gentlest result that fits.',
    icon: Target,
  },
];

/** An index into QUICK_TARGETS, or a size typed in by hand. */
type LimitChoice = number | 'custom';

const UNITS: readonly SizeUnit[] = ['KB', 'MB'];

export function CompressPanel() {
  const toast = useToast();
  const [file, setFile] = useState<LoadedPdf | null>(null);
  const [reading, setReading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [mode, setMode] = useState<Mode>('quality');
  const [quality, setQuality] = useState(70);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<CompressProgress>({
    stage: 'reading',
    done: 0,
    total: 0,
  });
  const [report, setReport] = useState<CompressReport | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [choice, setChoice] = useState<LimitChoice>(1);
  const [customText, setCustomText] = useState('');
  const [customUnit, setCustomUnit] = useState<SizeUnit>('KB');
  const [limitLeft, setLimitLeft] = useState(false);
  const [targetProgress, setTargetProgress] = useState<TargetProgress | null>(null);
  const [fitted, setFitted] = useState<TargetResult | null>(null);
  const [flattening, setFlattening] = useState(false);
  const [flattenMiss, setFlattenMiss] = useState<number | null>(null);
  const [flattenError, setFlattenError] = useState<string | null>(null);
  const customField = useRef<HTMLInputElement>(null);
  const fittedDownload = useRef<HTMLButtonElement>(null);

  const parsedCustom = choice === 'custom' ? parseTarget(customText, customUnit) : null;
  const target: SizeTarget | null =
    choice === 'custom' ? (parsedCustom?.ok ? parsedCustom.target : null) : QUICK_TARGETS[choice];
  // Quiet while a bare number is still being typed, as its unit may come next.
  const limitError =
    parsedCustom &&
    !parsedCustom.ok &&
    customText.trim() !== '' &&
    (limitLeft || !/^[\d.,\s]+$/.test(customText))
      ? parsedCustom.message
      : null;

  // flattenMiss too, since a flatten that gains nothing leaves the result as it was.
  useEffect(() => {
    if (fitted) fittedDownload.current?.focus();
  }, [fitted, flattenMiss]);

  const clearFitted = useCallback(() => {
    setFitted(null);
    setFlattenMiss(null);
    setFlattenError(null);
  }, []);

  const pick = useCallback(
    async (files: File[]) => {
      const candidate = files[0];
      if (!candidate) return;
      setLoadError(null);
      setActionError(null);
      setReport(null);
      clearFitted();

      if (!looksLikePdf(candidate)) {
        setLoadError(`“${candidate.name}” isn’t a PDF. Pick a .pdf file to compress.`);
        return;
      }

      setReading(true);
      try {
        await tick();
        setFile(await readPdf(candidate));
      } catch (err) {
        setLoadError(describePdfError(err, candidate.name));
        setFile(null);
      } finally {
        setReading(false);
      }
    },
    [clearFitted],
  );

  async function run() {
    if (!file || busy) return;
    setBusy(true);
    setReport(null);
    setActionError(null);
    setProgress({ stage: 'reading', done: 0, total: 0 });

    try {
      await tick();
      const outcome = await compressPdf(file, quality / 100, setProgress);
      setReport(outcome);
    } catch (err) {
      setActionError(describePdfError(err, file.name));
      toast.error('Compression failed.');
    } finally {
      setBusy(false);
    }
  }

  async function fit() {
    if (!file || busy || !target) return;
    setBusy(true);
    clearFitted();
    setActionError(null);
    setTargetProgress(null);

    try {
      await tick();
      setFitted(await fitUnderSize(file, target, setTargetProgress));
    } catch (err) {
      setActionError(describePdfError(err, file.name));
      toast.error('Compression failed.');
    } finally {
      setBusy(false);
    }
  }

  async function flatten() {
    if (!file || busy || !fitted) return;
    const previous = fitted;
    setBusy(true);
    setFlattening(true);
    setFlattenMiss(null);
    setFlattenError(null);
    setTargetProgress(null);

    try {
      await tick();
      const flat = await flattenUnderSize(file, previous.target, setTargetProgress);
      if (flat.bytes.byteLength < previous.bytes.byteLength) setFitted(flat);
      else setFlattenMiss(flat.bytes.byteLength);
    } catch (err) {
      setFlattenError(describePdfError(err, file.name));
      toast.error('Turning the pages into images failed.');
    } finally {
      setBusy(false);
      setFlattening(false);
    }
  }

  function save() {
    if (!report || !file) return;
    const name = report.keptOriginal
      ? downloadName(baseName(file.name), 'pdf', 'document.pdf')
      : downloadName(`${baseName(file.name)} - compressed`, 'pdf', 'compressed.pdf');
    downloadBlob(new Blob([report.bytes], { type: 'application/pdf' }), name);
    toast.celebrate(`Saved ${name}`);
  }

  function saveOutcome() {
    if (!fitted || !file) return;
    const stem = baseName(file.name);
    const name = fitted.untouched
      ? downloadName(stem, 'pdf', 'document.pdf')
      : fitted.kind === 'over'
        ? downloadName(`${stem} - compressed`, 'pdf', 'compressed.pdf')
        : downloadName(`${stem} - under ${formatTarget(fitted.target)}`, 'pdf', 'compressed.pdf');
    downloadBlob(new Blob([fitted.bytes], { type: 'application/pdf' }), name);
    toast.celebrate(`Saved ${name}`);
  }

  function chooseLimit(next: LimitChoice) {
    setChoice(next);
    setLimitLeft(false);
    clearFitted();
    setActionError(null);
    if (next === 'custom') window.setTimeout(() => customField.current?.focus(), 0);
  }

  function typeLimit(text: string) {
    setCustomText(text);
    setLimitLeft(false);
    clearFitted();
    setActionError(null);
    const parsed = parseTarget(text, customUnit);
    if (parsed.ok) setCustomUnit(parsed.target.unit);
  }

  const summary = report ? summariseCompression(report) : null;
  const targetSummary = fitted ? summariseTarget(fitted) : null;

  const progressLabel =
    progress.stage === 'images' && progress.total > 0
      ? `Re-encoding image ${Math.min(progress.done + 1, progress.total)} of ${progress.total}…`
      : STAGE_LABELS[progress.stage];

  const searchProgress = (
    <Progress
      label={targetProgress ? describeProgress(targetProgress) : STAGE_LABELS.reading}
      done={targetProgress ? Math.round(progressShare(targetProgress) * 1000) : 0}
      total={targetProgress ? 1000 : 0}
    />
  );

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader
          title="PDF to compress"
          description="One document at a time. The file is opened here in your browser."
          actions={
            file ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setFile(null);
                  setReport(null);
                  clearFitted();
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
              hint={'Works best on PDFs full of photos or scanned pages'}
              onFiles={(files) => {
                void pick(files);
              }}
            />
          )}

          {reading ? (
            <Progress className="mt-4" label={'Opening your PDF…'} done={0} total={0} />
          ) : null}

          {loadError ? <ErrorNote className="mt-4" message={loadError} /> : null}
        </div>
      </Card>

      <Note>
        <p>
          <strong className="font-medium text-ink">What this can actually do.</strong> It re-encodes
          the JPEG images inside a PDF at a lower quality, scales them down if a size limit needs
          it, and rebuilds the file more compactly. A PDF of scanned or photographic pages can
          shrink a lot. A PDF that is mostly text has almost nothing to squeeze, and will barely
          change &mdash; you will be told plainly which one yours is.
        </p>
      </Note>

      {file ? (
        <Card>
          <CardHeader
            title="How to compress"
            description={
              mode === 'quality'
                ? 'Only the images get smaller. Page text and vector artwork are never touched.'
                : 'Images are squeezed and, if need be, scaled down. Text and vector artwork are left alone unless you choose to turn the pages into images.'
            }
          />
          <div className="flex flex-col gap-5 p-5">
            <fieldset disabled={busy}>
              <legend className="sr-only">How to compress this PDF</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {MODES.map((option) => {
                  const Icon = option.icon;
                  const active = mode === option.id;
                  return (
                    <label
                      key={option.id}
                      className={cn(
                        'flex cursor-pointer gap-3 rounded-xl border p-3 transition-colors',
                        'focus-within:ring-2 focus-within:ring-accent',
                        active
                          ? 'border-accent bg-accent-soft'
                          : 'border-line bg-surface hover:bg-elevated',
                        busy && 'cursor-not-allowed opacity-60',
                      )}
                    >
                      <input
                        type="radio"
                        name="pdf-compress-mode"
                        value={option.id}
                        checked={active}
                        onChange={() => {
                          setMode(option.id);
                          setActionError(null);
                        }}
                        className="sr-only"
                      />
                      <Icon
                        className={cn('mt-0.5 h-4 w-4 shrink-0', active ? 'text-accent' : 'text-muted')}
                        aria-hidden
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

            {mode === 'quality' ? (
              <Slider
                label="JPEG quality"
                value={quality}
                onChange={(value) => {
                  setQuality(value);
                  setReport(null);
                }}
                min={20}
                max={95}
                step={5}
                suffix="%"
                disabled={busy}
                hint={
                  quality >= 85
                    ? 'Near-original quality. Expect a modest saving.'
                    : quality >= 60
                      ? 'A good balance for scanned documents and photos.'
                      : 'Visibly softer images, but the biggest saving.'
                }
              />
            ) : (
              <SizeLimitField
                choice={choice}
                onChoice={chooseLimit}
                customText={customText}
                onCustomText={typeLimit}
                unit={customUnit}
                onUnit={(unit) => {
                  setCustomUnit(unit);
                  // A unit typed in the box outranks the toggle, so picking one drops the typed one.
                  setCustomText((text) => text.replace(/\s*(kib|kb|k|mib|mb|m)\s*$/i, ''));
                  clearFitted();
                }}
                onLeave={() => setLimitLeft(true)}
                error={limitError}
                hint={target ? limitHint(target, file.size) : 'Type a size, then pick KB or MB.'}
                disabled={busy}
                inputRef={customField}
              />
            )}

            {busy && !flattening ? (
              mode === 'quality' ? (
                <Progress
                  label={progressLabel}
                  done={progress.stage === 'images' ? progress.done : 0}
                  total={progress.stage === 'images' ? progress.total : 0}
                />
              ) : (
                searchProgress
              )
            ) : null}

            {actionError ? <ErrorNote message={actionError} /> : null}

            <div className="flex flex-wrap items-center gap-3">
              {mode === 'quality' ? (
                <>
                  <Button variant="primary" disabled={busy} onClick={() => void run()}>
                    <Minimize2 className="h-4 w-4" aria-hidden />
                    {busy ? 'Compressing…' : report ? 'Compress again' : 'Compress PDF'}
                  </Button>
                  {report ? (
                    <p className="text-[13px] text-faint">
                      Move the slider and run it again to compare.
                    </p>
                  ) : null}
                </>
              ) : (
                <Button variant="primary" disabled={busy || !target} onClick={() => void fit()}>
                  <Target className="h-4 w-4" aria-hidden />
                  {busy
                    ? 'Compressing…'
                    : target
                      ? `Fit under ${formatTarget(target)}`
                      : 'Fit under a size'}
                </Button>
              )}
            </div>
          </div>
        </Card>
      ) : null}

      {mode === 'quality' && report && summary ? (
        <Card
          className={cn(
            summary.tone === 'good' ? 'border-ok/30 bg-ok/5' : 'border-line bg-elevated',
          )}
        >
          <div className="flex flex-col gap-4 p-5">
            <div className="flex items-start gap-2.5">
              <Gauge
                className={cn(
                  'mt-0.5 h-4 w-4 shrink-0',
                  summary.tone === 'good' ? 'text-ok' : 'text-muted',
                )}
                aria-hidden
              />
              <div className="min-w-0">
                <p className="text-sm font-medium text-ink">{summary.headline}</p>
                <p className="mt-1 text-[13px] leading-relaxed text-muted">{summary.detail}</p>
              </div>
            </div>

            <SizeChange before={report.originalSize} after={report.bytes.byteLength} />

            <dl className="grid grid-cols-2 gap-4 border-t border-line pt-4 sm:grid-cols-4">
              <Stat label="Pages" value={report.pageCount} />
              <Stat label="Images found" value={report.imagesFound} />
              <Stat
                label="Re-encoded"
                value={
                  report.jpegImages === 0
                    ? 'none'
                    : `${report.imagesRewritten} of ${report.jpegImages} JPEG`
                }
              />
              <Stat
                label="Image data"
                value={
                  report.imagesRewritten > 0
                    ? `${formatBytes(report.imageBytesBefore)} → ${formatBytes(report.imageBytesAfter)}`
                    : 'unchanged'
                }
              />
            </dl>

            {report.imagesFound > report.jpegImages ? (
              <p className="text-[13px] leading-relaxed text-faint">
                {plural(report.imagesFound - report.jpegImages, 'image')} in this file
                {report.imagesFound - report.jpegImages === 1 ? ' is' : ' are'} either stored in a
                way a browser can&rsquo;t safely re-encode &mdash; lossless pictures (screenshots and
                some scans), print colours (CMYK), masks, indexed colour or JPEG 2000 &mdash; or
                too small to be worth it,
                so {report.imagesFound - report.jpegImages === 1 ? 'it was' : 'they were'} left
                exactly as {report.imagesFound - report.jpegImages === 1 ? 'it was' : 'they were'}.
              </p>
            ) : null}

            <div>
              <Button variant="primary" onClick={save}>
                <Download className="h-4 w-4" aria-hidden />
                {report.keptOriginal ? 'Download original' : 'Download compressed PDF'}
              </Button>
            </div>
          </div>
        </Card>
      ) : null}

      {mode === 'target' && fitted && targetSummary ? (
        <Card
          className={cn(
            targetSummary.tone === 'good' ? 'border-ok/30 bg-ok/5' : 'border-line bg-elevated',
          )}
        >
          <div className="flex flex-col gap-4 p-5">
            <div className="flex items-start gap-2.5">
              <Target
                className={cn(
                  'mt-0.5 h-4 w-4 shrink-0',
                  targetSummary.tone === 'good' ? 'text-ok' : 'text-muted',
                )}
                aria-hidden
              />
              <div className="min-w-0">
                <p className="text-sm font-medium text-ink">{targetSummary.headline}</p>
                <p className="mt-1 text-[13px] leading-relaxed text-muted">
                  {targetSummary.detail}
                </p>
              </div>
            </div>

            <SizeChange before={fitted.originalSize} after={fitted.bytes.byteLength} />

            <dl className="grid grid-cols-2 gap-4 border-t border-line pt-4 sm:grid-cols-4">
              <Stat label="Your limit" value={formatTarget(fitted.target)} />
              <Stat label="Pages" value={fitted.pageCount} />
              {fitted.method === 'images' ? (
                <>
                  <Stat label="Page detail" value={`${fitted.step.dpi} DPI`} />
                  <Stat label="Image quality" value={`${fitted.step.quality}%`} />
                </>
              ) : fitted.kind === 'already' ? (
                <>
                  <Stat label="Re-encoded" value="none" />
                  <Stat label="Image quality" value="unchanged" />
                </>
              ) : (
                <>
                  <Stat
                    label="Re-encoded"
                    value={
                      fitted.report.jpegImages === 0
                        ? 'none'
                        : `${fitted.report.imagesRewritten} of ${fitted.report.jpegImages} JPEG`
                    }
                  />
                  <Stat
                    label="Image quality"
                    value={
                      fitted.report.imagesRewritten > 0 && fitted.step.quality !== null
                        ? `${fitted.step.quality}%`
                        : 'unchanged'
                    }
                  />
                </>
              )}
            </dl>

            {targetSummary.aside ? (
              <p className="text-[13px] leading-relaxed text-faint">{targetSummary.aside}</p>
            ) : null}

            {flattenMiss !== null ? (
              <p className="text-[13px] leading-relaxed text-faint">
                Turning the pages into images only got it to {formatBytes(flattenMiss)}, so this is
                still the smallest version.
              </p>
            ) : null}

            <div>
              <Button
                ref={fittedDownload}
                variant="primary"
                disabled={flattening}
                onClick={saveOutcome}
              >
                <Download className="h-4 w-4" aria-hidden />
                {fitted.untouched
                  ? 'Download original'
                  : fitted.kind === 'over'
                    ? 'Download smallest version'
                    : 'Download compressed PDF'}
              </Button>
            </div>

            {fitted.kind === 'over' && fitted.method === 'compress' && flattenMiss === null ? (
              <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4">
                <div>
                  <p className="text-[13px] font-medium text-ink">
                    Still too big? Turn the pages into images
                  </p>
                  <p className="mt-1 text-[13px] leading-relaxed text-muted">
                    Each page becomes a single picture, which can come out much smaller when fonts,
                    drawings or unusual images are what&rsquo;s taking the room.
                  </p>
                  <p className="mt-2 flex items-start gap-2 text-[13px] leading-relaxed text-ink">
                    <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn" aria-hidden />
                    Text won&rsquo;t be selectable or searchable afterwards, and links will stop
                    working.
                  </p>
                </div>

                {flattening ? (
                  searchProgress
                ) : (
                  <div>
                    <Button size="sm" disabled={busy} onClick={() => void flatten()}>
                      <Images className="h-3.5 w-3.5" aria-hidden />
                      Turn {plural(fitted.pageCount, 'page')} into images
                    </Button>
                  </div>
                )}

                {flattenError ? <ErrorNote message={flattenError} /> : null}
              </div>
            ) : null}
          </div>
        </Card>
      ) : null}
    </div>
  );
}

function SizeLimitField({
  choice,
  onChoice,
  customText,
  onCustomText,
  unit,
  onUnit,
  onLeave,
  error,
  hint,
  disabled,
  inputRef,
}: {
  choice: LimitChoice;
  onChoice: (choice: LimitChoice) => void;
  customText: string;
  onCustomText: (text: string) => void;
  unit: SizeUnit;
  onUnit: (unit: SizeUnit) => void;
  onLeave: () => void;
  error: string | null;
  hint: string;
  disabled: boolean;
  inputRef: React.RefObject<HTMLInputElement | null>;
}) {
  const id = useId();
  const pill = (active: boolean) =>
    cn(
      'cursor-pointer rounded-lg border px-3 py-1.5 text-[13px] font-medium transition-colors',
      'focus-within:ring-2 focus-within:ring-accent',
      active ? 'border-accent bg-accent text-accent-ink' : 'border-line bg-bg text-muted hover:text-ink',
      disabled && 'cursor-not-allowed opacity-60',
    );

  return (
    <fieldset disabled={disabled} className="min-w-0">
      <legend className="text-[13px] font-medium text-ink">Size limit</legend>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {QUICK_TARGETS.map((option, index) => (
          <label key={formatTarget(option)} className={pill(choice === index)}>
            <input
              type="radio"
              name={`${id}-limit`}
              checked={choice === index}
              onChange={() => onChoice(index)}
              className="sr-only"
            />
            {formatTarget(option)}
          </label>
        ))}
        <label className={pill(choice === 'custom')}>
          <input
            type="radio"
            name={`${id}-limit`}
            checked={choice === 'custom'}
            onChange={() => onChoice('custom')}
            className="sr-only"
          />
          Other size
        </label>
      </div>

      {choice === 'custom' ? (
        <div
          className="mt-2.5 flex flex-wrap items-center gap-2"
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget)) onLeave();
          }}
        >
          <input
            ref={inputRef}
            type="text"
            inputMode="decimal"
            autoComplete="off"
            spellCheck={false}
            aria-label="Size limit"
            value={customText}
            onChange={(e) => onCustomText(e.target.value)}
            placeholder="e.g. 750"
            aria-invalid={error ? true : undefined}
            aria-describedby={`${id}-help`}
            className={cn(
              'h-10 w-32 rounded-xl border bg-surface px-3 font-mono text-sm text-ink',
              'placeholder:font-sans placeholder:text-faint disabled:opacity-60',
              error ? 'border-danger' : 'border-line',
            )}
          />
          {/* Without this, pressing a unit blurs the box and counts as leaving it. */}
          <div
            role="radiogroup"
            aria-label="Unit"
            onMouseDown={(e) => e.preventDefault()}
            className="inline-flex rounded-lg border border-line bg-bg p-0.5"
          >
            {UNITS.map((option) => (
              <label
                key={option}
                className={cn(
                  'cursor-pointer rounded-md px-2.5 py-1 text-[13px] font-medium transition-colors',
                  'focus-within:ring-2 focus-within:ring-accent',
                  unit === option ? 'bg-accent text-accent-ink' : 'text-muted hover:text-ink',
                  disabled && 'cursor-not-allowed opacity-60',
                )}
              >
                <input
                  type="radio"
                  name={`${id}-unit`}
                  value={option}
                  checked={unit === option}
                  onChange={() => onUnit(option)}
                  className="sr-only"
                />
                {option}
              </label>
            ))}
          </div>
        </div>
      ) : null}

      {error ? (
        <p id={`${id}-help`} role="alert" className="mt-1.5 text-[13px] text-danger">
          {error}
        </p>
      ) : (
        <p id={`${id}-help`} className="mt-1.5 text-xs text-faint">
          {hint}
        </p>
      )}
    </fieldset>
  );
}
