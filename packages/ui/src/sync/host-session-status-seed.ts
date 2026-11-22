import type { SyncEvent } from '@/lib/opencode/events';
import { opencodeClient } from '@/lib/opencode/client';
import type { HostSessionStatusSnapshot } from '@/lib/opencode/session-status';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { isSpaceDirectory } from '@/lib/spaces/space-route';
import { resolveGlobalSessionDirectory, useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { applyGlobalSessionStatusEvents, useGlobalSessionStatusStore } from './global-session-status';
import { readHostBlockingRequestsSnapshot } from './global-blocking-requests';

// Seeds the cross-directory status index from the host's own map.
//
// Directory bootstrap only runs for the directory the user is working in, so a
// turn that was already running in another project when this client started
// is invisible to the event stream until its next status event. The OpenChamber
// host (web server, or the VS Code extension host) has been listening to the
// single upstream stream the whole time and answers `/api/sessions/status` in
// one request without creating OpenCode instances.
//
// The seed is strictly additive: it only adds busy entries for sessions this
// client has not observed itself. Absence from the host map never clears
// anything, because the map has no directory and a missing entry proves
// nothing about a session the client already knows to be running. A live event
// that arrives before the seed wins, since the event path records every
// observed session and the seed skips those.

// The host checks its own sessions against OpenCode every 30 s, but nothing
// checks a space's sessions, and a host without that check keeps a missed idle
// as `busy` for its 24-hour retention.
// A running turn refreshes its entry at every agent-loop step; an entry older
// than this is not trusted as current activity. A genuinely long tool call
// past this age simply waits for its next event instead of being seeded.
export const HOST_STATUS_SEED_MAX_AGE_MS = 30 * 60_000;

type SeedDependencies = {
  isKnown: (sessionId: string) => boolean;
  resolveDirectory: (sessionId: string) => string | null;
  /** False when OpenCode says the session is not running (see `seedGlobalSessionStatusFromHost`). */
  mayBeRunning: (sessionId: string, directory: string) => boolean;
};

/**
 * Turns the host snapshot into per-directory `session.status` events for the
 * sessions the client has no live observation of. Retry collapses to busy:
 * the host keeps no attempt details, and the next live event restores them.
 */
export const buildHostStatusSeedEvents = (
  snapshot: HostSessionStatusSnapshot,
  deps: SeedDependencies,
  maxAgeMs = HOST_STATUS_SEED_MAX_AGE_MS,
): Map<string, SyncEvent[]> => {
  const eventsByDirectory = new Map<string, SyncEvent[]>();
  for (const [sessionId, entry] of Object.entries(snapshot.sessions)) {
    if (entry.status !== 'busy' && entry.status !== 'retry') continue;
    if (snapshot.serverTime - entry.lastUpdateAt > maxAgeMs) continue;
    if (deps.isKnown(sessionId)) continue;
    const directory = deps.resolveDirectory(sessionId);
    if (!directory || !deps.mayBeRunning(sessionId, directory)) continue;
    const events = eventsByDirectory.get(directory) ?? [];
    events.push({ type: 'session.status', properties: { sessionID: sessionId, status: { type: 'busy' } } });
    eventsByDirectory.set(directory, events);
  }
  return eventsByDirectory;
};

let inFlight: Promise<void> | null = null;

/**
 * Fetches the host map once and seeds unobserved busy sessions. Coalesces overlapping calls.
 *
 * The host map keeps a session busy when its end was never reported to the
 * host, so every host entry for a host directory is checked against
 * OpenCode's own running list, read alongside it. Without that check a
 * finished subagent can reappear after list loads in another window.
 * A session inside an isolated space is not on the
 * host's list and keeps the host's word, as does every session while a
 * replaced OpenCode drains; a failed read checks nothing.
 */
export const seedGlobalSessionStatusFromHost = (): Promise<void> => {
  if (inFlight) return inFlight;
  const runtimeKey = getRuntimeKey();
  inFlight = (async () => {
    const [snapshot, active] = await Promise.all([
      readHostBlockingRequestsSnapshot(async () => {
        const response = await opencodeClient.getHostSessionStatusSnapshot();
        return getRuntimeKey() === runtimeKey ? response : null;
      }, (sessionId) => {
        const session = useGlobalSessionsStore.getState().entityById.get(sessionId);
        return session ? resolveGlobalSessionDirectory(session) : null;
      }),
      opencodeClient.getActiveSessionStatuses(),
    ]);
    // A runtime switch between request and response clears the index; the old
    // host's sessions must not be written into the new one.
    if (!snapshot || getRuntimeKey() !== runtimeKey) return;
    const status = useGlobalSessionStatusStore.getState();
    const entities = useGlobalSessionsStore.getState().entityById;
    const events = buildHostStatusSeedEvents(snapshot, {
      isKnown: (sessionId) => status.statusById.has(sessionId) || status.observedById.has(sessionId),
      resolveDirectory: (sessionId) => {
        const session = entities.get(sessionId);
        return session ? resolveGlobalSessionDirectory(session) : null;
      },
      // While a replaced OpenCode drains, the turns it still runs are not on
      // the current OpenCode's list, so the host's word stands for them.
      mayBeRunning: (sessionId, directory) => active === null || snapshot.openCodeDraining === true
        || isSpaceDirectory(directory) || Object.hasOwn(active, sessionId),
    });
    for (const [directory, payloads] of events) {
      applyGlobalSessionStatusEvents(directory, payloads);
    }
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
};
