import type { Session } from '@opencode-ai/sdk/v2';
import { normalizePath } from '@/lib/pathNormalization';

type SessionDirectoryFields = Session & {
  directory?: string | null;
  project?: { id?: string | null; worktree?: string | null } | null;
  workspaceID?: string | null;
};

/**
 * The worktree a session's project record can vouch for, or null.
 *
 * OpenCode's placeholder "global" project reports `worktree: "/"` — the filesystem
 * root is a spelling of "nowhere", not a directory a session can belong to on this
 * computer. Sessions routed into a secure workspace arrive under that placeholder, and
 * taking "/" at face value sent the sidebar filter looking for a project that owns the
 * filesystem root and the status poller asking OpenCode about directory "/". No real
 * project roots at "/" either — the workspace plugin refuses to snapshot one.
 */
function ownedWorktree(record: SessionDirectoryFields): string | null {
  if (record.project?.id === 'global') return null;
  const worktree = normalizePath(record.project?.worktree ?? null);
  return worktree === '/' ? null : worktree;
}

/**
 * Where a secure workspace mounts the project it is working on. Every workspace uses the
 * same path, because it is a fresh container each time and nothing else lives there.
 */
const WORKSPACE_RUNTIME_DIRECTORY = '/workspace';

/**
 * Whether a reported directory is a path inside a workspace rather than on this computer.
 *
 * This is decided from the path itself, deliberately. `workspaceID` would be the better
 * signal, but OpenCode does not carry one on session records — asking it for sessions
 * scoped to a workspace returns exactly the same list as asking unscoped — so a session
 * that is plainly routed into a container arrives looking like an ordinary one. The path
 * is the only thing left that tells the truth.
 */
function isWorkspaceRuntimePath(value: string | null): boolean {
  if (!value) return false;
  return value === WORKSPACE_RUNTIME_DIRECTORY || value.startsWith(`${WORKSPACE_RUNTIME_DIRECTORY}/`);
}

/**
 * The directory on this computer that a session belongs to, or null when there is none.
 *
 * A session routed into a secure workspace reports the directory it works in, and that
 * directory is inside the container — `/workspace`, not a path here. Host-side state must
 * never take it. The file tree points at nothing; the value persists as `lastDirectory`,
 * so it outlives the session that introduced it; and on Windows it does not even stay
 * recognisable — `/workspace` resolves against the current drive, so the host OpenCode was
 * seen bootstrapping an instance for `C:\workspace` purely because such sessions existed
 * in the list. Paths are converted at the transport boundary, and this is that boundary.
 */
/** Whether a session record reports working inside a workspace container. */
export function isWorkspaceRuntimeSessionRecord(session: Session): boolean {
  const record = session as SessionDirectoryFields;
  return isWorkspaceRuntimePath(normalizePath(record.directory ?? null));
}

export function resolveSessionDirectoryKey(session: Session): string | null {
  const record = session as SessionDirectoryFields;
  const worktree = ownedWorktree(record);
  if (typeof record.workspaceID === 'string' && record.workspaceID) return worktree;
  const reported = normalizePath(record.directory ?? null);
  if (isWorkspaceRuntimePath(reported)) return worktree;
  return reported ?? worktree;
}
