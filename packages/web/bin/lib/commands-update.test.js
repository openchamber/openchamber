import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';

import { createUpdateCommand } from './commands-update.js';

async function withTempOpenChamberDataDir(fn) {
  const previous = process.env.OPENCHAMBER_DATA_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-update-test-'));
  process.env.OPENCHAMBER_DATA_DIR = dir;
  try {
    return await fn(dir);
  } finally {
    if (typeof previous === 'string') {
      process.env.OPENCHAMBER_DATA_DIR = previous;
    } else {
      delete process.env.OPENCHAMBER_DATA_DIR;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('update command', () => {
  it('uses the package-manager helpers on the update-available path', async () => {
    await withTempOpenChamberDataDir(async () => {
      const originalWrite = process.stdout.write;
      process.stdout.write = vi.fn(() => true);
      const executeUpdate = vi.fn(() => ({ success: true, exitCode: 0 }));
      const updateCommand = createUpdateCommand({
        packageManagerPath: '/fake/package-manager.js',
        serveCommand: vi.fn(),
        importFromFilePath: vi.fn(async () => ({
          checkForUpdates: vi.fn(async () => ({ available: true, version: '9.9.9' })),
          detectPackageManager: vi.fn(() => 'npm'),
          executeUpdate,
          getCurrentVersion: vi.fn(() => '1.0.0'),
        })),
      });

      try {
        await updateCommand({ json: true });

        expect(executeUpdate).toHaveBeenCalledWith('npm', { silent: true, targetVersion: '9.9.9' });
      } finally {
        process.stdout.write = originalWrite;
      }
    });
  });

  it('repairs an interrupted update and clears its maintenance gate only after success', async () => {
    await withTempOpenChamberDataDir(async (directory) => {
      const originalWrite = process.stdout.write;
      process.stdout.write = vi.fn(() => true);
      const markerPath = path.join(directory, 'run', 'openchamber-update.lock', 'marker.json');
      fs.mkdirSync(path.dirname(markerPath), { recursive: true });
      fs.writeFileSync(markerPath, JSON.stringify({
        id: 'interrupted-update',
        requiresRecovery: true,
        recoveryTargetVersion: '9.9.9',
        createdAt: new Date().toISOString(),
      }));
      const executeUpdate = vi.fn(() => ({ success: true, exitCode: 0 }));
      const checkForUpdates = vi.fn();
      const getCurrentVersion = vi.fn()
        .mockReturnValueOnce('unknown')
        .mockReturnValueOnce('9.9.9');
      const updateCommand = createUpdateCommand({
        packageManagerPath: '/fake/package-manager.js',
        serveCommand: vi.fn(),
        importFromFilePath: vi.fn(async () => ({
          checkForUpdates,
          detectPackageManager: vi.fn(() => 'npm'),
          executeUpdate,
          getCurrentVersion,
        })),
      });

      try {
        await updateCommand({ json: true });

        expect(checkForUpdates).not.toHaveBeenCalled();
        expect(executeUpdate).toHaveBeenCalledWith('npm', { silent: true, targetVersion: '9.9.9' });
        expect(fs.existsSync(markerPath)).toBe(false);
      } finally {
        process.stdout.write = originalWrite;
      }
    });
  });

  it('keeps the maintenance gate when interrupted-update repair fails', async () => {
    await withTempOpenChamberDataDir(async (directory) => {
      const markerPath = path.join(directory, 'run', 'openchamber-update.lock', 'marker.json');
      fs.mkdirSync(path.dirname(markerPath), { recursive: true });
      fs.writeFileSync(markerPath, JSON.stringify({
        id: 'interrupted-update',
        requiresRecovery: true,
        recoveryTargetVersion: '9.9.9',
        createdAt: new Date().toISOString(),
      }));
      const updateCommand = createUpdateCommand({
        packageManagerPath: '/fake/package-manager.js',
        serveCommand: vi.fn(),
        importFromFilePath: vi.fn(async () => ({
          checkForUpdates: vi.fn(),
          detectPackageManager: vi.fn(() => 'npm'),
          executeUpdate: vi.fn(() => ({ success: false, exitCode: 1 })),
          getCurrentVersion: vi.fn(() => 'unknown'),
        })),
      });

      await expect(updateCommand({ quiet: true })).rejects.toThrow('Update failed with exit code 1');
      expect(fs.existsSync(markerPath)).toBe(true);
    });
  });

  it('keeps the maintenance gate when repair does not install the pinned version', async () => {
    await withTempOpenChamberDataDir(async (directory) => {
      const markerPath = path.join(directory, 'run', 'openchamber-update.lock', 'marker.json');
      fs.mkdirSync(path.dirname(markerPath), { recursive: true });
      fs.writeFileSync(markerPath, JSON.stringify({
        id: 'interrupted-update',
        requiresRecovery: true,
        recoveryTargetVersion: '9.9.9',
        createdAt: new Date().toISOString(),
      }));
      const getCurrentVersion = vi.fn()
        .mockReturnValueOnce('unknown')
        .mockReturnValueOnce('9.9.8');
      const updateCommand = createUpdateCommand({
        packageManagerPath: '/fake/package-manager.js',
        serveCommand: vi.fn(),
        importFromFilePath: vi.fn(async () => ({
          checkForUpdates: vi.fn(),
          detectPackageManager: vi.fn(() => 'npm'),
          executeUpdate: vi.fn(() => ({ success: true, exitCode: 0 })),
          getCurrentVersion,
        })),
      });

      await expect(updateCommand({ quiet: true })).rejects.toThrow('installed 9.9.8, expected 9.9.9');
      expect(fs.existsSync(markerPath)).toBe(true);
    });
  });
});
