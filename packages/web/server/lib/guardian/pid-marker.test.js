import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  acquireGuardianPidMarker,
  inspectGuardianPidMarker,
  readGuardianPidMarker,
  releaseGuardianPidMarker,
} from './pid-marker.js';

const identity = {
  processStartTicks: '123',
  launch: { commandLine: 'node openchamber-guardian.js --data-dir /tmp/data', cwd: '/tmp/data' },
  owner: '1000',
};

const roots = [];

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

const makeMarkerPath = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-pid-marker-'));
  roots.push(root);
  return path.join(root, 'guardian.pid');
};

describe('guardian PID marker ownership', () => {
  it('writes a durable identity marker and only releases its own token', async () => {
    const pidFile = makeMarkerPath();
    const owner = await acquireGuardianPidMarker({ pidFile, pid: 1234, identity });
    expect(readGuardianPidMarker(pidFile)).toMatchObject({
      status: 'valid',
      pid: 1234,
      identity,
    });
    expect(inspectGuardianPidMarker(readGuardianPidMarker(pidFile), {
      readIdentity: () => identity,
      liveness: () => 'alive',
    })).toEqual({ state: 'alive' });

    expect(releaseGuardianPidMarker({ ...owner, token: 'different-token' })).toBe(false);
    expect(fs.existsSync(pidFile)).toBe(true);
    expect(releaseGuardianPidMarker(owner)).toBe(true);
    expect(readGuardianPidMarker(pidFile)).toBeNull();
  });

  it('waits and fails closed for an empty in-progress O_EXCL marker', async () => {
    const pidFile = makeMarkerPath();
    fs.writeFileSync(pidFile, '');

    await expect(acquireGuardianPidMarker({
      pidFile,
      pid: 1235,
      identity,
      liveness: () => 'alive',
      waitAttempts: 1,
      sleep: async () => {},
    })).rejects.toMatchObject({ code: 'GUARDIAN_PID_MARKER_UNCERTAIN' });
    expect(fs.readFileSync(pidFile, 'utf8')).toBe('');
  });

  it('cleans only a marker whose recorded process is definitely stale', async () => {
    const pidFile = makeMarkerPath();
    const stale = await acquireGuardianPidMarker({ pidFile, pid: 1236, identity });
    expect(stale.owned).toBe(true);

    const next = await acquireGuardianPidMarker({
      pidFile,
      pid: 1237,
      identity: { ...identity, processStartTicks: '456' },
      liveness: () => 'dead',
      waitAttempts: 1,
    });
    expect(readGuardianPidMarker(pidFile)).toMatchObject({ pid: 1237, status: 'valid' });
    releaseGuardianPidMarker(next);
  });

  it('serializes concurrent acquisition and leaves the winner marker intact', async () => {
    const pidFile = makeMarkerPath();
    const first = acquireGuardianPidMarker({ pidFile, pid: 1238, identity });
    const second = acquireGuardianPidMarker({
      pidFile,
      pid: 1239,
      identity,
      liveness: () => 'alive',
      readIdentity: () => identity,
      waitAttempts: 0,
    });
    const results = await Promise.allSettled([first, second]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')?.reason)
      .toMatchObject({ code: 'GUARDIAN_ALREADY_RUNNING' });
    const winner = results.find((result) => result.status === 'fulfilled')?.value;
    expect(readGuardianPidMarker(pidFile)?.token).toBe(winner.marker.token);
    releaseGuardianPidMarker(winner);
  });
});
