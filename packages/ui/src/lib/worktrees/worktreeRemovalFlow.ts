import type { Session } from '@/lib/opencode/model';
import { normalizePath } from '@/lib/pathNormalization';
import { checkoutHoldsDirectory } from '@/lib/worktrees/worktreePaths';

export const isWorktreeTeardownFailure = (error: Error): boolean => (
  'code' in error && error.code === 'WORKTREE_TEARDOWN_FAILED'
);

export const deleteWithoutTeardownToast = (
  error: Error,
  label: string,
  retryWithoutTeardown: () => void,
): { action: { label: string; onClick: () => void }; duration: number } | undefined => (
  isWorktreeTeardownFailure(error) ? { action: { label, onClick: retryWithoutTeardown }, duration: Infinity } : undefined
);

export type SessionArchiveResult = {
  archivedIds: string[];
  failedIds: string[];
};

export async function archiveSessionsThenRemoveWorktree(options: {
  sessionIds: string[];
  removeWorktree: (archivedIds: string[]) => Promise<boolean>;
  archiveSessions: (sessionIds: string[]) => Promise<SessionArchiveResult>;
  restoreSessions: (sessionIds: string[]) => Promise<{ failedIds: string[] }>;
}): Promise<{ removed: boolean; archive: SessionArchiveResult }> {
  const archive = options.sessionIds.length > 0
    ? await options.archiveSessions(options.sessionIds)
    : { archivedIds: [], failedIds: [] };
  const restore = async () => {
    if (archive.archivedIds.length === 0) return;
    const { failedIds } = await options.restoreSessions(archive.archivedIds)
      .catch(() => ({ failedIds: archive.archivedIds }));
    if (failedIds.length > 0) {
      console.warn(`[worktrees] ${failedIds.length} session(s) stay archived after the worktree removal failed`);
    }
  };

  let removed: boolean;
  try {
    removed = await options.removeWorktree(archive.archivedIds);
  } catch (error) {
    await restore();
    throw error;
  }
  if (removed) return { removed, archive };
  await restore();
  return { removed, archive: { archivedIds: [], failedIds: [] } };
}

export type WorktreeKeepStop = 'busy' | 'unknown' | 'added' | 'unconfirmed' | 'switched';

const STOP_MESSAGES = {
  busy: 'A session in the worktree is still running',
  unknown: 'Could not read whether a session in the worktree is running',
  added: 'A session started in the worktree while the others moved',
  unconfirmed: 'The server had not applied a session move in time',
  switched: 'The server changed before the worktree was removed',
} satisfies Record<WorktreeKeepStop, string>;

export class WorktreeKeepStoppedError extends Error {
  readonly reason: WorktreeKeepStop;

  constructor(reason: WorktreeKeepStop) {
    super(STOP_MESSAGES[reason]);
    this.name = 'WorktreeKeepStoppedError';
    this.reason = reason;
  }
}

export type SessionTreeInFolder = {
  root: Session;
  descendants: Session[];
  sourceDirectory: string;
};

export const groupSessionTreesByFolder = (sessions: readonly Session[]): SessionTreeInFolder[] => {
  const byFolder = new Map<string, Session[]>();
  for (const session of sessions) {
    const folder = normalizePath(session.directory);
    if (!folder) continue;
    const members = byFolder.get(folder);
    if (members) members.push(session);
    else byFolder.set(folder, [session]);
  }
  return [...byFolder.entries()].flatMap(([sourceDirectory, members]) => {
    const ids = new Set(members.map((session) => session.id));
    const childrenById = new Map<string, Session[]>();
    for (const session of members) {
      if (!session.parentID || !ids.has(session.parentID)) continue;
      const siblings = childrenById.get(session.parentID);
      if (siblings) siblings.push(session);
      else childrenById.set(session.parentID, [session]);
    }
    const descendantsOf = (id: string): Session[] => (childrenById.get(id) ?? [])
      .flatMap((child) => [child, ...descendantsOf(child.id)]);
    return members
      .filter((session) => !session.parentID || !ids.has(session.parentID))
      .map((root) => ({ root, descendants: descendantsOf(root.id).reverse(), sourceDirectory }));
  });
};

export async function moveSessionsThenRemoveWorktree(options: {
  worktreePath: string;
  readSessions: () => readonly Session[];
  readActivity: (sessions: readonly Session[]) => Promise<'active' | 'idle' | 'unknown'>;
  resolveDestination: (directory: string) => Promise<string>;
  moveTree: (tree: SessionTreeInFolder & { projectDirectory: string }) => Promise<void>;
  confirmMoves: (moves: readonly (SessionTreeInFolder & { projectDirectory: string })[]) => Promise<boolean>;
  removeWorktree: () => Promise<boolean>;
  isCurrent: () => boolean;
}): Promise<{ removed: boolean }> {
  const assertCurrent = () => {
    if (!options.isCurrent()) throw new WorktreeKeepStoppedError('switched');
  };
  const sessions = options.readSessions();
  if (sessions.length > 0) {
    const activity = await options.readActivity(sessions);
    assertCurrent();
    if (activity === 'unknown') throw new WorktreeKeepStoppedError('unknown');
    if (activity === 'active') throw new WorktreeKeepStoppedError('busy');
  }
  if (sessions.some((session) => !normalizePath(session.directory))) throw new Error('A session in the worktree has no folder');
  const worktreePath = normalizePath(options.worktreePath) ?? options.worktreePath;
  const moves = await Promise.all(groupSessionTreesByFolder(sessions).map(async (tree) => ({
    ...tree,
    projectDirectory: await options.resolveDestination(tree.sourceDirectory),
  })));
  const doomed = moves.find((move) => checkoutHoldsDirectory(worktreePath, normalizePath(move.projectDirectory) ?? move.projectDirectory));
  if (doomed) throw new Error(`The project folder ${doomed.projectDirectory} is inside the worktree`);
  for (const move of moves) {
    assertCurrent();
    await options.moveTree(move);
  }
  // external: https://github.com/anomalyco/opencode/blob/v2.3.0/packages/core/src/session/move.ts OpenCode queues moves before applying them in the source folder's runner.
  const confirmed = moves.length === 0 || await options.confirmMoves(moves);
  assertCurrent();
  if (!confirmed) throw new WorktreeKeepStoppedError('unconfirmed');
  const movedIds = new Set(sessions.map((session) => session.id));
  if (options.readSessions().some((session) => !movedIds.has(session.id))) throw new WorktreeKeepStoppedError('added');
  return { removed: await options.removeWorktree() };
}
