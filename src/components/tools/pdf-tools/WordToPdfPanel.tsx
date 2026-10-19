import { useCallback, useRef, useState } from 'react';
import { FileText, RotateCcw, Square } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { Dropzone } from '@/components/ui/Dropzone';
import { useToast } from '@/components/ToastProvider';
import { downloadBlob } from '@/lib/download';
import { baseName, formatBytes } from '@/lib/format';
import { downloadName, tick } from '@/lib/pdf-tools/pdf';
import {
  DEFAULT_OPTIONS,
  DocxError,
  looksLikeWord,
  wordToPdf,
  type WordPdfOptions,
  type WordPdfReport,
} from '@/lib/word-to-pdf';
import { Choice, ErrorNote, FileLine, Note, Progress, SelectField, Stat } from './shared';

type PaperChoice = WordPdfOptions['paper'];

const PAPER_OPTIONS: readonly { value: PaperChoice; label: string }[] = [
  { value: 'document', label: 'Same as the document' },
  { value: 'a4', label: 'A4' },
  { value: 'letter', label: 'Letter' },
  { value: 'legal', label: 'Legal' },
  { value: 'a3', label: 'A3' },
  { value: 'a5', label: 'A5' },
];

interface Result {
  name: string;
  size: number;
  report: WordPdfReport;
}

export function WordToPdfPanel() {
  const toast = useToast();

  const [file, setFile] = useState<File | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [paper, setPaper] = useState<PaperChoice>(DEFAULT_OPTIONS.paper);
  const [images, setImages] = useState(DEFAULT_OPTIONS.images);
  const [links, setLinks] = useState(DEFAULT_OPTIONS.links);
  const [headersFooters, setHeadersFooters] = useState(DEFAULT_OPTIONS.headersFooters);

  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState({ label: '', done: 0, total: 0 });
  const [actionError, setActionError] = useState<string | null>(null);
  const [stopped, setStopped] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const stopper = useRef<AbortController | null>(null);

  const pick = useCallback((files: File[]) => {
    const candidate = files[0];
    if (!candidate) return;
    setLoadError(null);
    setActionError(null);
    setStopped(false);
    setResult(null);

    if (!looksLikeWord(candidate)) {
      setLoadError(
        candidate.name.toLowerCase().endsWith('.doc')
          ? `“${candidate.name}” is an old .doc file. Open it in Word or LibreOffice and save it as .docx first.`
          : `“${candidate.name}” isn’t a Word file. Pick a .docx file to convert.`,
      );
      setFile(null);
      return;
    }

    setFile(candidate);
  }, []);

  async function run() {
    if (!file || busy) return;

    const controller = new AbortController();
    stopper.current = controller;
    setBusy(true);
    setActionError(null);
    setStopped(false);
    setResult(null);
    setStatus({ label: 'Opening your document…', done: 0, total: 0 });

    try {
      await tick();
      const { bytes, report } = await wordToPdf(
        file,
        { paper, images, links, headersFooters, signal: controller.signal },
        (progress) => {
          setStatus({
            label: progress.stage === 'reading' ? 'Reading your document…' : 'Drawing the pages…',
            done: progress.done,
            total: progress.total,
          });
        },
      );

      const name = downloadName(baseName(file.name), 'pdf', 'document.pdf');
      downloadBlob(new Blob([bytes], { type: 'application/pdf' }), name);
      setResult({ name, size: bytes.byteLength, report });
      toast.celebrate(`Saved ${name}`);
    } catch (err) {
      if (controller.signal.aborted) setStopped(true);
      else {
        setActionError(
          err instanceof DocxError
            ? err.message
            : 'That conversion did not work. The document may be damaged, or too big for this tab.',
        );
        toast.error('That conversion did not work.');
      }
    } finally {
      stopper.current = null;
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader
          title="Word file to convert"
          description="One .docx at a time. You get a PDF that reads the same on any device."
          actions={
            file ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setFile(null);
                  setLoadError(null);
                  setActionError(null);
                  setStopped(false);
                  setResult(null);
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
            <FileLine name={file.name} size={file.size} detail="Word document" />
          ) : (
            <Dropzone
              accept=".docx,.docm,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              title="Drop a Word file here"
              hint="Letters, reports, CVs and the like"
              onFiles={pick}
            />
          )}

          {loadError ? <ErrorNote className="mt-4" message={loadError} /> : null}
        </div>
      </Card>

      {!file ? (
        <Note>Add a .docx file to get started.</Note>
      ) : (
        <Card>
          <CardHeader
            title="How it should come out"
            description="Page size, margins, headings, lists, tables and pictures all come from the document."
          />
          <div className="flex flex-col gap-5 p-5">
            <fieldset disabled={busy} className="max-w-xs">
              <legend className="sr-only">Paper</legend>
              <SelectField
                label="Paper"
                value={paper}
                options={PAPER_OPTIONS}
                disabled={busy}
                hint="Leave this alone unless the document was set up for the wrong paper."
                onChange={(value) => {
                  setPaper(value);
                  setResult(null);
                }}
              />
            </fieldset>

            <fieldset disabled={busy} className="border-t border-line pt-3">
              <legend className="sr-only">What to include</legend>
              <Choice
                label="Include pictures"
                hint="Turn this off for a much smaller file that is all text."
                checked={images}
                disabled={busy}
                onChange={(value) => {
                  setImages(value);
                  setResult(null);
                }}
              />
              <Choice
                label="Keep web links clickable"
                checked={links}
                disabled={busy}
                onChange={(value) => {
                  setLinks(value);
                  setResult(null);
                }}
              />
              <Choice
                label="Include headers and footers"
                hint="The bands at the top and bottom of each page, with page numbers worked out again."
                checked={headersFooters}
                disabled={busy}
                onChange={(value) => {
                  setHeadersFooters(value);
                  setResult(null);
                }}
              />
            </fieldset>

            <Note>
              Fonts are matched to the three a PDF reader always has, so the shapes of letters will
              be close rather than identical, and lines may break in slightly different places.
            </Note>

            <div className="flex flex-col gap-3 border-t border-line pt-4">
              {busy ? (
                <div className="flex items-center gap-3">
                  <Progress
                    className="min-w-0 flex-1"
                    label={status.label}
                    done={status.done}
                    total={status.total}
                  />
                  <Button size="sm" onClick={() => stopper.current?.abort()}>
                    <Square className="h-3.5 w-3.5" aria-hidden />
                    Stop
                  </Button>
                </div>
              ) : null}

              {stopped ? (
                <Note>Stopped. Nothing was saved, and your document is untouched.</Note>
              ) : null}

              {actionError ? <ErrorNote message={actionError} /> : null}

              <div>
                <Button variant="primary" disabled={busy} onClick={() => void run()}>
                  <FileText className="h-4 w-4" aria-hidden />
                  {busy ? 'Working…' : 'Convert to PDF'}
                </Button>
              </div>
            </div>
          </div>
        </Card>
      )}

      {result ? (
        <Card>
          <CardHeader title="Saved" description={result.name} />
          <div className="flex flex-col gap-4 p-5">
            <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Stat label="Pages" value={result.report.pageCount} />
              <Stat label="Paragraphs" value={result.report.paragraphs.toLocaleString()} />
              <Stat label="Tables" value={result.report.tables} />
              <Stat label="Size" value={formatBytes(result.size)} />
            </dl>
            {result.report.notes.length > 0 ? (
              <Note>
                <ul className="flex flex-col gap-1">
                  {result.report.notes.map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
              </Note>
            ) : null}
          </div>
        </Card>
      ) : null}
    </div>
  );
}
