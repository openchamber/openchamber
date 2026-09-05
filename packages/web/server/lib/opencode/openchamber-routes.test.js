import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import path from 'node:path';
import request from 'supertest';

vi.mock('child_process', () => ({
  spawn: vi.fn(() => ({ unref: vi.fn() })),
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

const createApp = ({
  environment = {},
  storedOptions = {},
  platform = 'linux',
  plistExists = false,
} = {}) => {
  const app = express();
  const dependencies = {
    fs: {
      existsSync: vi.fn((targetPath) => {
        if (typeof targetPath === 'string' && targetPath.endsWith('dev.openchamber.web.plist')) {
          return plistExists;
        }
        return false;
      }),
      mkdirSync: vi.fn(),
      openSync: vi.fn(() => 42),
      closeSync: vi.fn(),
      promises: {
        readFile: vi.fn(async () => JSON.stringify({
          launchMode: 'foreground',
          port: 7897,
          ...storedOptions,
        })),
      },
    },
    os: {
      homedir: () => '/home/test',
    },
    path,
    process: {
      env: environment,
      platform,
      execPath: '/usr/bin/node',
      exit: vi.fn(),
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
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
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
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
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
    expect(childProcess.spawn).not.toHaveBeenCalled();
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
    expect(childProcess.spawn).not.toHaveBeenCalled();
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
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });

  it('rejects foreground update on macOS when launchd plist does not exist', async () => {
    const { app } = createApp({
      platform: 'darwin',
      storedOptions: { launchMode: 'foreground' },
      plistExists: false,
    });

    await request(app)
      .post('/api/openchamber/update-install')
      .expect(409, {
        error: 'Foreground servers must be updated by their service manager. Set OPENCHAMBER_SYSTEMD_UNIT when running under systemd, or run openchamber update and restart the service.',
      });

    expect(childProcess.spawnSync).not.toHaveBeenCalled();
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });

  it('allows foreground update on macOS when launchd plist exists and invokes launchd restart command', async () => {
    const { app } = createApp({
      platform: 'darwin',
      storedOptions: { launchMode: 'foreground' },
      plistExists: true,
    });

    await request(app)
      .post('/api/openchamber/update-install')
      .expect(200, {
        success: true,
        message: 'Update starting, server will restart shortly',
        version: '1.17.1',
        packageManager: 'npm',
        autoRestart: true,
        restartManager: 'service',
      });

    vi.advanceTimersByTime(600);

    expect(childProcess.spawn).toHaveBeenCalledWith(
      'sh',
      [
        '-c',
        expect.stringContaining(
          "launchctl kickstart -k gui/$(id -u)/dev.openchamber.web || (launchctl unload '/home/test/Library/LaunchAgents/dev.openchamber.web.plist' && launchctl load '/home/test/Library/LaunchAgents/dev.openchamber.web.plist')"
        ),
      ],
      expect.objectContaining({
        detached: true,
      })
    );
  });

  it('allows daemon update on macOS without launchd plist and invokes CLI restart command', async () => {
    const { app } = createApp({
      platform: 'darwin',
      storedOptions: { launchMode: 'daemon', port: 7897 },
      plistExists: false,
    });

    await request(app)
      .post('/api/openchamber/update-install')
      .expect(200, {
        success: true,
        message: 'Update starting, server will restart shortly',
        version: '1.17.1',
        packageManager: 'npm',
        autoRestart: true,
        restartManager: 'cli',
      });

    vi.advanceTimersByTime(600);

    expect(childProcess.spawn).toHaveBeenCalledWith(
      'sh',
      [
        '-c',
        expect.stringContaining(
          "('/usr/bin/node' '/opt/openchamber/bin/cli.js' serve --port 7897) || (openchamber serve --port 7897)"
        ),
      ],
      expect.objectContaining({
        detached: true,
      })
    );
  });

  it('allows daemon update on macOS with launchd plist present and still invokes CLI restart command', async () => {
    const { app } = createApp({
      platform: 'darwin',
      storedOptions: { launchMode: 'daemon', port: 7897 },
      plistExists: true,
    });

    await request(app)
      .post('/api/openchamber/update-install')
      .expect(200, {
        success: true,
        message: 'Update starting, server will restart shortly',
        version: '1.17.1',
        packageManager: 'npm',
        autoRestart: true,
        restartManager: 'cli',
      });

    vi.advanceTimersByTime(600);

    expect(childProcess.spawn).toHaveBeenCalledWith(
      'sh',
      [
        '-c',
        expect.stringContaining(
          "('/usr/bin/node' '/opt/openchamber/bin/cli.js' serve --port 7897) || (openchamber serve --port 7897)"
        ),
      ],
      expect.objectContaining({
        detached: true,
      })
    );
  });
});
