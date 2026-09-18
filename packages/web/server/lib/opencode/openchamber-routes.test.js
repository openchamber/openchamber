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

const createApp = ({ environment = {}, storedOptions = {}, desktopUpdater, platform = 'linux', execPath = '/usr/bin/node' } = {}) => {
  const app = express();
  const dependencies = {
    fs: {
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      openSync: vi.fn(() => 7),
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
      execPath,
      exit: vi.fn(),
    },
    server: {
      address: () => ({ port: 7897 }),
      close: vi.fn(),
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
  it('reports a restart rejection until the user retries installation', async () => {
    const desktopUpdater = {
      check: vi.fn(async () => ({ available: true, currentVersion: '1.17.0', version: '1.17.1' })),
      install: vi.fn(async () => ({ available: true, version: '1.17.1' })),
      restart: vi.fn().mockRejectedValueOnce(new Error('Signature rejected')).mockResolvedValue(undefined),
    };
    const { app } = createApp({ environment: { OPENCHAMBER_RUNTIME: 'desktop' }, desktopUpdater });
    const logError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await request(app).post('/api/openchamber/update-install').expect(200);
    await new Promise(resolve => setImmediate(resolve));
    await request(app).get('/api/openchamber/update-check?appType=web&reportUsage=false&updateStatus=true').expect(503, {
      code: 'DESKTOP_UPDATE_RESTART_FAILED', error: 'Signature rejected',
    });
    expect(desktopUpdater.check).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledOnce();
    // Availability remains reachable after a browser reload, so users can retry.
    await request(app).get('/api/openchamber/update-check?appType=web&reportUsage=false').expect(200);

    await request(app).post('/api/openchamber/update-install').expect(200);
    await new Promise(resolve => setImmediate(resolve));
    const response = await request(app).get('/api/openchamber/update-check?appType=web&reportUsage=false').expect(200);
    expect(response.body.currentVersion).toBe('1.17.0');
    expect(response.body.updateOwner).toBe('electron-updater');
    expect(packageManager.checkForUpdates).not.toHaveBeenCalled();
  });

  it('rejects native checks without a bridge and preserves explicit non-web checks', async () => {
    const { app } = createApp({ environment: { OPENCHAMBER_RUNTIME: 'desktop' } });
    await request(app).get('/api/openchamber/update-check?appType=web').expect(503, {
      available: false, code: 'DESKTOP_UPDATER_UNAVAILABLE', error: 'The desktop updater is not available.',
    });
    expect(packageManager.checkForUpdates).not.toHaveBeenCalled();
    await request(app).get('/api/openchamber/update-check?appType=desktop-electron').expect(200);
    expect(packageManager.checkForUpdates).toHaveBeenCalledOnce();
  });

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

describe('OpenChamber web update route on Windows', () => {
  it('runs the install-and-restart script from a batch file instead of a cmd.exe /c argument', async () => {
    const { app, dependencies } = createApp({
      platform: 'win32',
      execPath: 'C:\\Program Files\\nodejs\\node.exe',
      environment: { ComSpec: 'C:\\Windows\\system32\\cmd.exe' },
      storedOptions: { launchMode: 'daemon', port: 7897, uiPassword: 'pa%ss' },
    });
    childProcess.spawn.mockReturnValue({ unref: vi.fn() });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await request(app).post('/api/openchamber/update-install').expect(200);
    await new Promise((resolve) => setTimeout(resolve, 1300));

    const scriptPath = path.join('/tmp/openchamber', 'update-install.cmd');
    expect(dependencies.fs.writeFileSync).toHaveBeenCalledWith(scriptPath, expect.any(String), 'utf8');
    const script = dependencies.fs.writeFileSync.mock.calls[0][1];
    const lines = script.split('\r\n');
    expect(lines[0]).toBe('@echo off');
    // Every preamble line is an echo; none is left to run as a command.
    expect(lines.filter((line) => line.startsWith('currentVersion=') || line.startsWith('restartCommand='))).toEqual([]);
    expect(lines).toContain('echo packageManager=npm');
    expect(lines).toContain('echo restartCommand=^("C:\\Program Files\\nodejs\\node.exe" "/opt/openchamber/bin/cli.js" serve --port 7897 --ui-password "pa%%ss"^) ^|^| ^(openchamber serve --port 7897 --ui-password "pa%%ss"^)');
    // A .cmd shim (npm, pnpm, yarn) must be `call`ed or the script ends there.
    expect(lines).toContain('call npm install -g @openchamber/web@latest');
    expect(lines).toContain('ping -n 3 127.0.0.1 >nul');
    expect(lines.some((line) => line.startsWith('timeout '))).toBe(false);
    expect(lines).toContain('if %ERRORLEVEL% EQU 0 (');
    expect(lines.at(-2)).toBe('del "%~f0"');
    // A `%` in the password survives batch expansion only when doubled.
    expect(lines).toContain('  ("C:\\Program Files\\nodejs\\node.exe" "/opt/openchamber/bin/cli.js" serve --port 7897 --ui-password "pa%%ss") || (openchamber serve --port 7897 --ui-password "pa%%ss")');

    expect(childProcess.spawn).toHaveBeenCalledWith(
      'C:\\Windows\\system32\\cmd.exe',
      ['/c', scriptPath],
      expect.objectContaining({ detached: true, windowsHide: true }),
    );
    // The listener is closed before the batch is spawned, so the detached
    // child cannot inherit the socket and hold the port against the restart.
    expect(dependencies.server.close).toHaveBeenCalledOnce();
    expect(dependencies.server.close.mock.invocationCallOrder[0]).toBeLessThan(childProcess.spawn.mock.invocationCallOrder[0]);
    expect(dependencies.process.exit).toHaveBeenCalledWith(0);
  });

  it('answers 500 and keeps the server up when the batch file cannot be written', async () => {
    const { app, dependencies } = createApp({ platform: 'win32', storedOptions: { launchMode: 'daemon', port: 7897 } });
    dependencies.fs.writeFileSync.mockImplementation(() => { throw new Error('EACCES'); });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const logError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await request(app).post('/api/openchamber/update-install').expect(500);
    await new Promise((resolve) => setTimeout(resolve, 1300));

    expect(response.body.error).toContain('update-install.cmd');
    expect(response.body.error).toContain('EACCES');
    expect(childProcess.spawn).not.toHaveBeenCalled();
    expect(dependencies.process.exit).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledOnce();
  });
});

