import fs from 'node:fs';
import path from 'node:path';

import {
  applyDirectoryAcl,
  resolveCurrentUsername,
  validateWindowsAncestorAcl,
  validateWindowsAcl,
} from '../../guardian/windows-acl.js';
import { resolveGuardianPaths } from '../../guardian/paths.js';

const currentUid = () => (typeof process.getuid === 'function' ? process.getuid() : null);

const assertOwner = (stat, label, platform = process.platform) => {
  if (platform === 'win32') return;
  const uid = currentUid();
  if (uid !== null && stat.uid !== uid) {
    throw new Error(`Managed OpenCode handoff v2 ${label} is not owned by this user`);
  }
};

const assertMode = (stat, expectedMode, label, platform = process.platform) => {
  if (platform === 'win32') return;
  if ((stat.mode & 0o777) !== expectedMode) {
    throw new Error(`Managed OpenCode handoff v2 ${label} has unsafe permissions`);
  }
};

export const resolveManagedOpenCodeHandoffV2Root = (rootDir) => {
  const candidate = rootDir === undefined ? resolveGuardianPaths().rootDir : rootDir;
  if (typeof candidate !== 'string' || candidate.trim().length === 0 || !path.isAbsolute(candidate)) {
    throw new TypeError('Managed OpenCode handoff v2 root must be an absolute path');
  }

  const resolved = path.resolve(candidate);
  if (resolved === path.parse(resolved).root) {
    throw new TypeError('Managed OpenCode handoff v2 root must not be a filesystem root');
  }
  return resolved;
};

const defaultIsReparsePoint = (_filePath, stat) => Boolean(stat?.isSymbolicLink?.());

const assertNotReparsePoint = (filePath, stat, label, reparseChecker = defaultIsReparsePoint) => {
  if (reparseChecker(filePath, stat) === true) {
    throw new Error(`Managed OpenCode handoff v2 ${label} must be a regular directory/file and must not be a reparse point`);
  }
};

/**
 * Existing Windows state is trusted only when every existing directory on the
 * path to it is a normal directory. A reparse-point parent can redirect a
 * seemingly private root/file outside the ACL boundary. Missing components
 * are skipped while walking upward so a later existing ancestor is still
 * checked before recursive creation.
 */
export const assertSafeWindowsAncestors = (
  targetPath,
  {
    username,
    aclInspector,
    reparseChecker = defaultIsReparsePoint,
  } = {},
) => {
  const resolved = path.resolve(targetPath);
  const root = path.parse(resolved).root;
  let current = path.dirname(resolved);

  while (current !== root) {
    try {
      const stat = fs.lstatSync(current);
      assertNotReparsePoint(current, stat, 'ancestor', reparseChecker);
      if (!stat.isDirectory()) {
        throw new Error(`Managed OpenCode handoff v2 ancestor ${current} must be a directory`);
      }
      validateWindowsAncestorAcl({
        targetPath: current,
        username,
        ...(aclInspector ? { inspectAcl: aclInspector } : {}),
      });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
};

const assertPrivateDirectory = (
  directoryPath,
  {
    platform = process.platform,
    username,
    aclInspector,
    reparseChecker = defaultIsReparsePoint,
    validateAcl = true,
  } = {},
) => {
  const stat = fs.lstatSync(directoryPath);
  if (platform === 'win32') {
    assertSafeWindowsAncestors(directoryPath, {
      username,
      aclInspector,
      reparseChecker,
    });
  }
  assertNotReparsePoint(directoryPath, stat, 'root', reparseChecker);
  if (!stat.isDirectory()) {
    throw new Error('Managed OpenCode handoff v2 root must be a regular directory');
  }
  assertOwner(stat, 'root', platform);
  assertMode(stat, 0o700, 'root', platform);
  if (platform === 'win32' && validateAcl) {
    validateWindowsAcl({
      targetPath: directoryPath,
      username,
      kind: 'private directory',
      ...(aclInspector ? { inspectAcl: aclInspector } : {}),
    });
  }
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
const ensurePrivateDirectoryWindows = (
  directoryPath,
  { username, log = () => {}, aclInspector, reparseChecker = defaultIsReparsePoint } = {},
) => {
  const resolved = resolveManagedOpenCodeHandoffV2Root(directoryPath);
  const resolvedUsername = typeof username === 'string' && username.length > 0
    ? username
    : resolveCurrentUsername({ log });
  assertSafeWindowsAncestors(resolved, {
    username: resolvedUsername,
    aclInspector,
    reparseChecker,
  });
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  try {
    const existing = fs.lstatSync(resolved);
    assertNotReparsePoint(resolved, existing, 'root', reparseChecker);
    if (!existing.isDirectory()) {
      throw new Error('Managed OpenCode handoff v2 root must be a regular directory');
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  fs.mkdirSync(resolved, { recursive: true });
  applyDirectoryAcl({
    dirPath: resolved,
    username: resolvedUsername,
    log,
    ...(aclInspector ? { inspectAcl: aclInspector } : {}),
  });
  // The ACL application validates the trust boundary. Re-check the object
  // shape after the operation without issuing a second ACL query.
  assertPrivateDirectory(resolved, {
    platform: 'win32',
    username: resolvedUsername,
    aclInspector,
    reparseChecker,
    validateAcl: false,
  });
  return resolved;
};

export const ensurePrivateDirectory = (
  directoryPath,
  {
    platform = process.platform,
    username,
    log = () => {},
    aclInspector,
    reparseChecker = defaultIsReparsePoint,
  } = {},
) => {
  if (platform === 'win32') {
    return ensurePrivateDirectoryWindows(directoryPath, {
      username,
      log,
      aclInspector,
      reparseChecker,
    });
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

export const assertPrivateRegularFile = (
  filePath,
  expectedMode = 0o600,
  {
    platform = process.platform,
    username,
    aclInspector,
    reparseChecker = defaultIsReparsePoint,
  } = {},
) => {
  if (platform === 'win32') {
    assertSafeWindowsAncestors(filePath, {
      username,
      aclInspector,
      reparseChecker,
    });
  }
  const stat = fs.lstatSync(filePath);
  assertNotReparsePoint(filePath, stat, 'file', reparseChecker);
  if (!stat.isFile()) {
    throw new Error('Managed OpenCode handoff v2 file must be regular');
  }
  assertOwner(stat, 'file', platform);
  assertMode(stat, expectedMode, 'file', platform);
  if (platform === 'win32') {
    validateWindowsAcl({
      targetPath: filePath,
      username,
      kind: 'private file',
      ...(aclInspector ? { inspectAcl: aclInspector } : {}),
    });
  }
  return stat;
};

/**
 * POSIX durability is a security boundary for v2 initialization. A filesystem
 * that cannot fsync the containing directory is unsupported rather than a
 * best-effort success. Windows has no directory file-descriptor fsync through
 * this Node API; its ACL-protected root and atomic file publication provide
 * the platform-specific boundary instead.
 */
export const fsyncDirectory = (directoryPath, { platform = process.platform } = {}) => {
  if (platform === 'win32') return;

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
export const __test__ = {
  ensurePrivateDirectoryWindows,
  defaultIsReparsePoint,
  assertNotReparsePoint,
  assertSafeWindowsAncestors,
};
