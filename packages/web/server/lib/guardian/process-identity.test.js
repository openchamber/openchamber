import { describe, expect, it, vi } from 'vitest';

import {
  compareProcessIdentity,
  probeProcessLiveness,
  readProcessIdentity,
  readProcessLaunchIdentity,
  readProcessStartTicks,
} from './process-identity.js';

const expectWindowsQueryOptions = expect.objectContaining({
  encoding: 'utf8',
  timeout: 5000,
  windowsHide: true,
});

describe('Windows process identity queries', () => {
  it('uses a bounded PowerShell query and preserves the intentional cwd limitation', () => {
    const largeTicks = '638912345678901234';
    const spawnSync = vi.fn()
      .mockReturnValueOnce({ status: 0, stdout: `${largeTicks}\r\n` })
      .mockReturnValueOnce({ status: 0, stdout: 'node opencode serve --port 4096\r\n' });

    expect(readProcessStartTicks(42, { platform: 'win32', spawnSync })).toBe(largeTicks);
    expect(readProcessLaunchIdentity(42, { platform: 'win32', spawnSync })).toEqual({
      commandLine: 'node opencode serve --port 4096',
      cwd: null,
    });

    expect(spawnSync).toHaveBeenNthCalledWith(
      1,
      'powershell.exe',
      expect.arrayContaining(['-Command']),
      expectWindowsQueryOptions,
    );
    expect(spawnSync).toHaveBeenNthCalledWith(
      2,
      'powershell.exe',
      expect.arrayContaining(['-Command']),
      expectWindowsQueryOptions,
    );
  });

  it('fails closed when a Windows PowerShell query times out', () => {
    const timeout = Object.assign(new Error('query timed out'), { code: 'ETIMEDOUT' });
    const spawnSync = vi.fn().mockReturnValue({ status: null, stdout: '', error: timeout });

    expect(readProcessStartTicks(42, { platform: 'win32', spawnSync })).toBeNull();
    expect(readProcessLaunchIdentity(42, { platform: 'win32', spawnSync })).toBeNull();
    expect(spawnSync).toHaveBeenCalledTimes(2);
  });
});

describe('shared process identity', () => {
  it('keeps process-kill permission failures as unknown liveness', () => {
    const eperm = Object.assign(new Error('permission denied'), { code: 'EPERM' });
    const killFn = vi.fn(() => { throw eperm; });

    expect(probeProcessLiveness(42, { killFn })).toBe('unknown');
  });

  it('only maps ESRCH to authoritative death', () => {
    const killFn = vi.fn(() => {
      const error = Object.assign(new Error('no such process'), { code: 'ESRCH' });
      throw error;
    });

    expect(probeProcessLiveness(42, { killFn })).toBe('dead');
  });

  it('matches a complete identity and rejects a recycled start identity', () => {
    const expected = {
      processStartTicks: '123',
      launch: { commandLine: 'node guardian --data-dir /tmp/one', cwd: '/tmp/one' },
      owner: '1000',
    };
    expect(compareProcessIdentity(expected, { ...expected })).toBeNull();
    expect(compareProcessIdentity(expected, {
      ...expected,
      processStartTicks: '124',
    })).toMatch(/changed/);
  });

  it.skipIf(process.platform === 'win32')('reads a complete identity through the shared abstraction on Linux', () => {
    const identity = readProcessIdentity(process.pid, { platform: 'linux' });
    expect(identity).toMatchObject({
      processStartTicks: expect.stringMatching(/^(?:0|[1-9]\d*)$/),
      launch: {
        commandLine: expect.stringContaining('vitest'),
      },
    });
  });
});
