import type { TerminalAPI } from './api/types';
import { normalizeTerminalDirectory } from './pathNormalization';
import { groupTerminalSessionsByDirectory, reconcileTerminalSessionAuthority } from './projectActionTerminal';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from './runtime-switch';
import { subscribeOpenchamberEvents } from './openchamberEvents';

type AuthorityResult = NonNullable<Awaited<ReturnType<typeof reconcileTerminalSessionAuthority>>>;
type RevisionCapture = (directory: string) => ReadonlyMap<string, number>;
type Listener = (result: AuthorityResult) => void;
type Scope = { listeners: Set<Listener>; capture: RevisionCapture };
type Observation = { scopes: Map<string, Scope>; refresh: () => void; close: () => void };
const observations = new WeakMap<TerminalAPI, Observation>();

/** One event-driven observation per adapter. An empty directory observes all sessions. */
export const observeTerminalSessions = (
  terminal: TerminalAPI,
  directory: string,
  captureStartedActionMutationRevisions: RevisionCapture,
  listener: Listener,
): (() => void) => {
  if (!terminal.listSessions) return () => {};
  const key = normalizeTerminalDirectory(directory);
  let observation = observations.get(terminal);
  if (!observation) {
    const scopes = new Map<string, Scope>();
    let closed = false;
    let inFlight = false;
    let refreshAgain = false;
    let queued = false;
    let generation = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retryDelay = 2000;
    const active = () => document.visibilityState !== 'hidden' && navigator.onLine !== false;
    const refresh = () => {
      if (closed || !active()) return;
      if (retryTimer !== null) { clearTimeout(retryTimer); retryTimer = null; }
      if (inFlight) { refreshAgain = true; return; }
      // Mounting many directory consumers still starts one request.
      if (queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        if (closed || !active()) return;
        inFlight = true;
        refreshAgain = false;
        const startedGeneration = generation;
        const runtimeKey = getRuntimeKey();
        const startedScopes = new Map(scopes);
        let succeeded = false;
        void reconcileTerminalSessionAuthority(terminal, '', {
          captureStartedActionMutationRevisions: () => {
            const revisions = new Map<string, number>();
            for (const [directory, scope] of startedScopes) {
              for (const [action, revision] of scope.capture(directory)) revisions.set(action, revision);
            }
            return revisions;
          },
        }).then(result => {
          if (closed || generation !== startedGeneration || runtimeKey !== getRuntimeKey() || !result) return;
          succeeded = true;
          retryDelay = 2000;
          const byDirectory = groupTerminalSessionsByDirectory(result.sessions);
          for (const [directory, scope] of startedScopes) {
            if (scopes.get(directory) !== scope) continue;
            const sessions = directory ? byDirectory.get(directory) ?? [] : result.sessions;
            for (const notify of scope.listeners) notify({ ...result, sessions });
          }
        }).catch(() => { /* Keep failed invalidations pending until authority answers. */ }).finally(() => {
          inFlight = false;
          if (closed || !active()) return;
          if (refreshAgain) refresh();
          else if (!succeeded) {
            retryTimer = setTimeout(() => { retryTimer = null; refresh(); }, retryDelay);
            retryDelay = Math.min(retryDelay * 2, 60_000);
          }
        });
      });
    };
    const runtimeChanged = () => { generation += 1; refresh(); };
    window.addEventListener('focus', refresh);
    window.addEventListener('online', refresh);
    document.addEventListener('visibilitychange', refresh);
    const stopRuntimeListener = subscribeRuntimeEndpointChanged(runtimeChanged);
    const stopEvents = subscribeOpenchamberEvents(event => {
      if (event.type === 'terminal-sessions-changed' || event.type === 'event-stream-ready') refresh();
    });
    observation = {
      scopes,
      refresh,
      close: () => {
        closed = true;
        if (retryTimer !== null) clearTimeout(retryTimer);
        window.removeEventListener('focus', refresh);
        window.removeEventListener('online', refresh);
        document.removeEventListener('visibilitychange', refresh);
        stopRuntimeListener();
        stopEvents();
      },
    };
    observations.set(terminal, observation);
  }
  let scope = observation.scopes.get(key);
  if (!scope) {
    scope = { listeners: new Set(), capture: captureStartedActionMutationRevisions };
    observation.scopes.set(key, scope);
  }
  scope.listeners.add(listener);
  observation.refresh();
  return () => {
    scope.listeners.delete(listener);
    if (scope.listeners.size > 0) return;
    observation.scopes.delete(key);
    if (observation.scopes.size > 0) return;
    observation.close();
    observations.delete(terminal);
  };
};
