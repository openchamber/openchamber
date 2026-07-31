import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  runTaskkillForce,
  terminateChildWindows,
  __test__,
} from './windows-process.js';

let spawnSyncMock;

beforeEach(() => {
  spawnSyncMock = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Mirrors the mock child used in guardian.test.js, but minimal:
// no `kill` (the Windows path does not call child.kill; it shells
// out to `taskkill.exe`) and no `stdout`/`stderr` (we never read
// them from the child in the W-D code path).
const createFakeChild = ({ pid = 4242, exitCode = null, signalCode = null } = {}) => {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = exitCode;
  child.signalCode = signalCode;
  return child;
};

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

  it('invokes taskkill.exe with /F /PID <pid> and no /T flag', async () => {
    spawnSyncMock.mockReturnValue({ status: 0, stdout: '', stderr: '' });
    const child = createFakeChild({ pid: 12345 });
    // Emit a close event asynchronously so the close-wait resolves.
    setTimeout(() => {
      child.exitCode = 0;
      child.emit('close', 0, null);
    }, 0);

    const result = await terminateChildWindows(child, { timeoutMs: 500, spawnSync: spawnSyncMock });
    expect(result).toEqual({ ok: true });

    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawnSyncMock.mock.calls[0];
    expect(command).toBe('taskkill.exe');
    expect(args).toEqual(['/F', '/PID', '12345']);
    // Crucially, no /T flag (risk register: "taskkill /pid /f kills
    // our own process group via accidental /t" — High).
    expect(args).not.toContain('/T');
    expect(args).not.toContain('/t');
    expect(options).toEqual({
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
    });
  });

  it('polls OS liveness for a rehydrated child instead of waiting for close', async () => {
    spawnSyncMock.mockReturnValue({ status: 0, stdout: '', stderr: '' });
    const child = createFakeChild({ pid: 12345 });
    child.isRehydrated = true;
    const isProcessAlive = vi.fn()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);

    await expect(terminateChildWindows(child, {
      timeoutMs: 100,
      spawnSync: spawnSyncMock,
      isProcessAlive,
    })).resolves.toEqual({ ok: true });

    expect(isProcessAlive).toHaveBeenCalledWith(12345);
    expect(isProcessAlive).toHaveBeenCalledTimes(2);
    expect(child.listenerCount('close')).toBe(0);
  });

  it('does not skip taskkill when a rehydrated liveness probe is unknown', async () => {
    spawnSyncMock.mockReturnValue({ status: 128, stdout: '', stderr: 'process not found' });
    const child = createFakeChild({ pid: 12346 });
    child.isRehydrated = true;

    await expect(terminateChildWindows(child, {
      timeoutMs: 100,
      spawnSync: spawnSyncMock,
      isProcessAlive: () => 'unknown',
    })).resolves.toEqual({ ok: true });

    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
  });

  it('does not treat EPERM from the default probe as an already-dead child', async () => {
    spawnSyncMock.mockReturnValue({ status: 128, stdout: '', stderr: 'process not found' });
    const child = createFakeChild({ pid: 12347 });
    child.isRehydrated = true;
    const processKill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('permission denied'), { code: 'EPERM' });
    });

    try {
      await expect(terminateChildWindows(child, {
        timeoutMs: 100,
        spawnSync: spawnSyncMock,
      })).resolves.toEqual({ ok: true });
      expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    } finally {
      processKill.mockRestore();
    }
  });

  it('treats taskkill exit 128 (process not found) as success', async () => {
    spawnSyncMock.mockReturnValue({ status: 128, stdout: '', stderr: 'process not found' });
    const child = createFakeChild({ pid: 99999 });

    const result = await terminateChildWindows(child, { timeoutMs: 100, spawnSync: spawnSyncMock });
    expect(result).toEqual({ ok: true });
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
  });

  it('treats EPERM spawn error as a termination failure', async () => {
    const eperm = Object.assign(new Error('permission denied'), { code: 'EPERM' });
    spawnSyncMock.mockReturnValue({ error: eperm, status: null });
    const child = createFakeChild({ pid: 88888 });

    const result = await terminateChildWindows(child, { timeoutMs: 100, spawnSync: spawnSyncMock });
    expect(result).toEqual({ ok: false, reason: 'taskkill.exe spawn failed: permission denied' });
  });

  it('treats ESRCH spawn error as success (no such process)', async () => {
    const esrch = Object.assign(new Error('no such process'), { code: 'ESRCH' });
    spawnSyncMock.mockReturnValue({ error: esrch, status: null });
    const child = createFakeChild({ pid: 77777 });

    const result = await terminateChildWindows(child, { timeoutMs: 100, spawnSync: spawnSyncMock });
    expect(result).toEqual({ ok: true });
  });

  it('returns ok: true when child emits close before the timeout fires', async () => {
    spawnSyncMock.mockReturnValue({ status: 0, stdout: '', stderr: '' });
    const child = createFakeChild({ pid: 12345 });
    // Close fires after a short delay, well within the 1000ms timeout.
    setTimeout(() => {
      child.exitCode = 0;
      child.emit('close', 0, null);
    }, 10);

    const result = await terminateChildWindows(child, { timeoutMs: 1000, spawnSync: spawnSyncMock });
    expect(result).toEqual({ ok: true });
  });

  it('returns ok: false reason: still-running when child never closes within timeout', async () => {
    spawnSyncMock.mockReturnValue({ status: 0, stdout: '', stderr: '' });
    const child = createFakeChild({ pid: 12345 });
    // No `close` event ever emitted.

    const result = await terminateChildWindows(child, { timeoutMs: 50, spawnSync: spawnSyncMock });
    expect(result).toEqual({ ok: false, reason: 'still-running' });
  });

  it('returns ok: false with the taskkill reason when taskkill reports a real error', async () => {
    spawnSyncMock.mockReturnValue({ status: 1, stdout: '', stderr: 'Access is denied.' });
    const child = createFakeChild({ pid: 12345 });

    const result = await terminateChildWindows(child, { timeoutMs: 50, spawnSync: spawnSyncMock });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/taskkill\.exe exited with code 1: Access is denied\./);
  });

  it('returns ok: false with ENOENT message when taskkill.exe is missing', async () => {
    const enoent = Object.assign(new Error('spawn taskkill.exe ENOENT'), { code: 'ENOENT' });
    spawnSyncMock.mockReturnValue({ error: enoent, status: null });
    const child = createFakeChild({ pid: 12345 });

    const result = await terminateChildWindows(child, { timeoutMs: 50, spawnSync: spawnSyncMock });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/taskkill\.exe not found on PATH/);
  });

  it('returns ok: true synchronously if the child has already exited by the time taskkill resolves', async () => {
    // Race-condition guard: taskkill is synchronous in our usage
    // (spawnSync), but in tests we still want to assert that an
    // already-exited child observed between taskkill return and the
    // close-wait is treated as ok. We synthesize that by mutating
    // the child right after taskkill returns.
    spawnSyncMock.mockImplementation(() => {
      child.exitCode = 0;
      child.signalCode = null;
      return { status: 0, stdout: '', stderr: '' };
    });
    const child = createFakeChild({ pid: 12345 });

    const result = await terminateChildWindows(child, { timeoutMs: 100, spawnSync: spawnSyncMock });
    expect(result).toEqual({ ok: true });
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
    expect(r).toEqual({ status: 'error', reason: 'taskkill.exe spawn failed: permission denied' });
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
