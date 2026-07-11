import type { Session } from '@opencode-ai/sdk/v2';

export const prunePinnedSessionIds = (
  sessions: Array<Pick<Session, 'id'>>,
  pinnedSessionIds: Set<string>,
): Set<string> => {
  const existingSessionIds = new Set(sessions.map((session) => session.id));
  let changed = false;
  const next = new Set<string>();

  pinnedSessionIds.forEach((id) => {
    if (existingSessionIds.has(id)) {
      next.add(id);
      return;
    }
    changed = true;
  });

  return changed ? next : pinnedSessionIds;
};
