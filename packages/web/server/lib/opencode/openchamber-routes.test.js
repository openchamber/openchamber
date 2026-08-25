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

const createApp = ({ environment = {}, platform = 'linux', storedOptions = {} } = {}) => {
  const app = express();
  const dependencies = {
    fs: {
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      openSync: vi.fn(() => 17),
      closeSync: vi.fn(),
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
      platform,
      execPath: '/usr/bin/node',
      pid: 4321,
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
  childProcess.spawn.mockReturnValue({ unref: vi.fn() });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('OpenChamber foreground update route', () => {
  it('rejects a foreground update when the server is not owned by systemd', async () => {
    const { app } = createApp();

    await request(app)
      .post('/api/openchamber/update-install')
      .expect(409, {
        error: 'Foreground servers must be updated by their service manager. Set OPENCHAMBER_SYSTEMD_UNIT when running under systemd, set OPENCHAMBER_UPDATE_RESTART_ON_EXIT=true for a restart-on-exit supervisor, or run openchamber update and restart the service.',
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
        error: 'Foreground servers must be updated by their service manager. Set OPENCHAMBER_SYSTEMD_UNIT when running under systemd, set OPENCHAMBER_UPDATE_RESTART_ON_EXIT=true for a restart-on-exit supervisor, or run openchamber update and restart the service.',
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

  it('keeps a supervised foreground server online until installation succeeds', async () => {
    const { app, dependencies } = createApp({
      platform: 'darwin',
      environment: {
        OPENCHAMBER_UPDATE_RESTART_ON_EXIT: 'true',
        PATH: '/Users/test/.local/bin:/usr/bin:/bin',
      },
    });

    await request(app)
      .post('/api/openchamber/update-install')
      .expect(200, {
        success: true,
        message: 'Update queued; OpenChamber will exit after installation completes',
        version: '1.17.1',
        packageManager: 'npm',
        autoRestart: true,
        restartManager: 'process-manager',
        logPath: '/tmp/openchamber/update-install.log',
      });

    expect(childProcess.spawn).toHaveBeenCalledWith('/bin/sh', ['-c', [
      'set -eu',
      'sleep 1',
      'npm install -g @openchamber/web@latest',
      'kill -TERM 4321',
    ].join('\n')], {
      detached: true,
      stdio: ['ignore', 17, 17],
      env: dependencies.process.env,
    });
    expect(dependencies.fs.closeSync).toHaveBeenCalledWith(17);
  });

  it('does not queue a supervised update when its log cannot be opened', async () => {
    const { app, dependencies } = createApp({
      platform: 'darwin',
      environment: { OPENCHAMBER_UPDATE_RESTART_ON_EXIT: 'true' },
    });
    dependencies.fs.openSync.mockImplementation(() => {
      throw new Error('update log unavailable');
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await request(app)
      .post('/api/openchamber/update-install')
      .expect(500, { error: 'update log unavailable' });

    expect(childProcess.spawn).not.toHaveBeenCalled();
    expect(dependencies.fs.closeSync).not.toHaveBeenCalled();
  });

  it('does not enable restart-on-exit updates on Windows', async () => {
    const { app } = createApp({
      platform: 'win32',
      environment: { OPENCHAMBER_UPDATE_RESTART_ON_EXIT: 'true' },
    });

    await request(app)
      .post('/api/openchamber/update-install')
      .expect(409, {
        error: 'Foreground servers must be updated by their service manager. Run openchamber update and restart the service.',
      });

    expect(childProcess.spawn).not.toHaveBeenCalled();
  });
});
