import { ensureGlobalSessionsLoaded, resolveGlobalSessionDirectory } from '@/stores/useGlobalSessionsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';

/**
 * Select a session named by `/?session=`. Cold loads often do not know the
 * owning directory yet, so a first selection may guess the active project.
 * After the global session list is available, re-select with that directory
 * unless the user already moved to a different session.
 */
export async function openSessionFromRoute(sessionId: string): Promise<void> {
  const id = sessionId.trim();
  if (!id) return;

  const initial = useSessionUIStore.getState();
  if (initial.currentSessionId !== id) {
    initial.setCurrentSession(id, initial.getDirectoryForSession(id));
  }

  const snapshot = await ensureGlobalSessionsLoaded().catch(() => null);
  if (!snapshot) return;

  const latest = useSessionUIStore.getState();
  if (latest.currentSessionId !== id) return;

  const session = [...snapshot.activeSessions, ...snapshot.archivedSessions]
    .find((entry) => entry.id === id);
  if (!session) return;

  const directory = resolveGlobalSessionDirectory(session);
  if (!directory || directory === latest.currentSessionDirectory) return;

  latest.setCurrentSession(id, directory);
}
