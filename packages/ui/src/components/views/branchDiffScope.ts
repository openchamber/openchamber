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

export const RANGE_CACHE_IDLE_ENTRIES = 32;

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
  const pendingRequests = React.useRef(new Map<string, { revision: string }>());
  const idlePaths = React.useRef(new Set<string>());
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
    idlePaths.current.clear();
    entriesRef.current = new Map();
    setEntries(entriesRef.current);
    const requests = pendingRequests.current;
    return () => requests.clear();
  }, [rangeKey]);

  const requestKey = (pathsKey ? pathsKey.split('\0') : [])
    .map((path) => `${path}\0${pathRevisions?.has(path) ? `${revision}|${pathRevisions.get(path)}` : revision}`)
    .join('\0');

  React.useEffect(() => {
    const fetcher = fetchEntryRef.current;
    const requested = rangeKey && fetcher && requestKey ? requestKey.split('\0') : [];
    const requestedRevisions = new Map<string, string>();
    for (let index = 0; index < requested.length; index += 2) {
      requestedRevisions.set(requested[index], requested[index + 1]);
    }
    const pending = pendingRequests.current;
    const revisions = completedRevisions.current;
    let next: Map<string, T> | undefined;

    for (const [path, request] of pending) {
      if (requestedRevisions.get(path) === request.revision) continue;
      pending.delete(path);
      if (!revisions.has(path)) (next ??= new Map(entriesRef.current)).delete(path);
    }
    if (fetcher) for (const [path, pathRevision] of requestedRevisions) {
      if (revisions.get(path) === pathRevision || pending.has(path)) continue;
      const request = { revision: pathRevision };
      pending.set(path, request);
      if (!(next ?? entriesRef.current).has(path)) {
        (next ??= new Map(entriesRef.current)).set(path, placeholder);
      }
      fetcher(path)
        .then((value) => {
          if (pending.get(path) !== request) return;
          pending.delete(path);
          revisions.set(path, pathRevision);
          writeEntry(path, value);
        })
        .catch(() => {
          if (pending.get(path) !== request) return;
          pending.delete(path);
          revisions.delete(path);
          writeEntry(path, null);
        });
    }
    if (requestKey) {
      const idle = idlePaths.current;
      for (const path of requestedRevisions.keys()) idle.delete(path);
      for (const path of revisions.keys()) {
        if (!requestedRevisions.has(path)) idle.add(path);
      }
      for (const path of idle) {
        if (idle.size <= RANGE_CACHE_IDLE_ENTRIES) break;
        idle.delete(path);
        revisions.delete(path);
        (next ??= new Map(entriesRef.current)).delete(path);
      }
    }
    if (next) {
      entriesRef.current = next;
      setEntries(next);
    }
  }, [placeholder, rangeKey, requestKey, writeEntry]);

  return entriesRangeKey.current === rangeKey ? entries : hiddenEntries.current;
};
