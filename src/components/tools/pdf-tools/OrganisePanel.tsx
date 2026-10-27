import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CircleCheckBig,
  Download,
  FileOutput,
  RotateCcw,
  RotateCcwSquare,
  RotateCwSquare,
  Undo2,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { Dropzone } from '@/components/ui/Dropzone';
import { useToast } from '@/components/ToastProvider';
import { downloadBlob } from '@/lib/download';
import { baseName, formatBytes, plural } from '@/lib/format';
import { describePdfError, looksLikePdf } from '@/lib/pdf-tools/errors';
import {
  describeLayout,
  initialLayout,
  organisePdf,
  readPageInfo,
  rotateAll,
  summariseLayout,
  type Direction,
  type Layout,
  type LayoutSummary,
  type OrganiseStage,
  type PageInfo,
} from '@/lib/pdf-tools/organise';
import { downloadName, readPdf, tick, type LoadedPdf } from '@/lib/pdf-tools/pdf';
import { OrganiseGrid } from './OrganiseGrid';
import { ErrorNote, FileLine, Note, Progress, Stat } from './shared';
import { useThumbnails } from './useThumbnails';

const STAGE_LABELS: Record<OrganiseStage, string> = {
  reading: 'Reading your PDF…',
  arranging: 'Putting the pages in order…',
  saving: 'Saving the new file…',
};

const EMPTY: Layout = { pages: [], removed: [] };

interface OrganiseResult {
  name: string;
  bytes: Uint8Array;
  summary: LayoutSummary;
}

export function OrganisePanel({ active }: { active: boolean }) {
  const toast = useToast();
  const [file, setFile] = useState<LoadedPdf | null>(null);
  const [info, setInfo] = useState<PageInfo[]>([]);
  const [layout, setLayout] = useState<Layout>(EMPTY);
  const [resets, setResets] = useState(0);
  const [reading, setReading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<OrganiseStage>('reading');
  const [actionError, setActionError] = useState<string | null>(null);
  const [result, setResult] = useState<OrganiseResult | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const downloadButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (result) downloadButton.current?.focus();
  }, [result]);

  const thumbs = useThumbnails(file);
  const summary = useMemo(() => summariseLayout(layout, file?.pageCount ?? 0), [layout, file]);

  const change = useCallback((update: (current: Layout) => Layout) => {
    setResult(null);
    setActionError(null);
    setLayout(update);
  }, []);

  const pick = useCallback(async (files: File[]) => {
    const candidate = files[0];
    if (!candidate) return;
    setLoadError(null);
    setActionError(null);
    setResult(null);

    if (!looksLikePdf(candidate)) {
      setLoadError(`“${candidate.name}” isn’t a PDF. Pick a .pdf file to organise.`);
      return;
    }

    setReading(true);
    try {
      await tick();
      const loaded = await readPdf(candidate);
      const pages = await readPageInfo(loaded);
      setInfo(pages);
      setLayout(initialLayout(loaded.pageCount));
      setFile(loaded);
    } catch (err) {
      setLoadError(describePdfError(err, candidate.name));
      setFile(null);
      setLayout(EMPTY);
    } finally {
      setReading(false);
    }
  }, []);

  function rotateEvery(direction: Direction) {
    change((current) => rotateAll(current, direction));
    setAnnouncement(`Every page turned ${direction}.`);
  }

  function resetAll() {
    if (!file) return;
    change(() => initialLayout(file.pageCount));
    setResets((n) => n + 1);
    setAnnouncement('All changes undone.');
  }

  async function run() {
    if (!file || busy) return;
    setBusy(true);
    setResult(null);
    setActionError(null);
    setStage('reading');

    try {
      await tick();
      const bytes = await organisePdf(file, layout.pages, setStage);
      const name = downloadName(`${baseName(file.name)} - organised`, 'pdf', 'organised.pdf');
      setResult({ name, bytes, summary });
    } catch (err) {
      setActionError(describePdfError(err, file.name));
      toast.error('Organising the PDF did not work.');
    } finally {
      setBusy(false);
    }
  }

  function save() {
    if (!result) return;
    downloadBlob(new Blob([result.bytes], { type: 'application/pdf' }), result.name);
    toast.celebrate(`Saved ${result.name}`);
  }

  const canSave = summary.changed && layout.pages.length > 0;

  return (
    <div className="flex flex-col gap-4">
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>

      <Card>
        <CardHeader
          title="PDF to organise"
          description="One PDF at a time. Every page appears below, ready to rotate, move, copy or delete."
          actions={
            file ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setFile(null);
                  setInfo([]);
                  setLayout(EMPTY);
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
              hint="Nothing is uploaded — the pages are arranged in this tab"
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
          Add a PDF to see every page laid out. Turn pages the right way up, delete the ones you
          don&rsquo;t need, drag the rest into order, copy a page or add a blank one, then save it
          all as a new PDF.
        </Note>
      ) : (
        <Card>
          <CardHeader title="Pages" description={describeLayout(summary)} />

          <div className="flex flex-wrap items-center gap-2 border-b border-line px-5 py-3">
            <Button
              size="sm"
              disabled={busy || layout.pages.length === 0}
              onClick={() => rotateEvery('left')}
            >
              <RotateCcwSquare className="h-3.5 w-3.5" aria-hidden />
              Rotate all left
            </Button>
            <Button
              size="sm"
              disabled={busy || layout.pages.length === 0}
              onClick={() => rotateEvery('right')}
            >
              <RotateCwSquare className="h-3.5 w-3.5" aria-hidden />
              Rotate all right
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="sm:ml-auto"
              disabled={busy || !summary.changed}
              onClick={resetAll}
            >
              <Undo2 className="h-3.5 w-3.5" aria-hidden />
              Reset all changes
            </Button>
          </div>

          {thumbs.error ? (
            <div className="border-b border-line px-5 py-3">
              <ErrorNote
                message={`${thumbs.error} Page previews are unavailable, but you can still organise the pages by number.`}
              />
            </div>
          ) : null}

          <OrganiseGrid
            key={`${file.id}:${resets}`}
            layout={layout}
            info={info}
            thumbs={thumbs}
            active={active}
            disabled={busy}
            onChange={change}
          />

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line px-5 py-3">
            <p className="mr-auto text-[12px] text-faint">
              Drag pages to reorder them, or select one and then select where it should go.
            </p>
            {!thumbs.error && thumbs.outstanding > 0 ? (
              <p className="text-xs text-faint" aria-live="polite">
                Rendering previews&hellip; {thumbs.outstanding} to go
              </p>
            ) : null}
          </div>

          <div className="flex flex-col gap-4 border-t border-line px-5 py-4">
            <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              <Stat label="Pages out" value={layout.pages.length.toLocaleString()} />
              <Stat label="Original" value={plural(file.pageCount, 'page')} />
              <Stat label="Source size" value={formatBytes(file.size)} />
            </dl>

            {busy ? <Progress label={STAGE_LABELS[stage]} done={0} total={0} /> : null}

            {actionError ? <ErrorNote message={actionError} /> : null}

            <div className="flex flex-wrap items-center gap-3">
              <Button variant="primary" disabled={busy || !canSave} onClick={() => void run()}>
                <FileOutput className="h-4 w-4" aria-hidden />
                {busy ? 'Working…' : 'Create organised PDF'}
              </Button>
              {layout.pages.length === 0 ? (
                <p className="text-[13px] text-faint">
                  Every page has been deleted &mdash; put at least one back.
                </p>
              ) : !summary.changed ? (
                <p className="text-[13px] text-faint">
                  Rotate, move, delete or add a page first.
                </p>
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
                <p className="text-sm font-medium text-ink">Your organised PDF is ready.</p>
                <p className="mt-0.5 text-[13px] text-muted">{describeLayout(result.summary)}</p>
              </div>
            </div>

            <dl className="grid grid-cols-2 gap-4 border-t border-line pt-4 sm:grid-cols-4">
              <Stat label="Pages" value={result.summary.pages.toLocaleString()} />
              <Stat label="Rotated" value={result.summary.rotated.toLocaleString()} />
              <Stat label="Deleted" value={result.summary.deleted.toLocaleString()} />
              <Stat label="File size" value={formatBytes(result.bytes.byteLength)} />
            </dl>

            <div>
              <Button ref={downloadButton} variant="primary" onClick={save}>
                <Download className="h-4 w-4" aria-hidden />
                Download organised PDF
              </Button>
            </div>
          </div>
        </Card>
      ) : null}
    </div>
  );
}
