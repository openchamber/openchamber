/**
 * Minimal notification channel for git status invalidation.
 *
 * Every successful status-affecting git mutation must call
 * `notifyGitStatusInvalidated`. `useGitStore` subscribes and bumps its
 * per-directory status mutation revision so an immediate refresh cannot join an
 * in-flight status request admitted before the mutation, and a stale response
 * cannot commit over newer authoritative state.
 *
 * Runtime parity: this is about the store's in-flight status request, not about
 * adapter caching, so it applies to every runtime. The HTTP adapter in
 * `gitApiHttp.ts` emits it where it clears its own cache; runtime adapters (the
 * VS Code bridge) have no cache of their own, so the dispatch layer in
 * `gitApi.ts` emits it for them after a successful runtime mutation. Either
 * path announces a mutation exactly once.
 */

type GitStatusInvalidationListener = (directory: string) => void;

const listeners = new Set<GitStatusInvalidationListener>();

export const subscribeGitStatusInvalidations = (
  listener: GitStatusInvalidationListener
): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const notifyGitStatusInvalidated = (directory: string): void => {
  for (const listener of listeners) {
    listener(directory);
  }
};
