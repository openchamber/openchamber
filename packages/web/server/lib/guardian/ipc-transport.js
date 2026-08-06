import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  assertPrivateRegularFile,
  assertSafeWindowsAncestors,
  resolveManagedOpenCodeHandoffV2Root,
} from '../opencode/managed-opencode-handoff-v2/filesystem.js';
import {
  readDiscoveryFile,
  removeDiscoveryFile,
  removeFileByIdentity,
  writeDiscoveryFileAtomic,
} from './discovery-file.js';
import {
  hasFileIdentity,
  sameFileIdentity,
  sameFileObjectIdentity,
  snapshotFileIdentity,
} from './file-identity.js';
import { inspectGuardianPidMarker } from './pid-marker.js';

/**
 * IPC transport abstraction (W-A factory + W-B Windows backend).
 *
 * Single seam for the guardian IPC transport. On POSIX the factory forks a
 * small listener helper that owns `net.createServer(<socketPath>.owner)`,
 * applies umask `0o077` + mode `0600`, publishes the public `<socketPath>` with
 * no-clobber hard-link semantics, proves the public path reaches that actual
 * listener, transfers one accepted probe handle as a two-phase acknowledged
 * readiness token, and forwards later accepted sockets over Node IPC. Linux publishes
 * from a held `O_PATH` descriptor; other listed POSIX platforms use the checked
 * owner pathname and the same listener-probe/handle fence because they do not
 * expose that Linux primitive. The helper retains the Linux descriptor through
 * shutdown so its final identity refresh cannot adopt a replacement pair; the
 * parent identity-checks and removes both paths only after the helper exits. On Windows (W-B) the factory
 * binds a localhost TCP server on
 * an ephemeral port, publishes a per-user-ACL'd discovery file, and removes
 * the file on close.
 *
 * The factory is the only parent-side place in
 * `packages/web/server/lib/guardian/` that calls `net.createConnection`,
 * `chmodSync`, `process.umask`, or knows about platform-specific socket path
 * semantics. The POSIX listener helper owns its own `net.createServer` call.
 * Consumers (`GuardianIpcServer`, `GuardianClient`, `isGuardianRunning`) use
 * the returned `{ listen, close }` and dialer handle without platform
 * knowledge.
 */

const DEFAULT_SOCKET_MODE = 0o600;
const DEFAULT_UMASK = 0o077;
const LOOPBACK_HOST = '127.0.0.1';

const POSIX_PLATFORMS = new Set(['linux', 'darwin', 'freebsd', 'openbsd', 'netbsd', 'sunos', 'aix']);
const WINDOWS_LOCK_SUFFIX = '.lock';
const WINDOWS_TEMP_SUFFIX = '.tmp';
const TRANSPORT_CLEANUP_ERROR_CODE = 'GUARDIAN_TRANSPORT_CLEANUP_FAILED';
const TRANSPORT_CLEANUP_ERROR_MESSAGE = 'Guardian IPC transport cleanup failed';
const TRANSPORT_PUBLICATION_CLEANUP_UNCERTAIN_CODE = 'GUARDIAN_TRANSPORT_CLEANUP_UNCERTAIN';
const POSIX_LISTENER_HELPER_PATH = fileURLToPath(new URL('./ipc-listener-helper.js', import.meta.url));
const DEFAULT_HELPER_SHUTDOWN_TIMEOUT_MS = 2_000;
const DEFAULT_HELPER_KILL_TIMEOUT_MS = 2_000;
const PUBLICATION_HANDLE_MARKER = 'guardian-ipc-publication-handle';
const PUBLICATION_HANDLE_ACCEPT = 'guardian-ipc-publication-accept';
const PUBLICATION_HANDLE_COMMIT = 'guardian-ipc-publication-commit';
const PUBLICATION_HANDLE_COMMIT_ACK = 'guardian-ipc-publication-commit-ack';
const PUBLICATION_HANDLE_COMMIT_CONFIRM = 'guardian-ipc-publication-commit-confirm';
const PUBLICATION_HANDLE_TIMEOUT_MS = 2_000;
const POSIX_OWNER_SUFFIX = '.owner';
const LINUX_O_PATH = 0x200000;

// Bun's child-process IPC does not transfer net.Socket handles on every
// supported version. Use the installed Node executable for the helper when
// the parent is Bun, while passing only PATH (never the parent's environment).
const listenerHelperProcessOptions = () => process.versions?.bun
  ? { execPath: 'node', env: { PATH: process.env.PATH || '/usr/bin:/bin' } }
  : { execPath: process.execPath, env: {} };

const isPosixPlatform = (platform) => POSIX_PLATFORMS.has(platform);
export const isSupportedGuardianPlatform = (platform) => platform === 'win32' || isPosixPlatform(platform);
const posixOwnerPathFor = (socketPath) => `${socketPath}${POSIX_OWNER_SUFFIX}`;
const publicationLine = (kind, token) => `${kind}:${token}\n`;

const publicationHandleError = (message = 'Guardian IPC publication handle is unavailable') =>
  Object.assign(new Error(message), {
    code: 'GUARDIAN_TRANSPORT_PUBLICATION_HANDLE_UNAVAILABLE',
  });

const isPublicationHandle = (handle) => (
  handle instanceof net.Socket
  && !handle.destroyed
  && typeof handle.on === 'function'
  && typeof handle.once === 'function'
  && typeof handle.write === 'function'
  && typeof handle.destroy === 'function'
);

const waitForPublicationHandleLine = (
  handle,
  expectedLine,
  { sendLine } = {},
) => new Promise((resolve, reject) => {
  if (!isPublicationHandle(handle)) {
    reject(publicationHandleError());
    return;
  }

  let buffer = '';
  let timer;
  let settled = false;
  const finish = (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    handle.off('data', onData);
    handle.off('error', onError);
    handle.off('close', onClose);
    if (error) reject(error);
    else {
      handle.on('error', () => {});
      handle.pause?.();
      resolve();
    }
  };
  const onData = (chunk) => {
    buffer += chunk.toString();
    if (buffer.length > 4096) {
      finish(publicationHandleError('Guardian IPC publication handle marker is malformed'));
      return;
    }
    if (buffer.includes(expectedLine)) finish();
  };
  const onError = (error) => finish(publicationHandleError(error?.message));
  const onClose = () => finish(publicationHandleError('Guardian IPC publication handle closed'));

  handle.on('data', onData);
  handle.once('error', onError);
  handle.once('close', onClose);
  handle.resume?.();
  timer = setTimeout(() => finish(publicationHandleError('Guardian IPC publication handle timed out')), PUBLICATION_HANDLE_TIMEOUT_MS);
  timer.unref?.();

  if (sendLine !== undefined) {
    try {
      handle.write(sendLine, (error) => {
        if (error) onError(error);
      });
    } catch (error) {
      onError(error);
    }
  }
});

const staleRecoveryError = (message, code = 'GUARDIAN_TRANSPORT_RECOVERY_UNAUTHORIZED') =>
  Object.assign(new Error(message), { code });

const assertPosixIdentityPolicy = (identity, platform, artifactPath) => {
  const normalized = snapshotFileIdentity(identity);
  if (!normalized || normalized.type !== 'socket') {
    throw staleRecoveryError(
      `POSIX guardian socket identity is unavailable: ${artifactPath || 'unknown artifact'}`,
      'GUARDIAN_TRANSPORT_IDENTITY_UNAVAILABLE',
    );
  }
  if (platform !== 'linux' && normalized.birthtime === null) {
    throw staleRecoveryError(
      `POSIX guardian ctime-only socket identity requires descriptor fencing on Linux: ${artifactPath || 'unknown artifact'}`,
      'GUARDIAN_TRANSPORT_UNSUPPORTED',
    );
  }
  return normalized;
};

const withHeldPosixSocketIdentity = (artifactPath, priorIdentity, platform, callback) => {
  let descriptor = null;
  try {
    let heldIdentity = assertPosixIdentityPolicy(priorIdentity, platform, artifactPath);

    if (platform === 'linux') {
      descriptor = fs.openSync(artifactPath, LINUX_O_PATH | (fs.constants.O_NOFOLLOW ?? 0));
      const heldStat = fs.fstatSync(descriptor);
      const descriptorIdentity = snapshotFileIdentity(heldStat);
      if (
        !descriptorIdentity
        || !heldStat.isSocket?.()
        || !sameFileIdentity(heldIdentity, descriptorIdentity)
      ) {
        throw Object.assign(
          new Error(`POSIX guardian socket identity was replaced: ${artifactPath}`),
          { code: 'GUARDIAN_TRANSPORT_ARTIFACT_REPLACED' },
        );
      }
      heldIdentity = descriptorIdentity;
    } else {
      const currentStat = fs.lstatSync(artifactPath);
      const currentIdentity = assertPosixIdentityPolicy(currentStat, platform, artifactPath);
      if (!sameFileIdentity(heldIdentity, currentIdentity)) {
        throw staleRecoveryError(
          `POSIX guardian socket identity was replaced: ${artifactPath}`,
          'GUARDIAN_TRANSPORT_ARTIFACT_REPLACED',
        );
      }
      heldIdentity = currentIdentity;
    }

    return callback(heldIdentity, descriptor);
  } finally {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch { /* preserve the operation result */ }
    }
  }
};

const readHeldPosixSocketIdentity = ({
  artifactPath,
  descriptor = null,
  priorIdentity,
  platform,
  allowMissing = false,
} = {}) => {
  let stat;
  if (descriptor !== null && descriptor !== undefined) {
    stat = fs.fstatSync(descriptor);
  } else {
    try {
      stat = fs.lstatSync(artifactPath);
    } catch (error) {
      if (allowMissing && error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  if (!stat?.isSocket?.()) {
    throw staleRecoveryError(
      `POSIX guardian socket identity is unsafe: ${artifactPath || 'unknown artifact'}`,
      'GUARDIAN_TRANSPORT_ARTIFACT_UNSAFE',
    );
  }
  const identity = assertPosixIdentityPolicy(stat, platform, artifactPath);
  const identityMatchesPrior = descriptor !== null && descriptor !== undefined
    ? sameFileObjectIdentity(priorIdentity, identity)
    : sameFileIdentity(priorIdentity, identity);
  if (priorIdentity && !identityMatchesPrior) {
    throw staleRecoveryError(
      `POSIX guardian socket identity was replaced: ${artifactPath || 'unknown artifact'}`,
      'GUARDIAN_TRANSPORT_ARTIFACT_REPLACED',
    );
  }
  return identity;
};

const persistedPosixTransportIdentity = (marker) => {
  const value = marker?.transportIdentity;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const publicIdentity = snapshotFileIdentity(value.publicIdentity);
  const ownerIdentity = snapshotFileIdentity(value.ownerIdentity);
  if (
    !publicIdentity
    || !ownerIdentity
    || publicIdentity.type !== 'socket'
    || ownerIdentity.type !== 'socket'
    || !sameFileIdentity(publicIdentity, ownerIdentity)
  ) return null;

  return { publicIdentity, ownerIdentity };
};

const refreshPosixPairIdentity = (
  pair,
  identity,
  marker,
  priorIdentity,
  platform = 'linux',
) => {
  const refreshed = assertPosixIdentityPolicy(identity, platform, 'guardian transport pair');
  if (priorIdentity && !sameFileObjectIdentity(priorIdentity, refreshed)) {
    throw staleRecoveryError(
      'POSIX guardian transport pair identity changed across metadata mutation',
      'GUARDIAN_TRANSPORT_ARTIFACT_REPLACED',
    );
  }
  pair.publicIdentity = { ...refreshed };
  pair.ownerIdentity = { ...refreshed };
  if (marker?.transportIdentity && typeof marker.transportIdentity === 'object') {
    marker.transportIdentity.publicIdentity = { ...refreshed };
    marker.transportIdentity.ownerIdentity = { ...refreshed };
  }
  return refreshed;
};

const assertVerifiedDeadGuardian = (priorMarker, { readIdentity, liveness } = {}) => {
  if (
    priorMarker?.status !== 'valid'
    || typeof priorMarker.token !== 'string'
    || priorMarker.token.length === 0
    || !priorMarker.identity?.processStartTicks
    || !priorMarker.identity?.launch?.commandLine
  ) {
    throw staleRecoveryError(
      'Guardian transport recovery requires a complete prior guardian identity',
    );
  }

  const verification = inspectGuardianPidMarker(priorMarker, {
    ...(typeof readIdentity === 'function' ? { readIdentity } : {}),
    ...(typeof liveness === 'function' ? { liveness } : {}),
  });
  if (verification.state !== 'stale' || verification.reason !== 'recorded process is dead') {
    throw staleRecoveryError(
      `Guardian transport recovery requires verified prior guardian death (${verification.reason || verification.state})`,
    );
  }
  return verification;
};

const transportCleanupError = (artifact, cause, { uncertain = false } = {}) => Object.assign(
  new Error(TRANSPORT_CLEANUP_ERROR_MESSAGE),
  {
    code: uncertain || cause?.code === TRANSPORT_PUBLICATION_CLEANUP_UNCERTAIN_CODE
      ? TRANSPORT_PUBLICATION_CLEANUP_UNCERTAIN_CODE
      : TRANSPORT_CLEANUP_ERROR_CODE,
    artifact,
    cause,
  },
);

const removeStaleArtifact = (
  artifactPath,
  {
    platform,
    socket = false,
    expectedIdentity,
    onIdentity,
    username,
    aclInspector,
    reparseChecker,
  } = {},
) => {
  let stat;
  try {
    stat = platform === 'win32'
      ? assertPrivateRegularFile(artifactPath, 0o600, {
        platform,
        username,
        aclInspector,
        reparseChecker,
      })
      : fs.lstatSync(artifactPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }

  if (expectedIdentity) {
    if (!hasFileIdentity(stat)) {
      throw staleRecoveryError(
        `Cannot verify guardian transport artifact identity: ${artifactPath}`,
        'GUARDIAN_TRANSPORT_IDENTITY_UNAVAILABLE',
      );
    }
    if (!sameFileIdentity(expectedIdentity, stat)) {
      throw staleRecoveryError(
        `Refusing to remove a replaced guardian transport artifact: ${artifactPath}`,
        'GUARDIAN_TRANSPORT_ARTIFACT_REPLACED',
      );
    }
  }

  if (platform !== 'win32') {
    if (
      stat.isSymbolicLink?.()
      || (typeof reparseChecker === 'function' && reparseChecker(artifactPath, stat) === true)
      || (socket ? !stat.isSocket() : !stat.isFile())
    ) {
      throw staleRecoveryError(
        `Refusing to remove unsafe guardian transport artifact: ${artifactPath}`,
        'GUARDIAN_TRANSPORT_ARTIFACT_UNSAFE',
      );
    }
  }

  if (platform === 'win32') {
    return removeFileByIdentity(artifactPath, stat, {
      label: 'guardian transport artifact',
      platform,
      validateAncestors: () => assertSafeWindowsAncestors(artifactPath, {
        username,
        aclInspector,
        reparseChecker,
      }),
      validate: () => assertPrivateRegularFile(artifactPath, 0o600, {
        platform,
        username,
        aclInspector,
        reparseChecker,
      }),
      ...(typeof onIdentity === 'function' ? { onIdentity } : {}),
    });
  }

  try {
    return removeFileByIdentity(artifactPath, expectedIdentity || stat, {
      label: 'guardian transport artifact',
      expectedType: socket ? 'socket' : 'file',
      platform,
      ...(typeof onIdentity === 'function' ? { onIdentity } : {}),
    });
  } catch (error) {
    if (error?.code === 'GUARDIAN_TRANSPORT_ARTIFACT_REPLACED') {
      throw staleRecoveryError(
        `Refusing to remove a replaced guardian transport artifact: ${artifactPath}`,
        'GUARDIAN_TRANSPORT_ARTIFACT_REPLACED',
      );
    }
    throw error;
  }
};

const listQuarantineArtifacts = (basePath) => {
  if (typeof basePath !== 'string' || basePath.length === 0) return [];
  const directory = path.dirname(basePath);
  const prefix = `.${path.basename(basePath)}.`;
  let entries;
  try {
    entries = fs.readdirSync(directory);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  return entries
    .filter((name) => name.startsWith(prefix) && name.endsWith('.remove'))
    .map((name) => path.join(directory, name));
};

const removeStaleQuarantineArtifacts = (
  basePaths,
  {
    platform,
    socket = false,
    username,
    aclInspector,
    reparseChecker,
  } = {},
) => {
  const paths = Array.isArray(basePaths) ? basePaths : [basePaths];
  const seen = new Set();
  for (const basePath of paths) {
    for (const candidate of listQuarantineArtifacts(basePath)) {
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      removeStaleArtifact(candidate, {
        platform,
        socket,
        username,
        aclInspector,
        reparseChecker,
      });
    }
  }
};

const removeStalePosixQuarantineArtifacts = (
  basePaths,
  expectedIdentity,
  onIdentity,
  {
    platform = process.platform,
    heldDescriptor = null,
    refreshHeldIdentity,
  } = {},
) => {
  let authoritativeIdentity = assertPosixIdentityPolicy(
    expectedIdentity,
    platform,
    'guardian transport quarantine',
  );
  if (
    authoritativeIdentity.birthtime === null
    && heldDescriptor === null
    && typeof refreshHeldIdentity !== 'function'
  ) {
    throw staleRecoveryError(
      'POSIX ctime-only guardian transport quarantine requires a held descriptor',
      'GUARDIAN_TRANSPORT_UNSUPPORTED',
    );
  }

  const refreshAuthority = () => {
    if (typeof refreshHeldIdentity === 'function') {
      const refreshed = refreshHeldIdentity({ allowMissing: true });
      if (refreshed) authoritativeIdentity = assertPosixIdentityPolicy(
        refreshed,
        platform,
        'guardian transport quarantine',
      );
      return authoritativeIdentity;
    }
    if (heldDescriptor !== null) {
      authoritativeIdentity = readHeldPosixSocketIdentity({
        artifactPath: 'guardian transport quarantine',
        descriptor: heldDescriptor,
        priorIdentity: authoritativeIdentity,
        platform,
      });
      onIdentity?.(authoritativeIdentity);
    }
    return authoritativeIdentity;
  };

  const paths = Array.isArray(basePaths) ? basePaths : [basePaths];
  const candidates = new Set();
  for (const basePath of paths) {
    for (const candidate of listQuarantineArtifacts(basePath)) candidates.add(candidate);
  }

  for (const candidate of candidates) {
    refreshAuthority();
    let stat;
    try {
      stat = fs.lstatSync(candidate);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    if (stat.isSymbolicLink?.() || (!stat.isSocket?.() && !stat.isFile?.())) {
      throw staleRecoveryError(
        `Refusing to remove unsafe guardian transport quarantine: ${candidate}`,
        'GUARDIAN_TRANSPORT_ARTIFACT_UNSAFE',
      );
    }
    if (!sameFileIdentity(authoritativeIdentity, stat)) {
      throw staleRecoveryError(
        `Refusing to remove an unproven guardian transport quarantine: ${candidate}`,
        'GUARDIAN_TRANSPORT_ARTIFACT_REPLACED',
      );
    }
    removeStaleArtifact(candidate, {
      platform,
      socket: stat.isSocket(),
      expectedIdentity: authoritativeIdentity,
    });
    refreshAuthority();
  }
};

// The public and owner names are one logical POSIX transport identity. If the
// second identity-fenced removal fails, restore the first hard link before
// surfacing the error so a later retry still has a complete pair to inspect.
const removePosixOwnedSocketPair = ({
  initialIdentity,
  platform = process.platform,
  survivingPath,
  updateIdentity,
  removePublic,
  removeOwner,
  restorePublic,
  cleanupQuarantine,
} = {}) => {
  const normalizedInitialIdentity = assertPosixIdentityPolicy(
    initialIdentity,
    platform,
    survivingPath,
  );
  let authoritativeIdentity = normalizedInitialIdentity;
  let heldDescriptor = null;
  const noteIdentity = (identity) => {
    const refreshed = assertPosixIdentityPolicy(identity, platform, survivingPath);
    if (authoritativeIdentity && !sameFileObjectIdentity(authoritativeIdentity, refreshed)) {
      throw staleRecoveryError(
        'POSIX guardian transport pair sibling identity changed across metadata mutation',
        'GUARDIAN_TRANSPORT_ARTIFACT_REPLACED',
      );
    }
    authoritativeIdentity = refreshed;
    updateIdentity?.(refreshed);
    return refreshed;
  };

  const refreshHeldIdentity = ({ allowMissing = false } = {}) => {
    const refreshed = readHeldPosixSocketIdentity({
      artifactPath: survivingPath,
      descriptor: heldDescriptor,
      priorIdentity: authoritativeIdentity,
      platform,
      allowMissing,
    });
    if (!refreshed) return authoritativeIdentity;
    return noteIdentity(refreshed);
  };

  const run = (heldIdentity, descriptor) => {
    heldDescriptor = descriptor;
    authoritativeIdentity = heldIdentity;
    let publicRemoved = false;
    let ownerRemoved = false;
    try {
      if (removePublic(noteIdentity) !== true) {
        throw new Error('POSIX guardian socket cleanup did not settle');
      }
      publicRemoved = true;
      refreshHeldIdentity();
      if (removeOwner(noteIdentity) !== true) {
        throw new Error('POSIX guardian socket owner cleanup did not settle');
      }
      ownerRemoved = true;
      refreshHeldIdentity({ allowMissing: true });
      cleanupQuarantine?.({
        heldDescriptor,
        refreshHeldIdentity,
        getIdentity: () => authoritativeIdentity,
      });
    } catch (error) {
      if (publicRemoved && !ownerRemoved) {
        try {
          restorePublic(authoritativeIdentity, noteIdentity, {
            descriptor: heldDescriptor,
            refreshHeldIdentity,
          });
          refreshHeldIdentity({ allowMissing: true });
        } catch (restoreError) {
          try {
            if (!error.cause) error.cause = restoreError;
          } catch {
            // Preserve the primary cleanup failure when it cannot be annotated.
          }
        }
      }
      try {
        refreshHeldIdentity({ allowMissing: true });
      } catch (refreshError) {
        try {
          if (!error.cause) error.cause = refreshError;
        } catch {
          // Preserve the primary cleanup failure when it cannot be annotated.
        }
      }
      throw error;
    } finally {
      heldDescriptor = null;
    }
  };

  return withHeldPosixSocketIdentity(
    survivingPath,
    normalizedInitialIdentity,
    platform,
    run,
  );
};

/**
 * Remove transport artifacts left by a guardian that has definitely died.
 *
 * The caller obtains `priorMarker` from the O_EXCL PID-marker acquisition
 * path. We revalidate that marker here so a live guardian, a PID-reused
 * process, a legacy marker, or an ambiguous identity can never authorize an
 * unlink. Only regular marker files and expected transport artifact types are
 * removable; symlinks and unexpected filesystem objects fail closed.
 */
export function recoverStaleGuardianTransportArtifacts({
  platform,
  socketPath,
  portPath,
  priorMarker,
  readIdentity,
  liveness,
  username,
  aclInspector,
  reparseChecker,
} = {}) {
  assertVerifiedDeadGuardian(priorMarker, { readIdentity, liveness });

  if (platform === 'win32') {
    if (typeof portPath !== 'string' || portPath.length === 0) {
      throw new TypeError('recoverStaleGuardianTransportArtifacts: Windows portPath is required');
    }
    removeStaleArtifact(`${portPath}${WINDOWS_LOCK_SUFFIX}`, {
      platform,
      username,
      aclInspector,
      reparseChecker,
    });
    removeStaleArtifact(`${portPath}${WINDOWS_TEMP_SUFFIX}`, {
      platform,
      username,
      aclInspector,
      reparseChecker,
    });
    // A stale discovery file is also transport state. The discovery helper
    // performs the platform-specific regular-file and ACL/reparse checks
    // before unlinking it.
    removeDiscoveryFile(portPath, {
      platform,
      username,
      strict: true,
      ...(aclInspector ? { aclInspector } : {}),
      ...(reparseChecker ? { reparseChecker } : {}),
    });
    removeStaleQuarantineArtifacts(
      [portPath, `${portPath}${WINDOWS_LOCK_SUFFIX}`, `${portPath}${WINDOWS_TEMP_SUFFIX}`],
      { platform, username, aclInspector, reparseChecker },
    );
    return { recovered: true, platform };
  }

  if (!isPosixPlatform(platform)) {
    throw staleRecoveryError(`Unsupported guardian transport platform: ${String(platform)}`);
  }
  if (typeof socketPath !== 'string' || socketPath.length === 0) {
    throw new TypeError('recoverStaleGuardianTransportArtifacts: POSIX socketPath is required');
  }

  let socketStat = null;
  try {
    socketStat = fs.lstatSync(socketPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const ownerPath = posixOwnerPathFor(socketPath);
  let ownerStat = null;
  try {
    ownerStat = fs.lstatSync(ownerPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const persistedIdentity = persistedPosixTransportIdentity(priorMarker);
  if (!persistedIdentity) {
    // A marker can be durable before the helper has announced readiness. With
    // no verified transport identity there is no pathname authority to remove;
    // recovery is safe only when the public socket, owner alias, and any
    // hidden quarantine/sidecar artifacts are all absent. Existing artifacts
    // remain fail-closed under the stale marker so a later retry can inspect
    // them with the correct owner identity.
    const quarantineArtifacts = [
      ...listQuarantineArtifacts(socketPath),
      ...listQuarantineArtifacts(ownerPath),
    ];
    if (socketStat || ownerStat || quarantineArtifacts.length > 0) {
      throw staleRecoveryError(
        'Guardian transport recovery requires a persisted POSIX transport identity when artifacts exist',
        'GUARDIAN_TRANSPORT_IDENTITY_UNAVAILABLE',
      );
    }
    return { recovered: true, platform };
  }

  // A public socket without the private owner alias is an ambiguous legacy
  // or replacement artifact. A dead PID marker is not enough authority to
  // unlink it: the alias is the only same-inode proof that the old helper
  // actually owned the public pathname.
  if (!ownerStat) {
    if (
      socketStat
      || listQuarantineArtifacts(socketPath).length > 0
      || listQuarantineArtifacts(ownerPath).length > 0
    ) {
      throw staleRecoveryError(
        `Guardian transport owner alias is missing: ${ownerPath}`,
        'GUARDIAN_TRANSPORT_OWNER_ALIAS_UNAVAILABLE',
      );
    }
    return { recovered: true, platform };
  }
  if (ownerStat.isSymbolicLink?.() || !ownerStat.isSocket?.()) {
    throw staleRecoveryError(
      `Refusing to remove unsafe guardian transport owner alias: ${ownerPath}`,
      'GUARDIAN_TRANSPORT_ARTIFACT_UNSAFE',
    );
  }

  const ownerIdentity = snapshotFileIdentity(ownerStat);
  if (!ownerIdentity) {
    throw staleRecoveryError(
      `Cannot verify guardian transport owner alias identity: ${ownerPath}`,
      'GUARDIAN_TRANSPORT_IDENTITY_UNAVAILABLE',
    );
  }
  if (!socketStat) {
    throw staleRecoveryError(
      `Guardian transport public socket is missing: ${socketPath}`,
      'GUARDIAN_TRANSPORT_PUBLIC_PATH_UNAVAILABLE',
    );
  }
  if (socketStat.isSymbolicLink?.() || !socketStat.isSocket?.()) {
    throw staleRecoveryError(
      `Refusing to remove unsafe guardian transport socket: ${socketPath}`,
      'GUARDIAN_TRANSPORT_ARTIFACT_UNSAFE',
    );
  }

  const socketIdentity = snapshotFileIdentity(socketStat);
  if (!socketIdentity) {
    throw staleRecoveryError(
      `Cannot verify guardian transport socket identity: ${socketPath}`,
      'GUARDIAN_TRANSPORT_IDENTITY_UNAVAILABLE',
    );
  }
  if (!sameFileIdentity(ownerIdentity, socketIdentity)) {
    throw staleRecoveryError(
      `Guardian transport public socket does not match its owner alias: ${socketPath}`,
      'GUARDIAN_TRANSPORT_ARTIFACT_REPLACED',
    );
  }

  if (
    !sameFileIdentity(persistedIdentity.publicIdentity, socketIdentity)
    || !sameFileIdentity(persistedIdentity.ownerIdentity, ownerIdentity)
  ) {
    throw staleRecoveryError(
      `Guardian transport artifacts do not match the persisted listener identity: ${socketPath}`,
      'GUARDIAN_TRANSPORT_ARTIFACT_REPLACED',
    );
  }

  assertPosixIdentityPolicy(persistedIdentity.publicIdentity, platform, socketPath);

  const refreshPair = (identity, priorIdentity = persistedIdentity.publicIdentity || persistedIdentity.ownerIdentity) => refreshPosixPairIdentity(
    persistedIdentity,
    identity,
    priorMarker,
    priorIdentity,
    platform,
  );
  const refreshPairFromHeld = (
    heldDescriptor,
    priorIdentity = persistedIdentity.publicIdentity || persistedIdentity.ownerIdentity,
  ) => {
    const identity = readHeldPosixSocketIdentity({
      artifactPath: ownerPath,
      descriptor: heldDescriptor,
      priorIdentity,
      platform,
    });
    return refreshPair(identity, priorIdentity);
  };

  const restorePublicFromOwner = (
    priorIdentity = persistedIdentity.ownerIdentity,
    _recordIdentity,
    pairContext,
  ) => {
    const restoreWithHeldIdentity = (heldIdentity, heldDescriptor) => {
      const currentOwner = fs.lstatSync(ownerPath);
      if (currentOwner.isSymbolicLink?.() || !currentOwner.isSocket?.()) {
        throw staleRecoveryError(
          `Guardian transport owner alias is unavailable: ${ownerPath}`,
          'GUARDIAN_TRANSPORT_OWNER_ALIAS_UNAVAILABLE',
        );
      }
      const currentOwnerIdentity = snapshotFileIdentity(currentOwner);
      if (
        !currentOwnerIdentity
        || !sameFileObjectIdentity(heldIdentity, currentOwnerIdentity)
        || !sameFileIdentity(heldIdentity, currentOwnerIdentity)
      ) {
        throw staleRecoveryError(
          `Guardian transport owner alias was replaced: ${ownerPath}`,
          'GUARDIAN_TRANSPORT_ARTIFACT_REPLACED',
        );
      }

      let current;
      try {
        current = fs.lstatSync(socketPath);
      } catch (error) {
        if (error?.code === 'ENOENT') current = null;
        else throw error;
      }
      if (current) {
        const currentIdentity = snapshotFileIdentity(current);
        if (
          !currentIdentity
          || current.isSymbolicLink?.()
          || !current.isSocket?.()
          || !sameFileIdentity(heldIdentity, currentIdentity)
          || !sameFileObjectIdentity(heldIdentity, currentIdentity)
        ) {
          throw staleRecoveryError(
            `Guardian transport public socket was replaced: ${socketPath}`,
            'GUARDIAN_TRANSPORT_ARTIFACT_REPLACED',
          );
        }
        refreshPairFromHeld(heldDescriptor, heldIdentity);
        return;
      }

      try {
        // Hard-link restoration is no-clobber and the held owner descriptor
        // remains the object authority through the link and its ctime change.
        fs.linkSync(ownerPath, socketPath);
      } catch (error) {
        if (error?.code === 'EEXIST') {
          const replacement = fs.lstatSync(socketPath);
          if (
            replacement
            && replacement.isSocket?.()
            && hasFileIdentity(replacement)
            && sameFileIdentity(heldIdentity, replacement)
            && sameFileObjectIdentity(heldIdentity, replacement)
          ) {
            refreshPairFromHeld(heldDescriptor, heldIdentity);
            return;
          }
          throw staleRecoveryError(
            `Guardian transport public socket was replaced: ${socketPath}`,
            'GUARDIAN_TRANSPORT_ARTIFACT_REPLACED',
          );
        }
        throw error;
      }

      const restored = fs.lstatSync(socketPath);
      const postLinkOwnerIdentity = readHeldPosixSocketIdentity({
        artifactPath: ownerPath,
        descriptor: heldDescriptor,
        priorIdentity: heldIdentity,
        platform,
      });
      if (
        restored.isSymbolicLink?.()
        || !restored.isSocket?.()
        || !hasFileIdentity(restored)
        || !postLinkOwnerIdentity
        || !sameFileObjectIdentity(postLinkOwnerIdentity, restored)
        || !sameFileIdentity(postLinkOwnerIdentity, restored)
      ) {
        throw staleRecoveryError(
          `Guardian transport public socket restoration is unverified: ${socketPath}`,
          'GUARDIAN_TRANSPORT_IDENTITY_UNAVAILABLE',
        );
      }
      refreshPairFromHeld(heldDescriptor, postLinkOwnerIdentity);
    };

    try {
      if (pairContext && typeof pairContext.refreshHeldIdentity === 'function') {
        const heldIdentity = pairContext.refreshHeldIdentity();
        return restoreWithHeldIdentity(heldIdentity, pairContext.descriptor);
      }
      return withHeldPosixSocketIdentity(
        ownerPath,
        priorIdentity,
        platform,
        restoreWithHeldIdentity,
      );
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw staleRecoveryError(
          `Guardian transport owner alias is unavailable: ${ownerPath}`,
          'GUARDIAN_TRANSPORT_OWNER_ALIAS_UNAVAILABLE',
        );
      }
      throw error;
    }
  };

  // Validate both names before removing either. In particular, never delete
  // a public replacement merely because a stale marker says the prior process
  // died. The same identity is then required by each identity-fenced remove.
  removePosixOwnedSocketPair({
    initialIdentity: persistedIdentity.publicIdentity,
    platform,
    survivingPath: ownerPath,
    updateIdentity: (identity) => refreshPair(identity, identity),
    removePublic: () => {
      if (!removeStaleArtifact(socketPath, {
        platform,
        socket: true,
        expectedIdentity: persistedIdentity.publicIdentity,
      })) {
        throw staleRecoveryError(
          `Guardian transport public socket disappeared before identity-safe removal: ${socketPath}`,
          'GUARDIAN_TRANSPORT_PUBLIC_PATH_UNAVAILABLE',
        );
      }
      return true;
    },
    removeOwner: () => {
      if (!removeStaleArtifact(ownerPath, {
        platform,
        socket: true,
        expectedIdentity: persistedIdentity.ownerIdentity,
      })) {
        throw staleRecoveryError(
          `Guardian transport owner alias disappeared before identity-safe removal: ${ownerPath}`,
          'GUARDIAN_TRANSPORT_OWNER_ALIAS_UNAVAILABLE',
        );
      }
      return true;
    },
    restorePublic: restorePublicFromOwner,
    cleanupQuarantine: ({ heldDescriptor, refreshHeldIdentity, getIdentity }) => (
      removeStalePosixQuarantineArtifacts(
        [socketPath, ownerPath],
        getIdentity(),
        refreshPair,
        {
          platform,
          heldDescriptor,
          refreshHeldIdentity,
        },
      )
    ),
  });
  return { recovered: true, platform };
}

/**
 * Resolve the default per-platform IPC paths used by the guardian
 * entrypoint and consumers. The result intentionally has `undefined`
 * for the slot the platform does not use so callers can detect which
 * transport to dial.
 *
 * @param {object} options
 * @param {NodeJS.Platform} options.platform
 * @param {string} [options.rootDir] - POSIX v2 root (for `socketPath`).
 * @param {string} [options.portDir] - Windows v2 root (for `portPath`).
 * @returns {{ socketPath: string|undefined, portPath: string|undefined }}
 */
export function defaultIpcPaths({ platform, rootDir, portDir } = {}) {
  if (platform === 'win32') {
    if (typeof portDir !== 'string' || portDir.length === 0) {
      throw new TypeError('defaultIpcPaths: Windows portDir is required');
    }
    return {
      socketPath: undefined,
      portPath: path.join(resolveManagedOpenCodeHandoffV2Root(portDir), 'port'),
    };
  }

  if (isPosixPlatform(platform)) {
    if (typeof rootDir !== 'string' || rootDir.length === 0) {
      throw new TypeError('defaultIpcPaths: POSIX rootDir is required');
    }
    return {
      socketPath: path.join(resolveManagedOpenCodeHandoffV2Root(rootDir), 'guardian.sock'),
      portPath: undefined,
    };
  }

  // FIXME: extend the factory for any new platform. Failing closed
  // here is intentional: a silently-misrouted transport is a security
  // bug.
  throw new Error(`defaultIpcPaths: unsupported platform: ${String(platform)}`);
}

const createPosixIpcServer = ({
  platform = process.platform,
  socketPath,
  log = () => {},
  helperPath = POSIX_LISTENER_HELPER_PATH,
  helperShutdownTimeoutMs = DEFAULT_HELPER_SHUTDOWN_TIMEOUT_MS,
  forkProcess = fork,
} = {}) => {
  if (typeof socketPath !== 'string' || socketPath.length === 0) {
    throw new TypeError('createIpcServer: POSIX socketPath is required');
  }

  const ownerPath = posixOwnerPathFor(socketPath);

  const readPath = () => {
    try {
      return fs.lstatSync(socketPath);
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  };

  const readOwnerPath = () => {
    try {
      return fs.lstatSync(ownerPath);
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  };

  const replacementError = () => Object.assign(
    new Error(`Guardian IPC socket path was replaced: ${socketPath}`),
    { code: 'GUARDIAN_TRANSPORT_ARTIFACT_REPLACED' },
  );

  const ownerReplacementError = () => Object.assign(
    new Error(`Guardian IPC owner alias was replaced: ${ownerPath}`),
    { code: 'GUARDIAN_TRANSPORT_ARTIFACT_REPLACED' },
  );

  const identityUnavailableError = (message) => Object.assign(
    new Error(message),
    { code: 'GUARDIAN_TRANSPORT_IDENTITY_UNAVAILABLE' },
  );

  const helperFailureError = (code, phase, cleanupArtifacts) => Object.assign(
    new Error(`Guardian IPC listener helper failed (${code || 'unknown'})`),
    {
      code: code === 'EADDRINUSE'
        ? 'EADDRINUSE'
        : code === 'ENOTSUP'
          ? 'GUARDIAN_TRANSPORT_UNSUPPORTED'
        : code === TRANSPORT_PUBLICATION_CLEANUP_UNCERTAIN_CODE
          ? TRANSPORT_PUBLICATION_CLEANUP_UNCERTAIN_CODE
        : 'GUARDIAN_TRANSPORT_HELPER_FAILED',
      helperCode: code,
      helperPhase: phase,
      ...(Array.isArray(cleanupArtifacts) ? { cleanupArtifacts } : {}),
    },
  );

  const helperExitTimeoutError = (phase) => Object.assign(
    new Error(`Guardian IPC listener helper did not exit during ${phase}`),
    { code: 'GUARDIAN_TRANSPORT_HELPER_EXIT_TIMEOUT', helperPhase: phase },
  );

  const helperSendTimeoutError = () => Object.assign(
    new Error('Guardian IPC listener helper did not accept shutdown before the timeout'),
    { code: 'GUARDIAN_TRANSPORT_HELPER_SEND_TIMEOUT', helperPhase: 'shutdown' },
  );

  const listenCancelledError = () => Object.assign(
    new Error('Guardian IPC listen was cancelled by close'),
    { code: 'GUARDIAN_TRANSPORT_LISTEN_CANCELLED' },
  );

  const posixFailure = (artifact, error) => {
    if (
      error?.code === TRANSPORT_PUBLICATION_CLEANUP_UNCERTAIN_CODE
      && error?.artifact === artifact
      && error?.message === TRANSPORT_CLEANUP_ERROR_MESSAGE
    ) return error;
    return transportCleanupError(artifact, error, { uncertain: true });
  };

  let helper = null;
  let helperExitPromise = null;
  let helperExited = false;
  let helperExpectedExit = false;
  let helperExitInfo = null;
  let helperReportedError = null;
  let helperCleanupArtifacts = new Map();
  let listenerReady = false;
  let socketIdentity = null;
  let ownerIdentity = null;
  let socketQuarantinePath = null;
  let ownerQuarantinePath = null;
  let cleanupAuthority = false;
  let requestHandler = null;
  let closePromise = null;
  let activeListen = null;
  let startupFailureStarted = false;
  let startupCleanupPromise = null;
  let failStartup = null;
  let closing = false;
  let listenGeneration = 0;
  let activeListenGeneration = null;
  let pendingReadyPublication = null;
  let readyHandleAcceptanceInProgress = false;

  const sockets = new Set();

  const clearState = () => {
    helper = null;
    helperExitPromise = null;
    helperExited = false;
    helperExpectedExit = false;
    helperExitInfo = null;
    helperReportedError = null;
    helperCleanupArtifacts = new Map();
    listenerReady = false;
    socketIdentity = null;
    ownerIdentity = null;
    socketQuarantinePath = null;
    ownerQuarantinePath = null;
    cleanupAuthority = false;
    requestHandler = null;
    startupFailureStarted = false;
    startupCleanupPromise = null;
    activeListen = null;
    closing = false;
    activeListenGeneration = null;
    pendingReadyPublication = null;
    readyHandleAcceptanceInProgress = false;
  };

  const waitForHelperExit = async (timeoutMs) => {
    if (!helperExitPromise || helperExited) return helperExitInfo;
    const boundedTimeout = Number.isFinite(timeoutMs) && timeoutMs >= 0
      ? timeoutMs
      : DEFAULT_HELPER_SHUTDOWN_TIMEOUT_MS;
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), boundedTimeout);
    });
    try {
      return await Promise.race([helperExitPromise, timeout]);
    } finally {
      clearTimeout(timer);
    }
  };

  const rememberHelperCleanupArtifacts = (artifacts) => {
    if (!Array.isArray(artifacts)) return;
    for (const artifact of artifacts) {
      if (!artifact || typeof artifact.path !== 'string') continue;
      if (artifact.path !== socketPath && artifact.path !== ownerPath) continue;
      const identity = snapshotFileIdentity(artifact.identity);
      helperCleanupArtifacts.set(artifact.path, {
        path: artifact.path,
        label: typeof artifact.label === 'string'
          ? artifact.label
          : artifact.path === ownerPath
            ? 'POSIX guardian socket owner alias'
            : 'POSIX guardian socket',
        identity,
        quarantinePath: typeof artifact.quarantinePath === 'string'
          ? artifact.quarantinePath
          : null,
      });
    }

    const socketEntry = helperCleanupArtifacts.get(socketPath);
    const ownerEntry = helperCleanupArtifacts.get(ownerPath);
    if (socketEntry?.quarantinePath) socketQuarantinePath = socketEntry.quarantinePath;
    if (ownerEntry?.quarantinePath) ownerQuarantinePath = ownerEntry.quarantinePath;
  };

  const retryHelperCleanupArtifacts = () => {
    if (helperCleanupArtifacts.size === 0) {
      throw transportCleanupError(
        'POSIX guardian socket',
        Object.assign(new Error('helper cleanup authority is unavailable'), {
          code: TRANSPORT_PUBLICATION_CLEANUP_UNCERTAIN_CODE,
        }),
        { uncertain: true },
      );
    }

    const socketEntry = helperCleanupArtifacts.get(socketPath);
    const ownerEntry = helperCleanupArtifacts.get(ownerPath);
    if (
      socketEntry?.identity
      && ownerEntry?.identity
      && sameFileIdentity(socketEntry.identity, ownerEntry.identity)
    ) {
      // The helper's publication proof is cleanup authority even though the
      // parent never accepted the ready frame. Reuse the pair cleanup path so
      // ctime-only Linux identities and hidden quarantine entries receive the
      // same sibling refresh and restore treatment as a ready transport.
      socketIdentity = { ...socketEntry.identity };
      ownerIdentity = { ...ownerEntry.identity };
      socketQuarantinePath = socketEntry.quarantinePath;
      ownerQuarantinePath = ownerEntry.quarantinePath;
      removeOwnedSocket();
      helperCleanupArtifacts.clear();
      return;
    }

    for (const [artifactPath, entry] of [...helperCleanupArtifacts]) {
      if (!entry.identity) {
        throw transportCleanupError(
          entry.label,
          Object.assign(new Error(`helper cleanup identity is unavailable: ${artifactPath}`), {
            code: TRANSPORT_PUBLICATION_CLEANUP_UNCERTAIN_CODE,
          }),
          { uncertain: true },
        );
      }
      const result = removeFileByIdentity(artifactPath, entry.identity, {
        label: entry.label,
        expectedType: 'socket',
        platform,
        returnResult: true,
        quarantinePath: entry.quarantinePath || undefined,
        onQuarantinePath: (value) => {
          entry.quarantinePath = value;
          if (artifactPath === socketPath) socketQuarantinePath = value;
          if (artifactPath === ownerPath) ownerQuarantinePath = value;
        },
        onIdentity: (value) => {
          entry.identity = value;
          for (const sibling of helperCleanupArtifacts.values()) {
            if (sibling !== entry && sibling.identity && sameFileObjectIdentity(entry.identity, sibling.identity)) {
              sibling.identity = { ...value };
            }
          }
        },
      });
      if (result?.status !== 'removed' && result?.status !== 'absent') {
        throw result?.error || transportCleanupError(
          entry.label,
          Object.assign(new Error(`helper cleanup did not settle: ${artifactPath}`), {
            code: TRANSPORT_PUBLICATION_CLEANUP_UNCERTAIN_CODE,
          }),
          { uncertain: true },
        );
      }
      helperCleanupArtifacts.delete(artifactPath);
    }

    socketQuarantinePath = null;
    ownerQuarantinePath = null;
  };

  const sendHelperMessage = (message) => new Promise((resolve, reject) => {
    if (!helper || helperExited || helper.connected === false || typeof helper.send !== 'function') {
      reject(Object.assign(new Error('Guardian IPC listener helper channel is unavailable'), {
        code: 'GUARDIAN_TRANSPORT_HELPER_IPC_UNAVAILABLE',
      }));
      return;
    }
    try {
      helper.send(message, (error) => (error ? reject(error) : resolve()));
    } catch (error) {
      reject(error);
    }
  });

  const sendHelperMessageWithTimeout = (message, timeoutMs) => {
    const boundedTimeout = Number.isFinite(timeoutMs) && timeoutMs >= 0
      ? timeoutMs
      : DEFAULT_HELPER_SHUTDOWN_TIMEOUT_MS;
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(helperSendTimeoutError()), boundedTimeout);
    });
    return Promise.race([sendHelperMessage(message), timeout]).finally(() => {
      clearTimeout(timer);
    });
  };

  const stopHelper = async ({ preserveUnverifiedArtifacts = false } = {}) => {
    if (!helperExitPromise) return;

    if (!helperExited) {
      helperExpectedExit = true;
      let sendTimedOut = preserveUnverifiedArtifacts;
      if (preserveUnverifiedArtifacts) {
        // A parent-side ready/identity validation failure means the helper's
        // publication was never adopted by this transport. Do not send the
        // graceful shutdown frame: the helper could remove an artifact the
        // parent has deliberately classified as unknown. Kill only the child
        // process and leave recovery authority with the parent/marker path.
        try { helper?.kill?.('SIGKILL'); } catch { /* The process may have exited. */ }
      } else {
        try {
          await sendHelperMessageWithTimeout({ type: 'shutdown' }, helperShutdownTimeoutMs);
        } catch (error) {
          // The helper may have already lost IPC. The process handle is still
          // authoritative for the safe kill fallback below.
          sendTimedOut = error?.code === 'GUARDIAN_TRANSPORT_HELPER_SEND_TIMEOUT';
          if (sendTimedOut && helper && !helperExited) {
            try { helper.kill('SIGKILL'); } catch { /* The process may have exited. */ }
          }
        }
      }

      let exitInfo = await waitForHelperExit(
        sendTimedOut ? DEFAULT_HELPER_KILL_TIMEOUT_MS : helperShutdownTimeoutMs,
      );
      if (!exitInfo && helper && !helperExited) {
        try { helper.kill('SIGKILL'); } catch { /* The process may have exited. */ }
        exitInfo = await waitForHelperExit(DEFAULT_HELPER_KILL_TIMEOUT_MS);
      }
      if (!exitInfo) throw helperExitTimeoutError('shutdown');
    }
  };

  const destroySocket = (socket) => {
    try { socket?.end?.(); } catch { /* Ignore a failed half-close. */ }
    try { socket?.destroy?.(); } catch { /* Ignore a failed destroy. */ }
  };

  const destroyTrackedSockets = () => {
    for (const socket of sockets) destroySocket(socket);
  };

  const destroyPendingPublicationHandle = () => {
    const pending = pendingReadyPublication;
    pendingReadyPublication = null;
    destroySocket(pending?.handle);
  };

  const trackSocket = (socket, sourceHelper, sourceGeneration) => {
    if (!socket || typeof socket.on !== 'function') {
      destroySocket(socket);
      return;
    }
    // A child-process message can already be queued when shutdown begins, and
    // an old helper can emit a late message after a successful close/relisten.
    // Neither case may repopulate the transport's accepted-handle set.
    if (
      closing
      || sourceGeneration !== activeListenGeneration
      || helper !== sourceHelper
      || helperExited
      || !listenerReady
    ) {
      destroySocket(socket);
      return;
    }
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', (error) => {
      log(`[guardian-ipc] socket error: ${error.message}`);
      sockets.delete(socket);
    });
    try {
      requestHandler?.(socket);
    } catch {
      destroySocket(socket);
    }
  };

  const verifyOwnedArtifacts = () => {
    if (!hasFileIdentity(socketIdentity) || !hasFileIdentity(ownerIdentity)) {
      throw identityUnavailableError(
        `Guardian IPC public/owner identity is unavailable: ${socketPath}`,
      );
    }
    assertPosixIdentityPolicy(socketIdentity, platform, socketPath);

    const current = readPath();
    const currentOwner = readOwnerPath();
    if (!current) throw identityUnavailableError(`Guardian IPC public socket is missing: ${socketPath}`);
    if (!currentOwner) throw identityUnavailableError(`Guardian IPC owner alias is missing: ${ownerPath}`);
    if (current.isSymbolicLink?.() || !current.isSocket?.()) throw replacementError();
    if (currentOwner.isSymbolicLink?.() || !currentOwner.isSocket?.()) {
      throw ownerReplacementError();
    }

    const currentIdentity = snapshotFileIdentity(current);
    const currentOwnerIdentity = snapshotFileIdentity(currentOwner);
    if (!currentIdentity || !currentOwnerIdentity) {
      throw identityUnavailableError(
        `Guardian IPC public/owner identity is unavailable: ${socketPath}`,
      );
    }
    if (
      !sameFileIdentity(socketIdentity, currentIdentity)
      || !sameFileIdentity(ownerIdentity, currentOwnerIdentity)
      || !sameFileIdentity(currentIdentity, currentOwnerIdentity)
    ) {
      throw sameFileIdentity(ownerIdentity, currentOwnerIdentity)
        ? replacementError()
        : ownerReplacementError();
    }
    return { current, currentOwner };
  };

  const refreshOwnedPairIdentity = (identity, priorIdentity = socketIdentity || ownerIdentity) => {
    const refreshed = assertPosixIdentityPolicy(identity, platform, socketPath);
    if (priorIdentity && !sameFileObjectIdentity(priorIdentity, refreshed)) {
      throw replacementError();
    }
    socketIdentity = { ...refreshed };
    ownerIdentity = { ...refreshed };
    return refreshed;
  };

  const refreshOwnedPairIdentityFromHeld = (
    heldDescriptor,
    priorIdentity = socketIdentity || ownerIdentity,
  ) => {
    const identity = readHeldPosixSocketIdentity({
      artifactPath: ownerPath,
      descriptor: heldDescriptor,
      priorIdentity,
      platform,
    });
    return refreshOwnedPairIdentity(identity, priorIdentity);
  };

  const restorePublicFromOwner = (
    priorIdentity = ownerIdentity,
    _recordIdentity,
    pairContext,
  ) => {
    const restoreWithHeldIdentity = (heldIdentity, heldDescriptor) => {
      const currentOwner = readOwnerPath();
      if (!currentOwner || currentOwner.isSymbolicLink?.() || !currentOwner.isSocket?.()) {
        throw identityUnavailableError(`Guardian IPC owner alias is unavailable: ${ownerPath}`);
      }
      const currentOwnerIdentity = snapshotFileIdentity(currentOwner);
      if (
        !currentOwnerIdentity
        || !sameFileObjectIdentity(heldIdentity, currentOwnerIdentity)
        || !sameFileIdentity(heldIdentity, currentOwnerIdentity)
      ) {
        throw ownerReplacementError();
      }

      const current = readPath();
      if (current) {
        const currentIdentity = snapshotFileIdentity(current);
        if (
          !currentIdentity
          || !sameFileObjectIdentity(heldIdentity, currentIdentity)
          || !sameFileIdentity(heldIdentity, currentIdentity)
        ) {
          throw replacementError();
        }
        refreshOwnedPairIdentityFromHeld(heldDescriptor, heldIdentity);
        return;
      }

      try {
        // Hard-link restoration is no-clobber: a new public artifact cannot be
        // overwritten while repairing a partial identity-safe cleanup. The
        // held owner descriptor remains authoritative through the link and the
        // post-link ctime mutation.
        fs.linkSync(ownerPath, socketPath);
      } catch (error) {
        if (error?.code === 'EEXIST') {
          const replacement = readPath();
          if (
            replacement
            && hasFileIdentity(replacement)
            && sameFileObjectIdentity(heldIdentity, replacement)
            && sameFileIdentity(heldIdentity, replacement)
          ) {
            refreshOwnedPairIdentityFromHeld(heldDescriptor, heldIdentity);
            return;
          }
          throw replacementError();
        }
        throw error;
      }

      const restored = readPath();
      const postLinkOwnerIdentity = heldDescriptor === null
        ? snapshotFileIdentity(fs.lstatSync(ownerPath))
        : snapshotFileIdentity(fs.fstatSync(heldDescriptor));
      if (
        !restored
        || !hasFileIdentity(restored)
        || !postLinkOwnerIdentity
        || !sameFileObjectIdentity(postLinkOwnerIdentity, restored)
        || !sameFileIdentity(postLinkOwnerIdentity, restored)
      ) {
        throw identityUnavailableError(`Guardian IPC public socket restoration is unverified: ${socketPath}`);
      }
      refreshOwnedPairIdentityFromHeld(heldDescriptor, postLinkOwnerIdentity);
    };

    if (pairContext && typeof pairContext.refreshHeldIdentity === 'function') {
      const heldIdentity = pairContext.refreshHeldIdentity();
      return restoreWithHeldIdentity(heldIdentity, pairContext.descriptor);
    }
    return withHeldPosixSocketIdentity(
      ownerPath,
      priorIdentity,
      platform,
      restoreWithHeldIdentity,
    );
  };

  const removeOwnedSocket = () => {
    verifyOwnedArtifacts();

    removePosixOwnedSocketPair({
      initialIdentity: socketIdentity || ownerIdentity,
      platform,
      survivingPath: ownerPath,
      updateIdentity: (identity) => refreshOwnedPairIdentity(identity, identity),
      removePublic: () => {
        const publicResult = removeFileByIdentity(socketPath, socketIdentity, {
          label: 'POSIX guardian socket',
          expectedType: 'socket',
          platform,
          strict: true,
          returnResult: true,
          quarantinePath: socketQuarantinePath,
          onQuarantinePath: (value) => { socketQuarantinePath = value; },
        });
        if (publicResult?.status !== 'removed') {
          throw publicResult?.error || identityUnavailableError(
            `Guardian IPC public socket cleanup is incomplete: ${socketPath}`,
          );
        }
        return true;
      },
      removeOwner: () => {
        const ownerResult = removeFileByIdentity(ownerPath, ownerIdentity, {
          label: 'POSIX guardian socket owner alias',
          expectedType: 'socket',
          platform,
          strict: true,
          returnResult: true,
          quarantinePath: ownerQuarantinePath,
          onQuarantinePath: (value) => { ownerQuarantinePath = value; },
        });
        if (ownerResult?.status !== 'removed') {
          throw ownerResult?.error || identityUnavailableError(
            `Guardian IPC owner alias cleanup is incomplete: ${ownerPath}`,
          );
        }
        return true;
      },
      // If alias removal fails after the public inode was removed, restore the
      // public hard link from the still-verified owner alias. This preserves a
      // retryable owned pair rather than leaving an unowned alias behind.
      restorePublic: restorePublicFromOwner,
      cleanupQuarantine: ({ heldDescriptor, refreshHeldIdentity, getIdentity }) => (
        removeStalePosixQuarantineArtifacts(
          [socketPath, ownerPath],
          getIdentity(),
          undefined,
          {
            platform,
            heldDescriptor,
            refreshHeldIdentity,
          },
        )
      ),
    });

    if (
      readPath()
      || readOwnerPath()
      || listQuarantineArtifacts(socketPath).length > 0
      || listQuarantineArtifacts(ownerPath).length > 0
    ) {
      throw identityUnavailableError(`Guardian IPC cleanup could not prove both paths absent: ${socketPath}`);
    }
    socketIdentity = null;
    ownerIdentity = null;
    socketQuarantinePath = null;
    ownerQuarantinePath = null;
  };

  const verifyUnknownStartupPath = () => {
    const current = readPath();
    const currentOwner = readOwnerPath();
    if (
      !current
      && !currentOwner
      && listQuarantineArtifacts(socketPath).length === 0
      && listQuarantineArtifacts(ownerPath).length === 0
    ) return;
    throw identityUnavailableError(
      `Guardian IPC startup cleanup identity is unavailable: ${socketPath}`,
    );
  };

  const publicationProofError = () => identityUnavailableError(
    'Guardian IPC listener helper publication proof is unavailable',
  );

  const validatePublicationProof = (message) => {
    const token = message?.publicationToken;
    const proof = message?.publicationProof;
    if (
      typeof token !== 'string'
      || !/^[0-9a-f]{64}$/.test(token)
      || !proof
      || proof.token !== token
    ) {
      throw publicationProofError();
    }

    const {
      boundPathIdentity,
      descriptorIdentity,
      listenerIdentity,
      publicIdentity,
      ownerIdentity: proofOwnerIdentity,
    } = proof;
    if (
      !hasFileIdentity(boundPathIdentity)
      || boundPathIdentity.type !== 'socket'
      || !hasFileIdentity(descriptorIdentity)
      || descriptorIdentity.type !== 'socket'
      || !hasFileIdentity(listenerIdentity)
      || listenerIdentity.type !== 'socket'
      || !hasFileIdentity(publicIdentity)
      || publicIdentity.type !== 'socket'
      || !hasFileIdentity(proofOwnerIdentity)
      || proofOwnerIdentity.type !== 'socket'
    ) {
      throw publicationProofError();
    }
    for (const identity of [
      boundPathIdentity,
      descriptorIdentity,
      publicIdentity,
      proofOwnerIdentity,
    ]) {
      assertPosixIdentityPolicy(identity, platform, socketPath);
    }
    if (
      !sameFileIdentity(boundPathIdentity, descriptorIdentity)
      || !sameFileIdentity(boundPathIdentity, publicIdentity)
      || !sameFileIdentity(boundPathIdentity, proofOwnerIdentity)
      || !sameFileIdentity(publicIdentity, proofOwnerIdentity)
    ) {
      throw replacementError();
    }
    return { token, ...proof };
  };

  const validatePublicationHandle = async (message, handle, token) => {
    if (message?.publicationHandle !== 'accepted-probe' || !isPublicationHandle(handle)) {
      throw publicationHandleError();
    }
    await waitForPublicationHandleLine(
      handle,
      publicationLine(PUBLICATION_HANDLE_MARKER, token),
    );
  };

  const corroboratePublicationProof = (proof) => {
    const current = readPath();
    const currentOwner = readOwnerPath();
    if (
      !current
      || !currentOwner
      || current.isSymbolicLink?.()
      || currentOwner.isSymbolicLink?.()
      || !current.isSocket?.()
      || !currentOwner.isSocket?.()
      || !hasFileIdentity(current)
      || !hasFileIdentity(currentOwner)
      || !sameFileIdentity(proof.publicIdentity, current)
      || !sameFileIdentity(proof.ownerIdentity, currentOwner)
      || !sameFileObjectIdentity(current, currentOwner)
    ) {
      throw currentOwner && hasFileIdentity(currentOwner)
        && !sameFileIdentity(proof.ownerIdentity, currentOwner)
        ? ownerReplacementError()
        : replacementError();
    }
    assertPosixIdentityPolicy(current, platform, socketPath);
    assertPosixIdentityPolicy(currentOwner, platform, ownerPath);
    if (
      (current.mode & 0o777) !== DEFAULT_SOCKET_MODE
      || (currentOwner.mode & 0o777) !== DEFAULT_SOCKET_MODE
    ) {
      throw Object.assign(new Error('Guardian IPC socket mode is not owner-only'), {
        code: 'GUARDIAN_TRANSPORT_SOCKET_MODE_INVALID',
      });
    }
  };

  const samePublicationObject = (left, right) => (
    sameFileObjectIdentity(left?.listenerIdentity, right?.listenerIdentity)
    && sameFileObjectIdentity(left?.boundPathIdentity, right?.boundPathIdentity)
    && sameFileObjectIdentity(left?.descriptorIdentity, right?.descriptorIdentity)
    && sameFileObjectIdentity(left?.publicIdentity, right?.publicIdentity)
    && sameFileObjectIdentity(left?.ownerIdentity, right?.ownerIdentity)
  );

  const cleanupStartupFailure = async (originalError, preserveUnverifiedArtifacts = false) => {
    let cleanupError = null;
    destroyPendingPublicationHandle();
    try {
      await stopHelper({ preserveUnverifiedArtifacts });
    } catch (error) {
      cleanupError = error;
    }

    if (!cleanupError && helperReportedError?.code === TRANSPORT_PUBLICATION_CLEANUP_UNCERTAIN_CODE) {
      cleanupError = helperReportedError;
    }

    if (!cleanupError) {
      try {
        if (socketIdentity || ownerIdentity) removeOwnedSocket();
        else verifyUnknownStartupPath();
      } catch (error) {
        cleanupError = error;
      }
    }

    if (cleanupError) {
      cleanupAuthority = true;
      throw posixFailure('POSIX guardian socket', cleanupError);
    }

    clearState();
    throw originalError;
  };

  const handleHelperMessage = (message, handle, sourceHelper, sourceGeneration) => {
    if (message?.type === 'connection') {
      trackSocket(handle, sourceHelper, sourceGeneration);
      return;
    }

    // A prior helper may report an error, disconnect, or ready frame after a
    // successful close and relisten. Only its own listen generation may affect
    // the current transport; stale handles are still destroyed above.
    if (sourceGeneration !== activeListenGeneration || helper !== sourceHelper) {
      destroySocket(handle);
      return;
    }

    if (message?.type === 'closed') {
      const closedDescriptorIdentity = message.descriptorIdentity;
      const closedPublicIdentity = message.publicIdentity;
      const closedOwnerIdentity = message.ownerIdentity;
      const priorSocketIdentity = socketIdentity;
      const priorOwnerIdentity = ownerIdentity;
      const current = readPath();
      const currentOwner = readOwnerPath();
      if (
        hasFileIdentity(closedDescriptorIdentity)
        && closedDescriptorIdentity.type === 'socket'
        && hasFileIdentity(closedPublicIdentity)
        && closedPublicIdentity.type === 'socket'
        && hasFileIdentity(closedOwnerIdentity)
        && closedOwnerIdentity.type === 'socket'
        && sameFileObjectIdentity(priorSocketIdentity, closedPublicIdentity)
        && sameFileObjectIdentity(priorOwnerIdentity, closedOwnerIdentity)
        && sameFileIdentity(closedDescriptorIdentity, closedPublicIdentity)
        && sameFileIdentity(closedDescriptorIdentity, closedOwnerIdentity)
        && sameFileIdentity(closedPublicIdentity, closedOwnerIdentity)
        && current
        && currentOwner
        && current.isSocket?.()
        && currentOwner.isSocket?.()
        && hasFileIdentity(current)
        && hasFileIdentity(currentOwner)
        && sameFileIdentity(closedPublicIdentity, current)
        && sameFileIdentity(closedOwnerIdentity, currentOwner)
      ) {
        socketIdentity = { ...closedPublicIdentity };
        ownerIdentity = { ...closedOwnerIdentity };
      }
      return;
    }

    if (message?.type === 'error') {
      const error = helperFailureError(
        message.code,
        message.phase,
        message.cleanupArtifacts,
      );
      helperReportedError = error;
      if (message.code === TRANSPORT_PUBLICATION_CLEANUP_UNCERTAIN_CODE) {
        cleanupAuthority = true;
        rememberHelperCleanupArtifacts(message.cleanupArtifacts);
      }
      if (!listenerReady && !closing) {
        const uncertain = message.phase !== 'listen';
        failStartup?.(error, uncertain);
      } else if (!closing) {
        // A runtime helper failure leaves the identity-fenced path for the
        // normal guardian stop/recovery authority; never auto-unlink it from
        // an asynchronous child error.
        log(`[guardian-ipc] listener helper failure: ${message.code || 'unknown'}`);
      }
      return;
    }

    if (listenerReady || startupFailureStarted) {
      destroySocket(handle);
      return;
    }

    if (message?.type === 'ready-candidate') {
      if (pendingReadyPublication) {
        destroySocket(handle);
        return;
      }
      const candidate = { handle, proof: null };
      pendingReadyPublication = candidate;
      void (async () => {
        try {
          const proof = validatePublicationProof(message);
          // This pathname check is only candidate corroboration. The
          // transferred accepted-probe handle and acknowledged helper proof
          // are required before listen() can resolve.
          corroboratePublicationProof(proof);
          const tokenMarker = validatePublicationHandle(message, handle, proof.token);
          await sendHelperMessage({
            type: 'publication-handle-ready',
            publicationToken: proof.token,
          });
          await tokenMarker;
          if (closing || pendingReadyPublication !== candidate) return;
          candidate.proof = proof;
          await sendHelperMessage({
            type: 'accept-ready',
            publicationToken: proof.token,
          });
        } catch (error) {
          if (pendingReadyPublication === candidate) {
            pendingReadyPublication = null;
            destroySocket(handle);
          }
          if (!closing) failStartup?.(error, true);
        }
      })();
      return;
    }

    if (message?.type !== 'ready') return;
    if (readyHandleAcceptanceInProgress) return;
    readyHandleAcceptanceInProgress = true;
    void (async () => {
      const candidate = pendingReadyPublication;
      const handleToAccept = candidate?.handle;
      try {
        const proof = validatePublicationProof(message);
        if (
          !candidate
          || !candidate.proof
          || proof.token !== candidate.proof.token
          || !samePublicationObject(candidate.proof, proof)
        ) {
          throw replacementError();
        }

        // The final helper JSON is not enough. Acknowledging over the held
        // accepted-probe handle makes the helper perform one more actual
        // listener probe and return a commit marker. The commit is only phase
        // one: the parent must corroborate its helper-issued proof against
        // both current pathnames before sending the commit acknowledgement.
        await waitForPublicationHandleLine(
          handleToAccept,
          publicationLine(PUBLICATION_HANDLE_COMMIT, proof.token),
          { sendLine: publicationLine(PUBLICATION_HANDLE_ACCEPT, proof.token) },
        );

        if (closing || pendingReadyPublication !== candidate) return;
        corroboratePublicationProof(proof);

        // The helper re-probes after this parent-side fence and returns a
        // final confirmation on the same retained token. This second bounded
        // exchange closes the proof-to-commit delivery window without using a
        // timing delay or an unbounded wait.
        await waitForPublicationHandleLine(
          handleToAccept,
          publicationLine(PUBLICATION_HANDLE_COMMIT_CONFIRM, proof.token),
          { sendLine: publicationLine(PUBLICATION_HANDLE_COMMIT_ACK, proof.token) },
        );

        if (closing || pendingReadyPublication !== candidate) return;
        corroboratePublicationProof(proof);
        socketIdentity = { ...proof.publicIdentity };
        ownerIdentity = { ...proof.ownerIdentity };
        pendingReadyPublication = null;
        destroySocket(handleToAccept);
        listenerReady = true;
        cleanupAuthority = true;
        if (!closing && activeListen && !activeListen.settled) {
          activeListen.settled = true;
          activeListen.resolve({
            publicIdentity: { ...socketIdentity },
            ownerIdentity: { ...ownerIdentity },
          });
        }
      } catch (error) {
        if (pendingReadyPublication === candidate) {
          pendingReadyPublication = null;
          destroySocket(handleToAccept);
        }
        if (!closing) failStartup?.(error, true);
      } finally {
        readyHandleAcceptanceInProgress = false;
      }
    })();
  };

  const startHelper = (generation) => {
    let child;
    try {
      const helperProcessOptions = listenerHelperProcessOptions();
      child = forkProcess(helperPath, [], {
        env: helperProcessOptions.env,
        execArgv: [],
        execPath: helperProcessOptions.execPath,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      helper = child;
    } catch (error) {
      throw error;
    }

    helperExitPromise = new Promise((resolve) => {
      let settled = false;
      const finish = (info) => {
        if (settled) return;
        settled = true;
        helperExited = true;
        helperExitInfo = info;
        resolve(info);
      };
      child.once('exit', (code, signal) => finish({ code, signal, event: 'exit' }));
      child.once('close', (code, signal) => finish({ code, signal, event: 'close' }));
      if (child.exitCode !== null || child.signalCode !== null) {
        queueMicrotask(() => finish({
          code: child.exitCode,
          signal: child.signalCode,
          event: 'already-exited',
        }));
      }
    });

    const isCurrentHelper = () => generation === activeListenGeneration && helper === child;

    child.on('error', (error) => {
      if (!isCurrentHelper()) return;
      helperReportedError = error;
      if (!listenerReady && !closing) {
        failStartup?.(error, true);
      } else if (!closing) {
        log(`[guardian-ipc] listener helper error: ${error.code || 'unknown'}`);
      }
    });
    child.on('disconnect', () => {
      if (!isCurrentHelper()) return;
      if (!helperExpectedExit && !listenerReady && !closing) {
        failStartup?.(helperFailureError('IPC_CHANNEL_CLOSED', 'ipc'), true);
      }
    });
    child.on('message', (message, handle) => {
      handleHelperMessage(message, handle, child, generation);
    });
    child.on('exit', () => {
      if (!isCurrentHelper()) return;
      if (!listenerReady && !startupFailureStarted && !helperExpectedExit && !closing) {
        failStartup?.(
          helperReportedError || helperFailureError('HELPER_EXITED', 'ipc'),
          true,
        );
      }
    });
  };

  const listen = ({ onRequest } = {}) => {
    if (
      activeListen
      || helper
      || socketIdentity
      || ownerIdentity
      || cleanupAuthority
      || socketQuarantinePath
      || ownerQuarantinePath
    ) {
      return Promise.reject(new Error('createIpcServer: already listening'));
    }

    const generation = ++listenGeneration;
    activeListenGeneration = generation;
    let state;
    const promise = new Promise((resolve, reject) => {
      state = { resolve, reject, settled: false, generation };
    });
    state.promise = promise;
    activeListen = state;
    requestHandler = onRequest;
    cleanupAuthority = true;

    const fail = (error, uncertain) => {
      if (
        generation !== activeListenGeneration
        || activeListen !== state
        || startupFailureStarted
      ) return;
      startupFailureStarted = true;
      if (uncertain) cleanupAuthority = true;
      if (closing) {
        if (!state.settled) {
          state.settled = true;
          state.reject(error);
        }
        return;
      }
      startupCleanupPromise = cleanupStartupFailure(error, uncertain);
      void startupCleanupPromise.then(
        () => {},
        (cleanupError) => {
          if (!state.settled) {
            state.settled = true;
            state.reject(cleanupError);
          }
        },
      ).finally(() => {
        startupCleanupPromise = null;
      });
    };
    failStartup = fail;

    try {
      startHelper(generation);
      void sendHelperMessage({ type: 'listen', socketPath, platform }).catch((error) => fail(error, true));
    } catch (error) {
      fail(error, false);
    }

    promise.finally(() => {
      if (activeListen === state) activeListen = null;
    }).catch(() => {});
    return promise;
  };

  const close = () => {
    if (closePromise) return closePromise;
    if (!cleanupAuthority && !helper && !socketIdentity && !ownerIdentity
      && !socketQuarantinePath && !ownerQuarantinePath) {
      return Promise.resolve();
    }

    // Set this before stopping the helper. Any connection handle already in
    // the parent IPC queue must be destroyed rather than handed to the
    // request layer after close has begun.
    closing = true;
    destroyPendingPublicationHandle();
    if (activeListen && !activeListen.settled) {
      activeListen.settled = true;
      activeListen.reject(listenCancelledError());
    }
    destroyTrackedSockets();

    let pendingClose;
    pendingClose = (async () => {
      try {
        if (startupCleanupPromise) {
          await startupCleanupPromise.catch(() => {});
          if (!cleanupAuthority && !helper && !socketIdentity && !ownerIdentity
            && !socketQuarantinePath && !ownerQuarantinePath) {
            if (closePromise === pendingClose) closePromise = null;
            return;
          }
        }
        await stopHelper();
        // Child-process messages can be queued around the exit event. Drain a
        // couple of parent turns while `closing` remains true so late socket
        // handles are destroyed and cannot repopulate `sockets`.
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
        destroyTrackedSockets();
        sockets.clear();
        if (helperReportedError?.code === TRANSPORT_PUBLICATION_CLEANUP_UNCERTAIN_CODE) {
          retryHelperCleanupArtifacts();
        } else if (socketIdentity || ownerIdentity) removeOwnedSocket();
        else verifyUnknownStartupPath();
        clearState();
        if (closePromise === pendingClose) closePromise = null;
      } catch (error) {
        destroyTrackedSockets();
        sockets.clear();
        throw posixFailure('POSIX guardian socket', error);
      }
    })();
    closePromise = pendingClose;
    pendingClose.catch(() => {
      if (closePromise === pendingClose) closePromise = null;
    });
    return pendingClose;
  };

  return { listen, close };
};

/**
 * Construct a platform-specific IPC server backend.
 *
 * The returned object exposes a transport-agnostic
 * `{ listen({ onRequest }), close() }` surface. `onRequest(socket)` is
 * invoked once per accepted connection with a duplex `net.Socket`-like
 * object whose `on('data')` / `write(line)` work the same on every
 * transport — the JSON-line protocol layer in `GuardianIpcServer` is
 * therefore platform-independent.
 *
 * @param {object} options
 * @param {NodeJS.Platform} options.platform
 * @param {string} [options.socketPath] - POSIX Unix-domain socket path.
 * @param {string} [options.portPath] - Windows discovery-file path.
 * @param {string} [options.username] - Windows-only: current user
 *   for the discovery-file ACL. Required on Windows so the per-user
 *   trust boundary is established before the listener publishes the
 *   port.
 * @param {(message: string) => void} [options.log]
 * @param {string} [options.helperPath] - POSIX test-only helper override.
 * @param {number} [options.helperShutdownTimeoutMs] - POSIX helper shutdown
 *   timeout used by focused boundary tests.
 * @param {Function} [options.forkProcess] - POSIX test seam for helper event
 *   ordering; production callers use the native `fork` implementation.
 */
export function createIpcServer({
  platform = process.platform,
  socketPath,
  portPath,
  username,
  aclInspector,
  reparseChecker,
  log = () => {},
  helperPath,
  helperShutdownTimeoutMs,
  forkProcess,
} = {}) {
  if (platform === 'win32') {
    return createWindowsIpcServer({ portPath, username, aclInspector, reparseChecker, log });
  }

  if (!isPosixPlatform(platform)) {
    throw new Error(`createIpcServer: unsupported platform: ${String(platform)}`);
  }

  return createPosixIpcServer({
    platform,
    socketPath,
    log,
    ...(helperPath ? { helperPath } : {}),
    ...(helperShutdownTimeoutMs !== undefined ? { helperShutdownTimeoutMs } : {}),
    ...(forkProcess ? { forkProcess } : {}),
  });

}

/**
 * Windows backend of `createIpcServer`. Binds loopback TCP on an
 * ephemeral port, atomically publishes a per-user-ACL'd discovery
 * file at `<portPath>` BEFORE resolving `listen()`, and removes the
 * discovery file as the LAST step of `close()`.
 *
 * Ordering invariants (closes F-6):
 *   - `listen()` resolves only after the discovery file is published.
 *   - `close()` removes the discovery file only after the listener
 *     stops accepting; a client observing `portPath` is therefore
 *     guaranteed the listener is up.
 *   - The discovery file is created with O_EXCL and ACL'd to the
 *     current user before identity-fenced hard-link publication.
 *
 * @param {object} options
 * @param {string} options.portPath
 * @param {string} [options.username]
 * @param {(message: string) => void} [options.log]
 */
function createWindowsIpcServer({ portPath, username, aclInspector, reparseChecker, log } = {}) {
  if (typeof portPath !== 'string' || portPath.length === 0) {
    throw new TypeError('createIpcServer: Windows portPath is required');
  }

  let server = null;
  const sockets = new Set();
  let discoveryPublished = false;
  let publishedPort = null;
  let publishedIdentity = null;
  let pendingCleanupArtifacts = null;
  let finalQuarantinePath = null;
  let unknownStartupPath = false;
  let unknownStartupIdentity = null;
  let listenerClosed = false;
  let closePromise = null;

  const captureUnknownStartupPath = () => {
    try {
      const current = fs.lstatSync(portPath);
      unknownStartupPath = true;
      unknownStartupIdentity = snapshotFileIdentity(current);
      return true;
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      unknownStartupPath = true;
      unknownStartupIdentity = null;
      return true;
    }
  };

  const unknownStartupCleanupError = (message, cause) => transportCleanupError(
    'Windows guardian discovery file',
    Object.assign(new Error(message), {
      code: TRANSPORT_PUBLICATION_CLEANUP_UNCERTAIN_CODE,
      ...(cause ? { cause } : {}),
    }),
    { uncertain: true },
  );

  const verifyUnknownStartupPath = () => {
    if (!unknownStartupPath) return;

    let current;
    try {
      current = fs.lstatSync(portPath);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        unknownStartupPath = false;
        unknownStartupIdentity = null;
        return;
      }
      throw unknownStartupCleanupError(
        `Windows guardian discovery path cannot be verified: ${portPath}`,
        error,
      );
    }

    const currentIdentity = snapshotFileIdentity(current);
    if (
      !unknownStartupIdentity
      || !currentIdentity
      || !sameFileIdentity(unknownStartupIdentity, currentIdentity)
    ) {
      throw unknownStartupCleanupError(
        `Windows guardian discovery path was replaced or its identity is unavailable: ${portPath}`,
      );
    }
    throw unknownStartupCleanupError(
      `Windows guardian discovery path remains from before startup: ${portPath}`,
    );
  };

  const listen = ({ onRequest }) => new Promise((resolve, reject) => {
    if (server) {
      reject(new Error('createIpcServer: already listening'));
      return;
    }
    if (unknownStartupPath) {
      reject(unknownStartupCleanupError(
        `Windows guardian discovery path remains from before startup: ${portPath}`,
      ));
      return;
    }

    const onConnection = (socket) => {
      sockets.add(socket);
      socket.on('close', () => {
        sockets.delete(socket);
      });
      socket.on('error', (error) => {
        log(`[guardian-ipc] socket error: ${error.message}`);
        sockets.delete(socket);
      });
      if (typeof onRequest === 'function') {
        onRequest(socket);
      }
    };

    server = net.createServer(onConnection);
    listenerClosed = false;
    closePromise = null;

    server.on('error', (error) => {
      if (error.code === 'EADDRINUSE') {
        reject(new Error(`Guardian IPC TCP port is already in use (EADDRINUSE)`));
        return;
      }
      reject(error);
    });

    server.listen({ host: LOOPBACK_HOST, port: 0 }, () => {
      // Capture the ephemeral port the OS assigned.
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      if (typeof port !== 'number' || port <= 0 || port > 65535) {
        const err = new Error(`createIpcServer: bound to invalid TCP port ${port}`);
        try { server.close(); } catch { /* ignore */ }
        server = null;
        reject(err);
        return;
      }

      // Publish the discovery file BEFORE resolving. If the ACL fails,
      // we tear down the listener and reject; the user sees a clear
      // "icacls failed" error instead of a phantom listener.
      try {
        const identity = writeDiscoveryFileAtomic(portPath, port, {
          platform: 'win32',
          username,
          ...(aclInspector ? { aclInspector } : {}),
          ...(reparseChecker ? { reparseChecker } : {}),
          log,
        });
        if (!hasFileIdentity(identity)) {
          throw new Error('createIpcServer: published discovery identity is unavailable');
        }
        publishedIdentity = identity;
      } catch (publishError) {
        if (publishError?.code === TRANSPORT_PUBLICATION_CLEANUP_UNCERTAIN_CODE) {
          // The listener and the final artifact remain owned by this
          // transport until a later close retry can prove cleanup. Keeping
          // every recorded identity here lets Guardian startup retain its PID
          // marker instead of releasing ownership beside an uncertain
          // artifact, including a persistent temp/lock-only rollback.
          pendingCleanupArtifacts = publishError.cleanupArtifacts || null;
          finalQuarantinePath = pendingCleanupArtifacts?.final?.quarantinePath || null;
          publishedIdentity = hasFileIdentity(publishError.publishedIdentity)
            ? { ...publishError.publishedIdentity }
            : null;
          publishedPort = port;
          discoveryPublished = Boolean(publishedIdentity);
          reject(publishError);
          return;
        }
        const retainedUnknownPath = captureUnknownStartupPath();
        try { server.close(); } catch { /* ignore */ }
        server = null;
        if (retainedUnknownPath) {
          // A final path that existed outside this publication is not ours to
          // remove. Retain transport authority until it disappears so startup
          // rollback cannot release the marker beside a still-blocking path.
          reject(unknownStartupCleanupError(
            `Windows guardian discovery publication left an unknown path: ${portPath}`,
            publishError,
          ));
          return;
        }
        reject(publishError);
        return;
      }
      discoveryPublished = true;
      publishedPort = port;
      log(`[guardian-ipc] listening on 127.0.0.1:${port} (discovery at ${portPath})`);
      resolve();
    });
  });

  const close = () => {
    if (closePromise) return closePromise;
    // No-op if listen() never ran and no published artifact remains.
    if (!server && !discoveryPublished && !pendingCleanupArtifacts && !unknownStartupPath) {
      return Promise.resolve();
    }

    for (const socket of sockets) {
      try {
        socket.end();
        socket.destroy();
      } catch {
        // Ignore.
      }
    }
    sockets.clear();

    const activeServer = server;
    const hadPublished = discoveryPublished;
    const portToRemove = publishedPort;
    const identityToRemove = publishedIdentity;
    closePromise = new Promise((resolve, reject) => {
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        // Keep the transport state until the artifact is either removed or
        // explicitly proven absent/replaced. A later stop can then retry.
        closePromise = null;
        reject(error);
      };

      const removePendingArtifact = (kind) => {
        const entry = pendingCleanupArtifacts?.[kind];
        if (!entry) return;
        if (!hasFileIdentity(entry.identity)) {
          throw transportCleanupError(
            `Windows guardian ${kind} artifact`,
            Object.assign(new Error('pending cleanup identity is unavailable'), {
              code: TRANSPORT_PUBLICATION_CLEANUP_UNCERTAIN_CODE,
            }),
          );
        }

        const removed = removeFileByIdentity(entry.path, entry.identity, {
          label: `Windows guardian ${kind} artifact`,
          platform: 'win32',
           quarantinePath: entry.quarantinePath,
           onQuarantinePath: (value) => { entry.quarantinePath = value; },
           onIdentity: (value) => { entry.identity = value; },
          validateAncestors: () => assertSafeWindowsAncestors(entry.path, {
            username,
            aclInspector,
            reparseChecker,
          }),
          validate: () => assertPrivateRegularFile(entry.path, 0o600, {
            platform: 'win32',
            username,
            aclInspector,
            reparseChecker,
          }),
        });
        void removed;
        delete pendingCleanupArtifacts[kind];
      };

      const assertUnownedArtifactAbsent = (artifactPath, label) => {
        let present = false;
        try {
          fs.lstatSync(artifactPath);
          present = true;
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
        if (present) {
          throw transportCleanupError(
            label,
            Object.assign(new Error(`unowned cleanup artifact remains: ${artifactPath}`), {
              code: TRANSPORT_PUBLICATION_CLEANUP_UNCERTAIN_CODE,
            }),
          );
        }
      };

      const finishCleanup = () => {
        try {
          verifyUnknownStartupPath();
          // Temp and lock entries are publication bookkeeping. Clean them
          // before the final discovery entry so an uncertain bookkeeping
          // cleanup keeps the final owner-visible artifact and marker alive.
          removePendingArtifact('temp');
          removePendingArtifact('lock');
          assertUnownedArtifactAbsent(`${portPath}${WINDOWS_TEMP_SUFFIX}`, 'Windows guardian discovery temp');
          assertUnownedArtifactAbsent(`${portPath}${WINDOWS_LOCK_SUFFIX}`, 'Windows guardian discovery lock');

          const pendingFinal = pendingCleanupArtifacts?.final;
          const finalIdentity = pendingFinal?.identity || identityToRemove;
          if (hadPublished || hasFileIdentity(finalIdentity)) {
            pendingCleanupArtifacts ||= {};
            pendingCleanupArtifacts.final ||= {
              path: portPath,
              identity: finalIdentity,
              quarantinePath: finalQuarantinePath,
            };
            const entry = pendingCleanupArtifacts.final;
            finalQuarantinePath = entry.quarantinePath || null;
            const removed = removeDiscoveryFile(portPath, {
              platform: 'win32',
              username,
              expectedPort: portToRemove,
              expectedContent: typeof portToRemove === 'number'
                ? `127.0.0.1:${portToRemove}\n`
                : undefined,
              expectedIdentity: entry.identity,
              strict: true,
               quarantinePath: finalQuarantinePath,
               onQuarantinePath: (value) => {
                 finalQuarantinePath = value;
                 entry.quarantinePath = value;
               },
               onIdentity: (value) => {
                 entry.identity = value;
                 publishedIdentity = value;
               },
              ...(aclInspector ? { aclInspector } : {}),
              ...(reparseChecker ? { reparseChecker } : {}),
            });
            void removed;
            delete pendingCleanupArtifacts.final;
          }
        } catch (error) {
          if (error?.code === TRANSPORT_CLEANUP_ERROR_CODE
            || (typeof error?.artifact === 'string' && error.artifact.startsWith('Windows guardian '))) {
            fail(error);
            return;
          }
          const isDiscoveryFailure = error?.artifact === 'discovery file'
            || error?.code === 'GUARDIAN_TRANSPORT_ARTIFACT_REPLACED'
            || error?.code === 'GUARDIAN_TRANSPORT_ARTIFACT_CONTENT_MISMATCH';
          fail(transportCleanupError(
            isDiscoveryFailure ? 'Windows guardian discovery file' : 'Windows guardian transport artifacts',
            error,
          ));
          return;
        }

        server = null;
        listenerClosed = false;
        discoveryPublished = false;
        publishedPort = null;
        publishedIdentity = null;
        pendingCleanupArtifacts = null;
        finalQuarantinePath = null;
        unknownStartupPath = false;
        unknownStartupIdentity = null;
        closePromise = null;
        settled = true;
        resolve();
      };

      if (!activeServer || listenerClosed) {
        // Let the close-promise assignment complete before a synchronous
        // cleanup failure clears `closePromise`; retries must not receive the
        // already-rejected promise from this attempt.
        queueMicrotask(finishCleanup);
        return;
      }

      try {
        activeServer.close((error) => {
          if (error) {
            fail(transportCleanupError('Windows guardian listener', error));
            return;
          }
          listenerClosed = true;
          finishCleanup();
        });
      } catch (error) {
        fail(transportCleanupError('Windows guardian listener', error));
      }
    });
    return closePromise;
  };

  return { listen, close };
}

/**
 * Construct a platform-specific IPC dialer handle.
 *
 * Returns a function `dial() => Promise<net.Socket>` that, when called,
 * yields a connected duplex socket. Errors surface at call time so
 * `GuardianClient` can wrap them in its own `GuardianClientError`
 * shape.
 *
 * Construction itself never throws on Windows with a non-existent
 * `portPath`; the missing file is a runtime concern handled by the
 * consumer's connect-time error path.
 *
 * @param {object} options
 * @param {NodeJS.Platform} options.platform
 * @param {string} [options.socketPath]
 * @param {string} [options.portPath]
 */
export function createIpcDialer({
  platform = process.platform,
  socketPath,
  portPath,
  username,
  aclInspector,
  reparseChecker,
} = {}) {
  if (platform === 'win32') {
    return async function dial() {
      if (typeof portPath !== 'string' || portPath.length === 0) {
        throw new Error('createIpcDialer: Windows portPath is required');
      }
      // Throws on missing/unreadable file. Caller (`GuardianClient`)
      // wraps this in its own error shape.
      const parsed = readDiscoveryFile(portPath, {
        platform: 'win32',
        username,
        ...(aclInspector ? { aclInspector } : {}),
        ...(reparseChecker ? { reparseChecker } : {}),
      });
      if (!parsed || typeof parsed.port !== 'number' || !Number.isFinite(parsed.port)) {
        throw new Error(`createIpcDialer: discovery file at ${portPath} is malformed`);
      }
      // Hard-bind to 127.0.0.1 (Design Invariant #6). The discovery
      // file is the only thing that points at the guardian; the
      // resolved `host` is always loopback.
      return net.createConnection({ host: LOOPBACK_HOST, port: parsed.port });
    };
  }

  if (!isPosixPlatform(platform)) {
    throw new Error(`createIpcDialer: unsupported platform: ${String(platform)}`);
  }

  if (typeof socketPath !== 'string' || socketPath.length === 0) {
    throw new TypeError('createIpcDialer: POSIX socketPath is required');
  }

  return function dial() {
    return net.createConnection(socketPath);
  };
}
