export type RegisteredContextDirectories = Map<string, string>;

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
