import type { Session } from '@/lib/opencode/model';
import { isChatDirectoryPath } from '@/lib/chatDirectories';
import { normalizePath } from '@/lib/pathNormalization';
import { getSessionActivityTime } from '@/sync/session-ordering';

export const sessionTabChatsScope = (runtimeKey: string): string => `${runtimeKey}|chats`;

export const sessionTabScopeFor = (runtimeKey: string, directory: string | null): string | null => {
  if (isChatDirectoryPath(directory)) return sessionTabChatsScope(runtimeKey);
  const normalized = normalizePath(directory);
  return normalized ? `${runtimeKey}|${normalized}` : null;
};

export const sessionTabSeedFor = (
  directory: string | null,
  sessions: readonly Session[],
  projectRoots: readonly string[],
): string[] => {
  const normalized = normalizePath(directory);
  if (!normalized || isChatDirectoryPath(normalized)) return [];
  if (projectRoots.some((root) => normalizePath(root) === normalized)) return [];
  return sessions
    .filter((session) => !session.parentID && !session.time?.archived && normalizePath(session.directory ?? null) === normalized)
    .sort((left, right) => getSessionActivityTime(right) - getSessionActivityTime(left))
    .map((session) => session.id);
};
