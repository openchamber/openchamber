import { z } from 'zod';
import { primaryWorktreeRootFromGitDir } from '../git/repository-root.js';
import { getCheckedOutBranch, getRepositoryRemoteUrls, resolveRepositoryGitPaths, resolveWorktreeTopLevel } from '../git/service.js';
import type { SettingsDocument } from '../settings/settings-helpers.js';

interface PullRequestCheckout {
  directory: string;
  branch: string;
  repository: string;
  projects: string[];
}

const cleanupSettingsSchema = z.object({
  mergedWorktreeCleanupEnabled: z.boolean().catch(false),
  projects: z.array(z.object({ path: z.string().min(1) })).catch([]),
}).catch({ mergedWorktreeCleanupEnabled: false, projects: [] });

export const cleanupProjectsOf = (settings: SettingsDocument | null) => {
  const { mergedWorktreeCleanupEnabled, projects } = cleanupSettingsSchema.parse(settings);
  return mergedWorktreeCleanupEnabled ? projects.map((project) => project.path) : null;
};

const SCP_REMOTE = /^(?:[^@/\s]+@)?[^:/\s]+:(.+)$/;

const repositoryPathOfRemote = (remoteUrl: string) => {
  const scp = remoteUrl.includes('://') ? null : SCP_REMOTE.exec(remoteUrl);
  const remotePath = scp?.[1] ?? (URL.canParse(remoteUrl) ? new URL(remoteUrl).pathname : '');
  return remotePath.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').toLowerCase();
};

const comparablePath = (directory: string) => directory.replace(/\\/g, '/').replace(/\/+$/, '');
const holds = (checkout: string, directory: string) => directory === checkout || directory.startsWith(`${checkout}/`);

export async function isPullRequestWorktree({ directory, branch, repository, projects }: PullRequestCheckout) {
  if (await getCheckedOutBranch(directory) !== branch) return false;
  const gitPaths = await resolveRepositoryGitPaths(directory);
  if (!gitPaths.supported || gitPaths.gitDirectory === gitPaths.commonDirectory) return false;
  const mainCheckout = primaryWorktreeRootFromGitDir(comparablePath(gitPaths.commonDirectory));
  const projectPaths = projects.map(comparablePath);
  if (!mainCheckout || !projectPaths.some((project) => holds(mainCheckout, project))) return false;
  const worktree = comparablePath((await resolveWorktreeTopLevel(directory)).root);
  if (projectPaths.some((project) => holds(worktree, project))) return false;
  const remotes = await getRepositoryRemoteUrls(directory);
  const headRepository = repository.toLowerCase();
  return remotes.some((remote) => repositoryPathOfRemote(remote.fetchUrl) === headRepository || repositoryPathOfRemote(remote.pushUrl) === headRepository);
}
