import type { Session } from '@opencode-ai/sdk/v2/client';

import { getRuntimeKey } from '@/lib/runtime-switch';
import { computeSubtreeIds } from '@/sync/scoped-blocking-requests';

const isArchived = (session: Session): boolean => Boolean(session.time?.archived);

export type ArchiveSessionsResult = { archivedIds: string[]; failedIds: string[] };
type DeleteSessionsResult = { deletedIds: string[]; failedIds: string[] };

type MobileSessionMutationOptions = {
  expectedRuntimeKey: string;
  directory: string | null;
};

type MobileSessionTarget = {
  id: string;
  directory: string | null;
};

type ArchiveSessionsFn = (
  ids: string[],
  options?: MobileSessionMutationOptions,
) => Promise<ArchiveSessionsResult>;

type DeleteSessionsFn = (
  ids: string[],
  options?: MobileSessionMutationOptions,
) => Promise<DeleteSessionsResult>;

type CaptureDirectory = (sessionId: string, session?: Session) => string | null | undefined;

export const excludeArchivedMobileSessions = (
  sessions: Session[],
  archivedSessions: Session[],
): Session[] => {
  const archivedIds = new Set(archivedSessions.map((session) => session.id));
  return sessions.filter((session) => !isArchived(session) && !archivedIds.has(session.id));
};

const getSessionDirectory = (session?: Session): string | null => {
  if (!session) return null;
  const record = session as Session & {
    directory?: string | null;
    project?: { worktree?: string | null } | null;
  };
  const directory = record.directory ?? record.project?.worktree ?? null;
  return typeof directory === 'string' && directory.trim().length > 0 ? directory : null;
};

const collectMobileSessionTargets = (args: {
  sessions: Session[];
  rootId: string;
  includeArchived: boolean;
  captureDirectory?: CaptureDirectory;
}): MobileSessionTarget[] => {
  const subtreeIds = computeSubtreeIds(args.sessions, args.rootId);
  const archivedIds = new Set(args.sessions.filter(isArchived).map((session) => session.id));
  const sessionById = new Map<string, Session>();
  for (const session of args.sessions) {
    if (!sessionById.has(session.id)) sessionById.set(session.id, session);
  }

  const targetIds = [...subtreeIds].filter((id) => (
    args.includeArchived || id === args.rootId || !archivedIds.has(id)
  ));

  // Resolve every target while the full snapshot and its stores still exist.
  // The executor must never rediscover a directory after an earlier delete.
  return targetIds.map((id) => {
    const session = sessionById.get(id);
    const capturedDirectory = args.captureDirectory?.(id, session);
    return {
      id,
      directory: getSessionDirectory(session) ?? capturedDirectory ?? null,
    };
  });
};

/** IDs to archive: the root plus known active descendants, root first. */
export const collectMobileArchiveTargetIds = (sessions: Session[], rootId: string): string[] => (
  collectMobileSessionTargets({ sessions, rootId, includeArchived: false }).map((target) => target.id)
);

/** IDs to delete: the root plus every known descendant, including archived ones. */
export const collectMobileDeleteTargetIds = (sessions: Session[], rootId: string): string[] => (
  collectMobileSessionTargets({ sessions, rootId, includeArchived: true }).map((target) => target.id)
);

type ExecuteMobileSessionSubtreeArgs = {
  targets: MobileSessionTarget[];
  expectedRuntimeKey: string;
  mutate: (target: MobileSessionTarget, options: MobileSessionMutationOptions) => Promise<boolean>;
};

type ExecuteMobileSessionSubtreeResult = {
  completedIds: string[];
  failedIds: string[];
  targetCount: number;
};

/**
 * Runs one captured target at a time in post-order. A failed target blocks all
 * remaining targets, including siblings and ancestors, so a partial operation
 * never removes an ancestor whose known subtree was not handled.
 */
const executeMobileSessionSubtree = async (
  args: ExecuteMobileSessionSubtreeArgs,
): Promise<ExecuteMobileSessionSubtreeResult> => {
  const completedIds: string[] = [];
  const failedIds: string[] = [];
  const targetCount = args.targets.length;
  const orderedTargets = [...args.targets].reverse();

  for (let index = 0; index < orderedTargets.length; index += 1) {
    const target = orderedTargets[index];
    if (getRuntimeKey() !== args.expectedRuntimeKey) {
      failedIds.push(...orderedTargets.slice(index).map((entry) => entry.id));
      break;
    }

    let completed = false;
    try {
      completed = await args.mutate(target, {
        expectedRuntimeKey: args.expectedRuntimeKey,
        directory: target.directory,
      });
    } catch {
      completed = false;
    }

    if (!completed || getRuntimeKey() !== args.expectedRuntimeKey) {
      failedIds.push(...orderedTargets.slice(index).map((entry) => entry.id));
      break;
    }
    completedIds.push(target.id);
  }

  return { completedIds, failedIds, targetCount };
};

/**
 * Archives a swiped mobile row and its known active subtree. Already archived
 * descendants are traversed through but are not sent to the server, so they are
 * not retimestamped. Children missing from the snapshot cannot be targeted by
 * the client; their archive behavior remains defined by the backend.
 */
export const archiveMobileSessionSubtree = async (args: {
  sessions: Session[];
  rootId: string;
  expectedRuntimeKey: string;
  archiveSessions: ArchiveSessionsFn;
  captureDirectory?: CaptureDirectory;
}): Promise<ArchiveSessionsResult & { targetCount: number }> => {
  const result = await executeMobileSessionSubtree({
    targets: collectMobileSessionTargets({
      sessions: args.sessions,
      rootId: args.rootId,
      includeArchived: false,
      captureDirectory: args.captureDirectory,
    }),
    expectedRuntimeKey: args.expectedRuntimeKey,
    mutate: async (target, options) => {
      const response = await args.archiveSessions([target.id], options);
      return response.archivedIds.includes(target.id) && response.failedIds.length === 0;
    },
  });

  return {
    archivedIds: result.completedIds,
    failedIds: result.failedIds,
    targetCount: result.targetCount,
  };
};

/** Hard-deletes a row and every known descendant, including archived ones; unknown children rely on the backend cascade. */
export const deleteMobileSessionSubtree = async (args: {
  sessions: Session[];
  rootId: string;
  expectedRuntimeKey: string;
  deleteSessions: DeleteSessionsFn;
  captureDirectory?: CaptureDirectory;
}): Promise<DeleteSessionsResult & { targetCount: number }> => {
  const result = await executeMobileSessionSubtree({
    targets: collectMobileSessionTargets({
      sessions: args.sessions,
      rootId: args.rootId,
      includeArchived: true,
      captureDirectory: args.captureDirectory,
    }),
    expectedRuntimeKey: args.expectedRuntimeKey,
    mutate: async (target, options) => {
      const response = await args.deleteSessions([target.id], options);
      return response.deletedIds.includes(target.id) && response.failedIds.length === 0;
    },
  });

  return {
    deletedIds: result.completedIds,
    failedIds: result.failedIds,
    targetCount: result.targetCount,
  };
};
