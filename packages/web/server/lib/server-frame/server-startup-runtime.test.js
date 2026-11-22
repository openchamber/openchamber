import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { createServerStartupRuntime, resolveInheritedListenFd } from './server-startup-runtime.js';

/**
 * The desktop app embeds this server and nothing restarts it, so shutting down
 * on a single uncaught exception turned every stray socket error into "the
 * instance is unreachable until restarted". Only a sustained storm shuts down.
 */
describe('uncaught exception policy', () => {
  const setup = () => {
    const fakeProcess = new EventEmitter();
    let shutdowns = 0;
    const runtime = createServerStartupRuntime({
      process: fakeProcess,
      gracefulShutdown: () => { shutdowns += 1; },
      getSignalsAttached: () => true,
      setSignalsAttached: () => {},
      syncToHmrState: () => {},
    });
    runtime.attachProcessHandlers({ attachSignals: false });
    return { fakeProcess, shutdowns: () => shutdowns };
  };

  test('a single uncaught exception keeps the server running', () => {
    const { fakeProcess, shutdowns } = setup();
    fakeProcess.emit('uncaughtException', new Error('setTypeOfService EINVAL'));
    expect(shutdowns()).toBe(0);
  });

  test('a storm of uncaught exceptions still shuts down', () => {
    const { fakeProcess, shutdowns } = setup();
    for (let i = 0; i < 11; i += 1) {
      fakeProcess.emit('uncaughtException', new Error(`stray ${i}`));
    }
    expect(shutdowns()).toBeGreaterThan(0);
  });

  test('an unhandled rejection is logged without shutting down', () => {
    const { fakeProcess, shutdowns } = setup();
    fakeProcess.emit('unhandledRejection', new Error('late failure'), Promise.resolve());
    expect(shutdowns()).toBe(0);
  });
});

describe('signal handling', () => {
  const setup = ({ reloadOpenCodeConfiguration = async () => {} } = {}) => {
    const fakeProcess = new EventEmitter();
    const stops = [];
    let reloads = 0;
    const runtime = createServerStartupRuntime({
      process: fakeProcess,
      gracefulShutdown: async (options) => { stops.push(options); },
      reloadOpenCodeConfiguration: async () => {
        reloads += 1;
        await reloadOpenCodeConfiguration();
      },
      getSignalsAttached: () => false,
      setSignalsAttached: () => {},
      syncToHmrState: () => {},
    });
    runtime.attachProcessHandlers({ attachSignals: true });
    return { fakeProcess, stops, reloads: () => reloads };
  };

  test('SIGHUP reloads configuration and never shuts down', async () => {
    const { fakeProcess, stops, reloads } = setup();
    fakeProcess.emit('SIGHUP');
    await new Promise((resolve) => setImmediate(resolve));
    expect(reloads()).toBe(1);
    expect(stops).toEqual([]);
  });

  test('a failed SIGHUP reload is logged and the server keeps running', async () => {
    const errors = [];
    const originalError = console.error;
    console.error = (...args) => errors.push(args);
    try {
      const { fakeProcess, stops } = setup({ reloadOpenCodeConfiguration: async () => { throw new Error('bad settings'); } });
      fakeProcess.emit('SIGHUP');
      await new Promise((resolve) => setImmediate(resolve));
      expect(stops).toEqual([]);
      expect(errors.length).toBe(1);
    } finally {
      console.error = originalError;
    }
  });

  test('SIGTERM drains and keeps OpenCode running', () => {
    const { fakeProcess, stops } = setup();
    fakeProcess.emit('SIGTERM');
    expect(stops).toEqual([{ keepOpenCode: true }]);
  });

  test.each(['SIGINT', 'SIGQUIT', 'SIGUSR2'])('%s stops OpenCode with the server', (signal) => {
    const { fakeProcess, stops } = setup();
    fakeProcess.emit(signal);
    expect(stops).toEqual([undefined]);
  });
});

describe('socket activation', () => {
  test('adopts fd 3 only when systemd addresses this process', () => {
    expect(resolveInheritedListenFd({ LISTEN_PID: '77', LISTEN_FDS: '1' }, 77)).toBe(3);
    expect(resolveInheritedListenFd({ LISTEN_PID: '78', LISTEN_FDS: '1' }, 77)).toBeNull();
    expect(resolveInheritedListenFd({ LISTEN_PID: '77', LISTEN_FDS: '0' }, 77)).toBeNull();
    expect(resolveInheritedListenFd({}, 77)).toBeNull();
  });

  test('listens on the inherited socket and clears the activation variables', async () => {
    const env = { LISTEN_PID: '77', LISTEN_FDS: '1' };
    const fakeProcess = new EventEmitter();
    fakeProcess.env = env;
    fakeProcess.pid = 77;
    const listenCalls = [];
    const fakeServer = {
      once() {},
      off() {},
      address: () => ({ port: 4321 }),
      listen(...args) {
        listenCalls.push(args);
        const callback = args[args.length - 1];
        queueMicrotask(callback);
      },
    };
    const runtime = createServerStartupRuntime({
      process: fakeProcess,
      server: fakeServer,
      gracefulShutdown: () => {},
      getSignalsAttached: () => false,
      setSignalsAttached: () => {},
      syncToHmrState: () => {},
    });
    const { activePort } = await runtime.startListeningAndMaybeTunnel({ port: 0, bindHost: '127.0.0.1' });
    expect(listenCalls).toEqual([[{ fd: 3 }, expect.any(Function)]]);
    expect(activePort).toBe(4321);
    expect(env).not.toHaveProperty('LISTEN_FDS');
    expect(env).not.toHaveProperty('LISTEN_PID');
  });

  test('binds the configured port when no socket is inherited', async () => {
    const fakeProcess = new EventEmitter();
    fakeProcess.env = {};
    fakeProcess.pid = 77;
    const listenCalls = [];
    const fakeServer = {
      once() {},
      off() {},
      address: () => ({ port: 4321 }),
      listen(...args) {
        listenCalls.push(args.slice(0, 2));
        queueMicrotask(args[args.length - 1]);
      },
    };
    const runtime = createServerStartupRuntime({
      process: fakeProcess,
      server: fakeServer,
      gracefulShutdown: () => {},
      getSignalsAttached: () => false,
      setSignalsAttached: () => {},
      syncToHmrState: () => {},
    });
    await runtime.startListeningAndMaybeTunnel({ port: 4321, bindHost: '127.0.0.1' });
    expect(listenCalls).toEqual([[4321, '127.0.0.1']]);
  });
});
