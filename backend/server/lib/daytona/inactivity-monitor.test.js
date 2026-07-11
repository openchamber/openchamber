import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createInactivityMonitor } from './inactivity-monitor.js';
import { createSandboxRegistry } from './sandbox-registry.js';

/**
 * Flush pending microtasks/promises. With fake timers, we cannot use
 * setImmediate/setTimeout-based flush, so we resolve a plain microtask.
 */
const flushMicrotasks = () => vi.waitFor(() => {});

describe('createInactivityMonitor', () => {
  let registry;
  let lifecycle;
  let monitor;
  let onTimeoutSpy;
  let logger;

  beforeEach(() => {
    vi.useFakeTimers();

    registry = createSandboxRegistry();
    lifecycle = {
      destroySandbox: vi.fn(async () => {}),
    };
    onTimeoutSpy = vi.fn();
    logger = {
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    monitor = createInactivityMonitor({
      registry,
      lifecycle,
      config: { timeoutMs: 600_000 }, // 10 minutes
      logger,
      onTimeout: onTimeoutSpy,
    });
  });

  afterEach(() => {
    monitor.dispose();
    vi.useRealTimers();
  });

  it('start() begins the check interval', () => {
    monitor.start();
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining('Inactivity monitor started')
    );
  });

  it('calls onTimeout callback after a sandbox exceeds the timeout', async () => {
    registry.register('session-1', {
      sandboxId: 'sbx-123',
      openCodeUrl: 'http://localhost:4000',
    });

    monitor.start();

    // Advance past timeout + one check interval (30s) to trigger a sweep
    await vi.advanceTimersByTimeAsync(630_001);

    expect(lifecycle.destroySandbox).toHaveBeenCalledWith('session-1');
    expect(onTimeoutSpy).toHaveBeenCalledWith('session-1', 'sbx-123');
  });

  it('resetTimer() prevents timeout from triggering', async () => {
    registry.register('session-1', {
      sandboxId: 'sbx-123',
      openCodeUrl: 'http://localhost:4000',
    });

    monitor.start();

    // Advance 500s (less than timeout)
    await vi.advanceTimersByTimeAsync(500_000);

    // Reset the timer (updates lastActivityAt in the registry)
    monitor.resetTimer('session-1');

    // Advance another 200s (700s total from start, but only 200s from reset)
    await vi.advanceTimersByTimeAsync(200_000);

    // Should NOT have been destroyed since we reset the timer
    expect(lifecycle.destroySandbox).not.toHaveBeenCalled();
    expect(onTimeoutSpy).not.toHaveBeenCalled();
  });

  it('stop() clears the interval', async () => {
    registry.register('session-1', {
      sandboxId: 'sbx-123',
      openCodeUrl: 'http://localhost:4000',
    });

    monitor.start();
    monitor.stop();

    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining('Inactivity monitor stopped')
    );

    // Advance time well past the timeout
    await vi.advanceTimersByTimeAsync(900_000);

    // Should not trigger because monitor was stopped
    expect(lifecycle.destroySandbox).not.toHaveBeenCalled();
  });

  it('dispose() cleans up everything', () => {
    monitor.start();
    monitor.dispose();

    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining('Inactivity monitor stopped')
    );
  });

  it('does not destroy a sandbox that has recent activity', async () => {
    registry.register('session-1', {
      sandboxId: 'sbx-123',
      openCodeUrl: 'http://localhost:4000',
    });

    monitor.start();

    // Advance only 330s (less than timeout of 600s)
    await vi.advanceTimersByTimeAsync(330_000);

    expect(lifecycle.destroySandbox).not.toHaveBeenCalled();
  });

  it('handles errors from lifecycle.destroySandbox gracefully', async () => {
    registry.register('session-1', {
      sandboxId: 'sbx-123',
      openCodeUrl: 'http://localhost:4000',
    });

    lifecycle.destroySandbox.mockRejectedValueOnce(new Error('API error'));

    monitor.start();

    // Advance past timeout + check interval
    await vi.advanceTimersByTimeAsync(630_001);

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to destroy inactive sandbox')
    );
    // onTimeout is still called even if destroy fails
    expect(onTimeoutSpy).toHaveBeenCalledWith('session-1', 'sbx-123');
  });
});
