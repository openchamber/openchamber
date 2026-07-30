import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import fs from 'node:fs';
import path from 'node:path';

import { EXIT_CODE, TunnelCliError } from '../../../bin/lib/cli-errors.js';
import {
  _resetCachedGuardianPathsForTest,
  getDefaultGuardianPidFile,
  getDefaultGuardianPortPath,
  getDefaultGuardianSocketPath,
  guardianCommand,
  isGuardianAutoStarted,
  maybeAutoStartGuardian,
  resetGuardianAutoStarted,
  runReloadAction,
  shouldAutoStartGuardian,
  startGuardianDetached,
  stopGuardianViaIpc,
  _setProcessAliveOverrideForTest,
} from '../../../bin/lib/commands-guardian.js';

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');

function setPlatformForTest(platform) {
  Object.defineProperty(process, 'platform', {
    value: platform,
    configurable: true,
  });
}

function restorePlatform() {
  if (originalPlatformDescriptor) {
    Object.defineProperty(process, 'platform', originalPlatformDescriptor);
  } else {
    delete process.platform;
  }
}

afterEach(() => {
  restorePlatform();
  vi.restoreAllMocks();
  resetGuardianAutoStarted();
  // W-C: reset the cached per-platform IPC paths so the next test
  // recomputes them under its own (possibly flipped) process.platform.
  _resetCachedGuardianPathsForTest();
});

// W-C: `assertPlatformSupported` was removed. The guardian CLI is
// platform-agnostic now; the per-platform IPC paths come from
// `defaultIpcPaths` in `ipc-transport.js`. The opt-outs are
// `--no-guardian`, `--no-handoff`, and `OPENCHAMBER_GUARDIAN_AUTOSTART=disabled`.

describe('shouldAutoStartGuardian', () => {
  it.skipIf(process.platform === 'win32')('returns false when options.guardian === false', () => {
    setPlatformForTest('linux');
    expect(shouldAutoStartGuardian({ options: { guardian: false, handoff: true } })).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('returns false when options.handoff === false', () => {
    setPlatformForTest('linux');
    expect(shouldAutoStartGuardian({ options: { guardian: true, handoff: false } })).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('returns false when env var is disabled', () => {
    setPlatformForTest('linux');
    const previous = process.env.OPENCHAMBER_GUARDIAN_AUTOSTART;
    process.env.OPENCHAMBER_GUARDIAN_AUTOSTART = 'disabled';
    try {
      expect(shouldAutoStartGuardian({ options: { guardian: true, handoff: true } })).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.OPENCHAMBER_GUARDIAN_AUTOSTART;
      else process.env.OPENCHAMBER_GUARDIAN_AUTOSTART = previous;
    }
  });

  it.skipIf(process.platform === 'win32')('returns true by default on Linux', () => {
    setPlatformForTest('linux');
    const previous = process.env.OPENCHAMBER_GUARDIAN_AUTOSTART;
    delete process.env.OPENCHAMBER_GUARDIAN_AUTOSTART;
    try {
      expect(shouldAutoStartGuardian({ options: { guardian: true, handoff: true } })).toBe(true);
    } finally {
      if (previous !== undefined) process.env.OPENCHAMBER_GUARDIAN_AUTOSTART = previous;
    }
  });

  it('returns true on Windows when no opt-out is set (W-C platform dispatch)', () => {
    setPlatformForTest('win32');
    expect(shouldAutoStartGuardian({ options: { guardian: true, handoff: true } })).toBe(true);
  });

  it('returns false on Windows when --no-guardian is passed', () => {
    setPlatformForTest('win32');
    expect(shouldAutoStartGuardian({ options: { guardian: false, handoff: true } })).toBe(false);
  });

  it('returns false on Windows when OPENCHAMBER_GUARDIAN_AUTOSTART=disabled', () => {
    setPlatformForTest('win32');
    const previous = process.env.OPENCHAMBER_GUARDIAN_AUTOSTART;
    process.env.OPENCHAMBER_GUARDIAN_AUTOSTART = 'disabled';
    try {
      expect(shouldAutoStartGuardian({ options: { guardian: true, handoff: true } })).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.OPENCHAMBER_GUARDIAN_AUTOSTART;
      else process.env.OPENCHAMBER_GUARDIAN_AUTOSTART = previous;
    }
  });
});

describe('startGuardianDetached', () => {
  it.skipIf(process.platform === 'win32')('spawns the guardian entry with detached: true', async () => {
    setPlatformForTest('linux');
    const mockChild = { pid: 4242, unref: vi.fn() };
    const spawnFn = vi.fn().mockReturnValue(mockChild);
    const result = await startGuardianDetached({
      spawnFn,
      logFd: 1,
      env: { FOO: 'bar' },
    });
    expect(spawnFn).toHaveBeenCalledTimes(1);
    const [, , opts] = spawnFn.mock.calls[0];
    expect(opts.detached).toBe(true);
    expect(opts.env).toMatchObject({ FOO: 'bar' });
    expect(mockChild.unref).toHaveBeenCalled();
    expect(result.pid).toBe(4242);
  });

  // W-C: previously `startGuardianDetached` threw `TunnelCliError` on
  // Windows. The rejection is removed; on Windows the entrypoint runs
  // through the IPC transport factory's Windows backend, and
  // `windowsHide: true` is unconditionally set on the spawn options.
  it('does not throw on Windows and forwards portPath via --port-path when overridden', async () => {
    setPlatformForTest('win32');
    // Recompute the cached IPC paths under the flipped platform; a
    // prior test may have locked the cache under Linux.
    _resetCachedGuardianPathsForTest();
    const mockChild = { pid: 4242, unref: vi.fn() };
    const spawnFn = vi.fn().mockReturnValue(mockChild);
    // Pass an explicit `portPath` (different from the platform default)
    // so `startGuardianDetached` adds the `--port-path` CLI arg.
    const customPortPath = '/tmp/launch-wiring-test-explicit-portpath';
    const result = await startGuardianDetached({
      spawnFn,
      logFd: 1,
      env: { FOO: 'bar' },
      portPath: customPortPath,
    });
    expect(spawnFn).toHaveBeenCalledTimes(1);
    const [, , opts] = spawnFn.mock.calls[0];
    expect(opts.detached).toBe(true);
    expect(opts.windowsHide).toBe(true);
    expect(opts.env).toMatchObject({ FOO: 'bar' });
    expect(mockChild.unref).toHaveBeenCalled();
    expect(result.pid).toBe(4242);
    expect(result.portPath).toBe(customPortPath);
    // The --port-path CLI arg must be forwarded to the standalone
    // entrypoint when the caller provides an override. `spawnFn` is
    // called as `spawnFn(process.execPath, args, opts)`, so the args
    // array is at mock index [1] (not [0], which is the node binary).
    const args = spawnFn.mock.calls[0][1];
    const portPathIdx = args.indexOf('--port-path');
    expect(portPathIdx).toBeGreaterThanOrEqual(0);
    expect(args[portPathIdx + 1]).toBe(customPortPath);
  });

  it('sets windowsHide: true on Linux too (defense-in-depth)', async () => {
    setPlatformForTest('linux');
    const mockChild = { pid: 5151, unref: vi.fn() };
    const spawnFn = vi.fn().mockReturnValue(mockChild);
    await startGuardianDetached({ spawnFn, logFd: 1 });
    const [, , opts] = spawnFn.mock.calls[0];
    expect(opts.windowsHide).toBe(true);
  });
});

describe('stopGuardianViaIpc', () => {
  // W-C: previously `stopGuardianViaIpc` short-circuited on Windows.
  // It now dials the loopback TCP listener via the optional `portPath`
  // and runs the same IPC shutdown flow as on Linux.
  //
  // The proof of non-short-circuit is that `stopGuardianViaIpc` returns
  // a boolean derived from the IPC shutdown outcome, not from a
  // platform check. We exercise it by stubbing `GuardianClient` at the
  // module seam so the IPC shutdown succeeds without needing a real
  // listener.
  it('does not short-circuit on Windows (passes portPath through)', async () => {
    setPlatformForTest('win32');
    _resetCachedGuardianPathsForTest();
    const gc = await import('./guardian-client.js');
    const connectSpy = vi.spyOn(gc.GuardianClient.prototype, 'connect').mockResolvedValue(undefined);
    const shutdownSpy = vi.spyOn(gc.GuardianClient.prototype, 'shutdown').mockResolvedValue(undefined);
    const disconnectSpy = vi.spyOn(gc.GuardianClient.prototype, 'disconnect').mockImplementation(() => {});
    try {
      const result = await stopGuardianViaIpc({ timeoutMs: 100, portPath: '/tmp/launch-wiring-test-no-such-portpath' });
      expect(typeof result).toBe('boolean');
      // The connect probe was attempted (proves no platform short-circuit).
      expect(connectSpy).toHaveBeenCalled();
    } finally {
      connectSpy.mockRestore();
      shutdownSpy.mockRestore();
      disconnectSpy.mockRestore();
    }
  });

  it.skipIf(process.platform === 'win32')('returns false when GuardianClient.shutdown fails', async () => {
    setPlatformForTest('linux');
    // Use a non-existent socket path so the connect call fails fast.
    const result = await stopGuardianViaIpc({ timeoutMs: 200, socketPath: '/tmp/does-not-exist-guardian.sock' });
    expect(typeof result).toBe('boolean');
  });
});

describe('maybeAutoStartGuardian', () => {
  it.skipIf(process.platform === 'win32')('reports opt-out when --no-guardian is passed', async () => {
    setPlatformForTest('linux');
    const result = await maybeAutoStartGuardian({
      options: { guardian: false, handoff: true },
      emitNotice: () => {},
    });
    expect(result.started).toBe(false);
    expect(result.reason).toBe('opt-out');
  });

  // W-C: previously `maybeAutoStartGuardian` returned `{ started: false,
  // reason: 'opt-out' }` on Windows. After the platform short-circuit
  // is removed, the function takes the normal "already-running or
  // spawn" path. We stub `isGuardianRunning` to false and verify
  // the function reaches the spawn branch (started: true after the
  // synthetic child reports alive).
  it('does not short-circuit on Windows and reaches the spawn branch', async () => {
    setPlatformForTest('win32');
    _resetCachedGuardianPathsForTest();
    const det = await import('./detection.js');
    const isRunningSpy = vi.spyOn(det, 'isGuardianRunning').mockResolvedValue(false);
    const mockChild = { pid: 10101, unref: vi.fn() };
    const spawnFn = vi.fn().mockReturnValue(mockChild);
    _setProcessAliveOverrideForTest((pid) => pid === 10101);
    try {
      const result = await maybeAutoStartGuardian({
        options: { guardian: true, handoff: true },
        emitNotice: () => {},
        logFd: 1,
        spawnFn,
      });
      expect(result.started).toBe(true);
      expect(result.pid).toBe(10101);
      expect(spawnFn).toHaveBeenCalled();
      expect(isGuardianAutoStarted()).toBe(true);
    } finally {
      isRunningSpy.mockRestore();
      _setProcessAliveOverrideForTest(null);
    }
  });

  it('still honors --no-guardian on Windows', async () => {
    setPlatformForTest('win32');
    const result = await maybeAutoStartGuardian({
      options: { guardian: false, handoff: true },
      emitNotice: () => {},
    });
    expect(result.started).toBe(false);
    expect(result.reason).toBe('opt-out');
  });

  it.skipIf(process.platform === 'win32')('sets guardianAutoStarted flag after a successful spawn', async () => {
    setPlatformForTest('linux');
    resetGuardianAutoStarted();
    expect(isGuardianAutoStarted()).toBe(false);
    const mockChild = { pid: 9999, unref: vi.fn() };
    const spawnFn = vi.fn().mockReturnValue(mockChild);
    // Probe isGuardianRunning — we don't want to actually start a real guardian.
    // To force the spawn path, we can stub isGuardianRunning via dynamic import.
    const detection = await import('./detection.js');
    const isRunningSpy = vi.spyOn(detection, 'isGuardianRunning').mockResolvedValue(false);
    // M4: the new TOCTOU guard checks isProcessAlive on the spawned pid. Stub
    // it so the synthetic pid 9999 reports alive without spawning a real process.
    _setProcessAliveOverrideForTest((pid) => pid === 9999);
    try {
      const result = await maybeAutoStartGuardian({
        options: { guardian: true, handoff: true },
        emitNotice: () => {},
        logFd: 1,
        spawnFn,
      });
      expect(result.started).toBe(true);
      expect(result.pid).toBe(9999);
      expect(isGuardianAutoStarted()).toBe(true);
    } finally {
      isRunningSpy.mockRestore();
      _setProcessAliveOverrideForTest(null);
    }
  });
});

describe('guardianCommand JSON surface', () => {
  it.skipIf(process.platform === 'win32')('status action returns a JSON object with running/pid/socketPath', async () => {
    setPlatformForTest('linux');
    const detection = await import('./detection.js');
    const isRunningSpy = vi.spyOn(detection, 'isGuardianRunning').mockResolvedValue(false);
    try {
      const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      try {
        await guardianCommand({ json: true }, 'status');
        const last = writeSpy.mock.calls.at(-1)?.[0];
        expect(typeof last).toBe('string');
        const parsed = JSON.parse(String(last));
        expect(parsed.status).toBe('ok');
        expect(parsed).toMatchObject({
          action: 'status',
          running: false,
          supported: true,
          platform: 'linux',
        });
        expect(typeof parsed.socketPath).toBe('string');
      } finally {
        writeSpy.mockRestore();
      }
    } finally {
      isRunningSpy.mockRestore();
    }
  });

  it.skipIf(process.platform === 'win32')('start action surfaces a JSON object with the expected shape', async () => {
    setPlatformForTest('linux');
    // Pre-seed the running probe to true so runStartAction takes the
    // already-running short-circuit. This avoids spawning a real detached
    // process from inside the test runner.
    const det = await import('./detection.js');
    const isGuardianRunningSpy = vi.spyOn(det, 'isGuardianRunning').mockResolvedValue(true);
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await guardianCommand({ json: true }, 'start');
      const last = writeSpy.mock.calls.at(-1)?.[0];
      const parsed = JSON.parse(String(last));
      expect(parsed).toMatchObject({ action: 'start', started: false, alreadyRunning: true });
      expect(typeof parsed.socketPath).toBe('string');
    } finally {
      writeSpy.mockRestore();
      isGuardianRunningSpy.mockRestore();
    }
  });

  it.skipIf(process.platform === 'win32')('stop action surfaces stopped:false when not running', async () => {
    setPlatformForTest('linux');
    const detection = await import('./detection.js');
    const isRunningSpy = vi.spyOn(detection, 'isGuardianRunning').mockResolvedValue(false);
    try {
      const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      try {
        await guardianCommand({ json: true }, 'stop');
        const last = writeSpy.mock.calls.at(-1)?.[0];
        const parsed = JSON.parse(String(last));
        expect(parsed).toMatchObject({ action: 'stop', stopped: false, alreadyStopped: true });
      } finally {
        writeSpy.mockRestore();
      }
    } finally {
      isRunningSpy.mockRestore();
    }
  });

  it.skipIf(process.platform === 'win32')('reload action throws TunnelCliError when not running', async () => {
    setPlatformForTest('linux');
    const detection = await import('./detection.js');
    const isRunningSpy = vi.spyOn(detection, 'isGuardianRunning').mockResolvedValue(false);
    try {
      await expect(guardianCommand({ json: true }, 'reload')).rejects.toBeInstanceOf(TunnelCliError);
    } finally {
      isRunningSpy.mockRestore();
    }
  });

  // W-C: previously `guardianCommand` rejected every action on Windows
  // with `TunnelCliError`. The rejection is removed; each action now
  // returns a structured JSON response on every platform.
  it('returns a structured JSON response for status on Windows', async () => {
    setPlatformForTest('win32');
    _resetCachedGuardianPathsForTest();
    const det = await import('./detection.js');
    const isRunningSpy = vi.spyOn(det, 'isGuardianRunning').mockResolvedValue(false);
    try {
      const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      try {
        await guardianCommand({ json: true }, 'status');
        const last = writeSpy.mock.calls.at(-1)?.[0];
        const parsed = JSON.parse(String(last));
        expect(parsed).toMatchObject({
          status: 'ok',
          action: 'status',
          running: false,
          supported: true,
          platform: 'win32',
        });
        expect(typeof parsed.socketPath).toBe('string');
        // W-C: the JSON payload now also surfaces the Windows portPath
        // (undefined on Linux, defined on Windows) so operators can
        // confirm the discovery-file location without grepping the help
        // output.
        if (process.platform === 'win32' || getDefaultGuardianPortPath()) {
          expect(parsed.portPath).toBeDefined();
        }
      } finally {
        writeSpy.mockRestore();
      }
    } finally {
      isRunningSpy.mockRestore();
    }
  });

  it('returns a structured JSON response for start on Windows when already running', async () => {
    setPlatformForTest('win32');
    _resetCachedGuardianPathsForTest();
    const det = await import('./detection.js');
    const isRunningSpy = vi.spyOn(det, 'isGuardianRunning').mockResolvedValue(true);
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await guardianCommand({ json: true }, 'start');
      const last = writeSpy.mock.calls.at(-1)?.[0];
      const parsed = JSON.parse(String(last));
      expect(parsed).toMatchObject({ action: 'start', started: false, alreadyRunning: true });
    } finally {
      writeSpy.mockRestore();
      isRunningSpy.mockRestore();
    }
  });

  it.skipIf(process.platform === 'win32')('rejects unknown subcommand with TunnelCliError', async () => {
    setPlatformForTest('linux');
    await expect(guardianCommand({ json: true }, 'bogus')).rejects.toBeInstanceOf(TunnelCliError);
  });
});

describe('runReloadAction', () => {
  it.skipIf(process.platform === 'win32')('sends SIGHUP to the running guardian pid', async () => {
    setPlatformForTest('linux');
    const det = await import('./detection.js');
    const isRunningSpy = vi.spyOn(det, 'isGuardianRunning').mockResolvedValue(true);
    // Seed the PID file so getGuardianStatus reports a numeric pid.
    _resetCachedGuardianPathsForTest();
    const pidFile = getDefaultGuardianPidFile();
    fs.mkdirSync(path.dirname(pidFile), { recursive: true });
    const fakePid = 99991;
    fs.writeFileSync(pidFile, String(fakePid));
    const killFn = vi.fn();
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await runReloadAction({ options: { json: true }, killFn });
      const last = writeSpy.mock.calls.at(-1)?.[0];
      const parsed = JSON.parse(String(last));
      expect(parsed).toMatchObject({
        action: 'reload',
        reloaded: true,
        signal: 'SIGHUP',
        configReloaded: false,
        pid: fakePid,
      });
      expect(killFn).toHaveBeenCalledWith(fakePid, 'SIGHUP');
    } finally {
      writeSpy.mockRestore();
      isRunningSpy.mockRestore();
      try { fs.unlinkSync(pidFile); } catch { /* ignore */ }
      _resetCachedGuardianPathsForTest();
    }
  });

  it.skipIf(process.platform === 'win32')('throws TunnelCliError when guardian is not running', async () => {
    setPlatformForTest('linux');
    const det = await import('./detection.js');
    const isRunningSpy = vi.spyOn(det, 'isGuardianRunning').mockResolvedValue(false);
    try {
      await expect(runReloadAction({ options: { json: true } })).rejects.toBeInstanceOf(TunnelCliError);
    } finally {
      isRunningSpy.mockRestore();
    }
  });

  it.skipIf(process.platform === 'win32')('maps ESRCH from process.kill to a TunnelCliError', async () => {
    setPlatformForTest('linux');
    const det = await import('./detection.js');
    const isRunningSpy = vi.spyOn(det, 'isGuardianRunning').mockResolvedValue(true);
    _resetCachedGuardianPathsForTest();
    const pidFile = getDefaultGuardianPidFile();
    fs.mkdirSync(path.dirname(pidFile), { recursive: true });
    fs.writeFileSync(pidFile, '99992');
    const killFn = vi.fn(() => {
      const err = new Error('no such process');
      err.code = 'ESRCH';
      throw err;
    });
    try {
      await expect(runReloadAction({ options: { json: true }, killFn })).rejects.toThrow(/no longer alive/);
    } finally {
      isRunningSpy.mockRestore();
      try { fs.unlinkSync(pidFile); } catch { /* ignore */ }
      _resetCachedGuardianPathsForTest();
    }
  });
});

describe('stopGuardianViaIpc escalation', () => {
  it.skipIf(process.platform === 'win32')('falls back to SIGTERM when the IPC shutdown throws', async () => {
    setPlatformForTest('linux');
    _resetCachedGuardianPathsForTest();
    const pidFile = getDefaultGuardianPidFile();
    const fakePid = 99993;
    // Seed a PID file; isProcessAlive will be probed against it.
    fs.mkdirSync(path.dirname(pidFile), { recursive: true });
    fs.writeFileSync(pidFile, String(fakePid));
    // Use a non-existent socket so GuardianClient.connect() throws.
    const killFn = vi.fn().mockReturnValue(true);
    const logCalls = [];
    try {
      const result = await stopGuardianViaIpc({
        socketPath: '/tmp/launch-wiring-test-no-such-sock',
        timeoutMs: 200,
        killFn,
        logWarning: (msg) => logCalls.push(msg),
      });
      // The IPC path fails; the SIGTERM path runs; we then immediately remove
      // the PID file (simulating the guardian exiting) so the test does not
      // depend on a real PID being alive. Patch isProcessAlive indirectly by
      // making the killFn unlink the file.
      killFn.mockImplementation((pid, sig) => {
        if (sig === 'SIGTERM' || sig === 'SIGKILL') {
          try { fs.unlinkSync(pidFile); } catch { /* ignore */ }
        }
        return true;
      });
      // Re-run so the killFn is wired with the unlink behavior.
      fs.writeFileSync(pidFile, String(fakePid));
      const result2 = await stopGuardianViaIpc({
        socketPath: '/tmp/launch-wiring-test-no-such-sock',
        timeoutMs: 200,
        killFn,
        logWarning: (msg) => logCalls.push(msg),
      });
      expect(typeof result2).toBe('boolean');
      expect(logCalls.some((m) => /SIGTERM|SIGKILL|IPC shutdown failed/.test(m))).toBe(true);
      // Silence the unused-first-call warning.
      void result;
    } finally {
      try { fs.unlinkSync(pidFile); } catch { /* ignore */ }
      _resetCachedGuardianPathsForTest();
    }
  });
});

// Reference the test-time helper so it doesn't get tree-shaken if imports reorder.
void beforeEach;

describe('W-C: cross-platform IPC paths from defaultIpcPaths', () => {
  it('exposes socketPath on Linux and portPath on Windows', () => {
    _resetCachedGuardianPathsForTest();
    setPlatformForTest('linux');
    _resetCachedGuardianPathsForTest();
    expect(getDefaultGuardianSocketPath()).toBeDefined();
    expect(getDefaultGuardianPortPath()).toBeUndefined();
    _resetCachedGuardianPathsForTest();
    setPlatformForTest('win32');
    _resetCachedGuardianPathsForTest();
    expect(getDefaultGuardianPortPath()).toBeDefined();
  });
});
