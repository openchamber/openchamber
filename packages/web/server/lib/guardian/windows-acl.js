import { spawnSync as defaultSpawnSync } from 'node:child_process';

/**
 * Windows ACL helpers (W-B).
 *
 * The T2 Windows standalone-guardian trusts a discovery file at
 * `<portPath>` whose permissions are restricted to the current user via
 * `icacls`. The grant string is:
 *
 *     icacls <portPath> /inheritance:r /grant:r <username>:F
 *
 * for the discovery file (no inheritance), and:
 *
 *     icacls <dirPath>  /inheritance:r /grant:r <username>:(OI)(CI)F
 *
 * for the v2-root directory (inheritance is desired so files and
 * sub-directories pick up the same ACL).
 *
 * Trust model (Design Invariant #2):
 *   - The grant target is the **current Windows user** (resolved via
 *     `whoami`), not `Everyone`, not `Users`, not `Authenticated Users`.
 *   - The discovery file is created with `O_EXCL`; the temp file is
 *     never a symlink target because the temp filename cannot pre-exist
 *     on disk.
 *   - The ACL is applied to the **temp** file before the atomic rename
 *     to the published path so a half-published file is never readable
 *     by anyone but the owner.
 *
 * The helpers in this module are **synchronous** by design: the
 * discovery-file publish sequence is itself synchronous (`renameSync`),
 * and the ACL step is a brief shell-out. No
 * async coordination is needed.
 *
 * No raw secret / password / token is ever logged or persisted here.
 * The grant string includes the username (operator identity) only.
 */

// shell metacharacters and quote characters are rejected before values reach
// the `icacls` argument list. `spawnSync(..., { shell: false })` preserves
// each array entry as one argument, including paths with spaces; embedding
// shell quotes in an entry would make those quotes part of the Windows path.
const UNSAFE_PATH_CHARS = /[\x00-\x1F"&|<>^]/;
const FULL_CONTROL = 'F';
const unsafeAclError = (message) => Object.assign(new Error(message), { code: 'WINDOWS_ACL_UNSAFE' });
const SYSTEM_PRINCIPALS = new Set([
  'nt authority\\system',
  'builtin\\administrators',
  'administrators',
]);
const ANCESTOR_CREATOR_PRINCIPALS = new Set([
  'creator owner',
]);
const ANCESTOR_WRITE_RIGHTS = new Set([
  'F',
  'M',
  'W',
  'D',
  'CC',
  'DC',
  'WD',
  'AD',
  'WE',
  'WA',
  'WDAC',
  'WO',
  'SD',
]);

const assertSafePath = (value, label) => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`windows-acl: ${label} is required`);
  }
  if (UNSAFE_PATH_CHARS.test(value)) {
    throw new Error(`windows-acl: ${label} contains unsafe characters (control, shell metacharacters, or quotes)`);
  }
};

const assertUsername = (value) => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError('windows-acl: username is required');
  }
  if (UNSAFE_PATH_CHARS.test(value)) {
    // Defensive — usernames from `whoami` are well-formed on real
    // Windows installs, but a caller-injected username must not slip
    // through the icacls grant.
    throw new Error('windows-acl: username contains unsafe characters');
  }
  return value;
};

const normalizePrincipal = (value) => String(value ?? '').trim().toLowerCase();

const parseAclOutput = (output) => {
  const entries = [];
  let sawPath = false;
  for (const rawLine of String(output ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^successfully processed \d+ files?; failed processing \d+ files?$/i.test(line)) {
      continue;
    }
    const match = rawLine.match(/\s+(.+?):((?:\([^)]+\))+)[ \t]*$/);
    if (match) {
      sawPath = true;
    } else if (!sawPath) {
      sawPath = true;
      continue;
    }
    if (!match) {
      throw new Error('windows-acl: could not parse the complete ACL; refusing to trust the path');
    }
    const rights = Array.from(match[2].matchAll(/\(([^)]+)\)/g), ([, right]) => right.toUpperCase());
    entries.push({
      principal: match[1].trim(),
      rights,
      inherited: rights.includes('I'),
    });
  }
  if (entries.length === 0) {
    throw new Error('windows-acl: ACL query returned no access entries; refusing to trust the path');
  }
  return entries;
};

const inspectWindowsAcl = ({ targetPath, spawnSync = defaultSpawnSync } = {}) => {
  assertSafePath(targetPath, 'targetPath');
  const result = spawnSync('icacls', [targetPath], { encoding: 'utf8', shell: false });
  if (result?.error) {
    if (result.error.code === 'ENOENT') {
      throw new Error('Could not locate icacls binary; refusing to validate the Windows trust boundary');
    }
    throw new Error(`icacls ACL query failed: ${result.error.message}`);
  }
  if (result?.status !== 0) {
    const stderr = String(result?.stderr ?? '').trim();
    throw new Error(`icacls ACL query failed: ${stderr || `<no stderr, status=${result?.status}>`}`);
  }
  return { entries: parseAclOutput(result?.stdout) };
};

/**
 * Validate an existing Windows trust-boundary path. The ACL inspector is
 * injectable so Linux tests can exercise the fail-closed policy without
 * depending on Windows commands.
 */
export function validateWindowsAcl({
  targetPath,
  username,
  kind = 'file',
  aclEntries,
  inspectAcl: inspect = inspectWindowsAcl,
  spawnSync = defaultSpawnSync,
} = {}) {
  assertSafePath(targetPath, 'targetPath');
  let resolvedUsername;
  try {
    resolvedUsername = assertUsername(username || resolveCurrentUsername({ spawnSync }));
  } catch (error) {
    throw unsafeAclError(error?.message || 'Windows username resolution failed');
  }
  let snapshot;
  try {
    snapshot = Array.isArray(aclEntries)
      ? { entries: aclEntries }
      : inspect({ targetPath, username: resolvedUsername, kind, spawnSync });
  } catch (error) {
    if (error?.code === 'WINDOWS_ACL_UNSAFE') throw error;
    throw unsafeAclError(error?.message || 'Windows ACL inspection failed');
  }
  if (snapshot?.reparsePoint === true) {
    throw unsafeAclError(`windows-acl: ${kind} is a reparse point; refusing to trust the path`);
  }
  if (!Array.isArray(snapshot?.entries) || snapshot.entries.length === 0) {
    throw unsafeAclError(`windows-acl: ${kind} ACL is unavailable; refusing to trust the path`);
  }

  const ownerPrincipal = normalizePrincipal(resolvedUsername);
  let ownerEntry = false;
  for (const entry of snapshot.entries) {
    if (!entry || typeof entry.principal !== 'string' || !Array.isArray(entry.rights)) {
      throw unsafeAclError(`windows-acl: ${kind} ACL contains an invalid entry`);
    }
    const principal = normalizePrincipal(entry.principal);
    const rights = entry.rights.map((right) => String(right).toUpperCase());
    const isOwner = principal === ownerPrincipal;
    const isSystem = SYSTEM_PRINCIPALS.has(principal);
    if (!isOwner && !isSystem) {
      throw unsafeAclError(`windows-acl: ${kind} ACL grants access to an unapproved principal`);
    }
    if (rights.includes('DENY') || !rights.includes(FULL_CONTROL)) {
      throw unsafeAclError(`windows-acl: ${kind} ACL has unsafe rights for ${entry.principal}`);
    }
    if (isSystem && !(entry.inherited === true || rights.includes('I'))) {
      throw unsafeAclError(`windows-acl: ${kind} ACL has an unsafe explicit system/admin entry`);
    }
    if (isOwner) ownerEntry = true;
  }
  if (!ownerEntry) {
    throw unsafeAclError(`windows-acl: ${kind} ACL does not grant the current user full control`);
  }
  return { ok: true, username: resolvedUsername };
}

/**
 * Validate an existing ancestor directory. Ancestors such as `C:\Users` may
 * legitimately grant read/execute access to broad principals, so the target
 * ACL policy above is intentionally not reused verbatim. The security rule
 * here is narrower: an unapproved principal must not be able to modify the
 * path, while the current user and inherited SYSTEM/Administrators access
 * remain valid.
 */
export function validateWindowsAncestorAcl({
  targetPath,
  username,
  aclEntries,
  inspectAcl: inspect = inspectWindowsAcl,
  spawnSync = defaultSpawnSync,
} = {}) {
  assertSafePath(targetPath, 'targetPath');
  let resolvedUsername;
  try {
    resolvedUsername = assertUsername(username || resolveCurrentUsername({ spawnSync }));
  } catch (error) {
    throw unsafeAclError(error?.message || 'Windows username resolution failed');
  }

  let snapshot;
  try {
    snapshot = Array.isArray(aclEntries)
      ? { entries: aclEntries }
      : inspect({ targetPath, username: resolvedUsername, kind: 'ancestor', spawnSync });
  } catch (error) {
    if (error?.code === 'WINDOWS_ACL_UNSAFE') throw error;
    throw unsafeAclError(error?.message || 'Windows ancestor ACL inspection failed');
  }
  if (snapshot?.reparsePoint === true) {
    throw unsafeAclError('windows-acl: ancestor is a reparse point; refusing to trust the path');
  }
  if (!Array.isArray(snapshot?.entries) || snapshot.entries.length === 0) {
    throw unsafeAclError('windows-acl: ancestor ACL is unavailable; refusing to trust the path');
  }

  const ownerPrincipal = normalizePrincipal(resolvedUsername);
  for (const entry of snapshot.entries) {
    if (!entry || typeof entry.principal !== 'string' || !Array.isArray(entry.rights)) {
      throw unsafeAclError('windows-acl: ancestor ACL contains an invalid entry');
    }
    const principal = normalizePrincipal(entry.principal);
    const rights = entry.rights.map((right) => String(right).toUpperCase());
    if (rights.includes('DENY')) {
      throw unsafeAclError(`windows-acl: ancestor ACL has a deny entry for ${entry.principal}`);
    }
    const isOwner = principal === ownerPrincipal;
    const isSystem = SYSTEM_PRINCIPALS.has(principal);
    const isCreatorOwner = ANCESTOR_CREATOR_PRINCIPALS.has(principal);
    if (isCreatorOwner && !(entry.inherited === true || rights.includes('I'))) {
      throw unsafeAclError(`windows-acl: ancestor ACL has an unsafe explicit creator-owner entry for ${entry.principal}`);
    }
    if (!isOwner && !isSystem && !isCreatorOwner && rights.some((right) => ANCESTOR_WRITE_RIGHTS.has(right))) {
      throw unsafeAclError(`windows-acl: ancestor ACL grants write access to an unapproved principal (${entry.principal})`);
    }
  }
  return { ok: true, username: resolvedUsername };
}

/**
 * Resolve the current Windows user via `whoami`.
 *
 * `whoami` is a built-in on every supported Windows SKU (including
 * Server Core). The output is the SAM-compatible username
 * (e.g. `DOMAIN\alice` or `HOST\alice`); `icacls` accepts it natively
 * without an extra SID resolution step.
 *
 * The return value is **trimmed** and used directly as the icacls
 * grant target. It is intentionally not a SID: SID lookup via
 * `wmic useraccount get sid` is locale-fragile and adds a second
 * parse step for no security gain (closes F-7).
 *
 * @param {object} [options]
 * @param {typeof defaultSpawnSync} [options.spawnSync] - Override for tests.
 * @param {(message: string) => void} [options.log]
 * @returns {string}
 */
export function resolveCurrentUsername({ spawnSync = defaultSpawnSync, log = () => {} } = {}) {
  const result = spawnSync('whoami', [], { encoding: 'utf8' });
  if (result.error) {
    if (result.error.code === 'ENOENT') {
      log('[guardian-acl] whoami binary not found; cannot resolve Windows username');
      throw new Error('Could not resolve current Windows username (whoami not found on PATH); refusing to start guardian to preserve trust boundary');
    }
    throw new Error(`Could not resolve current Windows username: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = String(result.stderr ?? '').trim();
    throw new Error(`whoami exited with code ${result.status}: ${stderr || '<no stderr>'}`);
  }
  const username = String(result.stdout ?? '').trim();
  if (username.length === 0) {
    throw new Error('whoami returned an empty username');
  }
  return username;
};

/**
 * Apply a per-user ACL to the discovery file. Used as the second-to-last
 * step of the atomic publish sequence:
 *
 *   O_EXCL temp → write → fsync → close → applyDiscoveryFileAcl → rename
 *
 * The grant is `/grant:r <username>:F` (no inheritance, full control for
 * the owner). The command intentionally does not use `icacls /c`: an ACL
 * failure must stop publication rather than continue with a partially
 * protected discovery file.
 *
 * Synchronous because the surrounding publish sequence is.
 *
 * @param {object} options
 * @param {string} options.portPath - The discovery file path (already
 *   created with O_EXCL). The ACL is applied to **this** path. In the
 *   publish sequence the temp path is passed here before rename.
 * @param {string} options.username - The grant target (output of
 *   `resolveCurrentUsername`).
 * @param {(message: string) => void} [options.log]
 * @param {typeof defaultSpawnSync} [options.spawnSync] - Override for tests.
 * @returns {{ ok: true, username: string }}
 */
export function applyDiscoveryFileAcl({
  portPath,
  username,
  log = () => {},
  spawnSync = defaultSpawnSync,
  inspectAcl: inspect,
  aclEntries,
} = {}) {
  assertSafePath(portPath, 'portPath');
  assertUsername(username);
  const args = [
    portPath,
    '/inheritance:r',
    '/grant:r',
    `${username}:F`,
  ];
  const result = spawnSync('icacls', args, { encoding: 'utf8', shell: false });
  if (result.error) {
    if (result.error.code === 'ENOENT') {
      log('[guardian-acl] icacls binary not found on PATH');
      throw new Error('Could not locate icacls binary; refusing to start guardian to preserve trust boundary');
    }
    throw new Error(`icacls spawn failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = String(result.stderr ?? '').trim();
    throw new Error(`icacls failed: ${stderr || `<no stderr, status=${result.status}>`}`);
  }
  validateWindowsAcl({
    targetPath: portPath,
    username,
    kind: 'discovery file',
    ...(inspect ? { inspectAcl: inspect } : {}),
    ...(aclEntries ? { aclEntries } : {}),
    spawnSync,
  });
  return { ok: true, username };
};

/** Apply an owner-only ACL to a regular secret file. */
export function applyPrivateFileAcl({
  filePath,
  username,
  log = () => {},
  spawnSync = defaultSpawnSync,
  inspectAcl: inspect,
  aclEntries,
} = {}) {
  assertSafePath(filePath, 'filePath');
  assertUsername(username);
  const args = [
    filePath,
    '/inheritance:r',
    '/grant:r',
    `${username}:F`,
  ];
  const result = spawnSync('icacls', args, { encoding: 'utf8', shell: false });
  if (result.error) {
    if (result.error.code === 'ENOENT') {
      log('[guardian-acl] icacls binary not found on PATH');
      throw new Error('Could not locate icacls binary; refusing to start guardian to preserve trust boundary');
    }
    throw new Error(`icacls spawn failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = String(result.stderr ?? '').trim();
    throw new Error(`icacls failed: ${stderr || `<no stderr, status=${result.status}>`}`);
  }
  validateWindowsAcl({
    targetPath: filePath,
    username,
    kind: 'private file',
    ...(inspect ? { inspectAcl: inspect } : {}),
    ...(aclEntries ? { aclEntries } : {}),
    spawnSync,
  });
  return { ok: true, username };
}

/**
 * Apply a per-user ACL to a directory with container+object
 * inheritance. The grant is `<username>:(OI)(CI)F` so any file or
 * subdirectory created inside inherits the same per-user restriction.
 *
 * Used by the v2-root initialization on Windows (closes F-3).
 *
 * @param {object} options
 * @param {string} options.dirPath
 * @param {string} options.username
 * @param {(message: string) => void} [options.log]
 * @param {typeof defaultSpawnSync} [options.spawnSync]
 * @returns {{ ok: true, username: string }}
 */
export function applyDirectoryAcl({
  dirPath,
  username,
  log = () => {},
  spawnSync = defaultSpawnSync,
  inspectAcl: inspect,
  aclEntries,
} = {}) {
  assertSafePath(dirPath, 'dirPath');
  assertUsername(username);
  const args = [
    dirPath,
    '/inheritance:r',
    '/grant:r',
    `${username}:(OI)(CI)F`,
  ];
  const result = spawnSync('icacls', args, { encoding: 'utf8', shell: false });
  if (result.error) {
    if (result.error.code === 'ENOENT') {
      log('[guardian-acl] icacls binary not found on PATH');
      throw new Error('Could not locate icacls binary; refusing to start guardian to preserve trust boundary');
    }
    throw new Error(`icacls spawn failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = String(result.stderr ?? '').trim();
    throw new Error(`icacls failed: ${stderr || `<no stderr, status=${result.status}>`}`);
  }
  validateWindowsAcl({
    targetPath: dirPath,
    username,
    kind: 'private directory',
    ...(inspect ? { inspectAcl: inspect } : {}),
    ...(aclEntries ? { aclEntries } : {}),
    spawnSync,
  });
  return { ok: true, username };
};

// Exported for unit tests; not part of the public surface.
export const __test__ = {
  UNSAFE_PATH_CHARS,
  assertSafePath,
  assertUsername,
  parseAclOutput,
  normalizePrincipal,
};
