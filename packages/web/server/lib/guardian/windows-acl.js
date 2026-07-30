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
 * and the ACL step is a brief shell-out (one `icacls` invocation). No
 * async coordination is needed.
 *
 * No raw secret / password / token is ever logged or persisted here.
 * The grant string includes the username (operator identity) only.
 */

// shell metacharacters and quote characters that could break the
// `icacls <path> /inheritance:r /grant:r <user>:F` argument layout.
// `\0`-`\x1F` are control characters; `&|<>^` are shell meta; `"`
// could be used to escape the surrounding `"..."` we use to quote
// paths with spaces.
const UNSAFE_PATH_CHARS = /[\x00-\x1F"&|<>^]/;

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

// Quote a path with double quotes. Caller must have already rejected
// any path containing a literal `"`.
const quoteForIcacls = (value) => `"${value}"`;

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
 * the owner). `/c` continues on error so a missing FILE_WRITE_DATA bit
 * does not stop icacls from reporting the rest; we still parse the
 * exit code at the end.
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
export function applyDiscoveryFileAcl({ portPath, username, log = () => {}, spawnSync = defaultSpawnSync } = {}) {
  assertSafePath(portPath, 'portPath');
  assertUsername(username);
  const args = [
    quoteForIcacls(portPath),
    '/inheritance:r',
    '/grant:r',
    `${username}:F`,
    '/c',
  ];
  const result = spawnSync('icacls', args, { encoding: 'utf8' });
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
  return { ok: true, username };
};

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
export function applyDirectoryAcl({ dirPath, username, log = () => {}, spawnSync = defaultSpawnSync } = {}) {
  assertSafePath(dirPath, 'dirPath');
  assertUsername(username);
  const args = [
    quoteForIcacls(dirPath),
    '/inheritance:r',
    '/grant:r',
    `${username}:(OI)(CI)F`,
    '/c',
  ];
  const result = spawnSync('icacls', args, { encoding: 'utf8' });
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
  return { ok: true, username };
};

// Exported for unit tests; not part of the public surface.
export const __test__ = { UNSAFE_PATH_CHARS, assertSafePath, assertUsername, quoteForIcacls };
