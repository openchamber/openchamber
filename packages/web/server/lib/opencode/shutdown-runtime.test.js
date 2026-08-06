import { afterEach, describe, expect, it, vi } from 'vitest';

import { createGracefulShutdownRuntime } from './shutdown-runtime.js';

const createRuntime = (server, overrides = {}) => createGracefulShutdownRuntime({
  process: { exit: vi.fn() },
  shutdownTimeoutMs: 1000,
  getExitOnShutdown: () => false,
  getIsShuttingDown: () => false,
  setIsShuttingDown: vi.fn(),
  syncToHmrState: vi.fn(),
  openCodeWatcherRuntime: { stop: vi.fn() },
  sessionRuntime: { dispose: vi.fn() },
  scheduledTasksRuntime: { stop: vi.fn() },
  getHealthCheckInterval: () => null,
  clearHealthCheckInterval: vi.fn(),
  getTerminalRuntime: () => null,
  setTerminalRuntime: vi.fn(),
  getMessageStreamRuntime: () => null,
  setMessageStreamRuntime: vi.fn(),
  shouldSkipOpenCodeStop: () => false,
  getOpenCodePort: () => 4096,
  getOpenCodeProcess: () => ({
    isGuardianManaged: true,
    close: vi.fn(),
    stopOwnedOpenCode: vi.fn(async () => true),
  }),
  setOpenCodeProcess: vi.fn(),
  killProcessOnPort: vi.fn(),
  waitForPortRelease: vi.fn(async () => true),
  getServer: () => server,
  getUiAuthController: () => null,
  setUiAuthController: vi.fn(),
  getActiveTunnelController: () => null,
  setActiveTunnelController: vi.fn(),
  tunnelAuthController: { clearActiveTunnel: vi.fn() },
  ...overrides,
});

describe('graceful shutdown runtime', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('clears the server close timeout when the server closes first', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const server = {
      close: vi.fn((callback) => {
        callback();
      }),
    };

    const runtime = createRuntime(server);
    await runtime.gracefulShutdown({ exitProcess: false });

    await vi.advanceTimersByTimeAsync(1000);

    expect(warnSpy).not.toHaveBeenCalledWith('Server close timeout reached, forcing shutdown');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('detaches from a guardian child during restart without stopping or killing it', async () => {
    const setOpenCodeProcess = vi.fn();
    const detach = vi.fn();
    const killProcessOnPort = vi.fn();
    const waitForPortRelease = vi.fn(async () => true);
    const runtime = createRuntime(null, {
      setOpenCodeProcess,
      getOpenCodeProcess: () => ({ isGuardianManaged: true, detach, close: vi.fn() }),
      killProcessOnPort,
      waitForPortRelease,
    });

    await runtime.gracefulShutdown({ exitProcess: false, mode: 'restart' });

    expect(detach).toHaveBeenCalledOnce();
    expect(setOpenCodeProcess).toHaveBeenCalledWith(null);
    expect(killProcessOnPort).not.toHaveBeenCalled();
    expect(waitForPortRelease).not.toHaveBeenCalled();
  });

  it('surfaces an owner-scoped stop failure and preserves the recovery handle', async () => {
    const setOpenCodeProcess = vi.fn();
    const stopOwnedOpenCode = vi.fn(async () => {
      throw new Error('child still running');
    });
    const setIsShuttingDown = vi.fn();
    const killProcessOnPort = vi.fn();
    const waitForPortRelease = vi.fn(async () => true);
    const runtime = createRuntime(null, {
      setOpenCodeProcess,
      setIsShuttingDown,
      getOpenCodeProcess: () => ({ isGuardianManaged: true, stopOwnedOpenCode }),
      killProcessOnPort,
      waitForPortRelease,
    });

    await expect(runtime.gracefulShutdown({ exitProcess: false })).rejects.toThrow('child still running');

    expect(setOpenCodeProcess).not.toHaveBeenCalledWith(null);
    expect(setIsShuttingDown).toHaveBeenLastCalledWith(false);
    expect(killProcessOnPort).not.toHaveBeenCalled();
    expect(waitForPortRelease).not.toHaveBeenCalled();
  });

  it('can retry the same owner-scoped stop after a failed attempt', async () => {
    const setOpenCodeProcess = vi.fn();
    const stopOwnedOpenCode = vi.fn()
      .mockRejectedValueOnce(new Error('first stop failed'))
      .mockResolvedValueOnce(true);
    const openCodeProcess = { isGuardianManaged: true, stopOwnedOpenCode };
    const runtime = createRuntime(null, {
      setOpenCodeProcess,
      getOpenCodeProcess: () => openCodeProcess,
    });

    await expect(runtime.gracefulShutdown({ exitProcess: false })).rejects.toThrow('first stop failed');
    await expect(runtime.gracefulShutdown({ exitProcess: false })).resolves.toBeUndefined();

    expect(stopOwnedOpenCode).toHaveBeenCalledTimes(2);
    expect(setOpenCodeProcess).toHaveBeenCalledWith(null);
  });

  it('uses the explicit owner-scoped stop for a normal shutdown', async () => {
    const stopOwnedOpenCode = vi.fn();
    const close = vi.fn();
    const runtime = createRuntime(null, {
      getOpenCodeProcess: () => ({ isGuardianManaged: true, stopOwnedOpenCode, close }),
    });

    await runtime.gracefulShutdown({ exitProcess: false, mode: 'stop' });

    expect(stopOwnedOpenCode).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
  });
});
