import * as gitHttp from '@/lib/gitApiHttp';
import type { GitWorktreeBootstrapStatus } from '@/lib/api/types';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { toast } from '@/components/ui';
import { formatMessage, useI18nStore, type I18nKey, type I18nParams } from '@/lib/i18n';

type WorktreeBootstrapState = GitWorktreeBootstrapStatus;
type WorktreeBootstrapFailureHandler = (status: GitWorktreeBootstrapStatus) => void;
type WorktreeBootstrapReadyHandler = (status: GitWorktreeBootstrapStatus) => void;

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 250;

const normalizePath = (value: string): string => value.replace(/\\/g, '/').replace(/\/+$/, '') || value;

const state = new Map<string, WorktreeBootstrapState>();
const waiters = new Map<string, Promise<void>>();
const watchers = new Map<string, { cancelled: boolean; promise: Promise<void> }>();

const getKey = (directory: string): string => normalizePath(directory);

const getGitWorktreeBootstrapStatus = async (directory: string): Promise<GitWorktreeBootstrapStatus> => {
  const runtimeGit = getRegisteredRuntimeAPIs()?.git;
  if (runtimeGit?.worktree?.bootstrapStatus) {
    return runtimeGit.worktree.bootstrapStatus(directory);
  }
  if (runtimeGit?.getGitWorktreeBootstrapStatus) {
    return runtimeGit.getGitWorktreeBootstrapStatus(directory);
  }
  return gitHttp.getGitWorktreeBootstrapStatus(directory);
};

export const markWorktreeBootstrapPending = (directory: string): void => {
  const key = getKey(directory);
  if (!key) {
    return;
  }
  state.set(key, {
    status: 'pending',
    error: null,
    updatedAt: Date.now(),
  });
};

export const clearWorktreeBootstrapState = (directory: string): void => {
  const key = getKey(directory);
  if (!key) {
    return;
  }
  const watcher = watchers.get(key);
  if (watcher) {
    watcher.cancelled = true;
    watchers.delete(key);
  }
  state.delete(key);
  waiters.delete(key);
};

export const setWorktreeBootstrapState = (directory: string, next: WorktreeBootstrapState): void => {
  const key = getKey(directory);
  if (!key) {
    return;
  }
  state.set(key, next);
  if (next.status !== 'pending') {
    waiters.delete(key);
  }
};

export const getWorktreeBootstrapState = (directory: string): WorktreeBootstrapState | null => {
  const key = getKey(directory);
  if (!key) {
    return null;
  }
  return state.get(key) ?? null;
};

const t = (key: I18nKey, params?: I18nParams): string => {
  const dictionary = useI18nStore.getState().dictionary;
  return formatMessage(dictionary, key, params);
};

const createFailedStatus = (error: string): GitWorktreeBootstrapStatus => ({
  status: 'failed',
  error,
  updatedAt: Date.now(),
});

const markBootstrapFailed = (
  directory: string,
  error: string,
  onFailed?: WorktreeBootstrapFailureHandler,
): GitWorktreeBootstrapStatus => {
  const failed = createFailedStatus(error);
  setWorktreeBootstrapState(directory, failed);
  onFailed?.(failed);
  return failed;
};

const pollWorktreeBootstrapUntilSettled = async (directory: string, timeoutMs: number): Promise<void> => {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const result = await getGitWorktreeBootstrapStatus(directory);
    setWorktreeBootstrapState(directory, result);

    if (result.status === 'ready') {
      return;
    }

    if (result.status === 'failed') {
      throw new Error(result.error || 'Worktree bootstrap failed');
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  const failed = markBootstrapFailed(directory, t('worktree.bootstrap.toast.timeoutDescription'));
  throw new Error(failed.error || 'Timed out waiting for worktree bootstrap');
};

const pollWorktreeBootstrapInBackground = async (
  directory: string,
  watcher: { cancelled: boolean },
  timeoutMs: number,
  pollIntervalMs: number,
  onFailed?: WorktreeBootstrapFailureHandler,
  onReady?: WorktreeBootstrapReadyHandler,
): Promise<void> => {
  const startedAt = Date.now();

  while (!watcher.cancelled && Date.now() - startedAt < timeoutMs) {
    const result = await getGitWorktreeBootstrapStatus(directory);
    if (watcher.cancelled) {
      return;
    }
    setWorktreeBootstrapState(directory, result);

    if (result.status === 'ready') {
      onReady?.(result);
      return;
    }

    if (result.status === 'failed') {
      onFailed?.(result);
      toast.error(t('worktree.bootstrap.toast.failed'), {
        description: result.error || t('worktree.bootstrap.toast.failedDescription'),
      });
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  if (!watcher.cancelled) {
    const failed = markBootstrapFailed(directory, t('worktree.bootstrap.toast.timeoutDescription'), onFailed);
    toast.error(t('worktree.bootstrap.toast.failed'), {
      description: failed.error || t('worktree.bootstrap.toast.failedDescription'),
    });
  }
};

export const startWorktreeBootstrapWatcher = (
  directory: string,
  options?: {
    timeoutMs?: number;
    pollIntervalMs?: number;
    onFailed?: WorktreeBootstrapFailureHandler;
    onReady?: WorktreeBootstrapReadyHandler;
  },
): void => {
  const key = getKey(directory);
  if (!key) {
    return;
  }

  const current = state.get(key);
  if (current?.status !== 'pending') {
    return;
  }

  if (watchers.has(key)) {
    return;
  }

  const watcher = { cancelled: false, promise: Promise.resolve() };
  watcher.promise = pollWorktreeBootstrapInBackground(
    directory,
    watcher,
    options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    options?.pollIntervalMs ?? POLL_INTERVAL_MS,
    options?.onFailed,
    options?.onReady,
  ).catch((error) => {
    if (watcher.cancelled) {
      return;
    }
    const failed = markBootstrapFailed(
      directory,
      error instanceof Error ? error.message : String(error),
      options?.onFailed,
    );
    toast.error(t('worktree.bootstrap.toast.failed'), {
      description: failed.error || t('worktree.bootstrap.toast.failedDescription'),
    });
  }).finally(() => {
    if (watchers.get(key) === watcher) {
      watchers.delete(key);
    }
  });
  watchers.set(key, watcher);
};

export const waitForWorktreeBootstrap = async (directory: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> => {
  const key = getKey(directory);
  if (!key) {
    return;
  }

  const current = state.get(key);
  if (!current) {
    return;
  }

  if (current?.status === 'ready') {
    return;
  }
  if (current?.status === 'failed') {
    throw new Error(current.error || 'Worktree bootstrap failed');
  }

  const existing = waiters.get(key);
  if (existing) {
    return existing;
  }

  const pending = pollWorktreeBootstrapUntilSettled(directory, timeoutMs).finally(() => {
    waiters.delete(key);
  });
  waiters.set(key, pending);
  return pending;
};
