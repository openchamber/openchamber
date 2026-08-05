import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import path from 'node:path';
import request from 'supertest';
import { registerOpenChamberRoutes } from './openchamber-routes.js';

// Mock child_process so the update-install handler never spawns a real shell.
const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(() => ({ unref: vi.fn() })),
}));

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
  spawnSync: vi.fn(() => ({ status: 0, stdout: '', stderr: '' })),
}));

// Mock package-manager.js so each test controls update availability and the
// package-manager detection outcome.
const {
  checkForUpdatesMock,
  detectPackageManagerDetailsMock,
  getUpdateCommandMock,
} = vi.hoisted(() => ({
  checkForUpdatesMock: vi.fn(),
  detectPackageManagerDetailsMock: vi.fn(),
  getUpdateCommandMock: vi.fn(),
}));

vi.mock('../package-manager.js', () => ({
  checkForUpdates: checkForUpdatesMock,
  detectPackageManagerDetails: detectPackageManagerDetailsMock,
  getUpdateCommand: getUpdateCommandMock,
}));

const createDependencies = (overrides = {}) => ({
  fs: {
    existsSync: vi.fn(() => false),
    promises: { readFile: vi.fn(async () => { throw new Error('no instance file'); }) },
    mkdirSync: vi.fn(),
    openSync: vi.fn(() => 1),
    closeSync: vi.fn(),
  },
  path,
  process: { platform: 'linux', execPath: '/usr/bin/node', env: {}, exit: vi.fn() },
  server: { address: () => ({ port: 3000 }) },
  __dirname: '/workspace/packages/web/server/lib/opencode',
  openchamberDataDir: '/tmp/oc-test-data',
  modelsDevApiUrl: 'https://models.dev/api',
  modelsMetadataCacheTtl: 300,
  readSettingsFromDiskMigrated: vi.fn(async () => ({})),
  fetchFreeZenModels: vi.fn(async () => []),
  getCachedZenModels: vi.fn(() => null),
  ...overrides,
});

const createApp = (overrides = {}) => {
  const app = express();
  registerOpenChamberRoutes(app, createDependencies(overrides));
  return app;
};

const updateAvailable = { available: true, version: '2.0.0', currentVersion: '1.0.0' };

describe('POST /api/openchamber/update-install', () => {
  beforeEach(() => {
    checkForUpdatesMock.mockReset();
    detectPackageManagerDetailsMock.mockReset();
    getUpdateCommandMock.mockReset();
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => ({ unref: vi.fn() }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects with 400 when no update is available', async () => {
    checkForUpdatesMock.mockResolvedValue({ available: false, currentVersion: '1.0.0' });

    const response = await request(createApp())
      .post('/api/openchamber/update-install')
      .expect(400);

    expect(response.body).toEqual({ error: 'No update available' });
    expect(detectPackageManagerDetailsMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('returns 409 with manual-update guidance when no package manager owns the install (default-fallback)', async () => {
    checkForUpdatesMock.mockResolvedValue(updateAvailable);
    detectPackageManagerDetailsMock.mockReturnValue({
      packageManager: 'npm',
      reason: 'default-fallback',
      packagePath: '/opt/openchamber',
      packageManagerCommand: 'npm',
      globalNodeModulesRoot: null,
    });

    const response = await request(createApp())
      .post('/api/openchamber/update-install')
      .expect(409);

    expect(response.body.error).toMatch(/manually/i);
    expect(response.body.error).toMatch(/package manager/i);
    expect(getUpdateCommandMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('returns 409 for default-fallback even when running inside a container', async () => {
    checkForUpdatesMock.mockResolvedValue(updateAvailable);
    detectPackageManagerDetailsMock.mockReturnValue({
      packageManager: 'npm',
      reason: 'default-fallback',
      packagePath: '/opt/openchamber',
      packageManagerCommand: 'npm',
      globalNodeModulesRoot: null,
    });

    const response = await request(createApp({
      process: { platform: 'linux', execPath: '/usr/bin/node', env: { CONTAINER: '1' }, exit: vi.fn() },
    }))
      .post('/api/openchamber/update-install')
      .expect(409);

    expect(response.body.error).toMatch(/manually/i);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('starts the update when a real package manager is detected', async () => {
    vi.useFakeTimers();
    checkForUpdatesMock.mockResolvedValue(updateAvailable);
    detectPackageManagerDetailsMock.mockReturnValue({
      packageManager: 'pnpm',
      reason: 'global-root-owner',
      packagePath: '/usr/local/lib/node_modules/@openchamber/web',
      packageManagerCommand: 'pnpm',
      globalNodeModulesRoot: '/usr/local/lib/node_modules',
    });
    getUpdateCommandMock.mockReturnValue('pnpm add -g @openchamber/web@latest');

    const response = await request(createApp())
      .post('/api/openchamber/update-install')
      .expect(200);

    expect(response.body).toMatchObject({
      success: true,
      packageManager: 'pnpm',
      autoRestart: true,
    });
    expect(getUpdateCommandMock).toHaveBeenCalledWith('pnpm');

    // Advance the deferred update shell to prove the update command is spawned.
    await vi.advanceTimersByTimeAsync(600);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
});
