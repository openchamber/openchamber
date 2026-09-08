import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMcpReconnectRuntime } from './runtime.js';

const temporaryDirectories = [];
const disposers = [];

afterEach(async () => {
  await Promise.all(disposers.splice(0).map((dispose) => dispose()));
  vi.useRealTimers();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

const materialize = async (rawConfig = '{}') => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-mcp-reconnect-'));
  temporaryDirectories.push(dataDir);
  const runtime = createMcpReconnectRuntime({ fsPromises: fs, path, dataDir });
  const prepared = await runtime.prepareManagedOpenCodeEnv(rawConfig);
  const pluginPath = path.join(dataDir, 'mcp-reconnect', 'openchamber-mcp-reconnect-plugin.js');
  const pluginModule = await import(`${pathToFileURL(pluginPath).href}?test=${Date.now()}-${Math.random()}`);
  return { prepared, pluginPath, plugin: pluginModule.OpenChamberMcpReconnectPlugin };
};

/**
 * A stand-in for the SDK client OpenCode hands to plugins. `statuses` is live
 * state the test mutates; `connect` records when each attempt happened.
 */
const createClient = (statuses, { onConnect } = {}) => {
  const attempts = [];
  return {
    attempts,
    statuses,
    mcp: {
      status: vi.fn(async () => ({ data: { ...statuses } })),
      connect: vi.fn(async ({ path: { name } }) => {
        attempts.push({ name, at: Date.now() });
        onConnect?.(name);
        return { data: true };
      }),
    },
  };
};

const start = async (plugin, client) => {
  const hooks = await plugin({ client });
  disposers.push(hooks.dispose);
  return hooks;
};

describe('managed MCP reconnect runtime', () => {
  it('materializes the plugin and preserves existing plugin entries', async () => {
    const { prepared, pluginPath } = await materialize('{ "plugin": ["file:///existing.js"], "model": "test/model" }');
    const config = JSON.parse(prepared.OPENCODE_CONFIG_CONTENT);
    expect(config.model).toBe('test/model');
    expect(config.plugin).toEqual(['file:///existing.js', pathToFileURL(pluginPath).href]);
  });

  it('reconnects only servers in the failed state', async () => {
    vi.useFakeTimers();
    const { plugin } = await materialize();
    const client = createClient({
      broken: { status: 'failed', error: 'spawn ENOENT' },
      healthy: { status: 'connected' },
      off: { status: 'disabled' },
      login: { status: 'needs_auth' },
      registration: { status: 'needs_client_registration', error: 'no client id' },
    });
    await start(plugin, client);

    await vi.advanceTimersByTimeAsync(1000);

    expect(client.attempts.map((attempt) => attempt.name)).toEqual(['broken']);
  });

  it('backs off per server up to a cap while it keeps failing', async () => {
    vi.useFakeTimers();
    const { plugin } = await materialize();
    const client = createClient({ broken: { status: 'failed', error: 'refused' } });
    const started = Date.now();
    await start(plugin, client);

    await vi.advanceTimersByTimeAsync(92_000);

    expect(client.attempts.map((attempt) => attempt.at - started)).toEqual([
      1000, 2000, 4000, 8000, 16_000, 32_000, 62_000, 92_000,
    ]);
  });

  it('stops retrying once a server is back and starts fresh when it drops again', async () => {
    vi.useFakeTimers();
    const { plugin } = await materialize();
    const statuses = { flaky: { status: 'failed', error: 'refused' } };
    const client = createClient(statuses, {
      onConnect: () => { statuses.flaky = { status: 'connected' }; },
    });
    const hooks = await start(plugin, client);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(client.attempts).toHaveLength(1);

    statuses.flaky = { status: 'failed', error: 'Connection closed' };
    await hooks.event({ event: { type: 'mcp.tools.changed', properties: { server: 'flaky' } } });
    await vi.advanceTimersByTimeAsync(1000);

    expect(client.attempts).toHaveLength(2);
    expect(client.attempts[1].at - client.attempts[0].at).toBeGreaterThan(30_000);
  });

  it('keeps going when status is temporarily unavailable', async () => {
    vi.useFakeTimers();
    const { plugin } = await materialize();
    const client = createClient({ broken: { status: 'failed', error: 'refused' } });
    client.mcp.status.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await start(plugin, client);

    await vi.advanceTimersByTimeAsync(1000);
    expect(client.attempts).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(client.attempts).toHaveLength(1);
  });

  it('does nothing after dispose', async () => {
    vi.useFakeTimers();
    const { plugin } = await materialize();
    const client = createClient({ broken: { status: 'failed', error: 'refused' } });
    const hooks = await plugin({ client });

    await hooks.dispose();
    await hooks.event({ event: { type: 'mcp.tools.changed', properties: { server: 'broken' } } });
    await vi.advanceTimersByTimeAsync(120_000);

    expect(client.mcp.status).not.toHaveBeenCalled();
    expect(client.attempts).toHaveLength(0);
  });
});
