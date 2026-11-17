
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
