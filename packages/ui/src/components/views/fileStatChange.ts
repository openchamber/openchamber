type FileStatChangeInput = {
  size: number;
  mtimeMs?: number;
};

// Consecutive stat() calls for an unmodified file can report sub-millisecond mtimeMs
// jitter on network/overlay filesystems (NFS/SMB, Docker, FUSE) and via float
// round-tripping; ignore deltas below this to avoid an endless reload loop (#1489).
export const MIN_MTIME_CHANGE_MS = 1;

// Returns true only for a real external modification: a size change, or an mtime
// that moved by at least MIN_MTIME_CHANGE_MS.
export const hasFileStatChanged = (
  previous: FileStatChangeInput,
  latest: FileStatChangeInput,
): boolean => {
  if (latest.size !== previous.size) {
    return true;
  }

  if (
    latest.mtimeMs !== undefined
    && previous.mtimeMs !== undefined
    && Math.abs(latest.mtimeMs - previous.mtimeMs) >= MIN_MTIME_CHANGE_MS
  ) {
    return true;
  }

  return false;
};
