/* oxlint-disable react/only-export-components -- Provider and hooks are one contract. */
import React from 'react';

export type SessionRowOrderEntry = {
  id: string;
  rowKey: string;
  scopeKey: string | null;
  archived: boolean;
  descendantRange?: readonly [start: number, end: number];
};

export type SessionRowLifecycle = { time?: { archived?: number | null }; archived?: boolean };

export function mergeSessionRowLifecycle(entries: readonly SessionRowOrderEntry[], sessions: ReadonlyMap<string, SessionRowLifecycle>): ReadonlyMap<string, SessionRowLifecycle> {
  const lifecycle = new Map(sessions);
  for (const entry of entries) if (!lifecycle.has(entry.id)) lifecycle.set(entry.id, { archived: entry.archived });
  return lifecycle;
}

type SessionRowOrderRegistry = {
  getEntries: () => readonly SessionRowOrderEntry[];
  getDescendantIds: () => readonly string[];
  getSessionsById: () => ReadonlyMap<string, SessionRowLifecycle>;
};

const SessionRowOrderContext = React.createContext<SessionRowOrderRegistry | null>(null);

export const SessionRowOrderProvider: React.FC<{
  entries: readonly SessionRowOrderEntry[];
  descendantIds: readonly string[];
  sessionsById: ReadonlyMap<string, SessionRowLifecycle>;
  children: React.ReactNode;
}> = ({ entries, descendantIds, sessionsById, children }) => {
  const entriesRef = React.useRef(entries);
  const descendantIdsRef = React.useRef(descendantIds);
  const lifecycleById = React.useMemo(() => mergeSessionRowLifecycle(entries, sessionsById), [entries, sessionsById]);
  const sessionsByIdRef = React.useRef(lifecycleById);
  entriesRef.current = entries;
  descendantIdsRef.current = descendantIds;
  sessionsByIdRef.current = lifecycleById;
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
  sessionsById: ReadonlyMap<string, SessionRowLifecycle>,
): boolean => {
  if (selectedIds.size === 0) return false;
  for (const id of selectedIds) {
    const session = sessionsById.get(id);
    if (!(session?.archived ?? Boolean(session?.time?.archived))) return false;
  }
  return true;
};
