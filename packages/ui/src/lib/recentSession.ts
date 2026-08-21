import { getRuntimeKey } from '@/lib/runtime-switch';
import { RECENT_SESSION_TOKEN } from '@/lib/router';
import { useConfigStore } from '@/stores/useConfigStore';
import { refreshGlobalSessions, resolveGlobalSessionDirectory, useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { clearLastActiveSession, readLastActiveSession, readMostRecentLastActiveSession } from '@/sync/last-session-cache';

export type ResolvedRecentSession = {
  sessionId: string;
  directory: string | null;
};

export type RouteSessionResolution = {
  sessionId: string;
  directoryHint: string | null | undefined;
} | null;

/**
 * Resolve the `session` part of a route. A plain session ID is passed through
 * unchanged with its directory hint; the `?session=recent` token is resolved
 * against the last active session for the current runtime, falling through to
 * the default new-session behavior (null) when nothing usable is persisted.
 */
export async function resolveRouteSessionToken(
  rawSessionId: string,
  resolveRecent: () => Promise<ResolvedRecentSession | null>,
  getDirectoryForSession: (sessionId: string) => string | null | undefined,
): Promise<RouteSessionResolution> {
  if (rawSessionId !== RECENT_SESSION_TOKEN) {
    return { sessionId: rawSessionId, directoryHint: getDirectoryForSession(rawSessionId) };
  }
  const resolved = await resolveRecent();
  if (!resolved) {
    return null;
  }
  return { sessionId: resolved.sessionId, directoryHint: resolved.directory };
}

const RECENT_SESSION_RESOLUTION_TIMEOUT_MS = 6_000;
const RECENT_SESSION_RESOLUTION_ABSOLUTE_CAP_MS = 30_000;

/**
 * Resolve the `?session=recent` URL token to the last session that was active
 * for the current runtime. Mirrors the MobileApp cold-launch restore: the
 * persisted pointer is only trusted after an authoritative sessions snapshot
 * confirms the session still exists. The pointer is dropped only when an
 * authoritative `ready` snapshot confirms the session is gone; failures and
 * non-authoritative statuses preserve it for a later retry.
 *
 * Returns `null` when there is no usable persisted session, so callers can
 * fall back to the default new-session behavior.
 */
export async function resolveRecentSession(): Promise<ResolvedRecentSession | null> {
  const runtimeKey = getRuntimeKey();
  const persisted = readLastActiveSession(runtimeKey) ?? readMostRecentLastActiveSession();
  if (!persisted) {
    return null;
  }

  // Kick off a load if none is in flight. The returned promise is not
  // authoritative: on a runtime-switch generation mismatch it resolves to an
  // empty snapshot without touching the store status, while a newer load may
  // have already applied the real snapshot. Only the committed store status is
  // authoritative, so wait (bounded) for it to reach `ready` and read the
  // committed snapshot there.
  void refreshGlobalSessions().catch(() => null);

  const deadline = Date.now() + RECENT_SESSION_RESOLUTION_TIMEOUT_MS;
  const absoluteCap = Date.now() + RECENT_SESSION_RESOLUTION_ABSOLUTE_CAP_MS;
  for (;;) {
    const state = useGlobalSessionsStore.getState();
    if (Date.now() >= absoluteCap) {
      return null;
    }
    // A transient `error` right after boot (the first refresh attempt fails
    // while the SDK is still connecting on a slow first load, e.g. mobile web)
    // is not authoritative — only give up once the SDK is connected, when an
    // `error` really means the backend is unreachable. Non-connected errors are
    // preserved for the connected retry below.
    if (state.status === 'error' && useConfigStore.getState().isConnected) {
      return null;
    }
    if (state.status === 'ready') {
      const session = state.activeSessions.find((entry) => entry.id === persisted.sessionId);
      if (!session) {
        clearLastActiveSession(runtimeKey);
        return null;
      }
      return {
        sessionId: session.id,
        directory: resolveGlobalSessionDirectory(session) ?? persisted.directory,
      };
    }
    // On a slow first boot (mobile web in particular) the SDK connects only
    // after several seconds, so the sessions load cannot reach `ready` within
    // the resolve deadline. Don't let the deadline race the connection: pause
    // the countdown until the SDK reports connected, mirroring the native
    // mobile cold-launch restore which waits for `isConnected` too. The
    // absolute cap still guards against an unreachable backend.
    if (Date.now() >= deadline && useConfigStore.getState().isConnected) {
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
