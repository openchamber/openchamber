import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createOpenCodeGoSessionPluginRuntime } from './opencode-go-session-plugin.js';

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

const loadPlugin = async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-opencode-go-session-'));
  temporaryDirectories.push(dataDir);
  const runtime = createOpenCodeGoSessionPluginRuntime({ fsPromises: fs, path, dataDir });
  const pluginDirectory = await runtime.materializePlugin();
  const entrypoint = path.join(pluginDirectory, 'index.js');
  return (await import(`${pathToFileURL(entrypoint).href}?test=${Date.now()}`)).default;
};

describe('OpenCode Go session plugin', () => {
  it('gives managed OpenCode Go a session fallback without replacing configured headers', async () => {
    const plugin = await loadPlugin();
    const provider = { headers: { Authorization: 'Bearer test' } };
    const update = vi.fn((providerID, callback) => {
      expect(providerID).toBe('opencode-go');
      callback(provider);
    });
    const transform = vi.fn(async (callback) => callback({ get: () => provider, update }));

    await plugin.setup({ provider: { transform } });

    expect(transform).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledOnce();
    expect(provider.headers.Authorization).toBe('Bearer test');
    expect(provider.headers['x-opencode-session']).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('adds the fallback when the provider has no headers', async () => {
    const plugin = await loadPlugin();
    const provider = {};

    await plugin.setup({
      provider: {
        transform: async (callback) => callback({
          get: () => provider,
          update: (_providerID, update) => update(provider),
        }),
      },
    });

    expect(provider.headers['x-opencode-session']).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('keeps the fallback stable across provider state rebuilds', async () => {
    const plugin = await loadPlugin();
    let applyTransform;

    await plugin.setup({
      provider: {
        transform: async (callback) => { applyTransform = callback; },
      },
    });

    const apply = (provider) => applyTransform({
      get: () => provider,
      update: (_providerID, update) => update(provider),
    });
    const first = {};
    const rebuilt = {};
    apply(first);
    apply(rebuilt);

    expect(rebuilt.headers['x-opencode-session']).toBe(first.headers['x-opencode-session']);
  });

  it('canonicalizes an existing session fallback without changing its value', async () => {
    const plugin = await loadPlugin();
    const provider = { headers: { 'X-OpenCode-Session': 'configured-session' } };

    await plugin.setup({
      provider: {
        transform: async (callback) => callback({
          get: () => provider,
          update: (_providerID, update) => update(provider),
        }),
      },
    });

    expect(provider.headers).toEqual({ 'x-opencode-session': 'configured-session' });
  });

  it('does not create an unavailable OpenCode Go provider', async () => {
    const plugin = await loadPlugin();
    const update = vi.fn();

    await plugin.setup({
      provider: {
        transform: async (callback) => callback({ get: () => undefined, update }),
      },
    });

    expect(update).not.toHaveBeenCalled();
  });
});
