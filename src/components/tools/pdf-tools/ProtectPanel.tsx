import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { CircleCheckBig, Download, Eye, EyeOff, Lock, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { Dropzone } from '@/components/ui/Dropzone';
import { useToast } from '@/components/ToastProvider';
import { cn } from '@/lib/cn';
import { downloadBlob } from '@/lib/download';
import { baseName, formatBytes } from '@/lib/format';
import { describePdfError, looksLikePdf } from '@/lib/pdf-tools/errors';
import {
  describeExistingProtection,
  isUnlockerReady,
  passwordProblem,
  protectPdf,
  unlockerDownloadSize,
} from '@/lib/pdf-tools/password';
import { downloadName, readPdf, tick, type LoadedPdf } from '@/lib/pdf-tools/pdf';
import { ErrorNote, FileLine, Note, Progress, Stat } from './shared';

/** readPdf turns away every encrypted PDF; this says which kind of protection is already on it. */
async function describeLoadError(err: unknown, file: File): Promise<string> {
  try {
    const existing = await describeExistingProtection(
      new Uint8Array(await file.arrayBuffer()),
      file.name,
    );
    if (existing) return existing;
  } catch {
    // The general message still points to the Unlock tab
  }
  return describePdfError(err, file.name);
}

export function ProtectPanel() {
  const toast = useToast();
  const passwordId = useId();
  const confirmId = useId();
  const passwordField = useRef<HTMLInputElement>(null);
  const downloadButton = useRef<HTMLButtonElement>(null);

  const [file, setFile] = useState<LoadedPdf | null>(null);
  const [reading, setReading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [passwordBlurred, setPasswordBlurred] = useState(false);
  const [confirmBlurred, setConfirmBlurred] = useState(false);
  const [reveal, setReveal] = useState(false);

  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [result, setResult] = useState<Blob | null>(null);
  const [downloadHint, setDownloadHint] = useState<string | null>(null);

  const passwordIssue = password === '' ? null : passwordProblem(password);
  // Held back while typing: dead keys and input methods briefly put in characters it refuses.
  const shownIssue = passwordBlurred ? passwordIssue : null;
  // Quiet while the confirmation is still a correct start of the password.
  const mismatch =
    confirm !== '' && confirm !== password && (confirmBlurred || !password.startsWith(confirm));
  const ready = password !== '' && password === confirm && !passwordIssue;

  useEffect(() => {
    if (!file) return;
    passwordField.current?.focus();
    let live = true;
    void (async () => {
      const size = (await isUnlockerReady()) ? null : await unlockerDownloadSize();
      if (live) setDownloadHint(size);
    })();
    return () => {
      live = false;
    };
  }, [file]);

  useEffect(() => {
    if (result) downloadButton.current?.focus();
  }, [result]);

  const clearPasswords = useCallback(() => {
    setPassword('');
    setConfirm('');
    setPasswordBlurred(false);
    setConfirmBlurred(false);
    setReveal(false);
  }, []);

  const reset = useCallback(() => {
    setFile(null);
    setLoadError(null);
    setActionError(null);
    setResult(null);
    clearPasswords();
  }, [clearPasswords]);

  const pick = useCallback(async (files: File[]) => {
    const candidate = files[0];
    if (!candidate) return;
    setLoadError(null);
    setActionError(null);
    setResult(null);

    if (!looksLikePdf(candidate)) {
      setLoadError(`“${candidate.name}” isn’t a PDF. Pick a .pdf file to protect.`);
      return;
    }

    setReading(true);
    try {
      await tick();
      setFile(await readPdf(candidate));
    } catch (err) {
      setLoadError(await describeLoadError(err, candidate));
      setFile(null);
    } finally {
      setReading(false);
    }
  }, []);

  async function protect() {
    if (!file || busy || !ready) return;
    setBusy(true);
    setActionError(null);

    try {
      await tick();
      const bytes = await protectPdf(file.bytes.slice(), password);
      setResult(new Blob([bytes], { type: 'application/pdf' }));
      clearPasswords();
      setDownloadHint(null);
    } catch (err) {
      setActionError(describePdfError(err, file.name));
      toast.error('The password could not be added.');
      if (await isUnlockerReady()) setDownloadHint(null);
    } finally {
      setBusy(false);
    }
  }

  function save() {
    if (!file || !result) return;
    const name = downloadName(`${baseName(file.name)} - protected`, 'pdf', 'protected.pdf');
    downloadBlob(result, name);
    toast.celebrate(`Saved ${name}`);
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader
          title="PDF to protect"
          description="Add a password so nobody can open the PDF without it. One file at a time, opened here in your browser."
          actions={
            file ? (
              <Button variant="ghost" size="sm" disabled={busy} onClick={reset}>
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
              hint="Nothing is uploaded. The file is opened on this device."
              icon={<Lock className="h-5 w-5" aria-hidden />}
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

      {file && !result ? (
        <Card>
          <CardHeader
            title="Choose a password"
            description="Anyone opening the PDF will be asked for it. It stays in this tab, and is never saved or sent."
          />
          <form
            className="flex flex-col gap-5 p-5"
            onSubmit={(e) => {
              e.preventDefault();
              setPasswordBlurred(true);
              setConfirmBlurred(true);
              void protect();
            }}
          >
            <fieldset disabled={busy} className="min-w-0">
              <legend className="sr-only">New password</legend>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="min-w-0">
                  <label htmlFor={passwordId} className="text-[13px] font-medium text-ink">
                    Password
                  </label>
                  <div className="relative mt-1.5">
                    <input
                      ref={passwordField}
                      id={passwordId}
                      type={reveal ? 'text' : 'password'}
                      value={password}
                      autoComplete="new-password"
                      autoCapitalize="off"
                      autoCorrect="off"
                      spellCheck={false}
                      aria-invalid={shownIssue ? true : undefined}
                      aria-describedby={shownIssue ? `${passwordId}-issue` : undefined}
                      onChange={(e) => setPassword(e.target.value)}
                      onBlur={() => setPasswordBlurred(true)}
                      className={cn(
                        'h-10 w-full rounded-xl border bg-surface pl-3 pr-10 text-sm text-ink shadow-sm focus:outline-none',
                        shownIssue
                          ? 'border-danger focus:ring-2 focus:ring-danger/25'
                          : 'border-line focus:border-accent',
                      )}
                    />
                    <button
                      type="button"
                      onClick={() => setReveal((on) => !on)}
                      aria-label={reveal ? 'Hide the passwords' : 'Show the passwords'}
                      className="absolute right-1 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-lg text-muted transition-colors hover:text-ink"
                    >
                      {reveal ? (
                        <EyeOff className="h-4 w-4" aria-hidden />
                      ) : (
                        <Eye className="h-4 w-4" aria-hidden />
                      )}
                    </button>
                  </div>
                  {shownIssue ? (
                    <p id={`${passwordId}-issue`} role="alert" className="mt-1.5 text-[13px] text-danger">
                      {shownIssue}
                    </p>
                  ) : null}
                </div>

                <div className="min-w-0">
                  <label htmlFor={confirmId} className="text-[13px] font-medium text-ink">
                    Confirm password
                  </label>
                  <input
                    id={confirmId}
                    type={reveal ? 'text' : 'password'}
                    value={confirm}
                    autoComplete="new-password"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    aria-invalid={mismatch ? true : undefined}
                    aria-describedby={mismatch ? `${confirmId}-issue` : undefined}
                    onChange={(e) => setConfirm(e.target.value)}
                    onBlur={() => setConfirmBlurred(true)}
                    className={cn(
                      'mt-1.5 h-10 w-full rounded-xl border bg-surface px-3 text-sm text-ink shadow-sm focus:outline-none',
                      mismatch
                        ? 'border-danger focus:ring-2 focus:ring-danger/25'
                        : 'border-line focus:border-accent',
                    )}
                  />
                  {mismatch ? (
                    <p id={`${confirmId}-issue`} role="alert" className="mt-1.5 text-[13px] text-danger">
                      The passwords don’t match.
                    </p>
                  ) : null}
                </div>
              </div>
            </fieldset>

            <Note>
              There is no way back into the file if the password is forgotten, so keep it somewhere
              safe.
            </Note>

            <div className="flex flex-col gap-3 border-t border-line pt-4">
              {busy ? (
                <Progress
                  label={
                    downloadHint
                      ? `Getting ready — a one-time download of ${downloadHint}.`
                      : 'Adding the password…'
                  }
                  done={0}
                  total={0}
                />
              ) : null}

              {actionError ? <ErrorNote message={actionError} /> : null}

              <div className="flex flex-wrap items-center gap-3">
                <Button type="submit" variant="primary" disabled={busy || !ready}>
                  <Lock className="h-4 w-4" aria-hidden />
                  {busy ? 'Protecting…' : 'Protect PDF'}
                </Button>
                {downloadHint && !busy ? (
                  <p className="text-[13px] text-faint">
                    Needs a one-time download of {downloadHint}.
                  </p>
                ) : null}
              </div>
            </div>
          </form>
        </Card>
      ) : null}

      {file && result ? (
        <Card className="border-ok/30 bg-ok/5">
          <div className="flex flex-col gap-4 p-5">
            <div className="flex items-start gap-2.5">
              <CircleCheckBig className="mt-0.5 h-4 w-4 shrink-0 text-ok" aria-hidden />
              <div className="min-w-0">
                <p className="text-sm font-medium text-ink">
                  Protected. The PDF now asks for the password when it is opened.
                </p>
                <p className="mt-1 text-[13px] leading-relaxed text-muted">
                  Once it is open, printing and copying work as normal.
                </p>
              </div>
            </div>

            <dl className="grid grid-cols-2 gap-4 border-t border-line pt-4 sm:grid-cols-3">
              <Stat label="Pages" value={file.pageCount} />
              <Stat label="Size" value={formatBytes(result.size)} />
              <Stat label="Encryption" value="AES-256" />
            </dl>

            <div>
              <Button ref={downloadButton} variant="primary" onClick={save}>
                <Download className="h-4 w-4" aria-hidden />
                Download protected PDF
              </Button>
            </div>
          </div>
        </Card>
      ) : null}
    </div>
  );
}
