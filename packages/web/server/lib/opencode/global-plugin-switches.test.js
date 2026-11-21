import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createAdaptivePluginSwitchStore, createGlobalConfigPluginSwitchStore } from './global-plugin-switches.js';

const tempDirs = [];

const createTempDir = async (prefix) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};

afterEach(async () => {
  while (tempDirs.length > 0) {
    await fs.rm(tempDirs.pop(), { recursive: true, force: true }).catch(() => {});
  }
});

describe('global-plugin-switches', () => {
  it('writes and removes plugin denial policies in global opencode.json while preserving unrelated policies', async () => {
    const dir = await createTempDir('oc-global-switches-');
    const userPath = path.join(dir, 'opencode.json');
    let disk = {
      plugins: ['acme-plugin'],
      policies: [{ action: 'shell', resource: '*', effect: 'allow' }],
    };

    const store = createGlobalConfigPluginSwitchStore({
      readLayers: () => ({
        paths: { userPath, userOverridePath: null, projectPath: null, customPath: null },
        userConfig: structuredClone(disk),
        userOverrideConfig: {},
        projectConfig: {},
        customConfig: {},
        errors: new Map(),
      }),
      writeLayer: (config) => {
        disk = structuredClone(config);
      },
    });

    expect(store.read()).toEqual({ ok: true, resources: [] });
    expect(store.set('plugin:acme-plugin', false)).toEqual({ changed: true });
    expect(store.set('plugin:acme-plugin', false)).toEqual({ changed: false });
    expect(store.read()).toEqual({ ok: true, resources: ['plugin:acme-plugin'] });
    expect(disk.policies).toEqual([
      { action: 'shell', resource: '*', effect: 'allow' },
      { action: 'integration.use', resource: 'plugin:acme-plugin', effect: 'deny' },
    ]);

    expect(store.set('plugin:acme-plugin', true)).toEqual({ changed: true });
    expect(store.set('plugin:acme-plugin', true)).toEqual({ changed: false });
    expect(store.read()).toEqual({ ok: true, resources: [] });
    expect(disk.policies).toEqual([{ action: 'shell', resource: '*', effect: 'allow' }]);
  });

  it('delegates to globalStore when external mode is active and managedStore otherwise', () => {
    let external = false;
    const managedCalls = [];
    const globalCalls = [];
    const makeStore = (name, calls) => ({
      filePath: `/tmp/${name}.json`,
      read: () => { calls.push('read'); return { ok: true, resources: [] }; },
      set: (resource, enabled) => { calls.push(`set:${resource}:${enabled}`); return { changed: true }; },
      denials: () => { calls.push('denials'); return []; },
    });

    const adaptive = createAdaptivePluginSwitchStore({
      managedStore: makeStore('managed', managedCalls),
      globalStore: makeStore('global', globalCalls),
      isGlobalMode: () => external,
    });

    adaptive.set('plugin:a', false);
    external = true;
    adaptive.set('plugin:b', false);

    expect(managedCalls).toEqual(['set:plugin:a:false']);
    expect(globalCalls).toEqual(['set:plugin:b:false']);
  });
});
