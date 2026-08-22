/**
 * Minimal notification channel for git status invalidation.
 *
 * A runtime adapter that caches git status (currently only the HTTP adapter in
 * `gitApiHttp.ts`) must call `notifyGitStatusInvalidated` whenever a successful
 * status-affecting mutation invalidates its cache. `useGitStore` subscribes and
 * bumps its per-directory status mutation revision so an immediate refresh
 * cannot join an in-flight status request admitted before the mutation, and a
 * stale response cannot commit over newer authoritative state.
 *
 * Runtime parity: the VS Code bridge adapter performs no client-side status
 * caching (every `getGitStatus` is a fresh bridge request), so it has no cache
 * to invalidate and does not emit this signal today. Any adapter that adds
 * caching must emit on invalidation.
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
