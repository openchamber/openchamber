import type { Session } from '@/lib/opencode/model';
import type { SessionGroup } from '../types';

/**
 * The sessions "Archive all" takes from a project: every top-level session in
 * its groups, minus the ones the user still wants in front of them. Their
 * subagents join through `withArchiveAllSubtrees`, and the archived bucket is
 * already archived.
 */
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

/** A top-level session "Archive all" takes, with the subagents that go along. */
type ArchiveAllTarget = { id: string; descendantIds: readonly string[] };

/**
 * The server does not cascade an archive, so each session's subagents go in
 * the same batch, or they would stay active as orphan rows. A session whose
 * subagent is still running stays, as a running session itself does.
 */
export const withArchiveAllSubtrees = (
  rootIds: readonly string[],
  descendantIdsOf: (rootId: string) => readonly string[],
  isBusy: (sessionId: string) => boolean,
): ArchiveAllTarget[] => rootIds.flatMap((id) => {
  const descendantIds = descendantIdsOf(id);
  return descendantIds.some(isBusy) ? [] : [{ id, descendantIds }];
});

/**
 * The outcome in top-level sessions, the rows the dialog counted: one counts
 * as archived when it and all its subagents were, and as failed when any of
 * them was not, since a subagent left behind stays as a row of its own.
 */
export const countArchiveAllOutcome = (
  targets: readonly ArchiveAllTarget[],
  failedIds: readonly string[],
) => {
  const failed = new Set(failedIds);
  const failedCount = targets.filter(({ id, descendantIds }) => failed.has(id) || descendantIds.some((descendantId) => failed.has(descendantId))).length;
  return { archived: targets.length - failedCount, failed: failedCount };
};
