import { describe, expect, test } from 'bun:test';

import {
  waitForWebUpdateApplied,
  type WebUpdateCheckResult,
  type WebUpdateStatusPayload,
} from '../webUpdateStatus';

const noSleep = async (): Promise<void> => {};

const statusOf = (state: WebUpdateStatusPayload['state'], exitCode?: number): WebUpdateStatusPayload => (
  exitCode === undefined ? { state } : { state, exitCode }
);

const checkOk = (available: boolean, currentVersion?: string): WebUpdateCheckResult => ({
  kind: 'ok',
  available,
  currentVersion,
});

describe('waitForWebUpdateApplied', () => {
  test('returns applied immediately when the status endpoint reports success', async () => {
    const fetchCheck = () => {
      throw new Error('version check must not be consulted when status is authoritative');
    };

    const result = await waitForWebUpdateApplied({
      previousVersion: '1.7.3',
      targetVersion: '1.8.0',
      fetchStatus: async () => statusOf('success'),
      fetchCheck,
      maxAttempts: 3,
      intervalMs: 1,
      sleep: noSleep,
    });

    expect(result).toEqual({ outcome: 'applied' });
  });

  test('returns failed with the npm exit code when the install fails', async () => {
    const result = await waitForWebUpdateApplied({
      previousVersion: '1.7.3',
      targetVersion: '1.8.0',
      fetchStatus: async () => statusOf('failed', 1),
      maxAttempts: 3,
      intervalMs: 1,
      sleep: noSleep,
    });

    expect(result).toEqual({ outcome: 'failed', exitCode: 1 });
  });

  test('returns failed without exit code when the spawn itself errored', async () => {
    const result = await waitForWebUpdateApplied({
      previousVersion: '1.7.3',
      targetVersion: '1.8.0',
      fetchStatus: async () => statusOf('failed'),
      maxAttempts: 3,
      intervalMs: 1,
      sleep: noSleep,
    });

    expect(result).toEqual({ outcome: 'failed' });
  });

  test('keeps polling while installing, then applies on success', async () => {
    let calls = 0;
    const result = await waitForWebUpdateApplied({
      previousVersion: '1.7.3',
      targetVersion: '1.8.0',
      fetchStatus: async () => {
        calls += 1;
        return calls < 3 ? statusOf('installing') : statusOf('success');
      },
      maxAttempts: 5,
      intervalMs: 1,
      sleep: noSleep,
    });

    expect(result).toEqual({ outcome: 'applied' });
    expect(calls).toBe(3);
  });

  test('falls back to version-move detection when the status endpoint is unreachable', async () => {
    const result = await waitForWebUpdateApplied({
      previousVersion: '1.7.3',
      targetVersion: '1.8.0',
      fetchStatus: async () => null,
      fetchCheck: async () => checkOk(false, '1.8.0'),
      maxAttempts: 3,
      intervalMs: 1,
      sleep: noSleep,
    });

    expect(result).toEqual({ outcome: 'applied' });
  });

  test('regression: a no-update answer with an unchanged version is NOT treated as applied', async () => {
    // The old flow reloaded whenever `available === false`. The check reports
    // exactly that when the npm registry fetch fails or while package.json is
    // being replaced mid-install — reloading there is the reported bug.
    let calls = 0;
    const result = await waitForWebUpdateApplied({
      previousVersion: '1.7.3',
      targetVersion: '1.8.0',
      fetchStatus: async () => null,
      fetchCheck: async () => {
        calls += 1;
        return calls < 2
          ? checkOk(false, '1.7.3') // no update + unchanged version → keep waiting
          : checkOk(false, '1.8.0'); // version eventually moves → applied
      },
      maxAttempts: 5,
      intervalMs: 1,
      sleep: noSleep,
    });

    expect(result).toEqual({ outcome: 'applied' });
    expect(calls).toBe(2);
  });

  test('applies when the current version reaches the exact target version', async () => {
    const result = await waitForWebUpdateApplied({
      previousVersion: '1.7.3',
      targetVersion: '1.8.0',
      fetchStatus: async () => null,
      fetchCheck: async () => checkOk(true, '1.8.0'),
      maxAttempts: 3,
      intervalMs: 1,
      sleep: noSleep,
    });

    expect(result).toEqual({ outcome: 'applied' });
  });

  test('applies when the version moves even if it differs from the advertised target', async () => {
    // npm may deliver a newer patch than the update API advertised.
    const result = await waitForWebUpdateApplied({
      previousVersion: '1.7.3',
      targetVersion: '1.8.0',
      fetchStatus: async () => null,
      fetchCheck: async () => checkOk(false, '1.8.1'),
      maxAttempts: 3,
      intervalMs: 1,
      sleep: noSleep,
    });

    expect(result).toEqual({ outcome: 'applied' });
  });

  test('never treats an unknown current version as a version move', async () => {
    const result = await waitForWebUpdateApplied({
      previousVersion: '1.7.3',
      targetVersion: '1.8.0',
      fetchStatus: async () => null,
      fetchCheck: async () => checkOk(false, 'unknown'),
      maxAttempts: 2,
      intervalMs: 1,
      sleep: noSleep,
    });

    expect(result).toEqual({ outcome: 'timeout' });
  });

  test('applies after a restart behind auth when the server is reachable again', async () => {
    const result = await waitForWebUpdateApplied({
      previousVersion: '1.7.3',
      targetVersion: '1.8.0',
      fetchStatus: async () => null,
      fetchCheck: async () => ({ kind: 'unauthorized' }),
      isServerReachable: async () => true,
      maxAttempts: 3,
      intervalMs: 1,
      sleep: noSleep,
    });

    expect(result).toEqual({ outcome: 'applied' });
  });

  test('does not apply on unauthorized when the server is still down', async () => {
    const result = await waitForWebUpdateApplied({
      previousVersion: '1.7.3',
      targetVersion: '1.8.0',
      fetchStatus: async () => null,
      fetchCheck: async () => ({ kind: 'unauthorized' }),
      isServerReachable: async () => false,
      maxAttempts: 2,
      intervalMs: 1,
      sleep: noSleep,
    });

    expect(result).toEqual({ outcome: 'timeout' });
  });

  test('times out when the install never completes', async () => {
    const result = await waitForWebUpdateApplied({
      previousVersion: '1.7.3',
      targetVersion: '1.8.0',
      fetchStatus: async () => statusOf('installing'),
      maxAttempts: 2,
      intervalMs: 1,
      sleep: noSleep,
    });

    expect(result).toEqual({ outcome: 'timeout' });
  });
});
