import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import {
  compareProcessIdentity,
  normalizeProcessIdentity,
  probeProcessLiveness,
  readProcessIdentity,
} from './process-identity.js';
import { removeFileByIdentity } from './discovery-file.js';
import { fsyncDirectory } from '../opencode/managed-opencode-handoff-v2/filesystem.js';
import {
  hasFileIdentity,
  sameFileIdentity,
  sameFileObjectIdentity,
  snapshotFileIdentity,
} from './file-identity.js';

const MARKER_VERSION = 1;
const DEFAULT_WAIT_ATTEMPTS = 20;
const DEFAULT_WAIT_MS = 25;
const RECOVERY_LEASE_SUFFIX = '.recovery.lock';
const MARKER_TEMP_SUFFIX = '.tmp';

const isPositivePid = (value) => Number.isSafeInteger(value) && value > 0;

const createMarkerToken = () => randomBytes(16).toString('base64url');

const createSingletonError = (message, code) => Object.assign(new Error(message), { code });

const normalizeTransportIdentity = (value) => {
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

/**
 * Read the guardian marker without interpreting an unreadable or partial
 * marker as an absent file. `null` means the path does not exist; every other
 * result describes an existing marker and must be handled conservatively.
 */
const parseGuardianPidMarker = (content) => {
  const raw = String(content);
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { status: 'in-progress', reason: 'marker-is-empty', raw };
  }

  // Older installations wrote only the PID. It remains readable for status,
  // but it has no identity and therefore can never authorize a fallback
  // signal or an ownership-unsafe cleanup while its PID is live.
  if (/^\d+$/.test(trimmed)) {
    const pid = Number.parseInt(trimmed, 10);
    return isPositivePid(pid)
      ? { status: 'legacy', pid, token: null, identity: null, raw }
      : { status: 'invalid', reason: 'invalid-pid', raw };
  }

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { status: 'invalid', reason: 'marker-json-invalid', raw };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { status: 'invalid', reason: 'marker-shape-invalid', raw };
  }

  const pid = Number.isSafeInteger(parsed.pid) ? parsed.pid : Number.parseInt(String(parsed.pid ?? ''), 10);
  const identity = normalizeProcessIdentity(parsed.identity ?? {
    processStartTicks: parsed.processStartTicks,
    launch: parsed.launch ?? {
      commandLine: parsed.commandLine,
      cwd: parsed.cwd,
    },
    owner: parsed.owner,
  });
  const transportIdentity = normalizeTransportIdentity(parsed.transportIdentity);
  if (parsed.version !== MARKER_VERSION || !isPositivePid(pid)) {
    return { status: 'invalid', reason: 'marker-fields-invalid', raw };
  }
  return {
    status: 'valid',
    version: MARKER_VERSION,
    pid,
    token: typeof parsed.token === 'string' && parsed.token.length > 0 ? parsed.token : null,
    identity,
    // Optional for backward compatibility. A marker without this field is
    // still readable, but cannot authorize POSIX transport cleanup.
    transportIdentity,
    raw,
  };
};

export function readGuardianPidMarker(pidFile) {
  let content;
  try {
    content = fs.readFileSync(pidFile, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    return { status: 'unreadable', reason: error?.message || 'marker-read-failed', raw: '' };
  }

  return parseGuardianPidMarker(content);
}

const markerIsSame = (left, right) => {
  if (!left || !right || left.status !== right.status || left.pid !== right.pid) return false;
  if (left.status === 'valid') return left.token !== null && left.token === right.token;
  return left.raw === right.raw;
};

/**
 * Inspect whether a marker's recorded process is the same live process, a
 * definitely stale process, or an ambiguous existing marker.
 */
export function inspectGuardianPidMarker(marker, {
  readIdentity = readProcessIdentity,
  liveness = probeProcessLiveness,
} = {}) {
  if (!marker) return { state: 'absent' };
  if (marker.status !== 'valid' && marker.status !== 'legacy') {
    return { state: 'unknown', reason: marker.reason || 'marker-identity-unavailable' };
  }

  let liveState;
  try {
    liveState = liveness(marker.pid);
  } catch {
    liveState = 'unknown';
  }
  if (liveState === 'dead') return { state: 'stale', reason: 'recorded process is dead' };
  if (liveState !== 'alive') return { state: 'unknown', reason: 'process liveness is ambiguous' };
  if (!marker.identity) return { state: 'unknown', reason: 'persisted process identity is missing' };

  let actual;
  try {
    actual = readIdentity(marker.pid);
  } catch {
    actual = null;
  }
  if (!actual) return { state: 'unknown', reason: 'live process identity is unavailable' };
  const mismatch = compareProcessIdentity(marker.identity, actual);
  if (mismatch) return { state: 'stale', reason: mismatch };
  return { state: 'alive' };
}

const unlinkIfStillObserved = (pidFile, observed, expectedFileIdentity = null) => {
  let observedPathIdentity;
  try {
    observedPathIdentity = snapshotFileIdentity(fs.lstatSync(pidFile));
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    return false;
  }
  if (!observedPathIdentity || observedPathIdentity.type !== 'file') return false;

  const current = readGuardianPidMarker(pidFile);
  if (!markerIsSame(current, observed)) return false;

  let currentFileIdentity;
  try {
    currentFileIdentity = snapshotFileIdentity(fs.lstatSync(pidFile));
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    return false;
  }
  if (
    !currentFileIdentity
    || currentFileIdentity.type !== 'file'
    || !sameFileIdentity(observedPathIdentity, currentFileIdentity)
    || (expectedFileIdentity && !sameFileIdentity(expectedFileIdentity, observedPathIdentity))
  ) return false;

  try {
    const result = removeFileByIdentity(pidFile, observedPathIdentity, {
      label: 'guardian PID marker',
      expectedType: 'file',
      returnResult: true,
    });
    return result?.status === 'removed' || result?.status === 'absent';
  } catch {
    // A replacement or an incomplete quarantine must retain marker ownership.
    return false;
  }
};

const recoveryLeasePathFor = (pidFile) => `${pidFile}${RECOVERY_LEASE_SUFFIX}`;

const canRecoverRecoveryLease = (lease, { readIdentity, liveness } = {}) => {
  const state = inspectGuardianPidMarker(lease, { readIdentity, liveness });
  return lease?.status === 'valid'
    && typeof lease.token === 'string'
    && lease.token.length > 0
    && Boolean(lease.identity?.processStartTicks)
    && Boolean(lease.identity?.launch?.commandLine)
    && state.state === 'stale'
    && state.reason === 'recorded process is dead';
};

const recoveryLeaseBlocksAcquisition = ({ pidFile, readIdentity, liveness } = {}) => {
  const leasePath = recoveryLeasePathFor(pidFile);
  const existing = readGuardianPidMarker(leasePath);
  if (!existing) return false;
  if (canRecoverRecoveryLease(existing, { readIdentity, liveness })) {
    unlinkIfStillObserved(leasePath, existing);
    return readGuardianPidMarker(leasePath) !== null;
  }
  return true;
};

const acquireRecoveryLease = ({
  pidFile,
  pid,
  identity,
  readIdentity,
  liveness,
}) => {
  const leasePath = recoveryLeasePathFor(pidFile);
  const lease = {
    version: MARKER_VERSION,
    pid,
    token: createMarkerToken(),
    identity,
  };

  try {
    writeMarker(leasePath, lease);
    return { path: leasePath, marker: lease };
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }

  // A crashed starter must not leave recovery disabled forever. The lease is
  // itself an identity marker, so it may be reclaimed only after the lease
  // holder is independently proven stale. Partial or ambiguous leases remain
  // blockers just like partial or ambiguous guardian markers.
  const existing = readGuardianPidMarker(leasePath);
  if (canRecoverRecoveryLease(existing, { readIdentity, liveness })) {
    unlinkIfStillObserved(leasePath, existing);
  }
  return null;
};

const releaseRecoveryLease = (lease) => {
  if (!lease?.path || !lease.marker?.token) return false;
  return unlinkIfStillObserved(lease.path, {
    status: 'valid',
    pid: lease.marker.pid,
    token: lease.marker.token,
    identity: lease.marker.identity,
  });
};

const writeMarker = (pidFile, marker) => {
  const directory = path.dirname(pidFile);
  fs.mkdirSync(directory, { recursive: true });
  let descriptor;
  let created = false;
  try {
    descriptor = fs.openSync(pidFile, 'wx', 0o600);
    created = true;
    fs.writeFileSync(descriptor, JSON.stringify(marker), 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    if (process.platform !== 'win32') fs.chmodSync(pidFile, 0o600);
    return true;
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* ignore */ }
    }
    if (created) {
      try { fs.unlinkSync(pidFile); } catch { /* ignore */ }
    }
    throw error;
  }
};

const openMarkerReadWrite = (pidFile) => {
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  try {
    return fs.openSync(pidFile, fs.constants.O_RDWR | noFollow);
  } catch (error) {
    if (error?.code !== 'EINVAL' || noFollow === 0) throw error;
    return fs.openSync(pidFile, fs.constants.O_RDWR);
  }
};

const readMarkerFromDescriptor = (descriptor) => {
  const initialStat = fs.fstatSync(descriptor);
  if (!Number.isSafeInteger(initialStat.size) || initialStat.size < 0) {
    throw createSingletonError(
      'Guardian PID marker size is unavailable',
      'GUARDIAN_PID_MARKER_OWNERSHIP_LOST',
    );
  }

  const content = Buffer.alloc(initialStat.size);
  let offset = 0;
  while (offset < content.length) {
    const read = fs.readSync(descriptor, content, offset, content.length - offset, offset);
    if (!Number.isSafeInteger(read) || read <= 0) break;
    offset += read;
  }

  const finalStat = fs.fstatSync(descriptor);
  if (offset !== content.length || finalStat.size !== initialStat.size) {
    throw createSingletonError(
      'Guardian PID marker changed while it was being read',
      'GUARDIAN_PID_MARKER_OWNERSHIP_LOST',
    );
  }
  return parseGuardianPidMarker(content.toString('utf8'));
};

const markerTemporaryPathFor = (pidFile) => path.join(
  path.dirname(pidFile),
  `.${path.basename(pidFile)}.${process.pid}.${randomBytes(16).toString('hex')}${MARKER_TEMP_SUFFIX}`,
);

const writeMarkerReplacement = (temporaryPath, marker, { onIdentity } = {}) => {
  let descriptor;
  let identity;
  const content = Buffer.from(JSON.stringify(marker), 'utf8');
  try {
    descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
    identity = snapshotFileIdentity(fs.fstatSync(descriptor));
    if (!identity || identity.type !== 'file') {
      throw createSingletonError(
        'Guardian PID marker temporary file identity is unavailable',
        'GUARDIAN_PID_MARKER_UPDATE_UNCERTAIN',
      );
    }
    onIdentity?.(identity);
    if (process.platform !== 'win32') fs.fchmodSync(descriptor, 0o600);
    identity = snapshotFileIdentity(fs.fstatSync(descriptor));
    if (!identity || identity.type !== 'file') {
      throw createSingletonError(
        'Guardian PID marker temporary file identity is unavailable',
        'GUARDIAN_PID_MARKER_UPDATE_UNCERTAIN',
      );
    }
    onIdentity?.(identity);

    let offset = 0;
    while (offset < content.length) {
      const written = fs.writeSync(
        descriptor,
        content,
        offset,
        content.length - offset,
        offset,
      );
      if (!Number.isSafeInteger(written) || written <= 0) {
        throw createSingletonError(
          'Guardian PID marker transport publication was incomplete',
          'GUARDIAN_PID_MARKER_UPDATE_UNCERTAIN',
        );
      }
      offset += written;
    }
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;

    const observed = fs.lstatSync(temporaryPath);
    const observedIdentity = snapshotFileIdentity(observed);
    if (
      !observedIdentity
      || observedIdentity.type !== 'file'
      || !sameFileIdentity(identity, observedIdentity)
      || observed.size !== content.length
    ) {
      throw createSingletonError(
        'Guardian PID marker temporary file changed before publication',
        'GUARDIAN_PID_MARKER_UPDATE_UNCERTAIN',
      );
    }
    return observedIdentity;
  } finally {
    content.fill(0);
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* preserve the primary error */ }
    }
  }
};

const markerTransportIdentityMatches = (left, right) => {
  const leftNormalized = normalizeTransportIdentity(left);
  const rightNormalized = normalizeTransportIdentity(right);
  return Boolean(
    leftNormalized
    && rightNormalized
    && sameFileIdentity(leftNormalized.publicIdentity, rightNormalized.publicIdentity)
    && sameFileIdentity(leftNormalized.ownerIdentity, rightNormalized.ownerIdentity),
  );
};

/**
 * Attach the verified transport identity to this process's marker through an
 * fsynced same-directory replacement. The old marker is never truncated, and
 * the owner identity is advanced only after the replacement pathname and
 * contents have been verified.
 */
const updateGuardianPidMarker = (ownership, { transportIdentity } = {}) => {
  if (!ownership?.pidFile || typeof ownership.token !== 'string' || ownership.token.length === 0) {
    throw createSingletonError(
      'Guardian PID marker ownership is unavailable',
      'GUARDIAN_PID_MARKER_OWNERSHIP_UNAVAILABLE',
    );
  }

  const normalizedTransportIdentity = normalizeTransportIdentity(transportIdentity);
  if (!normalizedTransportIdentity) {
    throw createSingletonError(
      'Verified POSIX guardian transport identity is unavailable',
      'GUARDIAN_PID_TRANSPORT_IDENTITY_UNAVAILABLE',
    );
  }

  const pidFile = ownership.pidFile;
  const directory = path.dirname(pidFile);
  let descriptor;
  let temporaryPath;
  let temporaryIdentity;
  let temporaryQuarantinePath;
  let published = false;
  let committed;
  let operationError = null;

  const updateUncertainError = (cause) => {
    const error = createSingletonError(
      `Guardian PID marker transport publication is uncertain${cause?.message ? `: ${cause.message}` : ''}`,
      'GUARDIAN_PID_MARKER_UPDATE_UNCERTAIN',
    );
    error.cause = cause;
    if (temporaryPath) error.temporaryPath = temporaryPath;
    if (temporaryQuarantinePath) error.temporaryQuarantinePath = temporaryQuarantinePath;
    return error;
  };

  const verifyPublishedMarker = (expectedIdentity, expectedMarker) => {
    let firstPathIdentity;
    try {
      firstPathIdentity = snapshotFileIdentity(fs.lstatSync(pidFile));
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw createSingletonError(
          'Guardian PID marker disappeared during transport publication',
          'GUARDIAN_PID_MARKER_UPDATE_UNCERTAIN',
        );
      }
      throw error;
    }
    if (
      !firstPathIdentity
      || firstPathIdentity.type !== 'file'
      || !sameFileObjectIdentity(expectedIdentity, firstPathIdentity)
    ) {
      throw createSingletonError(
        'Guardian PID marker changed during transport publication',
        'GUARDIAN_PID_MARKER_OWNERSHIP_LOST',
      );
    }

    const content = fs.readFileSync(pidFile, 'utf8');
    const parsed = parseGuardianPidMarker(content);
    const expectedContent = JSON.stringify(expectedMarker);
    let finalPathIdentity;
    try {
      finalPathIdentity = snapshotFileIdentity(fs.lstatSync(pidFile));
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw createSingletonError(
          'Guardian PID marker disappeared during transport publication',
          'GUARDIAN_PID_MARKER_UPDATE_UNCERTAIN',
        );
      }
      throw error;
    }
    if (
      content !== expectedContent
      || !finalPathIdentity
      || !sameFileObjectIdentity(firstPathIdentity, finalPathIdentity)
      || !sameFileObjectIdentity(expectedIdentity, finalPathIdentity)
      || parsed?.status !== 'valid'
      || parsed.pid !== expectedMarker.pid
      || parsed.token !== expectedMarker.token
      || !markerTransportIdentityMatches(parsed.transportIdentity, expectedMarker.transportIdentity)
    ) {
      throw createSingletonError(
        'Guardian PID marker transport publication could not be verified',
        'GUARDIAN_PID_MARKER_UPDATE_UNCERTAIN',
      );
    }
    return { marker: parsed, identity: finalPathIdentity };
  };

  const revalidateCurrentMarker = (expectedIdentity, expectedMarker) => {
    const currentPathIdentity = snapshotFileIdentity(fs.lstatSync(pidFile));
    const current = readGuardianPidMarker(pidFile);
    if (
      !currentPathIdentity
      || currentPathIdentity.type !== 'file'
      || !sameFileIdentity(expectedIdentity, currentPathIdentity)
      || current?.status !== 'valid'
      || current.pid !== expectedMarker.pid
      || current.token !== expectedMarker.token
    ) {
      throw createSingletonError(
        'Guardian PID marker changed during transport publication',
        'GUARDIAN_PID_MARKER_OWNERSHIP_LOST',
      );
    }
  };

  const cleanupTemporary = () => {
    if (!temporaryPath || !temporaryIdentity) return null;
    let result;
    try {
      result = removeFileByIdentity(temporaryPath, temporaryIdentity, {
        label: 'guardian PID marker temporary file',
        returnResult: true,
        quarantinePath: temporaryQuarantinePath,
        onQuarantinePath: (value) => { temporaryQuarantinePath = value; },
        onIdentity: (value) => { temporaryIdentity = value; },
      });
    } catch (error) {
      return error;
    }
    if (result.status === 'removed' || result.status === 'absent') {
      temporaryPath = undefined;
      temporaryIdentity = undefined;
      temporaryQuarantinePath = undefined;
      return null;
    }
    return result.error || new Error('Guardian PID marker temporary cleanup is uncertain');
  };

  try {
    descriptor = openMarkerReadWrite(pidFile);
    const openedIdentity = snapshotFileIdentity(fs.fstatSync(descriptor));
    const currentPathStat = fs.lstatSync(pidFile);
    if (
      !openedIdentity
      || openedIdentity.type !== 'file'
      || !hasFileIdentity(currentPathStat)
      || !sameFileIdentity(openedIdentity, currentPathStat)
      || (ownership.markerFileIdentity
        && !sameFileIdentity(ownership.markerFileIdentity, openedIdentity))
    ) {
      throw createSingletonError(
        'Guardian PID marker identity changed; refusing transport publication',
        'GUARDIAN_PID_MARKER_OWNERSHIP_LOST',
      );
    }

    const current = readMarkerFromDescriptor(descriptor);
    if (
      current?.status !== 'valid'
      || current.pid !== ownership.marker?.pid
      || current.token !== ownership.token
    ) {
      throw createSingletonError(
        'Guardian PID marker token changed; refusing transport publication',
        'GUARDIAN_PID_MARKER_OWNERSHIP_LOST',
      );
    }

    const nextMarker = {
      version: MARKER_VERSION,
      pid: current.pid,
      token: current.token,
      identity: current.identity,
      transportIdentity: normalizedTransportIdentity,
    };
    temporaryPath = markerTemporaryPathFor(pidFile);
    temporaryIdentity = writeMarkerReplacement(temporaryPath, nextMarker, {
      onIdentity: (value) => { temporaryIdentity = value; },
    });

    // The old descriptor protects the identity used for the initial read. Do
    // not publish over a path that changed while the replacement was written.
    revalidateCurrentMarker(openedIdentity, current);
    fs.closeSync(descriptor);
    descriptor = undefined;
    revalidateCurrentMarker(openedIdentity, current);

    try {
      fs.renameSync(temporaryPath, pidFile);
      published = true;
    } catch (error) {
      operationError = error;
    }

    // A synchronous rename can be reported as failed after the filesystem has
    // already committed it (for example, an injected crash-equivalent seam).
    // Verify the pathname before deciding whether the old marker survived.
    try {
      verifyPublishedMarker(temporaryIdentity, nextMarker);
      published = true;
      fsyncDirectory(directory, { platform: process.platform });
      committed = verifyPublishedMarker(temporaryIdentity, nextMarker);
      operationError = null;
    } catch (error) {
      if (!operationError) operationError = error;
      if (published) {
        // The replacement pathname is now authoritative, but its durability
        // or post-rename verification is uncertain. Keep the in-memory owner
        // pointed at the valid replacement so a caller can release it safely;
        // the error still blocks startup until the uncertainty is resolved.
        try {
          committed = verifyPublishedMarker(temporaryIdentity, nextMarker);
        } catch {
          committed = undefined;
        }
      }
    }
  } catch (error) {
    operationError = error;
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* preserve the primary error */ }
    }
  }

  const cleanupError = published ? null : cleanupTemporary();
  if (committed) {
    ownership.marker = committed.marker;
    ownership.markerFileIdentity = committed.identity;
  }
  if (cleanupError) {
    throw updateUncertainError(operationError || cleanupError);
  }
  if (committed && operationError) {
    throw updateUncertainError(operationError);
  }
  if (operationError) throw operationError;
  if (!committed) {
    throw updateUncertainError(new Error('Guardian PID marker replacement was not committed'));
  }
  return ownership;
};

export function updateGuardianPidMarkerTransportIdentity(ownership, transportIdentity) {
  return updateGuardianPidMarker(ownership, { transportIdentity });
}

/**
 * Acquire the singleton marker. Existing empty/partial markers are treated as
 * an in-progress writer and are never unlinked merely because they cannot be
 * parsed. Only a complete marker whose recorded process is definitely dead
 * may be removed before retrying O_EXCL. A live process with a changed
 * identity is ambiguous and remains an ownership blocker.
 */
export async function acquireGuardianPidMarker({
  pidFile,
  pid = process.pid,
  identity = readProcessIdentity(pid),
  token = createMarkerToken(),
  readIdentity = readProcessIdentity,
  liveness = probeProcessLiveness,
  waitAttempts = DEFAULT_WAIT_ATTEMPTS,
  waitMs = DEFAULT_WAIT_MS,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  requireIdentity = false,
  onVerifiedStale,
} = {}) {
  if (typeof pidFile !== 'string' || pidFile.length === 0) {
    throw new TypeError('Guardian PID marker path is required');
  }
  if (!isPositivePid(pid)) throw new TypeError('Guardian PID marker requires a positive pid');
  const normalizedIdentity = normalizeProcessIdentity(identity);
  if (requireIdentity && (!normalizedIdentity?.processStartTicks || !normalizedIdentity?.launch?.commandLine)) {
    throw createSingletonError(
      'Guardian process identity is unavailable; refusing to create an unsafe PID marker',
      'GUARDIAN_PID_IDENTITY_UNAVAILABLE',
    );
  }

  const marker = {
    version: MARKER_VERSION,
    pid,
    token,
    identity: normalizedIdentity,
  };
  const maxAttempts = Number.isSafeInteger(waitAttempts) && waitAttempts >= 0
    ? waitAttempts
    : DEFAULT_WAIT_ATTEMPTS;

  for (let attempt = 0; attempt <= maxAttempts; attempt += 1) {
    // A recovery holder can briefly have the marker path absent while it
    // replaces the stale marker. Observe the cross-process lease before
    // trying O_EXCL so a loser cannot publish into that gap.
    if (recoveryLeaseBlocksAcquisition({ pidFile, readIdentity, liveness })) {
      if (attempt >= maxAttempts) {
        throw createSingletonError(
          'Guardian PID marker recovery is already owned by another starter',
          'GUARDIAN_PID_MARKER_UNCERTAIN',
        );
      }
      await sleep(waitMs);
      continue;
    }

    try {
      writeMarker(pidFile, marker);
      return {
        pidFile,
        marker,
        token,
        owned: true,
        markerFileIdentity: snapshotFileIdentity(fs.lstatSync(pidFile)),
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }

    const existing = readGuardianPidMarker(pidFile);
    const state = inspectGuardianPidMarker(existing, { readIdentity, liveness });
    if (state.state === 'alive') {
      throw createSingletonError(
        `Guardian is already running (pid ${existing.pid})`,
        'GUARDIAN_ALREADY_RUNNING',
      );
    }
    const canRecoverStaleMarker = existing?.status === 'valid'
      && typeof existing.token === 'string'
      && existing.token.length > 0
      && Boolean(existing.identity?.processStartTicks)
      && Boolean(existing.identity?.launch?.commandLine)
      && state.state === 'stale'
      && state.reason === 'recorded process is dead';
    if (canRecoverStaleMarker) {
      // Recovery cleanup may unlink a socket/discovery path. A second starter
      // can observe the same stale marker while the first is doing that work,
      // so serialize this section across processes. The lease is held until
      // the winner has published its replacement marker; otherwise a loser
      // could clean the new guardian's transport after the path is reused.
      const recoveryLease = acquireRecoveryLease({
        pidFile,
        pid,
        identity: normalizedIdentity,
        readIdentity,
        liveness,
      });
      if (recoveryLease) {
        try {
          const current = readGuardianPidMarker(pidFile);
          const currentState = inspectGuardianPidMarker(current, { readIdentity, liveness });
          if (markerIsSame(current, existing)
            && currentState.state === 'stale'
            && currentState.reason === 'recorded process is dead') {
            if (typeof onVerifiedStale === 'function') {
              await onVerifiedStale({ marker: existing, state });
            }
            if (unlinkIfStillObserved(pidFile, existing)) {
              writeMarker(pidFile, marker);
              return {
                pidFile,
                marker,
                token,
                owned: true,
                markerFileIdentity: snapshotFileIdentity(fs.lstatSync(pidFile)),
              };
            }
          }
        } finally {
          releaseRecoveryLease(recoveryLease);
        }
        // The marker or its identity changed while the lease was acquired.
        // Re-enter the normal acquisition path instead of touching transport
        // state that may now belong to another guardian.
        continue;
      }
    }

    if (attempt >= maxAttempts) {
      throw createSingletonError(
        `Guardian PID marker is unresolved (${state.reason || 'identity unavailable'}); refusing to start`,
        'GUARDIAN_PID_MARKER_UNCERTAIN',
      );
    }
    await sleep(waitMs);
  }

  throw createSingletonError('Guardian PID marker acquisition failed', 'GUARDIAN_PID_MARKER_UNCERTAIN');
}

/** Remove only a marker acquired by this process and ownership token. */
export function releaseGuardianPidMarker(ownership) {
  if (!ownership?.pidFile || !ownership?.token) return false;
  const current = readGuardianPidMarker(ownership.pidFile);
  if (current?.status !== 'valid' || current.token !== ownership.token) return false;
  return unlinkIfStillObserved(ownership.pidFile, current, ownership.markerFileIdentity);
}

export const __test__ = {
  MARKER_VERSION,
  DEFAULT_WAIT_ATTEMPTS,
  DEFAULT_WAIT_MS,
  markerIsSame,
  unlinkIfStillObserved,
  recoveryLeasePathFor,
  acquireRecoveryLease,
  releaseRecoveryLease,
  writeMarker,
  normalizeTransportIdentity,
};
