/**
 * Minimal notification channel for git status invalidation.
 *
 * Every confirmed status-affecting mutation must call
 * `notifyGitStatusInvalidated`. `useGitStore` subscribes and bumps its
 * per-directory status mutation revision so an immediate refresh cannot join an
 * in-flight status request admitted before the mutation, and a stale response
 * cannot commit over newer authoritative state. The HTTP adapter also subscribes
 * and clears its short-lived status cache.
 *
 * Runtime parity: this is about the store's in-flight status request, not about
 * adapter caching, so it applies to every runtime. HTTP mutations emit from
 * `gitApiHttp.ts`; runtime adapters such as the VS Code bridge emit from the
 * dispatch layer in `gitApi.ts`. Tool and editor mutations emit through the
 * shared Git refresh hint. Each path announces a mutation exactly once.
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
