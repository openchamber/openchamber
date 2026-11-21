import type { Session } from '@/lib/opencode/model';
import { getChatsRoot, isChatDirectoryPath } from '@/lib/chatDirectories';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { memoizeSessionListProjection } from '@/stores/sessionListProjection';
import type { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';

import { normalizePath } from './mobilePaths';


export const getSessionDirectory = (session: Session): string => {
  const sessionWithDirectory = session as Session & {
    directory?: string | null;
    project?: { worktree?: string | null } | null;
  };
  return normalizePath(sessionWithDirectory.directory ?? sessionWithDirectory.project?.worktree ?? null);
};

const hasChats = memoizeSessionListProjection((sessions: Session[], _root: string | null, _runtime: string) =>
  sessions.some((session) => isChatDirectoryPath(getSessionDirectory(session))));

export const selectHasChats = (state: ReturnType<typeof useGlobalSessionsStore.getState>): boolean =>
  hasChats(state.activeSessions, getChatsRoot(), getRuntimeKey());
