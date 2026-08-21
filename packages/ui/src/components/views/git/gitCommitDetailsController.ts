import type {
  GitAPI,
  GitCommitChangedFile,
  GitCommitFilePreviewRequest,
  GitCommitFilePreviewResponse,
} from '@/lib/api/types';

const MAX_METADATA_ENTRIES = 32;
const MAX_METADATA_CONCURRENCY = 2;
const MAX_PREVIEW_ENTRIES = 12;
const MAX_PREVIEW_BYTES = 8 * 1024 * 1024;
const LARGE_PREVIEW_CHANGED_LINES = 500;

export type GitCommitComparison = {
  directory: string;
  commitHash: string;
  parentHash: string | null;
};

export type GitCommitChangesSnapshot =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'empty' }
  | { status: 'ready'; files: readonly GitCommitChangedFile[] }
  | { status: 'error'; error: Error; retryCount: number };

export type GitCommitPreviewSnapshot =
  | { status: 'idle' }
  | { status: 'loading'; comparison: GitCommitComparison; file: GitCommitChangedFile }
  | { status: 'confirm-large'; comparison: GitCommitComparison; file: GitCommitChangedFile; changedLines: number; maxChangedLines: number }
  | { status: 'binary'; comparison: GitCommitComparison; file: GitCommitChangedFile }
  | { status: 'gitlink'; comparison: GitCommitComparison; file: GitCommitChangedFile; originalObjectId: string | null; objectId: string | null }
  | { status: 'ready'; comparison: GitCommitComparison; file: GitCommitChangedFile; original: string | null; modified: string | null }
  | { status: 'too-large'; comparison: GitCommitComparison; file: GitCommitChangedFile; totalBytes: number; maxBytes: number }
  | { status: 'error'; comparison: GitCommitComparison; file: GitCommitChangedFile; error: Error; retryCount: number };

export interface GitCommitDetailsController {
  getCommitSnapshot(key: GitCommitComparison): GitCommitChangesSnapshot;
  subscribeCommit(key: GitCommitComparison, listener: () => void): () => void;
  isExpanded(key: GitCommitComparison): boolean;
  subscribeExpanded(listener: () => void): () => void;
  toggleExpanded(key: GitCommitComparison): void;
  retryCommit(key: GitCommitComparison): void;
  selectFile(key: GitCommitComparison, file: GitCommitChangedFile): void;
  confirmLargePreview(): void;
  retryPreview(): void;
  clearSelection(): void;
  getPreviewSnapshot(): GitCommitPreviewSnapshot;
  subscribePreview(listener: () => void): () => void;
  dispose(): void;
}

type IdleScheduler = (callback: () => void) => () => void;

type MetadataEntry = {
  key: GitCommitComparison;
  cacheKey: string;
  snapshot: GitCommitChangesSnapshot;
  listeners: Set<() => void>;
  expanded: boolean;
  queued: boolean;
  inFlight: boolean;
  generation: number;
  retryCount: number;
};

type PreviewSelection = {
  comparison: GitCommitComparison;
  file: GitCommitChangedFile;
  request: GitCommitFilePreviewRequest;
  requestKey: string;
  generation: number;
  confirmedLarge: boolean;
};

type PreviewCacheEntry = {
  selection: PreviewSelection;
  snapshot: Extract<GitCommitPreviewSnapshot, { status: 'ready' }>;
  byteSize: number;
};

const IDLE_COMMIT_SNAPSHOT: GitCommitChangesSnapshot = { status: 'idle' };
const LOADING_COMMIT_SNAPSHOT: GitCommitChangesSnapshot = { status: 'loading' };
const EMPTY_COMMIT_SNAPSHOT: GitCommitChangesSnapshot = { status: 'empty' };
const IDLE_PREVIEW_SNAPSHOT: GitCommitPreviewSnapshot = { status: 'idle' };

export const scheduleGitCommitDetailsIdle = (callback: () => void) => {
  if ('requestIdleCallback' in globalThis && 'cancelIdleCallback' in globalThis) {
    const handle = globalThis.requestIdleCallback(callback);
    return () => globalThis.cancelIdleCallback(handle);
  }

  const handle = globalThis.setTimeout(callback, 0);
  return () => globalThis.clearTimeout(handle);
};

const toComparisonKey = (key: GitCommitComparison): string => JSON.stringify([key.directory, key.commitHash, key.parentHash]);

const toPreviewRequest = (key: GitCommitComparison, file: GitCommitChangedFile): GitCommitFilePreviewRequest => ({
  commitHash: key.commitHash,
  parentHash: key.parentHash,
  originalPath: file.status === 'A' ? null : (file.originalPath ?? file.path),
  modifiedPath: file.status === 'D' ? null : file.path,
});

const toPreviewRequestKey = (key: GitCommitComparison, request: GitCommitFilePreviewRequest): string => (
  JSON.stringify([
    key.directory,
    request.commitHash,
    request.parentHash,
    request.originalPath,
    request.modifiedPath,
  ])
);

const countChangedLines = (file: GitCommitChangedFile): number => file.insertions + file.deletions;

const getPreviewReadySize = (snapshot: Extract<GitCommitPreviewSnapshot, { status: 'ready' }>): number => {
  return ((snapshot.original?.length ?? 0) + (snapshot.modified?.length ?? 0)) * 2;
};

const toReadyPreviewSnapshot = (
  selection: PreviewSelection,
  response: Extract<GitCommitFilePreviewResponse, { status: 'ready' }>,
): Extract<GitCommitPreviewSnapshot, { status: 'ready' }> => {
  const original = selection.file.status === 'A' ? null : response.original;
  const modified = selection.file.status === 'D' ? null : response.modified;
  return {
    status: 'ready',
    comparison: selection.comparison,
    file: selection.file,
    original,
    modified,
  };
};

export function createGitCommitDetailsController(options: {
  directory: string;
  git: GitAPI;
  scheduleIdle: IdleScheduler;
}): GitCommitDetailsController {
  const metadataEntries = new Map<string, MetadataEntry>();
  const expandedListeners = new Set<() => void>();
  const previewListeners = new Set<() => void>();
  const previewCache = new Map<string, PreviewCacheEntry>();
  const previewRetryCounts = new Map<string, number>();
  const previewLatestGeneration = new Map<string, number>();

  let disposed = false;
  let metadataActiveLoads = 0;
  let metadataTrimCancel: (() => void) | null = null;
  let previewTrimCancel: (() => void) | null = null;
  let previewGeneration = 0;
  let previewSnapshot: GitCommitPreviewSnapshot = IDLE_PREVIEW_SNAPSHOT;
  let currentPreviewSelection: PreviewSelection | null = null;
  let queuedPreviewSelection: PreviewSelection | null = null;
  let previewInFlight: PreviewSelection | null = null;

  const notifyExpanded = () => {
    for (const listener of expandedListeners) {
      listener();
    }
  };

  const notifyCommit = (entry: MetadataEntry) => {
    for (const listener of entry.listeners) {
      listener();
    }
  };

  const notifyPreview = () => {
    for (const listener of previewListeners) {
      listener();
    }
  };

  const setPreviewSnapshot = (next: GitCommitPreviewSnapshot) => {
    if (previewSnapshot === next) {
      return;
    }
    previewSnapshot = next;
    notifyPreview();
  };

  const getOrCreateMetadataEntry = (key: GitCommitComparison): MetadataEntry => {
    const cacheKey = toComparisonKey(key);
    const existing = metadataEntries.get(cacheKey);
    if (existing) {
      return existing;
    }

    const created: MetadataEntry = {
      key,
      cacheKey,
      snapshot: IDLE_COMMIT_SNAPSHOT,
      listeners: new Set(),
      expanded: false,
      queued: false,
      inFlight: false,
      generation: 0,
      retryCount: 0,
    };
    metadataEntries.set(cacheKey, created);
    return created;
  };

  const touchMetadataEntry = (entry: MetadataEntry) => {
    metadataEntries.delete(entry.cacheKey);
    metadataEntries.set(entry.cacheKey, entry);
  };

  const setMetadataSnapshot = (entry: MetadataEntry, next: GitCommitChangesSnapshot) => {
    if (entry.snapshot === next) {
      return;
    }
    entry.snapshot = next;
    touchMetadataEntry(entry);
    notifyCommit(entry);
  };

  const isMetadataProtected = (entry: MetadataEntry): boolean => {
    return entry.expanded || entry.listeners.size > 0 || entry.inFlight || entry.queued;
  };

  const cancelMetadataTrim = () => {
    metadataTrimCancel?.();
    metadataTrimCancel = null;
  };

  const scheduleMetadataTrim = () => {
    if (disposed || metadataTrimCancel !== null || metadataEntries.size <= MAX_METADATA_ENTRIES) {
      return;
    }

    metadataTrimCancel = options.scheduleIdle(() => {
      metadataTrimCancel = null;
      if (disposed) {
        return;
      }

      for (const [cacheKey, entry] of metadataEntries) {
        if (metadataEntries.size <= MAX_METADATA_ENTRIES) {
          break;
        }
        if (isMetadataProtected(entry)) {
          continue;
        }
        metadataEntries.delete(cacheKey);
      }
    });
  };

  const maybeStartNextMetadataLoad = () => {
    if (disposed || metadataActiveLoads >= MAX_METADATA_CONCURRENCY) {
      return;
    }

    for (const entry of metadataEntries.values()) {
      if (!entry.queued) {
        continue;
      }
      entry.queued = false;
      entry.inFlight = true;
      metadataActiveLoads += 1;
      const generation = entry.generation + 1;
      entry.generation = generation;
      setMetadataSnapshot(entry, LOADING_COMMIT_SNAPSHOT);

      void (async () => {
        try {
          const response = await options.git.getCommitFiles(options.directory, {
            commitHash: entry.key.commitHash,
            parentHash: entry.key.parentHash,
          });
          if (disposed || entry.generation !== generation) {
            return;
          }

          entry.retryCount = 0;
          if (response.files.length === 0) {
            setMetadataSnapshot(entry, EMPTY_COMMIT_SNAPSHOT);
          } else {
            setMetadataSnapshot(entry, { status: 'ready', files: response.files });
          }
        } catch (error) {
          if (disposed || entry.generation !== generation) {
            return;
          }

          entry.retryCount += 1;
          setMetadataSnapshot(entry, {
            status: 'error',
            error: error instanceof Error ? error : new Error(String(error)),
            retryCount: entry.retryCount,
          });
        } finally {
          entry.inFlight = false;
          metadataActiveLoads -= 1;
          maybeStartNextMetadataLoad();
          scheduleMetadataTrim();
        }
      })();

      break;
    }
  };

  const requestMetadataLoad = (entry: MetadataEntry) => {
    if (disposed || entry.inFlight || entry.queued) {
      return;
    }

    entry.queued = true;
    setMetadataSnapshot(entry, LOADING_COMMIT_SNAPSHOT);
    maybeStartNextMetadataLoad();
  };

  const cancelPreviewTrim = () => {
    previewTrimCancel?.();
    previewTrimCancel = null;
  };

  const schedulePreviewTrim = () => {
    if (disposed || previewTrimCancel !== null) {
      return;
    }

    previewTrimCancel = options.scheduleIdle(() => {
      previewTrimCancel = null;
      if (disposed) {
        return;
      }

      let totalBytes = 0;
      for (const entry of previewCache.values()) {
        totalBytes += entry.byteSize;
      }

      for (const [cacheKey, entry] of previewCache) {
        const isProtected = currentPreviewSelection?.requestKey === cacheKey;
        if (previewCache.size <= MAX_PREVIEW_ENTRIES && totalBytes <= MAX_PREVIEW_BYTES) {
          break;
        }
        if (isProtected) {
          continue;
        }
        previewCache.delete(cacheKey);
        totalBytes -= entry.byteSize;
      }
    });
  };

  const touchPreviewCacheEntry = (cacheKey: string, entry: PreviewCacheEntry) => {
    previewCache.delete(cacheKey);
    previewCache.set(cacheKey, entry);
  };

  const getCachedPreviewSnapshot = (selection: PreviewSelection) => {
    const cached = previewCache.get(selection.requestKey);
    if (!cached) {
      return null;
    }
    touchPreviewCacheEntry(selection.requestKey, cached);
    return cached.snapshot;
  };

  const maybeStartQueuedPreview = () => {
    if (disposed || previewInFlight !== null || queuedPreviewSelection === null) {
      return;
    }

    const nextSelection = queuedPreviewSelection;
    queuedPreviewSelection = null;
    currentPreviewSelection = nextSelection;
    const cached = getCachedPreviewSnapshot(nextSelection);
    if (cached !== null) {
      setPreviewSnapshot(cached);
      schedulePreviewTrim();
      return;
    }
    startPreviewLoad(nextSelection);
  };

  function startPreviewLoad(selection: PreviewSelection) {
    previewInFlight = selection;
    currentPreviewSelection = selection;
    setPreviewSnapshot({ status: 'loading', comparison: selection.comparison, file: selection.file });

    void (async () => {
      try {
        const response = await options.git.getCommitFileDiff?.(options.directory, selection.request);
        if (disposed || response === undefined) {
          return;
        }

        if (previewLatestGeneration.get(selection.requestKey) !== selection.generation) {
          return;
        }

        if (response.status === 'too-large') {
          if (currentPreviewSelection?.generation === selection.generation) {
            setPreviewSnapshot({
              status: 'too-large',
              comparison: selection.comparison,
              file: selection.file,
              totalBytes: response.totalBytes,
              maxBytes: response.maxBytes,
            });
          }
          return;
        }

        const snapshot = toReadyPreviewSnapshot(selection, response);
        const byteSize = getPreviewReadySize(snapshot);
        touchPreviewCacheEntry(selection.requestKey, { selection, snapshot, byteSize });
        schedulePreviewTrim();

        if (currentPreviewSelection?.generation === selection.generation) {
          setPreviewSnapshot(snapshot);
        }
      } catch (error) {
        if (disposed || previewLatestGeneration.get(selection.requestKey) !== selection.generation) {
          return;
        }

        const retryCount = (previewRetryCounts.get(selection.requestKey) ?? 0) + 1;
        previewRetryCounts.set(selection.requestKey, retryCount);
        if (currentPreviewSelection?.generation === selection.generation) {
          setPreviewSnapshot({
            status: 'error',
            comparison: selection.comparison,
            file: selection.file,
            error: error instanceof Error ? error : new Error(String(error)),
            retryCount,
          });
        }
      } finally {
        if (previewInFlight?.generation === selection.generation) {
          previewInFlight = null;
        }
        maybeStartQueuedPreview();
      }
    })();
  }

  const showDerivedPreviewState = (selection: PreviewSelection): boolean => {
    if (selection.file.kind === 'gitlink') {
      setPreviewSnapshot({
        status: 'gitlink',
        comparison: selection.comparison,
        file: selection.file,
        originalObjectId: selection.file.originalObjectId ?? null,
        objectId: selection.file.objectId ?? null,
      });
      return true;
    }
    if (selection.file.isBinary) {
      setPreviewSnapshot({ status: 'binary', comparison: selection.comparison, file: selection.file });
      return true;
    }
    const changedLines = countChangedLines(selection.file);
    if (changedLines > LARGE_PREVIEW_CHANGED_LINES && !selection.confirmedLarge) {
      setPreviewSnapshot({
        status: 'confirm-large',
        comparison: selection.comparison,
        file: selection.file,
        changedLines,
        maxChangedLines: LARGE_PREVIEW_CHANGED_LINES,
      });
      return true;
    }
    return false;
  };

  const activatePreviewSelection = (selection: PreviewSelection) => {
    previewLatestGeneration.set(selection.requestKey, selection.generation);
    currentPreviewSelection = selection;

    if (showDerivedPreviewState(selection)) {
      return;
    }

    const cached = getCachedPreviewSnapshot(selection);
    if (cached !== null) {
      setPreviewSnapshot(cached);
      schedulePreviewTrim();
      return;
    }

    if (previewInFlight !== null) {
      queuedPreviewSelection = selection;
      setPreviewSnapshot({ status: 'loading', comparison: selection.comparison, file: selection.file });
      return;
    }

    startPreviewLoad(selection);
  };

  const createPreviewSelection = (
    comparison: GitCommitComparison,
    file: GitCommitChangedFile,
    confirmedLarge: boolean,
  ): PreviewSelection => {
    const request = toPreviewRequest(comparison, file);
    return {
      comparison,
      file,
      request,
      requestKey: toPreviewRequestKey(comparison, request),
      generation: ++previewGeneration,
      confirmedLarge,
    };
  };

  return {
    getCommitSnapshot(key) {
      return metadataEntries.get(toComparisonKey(key))?.snapshot ?? IDLE_COMMIT_SNAPSHOT;
    },

    subscribeCommit(key, listener) {
      if (disposed) {
        return () => {};
      }

      const entry = getOrCreateMetadataEntry(key);
      entry.listeners.add(listener);
      return () => {
        entry.listeners.delete(listener);
        scheduleMetadataTrim();
      };
    },

    isExpanded(key) {
      return metadataEntries.get(toComparisonKey(key))?.expanded ?? false;
    },

    subscribeExpanded(listener) {
      if (disposed) {
        return () => {};
      }

      expandedListeners.add(listener);
      return () => {
        expandedListeners.delete(listener);
      };
    },

    toggleExpanded(key) {
      if (disposed) {
        return;
      }

      const entry = getOrCreateMetadataEntry(key);
      entry.expanded = !entry.expanded;
      notifyExpanded();

      if (entry.expanded) {
        if (entry.snapshot.status === 'idle') {
          requestMetadataLoad(entry);
        }
        return;
      }

      scheduleMetadataTrim();
    },

    retryCommit(key) {
      if (disposed) {
        return;
      }

      const entry = getOrCreateMetadataEntry(key);
      requestMetadataLoad(entry);
    },

    selectFile(key, file) {
      if (disposed) {
        return;
      }

      activatePreviewSelection(createPreviewSelection(key, file, false));
    },

    confirmLargePreview() {
      if (disposed || currentPreviewSelection === null) {
        return;
      }

      activatePreviewSelection(createPreviewSelection(currentPreviewSelection.comparison, currentPreviewSelection.file, true));
    },

    retryPreview() {
      if (disposed || currentPreviewSelection === null) {
        return;
      }

      activatePreviewSelection(createPreviewSelection(
        currentPreviewSelection.comparison,
        currentPreviewSelection.file,
        currentPreviewSelection.confirmedLarge,
      ));
    },

    clearSelection() {
      if (disposed) {
        return;
      }

      currentPreviewSelection = null;
      queuedPreviewSelection = null;
      setPreviewSnapshot(IDLE_PREVIEW_SNAPSHOT);
      schedulePreviewTrim();
    },

    getPreviewSnapshot() {
      return previewSnapshot;
    },

    subscribePreview(listener) {
      if (disposed) {
        return () => {};
      }

      previewListeners.add(listener);
      return () => {
        previewListeners.delete(listener);
      };
    },

    dispose() {
      disposed = true;
      cancelMetadataTrim();
      cancelPreviewTrim();
      metadataEntries.clear();
      expandedListeners.clear();
      previewListeners.clear();
      previewCache.clear();
      previewRetryCounts.clear();
      previewLatestGeneration.clear();
      currentPreviewSelection = null;
      queuedPreviewSelection = null;
      previewInFlight = null;
      previewSnapshot = IDLE_PREVIEW_SNAPSHOT;
      metadataActiveLoads = 0;
    },
  };
}
