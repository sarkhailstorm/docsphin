import { useCallback, useRef, useState } from 'react';
import { FileText, RotateCcw, Square } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { Dropzone } from '@/components/ui/Dropzone';
import { useToast } from '@/components/ToastProvider';
import { downloadBlob } from '@/lib/download';
import { baseName, formatBytes } from '@/lib/format';
import { downloadName, tick } from '@/lib/pdf-tools/pdf';
import { PAPERS, type PaperId } from '@/lib/make-pdf/paper';
import {
  ACCEPT_ATTRIBUTE,
  DEFAULT_OPTIONS,
  excelToPdf,
  looksLikeSpreadsheet,
  readWorkbook,
  SpreadsheetError,
  type ExcelPdfOptions,
  type ExcelPdfReport,
  type TextSize,
  type Workbook,
} from '@/lib/excel-to-pdf';
import { Choice, ErrorNote, FileLine, Note, Progress, SelectField, Stat } from './shared';

type OrientationChoice = ExcelPdfOptions['orientation'];

const PAPER_OPTIONS = PAPERS.map((p) => ({ value: p.id, label: p.label }));

const ORIENTATION_OPTIONS: readonly { value: OrientationChoice; label: string }[] = [
  { value: 'auto', label: 'Whichever fits' },
  { value: 'portrait', label: 'Upright' },
  { value: 'landscape', label: 'On its side' },
];

const SIZE_OPTIONS: readonly { value: TextSize; label: string }[] = [
  { value: 'small', label: 'Small' },
  { value: 'normal', label: 'Normal' },
  { value: 'large', label: 'Large' },
];

function describe(workbook: Workbook): string {
  const count = workbook.sheets.length;
  return `${count} ${count === 1 ? 'sheet' : 'sheets'}`;
}

interface Loaded {
  file: File;
  workbook: Workbook;
}

interface Result {
  name: string;
  size: number;
  report: ExcelPdfReport;
}

export function ExcelToPdfPanel() {
  const toast = useToast();

  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [reading, setReading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [paper, setPaper] = useState<PaperId>(DEFAULT_OPTIONS.paper);
  const [orientation, setOrientation] = useState<OrientationChoice>(DEFAULT_OPTIONS.orientation);
  const [textSize, setTextSize] = useState<TextSize>(DEFAULT_OPTIONS.textSize);
  const [fitWidth, setFitWidth] = useState(DEFAULT_OPTIONS.fitWidth);
  const [gridlines, setGridlines] = useState(DEFAULT_OPTIONS.gridlines);
  const [repeatHeader, setRepeatHeader] = useState(DEFAULT_OPTIONS.repeatHeader);
  const [footer, setFooter] = useState(DEFAULT_OPTIONS.footer);
  const [chosen, setChosen] = useState<string[]>([]);

  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState({ label: '', done: 0, total: 0 });
  const [actionError, setActionError] = useState<string | null>(null);
  const [stopped, setStopped] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const stopper = useRef<AbortController | null>(null);

  const reset = useCallback(() => {
    setLoadError(null);
    setActionError(null);
    setStopped(false);
    setResult(null);
  }, []);

  const pick = useCallback(
    async (files: File[]) => {
      const candidate = files[0];
      if (!candidate) return;
      reset();

      if (!looksLikeSpreadsheet(candidate)) {
        setLoadError(
          `“${candidate.name}” isn’t a spreadsheet. Pick an .xlsx, .xls, .ods or .csv file.`,
        );
        return;
      }

      setReading(true);
      try {
        await tick();
        const workbook = await readWorkbook(candidate);
        setLoaded({ file: candidate, workbook });
        setChosen(workbook.sheets.filter((s) => !s.hidden).map((s) => s.name));
      } catch (err) {
        setLoadError(
          err instanceof SpreadsheetError
            ? err.message
            : `“${candidate.name}” could not be read. It may be corrupt, or not really a spreadsheet.`,
        );
        setLoaded(null);
      } finally {
        setReading(false);
      }
    },
    [reset],
  );

  async function run() {
    if (!loaded || busy) return;

    const controller = new AbortController();
    stopper.current = controller;
    setBusy(true);
    setActionError(null);
    setStopped(false);
    setResult(null);
    setStatus({ label: 'Getting started…', done: 0, total: loaded.workbook.sheets.length });

    try {
      await tick();
      const { bytes, report } = await excelToPdf(
        loaded.workbook,
        {
          paper,
          orientation,
          textSize,
          fitWidth,
          gridlines,
          repeatHeader,
          footer,
          sheets: chosen,
          signal: controller.signal,
        },
        (progress) => {
          setStatus({
            label: progress.sheet ? `Drawing “${progress.sheet}”…` : 'Finishing the PDF…',
            done: progress.done,
            total: progress.total,
          });
        },
      );

      const name = downloadName(baseName(loaded.file.name), 'pdf', 'spreadsheet.pdf');
      downloadBlob(new Blob([bytes], { type: 'application/pdf' }), name);
      setResult({ name, size: bytes.byteLength, report });
      toast.celebrate(`Saved ${name}`);
    } catch (err) {
      if (controller.signal.aborted) setStopped(true);
      else {
        const message =
          err instanceof Error && err.message
            ? err.message
            : 'That conversion did not work. Try a smaller spreadsheet.';
        setActionError(message);
        toast.error('That conversion did not work.');
      }
    } finally {
      stopper.current = null;
      setBusy(false);
    }
  }

  const sheets = loaded?.workbook.sheets ?? [];

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader
          title="Spreadsheet to convert"
          description="One file at a time. You get a PDF you can email, print or file away."
          actions={
            loaded ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setLoaded(null);
                  setChosen([]);
                  reset();
                }}
              >
                <RotateCcw className="h-3.5 w-3.5" aria-hidden />
                Start over
              </Button>
            ) : null
          }
        />
        <div className="p-5">
          {loaded ? (
            <FileLine
              name={loaded.file.name}
              size={loaded.file.size}
              detail={describe(loaded.workbook)}
            />
          ) : (
            <Dropzone
              accept={ACCEPT_ATTRIBUTE}
              disabled={reading}
              title="Drop a spreadsheet here"
              hint="Excel, OpenDocument or CSV"
              onFiles={(files) => {
                void pick(files);
              }}
            />
          )}

          {reading ? (
            <Progress className="mt-4" label="Opening your spreadsheet…" done={0} total={0} />
          ) : null}

          {loadError ? <ErrorNote className="mt-4" message={loadError} /> : null}
        </div>
      </Card>

      {!loaded ? (
        <Note>Add a spreadsheet to get started.</Note>
      ) : (
        <>
          {sheets.length > 1 ? (
            <Card>
              <CardHeader
                title="Sheets to include"
                description="Each sheet starts on a new page."
              />
              <fieldset disabled={busy} className="flex flex-col gap-0.5 p-5">
                <legend className="sr-only">Sheets</legend>
                {sheets.map((sheet) => (
                  <Choice
                    key={sheet.name}
                    label={sheet.name}
                    hint={sheet.hidden ? 'Hidden in Excel' : undefined}
                    checked={chosen.includes(sheet.name)}
                    disabled={busy}
                    onChange={(on) => {
                      setChosen((current) =>
                        on
                          ? [...current, sheet.name]
                          : current.filter((name) => name !== sheet.name),
                      );
                      setResult(null);
                    }}
                  />
                ))}
              </fieldset>
            </Card>
          ) : null}

          <Card>
            <CardHeader title="How the page should look" />
            <div className="flex flex-col gap-5 p-5">
              <fieldset disabled={busy} className="grid gap-4 sm:grid-cols-3">
                <legend className="sr-only">Page setup</legend>
                <SelectField
                  label="Paper"
                  value={paper}
                  options={PAPER_OPTIONS}
                  disabled={busy}
                  onChange={(value) => {
                    setPaper(value);
                    setResult(null);
                  }}
                />
                <SelectField
                  label="Direction"
                  value={orientation}
                  options={ORIENTATION_OPTIONS}
                  disabled={busy}
                  onChange={(value) => {
                    setOrientation(value);
                    setResult(null);
                  }}
                />
                <SelectField
                  label="Text size"
                  value={textSize}
                  options={SIZE_OPTIONS}
                  disabled={busy}
                  onChange={(value) => {
                    setTextSize(value);
                    setResult(null);
                  }}
                />
              </fieldset>

              <fieldset disabled={busy} className="border-t border-line pt-3">
                <legend className="sr-only">Layout</legend>
                <Choice
                  label="Squeeze the columns so a whole row fits"
                  hint="Turn this off to keep the column widths and carry on over the page."
                  checked={fitWidth}
                  disabled={busy}
                  onChange={(value) => {
                    setFitWidth(value);
                    setResult(null);
                  }}
                />
                <Choice
                  label="Draw the grid"
                  checked={gridlines}
                  disabled={busy}
                  onChange={(value) => {
                    setGridlines(value);
                    setResult(null);
                  }}
                />
                <Choice
                  label="Repeat the top row on every page"
                  checked={repeatHeader}
                  disabled={busy}
                  onChange={(value) => {
                    setRepeatHeader(value);
                    setResult(null);
                  }}
                />
                <Choice
                  label="Add page numbers at the bottom"
                  checked={footer}
                  disabled={busy}
                  onChange={(value) => {
                    setFooter(value);
                    setResult(null);
                  }}
                />
              </fieldset>

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
                  <Note>Stopped. Nothing was saved, and your spreadsheet is untouched.</Note>
                ) : null}

                {actionError ? <ErrorNote message={actionError} /> : null}

                <div>
                  <Button
                    variant="primary"
                    disabled={busy || chosen.length === 0}
                    onClick={() => void run()}
                  >
                    <FileText className="h-4 w-4" aria-hidden />
                    {busy ? 'Working…' : 'Convert to PDF'}
                  </Button>
                </div>
              </div>
            </div>
          </Card>
        </>
      )}

      {result ? (
        <Card>
          <CardHeader title="Saved" description={result.name} />
          <div className="flex flex-col gap-4 p-5">
            <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Stat label="Pages" value={result.report.pageCount} />
              <Stat label="Sheets" value={result.report.sheetCount} />
              <Stat label="Rows" value={result.report.rowCount.toLocaleString()} />
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
