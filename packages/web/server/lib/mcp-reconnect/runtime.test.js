import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMcpReconnectRuntime } from './runtime.js';

const temporaryDirectories = [];
const disposers = [];

beforeEach(() => {
  // The plugin reads this seam when it is imported; 0.5 makes the jitter
  // factor exactly 1 so backoff timings are deterministic.
  globalThis.__openchamberMcpReconnectTestRandom = () => 0.5;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  await Promise.all(disposers.splice(0).map((dispose) => dispose()));
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete globalThis.__openchamberMcpReconnectTestRandom;
  delete globalThis.__openchamberMcpReconnectCoordinator;
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

/**
 * Fire the arming event a real instance emits once its MCP is running. The
 * plugin makes no status call before this, so tests that expect polling or
 * reconnects must arm it first.
 */
const arm = (hooks) => hooks.event({ event: { type: 'mcp.tools.changed' } });

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
    await arm(await start(plugin, client));

    await vi.advanceTimersByTimeAsync(1000);

    expect(client.attempts.map((attempt) => attempt.name)).toEqual(['broken']);
  });

  it('makes no status call in an instance whose MCP has never run', async () => {
    vi.useFakeTimers();
    const { plugin } = await materialize();
    const client = createClient({ broken: { status: 'failed', error: 'refused' } });
    await start(plugin, client);

    // Ten minutes of pure timer passage with no events: the plugin must stay
    // passive. Reading status initializes MCP as a side effect, and polling
    // from load multiplied the whole stdio fleet across every background
    // instance at startup.
    await vi.advanceTimersByTimeAsync(600_000);

    expect(client.mcp.status).not.toHaveBeenCalled();
    expect(client.attempts).toHaveLength(0);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('backs off per server, gives up after the attempt cap, and says so once', async () => {
    vi.useFakeTimers();
    const { plugin } = await materialize();
    const client = createClient({ broken: { status: 'failed', error: 'refused' } });
    const started = Date.now();
    await arm(await start(plugin, client));

    await vi.advanceTimersByTimeAsync(92_000);
    expect(client.attempts.map((attempt) => attempt.at - started)).toEqual([
      1000, 2000, 4000, 8000, 16_000,
    ]);
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('broken'));

    await vi.advanceTimersByTimeAsync(300_000);
    expect(client.attempts).toHaveLength(5);
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it('starts a fresh retry episode after a given-up server recovers and drops again', async () => {
    vi.useFakeTimers();
    const { plugin } = await materialize();
    const statuses = { flaky: { status: 'failed', error: 'refused' } };
    const client = createClient(statuses);
    const hooks = await start(plugin, client);
    await arm(hooks);

    await vi.advanceTimersByTimeAsync(92_000);
    expect(client.attempts).toHaveLength(5);

    statuses.flaky = { status: 'connected' };
    await vi.advanceTimersByTimeAsync(31_000);
    statuses.flaky = { status: 'failed', error: 'Connection closed' };
    await hooks.event({ event: { type: 'mcp.tools.changed', properties: { server: 'flaky' } } });
    await vi.advanceTimersByTimeAsync(1000);

    expect(client.attempts).toHaveLength(6);
  });

  it('jitters the backoff by up to twenty percent', async () => {
    vi.useFakeTimers();
    const run = async (stub) => {
      globalThis.__openchamberMcpReconnectTestRandom = stub;
      const { plugin } = await materialize();
      const client = createClient({ broken: { status: 'failed', error: 'refused' } });
      const started = Date.now();
      await arm(await start(plugin, client));
      await vi.advanceTimersByTimeAsync(60_000);
      return client.attempts.map((attempt) => attempt.at - started);
    };

    expect(await run(() => 0)).toEqual([1000, 1800, 3400, 6600, 13_000]);
    expect(await run(() => 1)).toEqual([1000, 2200, 4600, 9400, 19_000]);
  });

  it('ignores tool-change events for servers it has given up on', async () => {
    vi.useFakeTimers();
    const { plugin } = await materialize();
    const client = createClient({ broken: { status: 'failed', error: 'refused' } });
    const hooks = await start(plugin, client);
    await arm(hooks);
    await vi.advanceTimersByTimeAsync(92_000);
    expect(client.attempts).toHaveLength(5);

    const statusCalls = client.mcp.status.mock.calls.length;
    await hooks.event({ event: { type: 'mcp.tools.changed', properties: { server: 'broken' } } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(client.mcp.status.mock.calls.length).toBe(statusCalls);

    await hooks.event({ event: { type: 'mcp.tools.changed', properties: { server: 'other' } } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(client.mcp.status.mock.calls.length).toBe(statusCalls + 1);

    await hooks.event({ event: { type: 'mcp.tools.changed' } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(client.mcp.status.mock.calls.length).toBe(statusCalls + 2);
  });

  it('caps concurrent reconnects across directory instances', async () => {
    vi.useFakeTimers();
    const first = await materialize();
    const second = await materialize();
    const statuses = {
      a: { status: 'failed', error: 'refused' },
      b: { status: 'failed', error: 'refused' },
      c: { status: 'failed', error: 'refused' },
    };
    // Connects stay pending until the test resolves them, like a real server
    // that is slow to come up.
    const pending = [];
    const createHoldingClient = () => ({
      mcp: {
        status: vi.fn(async () => ({ data: { ...statuses } })),
        connect: vi.fn(({ path: { name } }) => new Promise((resolve) => pending.push({ name, resolve }))),
      },
    });
    const clientA = createHoldingClient();
    const clientB = createHoldingClient();
    await arm(await start(first.plugin, clientA));
    await arm(await start(second.plugin, clientB));

    await vi.advanceTimersByTimeAsync(1000);
    expect(clientA.mcp.connect.mock.calls.map(([{ path }]) => path.name)).toEqual(['a', 'b']);
    expect(clientB.mcp.connect).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(clientA.mcp.connect).toHaveBeenCalledTimes(2);
    expect(clientB.mcp.connect).not.toHaveBeenCalled();

    for (const { resolve } of pending.splice(0)) resolve(undefined);
    statuses.a = { status: 'connected' };
    statuses.b = { status: 'connected' };
    await vi.advanceTimersByTimeAsync(2000);
    expect(clientA.mcp.connect.mock.calls.map(([{ path }]) => path.name)).toEqual(['a', 'b', 'c']);
    expect(clientB.mcp.connect).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3000);
    expect(clientB.mcp.connect.mock.calls.map(([{ path }]) => path.name)).toEqual(['c']);
  });

  it('stops retrying once a server is back and starts fresh when it drops again', async () => {
    vi.useFakeTimers();
    const { plugin } = await materialize();
    const statuses = { flaky: { status: 'failed', error: 'refused' } };
    const client = createClient(statuses, {
      onConnect: () => { statuses.flaky = { status: 'connected' }; },
    });
    const hooks = await start(plugin, client);
    await arm(hooks);

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
    await arm(await start(plugin, client));

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
