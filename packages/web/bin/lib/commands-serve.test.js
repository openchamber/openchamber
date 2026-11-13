import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createServeCommand } from './commands-serve.js';
import { INJECTED_ENV_KEY } from '../../server/lib/injected-env.js';

it('a foreground server keeps its selected binary after dropping an app shell environment', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-serve-env-'));
  const keys = [INJECTED_ENV_KEY, 'OPENCHAMBER_DATA_DIR', 'OPENCHAMBER_DIST_DIR', 'OPENCODE_BINARY'];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  const selectedBinary = '/qa/selected-opencode';
  const fixture = path.join(directory, 'server.mjs');
  await fs.writeFile(fixture, `export function startWebUiServer() {
    const error = new Error('fixture reached');
    error.binary = process.env.OPENCODE_BINARY;
    error.dist = process.env.OPENCHAMBER_DIST_DIR;
    throw error;
  }`);
  try {
    process.env.OPENCHAMBER_DATA_DIR = directory;
    process.env.OPENCHAMBER_DIST_DIR = '/qa/installed-assets';
    process.env.OPENCODE_BINARY = '/qa/inherited-opencode';
    process.env[INJECTED_ENV_KEY] = 'OPENCODE_BINARY,OPENCHAMBER_DIST_DIR';
    const serve = createServeCommand({
      serverPath: fixture,
      bunBin: process.execPath,
      checkOpenCodeCLI: async () => selectedBinary,
      getPreferredServerRuntime: () => 'node',
      setForegroundServerActive: () => {},
      setForegroundShutdown: () => {},
    });

    await expect(serve({ port: 0, explicitPort: true, foreground: true, host: '127.0.0.1', suppressUiPasswordWarning: true }))
      .rejects.toMatchObject({ message: 'fixture reached', binary: selectedBinary, dist: undefined });
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(directory, { recursive: true, force: true });
  }
});

it('a front door starts without looking for an OpenCode of its own', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-serve-front-door-'));
  const keys = [INJECTED_ENV_KEY, 'OPENCHAMBER_DATA_DIR', 'OPENCODE_BINARY', 'OPENCHAMBER_AGENT_SERVER_URL', 'OPENCHAMBER_AGENT_SERVER_TOKEN'];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  const fixture = path.join(directory, 'server.mjs');
  await fs.writeFile(fixture, `export function startWebUiServer() {
    const error = new Error('fixture reached');
    error.binary = process.env.OPENCODE_BINARY;
    throw error;
  }`);
  try {
    process.env.OPENCHAMBER_DATA_DIR = directory;
    delete process.env.OPENCODE_BINARY;
    process.env.OPENCHAMBER_AGENT_SERVER_URL = 'http://127.0.0.1:41890';
    process.env.OPENCHAMBER_AGENT_SERVER_TOKEN = 'synthetic-token';
    let looked = 0;
    const serve = createServeCommand({
      serverPath: fixture,
      bunBin: process.execPath,
      checkOpenCodeCLI: async () => { looked += 1; throw new Error('Unable to locate the opencode CLI'); },
      getPreferredServerRuntime: () => 'node',
      setForegroundServerActive: () => {},
      setForegroundShutdown: () => {},
    });
    await expect(serve({ port: 0, explicitPort: true, foreground: true, host: '127.0.0.1', suppressUiPasswordWarning: true }))
      .rejects.toMatchObject({ message: 'fixture reached', binary: undefined });
    expect(looked).toBe(0);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(directory, { recursive: true, force: true });
  }
});
