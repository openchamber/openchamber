import type { HostRequestErrorCode } from '@openchamber/sdk';

import { resolveBranchComparisonBase } from '@/components/views/git/baseBranch';
import { chooseAutoNestedRepo, discoversNestedRepos } from '@/lib/nestedRepositories';
import type { SourceControlAPI } from '@/lib/api/types';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { isMobileSurfaceRuntime } from '@/lib/runtimeSurface';
import { repositoryBindingOwner } from '@/lib/source-control/repository-binding';
import { getWorktreeBootstrapState } from '@/lib/worktrees/worktreeBootstrap';
import { useGitBaseBranchStore } from '@/stores/useGitBaseBranchStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useGitStore } from '@/stores/useGitStore';
import { useUIStore } from '@/stores/useUIStore';
import { useWalkthroughStore } from '@/stores/useWalkthroughStore';

type StoreGitAPI = Parameters<ReturnType<typeof useGitStore.getState>['ensureAll']>[1];

export type GuestOpenWalkthroughResult =
  | { ok: true }
  | { ok: false; code: HostRequestErrorCode; message: string };

export type WalkthroughRepository = {
  directory: string;
  autoSelected: boolean;
  branch: string | null;
  branches: readonly string[];
  remoteNames: ReadonlySet<string>;
  primaryRemote: string | null | undefined;
};

type OpenGuestWalkthroughOptions = {
  base: string;
  directory: string | null;
  readRepository: ((directory: string) => Promise<WalkthroughRepository | null>) | null;
  supported: boolean;
};

const requestedRemoteRef = (base: string, remoteNames: ReadonlySet<string>, localBranches: readonly string[]): string | null => {
  const stripped = base.replace(/^refs\/remotes\//, '').replace(/^remotes\//, '');
  if (stripped !== base) return stripped;
  const slashIndex = base.indexOf('/');
  return slashIndex > 0 && remoteNames.has(base.slice(0, slashIndex)) && !localBranches.includes(base) ? base : null;
};

export const openGuestWalkthrough = async ({ base, directory, readRepository, supported }: OpenGuestWalkthroughOptions): Promise<GuestOpenWalkthroughResult> => {
  if (!supported || isMobileSurfaceRuntime()) {
    return { ok: false, code: 'UNSUPPORTED', message: 'Changes Walkthrough does not open from extensions here.' };
  }
  if (!directory) return { ok: false, code: 'NO_DIRECTORY', message: 'No project is open.' };
  if (!readRepository) return { ok: false, code: 'HOST_UNAVAILABLE', message: 'Git is not available yet.' };
  const runtimeKey = getRuntimeKey();
  const selection = useGitStore.getState().nestedRepoSelection.get(directory);
  let repository: WalkthroughRepository | null;
  try {
    repository = await readRepository(directory);
  } catch {
    return { ok: false, code: 'HOST_UNAVAILABLE', message: 'Could not read this repository.' };
  }
  if (getRuntimeKey() !== runtimeKey) return { ok: false, code: 'HOST_UNAVAILABLE', message: 'The connection changed.' };
  if (useGitStore.getState().nestedRepoSelection.get(directory) !== selection) {
    return { ok: false, code: 'HOST_UNAVAILABLE', message: 'The repository selection changed.' };
  }
  if (!repository) return { ok: false, code: 'NOT_FOUND', message: 'This project is not a git repository.' };
  const { directory: gitDirectory, autoSelected, branch, branches, remoteNames, primaryRemote } = repository;
  if (!branch) return { ok: false, code: 'NOT_FOUND', message: 'No branch is checked out.' };
  const localBranches = branches.filter((name) => !name.startsWith('remotes/'));
  const resolved = resolveBranchComparisonBase({ chosen: base, pullRequest: null, createdFrom: null, defaultBranch: null }, {
    localBranches,
    remoteBranches: branches.filter((name) => name.startsWith('remotes/')).map((name) => name.slice('remotes/'.length)),
    remoteNames,
    primaryRemote,
    headBranch: branch,
  });
  const remoteRef = requestedRemoteRef(base.trim(), remoteNames, localBranches);
  if (!resolved || (remoteRef !== null && resolved.ref !== remoteRef)) {
    return { ok: false, code: 'NOT_FOUND', message: `"${base}" is not a branch this one can be compared with.` };
  }
  if (autoSelected) useGitStore.getState().selectNestedRepo(directory, gitDirectory, { persist: false });
  useGitBaseBranchStore.getState().setOverride(gitDirectory, branch, resolved.ref);
  useWalkthroughStore.getState().requestTarget(gitDirectory, { source: { kind: 'branch', baseRef: resolved.ref, headRef: branch } });
  useUIStore.getState().openContextPanelTab(directory, { mode: 'walkthrough' });
  return { ok: true };
};

const assertNoPendingWorktree = (directory: string): void => {
  if (getWorktreeBootstrapState(directory)?.status === 'pending') throw new Error('The worktree is still being created.');
};

const autoSelectedRepository = async (root: string): Promise<string | null> => {
  if (!discoversNestedRepos(root, useDirectoryStore.getState().homeDirectory)) return null;
  await useGitStore.getState().ensureNestedRepos(root);
  const { nestedReposByRoot, staleClearedSelections } = useGitStore.getState();
  const repositories = nestedReposByRoot.get(root);
  if (repositories === null) throw new Error('The repositories in this folder could not be listed.');
  if (!Array.isArray(repositories)) return null;
  const staleCleared = staleClearedSelections.get(root);
  return chooseAutoNestedRepo(root, staleCleared ? repositories.filter((repository) => !staleCleared.has(repository)) : repositories);
};

const resolveRepositoryDirectory = async (git: StoreGitAPI, root: string): Promise<{ directory: string; autoSelected: boolean } | null> => {
  const selected = useGitStore.getState().nestedRepoSelection.get(root);
  if (selected) return { directory: selected, autoSelected: false };
  await useGitStore.getState().fetchStatus(root, git, { force: true, silent: true, throwOnError: true });
  if (useGitStore.getState().directories.get(root)?.isGitRepo !== false) return { directory: root, autoSelected: false };
  const autoSelected = await autoSelectedRepository(root);
  return autoSelected ? { directory: autoSelected, autoSelected: true } : null;
};

export const readWalkthroughRepository = async (
  git: StoreGitAPI,
  sourceControl: Pick<SourceControlAPI, 'repositoryBinding'>,
  root: string,
): Promise<WalkthroughRepository | null> => {
  assertNoPendingWorktree(root);
  const resolved = await resolveRepositoryDirectory(git, root);
  if (!resolved) return null;
  const { directory } = resolved;
  assertNoPendingWorktree(directory);
  await useGitStore.getState().ensureAll(directory, git);
  const state = useGitStore.getState().directories.get(directory);
  if (state?.isGitRepo === false) return null;
  if (!state?.isGitRepo || !state.branches) throw new Error('The branch list could not be read.');
  const status = await git.getGitStatus(directory, { fresh: true });
  assertNoPendingWorktree(directory);
  const binding = await repositoryBindingOwner.read(repositoryBindingOwner.scope(directory), sourceControl);
  if (binding.status === 'error') throw binding.error;
  return {
    ...resolved,
    branch: status.current && status.current !== 'HEAD' ? status.current : null,
    branches: state.branches.all ?? [],
    remoteNames: new Set(binding.read?.repository.remotes.map((remote) => remote.name) ?? []),
    primaryRemote: binding.contexts[0]?.primaryRemote,
  };
};
