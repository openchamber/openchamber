import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { applyDirectoryAcl, resolveCurrentUsername } from '../../guardian/windows-acl.js';

const MANAGED_OPENCODE_HANDOFF_V2_DEFAULT_ROOT = path.join(
  os.homedir(),
  '.local',
  'state',
  'openchamber',
  'managed-opencode-handoff-v2',
);

const currentUid = () => (typeof process.getuid === 'function' ? process.getuid() : null);

const assertOwner = (stat, label) => {
  const uid = currentUid();
  if (uid !== null && stat.uid !== uid) {
    throw new Error(`Managed OpenCode handoff v2 ${label} is not owned by this user`);
  }
};

const assertMode = (stat, expectedMode, label) => {
  if ((stat.mode & 0o777) !== expectedMode) {
    throw new Error(`Managed OpenCode handoff v2 ${label} has unsafe permissions`);
  }
};

export const resolveManagedOpenCodeHandoffV2Root = (rootDir) => {
  const candidate = rootDir === undefined ? MANAGED_OPENCODE_HANDOFF_V2_DEFAULT_ROOT : rootDir;
  if (typeof candidate !== 'string' || candidate.trim().length === 0 || !path.isAbsolute(candidate)) {
    throw new TypeError('Managed OpenCode handoff v2 root must be an absolute path');
  }

  const resolved = path.resolve(candidate);
  if (resolved === path.parse(resolved).root) {
    throw new TypeError('Managed OpenCode handoff v2 root must not be a filesystem root');
  }
  return resolved;
};

const assertPrivateDirectory = (directoryPath) => {
  const stat = fs.lstatSync(directoryPath);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('Managed OpenCode handoff v2 root must be a regular directory');
  }
  assertOwner(stat, 'root');
  assertMode(stat, 0o700, 'root');
  return stat;
};

/**
 * Windows variant of `ensurePrivateDirectory` (closes F-3).
 *
 * POSIX file modes do not apply on NTFS; the trust boundary is the
 * per-user `icacls` grant. We:
 *   1. mkdir the parent (idempotent).
 *   2. mkdir the resolved root (idempotent; Node 10+ swallows EEXIST
 *      with `recursive: true`).
 *   3. apply `<username>:(OI)(CI)F` so files and sub-directories
 *      created later inherit the same per-user restriction.
 *
 * The `username` is supplied by the caller (the entrypoint caches the
 * `whoami` output for the process lifetime). Falling back to
 * `resolveCurrentUsername` keeps this helper self-contained for tests
 * and for callers that did not pre-resolve the username.
 */
const ensurePrivateDirectoryWindows = (directoryPath, { username, log = () => {} } = {}) => {
  const resolved = resolveManagedOpenCodeHandoffV2Root(directoryPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.mkdirSync(resolved, { recursive: true });
  const resolvedUsername = typeof username === 'string' && username.length > 0
    ? username
    : resolveCurrentUsername({ log });
  applyDirectoryAcl({ dirPath: resolved, username: resolvedUsername, log });
  return resolved;
};

export const ensurePrivateDirectory = (directoryPath, { platform = process.platform, username, log = () => {} } = {}) => {
  if (platform === 'win32') {
    return ensurePrivateDirectoryWindows(directoryPath, { username, log });
  }

  const resolved = resolveManagedOpenCodeHandoffV2Root(directoryPath);
  try {
    assertPrivateDirectory(resolved);
    return resolved;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
  let created = false;
  try {
    fs.mkdirSync(resolved, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }

  if (created) fs.chmodSync(resolved, 0o700);
  assertPrivateDirectory(resolved);
  return resolved;
};

export const assertPrivateRegularFile = (filePath, expectedMode = 0o600) => {
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error('Managed OpenCode handoff v2 file must be regular');
  }
  assertOwner(stat, 'file');
  assertMode(stat, expectedMode, 'file');
  return stat;
};

/**
 * POSIX durability is a security boundary for v2 initialization. A filesystem
 * that cannot fsync the containing directory is unsupported rather than a
 * best-effort success.
 */
export const fsyncDirectory = (directoryPath) => {
  let descriptor;
  try {
    descriptor = fs.openSync(
      directoryPath,
      fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0),
    );
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
};

// Exported for unit tests; not part of the public surface.
export const __test__ = { ensurePrivateDirectoryWindows };
