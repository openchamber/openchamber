import type { TerminalAPI } from './api/types';
import { reconcileTerminalSessionAuthority } from './projectActionTerminal';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from './runtime-switch';

const REFRESH_INTERVAL_MS = 5_000;
type AuthorityResult = NonNullable<Awaited<ReturnType<typeof reconcileTerminalSessionAuthority>>>;
type RevisionCapture = (directory: string) => ReadonlyMap<string, number>;
type Listener = (result: AuthorityResult) => void;
type Observation = { listeners: Set<Listener>; refresh: () => void; close: () => void };
const observations = new WeakMap<TerminalAPI, Map<string, Observation>>();

/** One visible-demand loop per adapter/directory, shared by the header and panel. */
export const observeTerminalSessions = (
  terminal: TerminalAPI,
  directory: string,
  captureStartedActionMutationRevisions: RevisionCapture,
  listener: Listener,
): (() => void) => {
  if (!terminal.listSessions) return () => {};
  let directories = observations.get(terminal);
  if (!directories) {
    directories = new Map();
    observations.set(terminal, directories);
  }
  let observation = directories.get(directory);
  if (!observation) {
    const listeners = new Set<Listener>();
    let closed = false;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let generation = 0;
    const active = () => document.visibilityState !== 'hidden' && navigator.onLine !== false;
    const clearTimer = () => { if (timer !== null) clearTimeout(timer); timer = null; };
    const refresh = () => {
      clearTimer();
      if (closed || inFlight || !active()) return;
      inFlight = true;
      const startedGeneration = generation;
      const runtimeKey = getRuntimeKey();
      void reconcileTerminalSessionAuthority(terminal, directory, { captureStartedActionMutationRevisions })
        .then(result => {
          if (closed || generation !== startedGeneration || runtimeKey !== getRuntimeKey() || !result) return;
          for (const notify of listeners) notify(result);
        })
        .finally(() => {
          inFlight = false;
          if (!closed && active()) timer = setTimeout(refresh, REFRESH_INTERVAL_MS);
        });
    };
    const runtimeChanged = () => { generation += 1; refresh(); };
    window.addEventListener('focus', refresh);
    window.addEventListener('online', refresh);
    window.addEventListener('offline', clearTimer);
    document.addEventListener('visibilitychange', refresh);
    const stopRuntimeListener = subscribeRuntimeEndpointChanged(runtimeChanged);
    observation = {
      listeners,
      refresh,
      close: () => {
        closed = true;
        clearTimer();
        window.removeEventListener('focus', refresh);
        window.removeEventListener('online', refresh);
        window.removeEventListener('offline', clearTimer);
        document.removeEventListener('visibilitychange', refresh);
        stopRuntimeListener();
      },
    };
    directories.set(directory, observation);
  }
  observation.listeners.add(listener);
  observation.refresh();
  return () => {
    observation.listeners.delete(listener);
    if (observation.listeners.size > 0) return;
    observation.close();
    directories.delete(directory);
    if (directories.size === 0) observations.delete(terminal);
  };
};
