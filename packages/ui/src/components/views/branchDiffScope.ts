import React from 'react';

/**
 * Pure helpers backing the "Branch" diff scope in DiffView. Extracted so the
 * coercion, availability, and range-cache invalidation contracts are testable
 * without mounting the full diff surface.
 */

/**
 * The "Branch" scope only exists while the repository's default branch is
 * known and the current branch differs from it (the caller decides runtime
 * availability). An unknown default must NOT show the option: the scope is
 * "this branch is not the default", which cannot be established, and offering
 * it on a guess flashes the option while branch metadata is still loading.
 */
export const isBranchScopeAvailable = (
  currentBranch: string | null,
  repositoryDefaultBranch: string | null
): boolean => (
  Boolean(currentBranch)
  && repositoryDefaultBranch !== null
  && currentBranch !== repositoryDefaultBranch
);

/**
 * Confirmed unavailability of the Branch scope, as opposed to "not (yet)
 * known". Coercion of a persisted branch scope must wait for this: while
 * metadata is loading the default branch is unknown, the option stays hidden,
 * but rewriting the persisted scope to working on that first render would
 * discard the user's choice the moment metadata arrives and confirms the
 * branch differs from the default.
 *
 * - `isBranchStatusResolved` distinguishes "no branch yet because the first
 *   status load has not settled" (unknown — keep the persisted scope) from
 *   "status finished and there is no branch" (detached HEAD / failed load —
 *   the Branch scope is impossible and the scope must coerce away).
 * - `isBranchMetadataLoaded` + a null default means the branch list settled
 *   WITHOUT a resolvable default branch (git/remote never reported one): the
 *   Branch scope is impossible in a different way, and must coerce too,
 *   otherwise the persisted scope spins on base resolution forever.
 */
export const isBranchScopeDefinitelyUnavailable = (
  currentBranch: string | null,
  repositoryDefaultBranch: string | null,
  isBranchStatusResolved: boolean,
  isBranchMetadataLoaded: boolean
): boolean => {
  if (!isBranchStatusResolved) return false;
  if (currentBranch === null) return true;
  if (isBranchMetadataLoaded && repositoryDefaultBranch === null) return true;
  return repositoryDefaultBranch !== null && currentBranch === repositoryDefaultBranch;
};

/**
 * A context tab persists its scope across branch checkouts and runtime
 * switches. When the Branch scope stops being offered (checked out the
 * default branch, VS Code runtime), fall back to a always-available one instead
 * of rendering the base-resolution spinner forever.
 */
export const coerceDiffScope = <T extends string>(
  scope: T,
  branchScopeAvailable: boolean
): T | 'working' => (scope === 'branch' && !branchScopeAvailable ? 'working' : scope);

/**
 * Identity of one `base...head` range in one repository. Range-cache entries
 * are only valid within a single range: the same file path can carry different
 * content under a different base or head, so a cache keyed by path alone leaks
 * stale patches across branch and base switches.
 */
export const branchRangeKey = (directory: string, base: string, head: string): string =>
  JSON.stringify([directory, base, head]);

/**
 * Bounded per-directory retry for a request whose failure leaves no result and
 * no signal beyond the in-flight flag settling back to false.
 *
 * - State carries its directory: after a directory switch the derived
 *   attempts/exhausted values reset IMMEDIATELY on the first render of the new
 *   directory (no reset effect, so no one-render window where a stale
 *   `exhausted: true` from the previous directory leaks into decisions).
 * - Retries stop after `maxAttempts` and report exhaustion instead of looping
 *   forever against a dead target.
 * - An in-flight request (possibly started by another mounted consumer of the
 *   same directory) suppresses duplicate starts.
 */
export const useBoundedDirectoryRetry = (
  directory: string | null,
  isEnabled: boolean,
  isRequestInFlight: boolean,
  hasResult: boolean,
  startRequest: () => void,
  maxAttempts: number
): boolean => {
  // Attempts live in a ref and the effect's deps deliberately exclude them:
  // a retry may only be triggered by an EXTERNAL transition (the in-flight
  // flag settling back to false, a directory switch, a result appearing), never
  // by the attempt counter itself — otherwise one start cascades into all
  // remaining attempts in a single commit.
  const attemptsRef = React.useRef<{ directory: string; attempts: number }>({ directory: '', attempts: 0 });
  const [exhaustedState, setExhaustedState] = React.useState<{ directory: string; exhausted: boolean }>(
    () => ({ directory: '', exhausted: false })
  );
  // The starter is read through a ref so an inline arrow from the caller
  // cannot restart the effect in a render loop.
  const startRequestRef = React.useRef(startRequest);
  startRequestRef.current = startRequest;

  // A different directory's (or the initial empty) exhaustion state reads as
  // not exhausted; this derivation is the instant-reset guarantee above.
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

/**
 * Per-path cache of lazily fetched values, valid within a single range.
 *
 * - Changing `rangeKey` clears every entry (new base/head/directory = new
 *   content for the same paths).
 * - Each expanded path is reserved with `placeholder` before its fetch starts,
 *   so a re-run does not issue a duplicate request.
 * - Completions from a previous run can never write into the new range's
 *   cache: every run is cancelled in its cleanup, and its callbacks ignore
 *   results after cancellation. This covers the stale-completion case where an
 *   old `fetchEntry` promise resolves (or rejects) after the range switched.
 * - Reservations that never completed are released on cleanup so a later run
 *   retries those paths instead of showing the placeholder forever.
 */
export const useRangeKeyedCache = <T>(
  rangeKey: string | null,
  pathsKey: string,
  fetchEntry: ((path: string) => Promise<T>) | null,
  placeholder: T
): ReadonlyMap<string, T> => {
  const [entries, setEntries] = React.useState<Map<string, T>>(() => new Map());
  const entriesRef = React.useRef(entries);
  entriesRef.current = entries;

  // The fetcher is read through a ref so a caller passing an inline arrow (a
  // new function every render) cannot restart the fetch effect in a loop.
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
    if (!rangeKey) return;
    entriesRef.current = new Map();
    setEntries(entriesRef.current);
  }, [rangeKey]);

  React.useEffect(() => {
    const fetcher = fetchEntryRef.current;
    if (!rangeKey || !fetcher || !pathsKey) {
      return;
    }
    let cancelled = false;
    const pendingReservations = new Set<string>();

    for (const path of pathsKey.split('\0')) {
      if (entriesRef.current.has(path)) continue;
      pendingReservations.add(path);
      writeEntry(path, placeholder);
      fetcher(path)
        .then((value) => {
          if (cancelled) return;
          pendingReservations.delete(path);
          writeEntry(path, value);
        })
        .catch(() => {
          if (cancelled) return;
          // Release the reservation so a later run can retry this path.
          pendingReservations.delete(path);
          writeEntry(path, null);
        });
    }
    return () => {
      cancelled = true;
      for (const path of pendingReservations) {
        writeEntry(path, null);
      }
    };
  }, [pathsKey, placeholder, rangeKey, writeEntry]);

  return entries;
};
