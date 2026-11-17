import { opencodeClient } from '@/lib/opencode/client';
import type { Session } from '@/lib/opencode/model';
import { normalizePath } from '@/lib/pathNormalization';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { resolveGlobalSessionDirectory, useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useBackgroundShellsStore } from '@/sync/background-shells';
import type { ChildStoreManager } from '@/sync/child-store';
import { aggregateLiveSessions } from '@/sync/live-aggregate';
import { useSessionUIStore } from '@/sync/session-ui-store';

const isInside = (directory: string | null | undefined, root: string): boolean => {
  const normalized = normalizePath(directory ?? null);
  return normalized === root || Boolean(normalized?.startsWith(`${root}/`));
};

export const sessionsInWorktree = (sessions: readonly Session[], path: string): Session[] => {
  const root = normalizePath(path);
  return root ? sessions.filter((session) => isInside(resolveGlobalSessionDirectory(session), root)) : [];
};

export const withSessionsNowInWorktree = (sessionIds: readonly string[], path: string): string[] => [
  ...new Set([...sessionIds, ...sessionsInWorktree(useGlobalSessionsStore.getState().activeSessions, path).map((session) => session.id)]),
];

export const activeSessionsInWorktreeNow = (path: string, liveSessions: readonly Session[]): Session[] => {
  const root = normalizePath(path);
  if (!root) return [];
  const listed = useGlobalSessionsStore.getState().activeSessions;
  const listedIds = new Set(listed.map((session) => session.id));
  const merged = new Map(sessionsInWorktree(listed, root).map((session) => [session.id, session]));
  for (const session of liveSessions) {
    if (!listedIds.has(session.id) && !session.time?.archived && isInside(resolveGlobalSessionDirectory(session), root)) merged.set(session.id, session);
  }
  return [...merged.values()];
};

export const readSessionsInWorktree = (childStores: ChildStoreManager, path: string): Session[] => activeSessionsInWorktreeNow(
  path,
  aggregateLiveSessions(Array.from(childStores.children.values(), (store) => store.getState())),
);

export const subscribeSessionsInWorktree = (childStores: ChildStoreManager, notify: () => void): (() => void) => {
  const stopLive = childStores.subscribeAllSelected((state) => state.session, notify);
  const stopGlobal = useGlobalSessionsStore.subscribe((state, previous) => {
    if (state.activeSessions !== previous.activeSessions) notify();
  });
  return () => {
    stopLive();
    stopGlobal();
  };
};

export type WorktreeUse = 'free' | 'busy' | 'inUse' | 'unknown';

export async function readWorktreeUse(path: string): Promise<WorktreeUse> {
  const root = normalizePath(path) ?? path;
  const statuses = await opencodeClient.getActiveSessionStatuses(root);
  const sessions = sessionsInWorktree(useGlobalSessionsStore.getState().activeSessions, root);
  const currentSessionId = useSessionUIStore.getState().currentSessionId;
  if (isInside(useDirectoryStore.getState().currentDirectory, root) || sessions.some((session) => session.id === currentSessionId)) return 'inUse';
  const shells = useBackgroundShellsStore.getState();
  if ([...shells.byId.values()].some((shell) => isInside(shell.directory, root)) || sessions.some((session) => shells.sessionIds.has(session.id))) {
    return 'busy';
  }
  if (!statuses) return 'unknown';
  return sessions.some((session) => session.id in statuses) ? 'busy' : 'free';
}
