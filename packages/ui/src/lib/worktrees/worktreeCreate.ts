import { checkIsGitRepository, getGitBranches, getGitStatus } from '@/lib/gitApi';
import type { CreateWorktreeArgs, ProjectRef } from '@/lib/worktrees/worktreeManager';
import { createWorktree } from '@/lib/worktrees/worktreeManager';
import { getRootBranch, resolveProjectRoot } from '@/lib/worktrees/worktreeStatus';

export class WorktreeRequiresGitRepositoryError extends Error {
  constructor() {
    super('Worktree creation requires a Git repository');
    this.name = 'WorktreeRequiresGitRepositoryError';
  }
}

const parseTrackingRef = (tracking: string | null | undefined): { remote: string; branch: string } | null => {
  const value = String(tracking || '').trim().replace(/^remotes\//, '');
  if (!value) {
    return null;
  }

  const separatorIndex = value.indexOf('/');
  if (separatorIndex <= 0 || separatorIndex >= value.length - 1) {
    return null;
  }

  return {
    remote: value.slice(0, separatorIndex),
    branch: value.slice(separatorIndex + 1),
  };
};

const normalizeBranchName = (value: string): string => {
  return String(value || '')
    .trim()
    .replace(/^refs\/heads\//, '')
    .replace(/^heads\//, '')
    .replace(/^remotes\//, '');
};

const resolveLocalBranchName = (args: CreateWorktreeArgs): string => {
  if (args.branchName) {
    return normalizeBranchName(args.branchName);
  }
  if (args.mode === 'existing') {
    return normalizeBranchName(args.existingBranch || args.preferredName || '');
  }
  return normalizeBranchName(args.preferredName || '');
};

export const resolveRootTrackingRemote = async (projectDirectory: string): Promise<string | null> => {
  const rootBranch = await getRootBranch(projectDirectory);

  try {
    const branchState = await getGitBranches(projectDirectory);
    const tracking = branchState.branches?.[rootBranch]?.tracking || null;
    const parsed = parseTrackingRef(tracking);
    if (parsed?.remote) {
      return parsed.remote;
    }
  } catch {
    // ignore and fallback to status tracking
  }

  try {
    const status = await getGitStatus(projectDirectory);
    const parsed = parseTrackingRef(status.tracking);
    if (parsed?.remote) {
      return parsed.remote;
    }
  } catch {
    // ignore
  }

  return null;
};

const resolveWorktreeUpstreamDefaults = async (
  projectDirectory: string,
  localBranch: string
): Promise<{ setUpstream: true; upstreamRemote: string; upstreamBranch: string } | null> => {
  const remote = await resolveRootTrackingRemote(projectDirectory);
  const normalizedBranch = normalizeBranchName(localBranch);
  if (!remote || !normalizedBranch) {
    return null;
  }

  return {
    setUpstream: true,
    upstreamRemote: remote,
    upstreamBranch: normalizedBranch,
  };
};

const withWorktreeUpstreamDefaults = async (
  projectDirectory: string,
  args: CreateWorktreeArgs,
  options?: { resolvedRootTrackingRemote?: string | null }
): Promise<CreateWorktreeArgs> => {
  const localBranch = resolveLocalBranchName(args);
  const resolvedRemote = options?.resolvedRootTrackingRemote;
  const defaults = resolvedRemote === undefined
    ? await resolveWorktreeUpstreamDefaults(projectDirectory, localBranch)
    : (resolvedRemote && normalizeBranchName(localBranch)
      ? {
          setUpstream: true as const,
          upstreamRemote: resolvedRemote,
          upstreamBranch: normalizeBranchName(localBranch),
        }
      : null);
  if (!defaults) {
    return args;
  }

  return {
    ...args,
    setUpstream: args.setUpstream ?? defaults.setUpstream,
    upstreamRemote: args.upstreamRemote || defaults.upstreamRemote,
    upstreamBranch: args.upstreamBranch || defaults.upstreamBranch,
  };
};

const REMOTE_START_REF_PATTERN = /^(remotes\/|refs\/remotes\/)/;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{7,40}$/i;

const normalizeLocalBranchName = (value: string): string => {
  return String(value || '')
    .trim()
    .replace(/^refs\/heads\//, '');
};

export const withWorktreeRemoteStartRef = async (
  project: ProjectRef,
  args: CreateWorktreeArgs
): Promise<CreateWorktreeArgs> => {
  if (args.mode === 'existing') {
    return args;
  }
  const rawStartRef = String(args.startRef || '').trim();
  if (rawStartRef && rawStartRef !== 'HEAD') {
    if (REMOTE_START_REF_PATTERN.test(rawStartRef) || COMMIT_SHA_PATTERN.test(rawStartRef)) {
      return args;
    }
  }

  const projectDirectory = project.path;
  const rootDirectory = await resolveProjectRoot(projectDirectory).catch(() => projectDirectory);
  const status = await getGitStatus(rootDirectory).catch(() => null);
  if (!status) {
    return args;
  }

  const currentBranch = String(status.current || '').trim();
  const tracking = parseTrackingRef(status.tracking);
  if (!currentBranch || !tracking) {
    return args;
  }

  const baseBranch = rawStartRef && rawStartRef !== 'HEAD' ? normalizeLocalBranchName(rawStartRef) : currentBranch;
  if (baseBranch !== currentBranch) {
    return args;
  }
  if (status.ahead > 0) {
    return args;
  }

  return { ...args, startRef: `remotes/${tracking.remote}/${tracking.branch}` };
};

export const createWorktreeWithDefaults = async (
  project: ProjectRef,
  args: CreateWorktreeArgs,
  options?: { resolvedRootTrackingRemote?: string | null }
) => {
  const isGitRepository = await checkIsGitRepository(project.path);
  if (!isGitRepository) {
    throw new WorktreeRequiresGitRepositoryError();
  }
  const remoteArgs = await withWorktreeRemoteStartRef(project, args);
  const resolvedArgs = await withWorktreeUpstreamDefaults(project.path, remoteArgs, options);
  return createWorktree(project, resolvedArgs);
};
