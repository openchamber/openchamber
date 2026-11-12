import type { Session } from '@/lib/opencode/model';
import { normalizePath } from '@/lib/pathNormalization';
import { checkoutHoldsDirectory } from '@/lib/worktrees/worktreePaths';

/**
 * A delete stopped by the project's teardown commands. The server, the
 * extension host and the bridge carry the code on the error they throw.
 */
export const isWorktreeTeardownFailure = (error: Error): boolean => (
  'code' in error && error.code === 'WORKTREE_TEARDOWN_FAILED'
);

/**
 * The failure toast's options for a delete its teardown commands stopped: an
 * action that repeats the delete with every option the user picked and no
 * teardown. Only a click runs it; nothing skips a teardown on its own. The
 * toast stays until it is answered or closed, like the app's other toasts that
 * wait for a decision.
 */
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

/**
 * Archives a worktree's sessions, then removes (or archives) the worktree. The sessions go
 * first because OpenCode can change a session only while its directory exists:
 * archived after the removal, each one would have to move to the project's
 * main folder first and carry a "moved" note in its transcript. A removal that
 * fails or throws restores the sessions it archived, so no archived session
 * stays attached to a worktree still on disk; a throw is passed on after that.
 */
export async function archiveSessionsThenRemoveWorktree(options: {
  sessionIds: string[];
  /** Gets the sessions it archived: an archive of the worktree records them. */
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

/**
 * Why keeping the sessions stopped with the worktree still on disk: a session
 * there runs, whether one runs could not be read, a session started there
 * while the others moved, the server had not yet applied a move, or the app
 * switched to another server meanwhile.
 */
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
  /** Deepest first, so a subsession moves before its parent. */
  descendants: Session[];
  sourceDirectory: string;
};

/**
 * The sessions as trees that each sit in one folder: a tree move relocates
 * every member from a single source folder, so a subsession working in another
 * folder of the checkout heads a tree of its own. The order comes from the
 * parent links, never from the order of `sessions`.
 */
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
    // Parents before their children, reversed below.
    const descendantsOf = (id: string): Session[] => (childrenById.get(id) ?? [])
      .flatMap((child) => [child, ...descendantsOf(child.id)]);
    return members
      .filter((session) => !session.parentID || !ids.has(session.parentID))
      .map((root) => ({ root, descendants: descendantsOf(root.id).reverse(), sourceDirectory }));
  });
};

/**
 * Moves a worktree's sessions to their projects, then removes the worktree.
 * The moves go first, while the folder exists, for the reason the archive
 * goes first above. A running session stops it before anything moves: a move
 * needs idle sessions. Each tree moves through the tree move a chat takes into
 * a project, which rolls back its own tree when a move fails; trees moved
 * before a failure stay in the project, where they work, and the worktree
 * stays. The removal waits until the server has applied every move; the
 * worktree also stays when it did not in time, a session started there
 * meanwhile, or the app switched servers. After a failed removal the sessions
 * stay in the project too: moving them back adds another "moved" note to each
 * transcript, and git may already have removed the folder before it failed on
 * the branch.
 */
export async function moveSessionsThenRemoveWorktree(options: {
  worktreePath: string;
  /** The active sessions working in the worktree now, its subfolders included. */
  readSessions: () => readonly Session[];
  /** Whether any of `sessions` runs; unknown when nothing can say. */
  readActivity: (sessions: readonly Session[]) => Promise<'active' | 'idle' | 'unknown'>;
  /** The project folder a session working in `directory` belongs to. */
  resolveDestination: (directory: string) => Promise<string>;
  moveTree: (tree: SessionTreeInFolder & { projectDirectory: string }) => Promise<void>;
  /** True once the server places every session of `moves` in its project; false when it did not in time. */
  confirmMoves: (moves: readonly (SessionTreeInFolder & { projectDirectory: string })[]) => Promise<boolean>;
  removeWorktree: () => Promise<boolean>;
  /** False once the app talks to another server than when the delete began. */
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
  // A session with no folder fits no tree, and would stay behind unmoved.
  if (sessions.some((session) => !normalizePath(session.directory))) throw new Error('A session in the worktree has no folder');
  const worktreePath = normalizePath(options.worktreePath) ?? options.worktreePath;
  const moves = await Promise.all(groupSessionTreesByFolder(sessions).map(async (tree) => ({
    ...tree,
    projectDirectory: await options.resolveDestination(tree.sourceDirectory),
  })));
  // A project registered inside the checkout goes with it, and so would a
  // session moved there.
  const doomed = moves.find((move) => checkoutHoldsDirectory(worktreePath, normalizePath(move.projectDirectory) ?? move.projectDirectory));
  if (doomed) throw new Error(`The project folder ${doomed.projectDirectory} is inside the worktree`);
  for (const move of moves) {
    assertCurrent();
    await options.moveTree(move);
  }
  // OpenCode answers a move once it is queued and applies it afterwards, in a
  // runner of the source folder that removing the folder would stop.
  const confirmed = moves.length === 0 || await options.confirmMoves(moves);
  // Reads after a server switch go to the new server, which does not know the
  // sessions: say that instead of blaming the moves.
  assertCurrent();
  if (!confirmed) throw new WorktreeKeepStoppedError('unconfirmed');
  // Only a session that was not there before counts: the server now places
  // each of those in its project, while the local list, refreshed while a
  // move was still queued, can place one in the worktree for a moment.
  const movedIds = new Set(sessions.map((session) => session.id));
  if (options.readSessions().some((session) => !movedIds.has(session.id))) throw new WorktreeKeepStoppedError('added');
  return { removed: await options.removeWorktree() };
}
