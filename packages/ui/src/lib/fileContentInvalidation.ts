const FILE_CONTENT_INVALIDATED_EVENT = 'openchamber:files:content-invalidated';

type FileContentInvalidatedDetail = {
  paths: string[];
};

const sanitizePaths = (paths: string[]): string[] => {
  return Array.from(
    new Set(
      paths
        .map((path) => (typeof path === 'string' ? path.trim() : ''))
        .filter(Boolean)
    )
  );
};

export const notifyFileContentInvalidated = (paths: string[]): void => {
  if (typeof window === 'undefined') {
    return;
  }

  const sanitizedPaths = sanitizePaths(paths);
  if (sanitizedPaths.length === 0) {
    return;
  }

  window.dispatchEvent(new CustomEvent<FileContentInvalidatedDetail>(FILE_CONTENT_INVALIDATED_EVENT, {
    detail: { paths: sanitizedPaths },
  }));
};

export const subscribeToFileContentInvalidated = (
  listener: (paths: string[]) => void
): (() => void) => {
  if (typeof window === 'undefined') {
    return () => undefined;
  }

  const handler = (event: Event) => {
    const customEvent = event as CustomEvent<FileContentInvalidatedDetail>;
    const nextPaths = sanitizePaths(Array.isArray(customEvent.detail?.paths) ? customEvent.detail.paths : []);
    if (nextPaths.length === 0) {
      return;
    }
    listener(nextPaths);
  };

  window.addEventListener(FILE_CONTENT_INVALIDATED_EVENT, handler as EventListener);
  return () => {
    window.removeEventListener(FILE_CONTENT_INVALIDATED_EVENT, handler as EventListener);
  };
};
