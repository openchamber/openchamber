import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

import { isGuardianRunning, selectGuardianChild } from './detection.js';

const expectedOwner = {
  ownerInstanceId: 'owner-a',
  runtimeIdentity: 'runtime-a',
};

const child = (overrides = {}) => ({
  state: 'active',
  incarnation: 'incarnation-a',
  pid: 1001,
  port: 4096,
  processStartTicks: '1',
  revision: 0,
  leaseExpiresAt: Date.now() + 60_000,
  mac: 'record-mac-a',
  ownerInstanceId: 'owner-a',
  runtimeIdentity: 'runtime-a',
  launchFingerprint: 'fingerprint-a',
  launchSpec: {
    binary: 'opencode',
    args: [],
    hostname: '127.0.0.1',
    port: 4096,
    cwd: '/tmp/project',
  },
  ...overrides,
});

const staleSocketRoots = [];

const createCrashedSocket = async (socketPath) => {
  const child = spawn(process.execPath, [
    '--input-type=module',
    '-e',
    `import net from 'node:net'; const server = net.createServer(); server.listen(${JSON.stringify(socketPath)}, '127.0.0.1');`,
  ], { stdio: 'ignore' });
  for (let attempt = 0; attempt < 100 && !fs.existsSync(socketPath); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  child.kill('SIGKILL');
  await new Promise((resolve) => child.once('exit', resolve));
};

afterEach(() => {
  while (staleSocketRoots.length > 0) {
    const root = staleSocketRoots.pop();
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe('guardian transport detection', () => {
  it('fails closed without probing unsupported transport platforms', async () => {
    await expect(isGuardianRunning('/tmp/guardian.sock', undefined, { platform: 'plan9' }))
      .rejects
      .toMatchObject({
        code: 'GUARDIAN_TRANSPORT_UNSUPPORTED',
        message: 'Unsupported guardian transport platform: plan9',
      });
  });

  it.skipIf(process.platform === 'win32')('reports a crashed POSIX guardian as absent without unlinking its socket', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-detection-crash-'));
    staleSocketRoots.push(root);
    const socketPath = path.join(root, 'guardian.sock');
    await createCrashedSocket(socketPath);

    await expect(isGuardianRunning(socketPath)).resolves.toBe(false);
    expect(fs.existsSync(socketPath)).toBe(true);
  });
});

describe('guardian adoption selection', () => {
  it.each([
    ['revision', { revision: undefined }],
    ['lease', { leaseExpiresAt: undefined }],
    ['MAC', { mac: undefined }],
  ])('rejects an active record with a missing %s binding field', (_label, override) => {
    expect(() => selectGuardianChild([child(override)], { expectedOwner }))
      .toThrow(/complete launch identity/);
  });

  it('selects only the active child owned by this runtime', () => {
    const selected = selectGuardianChild([
      child({ incarnation: 'foreign', ownerInstanceId: 'owner-b', runtimeIdentity: 'runtime-b' }),
      child(),
    ], { expectedOwner });

    expect(selected?.incarnation).toBe('incarnation-a');
  });

  it('rejects an active ownerless record instead of adopting by list order', () => {
    expect(() => selectGuardianChild([
      child({ ownerInstanceId: null, runtimeIdentity: null, launchFingerprint: null }),
      child({ incarnation: 'owned-later' }),
    ], { expectedOwner })).toThrow(/no complete owner identity/);
  });

  it('rejects multiple active children for the same owner', () => {
    expect(() => selectGuardianChild([
      child({ incarnation: 'first' }),
      child({ incarnation: 'second', pid: 1002, port: 4097 }),
    ], { expectedOwner })).toThrow(/adoption conflict/);
  });

  it('uses launch fingerprint to disambiguate the same owner and runtime', () => {
    const first = child({ incarnation: 'first', launchFingerprint: 'fingerprint-a' });
    const second = child({
      incarnation: 'second',
      pid: 1002,
      port: 4097,
      launchFingerprint: 'fingerprint-b',
    });

    expect(selectGuardianChild([first, second], {
      expectedOwner: { ...expectedOwner, launchFingerprint: 'fingerprint-b' },
    })).toMatchObject({ incarnation: 'second' });
  });

  it('isolates two live instances by exact owner and runtime identity', () => {
    const first = child({ incarnation: 'first', ownerInstanceId: 'owner-a', runtimeIdentity: 'runtime-a' });
    const second = child({ incarnation: 'second', ownerInstanceId: 'owner-b', runtimeIdentity: 'runtime-b' });

    expect(selectGuardianChild([second, first], { expectedOwner })).toMatchObject({ incarnation: 'first' });
    expect(selectGuardianChild([first, second], {
      expectedOwner: { ownerInstanceId: 'owner-b', runtimeIdentity: 'runtime-b' },
    })).toMatchObject({ incarnation: 'second' });
  });

  it('rejects an active record without launch identity', () => {
    expect(() => selectGuardianChild([child({ launchSpec: null })], { expectedOwner }))
      .toThrow(/complete launch identity/);
  });

  it('preserves and selects lossless decimal process start ticks', () => {
    const largeTicks = '638912345678901234';
    expect(selectGuardianChild([child({ processStartTicks: largeTicks })], { expectedOwner }))
      .toMatchObject({ processStartTicks: largeTicks });
  });

  it('rejects an active record whose process identity query is unavailable', () => {
    expect(() => selectGuardianChild([child({ processStartTicks: null })], { expectedOwner }))
      .toThrow(/complete launch identity/);
  });

  it('surfaces guardian attention records instead of spawning beside them', () => {
    expect(() => selectGuardianChild([
      child({ state: 'attention', incarnation: 'legacy-live', ownerInstanceId: null, runtimeIdentity: null }),
    ], { expectedOwner })).toThrow(/requires attention/);
  });

  it('blocks adoption and legacy fallback for a live stopping record', () => {
    expect(() => selectGuardianChild([
      child({ state: 'stopping', incarnation: 'stopping-live' }),
    ], { expectedOwner })).toThrow(/unresolved stopping state/);
  });

  it('blocks adoption and legacy fallback for an unknown record', () => {
    expect(() => selectGuardianChild([
      child({ state: 'unknown', incarnation: 'unknown-live', pid: null, port: null }),
    ], { expectedOwner })).toThrow(/unresolved unknown state/);
  });

  it('ignores unresolved records owned by a different runtime', () => {
    expect(selectGuardianChild([
      child({
        state: 'attention',
        incarnation: 'foreign-attention',
        ownerInstanceId: 'owner-b',
        runtimeIdentity: 'runtime-b',
      }),
      child({
        state: 'stopping',
        incarnation: 'foreign-stopping',
        ownerInstanceId: 'owner-b',
        runtimeIdentity: 'runtime-b',
      }),
      child({
        state: 'unknown',
        incarnation: 'foreign-unknown',
        ownerInstanceId: 'owner-b',
        runtimeIdentity: 'runtime-b',
      }),
      child(),
    ], { expectedOwner })).toMatchObject({ incarnation: 'incarnation-a' });
  });

  it('fails closed when the same owner has unresolved handoff state', () => {
    expect(() => selectGuardianChild([
      child({ state: 'handoff-prepared', incarnation: 'handoff-owned' }),
    ], { expectedOwner })).toThrow(/unresolved handoff-prepared state/);
  });

  it('requires an expected owner identity', () => {
    expect(() => selectGuardianChild([child()], { expectedOwner: null }))
      .toThrow(/stable expected owner identity/);
  });
});
