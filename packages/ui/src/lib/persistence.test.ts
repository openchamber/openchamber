import { afterAll, beforeEach, describe, expect, test } from 'bun:test';

import type { RuntimeAPIs, SettingsPayload } from '@/lib/api/types';
import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { startModelPrefsAutoSave } from '@/lib/modelPrefsAutoSave';
import { startAppearanceAutoSave } from '@/lib/appearanceAutoSave';
import { useUIStore } from '@/stores/useUIStore';
import { useMessageQueueStore } from '@/stores/messageQueueStore';
import {
  applyPersistedHomeDirectoryToWindow,
  getRuntimeSettingsMirrorStorageKey,
  getSettingsSaveState,
  invalidateSettingsCache,
  subscribeToSettingsSaveState,
  syncDesktopSettings,
  updateDesktopSettings,
} from './persistence';
import { switchRuntimeEndpoint } from './runtime-switch';

type TestWindow = {
  __OPENCHAMBER_HOME__?: string;
  addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => void;
  removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) => void;
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
  if (!testWindow.addEventListener || !testWindow.removeEventListener) {
    const eventTarget = new EventTarget();
    testWindow.addEventListener = eventTarget.addEventListener.bind(eventTarget);
    testWindow.removeEventListener = eventTarget.removeEventListener.bind(eventTarget);
    testWindow.dispatchEvent = eventTarget.dispatchEvent.bind(eventTarget);
  }
  testWindow.dispatchEvent ??= () => true;
  testWindow.setTimeout ??= setTimeout;
  testWindow.clearTimeout ??= clearTimeout;
  ensureLocalStorage();
  return testWindow as TestWindow;
};

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

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
    invalidateSettingsCache();
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

  test('publishes saving and saved states for an immediate setting update', async () => {
    const states: string[] = [];
    registerSettingsSave(async (changes) => changes as SettingsPayload);
    const unsubscribe = subscribeToSettingsSaveState(() => {
      states.push(getSettingsSaveState());
    });

    try {
      await updateDesktopSettings({ useSystemTheme: false, themeVariant: 'light' });
      // Success is silent: the shared state machine maps 'saved' back to 'idle'.
      expect(states).toEqual(['saving', 'idle']);
    } finally {
      unsubscribe();
    }
  });

  test('drains a pending save to the previous runtime and ignores its stale response', async () => {
    switchRuntimeEndpoint({ apiBaseUrl: 'https://settings-a.example', runtimeKey: 'settings-a' });
    const saveResult = deferred<SettingsPayload>();
    const saveCalls: Array<Partial<SettingsPayload>> = [];
    registerSettingsSave((changes) => {
      saveCalls.push(changes);
      return saveResult.promise;
    });
    const update = updateDesktopSettings({ terminalShell: 'zsh' });

    switchRuntimeEndpoint({ apiBaseUrl: 'https://settings-b.example', runtimeKey: 'settings-b' });
    registerSettingsSave(async (changes) => changes as SettingsPayload);
    useUIStore.getState().setTerminalShell('fish');

    expect(saveCalls).toEqual([{ terminalShell: 'zsh' }]);
    saveResult.resolve({ terminalShell: 'zsh' });
    await update;

    expect(useUIStore.getState().terminalShell).toBe('fish');
  });

  test('does not retry a failed old-runtime save against the new runtime', async () => {
    const previousFetch = globalThis.fetch;
    const fallbackRequests: string[] = [];
    const saveResult = deferred<SettingsPayload>();
    try {
      globalThis.fetch = (async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (init?.method === 'PUT' && url.includes('/api/config/settings')) fallbackRequests.push(url);
        return new Response(null, { status: 404 });
      }) as typeof fetch;
      switchRuntimeEndpoint({ apiBaseUrl: 'https://failed-save-a.example', runtimeKey: 'failed-save-a' });
      registerSettingsSave(() => saveResult.promise);
      const update = updateDesktopSettings({ terminalShell: 'zsh' });

      switchRuntimeEndpoint({ apiBaseUrl: 'https://failed-save-b.example', runtimeKey: 'failed-save-b' });
      registerSettingsSave(async (changes) => changes as SettingsPayload);
      saveResult.reject(new Error('runtime A disconnected'));
      await update;

      expect(fallbackRequests).toEqual([]);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  test('rejects stale loads by generation across an A to B to A switch', async () => {
    const originalLoad = deferred<{ settings: SettingsPayload; source: 'web' | 'vscode' }>();
    switchRuntimeEndpoint({ apiBaseUrl: 'https://load-a.example', runtimeKey: 'load-a' });
    registerSettingsApi(async () => ({}), () => originalLoad.promise);
    const firstSync = syncDesktopSettings();

    switchRuntimeEndpoint({ apiBaseUrl: 'https://load-b.example', runtimeKey: 'load-b' });
    registerSettingsApi(async () => ({}), async () => ({
      settings: { terminalShell: 'fish', draftStartersCraftGoalAdded: true },
      source: 'web',
    }));
    await syncDesktopSettings();
    expect(useUIStore.getState().terminalShell).toBe('fish');

    switchRuntimeEndpoint({ apiBaseUrl: 'https://load-a.example', runtimeKey: 'load-a' });
    registerSettingsApi(async () => ({}), async () => ({
      settings: { terminalShell: 'bash', draftStartersCraftGoalAdded: true },
      source: 'web',
    }));
    await syncDesktopSettings();
    expect(useUIStore.getState().terminalShell).toBe('bash');

    originalLoad.resolve({
      settings: { terminalShell: 'zsh', draftStartersCraftGoalAdded: true },
      source: 'web',
    });
    await firstSync;
    expect(useUIStore.getState().terminalShell).toBe('bash');
  });

  test('isolates local settings mirrors and removes values omitted by the next runtime', async () => {
    getWindow();
    localStorage.clear();
    switchRuntimeEndpoint({ apiBaseUrl: 'https://mirror-a.example', runtimeKey: 'mirror-a' });
    registerSettingsApi(async () => ({}), async () => ({
      settings: {
        themeId: 'theme-a',
        directoryShowHidden: true,
        sttModel: 'model-a',
        draftStartersCraftGoalAdded: true,
      },
      source: 'web',
    }));
    await syncDesktopSettings();

    switchRuntimeEndpoint({ apiBaseUrl: 'https://mirror-b.example', runtimeKey: 'mirror-b' });
    registerSettingsApi(async () => ({}), async () => ({
      settings: { draftStartersCraftGoalAdded: true },
      source: 'web',
    }));
    await syncDesktopSettings();

    expect(localStorage.getItem('selectedThemeId')).toBeNull();
    expect(localStorage.getItem('directoryTreeShowHidden')).toBeNull();
    expect(localStorage.getItem('sttModel')).toBeNull();
    expect(JSON.parse(localStorage.getItem(getRuntimeSettingsMirrorStorageKey('mirror-a')) ?? '{}')).toEqual({
      themeId: 'theme-a',
      directoryShowHidden: true,
      sttModel: 'model-a',
    });
    expect(JSON.parse(localStorage.getItem(getRuntimeSettingsMirrorStorageKey('mirror-b')) ?? '{}')).toEqual({});
  });

  test('resets in-memory preferences omitted by an authoritative runtime snapshot', async () => {
    getWindow();
    switchRuntimeEndpoint({ apiBaseUrl: 'https://preferences-a.example', runtimeKey: 'preferences-a' });
    registerSettingsApi(async () => ({}), async () => ({
      settings: {
        showReasoningTraces: false,
        terminalShell: 'fish',
        favoriteModels: [{ providerID: 'anthropic', modelID: 'claude-sonnet-4' }],
        followUpBehavior: 'steer',
        draftStarters: [{ type: 'command', name: 'runtime-a' }],
        draftStartersCraftGoalAdded: true,
      },
      source: 'web',
    }));
    await syncDesktopSettings();

    expect(useUIStore.getState().showReasoningTraces).toBe(false);
    expect(useUIStore.getState().terminalShell).toBe('fish');
    expect(useUIStore.getState().favoriteModels).toHaveLength(1);
    expect(useUIStore.getState().globalDraftStarters).toEqual([{ type: 'command', name: 'runtime-a' }]);
    expect(useMessageQueueStore.getState().followUpBehavior).toBe('steer');

    switchRuntimeEndpoint({ apiBaseUrl: 'https://preferences-b.example', runtimeKey: 'preferences-b' });
    registerSettingsApi(async () => ({}), async () => ({
      settings: { draftStartersCraftGoalAdded: true },
      source: 'web',
    }));
    await syncDesktopSettings();

    expect(useUIStore.getState().showReasoningTraces).toBe(true);
    expect(useUIStore.getState().terminalShell).toBe('auto');
    expect(useUIStore.getState().favoriteModels).toEqual([]);
    expect(useUIStore.getState().globalDraftStarters).toBeNull();
    expect(useMessageQueueStore.getState().followUpBehavior).toBe('queue');
  });

  test('treats settings save responses as partial patches', async () => {
    getWindow();
    localStorage.setItem('selectedThemeId', 'existing-theme');
    useUIStore.getState().setTerminalShell('fish');
    registerSettingsSave(async () => ({ showReasoningTraces: false }));

    await updateDesktopSettings({ showReasoningTraces: false });

    expect(useUIStore.getState().showReasoningTraces).toBe(false);
    expect(useUIStore.getState().terminalShell).toBe('fish');
    expect(localStorage.getItem('selectedThemeId')).toBe('existing-theme');
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

  test('applies the persisted terminal shell from server settings', async () => {
    getWindow();
    invalidateSettingsCache();
    useUIStore.getState().setTerminalShell('auto');
    useUIStore.getState().setTerminalLoginShells([]);
    registerSettingsApi(async () => ({}), async () => ({
      settings: { terminalShell: 'zsh', terminalLoginShells: ['zsh', 'fish'] },
      source: 'web',
    }));

    await syncDesktopSettings();

    expect(useUIStore.getState().terminalShell).toBe('zsh');
    expect(useUIStore.getState().terminalLoginShells).toEqual(['zsh', 'fish']);
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

  test('autosaves terminal shell changes to shared settings', async () => {
    getWindow();
    useUIStore.getState().setTerminalShell('auto');
    useUIStore.getState().setTerminalLoginShells([]);
    const saveCalls: Array<Partial<SettingsPayload>> = [];
    registerSettingsSave(async (changes) => {
      saveCalls.push(changes);
      return changes as SettingsPayload;
    });
    startAppearanceAutoSave();

    useUIStore.getState().setTerminalShell('zsh');
    useUIStore.getState().setTerminalLoginShells(['zsh']);
    await delay(500);

    expect(saveCalls.some((changes) => changes.terminalShell === 'zsh')).toBe(true);
    expect(saveCalls.some((changes) => changes.terminalLoginShells?.includes('zsh'))).toBe(true);
  });
});
