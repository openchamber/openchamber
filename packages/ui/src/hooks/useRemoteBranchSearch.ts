import * as React from 'react';

import { useDebouncedValue } from './useDebouncedValue';

const REMOTE_SEARCH_DEBOUNCE_MS = 200;

export function useRemoteBranchSearch({
  enabled,
  query,
  search,
}: {
  enabled: boolean;
  query: string;
  search?: (query: string) => Promise<string[]>;
}) {
  const normalizedQuery = query.trim().toLowerCase();
  const debouncedQuery = useDebouncedValue(normalizedQuery, REMOTE_SEARCH_DEBOUNCE_MS);
  const [result, setResult] = React.useState<{ query: string; branches: string[] } | null>(null);
  const [inFlight, setInFlight] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const cacheRef = React.useRef(new Map<string, string[]>());
  const generationRef = React.useRef(0);

  React.useEffect(() => {
    cacheRef.current.clear();
    setResult(null);
    setInFlight(false);
    setFailed(false);
  }, [search]);

  React.useEffect(() => {
    if (!enabled || !search || !debouncedQuery) {
      setInFlight(false);
      return;
    }
    setFailed(false);
    const cached = cacheRef.current.get(debouncedQuery);
    if (cached) {
      setResult({ query: debouncedQuery, branches: cached });
      setInFlight(false);
      return;
    }
    const generation = ++generationRef.current;
    let cancelled = false;
    setInFlight(true);
    void search(debouncedQuery)
      .then((branches) => {
        if (cancelled || generation !== generationRef.current) return;
        cacheRef.current.set(debouncedQuery, branches);
        setResult({ query: debouncedQuery, branches });
      })
      .catch(() => {
        if (!cancelled && generation === generationRef.current) setFailed(true);
      })
      .finally(() => {
        if (!cancelled && generation === generationRef.current) setInFlight(false);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, search, debouncedQuery]);

  const reset = React.useCallback(() => {
    cacheRef.current.clear();
    setResult(null);
    setInFlight(false);
    setFailed(false);
  }, []);

  return {
    matches: result?.query === normalizedQuery ? result.branches : [],
    isSearching: enabled && normalizedQuery.length > 0 && (inFlight || debouncedQuery !== normalizedQuery),
    failed: enabled && failed,
    reset,
  };
}
