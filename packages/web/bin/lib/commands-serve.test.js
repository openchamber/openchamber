import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('child_process', () => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(),
}));

vi.mock('../../server/lib/guardian/detection.js', () => ({
  getGuardianSocketPath: vi.fn(() => '/tmp/openchamber-serve-test/guardian.sock'),
  isGuardianRunning: vi.fn(async () => false),
}));

import { spawn } from 'node:child_process';
import { isGuardianRunning } from '../../server/lib/guardian/detection.js';
import { createServeCommand } from './commands-serve.js';
import { shouldAutoStartGuardian, isSkipStartConfigured } from './commands-guardian.js';
import { getInstanceFilePath, getPidFilePath, readInstanceOptions } from './cli-process.js';

const tempRoots = [];

afterEach(() => {
  spawn.mockReset();
  isGuardianRunning.mockReset();
  isGuardianRunning.mockResolvedValue(false);
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

describe('shouldAutoStartGuardian skip-start opt-out', () => {
  const originalSkipStart = process.env.OPENCODE_SKIP_START;
  const originalChamberSkip = process.env.OPENCHAMBER_SKIP_OPENCODE_START;
  const originalAutostart = process.env.OPENCHAMBER_GUARDIAN_AUTOSTART;

  afterEach(() => {
    for (const [key, value] of Object.entries({
      OPENCODE_SKIP_START: originalSkipStart,
      OPENCHAMBER_SKIP_OPENCODE_START: originalChamberSkip,
      OPENCHAMBER_GUARDIAN_AUTOSTART: originalAutostart,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('returns true by default (guardian + handoff enabled, no skip-start)', () => {
    delete process.env.OPENCODE_SKIP_START;
    delete process.env.OPENCHAMBER_SKIP_OPENCODE_START;
    delete process.env.OPENCHAMBER_GUARDIAN_AUTOSTART;
    expect(shouldAutoStartGuardian({ options: { guardian: true, handoff: true } })).toBe(true);
  });

  it('returns false when OPENCODE_SKIP_START=true', () => {
    process.env.OPENCODE_SKIP_START = 'true';
    delete process.env.OPENCHAMBER_SKIP_OPENCODE_START;
    delete process.env.OPENCHAMBER_GUARDIAN_AUTOSTART;
    expect(shouldAutoStartGuardian({ options: { guardian: true, handoff: true } })).toBe(false);
  });

  it('returns false when OPENCHAMBER_SKIP_OPENCODE_START=true', () => {
    delete process.env.OPENCODE_SKIP_START;
    process.env.OPENCHAMBER_SKIP_OPENCODE_START = 'true';
    delete process.env.OPENCHAMBER_GUARDIAN_AUTOSTART;
    expect(shouldAutoStartGuardian({ options: { guardian: true, handoff: true } })).toBe(false);
  });

  it('isSkipStartConfigured mirrors the env flags', () => {
    delete process.env.OPENCODE_SKIP_START;
    delete process.env.OPENCHAMBER_SKIP_OPENCODE_START;
    expect(isSkipStartConfigured()).toBe(false);
    process.env.OPENCODE_SKIP_START = 'true';
    expect(isSkipStartConfigured()).toBe(true);
    delete process.env.OPENCODE_SKIP_START;
    process.env.OPENCHAMBER_SKIP_OPENCODE_START = 'true';
    expect(isSkipStartConfigured()).toBe(true);
  });
});

describe('serve guardian autostart respects OPENCODE_SKIP_START', () => {
  const originalSkipStart = process.env.OPENCODE_SKIP_START;
  const originalChamberSkip = process.env.OPENCHAMBER_SKIP_OPENCODE_START;

  afterEach(() => {
    for (const [key, value] of Object.entries({
      OPENCODE_SKIP_START: originalSkipStart,
      OPENCHAMBER_SKIP_OPENCODE_START: originalChamberSkip,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  // Shared helper: a spawn implementation that records whether the guardian
  // entrypoint was launched. The guardian spawn's first arg is the guardian
  // entrypoint path; the daemon server spawn's first arg is the server path.
  const GUARDIAN_ENTRY_SUBSTRING = 'openchamber-guardian';
  const createSpawnRecorder = (serverReadyPort) => {
    const calls = [];
    const impl = (bin, args) => {
      const argList = Array.isArray(args) ? args : [];
      const isGuardianSpawn = argList.some(
        (arg) => typeof arg === 'string' && arg.includes(GUARDIAN_ENTRY_SUBSTRING),
      );
      calls.push({ bin, args: argList, isGuardianSpawn });
      const child = new EventEmitter();
      child.pid = process.pid;
      child.connected = true;
      child.unref = vi.fn();
      child.disconnect = vi.fn(() => { child.connected = false; });
      if (!isGuardianSpawn && serverReadyPort) {
        queueMicrotask(() => child.emit('message', { type: 'openchamber:ready', port: serverReadyPort }));
      }
      return child;
    };
    return { impl, calls };
  };

  it('daemon path does not autostart the guardian when OPENCODE_SKIP_START=true', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-serve-skipstart-daemon-'));
    tempRoots.push(dataDir);
    const previousDataDir = process.env.OPENCHAMBER_DATA_DIR;
    const previousOwner = process.env.OPENCHAMBER_GUARDIAN_OWNER_ID;
    process.env.OPENCHAMBER_DATA_DIR = dataDir;
    process.env.OPENCODE_SKIP_START = 'true';
    delete process.env.OPENCHAMBER_GUARDIAN_OWNER_ID;
    // Guardian is NOT running, so autostart would attempt a spawn if allowed.
    isGuardianRunning.mockResolvedValue(false);

    const recorder = createSpawnRecorder(34570);
    spawn.mockImplementation(recorder.impl);

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
        port: 34570,
        explicitPort: true,
        host: '127.0.0.1',
        quiet: true,
        suppressQuietOutput: true,
        suppressUiPasswordWarning: true,
        guardian: true,
        handoff: true,
      });

      const guardianSpawns = recorder.calls.filter((call) => call.isGuardianSpawn);
      expect(guardianSpawns).toHaveLength(0);
      // The server child still spawns.
      const serverSpawns = recorder.calls.filter((call) => !call.isGuardianSpawn);
      expect(serverSpawns).toHaveLength(1);
      // isGuardianRunning was never even probed because shouldAutoStartGuardian
      // short-circuited before the probe.
      expect(isGuardianRunning).not.toHaveBeenCalled();
    } finally {
      if (previousDataDir === undefined) delete process.env.OPENCHAMBER_DATA_DIR;
      else process.env.OPENCHAMBER_DATA_DIR = previousDataDir;
      if (previousOwner === undefined) delete process.env.OPENCHAMBER_GUARDIAN_OWNER_ID;
      else process.env.OPENCHAMBER_GUARDIAN_OWNER_ID = previousOwner;
    }
  });

  it('foreground path does not autostart the guardian when OPENCODE_SKIP_START=true', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-serve-skipstart-fg-'));
    tempRoots.push(dataDir);
    const serverPath = path.join(dataDir, 'server.mjs');
    fs.writeFileSync(
      serverPath,
      'export async function startWebUiServer() { return { getPort: () => 34571, stop: async () => {} }; }\n',
    );

    const previousEnv = {
      dataDir: process.env.OPENCHAMBER_DATA_DIR,
      owner: process.env.OPENCHAMBER_GUARDIAN_OWNER_ID,
      binary: process.env.OPENCODE_BINARY,
      host: process.env.OPENCHAMBER_HOST,
      runtime: process.env.OPENCHAMBER_RUNTIME,
    };
    process.env.OPENCHAMBER_DATA_DIR = dataDir;
    process.env.OPENCODE_SKIP_START = 'true';
    delete process.env.OPENCHAMBER_GUARDIAN_OWNER_ID;
    isGuardianRunning.mockResolvedValue(false);

    const recorder = createSpawnRecorder(null);
    spawn.mockImplementation(recorder.impl);

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
      port: 34571,
      explicitPort: true,
      host: '127.0.0.1',
      foreground: true,
      quiet: true,
      suppressQuietOutput: true,
      suppressUiPasswordWarning: true,
      suppressStartupSummary: true,
      guardian: true,
      handoff: true,
    });

    // Let the foreground server start settle.
    const instanceFilePath = await getInstanceFilePath(34571);
    for (let attempt = 0; attempt < 50 && !fs.existsSync(instanceFilePath); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    try {
      const guardianSpawns = recorder.calls.filter((call) => call.isGuardianSpawn);
      expect(guardianSpawns).toHaveLength(0);
      expect(isGuardianRunning).not.toHaveBeenCalled();
    } finally {
      const exitListener = process.listeners('exit').at(-1);
      if (exitListener) process.removeListener('exit', exitListener);
      for (const signal of ['SIGINT', 'SIGTERM', 'SIGQUIT']) {
        const listener = process.listeners(signal).at(-1);
        if (listener) process.removeListener(signal, listener);
      }
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      void foregroundPromise;
    }
  });
});
