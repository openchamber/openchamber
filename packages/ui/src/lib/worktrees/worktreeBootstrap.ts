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
type WorktreeBootstrapTarget = 'git-ready' | 'setup-ready';

const waiters = new Map<string, Promise<void>>();
const lifecycleVersions = new Map<string, number>();
let nextLifecycleVersion = 0;
const watchers = new Map<string, { cancelled: boolean; lifecycleVersion: number }>();

const getKey = (directory: string): string => normalizePath(directory);
const getWaiterKey = (key: string, target: WorktreeBootstrapTarget): string => `${key}\n${target}`;

const startLifecycle = (key: string): void => {
  const watcher = watchers.get(key);
  if (watcher) {
    watcher.cancelled = true;
    watchers.delete(key);
  }

  waiters.delete(getWaiterKey(key, 'git-ready'));
  waiters.delete(getWaiterKey(key, 'setup-ready'));

  const version = ++nextLifecycleVersion;
  lifecycleVersions.set(key, version);
};

const isCurrentLifecycle = (key: string, version: number): boolean => lifecycleVersions.get(key) === version;

const phaseRank = (phase: GitWorktreeBootstrapStatus['phase']): number => {
  switch (phase) {
    case 'setup-ready':
      return 2;
    case 'git-ready':
      return 1;
    case 'directory-created':
    default:
      return 0;
  }
};

const storePolledState = (
  key: string,
  next: WorktreeBootstrapState,
  lifecycleVersion: number,
): WorktreeBootstrapState | null => {
  if (!isCurrentLifecycle(key, lifecycleVersion)) {
    return null;
  }

  const current = state.get(key);
  const wouldRegressReadyState = current?.status === 'ready' && next.status === 'pending';
  const wouldRegressPendingPhase = current?.status === 'pending'
    && next.status === 'pending'
    && phaseRank(next.phase) < phaseRank(current.phase);

  if (wouldRegressReadyState || wouldRegressPendingPhase) {
    return current;
  }

  state.set(key, next);
  return next;
};

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
  startLifecycle(key);
  state.set(key, {
    status: 'pending',
    phase: 'directory-created',
    error: null,
    updatedAt: Date.now(),
  });
};

export const clearWorktreeBootstrapState = (directory: string): void => {
  const key = getKey(directory);
  if (!key) {
    return;
  }
  startLifecycle(key);
  state.delete(key);
  lifecycleVersions.delete(key);
};

export const setWorktreeBootstrapState = (directory: string, next: WorktreeBootstrapState): void => {
  const key = getKey(directory);
  if (!key) {
    return;
  }
  startLifecycle(key);
  state.set(key, next);
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

const hasReachedTarget = (status: GitWorktreeBootstrapStatus, target: WorktreeBootstrapTarget): boolean => {
  if (status.status === 'ready') return true;
  if (target === 'git-ready' && (status.phase === 'git-ready' || status.phase === 'setup-ready')) return true;
  return false;
};

const pollWorktreeBootstrapUntilSettled = async (
  directory: string,
  key: string,
  lifecycleVersion: number,
  timeoutMs: number,
  target: WorktreeBootstrapTarget,
): Promise<void> => {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const result = await getGitWorktreeBootstrapStatus(directory);
    const current = storePolledState(key, result, lifecycleVersion);
    if (!current) {
      throw new Error('Worktree bootstrap wait was cancelled');
    }

    if (hasReachedTarget(current, target)) {
      return;
    }

    if (current.status === 'failed') {
      throw new Error(current.error || 'Worktree bootstrap failed');
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  const failed = markBootstrapFailed(directory, t('worktree.bootstrap.toast.timeoutDescription'));
  throw new Error(failed.error || 'Timed out waiting for worktree bootstrap');
};

const pollWorktreeBootstrapInBackground = async (
  directory: string,
  key: string,
  watcher: { cancelled: boolean; lifecycleVersion: number },
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
    const current = storePolledState(key, result, watcher.lifecycleVersion);
    if (!current) {
      return;
    }

    if (current.status === 'ready') {
      onReady?.(current);
      return;
    }

    if (current.status === 'failed') {
      onFailed?.(current);
      toast.error(t('worktree.bootstrap.toast.failed'), {
        description: current.error || t('worktree.bootstrap.toast.failedDescription'),
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

  const watcher = {
    cancelled: false,
    lifecycleVersion: lifecycleVersions.get(key) ?? 0,
  };
  void pollWorktreeBootstrapInBackground(
    directory,
    key,
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

const waitForWorktreePhase = async (
  directory: string,
  target: WorktreeBootstrapTarget,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<void> => {
  const key = getKey(directory);
  if (!key) {
    return;
  }

  const current = state.get(key);
  if (!current) {
    return;
  }

  if (hasReachedTarget(current, target)) {
    return;
  }
  if (current?.status === 'failed') {
    throw new Error(current.error || 'Worktree bootstrap failed');
  }

  const waiterKey = getWaiterKey(key, target);
  const existing = waiters.get(waiterKey);
  if (existing) {
    return existing;
  }

  const lifecycleVersion = lifecycleVersions.get(key) ?? 0;
  const pending = pollWorktreeBootstrapUntilSettled(directory, key, lifecycleVersion, timeoutMs, target).finally(() => {
    if (waiters.get(waiterKey) === pending) {
      waiters.delete(waiterKey);
    }
  });
  waiters.set(waiterKey, pending);
  return pending;
};

export const waitForWorktreeGitReady = (directory: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> =>
  waitForWorktreePhase(directory, 'git-ready', timeoutMs);

export const waitForWorktreeBootstrap = (directory: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> =>
  waitForWorktreePhase(directory, 'setup-ready', timeoutMs);
