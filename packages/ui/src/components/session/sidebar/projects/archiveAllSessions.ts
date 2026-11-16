import type { Session } from '@/lib/opencode/model';
import type { SessionGroup } from '../types';

export const selectArchiveAllSessionIds = (
  groups: readonly SessionGroup[],
  isKept: (session: Session) => boolean,
): string[] => {
  const ids = new Set<string>();
  for (const group of groups) {
    if (group.isArchivedBucket) continue;
    for (const node of group.sessions) {
      const { session } = node;
      if (session.time?.archived) continue;
      if (isKept(session)) continue;
      ids.add(session.id);
    }
  }
  return [...ids];
};

type ArchiveAllTarget = { id: string; descendantIds: readonly string[] };

export const withArchiveAllSubtrees = (
  rootIds: readonly string[],
  descendantIdsOf: (rootId: string) => readonly string[],
  isBusy: (sessionId: string) => boolean,
): ArchiveAllTarget[] => rootIds.flatMap((id) => {
  const descendantIds = descendantIdsOf(id);
  return descendantIds.some(isBusy) ? [] : [{ id, descendantIds }];
});

export const countArchiveAllOutcome = (
  targets: readonly ArchiveAllTarget[],
  failedIds: readonly string[],
) => {
  const failed = new Set(failedIds);
  const failedCount = targets.filter(({ id, descendantIds }) => failed.has(id) || descendantIds.some((descendantId) => failed.has(descendantId))).length;
  return { archived: targets.length - failedCount, failed: failedCount };
};
