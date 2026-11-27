import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { isDiskPathRemoteUrl } from '../source-control/url-redaction.js';
import type { GitCommandResult } from './service-contracts.js';

interface RemoteProvisioningDependencies {
  runGitCommand(cwd: string, args: string[]): Promise<GitCommandResult>;
  runGitCommandOrThrow(cwd: string, args: string[], fallbackMessage?: string): Promise<GitCommandResult>;
}

export const createRemoteProvisioning = ({ runGitCommand, runGitCommandOrThrow }: RemoteProvisioningDependencies) => {
  const remoteProvisioningQueues = new Map<string, Promise<unknown>>();

  const networkRemoteName = async (primaryWorktree: string, remoteName: string) => {
    for (const urlArgs of remoteName ? [['remote', 'get-url', remoteName], ['remote', 'get-url', '--push', remoteName]] : []) {
      const url = await runGitCommand(primaryWorktree, urlArgs);
      if (url.success && isDiskPathRemoteUrl(url.stdout.trim())) return '';
    }
    return remoteName;
  };

  const withRemoteProvisioningQueue = async <Result>(primaryWorktree: string, remoteName: string, task: () => Promise<Result>) => {
    const key = `${path.resolve(primaryWorktree)}::${remoteName}`;
    const previous = remoteProvisioningQueues.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(task);
    const tail = current.catch(() => {});
    remoteProvisioningQueues.set(key, tail);
    try {
      return await current;
    } finally {
      if (remoteProvisioningQueues.get(key) === tail) remoteProvisioningQueues.delete(key);
    }
  };

  const isSameRemoteUrl = async (primaryWorktree: string, effectiveUrl: string, url: string) => {
    if (effectiveUrl === url) return true;
    const probe = `openchamber-url-probe-${randomUUID()}`;
    const rewritten = await runGitCommand(primaryWorktree, [
      '-c', `remote.${probe}.url=${url}`, 'ls-remote', '--get-url', probe,
    ]);
    return rewritten.success && String(rewritten.stdout || '').trim() === effectiveUrl;
  };

  const ensureRemoteWithUrlUnlocked = async (primaryWorktree: string, remoteName: string, remoteUrl: string) => {
    const name = String(remoteName || '').trim();
    const url = String(remoteUrl || '').trim();
    if (!name || !url) {
      return;
    }

    const getUrl = await runGitCommand(primaryWorktree, ['remote', 'get-url', '--', name]);
    if (getUrl.success) {
      if (!(await isSameRemoteUrl(primaryWorktree, String(getUrl.stdout || '').trim(), url))) {
        const error: Error & { code?: string; status?: number; remoteName?: string } = new Error(`Remote ${name} already exists with a different endpoint`);
        error.code = 'CONTRIBUTOR_REMOTE_COLLISION';
        error.status = 409;
        error.remoteName = name;
        throw error;
      }
      return;
    }

    await runGitCommandOrThrow(primaryWorktree, ['remote', 'add', '--', name, url], 'Failed to add git remote');
  };

  const ensureRemoteWithUrl = (primaryWorktree: string, remoteName: string, remoteUrl: string) => withRemoteProvisioningQueue(
    primaryWorktree,
    remoteName,
    () => ensureRemoteWithUrlUnlocked(primaryWorktree, remoteName, remoteUrl)
  );

  const captureRemoteUrl = async (primaryWorktree: string, remoteName: string) => {
    const result = await runGitCommand(primaryWorktree, ['remote', 'get-url', remoteName]);
    return result.success
      ? { exists: true, url: String(result.stdout || '').trim() }
      : { exists: false, url: '' };
  };

  const restoreProvisionedRemote = async (primaryWorktree: string, remoteName: string, provisionedUrl: string, previous: { exists: boolean; url: string }) => {
    const current = await captureRemoteUrl(primaryWorktree, remoteName);
    if (!current.exists) {
      if (!previous.exists) return;
      throw new Error(`Remote ${remoteName} changed during worktree creation`);
    }
    if (!(await isSameRemoteUrl(primaryWorktree, current.url, provisionedUrl))) {
      throw new Error(`Remote ${remoteName} changed during worktree creation`);
    }
    if (previous.exists) {
      return;
    }
    await runGitCommandOrThrow(primaryWorktree, ['remote', 'remove', '--', remoteName], 'Failed to remove provisioned git remote');
  };

  return {
    networkRemoteName, withRemoteProvisioningQueue, isSameRemoteUrl, ensureRemoteWithUrlUnlocked,
    ensureRemoteWithUrl, captureRemoteUrl, restoreProvisionedRemote,
  };
};
