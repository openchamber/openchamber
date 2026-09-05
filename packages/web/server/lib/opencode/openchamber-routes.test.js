import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import path from 'node:path';
import request from 'supertest';

vi.mock('child_process', () => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(),
}));

vi.mock('../package-manager.js', () => ({
  checkForUpdates: vi.fn(),
  getUpdateCommand: vi.fn(),
  detectPackageManagerDetails: vi.fn(),
}));

const childProcess = await import('child_process');
const packageManager = await import('../package-manager.js');
const { registerOpenChamberRoutes } = await import('./openchamber-routes.js');

const createApp = ({ environment = {}, storedOptions = {}, desktopUpdater } = {}) => {
  const app = express();
  const dependencies = {
    fs: {
      existsSync: vi.fn(() => false),
      promises: {
        readFile: vi.fn(async () => JSON.stringify({
          launchMode: 'foreground',
          port: 7897,
          ...storedOptions,
        })),
      },
    },
    path,
    process: {
      env: environment,
      platform: 'linux',
      execPath: '/usr/bin/node',
    },
    server: {
      address: () => ({ port: 7897 }),
    },
    __dirname: '/opt/openchamber/server',
    openchamberDataDir: '/tmp/openchamber',
    modelsDevApiUrl: 'https://models.example.test',
    modelsMetadataCacheTtl: 0,
    readSettingsFromDiskMigrated: vi.fn(),
    fetchFreeZenModels: vi.fn(),
    getCachedZenModels: vi.fn(),
    desktopUpdater,
  };

  registerOpenChamberRoutes(app, dependencies);
  return { app, dependencies };
};

beforeEach(() => {
  packageManager.checkForUpdates.mockResolvedValue({
    available: true,
    version: '1.17.1',
  });
  packageManager.detectPackageManagerDetails.mockReturnValue({
    packageManager: 'npm',
  });
  packageManager.getUpdateCommand.mockReturnValue('npm install -g @openchamber/web@latest');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('OpenChamber desktop host update route', () => {
  it('uses electron-updater to check for Web client updates', async () => {
    const desktopUpdater = {
      check: vi.fn(async () => ({
        available: true,
        currentVersion: '1.17.0',
        version: '1.17.1',
      })),
      install: vi.fn(),
      restart: vi.fn(),
    };
    const { app } = createApp({
      environment: {
        OPENCHAMBER_RUNTIME: 'desktop',
      },
      desktopUpdater,
    });

    await request(app)
      .get('/api/openchamber/update-check?appType=web&reportUsage=false')
      .expect(200, {
        available: true,
        currentVersion: '1.17.0',
        version: '1.17.1',
        packageManager: 'electron',
        updateOwner: 'electron-updater',
      });

    expect(desktopUpdater.check).toHaveBeenCalledOnce();
    expect(packageManager.checkForUpdates).not.toHaveBeenCalled();
  });

  it('installs through electron-updater and restarts after responding', async () => {
    const desktopUpdater = {
      check: vi.fn(),
      install: vi.fn(async () => ({
        available: true,
        version: '1.17.1',
      })),
      restart: vi.fn(),
    };
    const { app } = createApp({
      environment: {
        OPENCHAMBER_RUNTIME: 'desktop',
      },
      desktopUpdater,
    });

    await request(app)
      .post('/api/openchamber/update-install')
      .expect(200, {
        success: true,
        message: 'Desktop update downloaded, host will restart shortly',
        version: '1.17.1',
        packageManager: 'electron',
        updateOwner: 'electron-updater',
        autoRestart: true,
        restartManager: 'electron-updater',
      });
    await new Promise((resolve) => setImmediate(resolve));

    expect(desktopUpdater.install).toHaveBeenCalledOnce();
    expect(desktopUpdater.restart).toHaveBeenCalledOnce();
    expect(packageManager.checkForUpdates).not.toHaveBeenCalled();
    expect(packageManager.detectPackageManagerDetails).not.toHaveBeenCalled();
    expect(packageManager.getUpdateCommand).not.toHaveBeenCalled();
    expect(childProcess.spawn).not.toHaveBeenCalled();
    expect(childProcess.spawnSync).not.toHaveBeenCalled();
  });

  it('fails safely when the Electron updater bridge is unavailable', async () => {
    const { app } = createApp({
      environment: {
        OPENCHAMBER_RUNTIME: 'desktop',
      },
    });

    await request(app)
      .post('/api/openchamber/update-install')
      .expect(503, {
        code: 'DESKTOP_UPDATER_UNAVAILABLE',
        error: 'The desktop updater is not available.',
      });

    expect(packageManager.checkForUpdates).not.toHaveBeenCalled();
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });
});

describe('OpenChamber foreground update route', () => {
  it('rejects a foreground update when the server is not owned by systemd', async () => {
    const { app } = createApp();

    await request(app)
      .post('/api/openchamber/update-install')
      .expect(409, {
        error: 'Foreground servers must be updated by their service manager. Set OPENCHAMBER_SYSTEMD_UNIT when running under systemd, or run openchamber update and restart the service.',
      });

    expect(childProcess.spawnSync).not.toHaveBeenCalled();
  });

  it('rejects an unsafe systemd unit override before starting an update job', async () => {
    const { app } = createApp({
      environment: {
        INVOCATION_ID: 'systemd-invocation',
        OPENCHAMBER_SYSTEMD_UNIT: 'openchamber.service; rm -rf /',
      },
    });

    await request(app)
      .post('/api/openchamber/update-install')
      .expect(409, {
        error: 'Foreground servers must be updated by their service manager. Set OPENCHAMBER_SYSTEMD_UNIT when running under systemd, or run openchamber update and restart the service.',
      });

    expect(childProcess.spawnSync).not.toHaveBeenCalled();
  });

  it('queues the install in a transient systemd unit and returns its job identifier', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    childProcess.spawnSync.mockReturnValue({ status: 0, stdout: '', stderr: '' });
    const { app } = createApp({
      environment: {
        INVOCATION_ID: 'systemd-invocation',
        OPENCHAMBER_SYSTEMD_UNIT: 'openchamber@wsl.service',
        PATH: '/home/syu/.npm-global/bin:/usr/bin:/bin',
      },
    });

    await request(app)
      .post('/api/openchamber/update-install')
      .expect(200, {
        success: true,
        message: 'Update queued; OpenChamber will restart after installation completes',
        version: '1.17.1',
        packageManager: 'npm',
        autoRestart: true,
        restartManager: 'systemd',
        jobId: 'openchamber-update-1700000000000',
        logPath: 'journalctl --user-unit openchamber-update-1700000000000.service',
      });

    expect(childProcess.spawnSync).toHaveBeenCalledWith('systemd-run', [
      '--user',
      '--unit=openchamber-update-1700000000000',
      '--collect',
      '--service-type=exec',
      '--setenv=PATH=/home/syu/.npm-global/bin:/usr/bin:/bin',
      '/bin/sh',
      '-c',
      "set -eu\nnpm install -g @openchamber/web@latest\nsystemctl --user restart 'openchamber@wsl.service'",
    ], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
    });
  });
});
