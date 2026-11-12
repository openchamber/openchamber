/**
 * Directories whose source-control read contexts the sidebar has registered,
 * with the runtime each was registered under.
 */
export type RegisteredContextDirectories = Map<string, string>;

/**
 * Brings the registered directories in line with the ones now shown. Badges
 * read the registered contexts, so a directory still shown keeps its
 * registration until a fresh read replaces it: deleting, adding or renaming a
 * sibling worktree must not blank its badge. Directories that left the shown
 * set, or were registered under another runtime, are released.
 */
export const reconcileRegisteredContextDirectories = (
  registered: RegisteredContextDirectories,
  runtimeKey: string,
  shownDirectories: ReadonlySet<string>,
  release: (runtimeKey: string, directory: string) => void,
): void => {
  for (const [directory, registeredRuntimeKey] of registered) {
    if (registeredRuntimeKey === runtimeKey && shownDirectories.has(directory)) continue;
    release(registeredRuntimeKey, directory);
    registered.delete(directory);
  }
  for (const directory of shownDirectories) registered.set(directory, runtimeKey);
};
