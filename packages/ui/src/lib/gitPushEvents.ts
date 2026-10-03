import { normalizePath } from './pathNormalization';

type GitPushListener = (scope: string) => void;
const listeners = new Set<GitPushListener>();

export const gitPushScopeKey = (directory: string, runtimeKey: string): string =>
  JSON.stringify([runtimeKey, normalizePath(directory)]);

export function subscribeGitPush(listener: GitPushListener) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Announce only a confirmed push, against the runtime captured before it started. */
export function notifyGitPush(directory: string, runtimeKey: string) {
  const scope = gitPushScopeKey(directory, runtimeKey);
  for (const listener of listeners) listener(scope);
}
