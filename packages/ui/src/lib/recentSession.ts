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
  const deadline = Date.now() + 6_000;
  const cap = Date.now() + 30_000;
  let retriedAfterConnect = false;
  for (;;) {
    const state = useGlobalSessionsStore.getState();
    const connected = useConfigStore.getState().isConnected;
    if (Date.now() >= cap) {
      return null;
    }
    if (state.status === 'error') {
      if (!connected) {
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
    if (Date.now() >= deadline && connected) {
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
