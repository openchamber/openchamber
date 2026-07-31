import fs from 'node:fs';
import path from 'node:path';

import {
  applyDiscoveryFileAcl,
  resolveCurrentUsername,
  validateWindowsAcl,
} from './windows-acl.js';
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
 *   8. renameSync(temp -> portPath)  (atomic on Win32)
 *   9. release the lock (unlinkSync <portPath>.lock)
 *
 * The ACL is applied to the **temp** file before the rename so a
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
  const trimmed = body.trim();
  if (trimmed.length === 0) return null;
  const colonAt = trimmed.lastIndexOf(':');
  if (colonAt <= 0 || colonAt === trimmed.length - 1) return null;
  const host = trimmed.slice(0, colonAt);
  const portStr = trimmed.slice(colonAt + 1);
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
 * → rename → unlock. On any failure, the temp file is removed and the
 * lock is released before the error is propagated.
 *
 * The lock file uses `O_EXCL` too; a held lock refuses to start (no
 * stale-lock recovery in W-B; the entrypoint is the only publisher in
 * a normal installation, and crash recovery is a W-F concern).
 *
 * @param {string} portPath - Destination file path.
 * @param {number} port - TCP port the guardian bound to.
 * @param {object} [options]
 * @param {NodeJS.Platform} [options.platform] - Override for tests.
 * @param {string} [options.username] - Override for tests. Defaults
 *   to the output of `resolveCurrentUsername()` on Windows.
 * @param {(message: string) => void} [options.log]
 * @returns {void}
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

  let tempFd = null;
  let lockAcquired = false;

  try {
    // 2. acquire the lock.
    try {
      fs.openSync(lockPath, 'wx');
    } catch (error) {
      if (error?.code === 'EEXIST') {
        throw new Error(`discovery-file: lock held at ${lockPath}; refusing to start guardian`);
      }
      throw error;
    }
    lockAcquired = true;

    // 3. open the O_EXCL temp.
    try {
      tempFd = fs.openSync(tempPath, 'wx');
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

    // 8. atomic rename. On Windows, fs.renameSync is MoveFileEx
    //    which is atomic on the same volume. A prior guardian crash can leave
    //    a stale final file behind; unlinking that regular path does not
    //    follow a symlink and lets the fresh ACL-protected temp file publish.
    try {
      fs.unlinkSync(portPath);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    fs.renameSync(tempPath, portPath);

    // 9. release the lock.
  } catch (error) {
    if (tempFd !== null) {
      try { fs.closeSync(tempFd); } catch { /* ignore */ }
    }
    try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
    throw error;
  } finally {
    if (lockAcquired) {
      try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
    }
  }
}

/**
 * Read and parse a discovery file.
 *
 * On Windows: synchronously reads the file and parses the
 * `127.0.0.1:<port>` body. Throws if the file is missing or unreadable
 * (caller — typically `GuardianClient.connect` — translates the
 * underlying ENOENT/EACCES into a "guardian not running" / "permission
 * denied" signal).
 *
 * On any other platform: throws `WINDOWS_ONLY_ERROR` because the
 * discovery file is a Windows trust boundary.
 *
 * @param {string} portPath - File to read.
 * @param {object} [options]
 * @param {NodeJS.Platform} [options.platform] - Override for tests.
 * @returns {{ host: string, port: number } | null}
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
  assertRegularDiscoveryFile(portPath, {
    username,
    aclInspector,
    reparseChecker,
  });
  validateWindowsAcl({
    targetPath: portPath,
    username,
    kind: 'discovery file',
    ...(aclInspector ? { inspectAcl: aclInspector } : {}),
  });
  // Re-throw the underlying error so callers can distinguish missing
  // file (ENOENT), permission denied (EACCES), etc.
  const body = fs.readFileSync(portPath, 'utf8');
  return parseDiscoveryBody(body);
}

/**
 * Remove a discovery file. Idempotent: a missing file is not an
 * error. Used by the Windows backend on `GuardianIpcServer.stop()`.
 *
 * @param {string} portPath
 * @param {object} [options]
 * @param {NodeJS.Platform} [options.platform] - Override for tests.
 */
export function removeDiscoveryFile(
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
    assertRegularDiscoveryFile(portPath, {
      username,
      aclInspector,
      reparseChecker,
    });
    fs.unlinkSync(portPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
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
  assertRegularDiscoveryFile,
};
