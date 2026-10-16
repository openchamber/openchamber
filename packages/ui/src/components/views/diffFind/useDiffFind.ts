import type { FileDiffMetadata } from '@pierre/diffs';
import React from 'react';

import { findMatchesInFileDiff, type DiffFindMatch } from '@/lib/diff/diffFind';
import { hideWhitespaceChanges } from '@/lib/diff/hideWhitespaceChanges';

export type DiffFindLayout = 'inline' | 'side-by-side';

/** A match the bar can be opened directly onto, in the changeset's own terms. */
export interface DiffFindAnchor {
  filePath: string;
  lineNumber: number;
  spanStart: number;
}

/**
 * One searchable file. The owner supplies the parsed diff lazily: the hook
 * calls `load` only while the bar is open and only for files it has not
 * resolved at the current `revision`, so a closed bar costs nothing.
 */
export interface DiffFindSource {
  /** Stable identity within the changeset; matches carry it back. */
  filePath: string;
  /** The layout this file currently renders with; a change re-runs matching. */
  layout: DiffFindLayout;
  /**
   * Identity of the parsed diff itself. Moving it makes the hook re-read the
   * file; a layout change alone must not, since layout only affects matching.
   */
  revision?: string;
  /** Resolve the parsed diff, or null when the file has nothing to search. */
  load: () => Promise<FileDiffMetadata | null>;
}

export interface UseDiffFindResult {
  isOpen: boolean;
  open: () => void;
  close: () => void;
  query: string;
  setQuery: (query: string) => void;
  /** Every match across the changeset, in file order then reading order. */
  matches: DiffFindMatch[];
  /** Zero-based index into `matches`, or 0 when there is none. */
  currentIndex: number;
  currentMatch: DiffFindMatch | null;
  /** True while files are still being read, so `matches` may keep growing. */
  isSearching: boolean;
  next: () => void;
  previous: () => void;
  /**
   * Open the bar on `query`, landing on the match *after* `anchor`'s own match
   * (wrapping, like `next`). The anchor's file may still be loading: the intent
   * is held until its match appears, and falls back to the first match once the
   * changeset settles without it. With no anchor this is "open, set query,
   * first match". Unlike `setQuery` it does not reset an anchor jump to 0.
   */
  openWithQuery: (query: string, anchor?: DiffFindAnchor) => void;
}

/**
 * The diff a viewer actually renders: whitespace-only changes hidden when the
 * panel is in that mode. Searching the rendered diff keeps the count equal to
 * what is on screen, so "next" can always scroll to a line that exists.
 */
export const resolveFindDiff = (
  fileDiff: FileDiffMetadata | null,
  hideWhitespace: boolean,
): FileDiffMetadata | null => (fileDiff && hideWhitespace ? hideWhitespaceChanges(fileDiff) : fileDiff);

type LoadedEntry = { value: FileDiffMetadata | null; revision: string | undefined };

/**
 * Search state for a changeset of parsed diffs. It owns the query, the match
 * list and the active index; the owner renders the bar and moves the viewer.
 *
 * Files resolve one at a time — a large changeset must not fire every host read
 * at once — and at most once per revision, so opening the bar fills in
 * progressively (`isSearching`) without re-reading what is already known.
 * Closing stops starting new reads and keeps the resolved diffs, so reopening
 * is instant. Walkthrough reuses it by passing its own file set and per-file
 * `load`; `sources` should be memoized so its identity only moves with the file
 * list, a layout change, or a data revision.
 */
export const useDiffFind = (
  { sources, caseSensitive = false }: { sources: readonly DiffFindSource[]; caseSensitive?: boolean },
): UseDiffFindResult => {
  const [isOpen, setIsOpen] = React.useState(false);
  const [query, setQueryState] = React.useState('');
  const [currentIndex, setCurrentIndex] = React.useState(0);
  // The resolved diffs live in state so consumers re-render on each landing;
  // the pump also keeps the same map in a ref so it can read its own progress
  // without waiting for a render.
  const [loaded, setLoaded] = React.useState<ReadonlyMap<string, LoadedEntry>>(() => new Map());
  const loadedRef = React.useRef(loaded);

  const sourcesRef = React.useRef(sources);
  sourcesRef.current = sources;
  const isOpenRef = React.useRef(isOpen);
  isOpenRef.current = isOpen;
  const pumpingRef = React.useRef(false);
  // A pending "open on this anchor" intent: the anchor's match may not exist in
  // `matches` yet because its file is still being read. Held until the match
  // appears, the changeset settles without it, or the intent is invalidated.
  const pendingAnchorRef = React.useRef<(DiffFindAnchor & { query: string }) | null>(null);

  const pump = React.useCallback(async () => {
    if (pumpingRef.current) return;
    pumpingRef.current = true;
    try {
      for (;;) {
        if (!isOpenRef.current) return;
        const next = sourcesRef.current.find((source) => {
          const entry = loadedRef.current.get(source.filePath);
          return entry === undefined || entry.revision !== source.revision;
        });
        if (!next) return;
        let value: FileDiffMetadata | null = null;
        try {
          value = await next.load();
        } catch {
          value = null;
        }
        const settled = new Map(loadedRef.current).set(next.filePath, { value, revision: next.revision });
        loadedRef.current = settled;
        setLoaded(settled);
      }
    } finally {
      pumpingRef.current = false;
    }
  }, []);

  React.useEffect(() => {
    if (!isOpen) return;
    void pump();
  }, [isOpen, pump, sources]);

  const matches = React.useMemo<DiffFindMatch[]>(() => {
    if (!isOpen) return [];
    const needle = query.trim();
    if (needle.length === 0) return [];
    const found: DiffFindMatch[] = [];
    for (const source of sources) {
      const value = loaded.get(source.filePath)?.value;
      if (!value) continue;
      found.push(...findMatchesInFileDiff(value, source.filePath, needle, { caseSensitive, layout: source.layout }));
    }
    return found;
  }, [caseSensitive, isOpen, loaded, query, sources]);

  const matchesRef = React.useRef(matches);
  matchesRef.current = matches;

  React.useEffect(() => {
    setCurrentIndex((index) => (matches.length === 0 ? 0 : Math.min(index, matches.length - 1)));
  }, [matches.length]);

  const setQuery = React.useCallback((next: string) => {
    // A user edit supersedes any anchor jump still waiting on its file.
    pendingAnchorRef.current = null;
    setQueryState(next);
    setCurrentIndex(0);
  }, []);

  const open = React.useCallback(() => {
    pendingAnchorRef.current = null;
    setIsOpen(true);
  }, []);
  const close = React.useCallback(() => {
    pendingAnchorRef.current = null;
    setIsOpen(false);
  }, []);

  const openWithQuery = React.useCallback((next: string, anchor?: DiffFindAnchor) => {
    setQueryState(next);
    setIsOpen(true);
    if (anchor) {
      pendingAnchorRef.current = { ...anchor, query: next };
      return;
    }
    pendingAnchorRef.current = null;
    setCurrentIndex(0);
  }, []);

  const isSearching = isOpen && sources.some((source) => {
    const entry = loaded.get(source.filePath);
    return entry === undefined || entry.revision !== source.revision;
  });

  // Resolve a pending anchor jump once its match exists, or give up and show the
  // first match when the search has settled without it. A close, a reopen, or a
  // user edit leaves `pendingAnchorRef` null, so no stale jump survives.
  React.useEffect(() => {
    const pending = pendingAnchorRef.current;
    if (!pending) return;
    if (!isOpen || pending.query !== query) {
      pendingAnchorRef.current = null;
      return;
    }
    const anchorIndex = matches.findIndex((match) =>
      match.filePath === pending.filePath && match.lineNumber === pending.lineNumber && match.spanStart === pending.spanStart);
    if (anchorIndex >= 0) {
      pendingAnchorRef.current = null;
      setCurrentIndex(matches.length === 0 ? 0 : (anchorIndex + 1) % matches.length);
      return;
    }
    if (!isSearching) {
      pendingAnchorRef.current = null;
      setCurrentIndex(0);
    }
  }, [isOpen, isSearching, matches, query]);

  const next = React.useCallback(() => {
    setCurrentIndex((index) => {
      const total = matchesRef.current.length;
      return total === 0 ? 0 : (index + 1) % total;
    });
  }, []);

  const previous = React.useCallback(() => {
    setCurrentIndex((index) => {
      const total = matchesRef.current.length;
      return total === 0 ? 0 : (index - 1 + total) % total;
    });
  }, []);

  return {
    isOpen,
    open,
    close,
    query,
    setQuery,
    matches,
    currentIndex,
    currentMatch: matches[currentIndex] ?? null,
    isSearching,
    next,
    previous,
    openWithQuery,
  };
};
