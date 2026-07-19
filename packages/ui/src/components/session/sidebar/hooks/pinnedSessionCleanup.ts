import type { Session } from '@opencode-ai/sdk/v2';
import { resolveGlobalSessionDirectory } from '@/stores/useGlobalSessionsStore';
import { getPinnedSessionKey, parsePinnedSessionKey } from '@/stores/useSessionPinnedStore';

export const prunePinnedSessionIds = (
  runtimeKey: string,
  sessions: Session[],
  pinnedSessionIds: Set<string>,
): Set<string> => {
  const existingPinnedKeys = new Set<string>();
  for (const session of sessions) {
    const directory = resolveGlobalSessionDirectory(session);
    const key = directory ? getPinnedSessionKey(runtimeKey, directory, session.id) : null;
    if (key) existingPinnedKeys.add(key);
  }

  let changed = false;
  const next = new Set<string>();

  pinnedSessionIds.forEach((key) => {
    const parsed = parsePinnedSessionKey(key);
    if (parsed && (parsed[0] !== runtimeKey || existingPinnedKeys.has(key))) {
      next.add(key);
      return;
    }
    changed = true;
  });

  return changed ? next : pinnedSessionIds;
};
