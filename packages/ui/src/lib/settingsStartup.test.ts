import { describe, expect, test } from 'bun:test';

import { ensureSettingsHydrated, runSettingsStartup } from './settingsStartup';

describe('runSettingsStartup', () => {
  test('starts autosave watchers only after every hydration step settles', async () => {
    const events: string[] = [];
    let releaseSync: (() => void) | undefined;
    const syncReady = new Promise<void>((resolve) => { releaseSync = resolve; });

    const startup = runSettingsStartup({
      runtimeKey: 'watcher-order',
      initializeAppearance: async () => { events.push('appearance'); },
      syncSettings: async () => { events.push('sync-start'); await syncReady; events.push('sync-end'); },
      applyDirectory: async () => { events.push('directory'); },
      startWatchers: () => { events.push('watchers'); },
      onError: () => undefined,
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(events).not.toContain('watchers');
    releaseSync?.();
    await startup;
    expect(events.at(-1)).toBe('watchers');
  });

  test('starts watchers after a recoverable secondary hydration failure', async () => {
    const events: string[] = [];
    await runSettingsStartup({
      runtimeKey: 'recoverable-failure',
      initializeAppearance: async () => undefined,
      syncSettings: async () => { throw new Error('offline'); },
      applyDirectory: async () => undefined,
      startWatchers: () => { events.push('watchers'); },
      onError: () => { events.push('error'); },
    });
    expect(events).toEqual(['error', 'watchers']);
  });

  test('coalesces main startup and authentication hydration for one runtime', async () => {
    let syncCalls = 0;
    let appearanceCalls = 0;
    const dependencies = {
      runtimeKey: 'local-runtime',
      initializeAppearance: async () => { appearanceCalls += 1; },
      syncSettings: async () => { syncCalls += 1; },
      applyDirectory: async () => undefined,
      onError: () => undefined,
    };

    await Promise.all([
      ensureSettingsHydrated(dependencies),
      ensureSettingsHydrated(dependencies),
    ]);

    expect(appearanceCalls).toBe(1);
    expect(syncCalls).toBe(1);
  });
});
