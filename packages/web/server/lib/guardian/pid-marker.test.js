import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  acquireGuardianPidMarker,
  inspectGuardianPidMarker,
  readGuardianPidMarker,
  releaseGuardianPidMarker,
  updateGuardianPidMarkerTransportIdentity,
  __test__ as pidMarkerTest,
} from './pid-marker.js';
import { recoverStaleGuardianTransportArtifacts } from './ipc-transport.js';

const identity = {
  processStartTicks: '123',
  launch: { commandLine: 'node openchamber-guardian.js --data-dir /tmp/data', cwd: '/tmp/data' },
  owner: '1000',
};

const transportIdentity = {
  publicIdentity: {
    dev: '1',
    ino: '2',
    type: 'socket',
    birthtime: 'ms:3',
    ctime: 'ms:4',
  },
  ownerIdentity: {
    dev: '1',
    ino: '2',
    type: 'socket',
    birthtime: 'ms:3',
    ctime: 'ms:4',
  },
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

  it('retains a replacement inserted during identity-fenced marker release', async () => {
    const pidFile = makeMarkerPath();
    const owner = await acquireGuardianPidMarker({ pidFile, pid: 1234, identity });
    const replacement = JSON.stringify({
      version: 1,
      pid: 9997,
      token: 'replacement-during-release',
      identity,
    });
    const realRenameSync = fs.renameSync.bind(fs);
    let replaced = false;
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation((source, destination, ...args) => {
      if (source === pidFile && !replaced) {
        replaced = true;
        fs.unlinkSync(pidFile);
        fs.writeFileSync(pidFile, replacement, 'utf8');
      }
      return realRenameSync(source, destination, ...args);
    });

    try {
      expect(releaseGuardianPidMarker(owner)).toBe(false);
    } finally {
      renameSpy.mockRestore();
    }

    expect(readGuardianPidMarker(pidFile)).toMatchObject({
      status: 'valid',
      pid: 9997,
      token: 'replacement-during-release',
    });
  });

  it('retains a replacement inserted during recovery-lease release', async () => {
    const pidFile = makeMarkerPath();
    const lease = pidMarkerTest.acquireRecoveryLease({
      pidFile,
      pid: 1234,
      identity,
      liveness: () => 'dead',
      readIdentity: () => identity,
    });
    expect(lease).not.toBeNull();
    const replacement = JSON.stringify({
      version: 1,
      pid: 9996,
      token: 'replacement-recovery-lease',
      identity,
    });
    const realRenameSync = fs.renameSync.bind(fs);
    let replaced = false;
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation((source, destination, ...args) => {
      if (source === lease.path && !replaced) {
        replaced = true;
        fs.unlinkSync(lease.path);
        fs.writeFileSync(lease.path, replacement, 'utf8');
      }
      return realRenameSync(source, destination, ...args);
    });

    try {
      expect(pidMarkerTest.releaseRecoveryLease(lease)).toBe(false);
    } finally {
      renameSpy.mockRestore();
    }

    expect(readGuardianPidMarker(lease.path)).toMatchObject({
      status: 'valid',
      pid: 9996,
      token: 'replacement-recovery-lease',
    });
  });

  it('atomically persists transport identity only for the current marker token', async () => {
    const pidFile = makeMarkerPath();
    const owner = await acquireGuardianPidMarker({ pidFile, pid: 1234, identity });

    updateGuardianPidMarkerTransportIdentity(owner, transportIdentity);
    expect(readGuardianPidMarker(pidFile)).toMatchObject({
      status: 'valid',
      token: owner.token,
      transportIdentity,
    });

    fs.writeFileSync(pidFile, JSON.stringify({
      version: 1,
      pid: 9999,
      token: 'replacement-token',
      identity,
    }));
    await expect(Promise.resolve().then(() => updateGuardianPidMarkerTransportIdentity(
      owner,
      transportIdentity,
    ))).rejects.toMatchObject({ code: 'GUARDIAN_PID_MARKER_OWNERSHIP_LOST' });
    expect(readGuardianPidMarker(pidFile)).toMatchObject({
      pid: 9999,
      token: 'replacement-token',
    });
  });

  it('keeps the old marker valid when a replacement write is partial', async () => {
    const pidFile = makeMarkerPath();
    const owner = await acquireGuardianPidMarker({ pidFile, pid: 1234, identity });
    const before = fs.readFileSync(pidFile, 'utf8');
    const realWriteSync = fs.writeSync.bind(fs);
    let injected = false;
    const writeSpy = vi.spyOn(fs, 'writeSync').mockImplementation((descriptor, buffer, offset, length, position) => {
      if (!injected) {
        injected = true;
        const partialLength = Math.max(1, Math.min(length, 3));
        realWriteSync(descriptor, buffer, offset, partialLength, position);
        throw Object.assign(new Error('simulated partial marker write'), { code: 'EIO' });
      }
      return realWriteSync(descriptor, buffer, offset, length, position);
    });

    try {
      expect(() => updateGuardianPidMarkerTransportIdentity(owner, transportIdentity))
        .toThrow(/simulated partial marker write/);
    } finally {
      writeSpy.mockRestore();
    }

    expect(fs.readFileSync(pidFile, 'utf8')).toBe(before);
    expect(readGuardianPidMarker(pidFile)).toMatchObject({
      status: 'valid',
      pid: owner.marker.pid,
      token: owner.token,
      transportIdentity: null,
    });
    expect(fs.readdirSync(path.dirname(pidFile))).toEqual(['guardian.pid']);
  });

  it('accepts a marker atomically published before a crash-equivalent rename throw', async () => {
    const pidFile = makeMarkerPath();
    let owner = await acquireGuardianPidMarker({ pidFile, pid: 1234, identity });
    const realRenameSync = fs.renameSync.bind(fs);
    let injected = false;
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation((source, destination, ...args) => {
      if (destination === pidFile && !injected) {
        injected = true;
        realRenameSync(source, destination, ...args);
        throw Object.assign(new Error('simulated post-rename crash'), { code: 'EIO' });
      }
      return realRenameSync(source, destination, ...args);
    });

    try {
      owner = updateGuardianPidMarkerTransportIdentity(owner, transportIdentity);
    } finally {
      renameSpy.mockRestore();
    }

    expect(readGuardianPidMarker(pidFile)).toMatchObject({
      status: 'valid',
      pid: owner.marker.pid,
      token: owner.token,
      transportIdentity,
    });
    expect(releaseGuardianPidMarker(owner)).toBe(true);
    expect(readGuardianPidMarker(pidFile)).toBeNull();
  });

  it.skipIf(process.platform === 'win32')('retains releasable authority when directory durability is uncertain after rename', async () => {
    const pidFile = makeMarkerPath();
    const owner = await acquireGuardianPidMarker({ pidFile, pid: 1234, identity });
    const realFsyncSync = fs.fsyncSync.bind(fs);
    const fsyncSpy = vi.spyOn(fs, 'fsyncSync').mockImplementation((descriptor) => {
      if (fs.fstatSync(descriptor).isDirectory()) {
        throw Object.assign(new Error('simulated marker directory fsync failure'), { code: 'EIO' });
      }
      return realFsyncSync(descriptor);
    });

    try {
      expect(() => updateGuardianPidMarkerTransportIdentity(owner, transportIdentity))
        .toThrowError(expect.objectContaining({ code: 'GUARDIAN_PID_MARKER_UPDATE_UNCERTAIN' }));
    } finally {
      fsyncSpy.mockRestore();
    }

    expect(readGuardianPidMarker(pidFile)).toMatchObject({
      status: 'valid',
      token: owner.token,
      transportIdentity,
    });
    expect(releaseGuardianPidMarker(owner)).toBe(true);
  });

  it('does not overwrite a marker replaced after the descriptor identity check', async () => {
    const pidFile = makeMarkerPath();
    const owner = await acquireGuardianPidMarker({ pidFile, pid: 1234, identity });
    const replacement = JSON.stringify({
      version: 1,
      pid: 9998,
      token: 'replacement-race-token',
      identity,
    });
    const realLstatSync = fs.lstatSync.bind(fs);
    let replaced = false;
    const lstatSpy = vi.spyOn(fs, 'lstatSync').mockImplementation((target, ...args) => {
      const stat = realLstatSync(target, ...args);
      if (target === pidFile && !replaced) {
        replaced = true;
        fs.unlinkSync(pidFile);
        fs.writeFileSync(pidFile, replacement, 'utf8');
      }
      return stat;
    });

    try {
      expect(() => updateGuardianPidMarkerTransportIdentity(owner, transportIdentity))
        .toThrow(/marker changed during transport publication/);
    } finally {
      lstatSpy.mockRestore();
    }

    expect(readGuardianPidMarker(pidFile)).toMatchObject({
      pid: 9998,
      token: 'replacement-race-token',
      transportIdentity: null,
    });
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
    const recovered = [];

    const next = await acquireGuardianPidMarker({
      pidFile,
      pid: 1237,
      identity: { ...identity, processStartTicks: '456' },
      liveness: () => 'dead',
      waitAttempts: 1,
      onVerifiedStale: ({ marker, state }) => recovered.push({ marker, state }),
    });
    expect(readGuardianPidMarker(pidFile)).toMatchObject({ pid: 1237, status: 'valid' });
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({
      marker: { pid: 1236, status: 'valid', identity },
      state: { state: 'stale', reason: 'recorded process is dead' },
    });
    releaseGuardianPidMarker(next);
  });

  it('allows stale marker acquisition before readiness when verified-dead recovery has no artifacts', async () => {
    const pidFile = makeMarkerPath();
    await acquireGuardianPidMarker({ pidFile, pid: 1236, identity });
    const next = await acquireGuardianPidMarker({
      pidFile,
      pid: 1237,
      identity: { ...identity, processStartTicks: '456' },
      liveness: () => 'dead',
      waitAttempts: 0,
      onVerifiedStale: ({ marker }) => recoverStaleGuardianTransportArtifacts({
        platform: 'linux',
        socketPath: path.join(path.dirname(pidFile), 'guardian.sock'),
        priorMarker: marker,
        liveness: () => 'dead',
      }),
    });

    expect(readGuardianPidMarker(pidFile)).toMatchObject({ pid: 1237, status: 'valid' });
    releaseGuardianPidMarker(next);
  });

  it('keeps the stale marker when strict transport recovery sees a replaced discovery file', async () => {
    const pidFile = makeMarkerPath();
    const stale = await acquireGuardianPidMarker({ pidFile, pid: 1236, identity });
    const portPath = path.join(path.dirname(pidFile), 'port');
    fs.writeFileSync(portPath, '127.0.0.1:4096\n');
    const replacementBody = '127.0.0.1:4101\n';
    let replaced = false;

    await expect(acquireGuardianPidMarker({
      pidFile,
      pid: 1237,
      identity: { ...identity, processStartTicks: '456' },
      liveness: () => 'dead',
      waitAttempts: 0,
      onVerifiedStale: ({ marker }) => recoverStaleGuardianTransportArtifacts({
        platform: 'win32',
        portPath,
        priorMarker: marker,
        liveness: () => 'dead',
        username: 'alice',
        aclInspector: () => ({ entries: [{ principal: 'alice', rights: ['F'] }] }),
        reparseChecker: (candidate) => {
          if (candidate === portPath && !replaced) {
            replaced = true;
            fs.unlinkSync(portPath);
            fs.writeFileSync(portPath, replacementBody);
          }
          return false;
        },
      }),
    })).rejects.toMatchObject({ code: 'GUARDIAN_TRANSPORT_ARTIFACT_REPLACED' });

    expect(readGuardianPidMarker(pidFile)).toMatchObject({
      status: 'valid',
      token: stale.token,
      pid: stale.marker.pid,
    });
    expect(fs.readFileSync(portPath, 'utf8')).toBe(replacementBody);
  });

  it('keeps a live PID-reused marker as an ownership blocker', async () => {
    const pidFile = makeMarkerPath();
    await acquireGuardianPidMarker({ pidFile, pid: 1240, identity });

    await expect(acquireGuardianPidMarker({
      pidFile,
      pid: 1241,
      identity: { ...identity, processStartTicks: '456' },
      liveness: () => 'alive',
      readIdentity: () => ({ ...identity, processStartTicks: '456' }),
      waitAttempts: 0,
      sleep: async () => {},
    })).rejects.toMatchObject({ code: 'GUARDIAN_PID_MARKER_UNCERTAIN' });
    expect(readGuardianPidMarker(pidFile)).toMatchObject({ pid: 1240, status: 'valid' });
  });

  it('does not authorize transport recovery from a legacy numeric marker', async () => {
    const pidFile = makeMarkerPath();
    fs.writeFileSync(pidFile, '1242');

    await expect(acquireGuardianPidMarker({
      pidFile,
      pid: 1243,
      identity,
      liveness: () => 'dead',
      waitAttempts: 0,
      sleep: async () => {},
      onVerifiedStale: () => {
        throw new Error('transport recovery must not run for a legacy marker');
      },
    })).rejects.toMatchObject({ code: 'GUARDIAN_PID_MARKER_UNCERTAIN' });
    expect(fs.readFileSync(pidFile, 'utf8')).toBe('1242');
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

  it('serializes stale recovery so a losing starter cannot clean the winner transport', async () => {
    const pidFile = makeMarkerPath();
    const stale = await acquireGuardianPidMarker({ pidFile, pid: 1244, identity });
    const firstIdentity = { ...identity, processStartTicks: '457' };
    const secondIdentity = { ...identity, processStartTicks: '458' };
    let resolveRecoveryStarted;
    const recoveryStarted = new Promise((resolve) => { resolveRecoveryStarted = resolve; });
    let resolveRecovery;
    const recoveryReleased = new Promise((resolve) => { resolveRecovery = resolve; });
    let recoveryCalls = 0;
    const liveness = (pid) => pid === stale.marker.pid ? 'dead' : 'alive';
    const readIdentity = (pid) => pid === 1245 ? firstIdentity : secondIdentity;

    const first = acquireGuardianPidMarker({
      pidFile,
      pid: 1245,
      identity: firstIdentity,
      liveness,
      readIdentity,
      waitAttempts: 10,
      waitMs: 1,
      onVerifiedStale: async () => {
        recoveryCalls += 1;
        resolveRecoveryStarted();
        await recoveryReleased;
      },
    });
    await recoveryStarted;

    const second = acquireGuardianPidMarker({
      pidFile,
      pid: 1246,
      identity: secondIdentity,
      liveness,
      readIdentity,
      waitAttempts: 10,
      waitMs: 1,
      onVerifiedStale: () => {
        recoveryCalls += 1;
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(recoveryCalls).toBe(1);

    resolveRecovery();
    const results = await Promise.allSettled([first, second]);
    expect(results[0].status).toBe('fulfilled');
    expect(results[1].status).toBe('rejected');
    expect(results[1].reason).toMatchObject({ code: 'GUARDIAN_ALREADY_RUNNING' });
    expect(readGuardianPidMarker(pidFile)?.token).toBe(results[0].value.marker.token);
    releaseGuardianPidMarker(results[0].value);
  });
});
