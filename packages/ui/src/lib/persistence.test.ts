import { afterAll, beforeEach, describe, expect, test } from 'bun:test';

import type { RuntimeAPIs, SettingsPayload } from '@/lib/api/types';
import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { startModelPrefsAutoSave } from '@/lib/modelPrefsAutoSave';
import { useUIStore } from '@/stores/useUIStore';
import { applyPersistedHomeDirectoryToWindow, syncDesktopSettings, updateDesktopSettings } from './persistence';

type TestWindow = {
  __OPENCHAMBER_HOME__?: string;
  dispatchEvent: (event: Event) => boolean;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
};

let createdWindow = false;
let createdLocalStorage = false;

const ensureLocalStorage = (): void => {
  if (typeof localStorage !== 'undefined') {
    return;
  }

  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
      clear: () => {
        values.clear();
      },
    },
    configurable: true,
    writable: true,
  });
  createdLocalStorage = true;
};

const getWindow = (): TestWindow => {
  if (typeof window === 'undefined') {
    Object.defineProperty(globalThis, 'window', {
      value: {},
      configurable: true,
      writable: true,
    });
    createdWindow = true;
  }
  const testWindow = window as unknown as Partial<TestWindow>;
  testWindow.dispatchEvent ??= () => true;
  testWindow.setTimeout ??= setTimeout;
  testWindow.clearTimeout ??= clearTimeout;
  ensureLocalStorage();
  return testWindow as TestWindow;
};

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const registerSettingsApi = (
  save: (changes: Partial<SettingsPayload>) => Promise<SettingsPayload>,
  load: () => Promise<{ settings: SettingsPayload; source: 'web' | 'vscode' }> = async () => ({ settings: {}, source: 'web' }),
): void => {
  registerRuntimeAPIs({
    runtime: { platform: 'web', isDesktop: false, isVSCode: false },
    settings: {
      load,
      save,
    },
  } as unknown as RuntimeAPIs);
};

const registerSettingsSave = (save: (changes: Partial<SettingsPayload>) => Promise<SettingsPayload>): void => {
  registerSettingsApi(save);
};

const resetModelPrefsState = (): void => {
  useUIStore.setState({
    favoriteModels: [],
    hiddenModels: [],
    collapsedModelProviders: [],
    recentModels: [],
    recentAgents: [],
    recentEfforts: {},
  });
};

afterAll(() => {
  registerRuntimeAPIs(null);
  if (createdWindow) {
    delete (globalThis as { window?: unknown }).window;
  } else if (typeof window !== 'undefined') {
    delete getWindow().__OPENCHAMBER_HOME__;
  }
  if (createdLocalStorage) {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});

describe('applyPersistedHomeDirectoryToWindow', () => {
  beforeEach(() => {
    delete getWindow().__OPENCHAMBER_HOME__;
  });

  test('does not overwrite an injected desktop home directory', () => {
    getWindow().__OPENCHAMBER_HOME__ = '/Users/example';

    applyPersistedHomeDirectoryToWindow('/Users/example/projects/app');

    expect(getWindow().__OPENCHAMBER_HOME__).toBe('/Users/example');
  });

  test('uses persisted home when no runtime home was injected', () => {
    applyPersistedHomeDirectoryToWindow('/Users/example/projects/app');

    expect(getWindow().__OPENCHAMBER_HOME__).toBe('/Users/example/projects/app');
  });
});

describe('updateDesktopSettings', () => {
  beforeEach(() => {
    getWindow();
    registerRuntimeAPIs(null);
    resetModelPrefsState();
  });

  test('waits for the debounced settings save to finish before resolving', async () => {
    let saveStarted = false;
    let saveFinished = false;
    let updateResolved = false;

    registerSettingsSave(async () => {
      saveStarted = true;
      await delay(100);
      saveFinished = true;
      return {};
    });

    const update = updateDesktopSettings({
      skillCatalogs: [{ id: 'custom:test', label: 'Test', source: 'owner/repo' }],
    });
    update.then(() => {
      updateResolved = true;
    }).catch(() => {
      updateResolved = true;
    });

    await delay(50);
    expect(saveStarted).toBe(false);
    expect(updateResolved).toBe(false);

    await delay(200);
    expect(saveStarted).toBe(true);
    expect(saveFinished).toBe(false);
    expect(updateResolved).toBe(false);

    await update;
    expect(saveFinished).toBe(true);
    expect(updateResolved).toBe(true);
  });

  test('coalesces rapid settings updates and resolves every caller after one merged save', async () => {
    const saveCalls: Array<Partial<SettingsPayload>> = [];
    let firstResolved = false;
    let secondResolved = false;

    registerSettingsSave(async (changes) => {
      saveCalls.push(changes);
      await delay(50);
      return {};
    });

    const first = updateDesktopSettings({ themeVariant: 'dark' });
    first.then(() => {
      firstResolved = true;
    }).catch(() => {
      firstResolved = true;
    });

    await delay(50);

    const second = updateDesktopSettings({ fontSize: 14 });
    second.then(() => {
      secondResolved = true;
    }).catch(() => {
      secondResolved = true;
    });

    await Promise.all([first, second]);

    expect(saveCalls).toEqual([{ themeVariant: 'dark', fontSize: 14 }]);
    expect(firstResolved).toBe(true);
    expect(secondResolved).toBe(true);
  });

  test('applies model selector settings from server settings', async () => {
    getWindow();
    const settings = {
      favoriteModels: [{ providerID: 'anthropic', modelID: 'claude-haiku-4' }],
      hiddenModels: [{ providerID: 'openai', modelID: 'gpt-5' }],
      collapsedModelProviders: ['anthropic', 'openai'],
      recentModels: [{ providerID: 'google', modelID: 'gemini-pro' }],
      recentAgents: ['build', 'plan'],
      recentEfforts: { 'anthropic/claude-haiku-4': ['high', 'default'] },
      draftStartersCraftGoalAdded: true,
    } satisfies SettingsPayload;
    registerSettingsApi(async () => ({}), async () => ({ settings, source: 'web' }));

    await syncDesktopSettings();

    const state = useUIStore.getState();
    expect(state.favoriteModels).toEqual(settings.favoriteModels);
    expect(state.hiddenModels).toEqual(settings.hiddenModels);
    expect(state.collapsedModelProviders).toEqual(settings.collapsedModelProviders);
    expect(state.recentModels).toEqual(settings.recentModels);
    expect(state.recentAgents).toEqual(settings.recentAgents);
    expect(state.recentEfforts).toEqual(settings.recentEfforts);
  });

  test('autosaves all model selector settings fields', async () => {
    getWindow();
    const saveCalls: Array<Partial<SettingsPayload>> = [];
    registerSettingsSave(async (changes) => {
      saveCalls.push(changes);
      return changes as SettingsPayload;
    });
    const stop = startModelPrefsAutoSave();

    try {
      useUIStore.setState({ favoriteModels: [{ providerID: 'anthropic', modelID: 'claude-haiku-4' }] });
      await delay(20);
      useUIStore.setState({
        hiddenModels: [{ providerID: 'openai', modelID: 'gpt-5' }],
        collapsedModelProviders: ['openai'],
        recentModels: [{ providerID: 'google', modelID: 'gemini-pro' }],
        recentAgents: ['build'],
        recentEfforts: { 'openai/gpt-5': ['low'] },
      });

      await delay(1500);

      expect(saveCalls).toHaveLength(1);
      expect(saveCalls[0]).toEqual({
        draftStartersCraftGoalAdded: true,
        favoriteModels: [{ providerID: 'anthropic', modelID: 'claude-haiku-4' }],
        hiddenModels: [{ providerID: 'openai', modelID: 'gpt-5' }],
        collapsedModelProviders: ['openai'],
        recentModels: [{ providerID: 'google', modelID: 'gemini-pro' }],
        recentAgents: ['build'],
        recentEfforts: { 'openai/gpt-5': ['low'] },
      });
    } finally {
      stop();
    }
  });
});
