import { useId } from 'react';
import { cn } from '@/lib/cn';
import { parsePageRanges, type RangeResult } from '@/lib/pdf-tools/ranges';

export interface PageRange {
  scope: 'all' | 'some';
  text: string;
}

export const ALL_PAGES: PageRange = { scope: 'all', text: '' };

const SCOPES: readonly { value: PageRange['scope']; label: string }[] = [
  { value: 'all', label: 'All pages' },
  { value: 'some', label: 'Only some' },
];

/** The chosen pages, 1-based and sorted, or why they can't be used yet. */
export function resolvePageRange(range: PageRange, pageCount: number): RangeResult {
  if (range.scope === 'all') {
    return { ok: true, pages: Array.from({ length: pageCount }, (_, i) => i + 1) };
  }
  const parsed = parsePageRanges(range.text, pageCount);
  if (parsed.ok && parsed.pages.length === 0) {
    return { ok: false, message: 'Type the pages you want, like 1-3, 7.' };
  }
  return parsed;
}

export function PageRangeField({
  label,
  value,
  onChange,
  pageCount,
  disabled = false,
}: {
  label: string;
  value: PageRange;
  onChange: (value: PageRange) => void;
  pageCount: number;
  disabled?: boolean;
}) {
  const id = useId();
  const resolved = resolvePageRange(value, pageCount);
  // Only complain once something has been typed
  const error = value.scope === 'some' && value.text.trim() !== '' && !resolved.ok ? resolved.message : null;

  return (
    <fieldset disabled={disabled} className="min-w-0">
      <legend className="text-[13px] font-medium text-ink">{label}</legend>
      <div className="mt-1.5 inline-flex rounded-lg border border-line bg-bg p-0.5">
        {SCOPES.map((scope) => {
          const active = value.scope === scope.value;
          return (
            <label
              key={scope.value}
              className={cn(
                'cursor-pointer rounded-md px-2.5 py-1 text-[13px] font-medium transition-colors focus-within:ring-2 focus-within:ring-accent',
                active ? 'bg-accent text-accent-ink' : 'text-muted hover:text-ink',
                disabled && 'cursor-not-allowed opacity-60',
              )}
            >
              <input
                type="radio"
                name={`${id}-scope`}
                value={scope.value}
                checked={active}
                onChange={() => onChange({ ...value, scope: scope.value })}
                className="sr-only"
              />
              {scope.label}
            </label>
          );
        })}
      </div>

      {value.scope === 'some' ? (
        <div className="mt-2">
          <input
            type="text"
            inputMode="text"
            autoComplete="off"
            spellCheck={false}
            aria-label={`${label}: page numbers`}
            value={value.text}
            onChange={(e) => onChange({ ...value, text: e.target.value })}
            placeholder="e.g. 1-3, 7, 9-12"
            aria-invalid={error ? true : undefined}
            aria-describedby={`${id}-help`}
            className={cn(
              'h-10 w-full rounded-xl border bg-surface px-3 font-mono text-sm text-ink',
              'placeholder:font-sans placeholder:text-faint disabled:opacity-60',
              error ? 'border-danger' : 'border-line',
            )}
          />
          {error ? (
            <p id={`${id}-help`} role="alert" className="mt-1.5 text-[13px] text-danger">
              {error}
            </p>
          ) : (
            <p id={`${id}-help`} className="mt-1.5 text-xs text-faint">
              Pages 1 to {pageCount}, separated by commas.
            </p>
          )}
        </div>
      ) : null}
    </fieldset>
  );
}
