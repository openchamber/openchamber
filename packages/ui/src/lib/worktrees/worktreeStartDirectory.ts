
import { toast } from '@/components/ui';
import { resolveGitRepositoryPrefix, validateWorktreeDirectory } from '@/lib/gitApi';
import { formatMessage, useI18nStore } from '@/lib/i18n';
import type { ProjectRef } from '@/lib/openchamberConfig';
import { normalizePath } from '@/lib/pathNormalization';
import { waitForWorktreeGitReady } from '@/lib/worktrees/worktreeBootstrap';
import type { WorktreeMetadata } from '@/types/worktree';

type StartDirectoryFallback = 'unknown' | 'missing' | 'unverified';

type WorktreeStartDirectory =
  | { directory: string; fallback: null }
  | { directory: string; fallback: StartDirectoryFallback; folder: string | null };

export type WorktreeStartDirectoryDeps = {
  readProjectFolder: (project: ProjectRef) => Promise<string>;
  waitForCheckout: (worktreeRoot: string) => Promise<void>;
  directoryInsideCheckout: (directory: string, worktreeRoot: string) => Promise<boolean>;
};

const defaultDeps: WorktreeStartDirectoryDeps = {
  readProjectFolder: (project) => resolveGitRepositoryPrefix(project.path),
  waitForCheckout: waitForWorktreeGitReady,
  directoryInsideCheckout: async (directory, worktreeRoot) => {
    const result = await validateWorktreeDirectory(directory, worktreeRoot);
    return result.valid && result.insideWorktreeRoot;
  },
};

export const resolveStartDirectory = async (
  project: ProjectRef,
  worktreeRoot: string,
  deps: WorktreeStartDirectoryDeps = defaultDeps,
): Promise<WorktreeStartDirectory> => {
  const root = normalizePath(worktreeRoot) ?? worktreeRoot;

  let folder: string;
  try {
    folder = await deps.readProjectFolder(project);
  } catch (error) {
    console.warn('Failed to read the project folder inside its repository:', error);
    return { directory: root, fallback: 'unknown', folder: null };
  }
  if (!folder) return { directory: root, fallback: null };

  await deps.waitForCheckout(root);
  const candidate = `${root}/${folder}`;
  try {
    return await deps.directoryInsideCheckout(candidate, root)
      ? { directory: candidate, fallback: null }
      : { directory: root, fallback: 'missing', folder };
  } catch (error) {
    console.warn('Failed to check the session start folder:', error);
    return { directory: root, fallback: 'unverified', folder };
  }
};

export const resolveWorktreeStartDirectory = async (project: ProjectRef, worktreeRoot: string): Promise<string> => {
  const resolved = await resolveStartDirectory(project, worktreeRoot);
  if (resolved.fallback === null) return resolved.directory;

  const dictionary = useI18nStore.getState().dictionary;
  if (resolved.fallback === 'unknown') {
    toast.warning(formatMessage(dictionary, 'session.newWorktree.toast.startFolderUnknown'));
  } else {
    toast.warning(formatMessage(
      dictionary,
      resolved.fallback === 'missing' ? 'session.newWorktree.toast.startFolderMissing' : 'session.newWorktree.toast.startFolderUnverified',
      { folder: resolved.folder ?? '' },
    ));
  }
  return resolved.directory;
};

export type CreatedWorktreeStartDeps = {
  resolve: (project: ProjectRef, worktreeRoot: string) => Promise<string>;
  remove: (project: ProjectRef, worktree: WorktreeMetadata) => Promise<void>;
};

const createdWorktreeStartDeps: CreatedWorktreeStartDeps = {
  resolve: resolveWorktreeStartDirectory,
  remove: async (project, worktree) => {
    const { removeProjectWorktree } = await import('@/lib/worktrees/worktreeManager');
    await removeProjectWorktree(project, worktree, { deleteLocalBranch: true });
  },
};

export const resolveCreatedWorktreeStartDirectory = async (
  project: ProjectRef,
  worktree: WorktreeMetadata,
  deps: CreatedWorktreeStartDeps = createdWorktreeStartDeps,
): Promise<string> => {
  try {
    return await deps.resolve(project, worktree.path);
  } catch (error) {
    await deps.remove(project, worktree).catch((removalError) => {
      console.warn('Failed to remove a worktree whose checkout did not populate:', worktree.path, removalError);
    });
    throw error;
  }
};
