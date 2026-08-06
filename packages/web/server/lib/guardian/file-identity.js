const FILE_TYPES = new Set([
  'file',
  'socket',
  'directory',
  'symbolic-link',
  'character-device',
  'block-device',
  'fifo',
]);

const normalizeScalar = (value) => {
  if (typeof value === 'bigint') return value.toString(10);
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
  if (typeof value === 'string') {
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
  }
  return null;
};

const normalizeTimestamp = (value, unit) => {
  const normalized = normalizeScalar(value);
  return normalized === null ? null : `${unit}:${normalized}`;
};

const statType = (stat) => {
  if (typeof stat?.type === 'string' && FILE_TYPES.has(stat.type)) return stat.type;
  if (stat?.isSymbolicLink?.()) return 'symbolic-link';
  if (stat?.isSocket?.()) return 'socket';
  if (stat?.isFile?.()) return 'file';
  if (stat?.isDirectory?.()) return 'directory';
  if (stat?.isCharacterDevice?.()) return 'character-device';
  if (stat?.isBlockDevice?.()) return 'block-device';
  if (stat?.isFIFO?.()) return 'fifo';
  return null;
};

const statTimestamp = (stat, kind) => {
  const normalized = typeof stat?.[kind] === 'string' ? stat[kind] : null;
  if (normalized) return normalized;

  const ns = normalizeTimestamp(stat?.[`${kind}Ns`], 'ns');
  if (ns !== null) return ns;
  return normalizeTimestamp(stat?.[`${kind}Ms`], 'ms');
};

/**
 * Take a JSON-safe snapshot of a filesystem object's identity.
 *
 * `dev`/`ino` can be recycled after unlink/recreate on filesystems such as
 * XFS. The birth time is preferred because it survives hard-link publication
 * and rename quarantine; ctime is the portable fallback when Node/filesystem
 * metadata does not expose birth time. File type is part of the fence so a
 * socket/file substitution cannot pass the same identity check. A ctime-only
 * identity is therefore generation-sensitive and must be refreshed only after
 * a held descriptor proves that an atomic quarantine operation moved the same
 * object; callers must not ignore a ctime mismatch from pathname metadata.
 *
 * Stats objects may expose number or bigint fields. Every value is normalized
 * to text so identity comparisons remain portable and never lose a Windows
 * NTFS file-id bit through a JSON/number conversion.
 */
export const snapshotFileIdentity = (stat) => {
  if (!stat || typeof stat !== 'object') return null;

  const dev = normalizeScalar(stat.dev);
  const ino = normalizeScalar(stat.ino);
  const type = statType(stat);
  const birthtime = statTimestamp(stat, 'birthtime');
  const ctime = statTimestamp(stat, 'ctime');
  const stableTime = birthtime ?? ctime;

  if (dev === null || ino === null || type === null || stableTime === null) return null;

  return {
    dev,
    ino,
    type,
    birthtime,
    ctime,
  };
};

export const hasFileIdentity = (value) => snapshotFileIdentity(value) !== null;

// This deliberately omits birthtime/ctime and is only valid when another
// operation (for example, an open descriptor held across rename) proves object
// continuity. It is not a replacement for sameFileIdentity in ownership checks.
export const sameFileObjectIdentity = (left, right) => {
  const leftIdentity = snapshotFileIdentity(left);
  const rightIdentity = snapshotFileIdentity(right);
  if (!leftIdentity || !rightIdentity) return false;

  return leftIdentity.dev === rightIdentity.dev
    && leftIdentity.ino === rightIdentity.ino
    && leftIdentity.type === rightIdentity.type;
};

export const sameFileIdentity = (left, right) => {
  const leftIdentity = snapshotFileIdentity(left);
  const rightIdentity = snapshotFileIdentity(right);
  if (!leftIdentity || !rightIdentity) return false;

  // Never compare a birth time from one snapshot with a ctime from the other.
  // If either side exposes birth time, both sides must expose the same stable
  // metadata kind; otherwise the ctime fallback is used only when both sides
  // lack birth time.
  const sameStableTime = leftIdentity.birthtime !== null || rightIdentity.birthtime !== null
    ? leftIdentity.birthtime !== null
      && rightIdentity.birthtime !== null
      && leftIdentity.birthtime === rightIdentity.birthtime
    : leftIdentity.ctime !== null
      && rightIdentity.ctime !== null
      && leftIdentity.ctime === rightIdentity.ctime;

  return leftIdentity.dev === rightIdentity.dev
    && leftIdentity.ino === rightIdentity.ino
    && leftIdentity.type === rightIdentity.type
    && sameStableTime;
};
