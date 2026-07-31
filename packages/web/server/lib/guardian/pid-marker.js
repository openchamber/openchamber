import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import {
  compareProcessIdentity,
  normalizeProcessIdentity,
  probeProcessLiveness,
  readProcessIdentity,
} from './process-identity.js';

const MARKER_VERSION = 1;
const DEFAULT_WAIT_ATTEMPTS = 20;
const DEFAULT_WAIT_MS = 25;

const isPositivePid = (value) => Number.isSafeInteger(value) && value > 0;

const createMarkerToken = () => randomBytes(16).toString('base64url');

const createSingletonError = (message, code) => Object.assign(new Error(message), { code });

/**
 * Read the guardian marker without interpreting an unreadable or partial
 * marker as an absent file. `null` means the path does not exist; every other
 * result describes an existing marker and must be handled conservatively.
 */
export function readGuardianPidMarker(pidFile) {
  let content;
  try {
    content = fs.readFileSync(pidFile, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    return { status: 'unreadable', reason: error?.message || 'marker-read-failed', raw: '' };
  }

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
  if (parsed.version !== MARKER_VERSION || !isPositivePid(pid)) {
    return { status: 'invalid', reason: 'marker-fields-invalid', raw };
  }
  return {
    status: 'valid',
    version: MARKER_VERSION,
    pid,
    token: typeof parsed.token === 'string' && parsed.token.length > 0 ? parsed.token : null,
    identity,
    raw,
  };
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

const unlinkIfStillObserved = (pidFile, observed) => {
  const current = readGuardianPidMarker(pidFile);
  if (!markerIsSame(current, observed)) return false;
  try {
    fs.unlinkSync(pidFile);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    return false;
  }
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

/**
 * Acquire the singleton marker. Existing empty/partial markers are treated as
 * an in-progress writer and are never unlinked merely because they cannot be
 * parsed. Only a marker whose recorded identity is definitely stale may be
 * removed before retrying O_EXCL.
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
    try {
      writeMarker(pidFile, marker);
      return { pidFile, marker, token, owned: true };
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
    if (state.state === 'stale' && unlinkIfStillObserved(pidFile, existing)) {
      continue;
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
  try {
    fs.unlinkSync(ownership.pidFile);
    return true;
  } catch (error) {
    return error?.code === 'ENOENT';
  }
}

export const __test__ = {
  MARKER_VERSION,
  DEFAULT_WAIT_ATTEMPTS,
  DEFAULT_WAIT_MS,
  markerIsSame,
  unlinkIfStillObserved,
  writeMarker,
};
