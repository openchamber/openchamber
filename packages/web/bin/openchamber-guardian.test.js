import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  shouldReleaseGuardianMarkerAfterStartupFailure,
  shouldRetainGuardianAuthority,
} from './openchamber-guardian.js';
import {
  acquireGuardianPidMarker,
  readGuardianPidMarker,
  releaseGuardianPidMarker,
} from '../server/lib/guardian/pid-marker.js';

let root;
let markerOwnership;

afterEach(() => {
  if (markerOwnership) releaseGuardianPidMarker(markerOwnership);
  markerOwnership = null;
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = undefined;
});

const acquireMarker = async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-guardian-entrypoint-'));
  const pidFile = path.join(root, 'guardian.pid');
  markerOwnership = await acquireGuardianPidMarker({
    pidFile,
    pid: process.pid,
    identity: {
      processStartTicks: '123',
      launch: { commandLine: 'node openchamber-guardian.test.js', cwd: root },
    },
    requireIdentity: true,
  });
  return pidFile;
};

describe('openchamber-guardian startup rollback control flow', () => {
  it('releases a marker after a cleanup-uncertain operation has settled rollback', async () => {
    const pidFile = await acquireMarker();
    const error = Object.assign(new Error('startup operation failed'), {
      code: 'GUARDIAN_CLEANUP_UNCERTAIN',
      cleanupSettled: true,
    });

    expect(shouldRetainGuardianAuthority({}, error)).toBe(false);
    expect(releaseGuardianPidMarker(markerOwnership)).toBe(true);
    markerOwnership = null;
    expect(readGuardianPidMarker(pidFile)).toBeNull();
  });

  it('retains marker authority while cleanup remains unresolved', async () => {
    const pidFile = await acquireMarker();
    const error = Object.assign(new Error('transport cleanup is unresolved'), {
      code: 'GUARDIAN_TRANSPORT_CLEANUP_UNCERTAIN',
    });

    expect(shouldRetainGuardianAuthority({}, error)).toBe(true);
    expect(readGuardianPidMarker(pidFile)).toMatchObject({
      status: 'valid',
      token: markerOwnership.token,
    });
  });

  it('does not release a marker for an unclassified failure after guardian construction', async () => {
    const pidFile = await acquireMarker();
    const error = new Error('unexpected parent-side failure');

    expect(shouldReleaseGuardianMarkerAfterStartupFailure({}, error)).toBe(false);
    expect(readGuardianPidMarker(pidFile)).toMatchObject({
      status: 'valid',
      token: markerOwnership.token,
    });
  });

  it('allows marker release only for verified startup rollback', async () => {
    const pidFile = await acquireMarker();
    const error = Object.assign(new Error('startup rollback completed'), {
      cleanupSettled: true,
    });

    expect(shouldReleaseGuardianMarkerAfterStartupFailure({}, error)).toBe(true);
    expect(releaseGuardianPidMarker(markerOwnership)).toBe(true);
    markerOwnership = null;
    expect(readGuardianPidMarker(pidFile)).toBeNull();
  });
});
