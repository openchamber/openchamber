/**
 * Where a session in a worktree starts. A project opened on a folder inside its
 * repository (`repo/ai` rather than `repo`) works from that folder, so the
 * sessions of its worktrees start in the same folder of the checkout, where the
 * OpenCode config lives. The worktree root stays the identity of the checkout
 * for Git, bootstrap, removal and moves; only the session directory takes the
 * folder.
 */

import { toast } from '@/components/ui';
import { resolveGitRepositoryPrefix, validateWorktreeDirectory } from '@/lib/gitApi';
import { formatMessage, useI18nStore } from '@/lib/i18n';
import type { ProjectRef } from '@/lib/openchamberConfig';
import { normalizePath } from '@/lib/pathNormalization';
import { waitForWorktreeGitReady } from '@/lib/worktrees/worktreeBootstrap';
import type { WorktreeMetadata } from '@/types/worktree';

/** Why a session starts at the worktree root although the project opens on a folder, or could not tell. */
type StartDirectoryFallback = 'unknown' | 'missing' | 'unverified';

type WorktreeStartDirectory =
  | { directory: string; fallback: null }
  | { directory: string; fallback: StartDirectoryFallback; folder: string | null };

export type WorktreeStartDirectoryDeps = {
  /** The project's folder inside its repository; `''` when the project is the repository root. Rejects when unknown. */
  readProjectFolder: (project: ProjectRef) => Promise<string>;
  /** Resolves once the checkout's files exist; rejects when the worktree failed to populate. */
  waitForCheckout: (worktreeRoot: string) => Promise<void>;
  /** Whether `directory` exists inside the checkout, symlinks resolved. */
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

/**
 * The directory a session in `worktreeRoot` starts in. A project at the root of
 * its repository starts at the root and nothing waits. A project on a folder
 * waits for the checkout, then confirms the same folder exists inside it: a
 * branch that lacks the folder, a failed check, or a folder git cannot report
 * each answer with the root and name the reason, so a caller can tell the user.
 */
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

/** `resolveStartDirectory` for callers that only need the path; a fallback is shown as a warning toast. */
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
  /** Removes the worktree and its local branch. */
  remove: (project: ProjectRef, worktree: WorktreeMetadata) => Promise<void>;
};

const createdWorktreeStartDeps: CreatedWorktreeStartDeps = {
  resolve: resolveWorktreeStartDirectory,
  remove: async (project, worktree) => {
    // Loaded on failure only: worktreeManager reaches the session store, which imports this module.
    const { removeProjectWorktree } = await import('@/lib/worktrees/worktreeManager');
    await removeProjectWorktree(project, worktree, { deleteLocalBranch: true });
  },
};

/**
 * `resolveWorktreeStartDirectory` for a worktree the caller has just created.
 * It rejects only when the checkout failed to populate; that worktree and its
 * branch are of no use to anyone, so they are removed before the error is
 * rethrown. A failed removal is logged and the original error still wins.
 */
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
