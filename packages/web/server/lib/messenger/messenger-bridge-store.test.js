import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  MESSENGER_INTERRUPT_TIMEOUT_DEFAULT_MS,
  MESSENGER_INTERRUPT_TIMEOUT_MAX_MS,
  MESSENGER_INTERRUPT_TIMEOUT_MIN_MS,
  MessengerBridgeStore,
} from './messenger-bridge-store.js';

describe('MessengerBridgeStore — permission mode persistence', () => {
  let dbPath;
  let store;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `openchamber-agent-store-${crypto.randomBytes(6).toString('hex')}.sqlite`);
    store = new MessengerBridgeStore({ dbPath });
  });

  afterEach(() => {
    try {
      store.db.close();
    } catch {
      // ignore
    }
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.unlinkSync(dbPath + suffix);
      } catch {
        // ignore
      }
    }
  });

  const surface = { type: 'discord', botTokenHash: 'hash', targetKey: 'chan-1' };

  it('round-trips a per-surface permission mode override', () => {
    store.setOverrides({ ...surface, permissionModeOverride: 'yolo' });
    expect(store.lookup(surface)?.permissionModeOverride).toBe('yolo');

    store.setOverrides({ ...surface, permissionModeOverride: null });
    expect(store.lookup(surface)?.permissionModeOverride).toBeNull();
  });

  it('does not clobber other overrides when only setting the permission mode', () => {
    store.setOverrides({ ...surface, modelOverride: 'anthropic/sonnet', verbosityOverride: 'verbose' });
    store.setOverrides({ ...surface, permissionModeOverride: 'agent' });
    const row = store.lookup(surface);
    expect(row.modelOverride).toBe('anthropic/sonnet');
    expect(row.verbosityOverride).toBe('verbose');
    expect(row.permissionModeOverride).toBe('agent');
  });

  it('round-trips the project-default permission mode', () => {
    store.setProjectDefaults({ projectPath: '/proj', projectLabel: 'Proj', permissionModeDefault: 'yolo' });
    expect(store.getProjectDefaults('/proj')?.permissionModeDefault).toBe('yolo');

    // Setting an unrelated project default preserves the permission mode.
    store.setProjectDefaults({ projectPath: '/proj', modelDefault: 'anthropic/sonnet' });
    const pd = store.getProjectDefaults('/proj');
    expect(pd.permissionModeDefault).toBe('yolo');
    expect(pd.modelDefault).toBe('anthropic/sonnet');
  });

  it('round-trips the project auto-worktree default without clobbering other defaults', () => {
    store.setProjectDefaults({ projectPath: '/proj', projectLabel: 'Proj', autoWorktreeDefault: 1 });
    expect(store.getProjectDefaults('/proj')?.autoWorktreeDefault).toBe(1);

    store.setProjectDefaults({ projectPath: '/proj', agentDefault: 'build' });
    const pd = store.getProjectDefaults('/proj');
    expect(pd.autoWorktreeDefault).toBe(1);
    expect(pd.agentDefault).toBe('build');
  });

  it('round-trips the messenger-wide permission mode default', () => {
    expect(store.getPermissionModeDefault('discord')).toBeNull();
    store.setPermissionModeDefault('discord', 'agent');
    expect(store.getPermissionModeDefault('discord')).toBe('agent');
    store.setPermissionModeDefault('discord', null);
    expect(store.getPermissionModeDefault('discord')).toBeNull();
  });

  it('round-trips the notify-on-complete setting', () => {
    expect(store.getNotifyOnComplete('discord')).toBe(false);
    store.setNotifyOnComplete('discord', true);
    expect(store.getNotifyOnComplete('discord')).toBe(true);
    store.setNotifyOnComplete('discord', false);
    expect(store.getNotifyOnComplete('discord')).toBe(false);
  });

  it('normalizes and persists the interrupt timeout setting', () => {
    expect(store.getInterruptTimeoutMs('discord')).toBe(MESSENGER_INTERRUPT_TIMEOUT_DEFAULT_MS);
    store.setInterruptTimeoutMs('discord', 1234.6);
    expect(store.getInterruptTimeoutMs('discord')).toBe(1235);
    store.setInterruptTimeoutMs('discord', -1);
    expect(store.getInterruptTimeoutMs('discord')).toBe(MESSENGER_INTERRUPT_TIMEOUT_MIN_MS);
    store.setInterruptTimeoutMs('discord', 999999);
    expect(store.getInterruptTimeoutMs('discord')).toBe(MESSENGER_INTERRUPT_TIMEOUT_MAX_MS);
    store.setInterruptTimeoutMs('discord', MESSENGER_INTERRUPT_TIMEOUT_DEFAULT_MS);
    expect(store.getInterruptTimeoutMs('discord')).toBe(MESSENGER_INTERRUPT_TIMEOUT_DEFAULT_MS);
  });
});
