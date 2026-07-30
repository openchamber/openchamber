import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  getUpdateMaintenancePath,
  readActiveUpdateMaintenance,
  reserveUpdateMaintenance,
  shouldDeferStartForUpdate,
} from './maintenance.js';

describe('update maintenance marker', () => {
  it('allows only the intended daemon or post-install foreground restart', () => {
    expect(shouldDeferStartForUpdate({ id: 'tx-1' }, {})).toBe(true);
    expect(shouldDeferStartForUpdate({ id: 'tx-1' }, { transactionId: 'tx-1' })).toBe(false);
    expect(shouldDeferStartForUpdate({ id: 'tx-1', allowForegroundRestart: true }, { foreground: true })).toBe(false);
    expect(shouldDeferStartForUpdate({ id: 'tx-1', allowForegroundRestart: true }, { foreground: false })).toBe(true);
  });

  it('returns a fresh marker while its helper process is alive', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-update-marker-'));
    try {
      const markerPath = getUpdateMaintenancePath(directory);
      fs.mkdirSync(path.dirname(markerPath), { recursive: true });
      fs.writeFileSync(markerPath, JSON.stringify({
        id: 'transaction-1',
        helperPid: 123,
        createdAt: new Date().toISOString(),
      }));
      const processLike = { kill: vi.fn() };

      expect(readActiveUpdateMaintenance({ openchamberDataDir: directory, processLike })).toMatchObject({
        id: 'transaction-1',
        helperPid: 123,
      });
      expect(processLike.kill).toHaveBeenCalledWith(123, 0);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('removes a marker whose helper is no longer running', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-update-marker-'));
    try {
      const markerPath = getUpdateMaintenancePath(directory);
      fs.mkdirSync(path.dirname(markerPath), { recursive: true });
      fs.writeFileSync(markerPath, JSON.stringify({
        id: 'transaction-1',
        ownerPid: 123,
        createdAt: new Date().toISOString(),
      }));
      const processLike = { kill: vi.fn(() => { throw new Error('not running'); }) };

      expect(readActiveUpdateMaintenance({ openchamberDataDir: directory, processLike })).toBeNull();
      expect(fs.existsSync(markerPath)).toBe(false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps startup blocked when a helper dies during package replacement', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-update-marker-'));
    try {
      const markerPath = getUpdateMaintenancePath(directory);
      const statusPath = path.join(directory, 'updates', 'transaction-1', 'status.json');
      fs.mkdirSync(path.dirname(markerPath), { recursive: true });
      fs.mkdirSync(path.dirname(statusPath), { recursive: true });
      fs.writeFileSync(statusPath, JSON.stringify({
        id: 'transaction-1',
        state: 'installing',
        targetVersion: '1.2.3',
      }));
      fs.writeFileSync(markerPath, JSON.stringify({
        id: 'transaction-1',
        helperPid: 123,
        statusPath,
        createdAt: new Date().toISOString(),
      }));

      expect(readActiveUpdateMaintenance({
        openchamberDataDir: directory,
        processLike: { kill: vi.fn(() => { throw new Error('dead'); }) },
      })).toMatchObject({
        id: 'transaction-1',
        requiresRecovery: true,
        recoveryTargetVersion: '1.2.3',
      });
      expect(fs.existsSync(markerPath)).toBe(true);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('atomically rejects a second update reservation', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-update-marker-'));
    try {
      const processLike = { kill: vi.fn() };
      reserveUpdateMaintenance({
        openchamberDataDir: directory,
        processLike,
        marker: { id: 'transaction-1', ownerPid: 123, createdAt: new Date().toISOString() },
      });

      expect(() => reserveUpdateMaintenance({
        openchamberDataDir: directory,
        processLike,
        marker: { id: 'transaction-2', ownerPid: 456, createdAt: new Date().toISOString() },
      })).toThrow('already in progress');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('deletes an orphaned one-shot request with a dead reservation owner', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-update-marker-'));
    try {
      const requestPath = path.join(directory, 'updates', 'transaction-1', 'request.json');
      fs.mkdirSync(path.dirname(requestPath), { recursive: true });
      fs.writeFileSync(requestPath, 'secret');
      reserveUpdateMaintenance({
        openchamberDataDir: directory,
        processLike: { kill: vi.fn() },
        marker: {
          id: 'transaction-1',
          ownerPid: 123,
          requestPath,
          createdAt: new Date().toISOString(),
        },
      });

      expect(readActiveUpdateMaintenance({
        openchamberDataDir: directory,
        processLike: { kill: vi.fn(() => { throw new Error('dead'); }) },
      })).toBeNull();
      expect(fs.existsSync(requestPath)).toBe(false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
