type FileContentInvalidation = {
  runtimeKey: string;
  paths: readonly string[];
};

type FileContentInvalidationListener = (invalidation: FileContentInvalidation) => void;

const listeners = new Set<FileContentInvalidationListener>();

export const notifyFileContentInvalidated = (invalidation: FileContentInvalidation): void => {
  const runtimeKey = invalidation.runtimeKey.trim();
  const paths = Array.from(new Set(invalidation.paths.map((path) => path.trim()).filter(Boolean)));
  if (!runtimeKey || paths.length === 0) return;

  for (const listener of listeners) {
    listener({ runtimeKey, paths });
  }
};

export const subscribeToFileContentInvalidation = (
  listener: FileContentInvalidationListener,
): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
