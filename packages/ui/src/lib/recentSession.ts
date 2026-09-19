import { getRuntimeKey } from '@/lib/runtime-switch';
import { useConfigStore } from '@/stores/useConfigStore';
import { refreshGlobalSessions, resolveGlobalSessionDirectory, useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { clearLastActiveSession, readLastActiveSession, readMostRecentLastActiveSession } from '@/sync/last-session-cache';

export type ResolvedRecentSession = {
  sessionId: string;
  directory: string | null;
};

export function shouldApplyResolvedRecentSession(
  sessionIdBeforeResolution: string | null,
  currentSessionId: string | null,
): boolean {
  return sessionIdBeforeResolution === currentSessionId;
}

let recentSessionSnapshotWaitMs = 60_000;

/**
 * Test hook: shrink the snapshot wait so short-lived failure paths can be
 * exercised without real (long) delays. Never call from app code.
 */
export function setRecentSessionSnapshotWaitMs(ms: number): void {
  recentSessionSnapshotWaitMs = ms;
}

/**
 * Resolve the `?session=recent` URL token to the last session that was active
 * for the current runtime. The pointer is only cleared after a ready snapshot
 * confirms that the session no longer exists.
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

  void refreshGlobalSessions().catch(() => null);
  // The auto-opened draft already occupies the viewport while this resolves, so
  // holding route application is free — cutting off on a short built-in
  // deadline is what landed cold/mobile boots (the `?session=recent` iframe
  // reload on a phone, first request after a server restart) on a fresh draft
  // even though the sessions snapshot became ready a moment later. Wait for the
  // snapshot to settle; only a settled failure (post-reconnect retry) or the
  // generous cap below gives up.
  const deadline = Date.now() + recentSessionSnapshotWaitMs;
  let retriedAfterConnect = false;
  for (;;) {
    const state = useGlobalSessionsStore.getState();
    const connected = useConfigStore.getState().isConnected;
    if (state.status === 'error') {
      if (!connected) {
        if (Date.now() >= deadline) {
          return null;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
        continue;
      }
      if (!retriedAfterConnect) {
        retriedAfterConnect = true;
        void refreshGlobalSessions().catch(() => null);
        await new Promise((resolve) => setTimeout(resolve, 50));
        continue;
      }
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
    if (Date.now() >= deadline) {
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
