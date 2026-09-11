import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { createServerStartupRuntime } from './server-startup-runtime.js';

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
