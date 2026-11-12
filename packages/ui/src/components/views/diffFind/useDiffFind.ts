import type { FileDiffMetadata } from '@pierre/diffs';
import React from 'react';

import { findMatchesInFileDiff, type DiffFindMatch, type DiffFindSide } from '@/lib/diff/diffFind';
import { hideWhitespaceChanges } from '@/lib/diff/hideWhitespaceChanges';

export type DiffFindLayout = 'inline' | 'side-by-side';

/** Typing settles this long before the changeset is matched again. */
export const DIFF_FIND_QUERY_DEBOUNCE_MS = 120;

/** A match the bar can be opened directly onto, in the changeset's own terms. */
export interface DiffFindAnchor {
  filePath: string;
  side: DiffFindSide;
  lineNumber: number;
  spanStart: number;
}

/**
 * What a source resolves to when it turns out to hold files of its own (a
 * nested repository's row): those files are searched in its place, each read
 * through its own `load`.
 */
export interface DiffFindNestedSources {
  nestedSources: readonly DiffFindSource[];
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
  /**
   * Resolve the parsed diff, null when the file has nothing to search, or the
   * files to search in its place. A rejection marks the file as not searched.
   */
  load: () => Promise<FileDiffMetadata | DiffFindNestedSources | null>;
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
  /** Files whose read failed while the bar is open; reopening retries them. */
  failedCount: number;
  next: () => void;
  previous: () => void;
  /**
   * Open the bar on `query`, landing on the match *after* `anchor`'s own match
   * (wrapping, like `next`). The anchor's file may still be loading: the intent
   * is held until its match appears, and falls back to the first match once the
   * changeset settles without it. With no anchor this is "open, set query,
   * first match". Unlike `setQuery` it applies at once and does not reset an
   * anchor jump to 0.
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

/** Whether two matches (or a match and an anchor) point at the same occurrence. */
// A closed bar or an empty query has one shared empty list, so new sources
// while nothing is searched never look like new matches: the index sync below
// updates state during render, and a fresh array there would re-render forever.
const NO_MATCHES: DiffFindMatch[] = [];

const isSameMatch = (a: DiffFindAnchor, b: DiffFindAnchor): boolean =>
  a.filePath === b.filePath && a.side === b.side && a.lineNumber === b.lineNumber && a.spanStart === b.spanStart;

type LoadedEntry = {
  revision: string | undefined;
  diff: FileDiffMetadata | null;
  nestedSources: readonly DiffFindSource[] | null;
};

const isResolved = (loaded: ReadonlyMap<string, LoadedEntry>, source: DiffFindSource): boolean => {
  const entry = loaded.get(source.filePath);
  return entry !== undefined && entry.revision === source.revision;
};

const hasFailed = (failed: ReadonlyMap<string, string | undefined>, source: DiffFindSource): boolean =>
  failed.has(source.filePath) && failed.get(source.filePath) === source.revision;

/**
 * The files actually searched: a source resolved to nested sources is replaced
 * by them, in place, so matches keep the changeset's reading order.
 */
const expandSources = (
  sources: readonly DiffFindSource[],
  loaded: ReadonlyMap<string, LoadedEntry>,
): DiffFindSource[] => {
  const expanded: DiffFindSource[] = [];
  const visit = (list: readonly DiffFindSource[]) => {
    for (const source of list) {
      const entry = loaded.get(source.filePath);
      if (entry?.nestedSources && entry.revision === source.revision) visit(entry.nestedSources);
      else expanded.push(source);
    }
  };
  visit(sources);
  return expanded;
};

/**
 * Search state for a changeset of parsed diffs. It owns the query, the match
 * list and the active index; the owner renders the bar and moves the viewer.
 *
 * Files resolve one at a time (a large changeset must not fire every host read
 * at once) and at most once per revision, so opening the bar fills in
 * progressively (`isSearching`) without re-reading what is already known.
 * A failed read is kept apart from the resolved diffs: it is counted in
 * `failedCount` and retried the next time the bar opens. Closing stops starting
 * new reads and keeps the resolved diffs, so reopening is instant. Walkthrough
 * reuses it by passing its own file set and per-file `load`; `sources` should
 * be memoized so its identity only moves with the file list, a layout change,
 * or a data revision.
 */
export const useDiffFind = (
  { sources, caseSensitive = false }: { sources: readonly DiffFindSource[]; caseSensitive?: boolean },
): UseDiffFindResult => {
  const [isOpen, setIsOpen] = React.useState(false);
  const [query, setQueryState] = React.useState('');
  // The query matching runs on: `query` once typing has paused.
  const [appliedQuery, setAppliedQuery] = React.useState('');
  const [currentIndex, setCurrentIndex] = React.useState(0);
  // The resolved diffs live in state so consumers re-render on each landing;
  // the pump also keeps the same map in a ref so it can read its own progress
  // without waiting for a render. Failures are kept the same way.
  const [loaded, setLoaded] = React.useState<ReadonlyMap<string, LoadedEntry>>(() => new Map());
  const loadedRef = React.useRef(loaded);
  const [failed, setFailed] = React.useState<ReadonlyMap<string, string | undefined>>(() => new Map());
  const failedRef = React.useRef(failed);

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
        const next = expandSources(sourcesRef.current, loadedRef.current)
          .find((source) => !isResolved(loadedRef.current, source) && !hasFailed(failedRef.current, source));
        if (!next) return;
        let value: FileDiffMetadata | DiffFindNestedSources | null;
        try {
          value = await next.load();
        } catch {
          const nextFailed = new Map(failedRef.current).set(next.filePath, next.revision);
          failedRef.current = nextFailed;
          setFailed(nextFailed);
          continue;
        }
        const entry: LoadedEntry = value !== null && 'nestedSources' in value
          ? { revision: next.revision, diff: null, nestedSources: value.nestedSources }
          : { revision: next.revision, diff: value, nestedSources: null };
        const settled = new Map(loadedRef.current).set(next.filePath, entry);
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

  React.useEffect(() => {
    if (query === appliedQuery) return;
    const timer = window.setTimeout(() => {
      setAppliedQuery(query);
      setCurrentIndex(0);
    }, DIFF_FIND_QUERY_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [appliedQuery, query]);

  const searched = React.useMemo(() => expandSources(sources, loaded), [loaded, sources]);

  const matches = React.useMemo<DiffFindMatch[]>(() => {
    if (!isOpen) return NO_MATCHES;
    const needle = appliedQuery.trim();
    if (needle.length === 0) return NO_MATCHES;
    const found: DiffFindMatch[] = [];
    for (const source of searched) {
      const diff = loaded.get(source.filePath)?.diff;
      if (!diff) continue;
      found.push(...findMatchesInFileDiff(diff, source.filePath, needle, { caseSensitive, layout: source.layout }));
    }
    return found;
  }, [appliedQuery, caseSensitive, isOpen, loaded, searched]);

  const matchesRef = React.useRef(matches);
  matchesRef.current = matches;

  // A file landing, re-read or resolving to nested files rebuilds the list
  // under the same query: the active match keeps pointing at what it pointed
  // at, so the view does not jump to whatever now sits at its index. A new
  // query starts over (its apply set the index already).
  const [indexedMatches, setIndexedMatches] = React.useState({ matches, query: appliedQuery });
  if (indexedMatches.matches !== matches) {
    const previous = indexedMatches.query === appliedQuery ? indexedMatches.matches[currentIndex] : undefined;
    const kept = previous ? matches.findIndex((match) => isSameMatch(match, previous)) : -1;
    const nextIndex = kept >= 0 ? kept : matches.length === 0 ? 0 : Math.min(currentIndex, matches.length - 1);
    setIndexedMatches({ matches, query: appliedQuery });
    if (nextIndex !== currentIndex) setCurrentIndex(nextIndex);
  }

  const setQuery = React.useCallback((next: string) => {
    // A user edit supersedes any anchor jump still waiting on its file.
    pendingAnchorRef.current = null;
    setQueryState(next);
  }, []);

  const openBar = React.useCallback(() => {
    // Opening again retries what failed last time.
    if (!isOpenRef.current && failedRef.current.size > 0) {
      const cleared = new Map<string, string | undefined>();
      failedRef.current = cleared;
      setFailed(cleared);
    }
    setIsOpen(true);
  }, []);

  const open = React.useCallback(() => {
    pendingAnchorRef.current = null;
    openBar();
  }, [openBar]);
  const close = React.useCallback(() => {
    pendingAnchorRef.current = null;
    setIsOpen(false);
  }, []);

  const openWithQuery = React.useCallback((next: string, anchor?: DiffFindAnchor) => {
    setQueryState(next);
    setAppliedQuery(next);
    openBar();
    if (anchor) {
      pendingAnchorRef.current = { ...anchor, query: next };
      return;
    }
    pendingAnchorRef.current = null;
    setCurrentIndex(0);
  }, [openBar]);

  const isSearching = isOpen && searched.some((source) => !isResolved(loaded, source) && !hasFailed(failed, source));
  const failedCount = isOpen ? searched.filter((source) => hasFailed(failed, source)).length : 0;

  // Resolve a pending anchor jump once its match exists, or give up and show the
  // first match when the search has settled without it. A close, a reopen, or a
  // user edit leaves `pendingAnchorRef` null, so no stale jump survives.
  React.useEffect(() => {
    const pending = pendingAnchorRef.current;
    if (!pending) return;
    if (!isOpen || pending.query !== appliedQuery) {
      pendingAnchorRef.current = null;
      return;
    }
    const anchorIndex = matches.findIndex((match) => isSameMatch(match, pending));
    if (anchorIndex >= 0) {
      pendingAnchorRef.current = null;
      setCurrentIndex(matches.length === 0 ? 0 : (anchorIndex + 1) % matches.length);
      return;
    }
    if (!isSearching) {
      pendingAnchorRef.current = null;
      setCurrentIndex(0);
    }
  }, [appliedQuery, isOpen, isSearching, matches]);

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
    failedCount,
    next,
    previous,
    openWithQuery,
  };
};
