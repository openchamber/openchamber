/* eslint-disable react-refresh/only-export-components -- Provider and hooks are one contract. */
import React from 'react';

export type SessionRowOrderEntry = {
  id: string;
  rowKey: string;
  scopeKey: string | null;
  archived: boolean;
  descendantRange?: readonly [start: number, end: number];
};

type SessionRowOrderRegistry = {
  getEntries: () => readonly SessionRowOrderEntry[];
  getDescendantIds: () => readonly string[];
  getSessionsById: () => ReadonlyMap<string, { time?: { archived?: number | null } }>;
};

const SessionRowOrderContext = React.createContext<SessionRowOrderRegistry | null>(null);

export const SessionRowOrderProvider: React.FC<{
  entries: readonly SessionRowOrderEntry[];
  descendantIds: readonly string[];
  sessionsById: ReadonlyMap<string, { time?: { archived?: number | null } }>;
  children: React.ReactNode;
}> = ({ entries, descendantIds, sessionsById, children }) => {
  const entriesRef = React.useRef(entries);
  const descendantIdsRef = React.useRef(descendantIds);
  const sessionsByIdRef = React.useRef(sessionsById);
  entriesRef.current = entries;
  descendantIdsRef.current = descendantIds;
  sessionsByIdRef.current = sessionsById;
  const registryRef = React.useRef<SessionRowOrderRegistry | null>(null);
  if (registryRef.current === null) {
    registryRef.current = {
      getEntries: () => entriesRef.current,
      getDescendantIds: () => descendantIdsRef.current,
      getSessionsById: () => sessionsByIdRef.current,
    };
  }
  return <SessionRowOrderContext.Provider value={registryRef.current}>{children}</SessionRowOrderContext.Provider>;
};

export const useSessionRowOrderRegistry = (): SessionRowOrderRegistry | null => (
  React.useContext(SessionRowOrderContext)
);

export const deriveSessionRowBulkSelectAll = (
  entries: readonly SessionRowOrderEntry[],
  descendantIds: readonly string[],
  currentScopeKey: string | null,
): { ids: string[]; scopeKey: string | null } | null => {
  const first = entries[0];
  if (!first) return null;
  const scopeKey = currentScopeKey ?? first.scopeKey;
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (scopeKey && entry.scopeKey !== scopeKey) continue;
    const range = entry.descendantRange;
    const entryIds = range ? [entry.id, ...descendantIds.slice(range[0], range[1])] : [entry.id];
    for (const id of entryIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
  }
  return ids.length > 0 ? { ids, scopeKey } : null;
};

export const deriveSessionRowSelectionArchived = (
  selectedIds: ReadonlySet<string>,
  sessionsById: ReadonlyMap<string, { time?: { archived?: number | null } }>,
): boolean => {
  if (selectedIds.size === 0) return false;
  for (const id of selectedIds) {
    if (!sessionsById.get(id)?.time?.archived) return false;
  }
  return true;
};
