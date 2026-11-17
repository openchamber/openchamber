import React from 'react';


export const isBranchScopeAvailable = (
  currentBranch: string | null,
  base: string | null
): boolean => Boolean(currentBranch) && base !== null;

export const isBranchScopeDefinitelyUnavailable = (
  currentBranch: string | null,
  base: string | null,
  isBranchStatusResolved: boolean,
  isBaseResolved: boolean
): boolean => {
  if (!isBranchStatusResolved) return false;
  if (currentBranch === null) return true;
  return isBaseResolved && base === null;
};

export const coerceDiffScope = <T extends string>(
  scope: T,
  branchScopeAvailable: boolean
): T | 'working' => (scope === 'branch' && !branchScopeAvailable ? 'working' : scope);

export const useBoundedDirectoryRetry = (
  directory: string | null,
  isEnabled: boolean,
  isRequestInFlight: boolean,
  hasResult: boolean,
  startRequest: () => void,
  maxAttempts: number
): boolean => {
  const attemptsRef = React.useRef<{ directory: string; attempts: number }>({ directory: '', attempts: 0 });
  const [exhaustedState, setExhaustedState] = React.useState<{ directory: string; exhausted: boolean }>(
    () => ({ directory: '', exhausted: false })
  );
  const startRequestRef = React.useRef(startRequest);
  startRequestRef.current = startRequest;

  const exhausted = Boolean(directory) && exhaustedState.directory === directory && exhaustedState.exhausted;

  React.useEffect(() => {
    if (!directory || !isEnabled || hasResult || isRequestInFlight) {
      return;
    }
    const attempts = attemptsRef.current.directory === directory ? attemptsRef.current.attempts : 0;
    if (attempts >= maxAttempts) {
      if (!(exhaustedState.directory === directory && exhaustedState.exhausted)) {
        setExhaustedState({ directory, exhausted: true });
      }
      return;
    }
    attemptsRef.current = { directory, attempts: attempts + 1 };
    startRequestRef.current();
  }, [directory, exhaustedState, hasResult, isEnabled, isRequestInFlight, maxAttempts]);

  return exhausted;
};

export const branchPathRevisions = (
  files: ReadonlyArray<{ path: string; revision?: string }> | null,
  statusRevision: string
): ReadonlyMap<string, string> => new Map((files ?? []).map((file) => [file.path, file.revision ?? `status:${statusRevision}`]));

export const useRangeKeyedCache = <T>(
  rangeKey: string | null,
  pathsKey: string,
  fetchEntry: ((path: string) => Promise<T>) | null,
  placeholder: T,
  revision = '',
  pathRevisions?: ReadonlyMap<string, string>
): ReadonlyMap<string, T> => {
  const [entries, setEntries] = React.useState<Map<string, T>>(() => new Map());
  const entriesRef = React.useRef(entries);
  entriesRef.current = entries;
  const completedRevisions = React.useRef(new Map<string, string>());
  const entriesRangeKey = React.useRef<string | null>(null);
  const hiddenEntries = React.useRef<ReadonlyMap<string, T>>(new Map());

  const fetchEntryRef = React.useRef(fetchEntry);
  fetchEntryRef.current = fetchEntry;

  const writeEntry = React.useCallback((path: string, value: T | null) => {
    const next = new Map(entriesRef.current);
    if (value === null) {
      if (!next.delete(path)) return;
    } else {
      next.set(path, value);
    }
    entriesRef.current = next;
    setEntries(next);
  }, []);

  React.useEffect(() => {
    entriesRangeKey.current = rangeKey;
    completedRevisions.current.clear();
    entriesRef.current = new Map();
    setEntries(entriesRef.current);
  }, [rangeKey]);

  const requestKey = (pathsKey ? pathsKey.split('\0') : [])
    .map((path) => `${path}\0${pathRevisions?.has(path) ? `${revision}|${pathRevisions.get(path)}` : revision}`)
    .join('\0');

  React.useEffect(() => {
    const fetcher = fetchEntryRef.current;
    if (!rangeKey || !fetcher || !requestKey) {
      return;
    }
    const requested = requestKey.split('\0');
    let cancelled = false;
    const pendingReservations = new Set<string>();
    const revisions = completedRevisions.current;

    for (let index = 0; index < requested.length; index += 2) {
      const path = requested[index];
      const pathRevision = requested[index + 1];
      if (entriesRef.current.has(path) && revisions.get(path) === pathRevision) continue;
      pendingReservations.add(path);
      if (!entriesRef.current.has(path)) writeEntry(path, placeholder);
      fetcher(path)
        .then((value) => {
          if (cancelled) return;
          pendingReservations.delete(path);
          revisions.set(path, pathRevision);
          writeEntry(path, value);
        })
        .catch(() => {
          if (cancelled) return;
          pendingReservations.delete(path);
          revisions.delete(path);
          writeEntry(path, null);
        });
    }
    return () => {
      cancelled = true;
      for (const path of pendingReservations) {
        if (!revisions.has(path)) writeEntry(path, null);
      }
    };
  }, [placeholder, rangeKey, requestKey, writeEntry]);

  return entriesRangeKey.current === rangeKey ? entries : hiddenEntries.current;
};
