import * as gitHttp from '@/lib/gitApiHttp';
import type { RuntimeAPIs } from '@/lib/api/types';
import type { GitWorktreeBootstrapStatus } from '@/lib/api/types';
import { normalizePath } from '@/lib/pathUtils';

declare global {
  interface Window {
    __OPENCHAMBER_RUNTIME_APIS__?: RuntimeAPIs;
  }
}

type WorktreeBootstrapState = GitWorktreeBootstrapStatus;

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 250;

const state = new Map<string, WorktreeBootstrapState>();
const waiters = new Map<string, Promise<void>>();

const getKey = (directory: string): string => normalizePath(directory) ?? '';

const getGitWorktreeBootstrapStatus = async (directory: string): Promise<GitWorktreeBootstrapStatus> => {
  const runtimeGit = typeof window !== 'undefined' ? window.__OPENCHAMBER_RUNTIME_APIS__?.git : undefined;
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

  throw new Error('Timed out waiting for worktree bootstrap');
};

export const waitForWorktreeBootstrap = async (directory: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> => {
  const key = getKey(directory);
  if (!key) {
    return;
  }

  const current = state.get(key);
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
