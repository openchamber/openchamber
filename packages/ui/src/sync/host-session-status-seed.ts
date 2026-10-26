import { hostTurnStart, type SessionTurnStart, type SyncEvent } from '@/lib/opencode/events';
import { opencodeClient } from '@/lib/opencode/client';
import type { HostSessionStatusSnapshot } from '@/lib/opencode/session-status';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { resolveGlobalSessionDirectory, useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { applyGlobalSessionStatusEvents, hasActiveSubagent, useGlobalSessionStatusStore } from './global-session-status';
import { hasRunningShell } from './background-shells';
import { readHostBlockingRequestsSnapshot } from './global-blocking-requests';
import { applyHostTurnStarts, needsHostTurnStarts } from './session-activity-timing';

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

// Nothing on the host reconciles its map against OpenCode after a stream gap,
// so a missed idle can leave `busy` there for the host's 24-hour retention.
// A running turn refreshes its entry at every agent-loop step; an entry older
// than this is not trusted as current activity. A genuinely long tool call
// past this age simply waits for its next event instead of being seeded.
export const HOST_STATUS_SEED_MAX_AGE_MS = 30 * 60_000;

type SeedDependencies = {
  isKnown: (sessionId: string) => boolean;
  resolveDirectory: (sessionId: string) => string | null;
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
    if (!directory) continue;
    const events = eventsByDirectory.get(directory) ?? [];
    events.push({ type: 'session.status', properties: { sessionID: sessionId, status: { type: 'busy' } } });
    eventsByDirectory.set(directory, events);
  }
  return eventsByDirectory;
};

/**
 * The host's turn starts, moved onto this device's clock. A busy entry's start
 * is its running turn's. An idle entry's is its last turn's, which counts only
 * while this device holds that turn open for a subagent or background command
 * (`isHeldHere`); otherwise the turn is over, or a newer one began that the
 * host map has not caught up with.
 */
export const buildHostTurnStarts = (
  snapshot: HostSessionStatusSnapshot,
  isHeldHere: (sessionId: string) => boolean,
): Map<string, SessionTurnStart> => {
  const starts = new Map<string, SessionTurnStart>();
  for (const [sessionId, entry] of Object.entries(snapshot.sessions)) {
    if (entry.turnStartedAt === undefined) continue;
    const running = entry.status === 'busy' || entry.status === 'retry';
    if (!running && !isHeldHere(sessionId)) continue;
    starts.set(sessionId, hostTurnStart(entry.turnStartedAt, snapshot.serverTime));
  }
  return starts;
};

/** Idle here, with a running subagent or background command keeping its turn open. */
const isHeldHere = (sessionId: string, activeSessionIds: ReadonlySet<string>): boolean => (
  !activeSessionIds.has(sessionId) && (hasActiveSubagent(sessionId, activeSessionIds) || hasRunningShell(sessionId))
);

let inFlight: Promise<void> | null = null;

/** Fetches the host map once and seeds unobserved busy sessions. Coalesces overlapping calls. */
export const seedGlobalSessionStatusFromHost = (): Promise<void> => {
  if (inFlight) return inFlight;
  const runtimeKey = getRuntimeKey();
  const requestedAt = Date.now();
  inFlight = (async () => {
    const snapshot = await readHostBlockingRequestsSnapshot(async () => {
      const response = await opencodeClient.getHostSessionStatusSnapshot();
      return getRuntimeKey() === runtimeKey ? response : null;
    }, (sessionId) => {
      const session = useGlobalSessionsStore.getState().entityById.get(sessionId);
      return session ? resolveGlobalSessionDirectory(session) : null;
    });
    // A runtime switch between request and response clears the index; the old
    // host's sessions must not be written into the new one.
    if (!snapshot || getRuntimeKey() !== runtimeKey) return;
    // Turns that begin from here on, the statuses below included, are newer than the map.
    const answeredAt = Date.now();
    const status = useGlobalSessionStatusStore.getState();
    const entities = useGlobalSessionsStore.getState().entityById;
    const events = buildHostStatusSeedEvents(snapshot, {
      isKnown: (sessionId) => status.statusById.has(sessionId) || status.observedById.has(sessionId),
      resolveDirectory: (sessionId) => {
        const session = entities.get(sessionId);
        return session ? resolveGlobalSessionDirectory(session) : null;
      },
    });
    for (const [directory, payloads] of events) {
      applyGlobalSessionStatusEvents(directory, payloads);
    }
    // After the statuses: a session seeded busy just now is in its turn here.
    const { activeSessionIds } = useGlobalSessionStatusStore.getState();
    const held = new Set(Object.keys(snapshot.sessions).filter((sessionId) => isHeldHere(sessionId, activeSessionIds)));
    applyHostTurnStarts(buildHostTurnStarts(snapshot, (sessionId) => held.has(sessionId)), held, { requestedAt, answeredAt });
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
};

// Long enough for the host's own status event, which carries the start of a
// turn this device just saw begin, to make the read unnecessary.
const TURN_START_REQUEST_DELAY_MS = 300;
let turnStartRequest: ReturnType<typeof setTimeout> | null = null;

/**
 * Asks the host for the turn starts this page lacks or stands in for. One
 * request after a short wait covers every session that asked meanwhile.
 */
export const requestHostTurnStarts = (): void => {
  if (turnStartRequest !== null) return;
  turnStartRequest = setTimeout(() => {
    turnStartRequest = null;
    if (needsHostTurnStarts()) void seedGlobalSessionStatusFromHost();
  }, TURN_START_REQUEST_DELAY_MS);
};
