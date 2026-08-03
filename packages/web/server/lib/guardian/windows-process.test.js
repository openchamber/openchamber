import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  runTaskkillForce,
  terminateChildWindows,
  terminateRehydratedChildWindows,
  __test__,
} from './windows-process.js';
import { resolveWindowsPowerShellPath } from './process-identity.js';

let spawnSyncMock;

beforeEach(() => {
  spawnSyncMock = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Mirrors a live Node ChildProcess handle. The lifecycle must use this
// handle-backed kill path rather than converting an identity check into a
// PID-only taskkill operation.
const createFakeChild = ({ pid = 4242, exitCode = null, signalCode = null } = {}) => {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = exitCode;
  child.signalCode = signalCode;
  child.kill = vi.fn(() => {
    child.exitCode = 0;
    queueMicrotask(() => child.emit('close', 0, null));
    return true;
  });
  return child;
};

const rehydratedRecord = {
  pid: 4242,
  processStartTicks: '638912345678901234',
  port: 4096,
  launchSpec: {
    binary: 'C:\\OpenCode\\opencode.exe',
    args: [],
    hostname: '127.0.0.1',
    port: 4096,
    cwd: 'C:\\OpenCode',
  },
};

const helperOutput = (value) => ({
  status: 0,
  stdout: `${JSON.stringify(value)}\r\n`,
  stderr: '',
});

describe('terminateChildWindows', () => {
  it('returns ok: true immediately if child already exited (exitCode set)', async () => {
    const child = createFakeChild({ exitCode: 0, signalCode: null });
    const result = await terminateChildWindows(child, { timeoutMs: 100, spawnSync: spawnSyncMock });
    expect(result).toEqual({ ok: true });
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('returns ok: true immediately if child already exited (signalCode set)', async () => {
    const child = createFakeChild({ exitCode: null, signalCode: 'SIGKILL' });
    const result = await terminateChildWindows(child, { timeoutMs: 100, spawnSync: spawnSyncMock });
    expect(result).toEqual({ ok: true });
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('returns ok: true if child has no pid (defensive, mirrors Unix no-pid behavior)', async () => {
    const child = createFakeChild({ pid: 0 });
    const result = await terminateChildWindows(child, { timeoutMs: 100, spawnSync: spawnSyncMock });
    expect(result).toEqual({ ok: true });
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('uses the live child process handle and never invokes PID-only taskkill', async () => {
    const child = createFakeChild({ pid: 12345 });

    const result = await terminateChildWindows(child, { timeoutMs: 500, spawnSync: spawnSyncMock });
    expect(result).toEqual({ ok: true });
    expect(child.kill).toHaveBeenCalledOnce();
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('fails closed for a rehydrated child without a handle-backed terminator', async () => {
    const child = createFakeChild({ pid: 12345 });
    child.isRehydrated = true;
    const isProcessAlive = vi.fn().mockReturnValue(true);

    await expect(terminateChildWindows(child, {
      timeoutMs: 100,
      spawnSync: spawnSyncMock,
      isProcessAlive,
    })).resolves.toEqual({
      ok: false,
      reason: 'handle-backed Windows termination is unavailable for a rehydrated child',
    });

    expect(isProcessAlive).toHaveBeenCalledWith(12345);
    expect(isProcessAlive).toHaveBeenCalledTimes(1);
    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect(child.listenerCount('close')).toBe(0);
  });

  it('accepts an injected handle-backed rehydrated terminator', async () => {
    const child = createFakeChild({ pid: 12346 });
    child.isRehydrated = true;
    const terminateByHandle = vi.fn().mockResolvedValue({ status: 'already-gone' });

    await expect(terminateChildWindows(child, {
      timeoutMs: 100,
      spawnSync: spawnSyncMock,
      isProcessAlive: () => 'alive',
      terminateByHandle,
    })).resolves.toEqual({ ok: true });

    expect(terminateByHandle).toHaveBeenCalledWith(child);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('does not treat an unknown rehydrated identity as permission to use PID-only taskkill', async () => {
    const child = createFakeChild({ pid: 12347 });
    child.isRehydrated = true;
    const result = await terminateChildWindows(child, {
      timeoutMs: 100,
      spawnSync: spawnSyncMock,
      isProcessAlive: () => 'unknown',
    });
    expect(result).toMatchObject({ ok: false });
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('returns ok: true when child emits close before the timeout fires', async () => {
    const child = createFakeChild({ pid: 12345 });

    const result = await terminateChildWindows(child, { timeoutMs: 1000, spawnSync: spawnSyncMock });
    expect(result).toEqual({ ok: true });
  });

  it('returns ok: false reason: still-running when child never closes within timeout', async () => {
    const child = createFakeChild({ pid: 12345 });
    child.kill.mockImplementation(() => true);

    const result = await terminateChildWindows(child, { timeoutMs: 50, spawnSync: spawnSyncMock });
    expect(result).toEqual({ ok: false, reason: 'still-running' });
  });

  it('returns ok: false when the handle-backed kill is rejected', async () => {
    const child = createFakeChild({ pid: 12345 });
    child.kill.mockReturnValue(false);

    const result = await terminateChildWindows(child, { timeoutMs: 50, spawnSync: spawnSyncMock });
    expect(result).toEqual({ ok: false, reason: 'handle-backed Windows termination was rejected' });
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('does not use taskkill when a live child has no handle method', async () => {
    const child = createFakeChild({ pid: 12345 });
    delete child.kill;

    const result = await terminateChildWindows(child, { timeoutMs: 100, spawnSync: spawnSyncMock });
    expect(result).toEqual({
      ok: false,
      reason: 'handle-backed Windows termination is unavailable for a live child',
    });
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });
});

describe('terminateRehydratedChildWindows', () => {
  it('uses the hidden PowerShell/.NET handle helper and passes persisted identity over stdin', () => {
    spawnSyncMock.mockReturnValue(helperOutput({ status: 'killed' }));
    const child = createFakeChild({ pid: rehydratedRecord.pid });

    expect(terminateRehydratedChildWindows(child, {
      record: rehydratedRecord,
      spawnSync: spawnSyncMock,
    })).toEqual({ status: 'killed' });

    const [executable, args, options] = spawnSyncMock.mock.calls[0];
    expect(executable).toBe(__test__.resolveWindowsPowerShellPath());
    expect(args).toEqual(expect.arrayContaining([
      '-NoProfile',
      '-NonInteractive',
      '-WindowStyle',
      'Hidden',
      '-EncodedCommand',
    ]));
    expect(options).toEqual(expect.objectContaining({
      encoding: 'utf8',
      timeout: __test__.WINDOWS_HANDLE_TERMINATION_TIMEOUT_MS,
      windowsHide: true,
      shell: false,
    }));
    expect(JSON.parse(options.input)).toEqual({
      pid: rehydratedRecord.pid,
      processStartTicks: rehydratedRecord.processStartTicks,
      port: rehydratedRecord.port,
      launchSpec: rehydratedRecord.launchSpec,
    });
    expect(__test__.WINDOWS_HANDLE_TERMINATION_SCRIPT).toMatch(/OpenProcess/);
    expect(__test__.WINDOWS_HANDLE_TERMINATION_SCRIPT).toMatch(/GetProcessTimes/);
    expect(__test__.WINDOWS_HANDLE_TERMINATION_SCRIPT).toMatch(/TerminateProcess/);
    expect(__test__.WINDOWS_HANDLE_TERMINATION_SCRIPT).toMatch(/CloseHandle/);
  });

  it('does not assign PowerShell reserved $PID at source level', () => {
    expect(__test__.WINDOWS_HANDLE_TERMINATION_SCRIPT).toMatch(
      /\$requestPid\s*=\s*\[uint32\]\$request\.pid/,
    );
    expect(__test__.WINDOWS_HANDLE_TERMINATION_SCRIPT).not.toMatch(/\$pid\b/i);
  });

  it('uses complete case-insensitive command identity instead of basename substrings', () => {
    expect(__test__.WINDOWS_HANDLE_TERMINATION_SCRIPT).toMatch(/Split-WindowsCommandLine/);
    expect(__test__.WINDOWS_HANDLE_TERMINATION_SCRIPT).toMatch(/Normalize-WindowsCommandToken/);
    expect(__test__.WINDOWS_HANDLE_TERMINATION_SCRIPT).toMatch(/\bserve\b/);
    expect(__test__.WINDOWS_HANDLE_TERMINATION_SCRIPT).toMatch(/expectedPort/);
    expect(__test__.WINDOWS_HANDLE_TERMINATION_SCRIPT).toMatch(/ToLowerInvariant/);
    expect(__test__.WINDOWS_HANDLE_TERMINATION_SCRIPT).not.toMatch(/\.IndexOf\(/);
  });

  it('derives an absolute PowerShell path from SystemRoot without shell interpolation', () => {
    expect(__test__.resolveWindowsPowerShellPath).toBe(resolveWindowsPowerShellPath);
    expect(__test__.resolveWindowsPowerShellPath('D:\\Windows')).toBe(
      'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    );
    expect(__test__.resolveWindowsPowerShellPath('relative-root')).toBe(
      __test__.WINDOWS_POWERSHELL_FALLBACK_PATH,
    );
    expect(__test__.resolveWindowsPowerShellPath()).toMatch(
      /^[A-Za-z]:\\.+\\powershell\.exe$/,
    );
  });

  it('passes a caller-supplied SystemRoot to the centralized command executable resolver', () => {
    spawnSyncMock.mockReturnValue(helperOutput({ status: 'already-gone' }));
    const child = createFakeChild({ pid: rehydratedRecord.pid });

    expect(terminateRehydratedChildWindows(child, {
      record: rehydratedRecord,
      spawnSync: spawnSyncMock,
      systemRoot: 'E:\\Windows',
    })).toEqual({ status: 'already-gone' });
    expect(spawnSyncMock.mock.calls[0][0]).toBe(
      'E:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    );
  });

  it('returns the helper identity failure without attempting PID-only taskkill', () => {
    spawnSyncMock.mockReturnValue(helperOutput({
      status: 'error',
      reason: 'Windows process start identity changed',
    }));
    const child = createFakeChild({ pid: rehydratedRecord.pid });

    expect(terminateRehydratedChildWindows(child, {
      record: rehydratedRecord,
      spawnSync: spawnSyncMock,
    })).toEqual({
      status: 'error',
      reason: 'Windows process start identity changed',
    });
    expect(spawnSyncMock).toHaveBeenCalledWith(
      __test__.resolveWindowsPowerShellPath(),
      expect.any(Array),
      expect.any(Object),
    );
  });

  it('fails closed when PowerShell is unavailable', () => {
    const error = Object.assign(new Error('spawn powershell.exe ENOENT'), { code: 'ENOENT' });
    spawnSyncMock.mockReturnValue({ error, status: null, stdout: '', stderr: '' });
    const child = createFakeChild({ pid: rehydratedRecord.pid });

    expect(terminateRehydratedChildWindows(child, {
      record: rehydratedRecord,
      spawnSync: spawnSyncMock,
    })).toEqual({
      status: 'error',
      reason: 'Windows handle terminator is unavailable: powershell.exe not found',
    });
  });

  it('does not return untrusted helper stderr or credential material in diagnostics', () => {
    spawnSyncMock.mockReturnValue({
      status: 17,
      stdout: '',
      stderr: `password=do-not-leak\u0000${'x'.repeat(2000)}`,
    });
    const child = createFakeChild({ pid: rehydratedRecord.pid });

    const result = terminateRehydratedChildWindows(child, {
      record: rehydratedRecord,
      spawnSync: spawnSyncMock,
    });
    expect(result.reason).not.toContain('do-not-leak');
    expect(result.reason).not.toContain('\u0000');
    expect(result.reason.length).toBeLessThanOrEqual(512);
  });

  it('bounds and sanitizes helper-provided reasons before returning them', () => {
    const noisyReason = `secret=do-not-leak\u0001${'x'.repeat(2000)}`;
    spawnSyncMock.mockReturnValue(helperOutput({ status: 'error', reason: noisyReason }));
    const child = createFakeChild({ pid: rehydratedRecord.pid });

    const result = terminateRehydratedChildWindows(child, {
      record: rehydratedRecord,
      spawnSync: spawnSyncMock,
    });
    expect(result).toEqual({ status: 'error', reason: 'Windows handle terminator failed' });
    expect(result.reason).not.toContain('do-not-leak');
    expect(result.reason).not.toContain('\u0001');
    expect(__test__.sanitizeWindowsHelperDiagnostic(`a\u0000${'b'.repeat(600)}`).length).toBeLessThanOrEqual(512);
  });

  it.each([
    ['spawn error', { error: Object.assign(new Error('permission denied'), { code: 'EPERM' }), status: 0 }],
    ['signal', { status: 0, signal: 'SIGTERM' }],
    ['non-zero exit', { status: 1, stderr: 'helper failed' }],
  ])('never accepts success output when helper execution has a %s', (_label, result) => {
    spawnSyncMock.mockReturnValue({
      ...result,
      stdout: JSON.stringify({ status: 'killed' }),
    });
    const child = createFakeChild({ pid: rehydratedRecord.pid });

    const outcome = terminateRehydratedChildWindows(child, {
      record: rehydratedRecord,
      spawnSync: spawnSyncMock,
    });

    expect(outcome.status).toBe('error');
  });

  it('fails closed for malformed helper JSON even after a status-0 exit', () => {
    spawnSyncMock.mockReturnValue({ status: 0, stdout: '{not-json}', stderr: '' });
    const child = createFakeChild({ pid: rehydratedRecord.pid });

    expect(terminateRehydratedChildWindows(child, {
      record: rehydratedRecord,
      spawnSync: spawnSyncMock,
    })).toEqual({
      status: 'error',
      reason: 'Windows handle terminator returned malformed or ambiguous output',
    });
  });
});

describe('runTaskkillForce (lower-level envelope)', () => {
  it('returns { status: "killed" } on exit 0', () => {
    spawnSyncMock.mockReturnValue({ status: 0, stdout: '', stderr: '' });
    const r = runTaskkillForce({ pid: 1, spawnSync: spawnSyncMock });
    expect(r).toEqual({ status: 'killed' });
  });

  it('returns { status: "already-gone" } on exit 128 (process not found)', () => {
    spawnSyncMock.mockReturnValue({ status: 128, stdout: '', stderr: '' });
    const r = runTaskkillForce({ pid: 1, spawnSync: spawnSyncMock });
    expect(r).toEqual({ status: 'already-gone' });
  });

  it('returns { status: "error" } on EPERM spawn error', () => {
    const eperm = Object.assign(new Error('permission denied'), { code: 'EPERM' });
    spawnSyncMock.mockReturnValue({ error: eperm, status: null });
    const r = runTaskkillForce({ pid: 1, spawnSync: spawnSyncMock });
    expect(r).toEqual({ status: 'error', reason: 'taskkill.exe spawn failed (EPERM)' });
  });

  it('returns { status: "already-gone" } on ESRCH spawn error', () => {
    const esrch = Object.assign(new Error('no such process'), { code: 'ESRCH' });
    spawnSyncMock.mockReturnValue({ error: esrch, status: null });
    const r = runTaskkillForce({ pid: 1, spawnSync: spawnSyncMock });
    expect(r).toEqual({ status: 'already-gone' });
  });

  it('returns { status: "error" } on ENOENT (taskkill.exe missing)', () => {
    const enoent = Object.assign(new Error('spawn taskkill.exe ENOENT'), { code: 'ENOENT' });
    spawnSyncMock.mockReturnValue({ error: enoent, status: null });
    const r = runTaskkillForce({ pid: 1, spawnSync: spawnSyncMock });
    expect(r.status).toBe('error');
    expect(r.reason).toMatch(/not found on PATH/);
  });

  it('returns { status: "error" } when taskkill.exe is killed by a signal', () => {
    spawnSyncMock.mockReturnValue({ status: null, signal: 'SIGKILL', stdout: '', stderr: '' });
    const r = runTaskkillForce({ pid: 1, spawnSync: spawnSyncMock });
    expect(r.status).toBe('error');
    expect(r.reason).toMatch(/terminated by signal SIGKILL/);
  });

  it('throws on non-positive pid (defense in depth)', () => {
    expect(() => runTaskkillForce({ pid: 0, spawnSync: spawnSyncMock })).toThrow(/positive integer/);
    expect(() => runTaskkillForce({ pid: -1, spawnSync: spawnSyncMock })).toThrow(/positive integer/);
    expect(() => runTaskkillForce({ pid: 1.5, spawnSync: spawnSyncMock })).toThrow(/positive integer/);
  });

  it('rejects non-integer pid strings (defense in depth)', () => {
    // The helper is only called with `child.pid`, which Node.js
    // always coerces to a number, so this is just defense in depth.
    expect(() => runTaskkillForce({ pid: 'abc', spawnSync: spawnSyncMock })).toThrow(/positive integer/);
  });
});

describe('__test__ helpers', () => {
  it('TASKKILL_TIMEOUT_MS is a positive integer', () => {
    expect(Number.isInteger(__test__.TASKKILL_TIMEOUT_MS)).toBe(true);
    expect(__test__.TASKKILL_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it('TASKKILL_EXIT_NOT_FOUND is 128', () => {
    expect(__test__.TASKKILL_EXIT_NOT_FOUND).toBe(128);
  });

  it('hasChildExited returns true for child with exitCode set', () => {
    expect(__test__.hasChildExited({ exitCode: 0, signalCode: null })).toBe(true);
  });

  it('hasChildExited returns true for child with signalCode set', () => {
    expect(__test__.hasChildExited({ exitCode: null, signalCode: 'SIGKILL' })).toBe(true);
  });

  it('hasChildExited returns false for a live child', () => {
    expect(__test__.hasChildExited({ exitCode: null, signalCode: null })).toBe(false);
  });

  it('hasChildExited returns true for null/undefined child (defensive)', () => {
    expect(__test__.hasChildExited(null)).toBe(true);
    expect(__test__.hasChildExited(undefined)).toBe(true);
  });
});
