/**
 * Names the task a session works on, for the agent (`work.name` in the
 * openchamber tool).
 *
 * A worktree's task name is its branch description (see
 * `setWorktreeTaskTitle` in `lib/git`). Session titles are never changed here.
 *
 * A name the user gave wins. The agent's call then changes nothing and answers
 * with the current name, so it can stop asking.
 *
 * A worktree whose branch is still OpenChamber's placeholder (Quick worktree's
 * `kinetic-zebra`, or an issue's `issue-180-merry-salamander`, which keeps its
 * number; never pushed) gets its branch named in the same call: the
 * call requires `branch` and renames it. Asked for in prose beside the
 * checkout, weaker models named the task and went on; a call that refuses
 * without the branch, and says why, they answer at once. Any other branch (the
 * user's, a pushed one, the main checkout's) is not the agent's to rename, so
 * `branch` is not required there and changes nothing.
 */

import { z } from 'zod';

const TITLE_MAX_LENGTH = 120;

const textSchema = z.string().trim().catch('');
const asText = (value) => textSchema.parse(value);

const openchamberSchema = z.object({ openchamber: z.record(z.string(), z.json()) });
const openchamberOf = (session) => openchamberSchema.safeParse(session?.metadata).data?.openchamber ?? {};
const directoryOf = (session) => asText(session?.location?.directory) || asText(session?.directory);

const normalizeDirectory = (value) => asText(value).replace(/\\/g, '/').replace(/\/+$/, '');

/** The deepest checkout containing the directory, excluding the main checkout listed first. */
export const linkedWorktreeOf = (directory, checkouts) => {
  const target = normalizeDirectory(directory);
  let match = null;
  checkouts.forEach((checkout, index) => {
    const root = normalizeDirectory(checkout?.path);
    if (!root || (target !== root && !target.startsWith(`${root}/`))) return;
    if (!match || root.length > match.root.length) match = { root, path: checkout.path, main: index === 0 };
  });
  return match && !match.main ? match.path : null;
};

const workTitleSchema = z.object({ title: z.string().trim().min(1), by: z.string().optional() });
const readWorkTitle = (session) => {
  const value = workTitleSchema.safeParse(openchamberOf(session).workTitle).data;
  return value ?? null;
};

/**
 * @param {object} dependencies
 * @param {(sessionID: string) => Promise<object|null>} dependencies.getSession OpenCode's session record, or null when unknown
 * @param {(directory: string) => Promise<Array<{ path: string }>>} dependencies.listWorktrees the repository's checkouts, the main one first
 * @param {(directory: string, input: { title: string, by: 'agent'|'user' }) => Promise<object>} dependencies.setWorktreeTaskTitle
 * @param {(directory: string) => Promise<string|null>} [dependencies.readPlaceholderBranch] the worktree's branch while it is OpenChamber's unpushed placeholder, else null
 * @param {(directory: string, name: string) => Promise<{ from: string, to: string }|null>} [dependencies.renamePlaceholderBranch]
 * @param {(directory: string, title: string) => Promise<object|null>} [dependencies.nameSpaceTask] the server inside a space's persisted task name
 * @param {(message: string, status: number) => Error} dependencies.createError
 */
export const createWorkNamer = ({
  getSession,
  listWorktrees,
  setWorktreeTaskTitle,
  readPlaceholderBranch = async () => null,
  renamePlaceholderBranch = async () => null,
  nameSpaceTask = async () => null,
  createError,
}) => {
  /** The linked worktree holding `directory`, or null for the main checkout and plain folders. */
  const findLinkedWorktree = async (directory) => {
    try {
      return linkedWorktreeOf(directory, await listWorktrees(directory));
    } catch {
      return null;
    }
  };

  // Said whenever the agent passed a branch that was not renamed, so it does
  // not take the call for a rename.
  const BRANCH_KEPT = { branchRenamed: false, branchNote: 'Only a placeholder branch OpenChamber generated is renamed here; this one stays as it is.' };

  /** Renames a placeholder branch after the task; requires `branch` while it is one. */
  const nameBranch = async (worktree, rawBranch) => {
    const branch = asText(rawBranch);
    const placeholder = await readPlaceholderBranch(worktree).catch(() => null);
    if (!placeholder) return branch ? BRANCH_KEPT : {};
    if (!branch) {
      throw createError(
        `This worktree's branch \`${placeholder}\` is a placeholder OpenChamber generated, and it is not pushed.`
          + ' Call work.name again with both title and branch: the branch named after the task, following the naming'
          + " the repository's other branches use (`git branch -a`); with none, `<type>/<short-kebab-case>` with the"
          + ' conventional commit types, such as `fix/login-timeout`. No tool or app prefix. Nothing was named yet.',
        400,
      );
    }
    try {
      const renamed = await renamePlaceholderBranch(worktree, branch);
      return renamed ? { branch: renamed.to, branchRenamed: true } : BRANCH_KEPT;
    } catch (error) {
      throw createError(error instanceof Error ? error.message : String(error), Number(error?.status) || 500);
    }
  };

  const name = async ({ sessionId, title: rawTitle, branch: rawBranch }) => {
    if (!sessionId) throw createError('sessionId is required when the call does not come from a session', 400);
    const title = asText(rawTitle).split(/\r?\n/)[0].trim().slice(0, TITLE_MAX_LENGTH);
    if (!title) throw createError('title is required', 400);
    const session = await getSession(sessionId);
    if (!session) throw createError(`Session not found: ${sessionId}`, 404);
    const directory = directoryOf(session);

    const space = await nameSpaceTask(directory, title);
    if (space) return space;

    const worktree = directory ? await findLinkedWorktree(directory) : null;
    if (worktree) {
      const branch = await nameBranch(worktree, rawBranch);
      const result = await setWorktreeTaskTitle(worktree, { title, by: 'agent' });
      return result.applied
        ? { task: 'worktree', title: result.title, named: true, ...branch }
        : { task: 'worktree', title: result.title, named: false, reason: 'The user named this task; keep their name.', ...branch };
    }

    const branchKept = asText(rawBranch) ? BRANCH_KEPT : {};
    return { task: 'session', sessionId: session.id, title: asText(session.title), named: false,
      reason: 'Tasks in the main checkout or a plain folder use their session titles. Nothing needs naming here.', ...branchKept };
  };

  /**
   * A session moved into a new worktree takes its task's name along. The
   * worktree's row is named by its branch description, which a new branch
   * does not have, and the agent does not name a task twice, so without this
   * the row would show the bare branch. Explicit user ownership stays; every
   * other current session title seeds an agent-owned name.
   */
  const carryToWorktree = async ({ sessionId, worktree }) => {
    const session = await getSession(sessionId);
    const current = asText(session?.title);
    if (!current) return null;
    const by = readWorkTitle(session)?.by === 'user' ? 'user' : 'agent';
    return setWorktreeTaskTitle(worktree, { title: current, by });
  };

  return { name, carryToWorktree };
};
