/**
 * Reproduction test for GitHub issue #1994:
 * "VS Code drops newly favorited OpenAI models after view changes"
 *
 * Root cause: startModelPrefsAutoSave() exits early when isVSCodeRuntime()
 * is true (line 75-77 of modelPrefsAutoSave.ts), so no store subscription
 * is set up. Favorite-model mutations update only the in-memory Zustand
 * state and are never persisted through the VS Code settings bridge.
 *
 * When the webview is recreated or settings are re-synced,
 * syncDesktopSettings()→applyDesktopUiPreferences() re-applies the
 * persisted (stale) settings that lack the newly added favorite,
 * overwriting the in-memory state.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { useUIStore } from '@/stores/useUIStore';
import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import type { RuntimeAPIs } from '@/lib/api/types';

// ---- helpers ----

// Track calls to updateDesktopSettings. We mock the module so the
// imported startModelPrefsAutoSave() uses our tracked version.
let updateDesktopSettingsCallCount = 0;

const registerVSCodeRuntime = () => {
  registerRuntimeAPIs({
    runtime: { platform: 'vscode', isDesktop: false, isVSCode: true },
    settings: {
      load: async () => ({ settings: {}, source: 'web' as const }),
      save: async () => ({}),
      restartOpenCode: async () => ({ restarted: true }),
    },
  } as unknown as RuntimeAPIs);
};

const resetStoreState = () => {
  useUIStore.setState({
    favoriteModels: [],
    hiddenModels: [],
    collapsedModelProviders: [],
    recentModels: [],
    recentAgents: [],
    recentEfforts: {},
  });
};

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  resetStoreState();
  updateDesktopSettingsCallCount = 0;
});

afterAll(() => {
  registerRuntimeAPIs(null);
});

// ---- tests ----

describe('Issue #1994: VS Code drops newly favorited models', () => {
  test('[bug] startModelPrefsAutoSave() does NOT persist favorites when isVSCodeRuntime() is true', async () => {
    // Mock updateDesktopSettings so we can track whether prefs are persisted
    mock.module('@/lib/persistence', () => ({
      updateDesktopSettings: async () => {
        updateDesktopSettingsCallCount++;
      },
    }));

    // Dynamic import so module-level mocks take effect
    const { startModelPrefsAutoSave: startPrefsSave } = await import(
      `./modelPrefsAutoSave?cache-bust=${Date.now()}`
    );

    registerVSCodeRuntime();
    startPrefsSave();

    // Simulate a user favoriting an OpenAI model — this updates in-memory Zustand state.
    useUIStore.getState().toggleFavoriteModel('openai', 'gpt-4o');

    // Verify: the in-memory store has the new favorite.
    expect(useUIStore.getState().favoriteModels).toEqual([
      { providerID: 'openai', modelID: 'gpt-4o' },
    ]);

    // Wait long enough for the debounced auto-save (1200ms) to have fired if it were active.
    await wait(1500);

    // THE BUG: The auto-save was never triggered because startModelPrefsAutoSave()
    // exits early in VS Code runtime (modelPrefsAutoSave.ts lines 75-77) without
    // setting up a store subscription. The new favorite is only in memory.
    expect(updateDesktopSettingsCallCount).toBe(0);
  });

  test('[bug consequence] in-memory favorites are lost when stale settings are applied (simulating webview recreation)', () => {
    registerVSCodeRuntime();

    // Seed in-memory store with a recently-added favorite (not persisted).
    useUIStore.setState({
      favoriteModels: [{ providerID: 'openai', modelID: 'gpt-4o' }],
    });

    // Simulate what applyDesktopUiPreferences() does on webview recreation
    // (called by syncDesktopSettings in renderVSCodeApp.tsx).
    // The persisted settings loaded from the VS Code bridge don't include
    // the newly added favorite, so they overwrite it:
    const current = useUIStore.getState().favoriteModels;
    const staleNext: Array<{ providerID: string; modelID: string }> = [];
    if (current.length !== staleNext.length || current.some((item, idx) =>
      item.providerID !== staleNext[idx]?.providerID || item.modelID !== staleNext[idx]?.modelID
    )) {
      useUIStore.setState({ favoriteModels: staleNext });
    }

    // The in-memory favorite is now GONE — overwritten by stale persisted state.
    expect(useUIStore.getState().favoriteModels).toEqual([]);
  });
});
