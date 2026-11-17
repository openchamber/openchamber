import type { Session } from '@/lib/opencode/model';
import { getBtwOriginalSessionID } from '@/lib/sessionBtwMetadata';
import { ensureGlobalSessionsLoaded, resolveGlobalSessionDirectory, useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useBtwStore } from '@/stores/useBtwStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { setSessionOpener } from '@/sync/session-navigation';
import { requestMessageFocus } from './messageFocus';

let redirecting = false;
export const isSessionOpenRedirect = (): boolean => redirecting;

export type SessionOpenOptions = {
  directory?: string | null;
  messageId?: string | null;
  requireKnownSession?: boolean;
};

type SessionOpenTarget = {
  sessionId: string;
  directory: string | null;
  btwParentId: string | null;
};

const btwParentOf = (session: Session | undefined): string | null => {
  const parentId = getBtwOriginalSessionID(session);
  return parentId && session && parentId !== session.id ? parentId : null;
};

const targetFor = (
  session: Session | undefined,
  fallbackId: string,
  parentExists: (parentId: string) => boolean,
): SessionOpenTarget => {
  const parentId = btwParentOf(session);
  const directory = session ? resolveGlobalSessionDirectory(session) : null;
  return parentId && parentExists(parentId)
    ? { sessionId: parentId, directory, btwParentId: parentId }
    : { sessionId: fallbackId, directory, btwParentId: null };
};

const selectTarget = (target: SessionOpenTarget, directoryHint: string | null): void => {
  const state = useSessionUIStore.getState();
  const directory = directoryHint ?? state.getDirectoryForSession(target.sessionId) ?? target.directory;
  const directoryChanged = directory !== null && directory !== state.currentSessionDirectory;
  if (state.currentSessionId !== target.sessionId || directoryChanged) {
    state.setCurrentSession(target.sessionId, directory);
  }
  if (target.btwParentId) {
    useBtwStore.getState().setPanelState(target.btwParentId, { collapsed: false });
  }
};

export async function openSession(sessionId: string, options: SessionOpenOptions = {}): Promise<void> {
  const requestedId = sessionId.trim();
  if (!requestedId) return;
  if (options.requireKnownSession) {
    const selectedBeforeLoad = useSessionUIStore.getState().currentSessionId;
    const snapshot = await ensureGlobalSessionsLoaded().catch(() => null);
    if (useSessionUIStore.getState().currentSessionId !== selectedBeforeLoad) return;
    if (!snapshot || ![...snapshot.activeSessions, ...snapshot.archivedSessions].some((session) => session.id === requestedId)) return;
  }

  const messageId = options.messageId?.trim() || null;
  if (messageId) requestMessageFocus(requestedId, messageId);

  const initialStore = useGlobalSessionsStore.getState();
  const initialTarget = messageId
    ? { sessionId: requestedId, directory: null, btwParentId: null }
    : targetFor(initialStore.entityById.get(requestedId), requestedId, (parentId) => initialStore.entityById.has(parentId));
  selectTarget(initialTarget, options.directory?.trim() || null);

  const snapshot = await ensureGlobalSessionsLoaded().catch(() => null);
  if (!snapshot) return;

  const latest = useSessionUIStore.getState();
  if (latest.currentSessionId !== initialTarget.sessionId) return;

  const sessions = [...snapshot.activeSessions, ...snapshot.archivedSessions];
  const session = sessions.find((entry) => entry.id === requestedId);
  if (!session) return;

  const target = messageId
    ? { sessionId: requestedId, directory: resolveGlobalSessionDirectory(session), btwParentId: null }
    : targetFor(session, requestedId, (parentId) => sessions.some((entry) => entry.id === parentId));
  if (target.sessionId !== latest.currentSessionId) {
    redirecting = true;
    try {
      selectTarget(target, null);
    } finally {
      redirecting = false;
    }
    return;
  }
  if (!target.directory || target.directory === latest.currentSessionDirectory) return;
  latest.setCurrentSession(target.sessionId, target.directory);
}

export function openSessionLink(sessionId: string, messageId: string | null): Promise<void> {
  return openSession(sessionId, { messageId });
}

export function openSessionFromRoute(sessionId: string): Promise<void> {
  return openSession(sessionId);
}

setSessionOpener((sessionId, directory) => {
  void openSession(sessionId, { directory });
});
