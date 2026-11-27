import { z } from 'zod';
import { primaryWorktreeRootFromGitDir } from '../git/repository-root.js';
import { getCheckedOutBranch, getRepositoryRemoteUrls, resolveRepositoryGitPaths, resolveWorktreeTopLevel } from '../git/service.js';
import type { SettingsDocument } from '../settings/settings-helpers.js';
import type { BindingRead } from '../source-control/binding-service-contracts.js';

export type ReadBinding = (directory: string) => Promise<BindingRead>;

interface PullRequestCheckout {
  directory: string;
  branch: string;
  repository: string;
  projects: string[];
  provider: string;
  instance: string;
  readBinding: ReadBinding | undefined;
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

const primaryRemoteOf = (read: BindingRead | null, provider: string, instance: string) => {
  const entries = (read?.binding?.providers ?? []).filter((entry) => entry.provider === provider && entry.instance.toLowerCase() === instance.toLowerCase());
  const ready = entries.find((entry) => entry.readiness === 'ready'
    && entry.endpoint?.fingerprint === read?.repository.remotes.find((remote) => remote.name === entry.primaryRemote)?.fetch.fingerprint);
  if (ready) return ready.primaryRemote;
  return entries.some((entry) => entry.readiness !== 'account-unavailable') ? null : 'origin';
};

export async function isPullRequestWorktree({ directory, branch, repository, projects, provider, instance, readBinding }: PullRequestCheckout) {
  if (await getCheckedOutBranch(directory) !== branch) return false;
  const gitPaths = await resolveRepositoryGitPaths(directory);
  if (!gitPaths.supported || gitPaths.gitDirectory === gitPaths.commonDirectory) return false;
  const mainCheckout = primaryWorktreeRootFromGitDir(comparablePath(gitPaths.commonDirectory));
  const projectPaths = projects.map(comparablePath);
  if (!mainCheckout || !projectPaths.includes(mainCheckout)) return false;
  const worktree = comparablePath((await resolveWorktreeTopLevel(directory)).root);
  if (projectPaths.some((project) => holds(worktree, project))) return false;
  const primaryRemote = primaryRemoteOf(readBinding ? await readBinding(directory) : null, provider, instance);
  if (!primaryRemote) return false;
  const remote = (await getRepositoryRemoteUrls(directory)).find((entry) => entry.name === primaryRemote);
  const headRepository = repository.toLowerCase();
  return remote !== undefined && [remote.fetchUrl, remote.pushUrl].some((url) => repositoryPathOfRemote(url) === headRepository);
}
