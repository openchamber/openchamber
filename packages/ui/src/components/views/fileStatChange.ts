type FileStatChangeInput = {
  size: number;
  mtimeMs?: number;
};

// Some filesystems report sub-millisecond mtime jitter for unchanged files.
const MIN_MTIME_CHANGE_MS = 1;

export const hasFileStatChanged = (
  previous: FileStatChangeInput,
  latest: FileStatChangeInput,
): boolean => latest.size !== previous.size || (
  latest.mtimeMs !== undefined
  && previous.mtimeMs !== undefined
  && Math.abs(latest.mtimeMs - previous.mtimeMs) >= MIN_MTIME_CHANGE_MS
);
