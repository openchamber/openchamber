import type { Session } from '@/lib/opencode/model';
import { resolveGlobalSessionDirectory } from '@/stores/globalSessionStructure';

export type SessionVisit = { sessionId: string; directory: string | null };
type Dependencies = {
  resolve: (visit: SessionVisit, signal: AbortSignal) => Promise<Session | null>;
  select: (session: Session) => boolean | void;
  isKnownAvailable?: (sessionId: string) => boolean;
};
type Snapshot = Readonly<{
  canGoBack: boolean;
  canGoForward: boolean;
  pending: boolean;
  errorRevision: number;
}>;

export function createSessionNavigationHistory(dependencies: Dependencies) {
  let visits: SessionVisit[] = [];
  let cursor = -1;
  let pendingIndex: number | null = null;
  let generation = 0;
  let controller: AbortController | null = null;
  let stableScope: string | null = null;
  let suspended = true;
  let blocked = false;
  let selecting = false;
  let errorRevision = 0;
  const unavailable = new Set<string>();
  const listeners = new Set<() => void>();
  let snapshot: Snapshot = {
    canGoBack: false, canGoForward: false, pending: false, errorRevision: 0,
  };
  const nextIndex = (from: number, delta: -1 | 1): number => {
    for (let i = from + delta; i >= 0 && i < visits.length; i += delta) {
      if (!unavailable.has(visits[i].sessionId)) return i;
    }
    return -1;
  };
  const publish = () => {
    const origin = pendingIndex ?? cursor;
    const enabled = !suspended && !blocked;
    const next: Snapshot = {
      canGoBack: enabled && nextIndex(origin, -1) !== -1,
      canGoForward: enabled && nextIndex(origin, 1) !== -1,
      pending: pendingIndex !== null,
      errorRevision,
    };
    if (next.canGoBack === snapshot.canGoBack
      && next.canGoForward === snapshot.canGoForward
      && next.pending === snapshot.pending
      && next.errorRevision === snapshot.errorRevision) return;
    snapshot = next;
    listeners.forEach((listener) => listener());
  };
  const cancel = () => {
    generation += 1;
    controller?.abort();
    controller = null;
    pendingIndex = null;
  };
  const refreshAvailability = () => {
    if (suspended || unavailable.size === 0) return;
    let changed = false;
    for (const id of unavailable) {
      if (dependencies.isKnownAvailable?.(id)) {
        unavailable.delete(id);
        changed = true;
      }
    }
    if (changed) publish();
  };
  const record = (visit: SessionVisit) => {
    if (suspended || blocked || selecting) return;
    if (visits[cursor]?.sessionId === visit.sessionId) {
      if (visit.directory) visits[cursor] = visit;
      return;
    }
    cancel();
    unavailable.delete(visit.sessionId);
    visits = [...visits.slice(0, cursor + 1), visit].slice(-100);
    cursor = visits.length - 1;
    for (const id of unavailable) {
      if (!visits.some((entry) => entry.sessionId === id)) unavailable.delete(id);
    }
    publish();
  };
  const setScope = (scope: string | null) => {
    cancel();
    suspended = scope === null;
    if (scope !== null && scope !== stableScope) {
      visits = [];
      cursor = -1;
      unavailable.clear();
      stableScope = scope;
    }
    refreshAvailability();
    publish();
  };
  const setBlocked = (value: boolean) => {
    if (blocked === value) return;
    blocked = value;
    if (value) cancel();
    publish();
  };
  const navigate = async (delta: -1 | 1): Promise<boolean> => {
    if (suspended || blocked) return false;
    let target = nextIndex(pendingIndex ?? cursor, delta);
    if (target === -1) return false;
    cancel();
    if (target === cursor) { publish(); return true; }
    const request = generation;
    const abort = new AbortController();
    controller = abort;
    pendingIndex = target;
    publish();
    try {
      while (target !== -1) {
        const destination = await dependencies.resolve(visits[target], abort.signal);
        if (request !== generation || abort.signal.aborted) return false;
        if (destination) {
          selecting = true;
          let accepted = false;
          try { accepted = dependencies.select(destination) !== false; }
          finally { selecting = false; }
          if (accepted) {
            cursor = target;
            visits[target] = { sessionId: destination.id, directory: resolveGlobalSessionDirectory(destination) };
            return true;
          }
        }
        unavailable.add(visits[target].sessionId);
        target = nextIndex(target, delta);
        pendingIndex = target === -1 ? null : target;
        publish();
      }
      return false;
    } catch {
      if (request === generation && !abort.signal.aborted) errorRevision += 1;
      return false;
    } finally {
      if (request === generation) {
        controller = null;
        pendingIndex = null;
        // Authority may have changed while an unavailable lookup was settling.
        refreshAvailability();
        publish();
      }
    }
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    record, setScope, setBlocked, navigate, refreshAvailability,
  };
}
