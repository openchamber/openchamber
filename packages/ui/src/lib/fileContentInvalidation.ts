const FILE_CONTENT_INVALIDATED_EVENT = 'openchamber:files:content-invalidated';

type FileContentInvalidatedDetail = {
  paths: string[];
  prefixes: string[];
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

type InvalidationPayload = {
  paths?: string[];
  prefixes?: string[];
};

export const notifyFileContentInvalidated = (payload: string[] | InvalidationPayload): void => {
  if (typeof window === 'undefined') {
    return;
  }

  const normalizedPayload: InvalidationPayload = Array.isArray(payload) ? { paths: payload } : payload;
  const sanitizedPaths = sanitizePaths(Array.isArray(normalizedPayload.paths) ? normalizedPayload.paths : []);
  const sanitizedPrefixes = sanitizePaths(Array.isArray(normalizedPayload.prefixes) ? normalizedPayload.prefixes : []);

  if (sanitizedPaths.length === 0 && sanitizedPrefixes.length === 0) {
    return;
  }

  window.dispatchEvent(new CustomEvent<FileContentInvalidatedDetail>(FILE_CONTENT_INVALIDATED_EVENT, {
    detail: {
      paths: sanitizedPaths,
      prefixes: sanitizedPrefixes,
    },
  }));
};

export const subscribeToFileContentInvalidated = (
  listener: (payload: { paths: string[]; prefixes: string[] }) => void
): (() => void) => {
  if (typeof window === 'undefined') {
    return () => undefined;
  }

  const handler = (event: Event) => {
    const customEvent = event as CustomEvent<FileContentInvalidatedDetail>;
    const nextPaths = sanitizePaths(Array.isArray(customEvent.detail?.paths) ? customEvent.detail.paths : []);
    const nextPrefixes = sanitizePaths(Array.isArray(customEvent.detail?.prefixes) ? customEvent.detail.prefixes : []);
    if (nextPaths.length === 0 && nextPrefixes.length === 0) {
      return;
    }
    listener({ paths: nextPaths, prefixes: nextPrefixes });
  };

  window.addEventListener(FILE_CONTENT_INVALIDATED_EVENT, handler as EventListener);
  return () => {
    window.removeEventListener(FILE_CONTENT_INVALIDATED_EVENT, handler as EventListener);
  };
};
