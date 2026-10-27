import { memo, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronsLeft,
  ChevronsRight,
  CopyPlus,
  FilePlus2,
  FileWarning,
  RotateCcwSquare,
  RotateCwSquare,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';
import { plural } from '@/lib/format';
import {
  addBlankAfter,
  deletePage,
  duplicatePage,
  movePage,
  restorePages,
  rotatePage,
  shownSize,
  turned,
  type Layout,
  type OrganisedPage,
  type PageInfo,
  type Turn,
} from '@/lib/pdf-tools/organise';
import { Note } from './shared';
import type { Thumbnails } from './useThumbnails';

type PageAction = 'left' | 'right' | 'duplicate' | 'blank' | 'delete';

/** Width over height of every tile's frame, the same A-series shape the other page grids use. */
const FRAME = 1 / 1.414;

const TURN_WORDS: Record<Turn, string> = {
  0: 'the way it was',
  90: 'turned right',
  180: 'upside down',
  270: 'turned left',
};

function nameOf(page: OrganisedPage): string {
  return page.kind === 'blank' ? 'the blank page' : `page ${page.page}`;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function OrganiseGrid({
  layout,
  info,
  thumbs,
  active,
  disabled,
  onChange,
}: {
  layout: Layout;
  info: readonly PageInfo[];
  thumbs: Thumbnails;
  active: boolean;
  disabled: boolean;
  onChange: (update: (layout: Layout) => Layout) => void;
}) {
  const { pages, removed } = layout;
  const { urls, failed, error, request } = thumbs;
  const helpId = useId();
  const [liftedKey, setLiftedKey] = useState<string | null>(null);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);
  const [focusIndex, setFocusIndex] = useState(0);
  const [status, setStatus] = useState('');

  const rootRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLUListElement>(null);
  const tiles = useRef<Map<string, HTMLButtonElement>>(new Map());
  const refocus = useRef<string | null>(null);
  const dragging = useRef<string | null>(null);
  const observer = useRef<IntersectionObserver | null>(null);

  useEffect(() => {
    if (!active || typeof IntersectionObserver === 'undefined') return;
    const obs = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const page = Number((entry.target as HTMLElement).dataset.page);
          if (Number.isInteger(page)) request(page);
          obs.unobserve(entry.target);
        }
      },
      { root: scrollerRef.current, rootMargin: '400px 0px' },
    );
    observer.current = obs;
    return () => {
      obs.disconnect();
      observer.current = null;
    };
  }, [active, request]);

  // One observer for the whole grid, not one per tile: a document can run to hundreds of pages.
  useEffect(() => {
    if (!active) return;
    if (typeof IntersectionObserver === 'undefined') {
      for (const page of pages) if (page.kind === 'source') request(page.page);
      return;
    }
    const obs = observer.current;
    const root = scrollerRef.current;
    if (!obs || !root) return;
    for (const el of root.querySelectorAll<HTMLElement>('[data-pending="1"]')) obs.observe(el);
  }, [active, pages, urls, failed, request]);

  useEffect(() => {
    if (!active) return;
    for (const page of removed) request(page.page);
  }, [active, removed, request]);

  useEffect(() => {
    const key = refocus.current;
    if (!key) return;
    refocus.current = null;
    const focused = document.activeElement;
    if (focused && focused !== document.body && !rootRef.current?.contains(focused)) return;
    tiles.current.get(key)?.focus();
  });

  const indexOf = useCallback(
    (key: string | null) => (key === null ? -1 : pages.findIndex((page) => page.key === key)),
    [pages],
  );

  const moveTo = useCallback(
    (key: string, to: number) => {
      const from = indexOf(key);
      const target = Math.max(0, Math.min(pages.length - 1, to));
      if (from < 0 || from === target) return;
      refocus.current = key;
      setFocusIndex(target);
      onChange((current) => movePage(current, key, target));
      setStatus(`Moved ${nameOf(pages[from])} to position ${target + 1} of ${pages.length}.`);
    },
    [indexOf, pages, onChange],
  );

  const act = useCallback(
    (key: string, action: PageAction) => {
      const index = indexOf(key);
      if (index < 0) return;
      const page = pages[index];

      if (action === 'left' || action === 'right') {
        onChange((current) => rotatePage(current, key, action));
        const now = turned(page.turn, action);
        setStatus(`${capitalise(nameOf(page))} is ${now === 0 ? 'back' : 'now'} ${TURN_WORDS[now]}.`);
      } else if (action === 'duplicate') {
        onChange((current) => duplicatePage(current, key));
        setStatus(`Duplicated ${nameOf(page)}. The copy is at position ${index + 2}.`);
      } else if (action === 'blank') {
        onChange((current) => addBlankAfter(current, key, info));
        setStatus(`Added a blank page at position ${index + 2}.`);
      } else {
        const neighbour = pages[index + 1] ?? pages[index - 1];
        if (neighbour) refocus.current = neighbour.key;
        setLiftedKey((lifted) => (lifted === key ? null : lifted));
        setFocusIndex(Math.max(0, Math.min(index, pages.length - 2)));
        onChange((current) => deletePage(current, key));
        setStatus(`Deleted ${nameOf(page)}. ${plural(pages.length - 1, 'page')} left.`);
      }
    },
    [indexOf, pages, info, onChange],
  );

  const toggleLift = useCallback(
    (index: number) => {
      const page = pages[index];
      if (!page) return;
      if (liftedKey === page.key) {
        setLiftedKey(null);
        setStatus('Put down.');
        return;
      }
      if (liftedKey !== null && indexOf(liftedKey) >= 0) {
        moveTo(liftedKey, index);
        setLiftedKey(null);
        return;
      }
      setLiftedKey(page.key);
      setFocusIndex(index);
      setStatus(`Picked up ${nameOf(page)}, position ${index + 1} of ${pages.length}.`);
    },
    [pages, liftedKey, indexOf, moveTo],
  );

  const register = useCallback((key: string, el: HTMLButtonElement | null) => {
    if (el) tiles.current.set(key, el);
    else tiles.current.delete(key);
  }, []);

  const startDrag = useCallback((key: string, e: React.DragEvent<HTMLLIElement>) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', key);
    dragging.current = key;
    setDragKey(key);
  }, []);

  const dragOver = useCallback((key: string, e: React.DragEvent<HTMLLIElement>) => {
    // Only claim the drop for our own tiles, so a file dragged in from the desktop is left alone.
    if (!dragging.current) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setOverKey(key);
  }, []);

  const endDrag = useCallback(() => {
    dragging.current = null;
    setDragKey(null);
    setOverKey(null);
  }, []);

  const drop = useCallback(
    (key: string, e: React.DragEvent<HTMLLIElement>) => {
      const from = dragging.current;
      if (!from) return;
      e.preventDefault();
      e.stopPropagation();
      const to = indexOf(key);
      if (to >= 0 && from !== key) moveTo(from, to);
      endDrag();
    },
    [indexOf, moveTo, endDrag],
  );

  const restore = useCallback(
    (keys: string[]) => {
      if (keys.length === 0) return;
      refocus.current = keys[0];
      onChange((current) => restorePages(current, keys));
    },
    [onChange],
  );

  // Tiles are memoised, so they get stable handlers that call the latest closures.
  const handlers = useRef({ act, toggleLift, drop });
  useLayoutEffect(() => {
    handlers.current = { act, toggleLift, drop };
  });
  const onAction = useCallback(
    (key: string, action: PageAction) => handlers.current.act(key, action),
    [],
  );
  const onPick = useCallback((index: number) => handlers.current.toggleLift(index), []);
  const onDrop = useCallback(
    (key: string, e: React.DragEvent<HTMLLIElement>) => handlers.current.drop(key, e),
    [],
  );

  function columns(): number {
    const grid = gridRef.current;
    if (!grid) return 1;
    const template = getComputedStyle(grid).gridTemplateColumns;
    return Math.max(1, template.split(' ').filter(Boolean).length);
  }

  /** Read focus from the DOM: the focusIndex state lags a programmatic focus. */
  function focusedIndex(): number {
    const el = document.activeElement;
    for (const [key, node] of tiles.current) {
      if (node === el) return indexOf(key);
    }
    return Math.min(focusIndex, pages.length - 1);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLUListElement>) {
    if (disabled || pages.length === 0) return;
    // The page's own buttons handle their keys themselves.
    if (!(e.target instanceof HTMLElement) || e.target.dataset.tile === undefined) return;
    const lifted = liftedKey !== null && indexOf(liftedKey) >= 0 ? liftedKey : null;
    const current = lifted ? indexOf(lifted) : focusedIndex();
    if (current < 0) return;

    const go = (target: number) => {
      e.preventDefault();
      const clamped = Math.max(0, Math.min(pages.length - 1, target));
      if (clamped === current) return;
      if (lifted) {
        moveTo(lifted, clamped);
      } else {
        setFocusIndex(clamped);
        tiles.current.get(pages[clamped].key)?.focus();
      }
    };

    switch (e.key) {
      case 'ArrowLeft':
        return go(current - 1);
      case 'ArrowRight':
        return go(current + 1);
      case 'ArrowUp':
        return go(current - columns());
      case 'ArrowDown':
        return go(current + columns());
      case 'Home':
        return go(0);
      case 'End':
        return go(pages.length - 1);
      case 'Enter':
      case ' ':
        e.preventDefault();
        return toggleLift(current);
      case 'Escape':
        if (lifted) {
          e.preventDefault();
          setLiftedKey(null);
          setStatus('Put down.');
        }
        return;
      case 'Delete':
      case 'Backspace':
        e.preventDefault();
        return act(pages[current].key, 'delete');
      default:
    }
  }

  const liftedIndex = disabled ? -1 : indexOf(liftedKey);
  const lifted = liftedIndex >= 0 ? pages[liftedIndex] : null;
  const focusable = Math.min(focusIndex, pages.length - 1);
  const restoring = [...removed].sort((a, b) => a.page - b.page);

  return (
    <div ref={rootRef} className="bg-bg">
      <p id={helpId} className="sr-only">
        Press Enter to pick up a page, then the arrow keys to move it, and Enter or Escape to put it
        down. Press Delete to delete a page. While a page is picked up, buttons below the pages let
        you move, rotate, duplicate or delete it, or add a blank page after it.
      </p>
      <p aria-live="polite" className="sr-only">
        {status}
      </p>

      <div
        ref={scrollerRef}
        className="scroll-thin max-h-[32rem] overflow-y-auto overscroll-contain p-2 sm:max-h-[40rem] sm:p-3"
      >
        {pages.length === 0 ? (
          <Note>
            Every page has been deleted. Put some back below, or reset all changes.
          </Note>
        ) : (
          <ul
            ref={gridRef}
            role="group"
            aria-label="Pages in the new PDF"
            aria-describedby={helpId}
            onKeyDown={onKeyDown}
            className="grid grid-cols-3 gap-2 sm:gap-3 md:grid-cols-4 lg:grid-cols-6"
          >
            {pages.map((page, index) => (
              <Tile
                key={page.key}
                page={page}
                index={index}
                total={pages.length}
                info={info}
                url={page.kind === 'source' ? urls[page.page] : undefined}
                failed={page.kind === 'source' && (Boolean(failed[page.page]) || error !== null)}
                lifted={liftedKey === page.key}
                dragged={dragKey === page.key}
                over={overKey === page.key && dragKey !== page.key}
                focusable={index === focusable}
                disabled={disabled}
                onRegister={register}
                onFocusTile={setFocusIndex}
                onPick={onPick}
                onAction={onAction}
                onDragStart={startDrag}
                onDragOver={dragOver}
                onDrop={onDrop}
                onDragEnd={endDrag}
              />
            ))}
          </ul>
        )}
      </div>

      {lifted ? (
        <div className="sticky bottom-0 z-10 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line bg-surface px-2 py-2 sm:px-3">
          <span className="mr-auto min-w-0 truncate text-[13px] text-muted">
            {capitalise(nameOf(lifted))} &middot; position {liftedIndex + 1} of {pages.length}
          </span>
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              className="h-9 w-9 px-0"
              aria-label="Move to the start"
              title="Move to the start"
              aria-disabled={liftedIndex === 0}
              onClick={() => moveTo(lifted.key, 0)}
            >
              <ChevronsLeft className="h-4 w-4" aria-hidden />
            </Button>
            <Button
              size="sm"
              className="h-9 w-9 px-0"
              aria-label="Move earlier"
              title="Move earlier"
              aria-disabled={liftedIndex === 0}
              onClick={() => moveTo(lifted.key, liftedIndex - 1)}
            >
              <ArrowLeft className="h-4 w-4" aria-hidden />
            </Button>
            <Button
              size="sm"
              className="h-9 w-9 px-0"
              aria-label="Move later"
              title="Move later"
              aria-disabled={liftedIndex === pages.length - 1}
              onClick={() => moveTo(lifted.key, liftedIndex + 1)}
            >
              <ArrowRight className="h-4 w-4" aria-hidden />
            </Button>
            <Button
              size="sm"
              className="h-9 w-9 px-0"
              aria-label="Move to the end"
              title="Move to the end"
              aria-disabled={liftedIndex === pages.length - 1}
              onClick={() => moveTo(lifted.key, pages.length - 1)}
            >
              <ChevronsRight className="h-4 w-4" aria-hidden />
            </Button>
          </div>
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              className="h-9 w-9 px-0"
              aria-label="Rotate left"
              title="Rotate left"
              onClick={() => act(lifted.key, 'left')}
            >
              <RotateCcwSquare className="h-4 w-4" aria-hidden />
            </Button>
            <Button
              size="sm"
              className="h-9 w-9 px-0"
              aria-label="Rotate right"
              title="Rotate right"
              onClick={() => act(lifted.key, 'right')}
            >
              <RotateCwSquare className="h-4 w-4" aria-hidden />
            </Button>
            <Button
              size="sm"
              className="h-9 w-9 px-0"
              aria-label="Duplicate"
              title="Duplicate"
              onClick={() => act(lifted.key, 'duplicate')}
            >
              <CopyPlus className="h-4 w-4" aria-hidden />
            </Button>
            <Button
              size="sm"
              className="h-9 w-9 px-0"
              aria-label="Add a blank page after it"
              title="Add a blank page after it"
              onClick={() => act(lifted.key, 'blank')}
            >
              <FilePlus2 className="h-4 w-4" aria-hidden />
            </Button>
            <Button
              size="sm"
              className="h-9 w-9 px-0 hover:text-danger"
              aria-label="Delete"
              title="Delete"
              onClick={() => act(lifted.key, 'delete')}
            >
              <Trash2 className="h-4 w-4" aria-hidden />
            </Button>
          </div>
          <Button size="sm" className="h-9" onClick={() => setLiftedKey(null)}>
            <Check className="h-4 w-4" aria-hidden />
            Done
          </Button>
        </div>
      ) : null}

      {restoring.length > 0 ? (
        <div className="border-t border-line p-2 sm:p-3">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2 px-1">
            <h3 className="text-[11px] font-medium uppercase tracking-wide text-faint">
              Deleted ({restoring.length})
            </h3>
            <Button
              size="sm"
              disabled={disabled}
              onClick={() => {
                restore(restoring.map((page) => page.key));
                setStatus(`Put ${plural(restoring.length, 'page')} back.`);
              }}
            >
              <Undo2 className="h-3.5 w-3.5" aria-hidden />
              Put all back
            </Button>
          </div>
          <ul className="grid grid-cols-4 gap-2 sm:grid-cols-6 sm:gap-3 lg:grid-cols-8">
            {restoring.map((page) => (
              <li key={page.key} className="min-w-0">
                <button
                  type="button"
                  disabled={disabled}
                  aria-label={`Put page ${page.page} back`}
                  title={`Put page ${page.page} back`}
                  onClick={() => {
                    restore([page.key]);
                    setStatus(`Put page ${page.page} back.`);
                  }}
                  className="group block w-full rounded-lg text-left opacity-50 transition-opacity hover:opacity-100 focus-visible:opacity-100 disabled:cursor-not-allowed"
                >
                  <span className="relative block">
                    <Sheet
                      page={page}
                      info={info}
                      url={urls[page.page]}
                      failed={Boolean(failed[page.page]) || error !== null}
                      lifted={false}
                    />
                    <span className="absolute inset-0 flex items-center justify-center">
                      <span className="flex h-6 w-6 items-center justify-center rounded-md bg-ink/70 text-bg group-hover:bg-accent group-hover:text-accent-ink">
                        <X className="h-3.5 w-3.5 [@media(hover:hover)]:group-hover:hidden" aria-hidden />
                        <Undo2
                          className="hidden h-3.5 w-3.5 [@media(hover:hover)]:group-hover:block"
                          aria-hidden
                        />
                      </span>
                    </span>
                  </span>
                  <span className="mt-1 block text-center text-[11px] text-faint">p{page.page}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

const Tile = memo(function Tile({
  page,
  index,
  total,
  info,
  url,
  failed,
  lifted,
  dragged,
  over,
  focusable,
  disabled,
  onRegister,
  onFocusTile,
  onPick,
  onAction,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  page: OrganisedPage;
  index: number;
  total: number;
  info: readonly PageInfo[];
  url: string | undefined;
  failed: boolean;
  lifted: boolean;
  dragged: boolean;
  over: boolean;
  focusable: boolean;
  disabled: boolean;
  onRegister: (key: string, el: HTMLButtonElement | null) => void;
  onFocusTile: (index: number) => void;
  onPick: (index: number) => void;
  onAction: (key: string, action: PageAction) => void;
  onDragStart: (key: string, e: React.DragEvent<HTMLLIElement>) => void;
  onDragOver: (key: string, e: React.DragEvent<HTMLLIElement>) => void;
  onDrop: (key: string, e: React.DragEvent<HTMLLIElement>) => void;
  onDragEnd: () => void;
}) {
  const name = nameOf(page);
  const label =
    `Position ${index + 1} of ${total}, ${page.kind === 'blank' ? 'blank page' : name}` +
    (page.turn === 0 ? '' : `, ${TURN_WORDS[page.turn]}`);

  return (
    <li
      draggable={!disabled}
      onDragStart={(e) => onDragStart(page.key, e)}
      onDragOver={(e) => onDragOver(page.key, e)}
      onDrop={(e) => onDrop(page.key, e)}
      onDragEnd={onDragEnd}
      className={cn(
        'group relative min-w-0 rounded-lg p-1 transition-colors',
        dragged && 'opacity-40',
        over && 'bg-accent-soft',
      )}
    >
      <button
        type="button"
        ref={(el) => onRegister(page.key, el)}
        data-tile=""
        disabled={disabled}
        aria-pressed={lifted}
        aria-roledescription="Sortable page"
        aria-label={label}
        tabIndex={focusable ? 0 : -1}
        onFocus={() => onFocusTile(index)}
        onClick={() => onPick(index)}
        className="block w-full cursor-grab rounded-lg text-left active:cursor-grabbing disabled:cursor-not-allowed"
      >
        <Sheet page={page} info={info} url={url} failed={failed} lifted={lifted} />
        <span className="mt-1 flex items-center justify-center gap-1 text-[11px]">
          <span
            className={cn('font-mono tabular-nums', lifted ? 'font-medium text-accent' : 'text-ink')}
          >
            {index + 1}
          </span>
          <span className="text-faint">{page.kind === 'blank' ? 'blank' : `p${page.page}`}</span>
        </span>
      </button>

      {disabled ? null : (
        // Hover only with a real pointer: iOS treats a first tap that reveals content as a hover.
        <div className="pointer-events-none invisible absolute inset-x-1 top-2 hidden justify-center group-has-[:focus-visible]:visible sm:flex [@media(hover:hover)]:group-hover:visible">
          <div className="pointer-events-auto flex items-center gap-0.5 rounded-lg border border-line bg-surface/95 p-0.5 shadow-card">
            <ToolButton label={`Rotate ${name} left`} onClick={() => onAction(page.key, 'left')}>
              <RotateCcwSquare className="h-3.5 w-3.5" aria-hidden />
            </ToolButton>
            <ToolButton label={`Rotate ${name} right`} onClick={() => onAction(page.key, 'right')}>
              <RotateCwSquare className="h-3.5 w-3.5" aria-hidden />
            </ToolButton>
            <ToolButton label={`Duplicate ${name}`} onClick={() => onAction(page.key, 'duplicate')}>
              <CopyPlus className="h-3.5 w-3.5" aria-hidden />
            </ToolButton>
            <ToolButton
              label={`Add a blank page after ${name}`}
              onClick={() => onAction(page.key, 'blank')}
            >
              <FilePlus2 className="h-3.5 w-3.5" aria-hidden />
            </ToolButton>
            <ToolButton
              label={`Delete ${name}`}
              className="hover:text-danger"
              onClick={() => onAction(page.key, 'delete')}
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden />
            </ToolButton>
          </div>
        </div>
      )}
    </li>
  );
});

function ToolButton({
  label,
  className,
  onClick,
  children,
}: {
  label: string;
  className?: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        'flex h-6 w-6 items-center justify-center rounded-md text-muted transition-colors hover:bg-line/50 hover:text-ink',
        className,
      )}
    >
      {children}
    </button>
  );
}

function Sheet({
  page,
  info,
  url,
  failed,
  lifted,
}: {
  page: OrganisedPage;
  info: readonly PageInfo[];
  url: string | undefined;
  failed: boolean;
  lifted: boolean;
}) {
  const { width, height } = shownSize(page, info);
  const ratio = width / height;
  const sideways = page.turn === 90 || page.turn === 270;
  const box =
    ratio <= FRAME
      ? { width: `${(ratio / FRAME) * 100}%`, height: '100%' }
      : { width: '100%', height: `${(FRAME / ratio) * 100}%` };

  return (
    <span className="relative block aspect-[1/1.414] w-full">
      <span
        data-page={page.kind === 'source' ? page.page : undefined}
        data-pending={page.kind === 'source' && !url && !failed ? '1' : '0'}
        style={box}
        className={cn(
          'absolute left-1/2 top-1/2 block -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-md border transition-colors',
          // Paper is white in both themes, as it is in the rendered previews.
          page.kind === 'blank' ? 'bg-white' : 'bg-surface',
          lifted ? 'border-accent ring-2 ring-accent' : 'border-line',
        )}
      >
        {page.kind === 'blank' ? null : url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={url}
            alt=""
            aria-hidden
            draggable={false}
            loading="lazy"
            decoding="async"
            className="absolute left-1/2 top-1/2 max-w-none object-contain"
            style={{
              // Turned sideways, the preview is laid out with the box's sides swapped, then rotated to fill it.
              width: sideways ? `${100 / ratio}%` : '100%',
              height: sideways ? `${ratio * 100}%` : '100%',
              transform: `translate(-50%, -50%) rotate(${page.turn}deg)`,
            }}
          />
        ) : failed ? (
          <span className="flex h-full w-full items-center justify-center">
            <FileWarning className="h-4 w-4 text-faint" aria-hidden />
          </span>
        ) : (
          <span className="block h-full w-full animate-pulse bg-line/60" aria-hidden />
        )}
      </span>
    </span>
  );
}
