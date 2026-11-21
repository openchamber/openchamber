
import { z } from 'zod';
import { readLead } from '../session-lead/metadata.js';
import type { setWorktreeTaskTitle as setWorktreeTaskTitleDefault } from '../git/service.js';
import type { SessionInfo } from '@opencode/client';

const TITLE_MAX_LENGTH = 120;

interface WorkNameInput {
  sessionId: string | null;
  title: unknown;
  branch?: unknown;
}

const textSchema = z.string().trim().catch('');
const asText = (value: WorkNameInput['title']) => textSchema.parse(value);

interface NamingSession {
  id: string;
  metadata?: SessionInfo['metadata'];
  location?: { directory?: string };
  directory?: string;
  title?: string;
}

const openchamberSchema = z.object({ openchamber: z.record(z.string(), z.json()) });
const openchamberOf = (session: NamingSession | null) => openchamberSchema.safeParse(session?.metadata).data?.openchamber ?? {};
const directoryOf = (session: NamingSession) => asText(session?.location?.directory) || asText(session?.directory);

const normalizeDirectory = (value: string) => asText(value).replace(/\\/g, '/').replace(/\/+$/, '');

export const linkedWorktreeOf = (directory: string, checkouts: { path: string }[]) => {
  const target = normalizeDirectory(directory);
  let match: { root: string; path: string; main: boolean } | null = null;
  for (const [index, checkout] of checkouts.entries()) {
    const root = normalizeDirectory(checkout?.path);
    if (!root || (target !== root && !target.startsWith(`${root}/`))) continue;
    if (!match || root.length > match.root.length) match = { root, path: checkout.path, main: index === 0 };
  }
  return match && !match.main ? match.path : null;
};

const workTitleSchema = z.object({ title: z.string().trim().min(1), by: z.string().optional() });
const readWorkTitle = (session: NamingSession | null) => {
  const value = workTitleSchema.safeParse(openchamberOf(session).workTitle).data;
  return value ?? null;
};

interface WorkNamingDependencies {
  getSession: (sessionID: string) => Promise<NamingSession | null>;
  renameSession?: ((sessionID: string, title: string) => Promise<void>) | null;
  listWorktrees: (directory: string) => Promise<{ path: string }[]>;
  setWorktreeTaskTitle: typeof setWorktreeTaskTitleDefault;
  readPlaceholderBranch?: (directory: string) => Promise<string | null>;
  renamePlaceholderBranch?: (directory: string, name: string) => Promise<{ from: string; to: string } | null>;
  nameSpaceTask?: (directory: string, title: string) => object | null | Promise<object | null>;
  createError: (message: string, status: number) => Error;
}

const hasStatus = (value: unknown): value is { status: unknown } =>
  value !== null && value !== undefined && 'status' in Object(value);

export const createWorkNamer = ({
  getSession,
  renameSession = null,
  listWorktrees,
  setWorktreeTaskTitle,
  readPlaceholderBranch = async () => null,
  renamePlaceholderBranch = async () => null,
  nameSpaceTask = async () => null,
  createError,
}: WorkNamingDependencies) => {
  const findLinkedWorktree = async (directory: string) => {
    try {
      return linkedWorktreeOf(directory, await listWorktrees(directory));
    } catch {
      return null;
    }
  };

  const BRANCH_KEPT = { branchRenamed: false, branchNote: 'Only a placeholder branch OpenChamber generated is renamed here; this one stays as it is.' };

  const nameBranch = async (worktree: string, rawBranch: WorkNameInput['branch']) => {
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
      throw createError(error instanceof Error ? error.message : String(error), Number(hasStatus(error) ? error.status : undefined) || 500);
    }
  };

  const name = async ({ sessionId, title: rawTitle, branch: rawBranch }: WorkNameInput) => {
    if (!sessionId) throw createError('sessionId is required when the call does not come from a session', 400);
    const title = (asText(rawTitle).split(/\r?\n/)[0] ?? '').trim().slice(0, TITLE_MAX_LENGTH);
    if (!title) throw createError('title is required', 400);
    const session = await getSession(sessionId);
    if (!session) throw createError(`Session not found: ${sessionId}`, 404);
    const directory = directoryOf(session);

    if (readLead(session.metadata) && renameSession) {
      if (readWorkTitle(session)?.by === 'user') {
        return { task: 'lead', sessionId: session.id, title: asText(session.title), named: false, reason: 'The user named this lead; keep their name.' };
      }
      if (asText(session.title) !== title) await renameSession(session.id, title);
      return { task: 'lead', sessionId: session.id, title, named: true };
    }

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

  const carryToWorktree = async ({ sessionId, worktree }: { sessionId: string; worktree: string }) => {
    const session = await getSession(sessionId);
    const current = asText(session?.title);
    if (!current) return null;
    const by = readWorkTitle(session)?.by === 'user' ? 'user' : 'agent';
    return setWorktreeTaskTitle(worktree, { title: current, by });
  };

  return { name, carryToWorktree };
};
