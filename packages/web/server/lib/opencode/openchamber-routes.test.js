import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const checkForUpdates = vi.fn();
const detectPackageManagerDetails = vi.fn();
const getUpdateLaunchSpec = vi.fn();
const startUpdateTransaction = vi.fn();
const readUpdateTransactionStatus = vi.fn();

vi.mock('../package-manager.js', () => ({
  checkForUpdates,
  detectPackageManagerDetails,
  getUpdateLaunchSpec,
}));

vi.mock('../openchamber-update/runtime.js', () => ({
  startUpdateTransaction,
  readUpdateTransactionStatus,
}));

vi.mock('child_process', () => ({ spawn: vi.fn(), spawnSync: vi.fn() }));

const { registerOpenChamberRoutes } = await import('./openchamber-routes.js');

describe('OpenChamber update routes', () => {
  let dataDirectory;
  let processLike;
  let gracefulShutdown;
  let app;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-update-routes-'));
    processLike = {
      env: {},
      execPath: process.execPath,
      pid: 4321,
      exit: vi.fn(),
    };
    gracefulShutdown = vi.fn(async () => {});
    checkForUpdates.mockResolvedValue({ available: true, currentVersion: '1.0.0', version: '1.1.0' });
    detectPackageManagerDetails.mockReturnValue({
      packageManager: 'npm',
      reason: 'global-root-owner',
      packageManagerCommand: 'npm',
      packagePath: path.join(dataDirectory, 'node_modules', '@openchamber', 'web'),
    });
    getUpdateLaunchSpec.mockImplementation((_packageManager, version) => ({
      command: process.execPath,
      args: ['npm-cli.js', 'install', '-g', `@openchamber/web@${version}`],
      source: 'node-shim',
    }));
    startUpdateTransaction.mockResolvedValue({
      id: '11111111-1111-1111-1111-111111111111',
      currentVersion: '1.0.0',
      targetVersion: '1.1.0',
      packageManager: 'npm',
    });

    const runDirectory = path.join(dataDirectory, 'run');
    fs.mkdirSync(runDirectory, { recursive: true });
    fs.writeFileSync(path.join(runDirectory, 'openchamber-4097.json'), JSON.stringify({
      port: 4097,
      host: '0.0.0.0',
      launchMode: 'daemon',
      uiPassword: 'secret-with-&-characters',
      apiOnly: true,
    }));

    app = express();
    registerOpenChamberRoutes(app, {
      fs,
      path,
      process: processLike,
      server: { address: () => ({ port: 4097 }) },
      __dirname: path.join(dataDirectory, 'server'),
      openchamberDataDir: dataDirectory,
      modelsDevApiUrl: 'https://example.invalid/models',
      modelsMetadataCacheTtl: 1000,
      gracefulShutdown,
      readSettingsFromDiskMigrated: vi.fn(),
      fetchFreeZenModels: vi.fn(),
      getCachedZenModels: vi.fn(),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  });

  it('returns an accepted transaction before gracefully shutting down', async () => {
    const response = await request(app).post('/api/openchamber/update-install');

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({
      accepted: true,
      transactionId: '11111111-1111-1111-1111-111111111111',
      currentVersion: '1.0.0',
      targetVersion: '1.1.0',
    });
    const transactionOptions = startUpdateTransaction.mock.calls[0][0];
    expect(transactionOptions.install.args).toContain('@openchamber/web@1.1.0');
    expect(transactionOptions.rollback.args).toContain('@openchamber/web@1.0.0');
    expect(transactionOptions.restart.args).not.toContain('secret-with-&-characters');
    expect(transactionOptions.restart.env).toEqual({ OPENCHAMBER_UI_PASSWORD: 'secret-with-&-characters' });
    expect(gracefulShutdown).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(250);
    expect(gracefulShutdown).toHaveBeenCalledWith({ exitProcess: true });
    expect(processLike.exit).not.toHaveBeenCalled();
  });

  it('does not shut down when helper preparation fails', async () => {
    startUpdateTransaction.mockRejectedValueOnce(new Error('helper failed'));

    const response = await request(app).post('/api/openchamber/update-install');
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'helper failed' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(gracefulShutdown).not.toHaveBeenCalled();
  });

  it('refuses to update when package-manager ownership is only a weak hint', async () => {
    detectPackageManagerDetails.mockReturnValueOnce({
      packageManager: 'npm',
      reason: 'hinted-visible-install',
      packageManagerCommand: 'npm',
      packagePath: path.join(dataDirectory, 'source-checkout'),
    });

    const response = await request(app).post('/api/openchamber/update-install');
    expect(response.status).toBe(409);
    expect(startUpdateTransaction).not.toHaveBeenCalled();
    expect(gracefulShutdown).not.toHaveBeenCalled();
  });

  it('leaves packaged Desktop updates to the native updater', async () => {
    processLike.env.OPENCHAMBER_RUNTIME = 'desktop';

    const response = await request(app).post('/api/openchamber/update-install');
    expect(response.status).toBe(409);
    expect(startUpdateTransaction).not.toHaveBeenCalled();
    expect(gracefulShutdown).not.toHaveBeenCalled();
  });

  it('asks the built-in Windows startup task to restart a foreground service', async () => {
    fs.writeFileSync(path.join(dataDirectory, 'run', 'openchamber-4097.json'), JSON.stringify({
      port: 4097,
      host: '0.0.0.0',
      launchMode: 'foreground',
      serviceManager: 'windows-task',
    }));

    const response = await request(app).post('/api/openchamber/update-install');
    expect(response.status).toBe(202);
    expect(response.body.restartManager).toBe('service');
    expect(startUpdateTransaction.mock.calls[0][0].restart).toMatchObject({
      mode: 'service',
      serviceManager: 'windows-task',
      serviceCommand: 'schtasks.exe',
      serviceArgs: ['/Run', '/TN', 'dev.openchamber.web'],
    });
  });

  it('moves a systemd foreground update helper into an independent transient unit', async () => {
    processLike.platform = 'linux';
    processLike.env.OPENCHAMBER_SERVICE_MANAGER = 'systemd';
    fs.writeFileSync(path.join(dataDirectory, 'run', 'openchamber-4097.json'), JSON.stringify({
      port: 4097,
      host: '0.0.0.0',
      launchMode: 'foreground',
    }));

    const response = await request(app).post('/api/openchamber/update-install');
    expect(response.status).toBe(202);
    expect(startUpdateTransaction.mock.calls[0][0]).toMatchObject({
      helperManager: 'systemd',
      restart: { mode: 'service', serviceManager: 'systemd' },
    });
  });

  it('refuses automatic updates for unmanaged foreground servers', async () => {
    fs.writeFileSync(path.join(dataDirectory, 'run', 'openchamber-4097.json'), JSON.stringify({
      port: 4097,
      host: '0.0.0.0',
      launchMode: 'foreground',
    }));

    const response = await request(app).post('/api/openchamber/update-install');
    expect(response.status).toBe(409);
    expect(startUpdateTransaction).not.toHaveBeenCalled();
    expect(gracefulShutdown).not.toHaveBeenCalled();
  });

  it('probes the configured interface when it is not a wildcard bind', async () => {
    fs.writeFileSync(path.join(dataDirectory, 'run', 'openchamber-4097.json'), JSON.stringify({
      port: 4097,
      host: '192.0.2.10',
      launchMode: 'daemon',
    }));

    const response = await request(app).post('/api/openchamber/update-install');
    expect(response.status).toBe(202);
    expect(startUpdateTransaction.mock.calls[0][0].restart.healthUrl).toBe('http://192.0.2.10:4097/health');
  });

  it('returns sanitized transaction status', async () => {
    readUpdateTransactionStatus.mockReturnValue({
      id: '11111111-1111-1111-1111-111111111111',
      state: 'installing',
      currentVersion: '1.0.0',
      targetVersion: '1.1.0',
    });

    const response = await request(app)
      .get('/api/openchamber/update-status/11111111-1111-1111-1111-111111111111');
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body.state).toBe('installing');
  });
});
