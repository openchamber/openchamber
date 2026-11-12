import React from 'react';

/**
 * Pure helpers backing the "Branch" diff scope in DiffView. Extracted so the
 * coercion, availability, and range-cache invalidation contracts are testable
 * without mounting the full diff surface.
 */

/**
 * The "Branch" scope exists while the current branch has a comparison base:
 * chosen, an open pull request's, the one it was created from, or the default
 * branch (the caller decides runtime availability). Resolution skips a base
 * that is the branch itself, so on the default branch with nothing else to
 * compare against the option is not offered. Until the base resolves the
 * option stays hidden instead of flashing on a guess.
 */
export const isBranchScopeAvailable = (
  currentBranch: string | null,
  base: string | null
): boolean => Boolean(currentBranch) && base !== null;

/**
 * Confirmed unavailability of the Branch scope, as opposed to "not (yet)
 * known". Coercion of a persisted branch scope must wait for this: while the
 * base is resolving the option stays hidden, but rewriting the persisted scope
 * to working on that first render would discard the user's choice the moment
 * the base arrives.
 *
 * - `isBranchStatusResolved` distinguishes "no branch yet because the first
 *   status load has not settled" (unknown — keep the persisted scope) from
 *   "status finished and there is no branch" (detached HEAD / failed load —
 *   the Branch scope is impossible and the scope must coerce away).
 * - `isBaseResolved` with a null base means every candidate answered and none
 *   names a base: the scope must coerce too, otherwise a persisted branch
 *   scope spins on base resolution forever.
 */
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
 * Per-file revisions of a Branch listing for `useRangeKeyedCache`. A file the
 * server fingerprints refreshes only when that fingerprint moves; a listing
 * without one (an older server) falls back to the status revision, which moves
 * on every status read.
 */
export const branchPathRevisions = (
  files: ReadonlyArray<{ path: string; revision?: string }> | null,
  statusRevision: string
): ReadonlyMap<string, string> => new Map((files ?? []).map((file) => [file.path, file.revision ?? `status:${statusRevision}`]));

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
 * - A revision change refreshes requested paths while retaining completed
 *   same-range values until replacement. Unchanged revisions do no extra work;
 *   closed paths refresh when requested again. Range switches hide old values
 *   immediately, before effects run.
 * - `pathRevisions` adds a revision per path on top of `revision`, so a path
 *   refreshes only when its own entry moves. A path missing from the map
 *   refreshes with `revision` alone.
 */
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
    entriesRangeKey.current = rangeKey;
    completedRevisions.current.clear();
    entriesRef.current = new Map();
    setEntries(entriesRef.current);
  }, [rangeKey]);

  // Path and revision pairs as one string, so a new map carrying the same
  // revisions (every file-list re-read) does not re-run the fetch effect and
  // cancel requests in flight. Paths never contain NUL; revisions are JSON.
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
          // Release the reservation so a later run can retry this path.
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

  // Before the range-change effect runs, the old range's values are hidden
  // behind one empty map kept for this hook: a fresh map per render would read as new data
  // to every memo keyed on this result, and a render-phase update in a
  // consumer (the find bar) would then re-render forever.
  return entriesRangeKey.current === rangeKey ? entries : hiddenEntries.current;
};
