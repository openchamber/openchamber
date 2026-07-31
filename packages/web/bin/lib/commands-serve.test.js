import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('child_process', () => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(),
}));

import { spawn } from 'node:child_process';
import { createServeCommand } from './commands-serve.js';
import { getInstanceFilePath, getPidFilePath, readInstanceOptions } from './cli-process.js';

const tempRoots = [];

afterEach(() => {
  spawn.mockReset();
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('serve guardian owner propagation', () => {
  it('generates one owner ID, persists it, and propagates it to a daemon server', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-serve-test-'));
    tempRoots.push(dataDir);
    const previousDataDir = process.env.OPENCHAMBER_DATA_DIR;
    const previousOwner = process.env.OPENCHAMBER_GUARDIAN_OWNER_ID;
    process.env.OPENCHAMBER_DATA_DIR = dataDir;
    delete process.env.OPENCHAMBER_GUARDIAN_OWNER_ID;

    const child = new EventEmitter();
    child.pid = process.pid;
    child.connected = true;
    child.unref = vi.fn();
    child.disconnect = vi.fn(() => {
      child.connected = false;
    });
    spawn.mockImplementation(() => {
      queueMicrotask(() => child.emit('message', { type: 'openchamber:ready', port: 34567 }));
      return child;
    });

    try {
      const serveCommand = createServeCommand({
        serverPath: '/tmp/openchamber-server.js',
        bunBin: process.execPath,
        checkOpenCodeCLI: vi.fn(async () => '/usr/bin/opencode'),
        getPreferredServerRuntime: () => 'node',
        setForegroundServerActive: vi.fn(),
        setForegroundShutdown: vi.fn(),
      });

      await serveCommand({
        port: 34567,
        explicitPort: true,
        host: '127.0.0.1',
        quiet: true,
        suppressQuietOutput: true,
        suppressUiPasswordWarning: true,
        guardian: false,
        handoff: false,
      });

      const spawnEnv = spawn.mock.calls[0][2].env;
      const instanceOptions = readInstanceOptions(await getInstanceFilePath(34567));
      expect(typeof spawnEnv.OPENCHAMBER_GUARDIAN_OWNER_ID).toBe('string');
      expect(spawnEnv.OPENCHAMBER_GUARDIAN_OWNER_ID.length).toBeGreaterThan(0);
      expect(instanceOptions.guardianOwnerInstanceId).toBe(spawnEnv.OPENCHAMBER_GUARDIAN_OWNER_ID);
    } finally {
      if (previousDataDir === undefined) delete process.env.OPENCHAMBER_DATA_DIR;
      else process.env.OPENCHAMBER_DATA_DIR = previousDataDir;
      if (previousOwner === undefined) delete process.env.OPENCHAMBER_GUARDIAN_OWNER_ID;
      else process.env.OPENCHAMBER_GUARDIAN_OWNER_ID = previousOwner;
    }
  });

  it('retains foreground restart metadata after exit cleanup', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-serve-foreground-test-'));
    tempRoots.push(dataDir);
    const serverPath = path.join(dataDir, 'server.mjs');
    fs.writeFileSync(
      serverPath,
      'export async function startWebUiServer() { return { getPort: () => 34568, stop: async () => {} }; }\n',
    );

    const previousEnv = {
      dataDir: process.env.OPENCHAMBER_DATA_DIR,
      owner: process.env.OPENCHAMBER_GUARDIAN_OWNER_ID,
      binary: process.env.OPENCODE_BINARY,
      host: process.env.OPENCHAMBER_HOST,
      runtime: process.env.OPENCHAMBER_RUNTIME,
      uiPassword: process.env.OPENCHAMBER_UI_PASSWORD,
    };
    process.env.OPENCHAMBER_DATA_DIR = dataDir;
    delete process.env.OPENCHAMBER_GUARDIAN_OWNER_ID;

    const setForegroundServerActive = vi.fn();
    const setForegroundShutdown = vi.fn();
    const serveCommand = createServeCommand({
      serverPath,
      bunBin: process.execPath,
      checkOpenCodeCLI: vi.fn(async () => '/usr/bin/opencode'),
      getPreferredServerRuntime: () => 'node',
      setForegroundServerActive,
      setForegroundShutdown,
    });

    const foregroundPromise = serveCommand({
      port: 34568,
      explicitPort: true,
      host: '127.0.0.1',
      foreground: true,
      uiPassword: 'foreground-secret',
      apiOnly: true,
      guardian: false,
      handoff: true,
      suppressUiPasswordWarning: true,
      suppressStartupSummary: true,
    });

    const instanceFilePath = await getInstanceFilePath(34568);
    for (let attempt = 0; attempt < 50 && !fs.existsSync(instanceFilePath); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const beforeExit = readInstanceOptions(instanceFilePath);
    expect(beforeExit).toMatchObject({
      uiPassword: 'foreground-secret',
      apiOnly: true,
      guardianOwnerInstanceId: expect.any(String),
    });

    const exitListener = process.listeners('exit').at(-1);
    expect(typeof exitListener).toBe('function');
    exitListener();

    const afterExit = readInstanceOptions(instanceFilePath);
    expect(afterExit).toMatchObject({
      uiPassword: 'foreground-secret',
      apiOnly: true,
      guardianOwnerInstanceId: beforeExit.guardianOwnerInstanceId,
      startedAt: beforeExit.startedAt,
    });

    if (exitListener) process.removeListener('exit', exitListener);
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGQUIT']) {
      const listener = process.listeners(signal).at(-1);
      if (listener) process.removeListener(signal, listener);
    }
    void foregroundPromise;

    if (previousEnv.dataDir === undefined) delete process.env.OPENCHAMBER_DATA_DIR;
    else process.env.OPENCHAMBER_DATA_DIR = previousEnv.dataDir;
    if (previousEnv.owner === undefined) delete process.env.OPENCHAMBER_GUARDIAN_OWNER_ID;
    else process.env.OPENCHAMBER_GUARDIAN_OWNER_ID = previousEnv.owner;
    if (previousEnv.binary === undefined) delete process.env.OPENCODE_BINARY;
    else process.env.OPENCODE_BINARY = previousEnv.binary;
    if (previousEnv.host === undefined) delete process.env.OPENCHAMBER_HOST;
    else process.env.OPENCHAMBER_HOST = previousEnv.host;
    if (previousEnv.runtime === undefined) delete process.env.OPENCHAMBER_RUNTIME;
    else process.env.OPENCHAMBER_RUNTIME = previousEnv.runtime;
    if (previousEnv.uiPassword === undefined) delete process.env.OPENCHAMBER_UI_PASSWORD;
    else process.env.OPENCHAMBER_UI_PASSWORD = previousEnv.uiPassword;
  });

  it('preserves foreground metadata when owner-scoped shutdown fails', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-serve-foreground-failure-test-'));
    tempRoots.push(dataDir);
    const serverPath = path.join(dataDir, 'server.mjs');
    fs.writeFileSync(
      serverPath,
      'export async function startWebUiServer() { return { getPort: () => 34569, stop: async () => { throw new Error("guardian stop failed"); } }; }\n',
    );

    const previousDataDir = process.env.OPENCHAMBER_DATA_DIR;
    process.env.OPENCHAMBER_DATA_DIR = dataDir;
    const processExit = vi.spyOn(process, 'exit').mockImplementation(() => {});
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const setForegroundServerActive = vi.fn();
    const setForegroundShutdown = vi.fn();
    const serveCommand = createServeCommand({
      serverPath,
      bunBin: process.execPath,
      checkOpenCodeCLI: vi.fn(async () => '/usr/bin/opencode'),
      getPreferredServerRuntime: () => 'node',
      setForegroundServerActive,
      setForegroundShutdown,
    });

    const foregroundPromise = serveCommand({
      port: 34569,
      explicitPort: true,
      host: '127.0.0.1',
      foreground: true,
      guardian: false,
      handoff: true,
      suppressUiPasswordWarning: true,
      suppressStartupSummary: true,
    });

    const pidFilePath = await getPidFilePath(34569);
    const instanceFilePath = await getInstanceFilePath(34569);
    for (let attempt = 0; attempt < 50 && !fs.existsSync(instanceFilePath); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    try {
      const shutdown = setForegroundShutdown.mock.calls.at(-1)?.[0];
      expect(typeof shutdown).toBe('function');

      await expect(shutdown('SIGTERM')).resolves.toBe(false);
      expect(processExit).not.toHaveBeenCalled();
      expect(fs.existsSync(pidFilePath)).toBe(true);
      expect(readInstanceOptions(instanceFilePath)).toMatchObject({
        guardianOwnerInstanceId: expect.any(String),
      });
      expect(setForegroundServerActive).toHaveBeenLastCalledWith(true);
      expect(consoleError).toHaveBeenCalledWith(
        'Foreground shutdown failed; preserving OpenChamber metadata for retry:',
        'guardian stop failed',
      );
    } finally {
      const exitListener = process.listeners('exit').at(-1);
      if (exitListener) process.removeListener('exit', exitListener);
      for (const signal of ['SIGINT', 'SIGTERM', 'SIGQUIT']) {
        const listener = process.listeners(signal).at(-1);
        if (listener) process.removeListener(signal, listener);
      }
      if (previousDataDir === undefined) delete process.env.OPENCHAMBER_DATA_DIR;
      else process.env.OPENCHAMBER_DATA_DIR = previousDataDir;
      void foregroundPromise;
    }
  });
});
