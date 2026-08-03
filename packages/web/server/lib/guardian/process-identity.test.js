import { describe, expect, it, vi } from 'vitest';

import {
  compareProcessIdentity,
  matchesWindowsProcessLaunchIdentity,
  probeProcessLiveness,
  readProcessIdentity,
  readProcessLaunchIdentity,
  readProcessOwnerIdentity,
  readProcessStartTicks,
  resolveWindowsSystemToolPath,
  resolveWindowsPowerShellPath,
  __test__,
} from './process-identity.js';

const expectWindowsQueryOptions = expect.objectContaining({
  encoding: 'utf8',
  timeout: 5000,
  windowsHide: true,
  shell: false,
});

describe('Windows process identity queries', () => {
  it('uses the trusted absolute PowerShell executable for every bounded query', () => {
    const largeTicks = '638912345678901234';
    const systemRoot = 'D:\\Windows';
    const spawnSync = vi.fn()
      .mockReturnValueOnce({ status: 0, stdout: `${largeTicks}\r\n` })
      .mockReturnValueOnce({ status: 0, stdout: 'node opencode serve --port 4096\r\n' })
      .mockReturnValueOnce({ status: 0, stdout: 'alice\r\n' });

    const options = { platform: 'win32', spawnSync, systemRoot };
    expect(readProcessStartTicks(42, options)).toBe(largeTicks);
    expect(readProcessLaunchIdentity(42, options)).toEqual({
      commandLine: 'node opencode serve --port 4096',
      cwd: null,
    });
    expect(readProcessOwnerIdentity(42, options)).toBe('alice');

    for (const call of spawnSync.mock.calls) {
      expect(call[0]).toBe(resolveWindowsPowerShellPath(systemRoot));
      expect(call[0]).not.toBe('powershell.exe');
      expect(call[1]).toEqual(expect.arrayContaining(['-Command']));
      expect(call[2]).toEqual(expectWindowsQueryOptions);
    }
    expect(spawnSync).toHaveBeenCalledTimes(3);
  });

  it('fails closed when a Windows PowerShell query times out', () => {
    const timeout = Object.assign(new Error('query timed out'), { code: 'ETIMEDOUT' });
    const spawnSync = vi.fn().mockReturnValue({ status: null, stdout: '', error: timeout });

    expect(readProcessStartTicks(42, { platform: 'win32', spawnSync })).toBeNull();
    expect(readProcessLaunchIdentity(42, { platform: 'win32', spawnSync })).toBeNull();
    expect(spawnSync).toHaveBeenCalledTimes(2);
  });

  it('resolves SystemRoot to an absolute executable and never falls back to PATH', () => {
    expect(resolveWindowsPowerShellPath('D:\\Windows')).toBe(
      'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    );
    expect(resolveWindowsPowerShellPath('relative-root')).toBe(
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    );
    expect(resolveWindowsPowerShellPath('')).toBe(__test__.WINDOWS_POWERSHELL_FALLBACK_PATH);
    expect(__test__.WINDOWS_POWERSHELL_FALLBACK_PATH).toMatch(
      /^[A-Za-z]:\\.+\\powershell\.exe$/,
    );
  });

  it('resolves every guardian ACL/identity tool from the same trusted SystemRoot seam', () => {
    expect(resolveWindowsSystemToolPath('powershell', 'D:\\Windows')).toBe(
      'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    );
    expect(resolveWindowsSystemToolPath('icacls', 'D:\\Windows')).toBe(
      'D:\\Windows\\System32\\icacls.exe',
    );
    expect(resolveWindowsSystemToolPath('whoami.exe', 'D:\\Windows')).toBe(
      'D:\\Windows\\System32\\whoami.exe',
    );
    expect(resolveWindowsSystemToolPath('icacls', 'relative-root')).toBe(
      __test__.WINDOWS_SYSTEM_TOOL_FALLBACK_PATHS.icacls,
    );
    for (const executable of Object.values(__test__.WINDOWS_SYSTEM_TOOL_FALLBACK_PATHS)) {
      expect(executable).toMatch(/^[A-Za-z]:\\.+\.exe$/);
    }
    expect(() => resolveWindowsSystemToolPath('where')).toThrow(/Unsupported Windows system tool/);
  });
});

describe('Windows launch identity comparison', () => {
  const launchSpec = {
    binary: 'C:\\OpenCode\\opencode.exe',
    args: [],
    hostname: '127.0.0.1',
    port: 4096,
    cwd: 'C:\\OpenCode',
  };

  it('requires an exact argv shape including serve, hostname, and port', () => {
    expect(matchesWindowsProcessLaunchIdentity(
      '"c:\\opencode\\opencode.exe" SERVE --HOSTNAME 127.0.0.1 --PORT 4096',
      launchSpec,
    )).toBe(true);
    expect(matchesWindowsProcessLaunchIdentity(
      'c:\\opencode\\opencode.exe serve --hostname 127.0.0.1 --port 4096 --extra',
      launchSpec,
    )).toBe(false);
    expect(matchesWindowsProcessLaunchIdentity(
      'c:\\opencode\\opencode.exe --hostname 127.0.0.1 --port 4096',
      launchSpec,
    )).toBe(false);
  });

  it('allows only the unqualified executable basename compatibility case', () => {
    expect(matchesWindowsProcessLaunchIdentity(
      'opencode.exe serve --hostname 127.0.0.1 --port 4096',
      { ...launchSpec, binary: 'opencode' },
    )).toBe(true);
    expect(matchesWindowsProcessLaunchIdentity(
      'C:\\Other\\opencode.exe serve --hostname 127.0.0.1 --port 4096',
      launchSpec,
    )).toBe(false);
  });

  it('rejects malformed command lines rather than using substring matching', () => {
    expect(__test__.parseWindowsCommandLine('opencode.exe "serve --hostname 127.0.0.1')).toBeNull();
    expect(matchesWindowsProcessLaunchIdentity(
      'not-opencode.exe serve --hostname 127.0.0.1 --port 4096',
      { ...launchSpec, binary: 'opencode' },
    )).toBe(false);
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

  it('compares Windows command identity without false case failures', () => {
    const expected = {
      processStartTicks: '123',
      launch: { commandLine: 'C:\\OpenCode\\opencode.exe Serve --Port 4096', cwd: null },
      owner: null,
    };
    const actual = {
      processStartTicks: '123',
      launch: { commandLine: 'c:\\opencode\\opencode.exe serve --port 4096', cwd: null },
      owner: null,
    };
    expect(compareProcessIdentity(expected, actual, { platform: 'win32' })).toBeNull();
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
