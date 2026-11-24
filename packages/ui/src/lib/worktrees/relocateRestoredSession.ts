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
  | { outcome: 'worktreeRestored' }
  | { outcome: 'moved'; projectRoot: string }
  | { outcome: 'failed'; error: Error };

type RelocationDeps = {
  getSession: (sessionId: string) => Session | undefined;
  getActiveSessions: () => readonly Session[];
  getDirectoryAvailability: (directory: string) => Promise<'available' | 'missing' | 'unknown'>;
  resolveProjectRoot: (session: Session) => string | null;
  moveSession: (session: Session, sourceDirectory: string, destinationDirectory: string) => Promise<string>;
  restoreArchivedWorktree: (session: Session, projectRoot: string) => Promise<boolean>;
};

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

const collectDescendantsInDirectory = (
  root: Session,
  sessions: readonly Session[],
  directory: string,
): Session[] => createSessionLineage(sessions)
  .descendantsOf(root.id, 'active')
  .filter((descendant) => normalizePath(descendant.directory) === directory)
  .reverse();

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
  if (await deps.restoreArchivedWorktree(session, projectRoot)) return { outcome: 'worktreeRestored' };
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

export async function relocateRestoredSessionWithNotice(sessionId: string): Promise<void> {
  const result = await relocateRestoredSessionIfDirectoryMissing(sessionId);
  const dictionary = useI18nStore.getState().dictionary;
  if (result.outcome === 'worktreeRestored') {
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
