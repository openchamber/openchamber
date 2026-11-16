import React from 'react';
import { create } from 'zustand';
import { GitWorktreeRequestError, type GitWorktreeArchive } from '@/lib/api/types';
import { canArchiveWorktrees, git } from '@/lib/gitApi';
import type { Session } from '@/lib/opencode/model';
import { normalizePath } from '@/lib/pathNormalization';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { resolveWorktreeSetupCommandsOrCancel } from '@/lib/sharedTrustConfirmation';
import {
  archiveProjectWorktree,
  createWorktree,
  listProjectWorktrees,
  removeProjectWorktree,
  resolveWorktreeTeardownCommand,
  type ProjectRef,
} from '@/lib/worktrees/worktreeManager';
import { archiveSessionsThenRemoveWorktree } from '@/lib/worktrees/worktreeRemovalFlow';
import { clearWorktreeRemoval, markWorktreeRemoving } from '@/lib/worktrees/worktreeRemovalState';
import { getSafeStorage } from '@/stores/utils/safeStorage';
import { z } from 'zod';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { archiveSessions, deleteSessions, moveSessionToDirectory, unarchiveSessions } from '@/sync/session-actions';
import type { WorktreeMetadata } from '@/types/worktree';

type ProjectArchives =
  | { status: 'loading'; archives: GitWorktreeArchive[] }
  | { status: 'ready'; archives: GitWorktreeArchive[] }
  | { status: 'error'; archives: GitWorktreeArchive[]; error: string };

type WorktreeArchivesState = { byProject: ReadonlyMap<string, ProjectArchives> };

const useWorktreeArchivesStore = create<WorktreeArchivesState>(() => ({ byProject: new Map() }));

const setProjectArchives = (projectPath: string, value: ProjectArchives): void => {
  const next = new Map(useWorktreeArchivesStore.getState().byProject);
  next.set(projectPath, value);
  useWorktreeArchivesStore.setState({ byProject: next });
};

const latestListing = new Map<string, number>();
let listingSequence = 0;

export async function loadWorktreeArchives(projectPath: string): Promise<GitWorktreeArchive[]> {
  const key = normalizePath(projectPath);
  if (!key || !canArchiveWorktrees()) return [];
  const runtime = getRuntimeKey();
  const request = ++listingSequence;
  latestListing.set(key, request);
  const isLatest = () => getRuntimeKey() === runtime && latestListing.get(key) === request;
  const previous = useWorktreeArchivesStore.getState().byProject.get(key)?.archives ?? [];
  setProjectArchives(key, { status: 'loading', archives: previous });
  try {
    const archives = await git.worktree.listArchives(key);
    if (isLatest()) setProjectArchives(key, { status: 'ready', archives });
    return archives;
  } catch (error) {
    if (isLatest()) {
      setProjectArchives(key, { status: 'error', archives: previous, error: error instanceof Error ? error.message : String(error) });
    }
    throw error;
  }
}

const EMPTY: ProjectArchives = { status: 'ready', archives: [] };

export const useProjectWorktreeArchives = (projectPath: string | null | undefined): ProjectArchives => {
  const key = normalizePath(projectPath ?? null);
  React.useEffect(() => {
    if (key) void loadWorktreeArchives(key).catch(() => undefined);
  }, [key]);
  return useWorktreeArchivesStore((state) => (key ? state.byProject.get(key) : undefined) ?? EMPTY);
};

export const useWorktreeArchivesByProject = (): ReadonlyMap<string, ProjectArchives> => useWorktreeArchivesStore((state) => state.byProject);

subscribeRuntimeEndpointChanged(() => {
  if (useWorktreeArchivesStore.getState().byProject.size > 0) useWorktreeArchivesStore.setState({ byProject: new Map() });
});

const newArchiveId = (): string => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export async function archiveWorktreeWork(input: {
  project: ProjectRef;
  worktree: WorktreeMetadata;
  sessions: readonly Session[];
  title?: string;
  askForTrust?: boolean;
}): Promise<void> {
  const sessionIds = input.sessions.map((session) => session.id);
  let partial: Error | null = null;
  markWorktreeRemoving(input.worktree.path);
  try {
    const teardownCommand = await resolveWorktreeTeardownCommand(input.project, input.worktree, { ask: input.askForTrust });
    if (teardownCommand) {
      await git.worktree.teardown(normalizePath(input.project.path) ?? input.project.path, { directory: input.worktree.path, teardownCommand });
    }
    await archiveSessionsThenRemoveWorktree({
      sessionIds,
      archiveSessions: (ids) => archiveSessions(ids),
      restoreSessions: (ids) => unarchiveSessions(ids, { undo: true }),
      removeWorktree: async (archivedIds) => {
        if (archivedIds.length !== sessionIds.length) {
          throw new Error(`Could not archive ${sessionIds.length - archivedIds.length} session(s)`);
        }
        try {
          await archiveProjectWorktree(input.project, input.worktree, { id: newArchiveId(), sessionIds: archivedIds, title: input.title });
        } catch (error) {
          if (!(error instanceof GitWorktreeRequestError) || error.code !== 'WORKTREE_ARCHIVE_PARTIAL') throw error;
          partial = error;
        }
        return true;
      },
    });
  } finally {
    clearWorktreeRemoval(input.worktree.path);
    void loadWorktreeArchives(input.project.path).catch(() => undefined);
  }
  if (partial) throw partial;
}

export const archivedWorktreeLabel = (archive: GitWorktreeArchive): string => (
  archive.title || archive.branch || archive.path.split('/').filter(Boolean).pop() || archive.path
);

const lastSegment = (path: string): string => normalizePath(path)?.split('/').filter(Boolean).pop() ?? '';

export type WorktreeArchiveRestore =
  | { outcome: 'restored'; worktree: WorktreeMetadata; conflicts: boolean; sessionsFailed: number }
  | { outcome: 'cancelled' };

const restoresInFlight = new Map<string, Promise<WorktreeArchiveRestore>>();

export function restoreArchivedWorktree(input: {
  project: ProjectRef;
  archive: GitWorktreeArchive;
}): Promise<WorktreeArchiveRestore> {
  const running = restoresInFlight.get(input.archive.id);
  if (running) return running;
  const restore = restoreArchivedWorktreeOnce(input).finally(() => restoresInFlight.delete(input.archive.id));
  restoresInFlight.set(input.archive.id, restore);
  return restore;
}

async function restoreArchivedWorktreeOnce(input: {
  project: ProjectRef;
  archive: GitWorktreeArchive;
}): Promise<WorktreeArchiveRestore> {
  const { project, archive } = input;
  const setupCommands = await resolveWorktreeSetupCommandsOrCancel(project);
  if (setupCommands === null) return { outcome: 'cancelled' };

  const worktreeName = lastSegment(archive.path);
  const worktree = archive.branchExists
    ? await createWorktree(project, { mode: 'existing', existingBranch: archive.branch, worktreeName, setupCommands })
    : await createWorktree(project, {
      mode: 'new',
      branchName: archive.branch || worktreeName,
      startRef: archive.head,
      worktreeName,
      setupCommands,
    });
  let conflicts: boolean;
  try {
    ({ conflicts } = await git.worktree.restoreArchive(worktree.path, archive.id));
  } catch (error) {
    await removeProjectWorktree(project, worktree, { deleteLocalBranch: !archive.branchExists }).catch(() => undefined);
    throw error;
  }
  noteRestoredWorktree(worktree.path);

  const from = normalizePath(archive.path);
  const to = normalizePath(worktree.path);
  const { entityById } = useGlobalSessionsStore.getState();
  const sessions = archive.sessionIds.flatMap((id) => {
    const session = entityById.get(id);
    return session ? [session] : [];
  });
  let sessionsFailed = 0;
  if (from && to && from !== to) {
    for (const session of sessions) {
      const directory = normalizePath(session.directory);
      if (!directory || (directory !== from && !directory.startsWith(`${from}/`))) continue;
      await moveSessionToDirectory(session, directory, `${to}${directory.slice(from.length)}`).catch(() => { sessionsFailed += 1; });
    }
  }
  const archived = sessions.filter((session) => Boolean(session.time?.archived)).map((session) => session.id);
  if (archived.length > 0) {
    const { failedIds } = await unarchiveSessions(archived, { undo: true });
    sessionsFailed += failedIds.length;
  }

  void listProjectWorktrees(project, { force: true }).catch(() => undefined);
  void loadWorktreeArchives(project.path).catch(() => undefined);
  return { outcome: 'restored', worktree, conflicts, sessionsFailed };
}

export async function deleteArchivedWorktree(input: { project: ProjectRef; archive: GitWorktreeArchive }): Promise<void> {
  const { entityById } = useGlobalSessionsStore.getState();
  const others = useWorktreeArchivesStore.getState().byProject.get(normalizePath(input.project.path) ?? '')?.archives ?? [];
  const elsewhere = new Set(others.filter((archive) => archive.id !== input.archive.id).flatMap((archive) => archive.sessionIds));
  const sessionIds = input.archive.sessionIds.filter((id) => Boolean(entityById.get(id)?.time?.archived) && !elsewhere.has(id));
  if (sessionIds.length > 0) {
    const { failedIds } = await deleteSessions(sessionIds);
    if (failedIds.length > 0) throw new Error(`Could not delete ${failedIds.length} session(s)`);
  }
  try {
    await git.worktree.deleteArchive(normalizePath(input.project.path) ?? input.project.path, { id: input.archive.id, deleteBranch: true });
  } finally {
    void loadWorktreeArchives(input.project.path).catch(() => undefined);
  }
}

export async function findWorktreeArchiveForSession(projectPath: string, sessionId: string): Promise<GitWorktreeArchive | null> {
  if (!canArchiveWorktrees()) return null;
  const archives = await loadWorktreeArchives(projectPath);
  return archives.find((archive) => archive.sessionIds.includes(sessionId)) ?? null;
}

const RESTORED_STORAGE_KEY = 'openchamber.mergedWorktreeCleanup.restored';
const RESTORED_LIMIT = 100;
const restoredSchema = z.array(z.string()).catch([]);

const readRestored = (): string[] => {
  try {
    return restoredSchema.parse(JSON.parse(getSafeStorage().getItem(RESTORED_STORAGE_KEY) ?? '[]'));
  } catch {
    return [];
  }
};

const writeRestored = (paths: string[]): void => {
  getSafeStorage().setItem(RESTORED_STORAGE_KEY, JSON.stringify(paths.slice(-RESTORED_LIMIT)));
};

const noteRestoredWorktree = (path: string): void => {
  const key = normalizePath(path);
  if (key) writeRestored([...readRestored().filter((entry) => entry !== key), key]);
};

export const takeRestoredWorktree = (path: string): boolean => {
  const key = normalizePath(path);
  const restored = readRestored();
  if (!key || !restored.includes(key)) return false;
  writeRestored(restored.filter((entry) => entry !== key));
  return true;
};
