import type { Session } from '@/lib/opencode/model';
import { toast } from '@/components/ui';
import { createSessionOwnershipIndex } from '@/components/session/sidebar/sessions/sessionOwnership';
import { formatMessage, useI18nStore } from '@/lib/i18n';
import { opencodeClient } from '@/lib/opencode/client';
import { normalizePath } from '@/lib/pathNormalization';
import { createSessionLineage } from '@/stores/sessionLineage';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useGlobalSyncStore } from '@/sync/global-sync-store';
import { moveSessionToDirectory } from '@/sync/session-actions';
import { useSessionUIStore } from '@/sync/session-ui-store';

export type RestoredSessionRelocation =
  | { outcome: 'kept' }
  /** The session belonged to an archived worktree, which came back with it. */
  | { outcome: 'worktreeRestored' }
  | { outcome: 'moved'; projectRoot: string }
  | { outcome: 'failed'; error: Error };

type RelocationDeps = {
  getSession: (sessionId: string) => Session | undefined;
  getActiveSessions: () => readonly Session[];
  getDirectoryAvailability: (directory: string) => Promise<'available' | 'missing' | 'unknown'>;
  resolveProjectRoot: (session: Session) => string | null;
  moveSession: (session: Session, sourceDirectory: string, destinationDirectory: string) => Promise<void>;
  /** Restores the archived worktree holding the session, if one does; false when none does or it did not come back. */
  restoreArchivedWorktree: (session: Session, projectRoot: string) => Promise<boolean>;
};

// The project a session belongs to, the way the sidebar groups it: by its
// directory first, then by OpenCode's project metadata. The second step is the
// one that matters here, since a removed worktree's path matches nothing.
const resolveProjectRootFromStores = (session: Session): string | null => {
  const projects = useProjectsStore.getState().projects.flatMap((project) => {
    const normalizedPath = normalizePath(project.path);
    return normalizedPath ? [{ id: project.id, normalizedPath }] : [];
  });
  const ownership = createSessionOwnershipIndex(
    [session],
    projects,
    useSessionUIStore.getState().availableWorktreesByProject,
    false,
    [],
    useGlobalSyncStore.getState().projects,
  );
  return ownership.bySessionId.get(session.id)?.projectRoot ?? null;
};

// A failed restore is said here and the session still moves to the project
// root, so it can be written to either way.
const restoreArchivedWorktreeOfSession = async (session: Session, projectRoot: string): Promise<boolean> => {
  const project = useProjectsStore.getState().projects.find((entry) => normalizePath(entry.path) === projectRoot);
  if (!project) return false;
  const { findWorktreeArchiveForSession, restoreArchivedWorktree } = await import('@/lib/worktrees/worktreeArchive');
  try {
    const archive = await findWorktreeArchiveForSession(projectRoot, session.id);
    if (!archive) return false;
    const result = await restoreArchivedWorktree({ project: { id: project.id, path: project.path }, archive });
    return result.outcome === 'restored';
  } catch (error) {
    toast.error(formatMessage(useI18nStore.getState().dictionary, 'sessions.archive.worktree.restoreFailed'), {
      description: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
};

const defaultDeps: RelocationDeps = {
  getSession: (sessionId) => useGlobalSessionsStore.getState().entityById.get(sessionId),
  getActiveSessions: () => useGlobalSessionsStore.getState().activeSessions,
  getDirectoryAvailability: (directory) => opencodeClient.getDirectoryAvailability(directory),
  resolveProjectRoot: resolveProjectRootFromStores,
  moveSession: moveSessionToDirectory,
  restoreArchivedWorktree: restoreArchivedWorktreeOfSession,
};

// Subsessions working in the same directory move with their root, deepest
// first, the way the sidebar's Move to worktree moves a tree.
const collectDescendantsInDirectory = (
  root: Session,
  sessions: readonly Session[],
  directory: string,
): Session[] => createSessionLineage(sessions)
  .descendantsOf(root.id, 'active')
  .filter((descendant) => normalizePath(descendant.directory) === directory)
  .reverse();

/**
 * A session restored from the archive may still point at a worktree that was
 * removed meanwhile. When the worktree was archived with it, the worktree is
 * restored. Otherwise OpenCode cannot run a prompt there (it answers 500), so
 * the session moves to its project root, where it works again. OpenCode
 * records the move and tells the model its working directory changed.
 *
 * Only a directory the server confirms missing triggers the move; an
 * unreachable server or an unknown answer leaves the session where it is.
 */
export async function relocateRestoredSessionIfDirectoryMissing(
  sessionId: string,
  deps: RelocationDeps = defaultDeps,
): Promise<RestoredSessionRelocation> {
  const session = deps.getSession(sessionId);
  const sourceDirectory = normalizePath(session?.directory ?? null);
  if (!session || !sourceDirectory) return { outcome: 'kept' };
  if (await deps.getDirectoryAvailability(sourceDirectory) !== 'missing') return { outcome: 'kept' };

  const projectRoot = normalizePath(deps.resolveProjectRoot(session));
  if (!projectRoot || projectRoot === sourceDirectory) return { outcome: 'kept' };
  // A session archived with its worktree brings the worktree back: in the
  // project root it would miss the changes it worked on.
  if (await deps.restoreArchivedWorktree(session, projectRoot)) return { outcome: 'worktreeRestored' };
  // Its subsessions come back one by one, and the first may already have
  // restored the worktree (and closed its archive) since the check above.
  if (await deps.getDirectoryAvailability(sourceDirectory) !== 'missing') return { outcome: 'kept' };
  if (await deps.getDirectoryAvailability(projectRoot) !== 'available') return { outcome: 'kept' };

  try {
    const tree = [...collectDescendantsInDirectory(session, deps.getActiveSessions(), sourceDirectory), session];
    for (const member of tree) {
      await deps.moveSession(member, sourceDirectory, projectRoot);
    }
    return { outcome: 'moved', projectRoot };
  } catch (error) {
    return { outcome: 'failed', error: error instanceof Error ? error : new Error(String(error)) };
  }
}

const projectLabelFor = (projectRoot: string): string => {
  const project = useProjectsStore.getState().projects.find((entry) => normalizePath(entry.path) === projectRoot);
  return project?.label?.trim() || projectRoot.split('/').filter(Boolean).pop() || projectRoot;
};

/**
 * Restores the session's working directory after an unarchive and tells the
 * user why it moved: the worktree folder is gone, which this app did not
 * necessarily do (it may have been removed by hand or by git).
 */
export async function relocateRestoredSessionWithNotice(sessionId: string): Promise<void> {
  const result = await relocateRestoredSessionIfDirectoryMissing(sessionId);
  const dictionary = useI18nStore.getState().dictionary;
  if (result.outcome === 'worktreeRestored') {
    // One toast for the session and the subsessions that come back with it.
    toast.success(formatMessage(dictionary, 'sessions.archive.worktree.restored'), {
      id: 'worktree-restored-with-session',
      description: formatMessage(dictionary, 'sessions.archive.worktree.restoredWithSession'),
    });
    return;
  }
  if (result.outcome === 'moved') {
    toast.info(formatMessage(dictionary, 'sessions.sidebar.session.restore.relocatedTitle'), {
      description: formatMessage(dictionary, 'sessions.sidebar.session.restore.relocatedDescription', {
        project: projectLabelFor(result.projectRoot),
      }),
    });
    return;
  }
  if (result.outcome === 'failed') {
    toast.error(formatMessage(dictionary, 'sessions.sidebar.session.restore.relocateFailed'), {
      description: result.error.message,
    });
  }
}
