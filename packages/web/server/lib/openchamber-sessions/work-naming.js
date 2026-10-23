/**
 * Names the task a session works on, for the agent (`work.name` in the
 * openchamber tool).
 *
 * A task is what the sidebar lists as one entry: a linked worktree with all
 * its sessions, or a session in the main checkout together with the sessions
 * that grew out of it there (an auto-review, a fork, a session an agent
 * dispatched from it). A worktree's name is its branch description (see
 * `setWorktreeTaskTitle` in `lib/git`); a main-checkout task's name is its
 * root session's title, with `metadata.openchamber.workTitle` recording who
 * gave it.
 *
 * A name the user gave wins. The agent's call then changes nothing and answers
 * with the current name, so it can stop asking.
 */

import { z } from 'zod';

const TITLE_MAX_LENGTH = 120;
// Origins chain (a review of a fork of a dispatched session); recorded
// metadata can loop, so the walk to the task's root session is bounded.
const MAX_ORIGIN_DEPTH = 16;

const textSchema = z.string().trim().catch('');
const asText = (value) => textSchema.parse(value);

const openchamberSchema = z.object({ openchamber: z.record(z.string(), z.json()) });
const openchamberOf = (session) => openchamberSchema.safeParse(session?.metadata).data?.openchamber ?? {};
const directoryOf = (session) => asText(session?.location?.directory) || asText(session?.directory);

const normalizeDirectory = (value) => asText(value).replace(/\\/g, '/').replace(/\/+$/, '');

/** The session this one grew out of, as the sidebar nests it (`lib/sessionWorkLineage.ts`). */
const originOf = (session) => {
  const parentID = asText(session?.parentID);
  if (parentID) return parentID;
  const openchamber = openchamberOf(session);
  if (openchamber.kind === 'review' && asText(openchamber.originalSessionID)) return asText(openchamber.originalSessionID);
  const forkSource = asText(session?.fork?.sessionID);
  if (forkSource) return forkSource;
  return asText(openchamber.originSessionID) || null;
};

const workTitleSchema = z.object({ title: z.string().trim().min(1), by: z.string().optional() });
const readWorkTitle = (session) => {
  const value = workTitleSchema.safeParse(openchamberOf(session).workTitle).data;
  return value ? { title: value.title, by: value.by === 'agent' ? 'agent' : 'user' } : null;
};

/**
 * @param {object} dependencies
 * @param {(sessionID: string) => Promise<object|null>} dependencies.getSession OpenCode's session record, or null when unknown
 * @param {(directory: string) => Promise<Array<{ path: string }>>} dependencies.listWorktrees the repository's checkouts, the main one first
 * @param {(directory: string, input: { title: string, by: 'agent' }) => Promise<object>} dependencies.setWorktreeTaskTitle
 * @param {(sessionID: string, title: string, directory: string) => Promise<void>} dependencies.renameSession
 * @param {(sessionID: string, decide: (metadata: object) => object|null, options: { directory: string }) => Promise<unknown>} dependencies.updateMetadata
 * @param {(message: string, status: number) => Error} dependencies.createError
 */
export const createWorkNamer = ({ getSession, listWorktrees, setWorktreeTaskTitle, renameSession, updateMetadata, createError }) => {
  /** The linked worktree holding `directory`, or null for the main checkout and plain folders. */
  const findLinkedWorktree = async (directory) => {
    const target = normalizeDirectory(directory);
    let checkouts;
    try {
      checkouts = await listWorktrees(directory);
    } catch {
      return null;
    }
    let match = null;
    checkouts.forEach((checkout, index) => {
      const root = normalizeDirectory(checkout?.path);
      if (!root || (target !== root && !target.startsWith(`${root}/`))) return;
      if (!match || root.length > match.root.length) match = { root, path: checkout.path, main: index === 0 };
    });
    return match && !match.main ? match.path : null;
  };

  /** The root session of the main-checkout task `session` belongs to. */
  const findTaskRoot = async (session) => {
    const directory = normalizeDirectory(directoryOf(session));
    const seen = new Set([session.id]);
    let root = session;
    for (let depth = 0; depth < MAX_ORIGIN_DEPTH; depth += 1) {
      const originID = originOf(root);
      if (!originID || seen.has(originID)) break;
      seen.add(originID);
      const origin = await getSession(originID).catch(() => null);
      if (!origin || origin.time?.archived || normalizeDirectory(directoryOf(origin)) !== directory) break;
      root = origin;
    }
    return root;
  };

  const name = async ({ sessionId, title: rawTitle }) => {
    if (!sessionId) throw createError('sessionId is required when the call does not come from a session', 400);
    const title = asText(rawTitle).split(/\r?\n/)[0].trim().slice(0, TITLE_MAX_LENGTH);
    if (!title) throw createError('title is required', 400);
    const session = await getSession(sessionId);
    if (!session) throw createError(`Session not found: ${sessionId}`, 404);
    const directory = directoryOf(session);

    const worktree = directory ? await findLinkedWorktree(directory) : null;
    if (worktree) {
      const result = await setWorktreeTaskTitle(worktree, { title, by: 'agent' });
      return result.applied
        ? { task: 'worktree', title: result.title, named: true }
        : { task: 'worktree', title: result.title, named: false, reason: 'The user named this task; keep their name.' };
    }

    const root = await findTaskRoot(session);
    const current = asText(root.title);
    const recorded = readWorkTitle(root);
    // The user named it, here or by renaming the session after the agent did.
    if (recorded && (recorded.by === 'user' || recorded.title !== current)) {
      return { task: 'session', sessionId: root.id, title: current, named: false, reason: 'The user named this task; keep their name.' };
    }
    if (current !== title) await renameSession(root.id, title, directoryOf(root));
    await updateMetadata(root.id, (metadata) => {
      const existing = readWorkTitle({ metadata });
      if (existing?.title === title && existing.by === 'agent') return null;
      return { openchamber: { workTitle: { title, by: 'agent' } } };
    }, { directory: directoryOf(root) });
    return { task: 'session', sessionId: root.id, title, named: true };
  };

  return { name };
};
