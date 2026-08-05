import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { registerOpenChamberRoutes } from './openchamber-routes.js';

// Mock child_process so the route's spawn and the package-manager detection
// spawnSync calls never touch a real shell.
vi.mock('child_process', () => {
  const { EventEmitter } = require('node:events');
  return {
    spawn: vi.fn(() => {
      const child = new EventEmitter();
      child.unref = vi.fn();
      child.pid = 4242;
      return child;
    }),
    spawnSync: vi.fn(() => ({ status: 0, stdout: '/usr/local/bin', stderr: '' })),
  };
});

const { spawn } = await import('child_process');

function createFetchMock() {
  const handlers = new Map();
  const mock = vi.fn((url) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    for (const [pattern, response] of handlers) {
      if (urlStr.includes(pattern)) {
        return Promise.resolve(response);
      }
    }
    return Promise.reject(new Error(`Unexpected fetch call: ${urlStr}`));
  });
  mock.when = (pattern, response) => {
    handlers.set(pattern, response);
    return mock;
  };
  return mock;
}

const makeApp = async (dataDir) => {
  const app = express();
  app.use(express.json());
  registerOpenChamberRoutes(app, {
    fs,
    path,
    process,
    server: { address: () => ({ port: 3000 }) },
    __dirname,
    openchamberDataDir: dataDir,
    modelsDevApiUrl: 'http://models.test',
    modelsMetadataCacheTtl: 300,
    readSettingsFromDiskMigrated: () => ({}),
    fetchFreeZenModels: async () => [],
    getCachedZenModels: () => null,
  });
  return app;
};

const waitForSpawn = async () => {
  // The container-mode install spawns inside a 500ms setTimeout after the
  // response is sent, so wait for it deterministically.
  await new Promise((resolve) => setTimeout(resolve, 700));
};

describe('openchamber update-install (container mode) + update-status', () => {
  let fetchMock;
  let originalFetch;
  let dataDir;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-update-route-test-'));
    fetchMock = createFetchMock()
      .when('api.openchamber.dev', {
        ok: true,
        json: async () => ({
          latestVersion: '1.19.0',
          updateAvailable: true,
          releaseNotes: '## [1.19.0] - 2026-07-01\n\n- Great new feature',
        }),
      })
      .when('registry.npmjs.org', {
        ok: true,
        json: async () => ({
          'dist-tags': { latest: '1.19.0' },
        }),
      });
    originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock;
    process.env.CONTAINER = 'true';
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.CONTAINER;
    globalThis.fetch = originalFetch;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('records installing, then success with exit code when npm exits 0', async () => {
    const app = await makeApp(dataDir);
    const response = await request(app).post('/api/openchamber/update-install');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ success: true, autoRestart: false });

    await waitForSpawn();

    expect(spawn).toHaveBeenCalledTimes(1);
    const [shell, args] = spawn.mock.calls[0];
    expect(shell).toBe('sh');
    expect(args[0]).toBe('-c');
    expect(args[1]).toContain('npm install -g @openchamber/web@latest');

    const installing = JSON.parse(fs.readFileSync(path.join(dataDir, 'update-status.json'), 'utf8'));
    expect(installing.state).toBe('installing');
    expect(installing.targetVersion).toBe('1.19.0');

    const child = spawn.mock.results[0].value;
    child.emit('exit', 0);

    const finished = JSON.parse(fs.readFileSync(path.join(dataDir, 'update-status.json'), 'utf8'));
    expect(finished).toMatchObject({ state: 'success', exitCode: 0, targetVersion: '1.19.0' });
    expect(typeof finished.finishedAt).toBe('number');

    const statusResponse = await request(app).get('/api/openchamber/update-status');
    expect(statusResponse.status).toBe(200);
    expect(statusResponse.body).toMatchObject({ state: 'success', exitCode: 0 });
  });

  it('records failed with the npm exit code when install exits non-zero', async () => {
    const app = await makeApp(dataDir);
    await request(app).post('/api/openchamber/update-install');
    await waitForSpawn();

    const child = spawn.mock.results[0].value;
    child.emit('exit', 1);

    const statusResponse = await request(app).get('/api/openchamber/update-status');
    expect(statusResponse.status).toBe(200);
    expect(statusResponse.body).toMatchObject({ state: 'failed', exitCode: 1 });
  });

  it('records failed with an error message when the spawn itself errors', async () => {
    const app = await makeApp(dataDir);
    await request(app).post('/api/openchamber/update-install');
    await waitForSpawn();

    const child = spawn.mock.results[0].value;
    child.emit('error', new Error('ENOENT: no such file or directory'));

    const statusResponse = await request(app).get('/api/openchamber/update-status');
    expect(statusResponse.status).toBe(200);
    expect(statusResponse.body.state).toBe('failed');
    expect(statusResponse.body.error).toContain('ENOENT');
  });

  it('reports idle before any install has been started', async () => {
    const app = await makeApp(dataDir);
    const statusResponse = await request(app).get('/api/openchamber/update-status');
    expect(statusResponse.status).toBe(200);
    expect(statusResponse.body).toEqual({ state: 'idle' });
  });

  it('rejects the install when no update is available', async () => {
    fetchMock.when('api.openchamber.dev', {
      ok: true,
      json: async () => ({
        latestVersion: '1.19.0',
        updateAvailable: false,
      }),
    });
    fetchMock.when('registry.npmjs.org', {
      ok: true,
      json: async () => ({
        'dist-tags': { latest: '1.19.0' },
      }),
    });

    const app = await makeApp(dataDir);
    const response = await request(app).post('/api/openchamber/update-install');
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('No update available');
    expect(fs.existsSync(path.join(dataDir, 'update-status.json'))).toBe(false);
  });
});
