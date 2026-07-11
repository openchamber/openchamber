import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createSandboxRegistry } from './sandbox-registry.js';

describe('createSandboxRegistry', () => {
  let registry;

  beforeEach(() => {
    registry = createSandboxRegistry();
  });

  it('register() adds an entry that can be retrieved with get()', () => {
    registry.register('session-1', {
      sandboxId: 'sbx-abc',
      openCodeUrl: 'http://localhost:4000',
    });

    const entry = registry.get('session-1');
    expect(entry).not.toBeNull();
    expect(entry.sandboxId).toBe('sbx-abc');
    expect(entry.sessionId).toBe('session-1');
    expect(entry.openCodeUrl).toBe('http://localhost:4000');
    expect(entry.status).toBe('active');
    expect(entry.createdAt).toBeTypeOf('number');
    expect(entry.lastActivityAt).toBeTypeOf('number');
  });

  it('unregister() removes the entry', () => {
    registry.register('session-1', {
      sandboxId: 'sbx-abc',
      openCodeUrl: 'http://localhost:4000',
    });

    const removed = registry.unregister('session-1');
    expect(removed).not.toBeNull();
    expect(removed.sandboxId).toBe('sbx-abc');

    const entry = registry.get('session-1');
    expect(entry).toBeNull();
  });

  it('unregister() returns null for unknown sessionId', () => {
    const result = registry.unregister('nonexistent');
    expect(result).toBeNull();
  });

  it('get() returns null for unknown sessionId', () => {
    const entry = registry.get('unknown-session');
    expect(entry).toBeNull();
  });

  it('updateActivity() updates the lastActivityAt timestamp', () => {
    registry.register('session-1', {
      sandboxId: 'sbx-abc',
      openCodeUrl: 'http://localhost:4000',
    });

    const before = registry.get('session-1').lastActivityAt;

    // Advance time slightly
    vi.useFakeTimers();
    vi.advanceTimersByTime(1000);

    registry.updateActivity('session-1');
    const after = registry.get('session-1').lastActivityAt;

    expect(after).toBeGreaterThan(before);
    vi.useRealTimers();
  });

  it('updateActivity() does nothing for unknown sessionId', () => {
    // Should not throw
    expect(() => registry.updateActivity('nonexistent')).not.toThrow();
  });

  it('listActive() returns only entries with status === "active"', () => {
    registry.register('session-1', {
      sandboxId: 'sbx-1',
      openCodeUrl: 'http://localhost:4001',
    });
    registry.register('session-2', {
      sandboxId: 'sbx-2',
      openCodeUrl: 'http://localhost:4002',
    });

    // Manually change one entry's status to simulate a stopped sandbox
    const entry = registry.get('session-2');
    entry.status = 'stopped';

    const active = registry.listActive();
    expect(active).toHaveLength(1);
    expect(active[0].sessionId).toBe('session-1');
  });

  it('getAll() returns all entries as a Map', () => {
    registry.register('session-1', {
      sandboxId: 'sbx-1',
      openCodeUrl: 'http://localhost:4001',
    });
    registry.register('session-2', {
      sandboxId: 'sbx-2',
      openCodeUrl: 'http://localhost:4002',
    });

    const all = registry.getAll();
    expect(all).toBeInstanceOf(Map);
    expect(all.size).toBe(2);
    expect(all.has('session-1')).toBe(true);
    expect(all.has('session-2')).toBe(true);
  });

  it('register() sets openCodeUrl to null when not provided', () => {
    registry.register('session-1', {
      sandboxId: 'sbx-abc',
    });

    const entry = registry.get('session-1');
    expect(entry.openCodeUrl).toBeNull();
  });
});
