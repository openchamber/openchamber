import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  applyDiscoveryFileAcl,
  resolveCurrentUsername,
  validateWindowsAcl,
} from './windows-acl.js';
import {
  hasFileIdentity,
  sameFileObjectIdentity,
  sameFileIdentity,
  snapshotFileIdentity,
} from './file-identity.js';
import { assertSafeWindowsAncestors } from '../opencode/managed-opencode-handoff-v2/filesystem.js';

/**
 * Windows discovery-file helpers (W-B).
 *
 * The Windows standalone-guardian publishes a `127.0.0.1:<port>\n`
 * discovery file via the sequence:
 *
 *   1. mkdirSync(dirname(portPath), { recursive: true })
 *   2. acquire O_EXCL lock at <portPath>.lock
 *   3. open O_EXCL|O_WRONLY|O_CREAT temp file <portPath>.tmp
 *   4. writeFileSync(fd, "127.0.0.1:<port>\n")
 *   5. fsync the fd
 *   6. close the fd
 *   7. icacls the temp file (applyDiscoveryFileAcl)
 *   8. hard-link temp -> portPath (no replacement of a final path)
 *   9. identity-fenced removal of the temp entry
 *  10. identity-fenced release of the lock
 *  11. on any post-link failure, identity-fenced rollback of the final entry
 *
 * The ACL is applied to the **temp** file before publication so a
 * half-published file is never readable by anyone but the owner (closes
 * F-6). The temp filename cannot be a symlink target because O_EXCL
 * rejects pre-existing names.
 *
 * All three helpers throw on non-Windows because the file is part of
 * the Windows trust boundary (loopback + per-user ACL). POSIX
 * consumers should not be tempted to use it.
 */

const WINDOWS_ONLY_ERROR = 'discovery-file is Windows-only';
const LOCK_FILE_SUFFIX = '.lock';
const TEMP_FILE_SUFFIX = '.tmp';
const PUBLICATION_CLEANUP_UNCERTAIN_CODE = 'GUARDIAN_TRANSPORT_CLEANUP_UNCERTAIN';
const PUBLICATION_CLEANUP_UNCERTAIN_MESSAGE = 'Guardian discovery publication cleanup is uncertain';
const IDENTITY_CLEANUP_UNCERTAIN_MESSAGE = 'Guardian transport artifact cleanup is uncertain';
const GUARDIAN_DISCOVERY_INVALID_CODE = 'GUARDIAN_DISCOVERY_INVALID';
const GUARDIAN_DISCOVERY_MAX_BODY_BYTES = 1024;
const LINUX_O_PATH = 0x200000;

const assertWindows = (platform) => {
  if (platform !== 'win32') {
    throw new Error(WINDOWS_ONLY_ERROR);
  }
};

// Path safety: the discovery file path comes from the operator's data
// dir + a fixed `port` filename, so under normal use it cannot contain
// shell metacharacters. Still, we re-validate here as defense in depth
// because the value flows into a child-process argument list.
const UNSAFE_PATH_CHARS = /[\x00-\x1F"&|<>^]/;
const assertSafePath = (value, label) => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`discovery-file: ${label} is required`);
  }
  if (UNSAFE_PATH_CHARS.test(value)) {
    throw new Error(`discovery-file: ${label} contains unsafe characters (control, shell metacharacters, or quotes)`);
  }
};

const defaultIsReparsePoint = (_filePath, stat) => Boolean(stat?.isSymbolicLink?.());

const isExpectedFileType = (stat, expectedType) => expectedType === 'socket'
  ? Boolean(stat?.isSocket?.())
  : Boolean(stat?.isFile?.());

const replacementError = (label, filePath) => Object.assign(
  new Error(`discovery-file: Refusing to remove a replaced ${label}: ${filePath}`),
  { code: 'GUARDIAN_TRANSPORT_ARTIFACT_REPLACED' },
);

const contentMismatchError = (label, filePath) => Object.assign(
  new Error(`discovery-file: Refusing to remove a mutated ${label}: ${filePath}`),
  { code: 'GUARDIAN_TRANSPORT_ARTIFACT_CONTENT_MISMATCH' },
);

const identityUnavailableError = (label, filePath) => Object.assign(
  new Error(`discovery-file: Cannot verify identity for ${label}: ${filePath}`),
  { code: 'GUARDIAN_TRANSPORT_IDENTITY_UNAVAILABLE' },
);

const identityCleanupUncertainError = (label, filePath, cause, quarantinePath) => Object.assign(
  new Error(IDENTITY_CLEANUP_UNCERTAIN_MESSAGE),
  {
    code: PUBLICATION_CLEANUP_UNCERTAIN_CODE,
    artifact: label,
    path: filePath,
    cause,
    quarantinePath,
  },
);

const invalidDiscoveryError = (reason, cause) => Object.assign(
  new Error(`Guardian discovery file is invalid: ${reason}`),
  {
    code: GUARDIAN_DISCOVERY_INVALID_CODE,
    ...(cause ? { cause } : {}),
  },
);

const publicationCleanupUncertainError = (cause, publishedIdentity, cleanupArtifacts) => Object.assign(
  new Error(PUBLICATION_CLEANUP_UNCERTAIN_MESSAGE),
  {
    code: PUBLICATION_CLEANUP_UNCERTAIN_CODE,
    artifact: 'Windows guardian discovery file',
    cause,
    cleanupError: cause,
    publishedIdentity,
    cleanupArtifacts,
  },
);

const openIdentityCheckedFile = (filePath, expected, label) => {
  let descriptor;
  try {
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
    try {
      descriptor = fs.openSync(filePath, flags);
    } catch (error) {
      // O_NOFOLLOW is not implemented by every Windows Node/libuv build. The
      // lstat + fstat identity fence remains the fallback there; a reparse
      // replacement cannot be mistaken for the expected inode.
      if (error?.code !== 'EINVAL' || !(fs.constants.O_NOFOLLOW ?? 0)) throw error;
      descriptor = fs.openSync(filePath, fs.constants.O_RDONLY);
    }
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || !sameFileIdentity(expected, opened)) {
      throw replacementError(label, filePath);
    }
    return descriptor;
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* best effort */ }
    }
    throw error;
  }
};

const openIdentityCheckedArtifact = (
  filePath,
  expected,
  label,
  expectedType,
  platform = process.platform,
) => {
  if (expectedType !== 'socket') return openIdentityCheckedFile(filePath, expected, label);
  if (platform !== 'linux') return null;

  let descriptor;
  try {
    descriptor = fs.openSync(
      filePath,
      LINUX_O_PATH | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const opened = fs.fstatSync(descriptor);
    if (!opened.isSocket?.() || !sameFileIdentity(expected, opened)) {
      throw replacementError(label, filePath);
    }
    return descriptor;
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* preserve the primary error */ }
    }
    throw error;
  }
};

const readIdentityCheckedFile = (
  filePath,
  expected,
  label,
  { validateAncestors, maxBytes } = {},
) => {
  validateAncestors?.();
  const descriptor = openIdentityCheckedFile(filePath, expected, label);
  try {
    const opened = fs.fstatSync(descriptor);
    if (Number.isSafeInteger(maxBytes) && maxBytes >= 0 && opened.size > maxBytes) {
      throw invalidDiscoveryError(`${label} exceeds the ${maxBytes}-byte limit`);
    }

    const readLimit = Number.isSafeInteger(maxBytes) && maxBytes >= 0
      ? maxBytes + 1
      : opened.size;
    const value = Buffer.alloc(Math.max(0, readLimit));
    let offset = 0;
    while (offset < value.length) {
      const read = fs.readSync(descriptor, value, offset, value.length - offset, null);
      if (!Number.isSafeInteger(read) || read <= 0) break;
      offset += read;
    }
    if (Number.isSafeInteger(maxBytes) && maxBytes >= 0 && offset > maxBytes) {
      throw invalidDiscoveryError(`${label} exceeds the ${maxBytes}-byte limit`);
    }
    const body = value.subarray(0, offset).toString('utf8');
    validateAncestors?.();
    const readStat = fs.fstatSync(descriptor);
    let pathStat;
    try {
      pathStat = fs.lstatSync(filePath);
    } catch (error) {
      if (error?.code === 'ENOENT') throw replacementError(label, filePath);
      throw error;
    }
    if (
      !sameFileIdentity(expected, readStat)
      || !readStat.isFile()
      || !sameFileIdentity(expected, pathStat)
      || (Number.isSafeInteger(maxBytes) && maxBytes >= 0 && (
        readStat.size > maxBytes || pathStat.size > maxBytes || readStat.size !== offset
      ))
    ) {
      throw replacementError(label, filePath);
    }
    return body;
  } finally {
    fs.closeSync(descriptor);
  }
};

/**
 * Remove a validated filesystem artifact without unlinking a replacement at
 * the original path. Regular files are identity-checked through a handle and
 * Linux sockets through an O_PATH handle; other sockets use their lstat
 * identity. Both are atomically moved to a private same-directory quarantine
 * name, checked again, and only then unlinked. A ctime-only identity is
 * refreshed after a held descriptor proves the rename preserved the same
 * object; without that proof the quarantine is retained as cleanup-uncertain.
 * If the source changed before the move, the moved replacement is restored
 * with a no-clobber hard link instead of being deleted. The default return
 * value preserves the historical `true` (removed) / `false` (verified absent)
 * contract; `returnResult: true` exposes `removed`, `absent`, `replaced`, and
 * `cleanup-uncertain` outcomes for strict callers.
 */
export const removeFileByIdentity = (
  filePath,
  expected,
  {
    label = 'transport artifact',
    expectedType = 'file',
    validate,
    validateAncestors,
    strict = false,
    returnResult = false,
    quarantinePath: initialQuarantinePath,
    onQuarantinePath,
    onIdentity,
    platform = process.platform,
  } = {},
) => {
  let activeIdentity = snapshotFileIdentity(expected);
  if (!activeIdentity) {
    throw identityUnavailableError(label, filePath);
  }
  if (expectedType === 'socket' && activeIdentity.birthtime === null && platform !== 'linux') {
    throw Object.assign(
      new Error(`discovery-file: ctime-only socket identity requires Linux descriptor fencing: ${filePath}`),
      { code: 'GUARDIAN_TRANSPORT_UNSUPPORTED' },
    );
  }

  let quarantinePath = initialQuarantinePath;
  let moved = false;
  let heldDescriptor = null;
  let retainQuarantine = false;
  let operationError = null;
  let removed = false;

  const publishQuarantinePath = (value) => {
    quarantinePath = value || null;
    if (typeof onQuarantinePath === 'function') onQuarantinePath(quarantinePath);
  };

  const publishIdentity = (value) => {
    activeIdentity = snapshotFileIdentity(value);
    if (!activeIdentity) throw identityUnavailableError(label, filePath);
    if (typeof onIdentity === 'function') onIdentity(activeIdentity);
  };

  const refreshHeldIdentity = () => {
    if (heldDescriptor === null) return;
    const heldStat = fs.fstatSync(heldDescriptor);
    const heldIdentity = snapshotFileIdentity(heldStat);
    if (!heldIdentity || !sameFileObjectIdentity(activeIdentity, heldIdentity)) {
      throw replacementError(`held ${label}`, filePath);
    }
    publishIdentity(heldIdentity);
  };

  const quarantineExists = () => {
    if (!quarantinePath) return false;
    try {
      fs.lstatSync(quarantinePath);
      return true;
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
  };

  const removeExistingQuarantine = () => {
    if (!quarantinePath) return;
    if (!quarantineExists()) return;

    let original;
    try {
      original = fs.lstatSync(filePath);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }

    // If the original path now names another object, the hidden quarantine is
    // deliberately retained. Removing it would be a destructive retry after
    // a replacement race, even though its inode is known.
    if (original && !sameFileIdentity(activeIdentity, original)) {
      throw identityCleanupUncertainError(
        label,
        filePath,
        replacementError(label, filePath),
        quarantinePath,
      );
    }

    const quarantined = fs.lstatSync(quarantinePath);
    if (!isExpectedFileType(quarantined, expectedType)
      || !sameFileIdentity(activeIdentity, quarantined)) {
      throw identityCleanupUncertainError(
        label,
        filePath,
        replacementError(`quarantined ${label}`, quarantinePath),
        quarantinePath,
      );
    }
    let quarantineDescriptor = null;
    try {
      if (activeIdentity.birthtime === null) {
          quarantineDescriptor = openIdentityCheckedArtifact(
            quarantinePath,
            activeIdentity,
            label,
            expectedType,
            platform,
          );
      } else if (expectedType !== 'socket') {
        quarantineDescriptor = openIdentityCheckedFile(quarantinePath, activeIdentity, label);
      }
      validateAncestors?.();
      fs.unlinkSync(quarantinePath);
      if (quarantineDescriptor !== null) {
        const afterUnlink = snapshotFileIdentity(fs.fstatSync(quarantineDescriptor));
        if (!afterUnlink || !sameFileObjectIdentity(activeIdentity, afterUnlink)) {
          throw replacementError(`unlinked ${label}`, filePath);
        }
        publishIdentity(afterUnlink);
      }
      publishQuarantinePath(null);
    } finally {
      if (quarantineDescriptor !== null) {
        try { fs.closeSync(quarantineDescriptor); } catch { /* preserve the primary error */ }
      }
    }
  };

  const restore = () => {
    if (!moved || !quarantinePath || retainQuarantine) return null;
    let originalExists = false;
    try {
      fs.lstatSync(filePath);
      originalExists = true;
    } catch (error) {
      if (error?.code !== 'ENOENT') return error;
    }
    if (originalExists) return null;
    try {
      // A hard link is the no-clobber restore primitive. `renameSync` would
      // replace a new artifact that appeared after the quarantine move.
      fs.linkSync(quarantinePath, filePath);
      try {
        // Both hard-link creation and removal of the quarantine name mutate
        // ctime on ctime-only filesystems. Refresh the descriptor-backed
        // identity after each mutation so a pair-level retry keeps the
        // sibling's expected identity current.
        refreshHeldIdentity();
        fs.unlinkSync(quarantinePath);
        refreshHeldIdentity();
        moved = false;
        publishQuarantinePath(null);
      } catch (error) {
        // The expected object is now also reachable at the original path;
        // retain the quarantine entry when its final cleanup is uncertain.
        return Object.assign(
          new Error(`discovery-file: quarantine cleanup remains uncertain: ${quarantinePath}`),
          { cause: error },
        );
      }
    } catch (error) {
      // Leave the quarantined artifact in place rather than replacing an
      // object whose identity could not be restored safely.
      return Object.assign(
        new Error(`discovery-file: quarantine restoration remains uncertain: ${quarantinePath}`),
        { cause: error },
      );
    }
    return null;
  };

  try {
    // A previous attempt may have restored the expected object at the
    // original path while leaving its private quarantine entry behind. It is
    // safe to retry only while the original identity is still present (or
    // absent); a replacement blocks this path without deleting anything.
    removeExistingQuarantine();

    let current;
    try {
      current = typeof validate === 'function' ? validate() : fs.lstatSync(filePath);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        removed = false;
        current = null;
      } else {
        throw error;
      }
    }
    if (!current) {
      removed = false;
    } else {
      if (!hasFileIdentity(current)) {
        throw identityUnavailableError(label, filePath);
      }
      if (!sameFileIdentity(activeIdentity, current)) {
        throw replacementError(label, filePath);
      }
      if (!isExpectedFileType(current, expectedType)) {
        throw replacementError(label, filePath);
      }
      validateAncestors?.();

      if (activeIdentity.birthtime === null) {
        // Only ctime-only identities need the descriptor across rename. Keep
        // the historical close-before-rename path for birthtime-backed files,
        // including Windows filesystems whose sharing rules may reject an
        // open handle during quarantine.
        heldDescriptor = openIdentityCheckedArtifact(
          filePath,
          activeIdentity,
          label,
          expectedType,
          platform,
        );
      } else {
        const descriptor = openIdentityCheckedArtifact(
          filePath,
          activeIdentity,
          label,
          expectedType,
          platform,
        );
        if (descriptor !== null) fs.closeSync(descriptor);
      }
      validateAncestors?.();

      quarantinePath ||= initialQuarantinePath || path.join(
        path.dirname(filePath),
        `.${path.basename(filePath)}.${process.pid}.${randomBytes(16).toString('hex')}.remove`,
      );
      try {
        fs.lstatSync(quarantinePath);
        throw new Error(`discovery-file: quarantine path already exists: ${quarantinePath}`);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }

      try {
        fs.renameSync(filePath, quarantinePath);
        moved = true;
        publishQuarantinePath(quarantinePath);
      } catch (error) {
        if (error?.code === 'ENOENT') {
          publishQuarantinePath(null);
          removed = false;
        } else {
          throw error;
        }
      }

      if (moved) {
        // A replacement can be created at the original path immediately after
        // the rename. Never delete the quarantined expected object while that
        // replacement is present; restore() below leaves it untouched and the
        // caller receives an explicit cleanup-uncertain result.
        try {
          fs.lstatSync(filePath);
          throw replacementError(label, filePath);
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }

        const movedStat = fs.lstatSync(quarantinePath);
        if (!isExpectedFileType(movedStat, expectedType)) {
          throw replacementError(label, filePath);
        }
        if (!hasFileIdentity(movedStat)) throw identityUnavailableError(label, filePath);
        const movedIdentity = snapshotFileIdentity(movedStat);
        if (!movedIdentity) throw identityUnavailableError(label, quarantinePath);
        if (activeIdentity.birthtime === null) {
          // ctime is mutable metadata: rename quarantine can legitimately
          // advance it. Only a descriptor held from the pre-rename identity
          // can prove that the moved object is still the owned object. A
          // ctime-only socket on platforms without such a descriptor remains
          // quarantined and retryable rather than being deleted by name.
          if (heldDescriptor === null) {
            retainQuarantine = true;
            throw identityCleanupUncertainError(
              label,
              filePath,
              new Error('ctime-only identity cannot be verified across quarantine rename'),
              quarantinePath,
            );
          }
          const heldStat = fs.fstatSync(heldDescriptor);
          const heldIdentity = snapshotFileIdentity(heldStat);
          if (
            !heldIdentity
            || !sameFileObjectIdentity(activeIdentity, heldIdentity)
            || !sameFileIdentity(heldIdentity, movedIdentity)
          ) {
            throw replacementError(`quarantined ${label}`, quarantinePath);
          }
          publishIdentity(heldIdentity);
        } else if (!sameFileIdentity(activeIdentity, movedIdentity)) {
          throw replacementError(label, filePath);
        }
        validateAncestors?.();
        try {
          fs.lstatSync(filePath);
          throw replacementError(label, filePath);
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
        fs.unlinkSync(quarantinePath);
        // Removing the quarantine name is another inode metadata mutation.
        // Refresh through the held descriptor before propagating success to a
        // sibling hard link in a POSIX transport pair.
        refreshHeldIdentity();
        moved = false;
        publishQuarantinePath(null);
        removed = true;
      }
    }
  } catch (error) {
    operationError = error;
  }

  const restorationError = restore();
  if (heldDescriptor !== null) {
    try { fs.closeSync(heldDescriptor); } catch (error) { operationError ||= error; }
    heldDescriptor = null;
  }
  let leftoverQuarantine = false;
  try {
    leftoverQuarantine = quarantineExists();
  } catch (error) {
    operationError ||= error;
    leftoverQuarantine = true;
  }

  if (restorationError || leftoverQuarantine) {
    const uncertain = identityCleanupUncertainError(
      label,
      filePath,
      restorationError || operationError || new Error('quarantine artifact remains'),
      quarantinePath,
    );
    if (returnResult && !strict) return { status: 'cleanup-uncertain', error: uncertain };
    throw uncertain;
  }
  if (operationError) {
    if (returnResult && !strict) {
      if (
        operationError?.code === 'GUARDIAN_TRANSPORT_ARTIFACT_REPLACED'
        || operationError?.code === 'GUARDIAN_TRANSPORT_ARTIFACT_CONTENT_MISMATCH'
      ) {
        return { status: 'replaced', error: operationError };
      }
    }
    throw operationError;
  }

  if (returnResult) return { status: removed ? 'removed' : 'absent' };
  return removed;
};

const assertRegularDiscoveryFile = (
  portPath,
  {
    username,
    aclInspector,
    reparseChecker = defaultIsReparsePoint,
  } = {},
) => {
  assertSafeWindowsAncestors(portPath, {
    username,
    aclInspector,
    reparseChecker,
  });
  const stat = fs.lstatSync(portPath);
  if (reparseChecker(portPath, stat) === true) {
    throw Object.assign(
      new Error('discovery-file: path must not be a reparse point'),
      { code: 'WINDOWS_ACL_UNSAFE' },
    );
  }
  if (!stat.isFile()) {
    throw new Error('discovery-file: path must be a regular file');
  }
  return stat;
};

/**
 * Parse a discovery file body. Exported for unit tests; the W-B
 * write side produces strings exactly in this shape.
 *
 * Accepts `127.0.0.1:4096\n`, `localhost:4096\n`, or any other
 * `<host>:<port>\n` line. The plan hard-binds clients to `127.0.0.1`,
 * so the host component is parsed but not trusted.
 */
const parseDiscoveryBody = (body) => {
  if (typeof body !== 'string') return null;
  if (Buffer.byteLength(body, 'utf8') > GUARDIAN_DISCOVERY_MAX_BODY_BYTES) return null;

  let line = body;
  if (line.endsWith('\n')) line = line.slice(0, -1);
  if (line.endsWith('\r')) line = line.slice(0, -1);
  if (
    line.length === 0
    || line.trim() !== line
    || /[\x00-\x1F\x7F]/.test(line)
  ) return null;

  const colonAt = line.lastIndexOf(':');
  if (colonAt <= 0 || colonAt === line.length - 1) return null;
  const host = line.slice(0, colonAt);
  const portStr = line.slice(colonAt + 1);
  if (!/^[A-Za-z0-9_.:[\]-]+$/.test(host)) return null;
  if (!/^\d+$/.test(portStr)) return null;
  const port = Number.parseInt(portStr, 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return null;
  return { host, port };
};

/**
 * Atomically publish a discovery file containing `127.0.0.1:<port>\n`
 * with a per-user ACL. Used by the Windows backend of `createIpcServer`
 * BEFORE `listen()` resolves, so no client can dial a port that has no
 * published file.
 *
 * The sequence is: lock → O_EXCL temp → write → fsync → close → icacls
 * → identity-fenced hard-link publish → identity-fenced temp removal → unlock.
 * On any failure, the temp file and lock are cleaned before the error is
 * propagated. Once the final link exists, rollback is attempted by its
 * recorded identity; failure to prove that rollback returns a stable
 * cleanup-uncertain error for the guardian retry path.
 *
 * The lock file uses `O_EXCL` too; a held lock refuses to start. Stale lock,
 * temp, and final discovery artifacts are removed only by the transport
 * recovery path after the prior guardian's validated PID marker proves death.
 *
 * @param {string} portPath - Destination file path.
 * @param {number} port - TCP port the guardian bound to.
 * @param {object} [options]
 * @param {NodeJS.Platform} [options.platform] - Override for tests.
 * @param {string} [options.username] - Override for tests. Defaults
 *   to the output of `resolveCurrentUsername()` on Windows.
 * @param {(message: string) => void} [options.log]
 * @returns {{dev: string, ino: string, type: string, birthtime: string|null, ctime: string|null}}
 */
export function writeDiscoveryFileAtomic(
  portPath,
  port,
  {
    platform = process.platform,
    username,
    log = () => {},
    aclInspector,
    reparseChecker = defaultIsReparsePoint,
  } = {},
) {
  assertWindows(platform);
  assertSafePath(portPath, 'portPath');
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new TypeError(`discovery-file: port must be an integer in 1..65535 (got ${port})`);
  }

  const resolvedUsername = typeof username === 'string' && username.length > 0
    ? username
    : resolveCurrentUsername({ log });

  const dirPath = path.dirname(portPath);
  assertSafeWindowsAncestors(portPath, {
    username: resolvedUsername,
    aclInspector,
    reparseChecker,
  });
  fs.mkdirSync(dirPath, { recursive: true });
  // Missing components were not inspectable before recursive creation. Walk
  // the now-existing path again before creating lock/temp artifacts.
  assertSafeWindowsAncestors(portPath, {
    username: resolvedUsername,
    aclInspector,
    reparseChecker,
  });
  try {
    assertRegularDiscoveryFile(portPath, {
      username: resolvedUsername,
      aclInspector,
      reparseChecker,
    });
    validateWindowsAcl({
      targetPath: portPath,
      username: resolvedUsername,
      kind: 'discovery file',
      ...(aclInspector ? { inspectAcl: aclInspector } : {}),
    });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const lockPath = `${portPath}${LOCK_FILE_SUFFIX}`;
  const tempPath = `${portPath}${TEMP_FILE_SUFFIX}`;
  const body = `127.0.0.1:${port}\n`;

  let lockFd = null;
  let lockIdentity = null;
  let tempFd = null;
  let tempIdentity = null;
  let publishedIdentity = null;
  let tempCreated = false;
  let lockAcquired = false;
  let operationError = null;
  let cleanupError = null;
  let tempQuarantinePath = null;
  let lockQuarantinePath = null;
  let finalQuarantinePath = null;
  let finalCleanupComplete = false;
  let finalRollbackRequired = false;

  const pendingCleanupArtifacts = () => ({
    ...(tempCreated || tempQuarantinePath ? {
      temp: {
        path: tempPath,
        identity: tempIdentity,
        quarantinePath: tempQuarantinePath,
      },
    } : {}),
    ...(lockAcquired || lockQuarantinePath ? {
      lock: {
        path: lockPath,
        identity: lockIdentity,
        quarantinePath: lockQuarantinePath,
      },
    } : {}),
    ...(finalRollbackRequired && publishedIdentity && !finalCleanupComplete ? {
      final: {
        path: portPath,
        identity: publishedIdentity,
        quarantinePath: finalQuarantinePath,
      },
    } : {}),
  });


  try {
    // 2. acquire the lock.
    assertSafeWindowsAncestors(portPath, {
      username: resolvedUsername,
      aclInspector,
      reparseChecker,
    });
    try {
      lockFd = fs.openSync(lockPath, 'wx', 0o600);
      // O_EXCL succeeded: retain ownership even if the first identity probe
      // fails. Releasing this state would let the caller drop its transport
      // marker while the lock remains on disk and can block or confuse the
      // next guardian.
      lockAcquired = true;
      lockIdentity = snapshotFileIdentity(fs.fstatSync(lockFd));
      if (!lockIdentity) throw new Error(`discovery-file: lock has no usable identity: ${lockPath}`);
      fs.closeSync(lockFd);
      lockFd = null;
    } catch (error) {
      if (error?.code === 'EEXIST') {
        throw new Error(`discovery-file: lock held at ${lockPath}; refusing to start guardian`);
      }
      throw error;
    }

    // 3. open the O_EXCL temp.
    assertSafeWindowsAncestors(tempPath, {
      username: resolvedUsername,
      aclInspector,
      reparseChecker,
    });
    try {
      tempFd = fs.openSync(tempPath, 'wx', 0o600);
      // As with the lock, an O_EXCL-opened temp is owned before its identity
      // can be observed. Keep it in the pending cleanup report on any
      // post-open metadata failure.
      tempCreated = true;
      tempIdentity = snapshotFileIdentity(fs.fstatSync(tempFd));
      if (!tempIdentity) throw new Error(`discovery-file: temp file has no usable identity: ${tempPath}`);
    } catch (error) {
      if (error?.code === 'EEXIST') {
        throw new Error(`discovery-file: temp file ${tempPath} already exists; refusing to start guardian`);
      }
      throw error;
    }

    // 4. write.
    fs.writeFileSync(tempFd, body, 'utf8');
    // 5. fsync.
    fs.fsyncSync(tempFd);
    // 6. close the temp fd before ACL.
    fs.closeSync(tempFd);
    tempFd = null;

    // 7. ACL on the temp file. Throws on failure; the catch below
    //    cleans up the temp and lock and re-throws.
    applyDiscoveryFileAcl({
      portPath: tempPath,
      username: resolvedUsername,
      log,
      ...(aclInspector ? { inspectAcl: aclInspector } : {}),
    });

    const currentTemp = fs.lstatSync(tempPath);
    if (!currentTemp.isFile() || !sameFileIdentity(tempIdentity, currentTemp)) {
      throw replacementError('temporary discovery file', tempPath);
    }

    // 8. Refuse to replace an existing final path. A stale final file must be
    // removed by the identity-validated transport recovery path before this
    // publisher runs; never let a second publisher clobber a live guardian's
    // discovery artifact.
    try {
      assertRegularDiscoveryFile(portPath, {
        username: resolvedUsername,
        aclInspector,
        reparseChecker,
      });
      throw new Error(
        `discovery-file: destination ${portPath} already exists; refusing to replace it without stale-guardian recovery`,
      );
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    // 9. Publish with a hard link. Unlike rename/MoveFileEx, this cannot
    // replace a final path that appears after the existence check. The temp
    // and final entries are the same file identity until the temp entry is
    // removed below. Hard-link creation can update ctime, so refresh the
    // identity after publication before using it for either cleanup path.
    assertSafeWindowsAncestors(portPath, {
      username: resolvedUsername,
      aclInspector,
      reparseChecker,
    });
    try {
      fs.linkSync(tempPath, portPath);
    } catch (error) {
      if (error?.code === 'EEXIST') {
        throw new Error(
          `discovery-file: destination ${portPath} appeared during publication; refusing to replace it`,
        );
      }
      throw error;
    }
    // Keep the pre-link identity as a conservative rollback fallback until
    // both links have been observed with the post-link metadata. If a later
    // step fails, only the refreshed published identity may authorize final
    // rollback.
    publishedIdentity = { ...tempIdentity };
    const published = assertRegularDiscoveryFile(portPath, {
      username: resolvedUsername,
      aclInspector,
      reparseChecker,
    });
    const linkedTempIdentity = snapshotFileIdentity(fs.lstatSync(tempPath));
    const linkedPublishedIdentity = snapshotFileIdentity(published);
    if (
      !linkedTempIdentity
      || !linkedPublishedIdentity
      || !sameFileIdentity(tempIdentity, linkedTempIdentity)
      || !sameFileIdentity(linkedTempIdentity, linkedPublishedIdentity)
    ) {
      throw replacementError('published discovery file', portPath);
    }
    tempIdentity = linkedTempIdentity;
    publishedIdentity = linkedPublishedIdentity;
    validateWindowsAcl({
      targetPath: portPath,
      username: resolvedUsername,
      kind: 'discovery file',
      ...(aclInspector ? { inspectAcl: aclInspector } : {}),
    });
  } catch (error) {
    operationError = error;
  } finally {
    if (lockFd !== null) {
      try { fs.closeSync(lockFd); } catch (error) { cleanupError ||= error; }
      lockFd = null;
    }
    if (tempFd !== null) {
      try { fs.closeSync(tempFd); } catch (error) { cleanupError ||= error; }
      tempFd = null;
    }
  }

  // Cleanup is deliberately outside the publication try/catch so every
  // post-link failure can trigger an identity-fenced rollback of the final
  // artifact before the original publication error is returned.
  if (tempCreated) {
    try {
      const removed = removeFileByIdentity(tempPath, tempIdentity, {
        label: 'temporary discovery file',
        quarantinePath: tempQuarantinePath,
        onQuarantinePath: (value) => { tempQuarantinePath = value; },
        onIdentity: (value) => { tempIdentity = value; },
        validateAncestors: () => assertSafeWindowsAncestors(tempPath, {
          username: resolvedUsername,
          aclInspector,
          reparseChecker,
        }),
      });
      // A verified absence is an idempotent cleanup success. It is not an
      // unresolved ownership state and must not be retried destructively.
      void removed;
      tempCreated = false;
    } catch (error) {
      cleanupError ||= error;
      // The identity-safe helper restores an artifact when its quarantine
      // unlink fails. A bounded retry removes that restored entry when the
      // failure was transient, without turning an identity mismatch into a
      // successful cleanup.
      try {
        const removed = removeFileByIdentity(tempPath, tempIdentity, {
          label: 'temporary discovery file',
          quarantinePath: tempQuarantinePath,
          onQuarantinePath: (value) => { tempQuarantinePath = value; },
          onIdentity: (value) => { tempIdentity = value; },
          validateAncestors: () => assertSafeWindowsAncestors(tempPath, {
            username: resolvedUsername,
            aclInspector,
            reparseChecker,
          }),
        });
        void removed;
        tempCreated = false;
      } catch (retryError) {
        cleanupError ||= retryError;
      }
    }
  }

  if (lockAcquired) {
    try {
      const removed = removeFileByIdentity(lockPath, lockIdentity, {
        label: 'discovery lock',
        quarantinePath: lockQuarantinePath,
        onQuarantinePath: (value) => { lockQuarantinePath = value; },
        onIdentity: (value) => { lockIdentity = value; },
        validateAncestors: () => assertSafeWindowsAncestors(lockPath, {
          username: resolvedUsername,
          aclInspector,
          reparseChecker,
        }),
      });
      void removed;
      lockAcquired = false;
    } catch (error) {
      cleanupError ||= error;
      try {
        const removed = removeFileByIdentity(lockPath, lockIdentity, {
          label: 'discovery lock',
          quarantinePath: lockQuarantinePath,
          onQuarantinePath: (value) => { lockQuarantinePath = value; },
          onIdentity: (value) => { lockIdentity = value; },
          validateAncestors: () => assertSafeWindowsAncestors(lockPath, {
            username: resolvedUsername,
            aclInspector,
            reparseChecker,
          }),
        });
        void removed;
        lockAcquired = false;
      } catch (retryError) {
        cleanupError ||= retryError;
      }
    }
  }

  const publishError = operationError || cleanupError;
  if (publishError && publishedIdentity) {
    finalRollbackRequired = true;
    let finalCleanupError = null;
    try {
      const removed = removeFileByIdentity(portPath, publishedIdentity, {
        label: 'published discovery file',
        quarantinePath: finalQuarantinePath,
        onQuarantinePath: (value) => { finalQuarantinePath = value; },
        onIdentity: (value) => { publishedIdentity = value; },
        validateAncestors: () => assertSafeWindowsAncestors(portPath, {
          username: resolvedUsername,
          aclInspector,
          reparseChecker,
        }),
        validate: () => assertRegularDiscoveryFile(portPath, {
          username: resolvedUsername,
          aclInspector,
          reparseChecker,
        }),
      });
      void removed;
      finalCleanupComplete = true;
    } catch (error) {
      finalCleanupError = error;
    }

    if (finalCleanupError) cleanupError ||= finalCleanupError;
  }

  const persistentCleanup = Object.keys(pendingCleanupArtifacts()).length > 0;
  if (persistentCleanup) {
    throw publicationCleanupUncertainError(
      cleanupError || publishError || new Error('discovery publication cleanup remains uncertain'),
      publishedIdentity,
      pendingCleanupArtifacts(),
    );
  }

  if (publishError) {
    throw publishError;
  }

  return publishedIdentity;
}

/**
 * Read and parse a discovery file.
 *
 * On Windows: synchronously reads the bounded file and parses the
 * `127.0.0.1:<port>` body. ENOENT is preserved as the sole absence signal.
 * Malformed, oversized, unsafe, permission-denied, and identity-uncertain
 * discovery state throws `GUARDIAN_DISCOVERY_INVALID` so lifecycle callers
 * cannot interpret an untrusted endpoint as a stopped guardian.
 *
 * On any other platform: throws `WINDOWS_ONLY_ERROR` because the
 * discovery file is a Windows trust boundary.
 *
 * @param {string} portPath - File to read.
 * @param {object} [options]
 * @param {NodeJS.Platform} [options.platform] - Override for tests.
 * @returns {{ host: string, port: number }}
 */
export function readDiscoveryFile(
  portPath,
  {
    platform = process.platform,
    username,
    aclInspector,
    reparseChecker = defaultIsReparsePoint,
  } = {},
) {
  assertWindows(platform);
  assertSafePath(portPath, 'portPath');
  try {
    const observed = assertRegularDiscoveryFile(portPath, {
      username,
      aclInspector,
      reparseChecker,
    });
    if (observed.size > GUARDIAN_DISCOVERY_MAX_BODY_BYTES) {
      throw invalidDiscoveryError(
        `discovery file exceeds the ${GUARDIAN_DISCOVERY_MAX_BODY_BYTES}-byte limit`,
      );
    }
    validateWindowsAcl({
      targetPath: portPath,
      username,
      kind: 'discovery file',
      ...(aclInspector ? { inspectAcl: aclInspector } : {}),
    });
    const body = readIdentityCheckedFile(portPath, observed, 'discovery file', {
      maxBytes: GUARDIAN_DISCOVERY_MAX_BODY_BYTES,
      validateAncestors: () => assertSafeWindowsAncestors(portPath, {
        username,
        aclInspector,
        reparseChecker,
      }),
    });
    const parsed = parseDiscoveryBody(body);
    if (!parsed) {
      throw invalidDiscoveryError('body is malformed or contains an unsafe host/port');
    }
    return parsed;
  } catch (error) {
    // ENOENT is the only absence signal. Permission, ACL, reparse-point,
    // identity, size, and parse failures describe an existing-but-untrusted
    // discovery boundary and must never be translated to "not running".
    if (error?.code === 'ENOENT') throw error;
    if (error?.code === GUARDIAN_DISCOVERY_INVALID_CODE) throw error;
    throw invalidDiscoveryError(error?.message || 'discovery read failed', error);
  }
}

/**
 * Remove a discovery file. Idempotent: a missing file is not an
 * error. Used by the Windows backend on `GuardianIpcServer.stop()`.
 *
 * @param {string} portPath
 * @param {object} [options]
 * @param {NodeJS.Platform} [options.platform] - Override for tests.
 * @param {string} [options.expectedContent] - Exact published body expected
 *   during strict identity-fenced removal.
 * @param {{dev: string, ino: string, type: string, birthtime: string|null, ctime: string|null}} [options.expectedIdentity]
 *   published by the current transport; a mismatch is a safe replacement.
 * @param {boolean} [options.strict] - Preserve replacement/identity errors for
 *   stale-transport recovery; normal close remains idempotent.
 * @param {string} [options.quarantinePath] - A private quarantine left by a
 *   previous removal attempt.
 * @param {(path: string|null) => void} [options.onQuarantinePath]
 * @param {(identity: object) => void} [options.onIdentity] - Receives a
 *   refreshed ctime-only identity after a descriptor-proven quarantine move.
 * @param {boolean} [options.returnResult] - Return an explicit outcome object
 *   instead of the historical boolean contract.
 * @returns {boolean|{status: string}} `true` when removed, `false` only when
 *   absence was verified, or an explicit status object when requested. Strict
 *   mode throws on replacement, content mismatch, or uncertain cleanup.
 */
export function removeDiscoveryFile(
  portPath,
  {
    platform = process.platform,
    username,
    expectedPort,
    expectedContent,
    expectedIdentity,
    strict = false,
    quarantinePath,
    onQuarantinePath,
    onIdentity,
    returnResult = false,
    aclInspector,
    reparseChecker = defaultIsReparsePoint,
  } = {},
) {
  assertWindows(platform);
  assertSafePath(portPath, 'portPath');
  try {
    let observed;
    try {
      observed = assertRegularDiscoveryFile(portPath, {
        username,
        aclInspector,
        reparseChecker,
      });
    } catch (error) {
      // A failed identity-fenced removal may have restored the expected
      // object under a private quarantine link. Let the shared helper retry
      // that exact identity even when the original path is currently absent.
      if (error?.code === 'ENOENT' && expectedIdentity !== undefined && quarantinePath) {
        return removeFileByIdentity(portPath, expectedIdentity, {
          label: 'discovery file',
          strict,
          returnResult,
          platform,
          quarantinePath,
          onQuarantinePath,
          onIdentity,
          validateAncestors: () => assertSafeWindowsAncestors(portPath, {
            username,
            aclInspector,
            reparseChecker,
          }),
          validate: () => {
            const current = assertRegularDiscoveryFile(portPath, {
              username,
              aclInspector,
              reparseChecker,
            });
            if (expectedContent !== undefined) {
              const currentBody = readIdentityCheckedFile(portPath, current, 'discovery file', {
                maxBytes: GUARDIAN_DISCOVERY_MAX_BODY_BYTES,
                validateAncestors: () => assertSafeWindowsAncestors(portPath, {
                  username,
                  aclInspector,
                  reparseChecker,
                }),
              });
              if (currentBody !== expectedContent) {
                throw contentMismatchError('discovery file', portPath);
              }
            }
            return current;
          },
        });
      }
      throw error;
    }
    if (expectedIdentity !== undefined) {
      if (!hasFileIdentity(observed)) throw identityUnavailableError('discovery file', portPath);
      if (!sameFileIdentity(expectedIdentity, observed)) {
        const error = replacementError('discovery file', portPath);
        if (strict) throw error;
        if (returnResult) return { status: 'replaced', error };
        return false;
      }
    }
    if (expectedPort !== undefined || expectedContent !== undefined) {
      const body = readIdentityCheckedFile(portPath, observed, 'discovery file', {
        maxBytes: GUARDIAN_DISCOVERY_MAX_BODY_BYTES,
        validateAncestors: () => assertSafeWindowsAncestors(portPath, {
          username,
          aclInspector,
          reparseChecker,
        }),
      });
      const parsed = expectedPort !== undefined ? parseDiscoveryBody(body) : null;
      if (expectedPort !== undefined && parsed?.port !== expectedPort) {
        const error = replacementError('discovery file', portPath);
        if (strict) throw error;
        if (returnResult) return { status: 'replaced', error };
        return false;
      }
      if (expectedContent !== undefined && body !== expectedContent) {
        const error = contentMismatchError('discovery file', portPath);
        if (strict) throw error;
        if (returnResult) return { status: 'replaced', error };
        return false;
      }
    }
    return removeFileByIdentity(portPath, observed, {
      label: 'discovery file',
      strict,
      returnResult,
      platform,
      quarantinePath,
      onQuarantinePath,
      onIdentity,
      validateAncestors: () => assertSafeWindowsAncestors(portPath, {
        username,
        aclInspector,
        reparseChecker,
      }),
      validate: () => {
        const current = assertRegularDiscoveryFile(portPath, {
          username,
          aclInspector,
          reparseChecker,
        });
        if (expectedContent !== undefined) {
          const currentBody = readIdentityCheckedFile(portPath, current, 'discovery file', {
            maxBytes: GUARDIAN_DISCOVERY_MAX_BODY_BYTES,
            validateAncestors: () => assertSafeWindowsAncestors(portPath, {
              username,
              aclInspector,
              reparseChecker,
            }),
          });
          if (currentBody !== expectedContent) {
            throw contentMismatchError('discovery file', portPath);
          }
        }
        return current;
      },
    });
  } catch (error) {
    if (error?.code === 'ENOENT') return returnResult ? { status: 'absent' } : false;
    if (
      !strict
      && (
        error?.code === 'GUARDIAN_TRANSPORT_ARTIFACT_REPLACED'
        || error?.code === 'GUARDIAN_TRANSPORT_ARTIFACT_CONTENT_MISMATCH'
      )
    ) return returnResult ? { status: 'replaced', error } : false;
    throw error;
  }
}

// Exported for unit tests; not part of the public surface.
export const __test__ = {
  parseDiscoveryBody,
  WINDOWS_ONLY_ERROR,
  assertSafePath,
  UNSAFE_PATH_CHARS,
  defaultIsReparsePoint,
  hasFileIdentity,
  sameFileObjectIdentity,
  sameFileIdentity,
  snapshotFileIdentity,
  assertRegularDiscoveryFile,
  GUARDIAN_DISCOVERY_INVALID_CODE,
  GUARDIAN_DISCOVERY_MAX_BODY_BYTES,
};
