import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { MessengerBridgeStore } from './messenger-bridge-store.js';

describe('MessengerBridgeStore — permission mode persistence', () => {
  let dbPath;
  let store;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `otto-store-${crypto.randomBytes(6).toString('hex')}.sqlite`);
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
    store.setOverrides({ ...surface, permissionModeOverride: 'auto-edit' });
    const row = store.lookup(surface);
    expect(row.modelOverride).toBe('anthropic/sonnet');
    expect(row.verbosityOverride).toBe('verbose');
    expect(row.permissionModeOverride).toBe('auto-edit');
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

  it('round-trips the messenger-wide permission mode default', () => {
    expect(store.getPermissionModeDefault('discord')).toBeNull();
    store.setPermissionModeDefault('discord', 'auto-edit');
    expect(store.getPermissionModeDefault('discord')).toBe('auto-edit');
    store.setPermissionModeDefault('discord', null);
    expect(store.getPermissionModeDefault('discord')).toBeNull();
  });
});
