import type { FileDiffMetadata } from '@pierre/diffs';
import React from 'react';

import { findMatchesInFileDiff, type DiffFindMatch, type DiffFindSide } from '@/lib/diff/diffFind';
import { hideWhitespaceChanges } from '@/lib/diff/hideWhitespaceChanges';

export type DiffFindLayout = 'inline' | 'side-by-side';

export const DIFF_FIND_QUERY_DEBOUNCE_MS = 120;

export interface DiffFindAnchor {
  filePath: string;
  side: DiffFindSide;
  lineNumber: number;
  spanStart: number;
}

export interface DiffFindNestedSources {
  nestedSources: readonly DiffFindSource[];
}

export interface DiffFindSource {
  filePath: string;
  layout: DiffFindLayout;
  revision?: string;
  load: () => Promise<FileDiffMetadata | DiffFindNestedSources | null>;
}

export interface UseDiffFindResult {
  isOpen: boolean;
  open: () => void;
  close: () => void;
  query: string;
  setQuery: (query: string) => void;
  matches: DiffFindMatch[];
  currentIndex: number;
  currentMatch: DiffFindMatch | null;
  isSearching: boolean;
  failedCount: number;
  next: () => void;
  previous: () => void;
  openWithQuery: (query: string, anchor?: DiffFindAnchor) => void;
}

export const resolveFindDiff = (
  fileDiff: FileDiffMetadata | null,
  hideWhitespace: boolean,
): FileDiffMetadata | null => (fileDiff && hideWhitespace ? hideWhitespaceChanges(fileDiff) : fileDiff);

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

export const useDiffFind = (
  { sources, caseSensitive = false }: { sources: readonly DiffFindSource[]; caseSensitive?: boolean },
): UseDiffFindResult => {
  const [isOpen, setIsOpen] = React.useState(false);
  const [query, setQueryState] = React.useState('');
  const [appliedQuery, setAppliedQuery] = React.useState('');
  const [currentIndex, setCurrentIndex] = React.useState(0);
  const [loaded, setLoaded] = React.useState<ReadonlyMap<string, LoadedEntry>>(() => new Map());
  const loadedRef = React.useRef(loaded);
  const [failed, setFailed] = React.useState<ReadonlyMap<string, string | undefined>>(() => new Map());
  const failedRef = React.useRef(failed);

  const sourcesRef = React.useRef(sources);
  sourcesRef.current = sources;
  const isOpenRef = React.useRef(isOpen);
  isOpenRef.current = isOpen;
  const pumpingRef = React.useRef(false);
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

  const [indexedMatches, setIndexedMatches] = React.useState({ matches, query: appliedQuery });
  if (indexedMatches.matches !== matches) {
    const previous = indexedMatches.query === appliedQuery ? indexedMatches.matches[currentIndex] : undefined;
    const kept = previous ? matches.findIndex((match) => isSameMatch(match, previous)) : -1;
    const nextIndex = kept >= 0 ? kept : matches.length === 0 ? 0 : Math.min(currentIndex, matches.length - 1);
    setIndexedMatches({ matches, query: appliedQuery });
    if (nextIndex !== currentIndex) setCurrentIndex(nextIndex);
  }

  const setQuery = React.useCallback((next: string) => {
    pendingAnchorRef.current = null;
    setQueryState(next);
  }, []);

  const openBar = React.useCallback(() => {
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
