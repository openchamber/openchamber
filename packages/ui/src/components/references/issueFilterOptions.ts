/**
 * The options behind the issues filter's label and milestone dropdowns.
 *
 * Built on the reference value cache, but with last-good semantics the cache
 * alone does not give: a cache that fails a refresh drops its value to an
 * error state, which would blank a dropdown the user is reading. Here a
 * refresh failure keeps the last good list and marks it stale; a first
 * failure (no last good list) is an error that disables the dropdown. A fetch
 * failure is never an authoritative empty list.
 */

import * as React from 'react';

import { createValueCache, type CachedValue, type ValueCache } from './referenceCache';

export type ChoiceOptionsState<T> =
  | { status: 'loading'; items: T[]; stale: false; error: null }
  | { status: 'ready'; items: T[]; stale: boolean; error: null }
  | { status: 'error'; items: T[]; stale: false; error: string };

export type ChoiceOptions<T> = {
  /** Fetch when missing or stale; `force` re-asks even when fresh. */
  ensure: (options?: { force?: boolean }) => Promise<void>;
  read: () => ChoiceOptionsState<T>;
  subscribe: (listener: () => void) => () => void;
};

/** The state a hook reports before a key exists or while nothing is read. */
const IDLE_STATE: ChoiceOptionsState<never> = { status: 'loading', items: [], stale: false, error: null };

const stateOf = <A,>(value: CachedValue<A[]> | null, kept: A[] | undefined): ChoiceOptionsState<A> => {
  if (!value) return { status: 'loading', items: [], stale: false, error: null };
  if (value.status === 'ready') return { status: 'ready', items: value.value, stale: false, error: null };
  if (value.status === 'error') {
    // A failure with a last good list is stale, not an error that blanks it.
    if (kept) return { status: 'ready', items: kept, stale: true, error: null };
    return { status: 'error', items: [], stale: false, error: value.error };
  }
  return { status: 'loading', items: kept ?? [], stale: false, error: null };
};

/**
 * A keyed, last-good choice read. The key carries everything that changes the
 * answer (runtime, account, project, kind); a null key reads nothing.
 */
export function createChoiceOptions<T>(
  fetch: () => Promise<T[]>,
  key = 'default',
): ChoiceOptions<T> {
  const cache: ValueCache<T[]> = createValueCache(40);
  const lastGood = new Map<string, T[]>();

  // The value cache hands back the same state object until it changes, so the
  // derived state is computed once per value and reused: `useSyncExternalStore`
  // compares snapshots by identity and a fresh object per read loops.
  let derived: { value: CachedValue<T[]> | null; state: ChoiceOptionsState<T> } | null = null;

  const read = (): ChoiceOptionsState<T> => {
    const value = cache.read(key);
    if (derived && derived.value === value) return derived.state;
    const state = stateOf(value, lastGood.get(key));
    derived = { value, state };
    return state;
  };

  const ensure = async (options?: { force?: boolean }): Promise<void> => {
    try {
      const value = await cache.ensure(key, fetch, options);
      lastGood.set(key, value);
    } catch {
      // The cache already records the error; read() decides stale vs. disabled.
    }
  };

  const subscribe = (listener: () => void): (() => void) => cache.subscribe(key, listener);

  return { ensure, read, subscribe };
}

/** The React hook form of {@link createChoiceOptions}. */
export function useChoiceOptions<T>(
  fetch: () => Promise<T[]>,
  key: string | null,
): ChoiceOptionsState<T> {
  const options = React.useMemo(
    () => (key ? createChoiceOptions(fetch, key) : null),
    [fetch, key],
  );
  const subscribe = React.useCallback(
    (listener: () => void) => (options ? options.subscribe(listener) : () => undefined),
    [options],
  );
  const state = React.useSyncExternalStore(subscribe, () => (options ? options.read() : IDLE_STATE));

  React.useEffect(() => {
    if (options) void options.ensure();
  }, [options]);

  return state;
}
