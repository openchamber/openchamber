import { describe, expect, it, vi } from 'vitest';
import crypto from 'crypto';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';

import { createSettingsHelpers } from './settings-helpers.js';
import { createSettingsRuntime } from './settings-runtime.js';
import { createServerBrowserLifecycle } from '../browser/server-browser-lifecycle.js';

const createHelpers = () => createSettingsHelpers({
  normalizePathForPersistence: (value) => value,
  normalizeDirectoryPath: (value) => value,
  normalizeTunnelBootstrapTtlMs: (value) => value,
  normalizeTunnelSessionTtlMs: (value) => value,
  normalizeTunnelProvider: (value) => value,
  normalizeTunnelMode: (value) => value,
  normalizeOptionalPath: (value) => value,
  normalizeManagedRemoteTunnelHostname: (value) => value,
  normalizeManagedRemoteTunnelPresets: () => undefined,
  normalizeManagedRemoteTunnelPresetTokens: () => undefined,
  sanitizeTypographySizesPartial: () => undefined,
  normalizeStringArray: (input) => (Array.isArray(input) ? input : []),
  sanitizeModelRefs: () => undefined,
  sanitizeSkillCatalogs: () => undefined,
  sanitizeProjects: () => undefined,
});

const createRealRuntime = async () => {
  const tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'oc-server-browser-settings-'));
  const settingsFilePath = path.join(tempRoot, 'settings.json');
  const helpers = createHelpers();
  const runtime = createSettingsRuntime({
    fsPromises,
    path,
    crypto,
    SETTINGS_FILE_PATH: settingsFilePath,
    sanitizeProjects: (projects) => (Array.isArray(projects) ? projects : []),
    sanitizeSettingsUpdate: helpers.sanitizeSettingsUpdate,
    mergePersistedSettings: helpers.mergePersistedSettings,
    normalizeSettingsPaths: (settings) => ({ settings, changed: false }),
    normalizeStringArray: helpers.normalizeStringArray,
    formatSettingsResponse: helpers.formatSettingsResponse,
    resolveDirectoryCandidate: (value) => value,
    normalizeManagedRemoteTunnelHostname: (value) => value,
    normalizeManagedRemoteTunnelPresets: (value) => value,
    normalizeManagedRemoteTunnelPresetTokens: (value) => value,
    syncManagedRemoteTunnelConfigWithPresets: async () => {},
    upsertManagedRemoteTunnelToken: async () => {},
  });
  return {
    runtime,
    settingsFilePath,
    preferencesFilePath: path.join(tempRoot, 'preferences.json'),
    cleanup: () => fsPromises.rm(tempRoot, { recursive: true, force: true }),
  };
};

const createFakeComposition = () => {
  const calls = { kill: 0, close: 0 };
  const order = [];
  return {
    calls,
    order,
    composition: {
      chromeProcessManager: {
        kill: async () => { calls.kill += 1; order.push('kill'); },
        shutdown: async () => { calls.kill += 1; order.push('kill'); },
        getPrivatePorts: async () => [],
      },
      browserSessionManager: {
        close: async () => { calls.close += 1; order.push('close'); },
      },
      backend: { kind: 'fake-server-chrome' },
    },
  };
};

describe('serverBrowserEnabled setting', () => {
  it('excludes configured and active CDP ports without composing a stopped browser', async () => {
    const fake = createFakeComposition();
    fake.composition.chromeProcessManager.getPrivatePorts = async () => [40211];
    const compose = vi.fn(async () => fake.composition);
    const lifecycle = createServerBrowserLifecycle({ compose });
    lifecycle.setDebugPort(40212);
    expect(await lifecycle.getPrivatePorts()).toEqual([40212]);
    expect(compose).not.toHaveBeenCalled();
    await lifecycle.apply(true);
    await lifecycle.ensureComposition();
    expect(await lifecycle.getPrivatePorts()).toEqual([40211, 40212]);
    const killing = Promise.withResolvers();
    fake.composition.chromeProcessManager.kill = () => killing.promise;
    const stopping = lifecycle.apply(false);
    let settled = false;
    const ports = lifecycle.getPrivatePorts().then((value) => { settled = true; return value; });
    await Promise.resolve();
    expect(settled).toBe(false);
    killing.resolve();
    await stopping;
    expect(await ports).toEqual([40212]);
  });

  it('defaults the debug port to automatic and sanitizes invalid persisted values', () => {
    const helpers = createHelpers();
    expect(helpers.formatSettingsResponse({}).serverBrowserDebugPort).toBe(0);
    for (const port of [0, 9222, 65535]) {
      expect(helpers.sanitizeSettingsUpdate({ serverBrowserDebugPort: port })).toEqual({ serverBrowserDebugPort: port });
    }
    for (const port of [-1, 65536, 1.5, '9222', null, NaN]) {
      expect(helpers.sanitizeSettingsUpdate({ serverBrowserDebugPort: port })).toEqual({});
      expect(helpers.formatSettingsResponse({ serverBrowserDebugPort: port }).serverBrowserDebugPort).toBe(0);
    }
  });

  it('round trips automatic and fixed debug ports without erasing valid settings on invalid updates', async () => {
    const { runtime, settingsFilePath, preferencesFilePath, cleanup } = await createRealRuntime();
    try {
      expect((await runtime.persistSettings({ serverBrowserDebugPort: 9222 })).serverBrowserDebugPort).toBe(9222);
      expect((await runtime.readSettingsFromDisk()).serverBrowserDebugPort).toBe(9222);
      expect((await runtime.persistSettings({ serverBrowserDebugPort: -1 })).serverBrowserDebugPort).toBe(9222);
      expect((await runtime.persistSettings({ serverBrowserDebugPort: 0 })).serverBrowserDebugPort).toBe(0);
      expect((await runtime.readSettingsFromDisk()).serverBrowserDebugPort).toBe(0);
      expect(JSON.parse(await fsPromises.readFile(settingsFilePath, 'utf8')).serverBrowserDebugPort).toBe(0);
      expect(JSON.parse(await fsPromises.readFile(preferencesFilePath, 'utf8')).fields).toEqual({});
    } finally {
      await cleanup();
    }
  });

  it('is absent by default and only accepts booleans', () => {
    const helpers = createHelpers();
    expect(helpers.sanitizeSettingsUpdate({ serverBrowserEnabled: true })).toEqual({ serverBrowserEnabled: true });
    expect(helpers.sanitizeSettingsUpdate({ serverBrowserEnabled: false })).toEqual({ serverBrowserEnabled: false });
    expect(helpers.sanitizeSettingsUpdate({ serverBrowserEnabled: 'yes' })).toEqual({});
    expect(helpers.sanitizeSettingsUpdate({ serverBrowserEnabled: 'true' })).toEqual({});
    expect(helpers.sanitizeSettingsUpdate({ serverBrowserEnabled: 1 })).toEqual({});
    expect(helpers.sanitizeSettingsUpdate({ serverBrowserEnabled: null })).toEqual({});
    // Default off: an unset key must not appear enabled in the response.
    expect(helpers.formatSettingsResponse({}).serverBrowserEnabled).not.toBe(true);
    expect(helpers.formatSettingsResponse({ serverBrowserEnabled: false }).serverBrowserEnabled).toBe(false);
  });

  it('persists a round trip through the real settings runtime', async () => {
    const { runtime, settingsFilePath, preferencesFilePath, cleanup } = await createRealRuntime();
    try {
      const enabled = await runtime.persistSettings({ serverBrowserEnabled: true });
      expect(enabled.serverBrowserEnabled).toBe(true);
      expect(JSON.parse(await fsPromises.readFile(settingsFilePath, 'utf8')).serverBrowserEnabled).toBe(true);
      expect((await runtime.readSettingsFromDisk()).serverBrowserEnabled).toBe(true);

      const disabled = await runtime.persistSettings({ serverBrowserEnabled: false });
      expect(disabled.serverBrowserEnabled).toBe(false);
      expect(JSON.parse(await fsPromises.readFile(settingsFilePath, 'utf8')).serverBrowserEnabled).toBe(false);
      expect(JSON.parse(await fsPromises.readFile(preferencesFilePath, 'utf8')).fields).toEqual({});
    } finally {
      await cleanup();
    }
  });

  it('sanitizes a wrong-typed value away so the backend never enables', async () => {
    const { runtime, settingsFilePath, cleanup } = await createRealRuntime();
    try {
      const updated = await runtime.persistSettings({ serverBrowserEnabled: 'yes' });
      expect(updated.serverBrowserEnabled).not.toBe(true);
      expect(JSON.parse(await fsPromises.readFile(settingsFilePath, 'utf8')).serverBrowserEnabled).toBeUndefined();

      const lifecycle = createServerBrowserLifecycle({ compose: vi.fn() });
      await lifecycle.apply(updated.serverBrowserEnabled === true);
      expect(lifecycle.isEnabled()).toBe(false);
    } finally {
      await cleanup();
    }
  });
});

describe('server browser lifecycle', () => {
  it('reports configured versus active debug ports without composing or restarting Chrome', async () => {
    const fake = createFakeComposition();
    const process = fake.composition.chromeProcessManager;
    process.activePort = null;
    process.launchDebugPort = null;
    const compose = vi.fn(async () => fake.composition);
    const lifecycle = createServerBrowserLifecycle({ compose });
    expect(await lifecycle.getRuntimeStatus()).toEqual({ configuredPort: 0, running: false, activePort: null, restartRequired: false });
    lifecycle.setDebugPort(9222);
    await lifecycle.apply(true);
    expect(await lifecycle.getRuntimeStatus()).toEqual({ configuredPort: 9222, running: false, activePort: null, restartRequired: false });
    expect(compose).not.toHaveBeenCalled();
    await lifecycle.ensureComposition();
    process.activePort = 9222;
    process.launchDebugPort = 9222;
    expect(await lifecycle.getRuntimeStatus()).toEqual({ configuredPort: 9222, running: true, activePort: 9222, restartRequired: false });
    lifecycle.setDebugPort(0);
    expect(await lifecycle.getRuntimeStatus()).toEqual({ configuredPort: 0, running: true, activePort: 9222, restartRequired: true });
    expect(fake.calls.kill).toBe(0);
    expect(() => lifecycle.setDebugPort(65536)).toThrow(/port/i);
    expect((await lifecycle.getRuntimeStatus()).configuredPort).toBe(0);
    await lifecycle.apply(false);
    expect(await lifecycle.getRuntimeStatus()).toEqual({ configuredPort: 0, running: false, activePort: null, restartRequired: false });
  });

  it('defaults to disabled and rejects composition honestly', async () => {
    const compose = vi.fn();
    const lifecycle = createServerBrowserLifecycle({ compose });
    expect(lifecycle.isEnabled()).toBe(false);
    await expect(lifecycle.ensureComposition()).rejects.toThrow(/disabled/);
    expect(compose).not.toHaveBeenCalled();
  });

  it('arms lazily on enable: nothing composes until the first routed request', async () => {
    const fake = createFakeComposition();
    const compose = vi.fn(async () => fake.composition);
    const lifecycle = createServerBrowserLifecycle({ compose });

    await lifecycle.apply(true);
    expect(lifecycle.isEnabled()).toBe(true);
    expect(compose).not.toHaveBeenCalled();

    const first = await lifecycle.ensureComposition();
    expect(first).toBe(fake.composition);
    expect(compose).toHaveBeenCalledTimes(1);

    const second = await lifecycle.ensureComposition();
    expect(second).toBe(fake.composition);
    expect(compose).toHaveBeenCalledTimes(1);
  });

  it('disable with nothing composed only disposes the gateway', async () => {
    const compose = vi.fn();
    const disposeGateway = vi.fn();
    const lifecycle = createServerBrowserLifecycle({ compose, disposeGateway });

    await lifecycle.apply(true);
    await lifecycle.apply(false);

    expect(lifecycle.isEnabled()).toBe(false);
    expect(disposeGateway).toHaveBeenCalledTimes(1);
    expect(compose).not.toHaveBeenCalled();
    await expect(lifecycle.ensureComposition()).rejects.toThrow(/disabled/);
  });

  it('disable during an in-flight startup cancels it via kill before closing sessions', async () => {
    const fake = createFakeComposition();
    let resolveCompose;
    const compose = vi.fn(() => new Promise((resolve) => { resolveCompose = resolve; }));
    const disposeGateway = vi.fn();
    const lifecycle = createServerBrowserLifecycle({ compose, disposeGateway });

    await lifecycle.apply(true);
    const pending = lifecycle.ensureComposition();

    // Flip off while the composition (process startup path) is still pending.
    const disabling = lifecycle.apply(false);
    expect(lifecycle.isEnabled()).toBe(false);
    // New work is rejected honestly immediately, not after teardown settles.
    await expect(lifecycle.ensureComposition()).rejects.toThrow(/disabled/);

    resolveCompose(fake.composition);
    await Promise.all([pending, disabling]);

    expect(disposeGateway).toHaveBeenCalledTimes(1);
    expect(fake.calls.kill).toBe(1);
    expect(fake.calls.close).toBe(1);
    expect(fake.order).toEqual(['kill', 'close']);
  });

  it('disable with a running Chrome kills it, closes sessions, and clears the composition', async () => {
    const fake = createFakeComposition();
    const compose = vi.fn(async () => fake.composition);
    const disposeGateway = vi.fn();
    const lifecycle = createServerBrowserLifecycle({ compose, disposeGateway });

    await lifecycle.apply(true);
    await lifecycle.ensureComposition();
    await lifecycle.apply(false);

    expect(fake.calls.kill).toBe(1);
    expect(fake.calls.close).toBe(1);
    expect(disposeGateway).toHaveBeenCalledTimes(1);

    // A later re-enable composes a fresh backend rather than reviving the
    // torn-down one.
    await lifecycle.apply(true);
    await lifecycle.ensureComposition();
    expect(compose).toHaveBeenCalledTimes(2);
  });

  it('shutdown tears down a composed backend regardless of the flag', async () => {
    const fake = createFakeComposition();
    const lifecycle = createServerBrowserLifecycle({
      compose: async () => fake.composition,
      disposeGateway: vi.fn(),
    });

    await lifecycle.apply(true);
    await lifecycle.ensureComposition();
    await lifecycle.shutdown();

    expect(fake.calls.kill).toBe(1);
    expect(fake.calls.close).toBe(1);
  });

  it('composeWhileEnabled passes the composed session manager holder to the load callback', async () => {
    const fake = createFakeComposition();
    const lifecycle = createServerBrowserLifecycle({ compose: async () => fake.composition });
    const loaded = { gateway: true, dispose: vi.fn() };
    const load = vi.fn(async () => loaded);

    await lifecycle.apply(true);
    const result = await lifecycle.composeWhileEnabled(load, (value) => value.dispose());

    // The gateway factory receives THE composition — its browserSessionManager
    // is what the gateway binds, never null while enabled.
    expect(load).toHaveBeenCalledWith(fake.composition);
    expect(result).toBe(loaded);
    expect(loaded.dispose).not.toHaveBeenCalled();
  });

  it('composeWhileEnabled never loads while disabled', async () => {
    const compose = vi.fn();
    const load = vi.fn();
    const lifecycle = createServerBrowserLifecycle({ compose });

    await expect(lifecycle.composeWhileEnabled(load)).resolves.toBe(null);
    expect(load).not.toHaveBeenCalled();
    expect(compose).not.toHaveBeenCalled();
  });

  it('a composition failure propagates and never reaches the load callback', async () => {
    const load = vi.fn();
    const lifecycle = createServerBrowserLifecycle({
      compose: async () => { throw new Error('chrome modules failed to load'); },
    });

    await lifecycle.apply(true);
    await expect(lifecycle.composeWhileEnabled(load)).rejects.toThrow('chrome modules failed to load');
    expect(load).not.toHaveBeenCalled();
  });

  it('composeWhileEnabled disposes a stale load when the composition was superseded mid-load', async () => {
    const compA = createFakeComposition();
    const compB = createFakeComposition();
    const compose = vi.fn()
      .mockResolvedValueOnce(compA.composition)
      .mockResolvedValueOnce(compB.composition);
    const lifecycle = createServerBrowserLifecycle({ compose });

    await lifecycle.apply(true);
    const loaded = { gateway: true, dispose: vi.fn() };
    let releaseLoad;
    const load = vi.fn(() => new Promise((resolve) => { releaseLoad = () => resolve(loaded); }));
    const pending = lifecycle.composeWhileEnabled(load, (value) => value.dispose());

    // Disable + re-enable while the load is in flight: the composition the
    // load bound to is torn down and superseded by a fresh one.
    await lifecycle.apply(false);
    await lifecycle.apply(true);
    releaseLoad();

    await expect(pending).resolves.toBe(null);
    expect(load).toHaveBeenCalledWith(compA.composition);
    expect(loaded.dispose).toHaveBeenCalledTimes(1);
    expect(compA.calls.kill).toBe(1);
    expect(compA.calls.close).toBe(1);
  });
});
