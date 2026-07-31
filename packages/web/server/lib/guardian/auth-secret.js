import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  applyPrivateFileAcl,
  resolveCurrentUsername,
} from './windows-acl.js';
import {
  assertPrivateRegularFile,
  ensurePrivateDirectory,
} from '../opencode/managed-opencode-handoff-v2/filesystem.js';
import { resolveGuardianPaths } from './paths.js';

export const GUARDIAN_AUTH_SECRET_BYTES = 32;

const readSecret = (secretPath, platform, { username, aclInspector, reparseChecker } = {}) => {
  let stat;
  try {
    stat = assertPrivateRegularFile(secretPath, 0o600, {
      platform,
      username,
      aclInspector,
      reparseChecker,
    });
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }

  if (stat.isSymbolicLink?.() || !stat.isFile() || stat.size !== GUARDIAN_AUTH_SECRET_BYTES) {
    throw new Error('Guardian IPC authentication secret is unsafe');
  }

  const value = fs.readFileSync(secretPath);
  if (value.length !== GUARDIAN_AUTH_SECRET_BYTES) {
    value.fill(0);
    throw new Error('Guardian IPC authentication secret has an invalid length');
  }
  return value;
};

const createSecret = ({ secretPath, platform, username, aclInspector, log }) => {
  const directory = path.dirname(secretPath);
  fs.mkdirSync(directory, { recursive: true });
  let descriptor;
  let value;
  try {
    value = randomBytes(GUARDIAN_AUTH_SECRET_BYTES);
    descriptor = fs.openSync(secretPath, 'wx', 0o600);
    fs.writeFileSync(descriptor, value);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    if (platform !== 'win32') {
      fs.chmodSync(secretPath, 0o600);
    } else {
      applyPrivateFileAcl({
        filePath: secretPath,
        username: username || resolveCurrentUsername({ log }),
        log,
        ...(aclInspector ? { inspectAcl: aclInspector } : {}),
      });
    }
    return value;
  } catch (error) {
    try { if (descriptor !== undefined) fs.closeSync(descriptor); } catch { /* ignore */ }
    value?.fill(0);
    if (error?.code === 'EEXIST') return null;
    try { fs.unlinkSync(secretPath); } catch { /* ignore */ }
    throw error;
  }
};

/**
 * Load or atomically create the per-user guardian IPC secret. The caller owns
 * the returned Buffer and must clear it when the IPC server is stopped.
 */
export async function ensureGuardianAuthSecret({
  paths,
  rootDir,
  platform = process.platform,
  username,
  aclInspector,
  reparseChecker,
  log = () => {},
} = {}) {
  const resolvedPaths = paths ?? resolveGuardianPaths({ platform, rootDir });
  ensurePrivateDirectory(resolvedPaths.rootDir, {
    platform,
    username,
    log,
    aclInspector,
    reparseChecker,
  });
  const existing = readSecret(resolvedPaths.authSecretPath, platform, {
    username,
    aclInspector,
    reparseChecker,
  });
  if (existing) return existing;

  const created = createSecret({
    secretPath: resolvedPaths.authSecretPath,
    platform,
    username,
    aclInspector,
    log,
  });
  if (created) return created;

  const converged = readSecret(resolvedPaths.authSecretPath, platform, {
    username,
    aclInspector,
    reparseChecker,
  });
  if (!converged) {
    throw new Error('Guardian IPC authentication secret creation did not converge');
  }
  return converged;
}

export function readGuardianAuthSecret(
  secretPath,
  { platform = process.platform, username, aclInspector, reparseChecker } = {},
) {
  const value = readSecret(secretPath, platform, { username, aclInspector, reparseChecker });
  if (!value) throw new Error('Guardian IPC authentication secret is missing');
  return value;
}
