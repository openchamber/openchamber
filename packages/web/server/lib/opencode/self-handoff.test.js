import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HANDOFF_FROM_ENV,
  HANDOFF_READY_MESSAGE,
  buildSuccessorCommand,
  createSelfHandoffRuntime,
  isSelfHandoffEnabled,
  notifySystemdReady,
  resolveHandoffTimeoutMs,
  takeHandoffPredecessor,
  waitUntilServing,
} from './self-handoff.js';

// Unit-level checks of the handoff decisions. The real-process behaviour is in self-handoff-process.test.js.

const fakeServer = () => ({
  listening: true,
  address: () => ({ port: 4321, address: '127.0.0.1' }),
  _handle: { fd: 21 },
});

// A child that is ready when told to be, exits when signalled, and records what the runtime did with it.
const fakeChild = ({ pid = 424242, readyAfterMs = null, exitAfterMs = null } = {}) => {
  const child = new EventEmitter();
  child.pid = pid;
  child.connected = true;
  child.exitCode = null;
  child.signalCode = null;
  child.disconnect = vi.fn(() => { child.connected = false; });
  child.unref = vi.fn();
  if (readyAfterMs !== null) setTimeout(() => child.emit('message', { type: HANDOFF_READY_MESSAGE, pid }), readyAfterMs);
  if (exitAfterMs !== null) setTimeout(() => { child.exitCode = 0; child.emit('exit', 0, null); }, exitAfterMs);
  return child;
};

const createRuntime = (overrides = {}) => {
  const gracefulShutdown = vi.fn(async () => {});
  const log = { log: vi.fn(), warn: vi.fn() };
  const runtime = createSelfHandoffRuntime({
    process: { pid: 1001, execPath: '/usr/bin/node', execArgv: [] },
    getServer: () => fakeServer(),
    spawn: vi.fn(),
    gracefulShutdown,
    isShuttingDown: () => false,
    entry: '/opt/openchamber/bin/cli.js',
    env: {},
    timeoutMs: 1000,
    log,
    ...overrides,
  });
  return { runtime, gracefulShutdown, log };
};

describe('buildSuccessorCommand', () => {
  it('starts the same CLI in foreground with LISTEN_PID naming the successor and fd 3 as the listener', () => {
    const { command, args } = buildSuccessorCommand({ execPath: '/usr/bin/node', execArgv: ['--no-warnings'], entry: '/x/cli.js', port: 3000, host: '127.0.0.1', apiOnly: true });
    expect(command).toBe('/bin/sh');
    expect(args[1]).toBe('export LISTEN_PID=$$ LISTEN_FDS=1; exec "$@"');
    expect(args.slice(3)).toEqual(['/usr/bin/node', '--no-warnings', '/x/cli.js', 'serve', '--foreground', '--port', '3000', '--host', '127.0.0.1', '--api-only']);
  });

  it('leaves out --api-only unless the predecessor runs API-only', () => {
    const { args } = buildSuccessorCommand({ execPath: 'node', execArgv: [], entry: 'cli.js', port: 1, host: '::1', apiOnly: false });
    expect(args).not.toContain('--api-only');
  });
});

describe('takeHandoffPredecessor', () => {
  it('reads the predecessor pid once and removes it so OpenCode does not inherit it', () => {
    const env = { [HANDOFF_FROM_ENV]: '777' };
    expect(takeHandoffPredecessor(env)).toBe(777);
    expect(env).not.toHaveProperty(HANDOFF_FROM_ENV);
    expect(takeHandoffPredecessor(env)).toBeNull();
  });

  it('drops a malformed value rather than trusting it', () => {
    const env = { [HANDOFF_FROM_ENV]: 'not-a-pid' };
    expect(takeHandoffPredecessor(env)).toBeNull();
    expect(env).not.toHaveProperty(HANDOFF_FROM_ENV);
  });
});

describe('handoff settings', () => {
  it('defaults the timeout and rejects invalid values', () => {
    expect(resolveHandoffTimeoutMs({})).toBe(30_000);
    expect(resolveHandoffTimeoutMs({ OPENCHAMBER_HANDOFF_TIMEOUT_MS: '250' })).toBe(250);
    expect(resolveHandoffTimeoutMs({ OPENCHAMBER_HANDOFF_TIMEOUT_MS: '0' })).toBe(30_000);
    expect(resolveHandoffTimeoutMs({ OPENCHAMBER_HANDOFF_TIMEOUT_MS: 'soon' })).toBe(30_000);
  });

  it('falls back to the default for exponent, hex, signed, and decimal-point spellings', () => {
    expect(resolveHandoffTimeoutMs({ OPENCHAMBER_HANDOFF_TIMEOUT_MS: '1e3' })).toBe(30_000);
    expect(resolveHandoffTimeoutMs({ OPENCHAMBER_HANDOFF_TIMEOUT_MS: '0x10' })).toBe(30_000);
    expect(resolveHandoffTimeoutMs({ OPENCHAMBER_HANDOFF_TIMEOUT_MS: '+5000' })).toBe(30_000);
    expect(resolveHandoffTimeoutMs({ OPENCHAMBER_HANDOFF_TIMEOUT_MS: '5000.0' })).toBe(30_000);
    expect(resolveHandoffTimeoutMs({ OPENCHAMBER_HANDOFF_TIMEOUT_MS: '5000' })).toBe(5000);
  });

  it('falls back to the default above the timer maximum and for unsafe integers', () => {
    expect(resolveHandoffTimeoutMs({ OPENCHAMBER_HANDOFF_TIMEOUT_MS: '2147483647' })).toBe(2_147_483_647);
    expect(resolveHandoffTimeoutMs({ OPENCHAMBER_HANDOFF_TIMEOUT_MS: '3000000000' })).toBe(30_000);
    expect(resolveHandoffTimeoutMs({ OPENCHAMBER_HANDOFF_TIMEOUT_MS: '9007199254740993' })).toBe(30_000);
  });

  it('is on unless OPENCHAMBER_SELF_HANDOFF is 0', () => {
    expect(isSelfHandoffEnabled({})).toBe(true);
    expect(isSelfHandoffEnabled({ OPENCHAMBER_SELF_HANDOFF: '1' })).toBe(true);
    expect(isSelfHandoffEnabled({ OPENCHAMBER_SELF_HANDOFF: '0' })).toBe(false);
  });
});

describe('notifySystemdReady', () => {
  it('does nothing outside systemd', () => {
    const run = vi.fn();
    expect(notifySystemdReady({ pid: 42, env: {}, run })).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it('sends READY and the main pid through systemd-notify when NOTIFY_SOCKET is set', () => {
    const run = vi.fn(() => ({ status: 0 }));
    expect(notifySystemdReady({ pid: 42, env: { NOTIFY_SOCKET: '/run/systemd/notify' }, run })).toBe(true);
    expect(run).toHaveBeenCalledWith('systemd-notify', ['--ready', '--pid=42'], expect.objectContaining({ env: { NOTIFY_SOCKET: '/run/systemd/notify' } }));
  });
});

describe('waitUntilServing', () => {
  it('resolves on the first poll where the check holds', async () => {
    let calls = 0;
    await waitUntilServing(() => { calls += 1; return calls >= 3; }, { intervalMs: 1 });
    expect(calls).toBe(3);
  });
});

describe('createSelfHandoffRuntime', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stops the predecessor only after the successor reports ready, keeping OpenCode', async () => {
    const child = fakeChild({ readyAfterMs: 5 });
    const { runtime, gracefulShutdown } = createRuntime({ spawn: vi.fn(() => child) });

    const result = await runtime.requestHandoff({ exitProcess: false });

    expect(result).toEqual({ ok: true, successorPid: child.pid });
    expect(gracefulShutdown).toHaveBeenCalledWith({ exitProcess: false, keepOpenCode: true, handoff: true });
    expect(child.disconnect).toHaveBeenCalled();
    expect(child.unref).toHaveBeenCalled();
  });

  it('spawns the successor with the listener at fd 3 and an IPC channel, and the predecessor pid in its environment', async () => {
    const child = fakeChild({ readyAfterMs: 5 });
    const spawn = vi.fn(() => child);
    const { runtime } = createRuntime({ spawn });

    await runtime.requestHandoff({ exitProcess: false });

    const [command, args, options] = spawn.mock.calls[0];
    expect(command).toBe('/bin/sh');
    expect(args).toContain('/opt/openchamber/bin/cli.js');
    expect(options.stdio).toEqual(['ignore', 'inherit', 'inherit', 21, 'ipc']);
    expect(options.detached).toBe(true);
    expect(options.env[HANDOFF_FROM_ENV]).toBe('1001');
  });

  it('keeps serving and stops the successor when it exits before reporting ready', async () => {
    const child = fakeChild({ exitAfterMs: 5 });
    const { runtime, gracefulShutdown, log } = createRuntime({ spawn: vi.fn(() => child) });

    const result = await runtime.requestHandoff({ exitProcess: false });

    expect(result).toEqual(expect.objectContaining({ ok: false, reason: 'exited' }));
    expect(gracefulShutdown).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('still serving'));
  });

  it('keeps serving and stops the successor when it is not ready in time', async () => {
    // SIGTERM is simulated as the exit that follows it, so the terminate step returns without a real kill.
    const child = fakeChild();
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      setTimeout(() => { child.exitCode = null; child.signalCode = 'SIGTERM'; child.emit('exit', null, 'SIGTERM'); }, 5);
      return true;
    });
    const { runtime, gracefulShutdown } = createRuntime({ spawn: vi.fn(() => child), timeoutMs: 20 });

    try {
      const result = await runtime.requestHandoff({ exitProcess: false });
      expect(result).toEqual({ ok: false, reason: 'timeout' });
      expect(gracefulShutdown).not.toHaveBeenCalled();
      expect(kill).toHaveBeenCalledWith(-child.pid, 'SIGTERM');
    } finally {
      kill.mockRestore();
    }
  });

  it('does nothing when handoff is disabled', async () => {
    const spawn = vi.fn();
    const { runtime } = createRuntime({ spawn, env: { OPENCHAMBER_SELF_HANDOFF: '0' } });

    expect(await runtime.requestHandoff()).toEqual({ ok: false, reason: 'disabled' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('refuses when the server is not listening', async () => {
    const spawn = vi.fn();
    const { runtime } = createRuntime({ spawn, getServer: () => ({ listening: false }) });

    expect(await runtime.requestHandoff()).toEqual({ ok: false, reason: 'not-listening' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('refuses, and says why, when the runtime does not expose the listening socket (Bun)', async () => {
    const spawn = vi.fn();
    const server = { listening: true, address: () => ({ port: 4321, address: '127.0.0.1' }), _handle: {} };
    const { runtime, log } = createRuntime({ spawn, getServer: () => server });

    expect(await runtime.requestHandoff()).toEqual({ ok: false, reason: 'no-listener-fd' });
    expect(spawn).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('not reachable'));
  });

  it('starts one successor for concurrent requests', async () => {
    const child = fakeChild({ readyAfterMs: 5 });
    const spawn = vi.fn(() => child);
    const { runtime } = createRuntime({ spawn });

    const [first, second] = await Promise.all([runtime.requestHandoff({ exitProcess: false }), runtime.requestHandoff({ exitProcess: false })]);

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
  });
});
