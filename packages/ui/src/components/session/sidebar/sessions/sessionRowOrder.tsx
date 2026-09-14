/* eslint-disable react-refresh/only-export-components -- The provider, its registration hooks, and the registry factory are one coupled contract. */
import React from 'react';
import type { SessionRowOrderEntry } from './sessionRowOrderUtils';
import { toSessionRowOrderIds } from './sessionRowOrderUtils';

export type SessionRowOrderSegment = {
  order: number;
  entries: readonly SessionRowOrderEntry[];
};

/**
 * Non-reactive registry of the sidebar's logical row order. Lists register
 * their rendered segments in document order; selection code reads the
 * flattened order. Nothing here triggers React renders — the context value is
 * one stable object and registration only mutates ref-held maps, so a list
 * update never re-renders unrelated consumers.
 */
export type SessionRowOrderRegistry = {
  register: (key: string, segment: SessionRowOrderSegment) => void;
  unregister: (key: string) => void;
  getOrderedEntries: () => readonly SessionRowOrderEntry[];
  getOrderedIds: () => readonly string[];
};

const EMPTY_ENTRIES: readonly SessionRowOrderEntry[] = [];
const EMPTY_IDS: readonly string[] = [];

export const createSessionRowOrderRegistry = (): SessionRowOrderRegistry => {
  const segments = new Map<string, SessionRowOrderSegment>();
  let cachedEntries: readonly SessionRowOrderEntry[] | null = null;
  let cachedIds: readonly string[] | null = null;

  const invalidate = (): void => {
    cachedEntries = null;
    cachedIds = null;
  };

  const getOrderedEntries = (): readonly SessionRowOrderEntry[] => {
    if (cachedEntries) return cachedEntries;
    const ordered = [...segments.values()].sort((a, b) => a.order - b.order);
    cachedEntries = ordered.length === 0
      ? EMPTY_ENTRIES
      : ordered.flatMap((segment) => segment.entries);
    return cachedEntries;
  };

  return {
    register: (key, segment) => {
      segments.set(key, segment);
      invalidate();
    },
    unregister: (key) => {
      if (segments.delete(key)) invalidate();
    },
    getOrderedEntries,
    getOrderedIds: () => {
      if (cachedIds) return cachedIds;
      const entries = getOrderedEntries();
      cachedIds = entries.length === 0 ? EMPTY_IDS : toSessionRowOrderIds(entries);
      return cachedIds;
    },
  };
};

const SessionRowOrderContext = React.createContext<SessionRowOrderRegistry | null>(null);

export const SessionRowOrderProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const registryRef = React.useRef<SessionRowOrderRegistry | null>(null);
  if (registryRef.current === null) {
    registryRef.current = createSessionRowOrderRegistry();
  }
  return <SessionRowOrderContext.Provider value={registryRef.current}>{children}</SessionRowOrderContext.Provider>;
};

export const useSessionRowOrderRegistry = (): SessionRowOrderRegistry | null => (
  React.useContext(SessionRowOrderContext)
);

/**
 * Register one list segment for the committed tree. `entries` must be treated
 * as immutable; a changed reference re-registers after the DOM commit and
 * before paint, so a click can never observe the previous list's order.
 */
export const useRegisterSessionRowOrder = (
  order: number,
  entries: readonly SessionRowOrderEntry[],
): void => {
  const registry = useSessionRowOrderRegistry();
  const key = React.useId();
  React.useLayoutEffect(() => {
    if (!registry) return;
    registry.register(key, { order, entries });
    return () => registry.unregister(key);
  }, [entries, key, order, registry]);
};
