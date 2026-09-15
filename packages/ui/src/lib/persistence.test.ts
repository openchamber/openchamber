import { afterAll, beforeEach, describe, expect, test } from 'bun:test';

import type { RuntimeAPIs, SettingsPayload } from '@/lib/api/types';
import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { startModelPrefsAutoSave } from '@/lib/modelPrefsAutoSave';
import { startAppearanceAutoSave } from '@/lib/appearanceAutoSave';
import {
  DEFAULT_INPUT_HISTORY_LIMIT,
  DEFAULT_INPUT_HISTORY_SCOPE,
} from '@/lib/inputHistoryScope';
import { useInputHistoryStore } from '@/stores/useInputHistoryStore';
import { useUIStore } from '@/stores/useUIStore';
import { useMessageQueueStore } from '@/stores/messageQueueStore';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
import {
  applyPersistedHomeDirectoryToWindow,
  getRuntimeSettingsMirrorStorageKey,
  getSettingsSaveState,
  invalidateSettingsCache,
  loadDesktopSettings,
  subscribeToSettingsSaveState,
  syncDesktopSettings,
  updateDesktopSettings,
  type SettingsSyncedDetail,
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
let isolatedRuntimeCounter = 0;

// Each test gets its own runtime identity so an in-flight load or save left
// behind by the previous test is rejected as stale instead of leaking its
// response into this test's stores or server-known values.
const isolateRuntime = (): void => {
  isolatedRuntimeCounter += 1;
  switchRuntimeEndpoint({
    apiBaseUrl: `https://isolated-${isolatedRuntimeCounter}.example`,
    runtimeKey: `isolated-${isolatedRuntimeCounter}`,
  });
};
const originalInputHistoryApplyScope = useInputHistoryStore.getState().applyScope;
const originalInputHistoryApplyEntryLimit = useInputHistoryStore.getState().applyEntryLimit;

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
    isolateRuntime();
    registerRuntimeAPIs(null);
    invalidateSettingsCache();
    resetModelPrefsState();
    useInputHistoryStore.setState({
      entryLimit: DEFAULT_INPUT_HISTORY_LIMIT,
      scope: DEFAULT_INPUT_HISTORY_SCOPE,
      globalBuckets: {},
      sessionBuckets: {},
      applyEntryLimit: originalInputHistoryApplyEntryLimit,
      applyScope: originalInputHistoryApplyScope,
    });
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

  test('sanitizes a successful fallback settings response before applying it', async () => {
    const previousFetch = globalThis.fetch;
    const fallbackFetch: typeof fetch = async () => new Response(JSON.stringify({ terminalShell: 'zsh' }), {
      headers: { 'Content-Type': 'application/json' },
    });
    try {
      globalThis.fetch = fallbackFetch;
      useUIStore.getState().setTerminalShell('fish');

      await updateDesktopSettings({ terminalShell: 'zsh' });

      expect(useUIStore.getState().terminalShell).toBe('zsh');
      expect(getSettingsSaveState()).toBe('idle');
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  test('applies enterToSendConfigured when it arrives without enterToSend', async () => {
    useUIStore.setState({ enterToSend: false, enterToSendConfigured: false });
    registerSettingsSave(async () => ({ enterToSendConfigured: true }));

    await updateDesktopSettings({ enterToSendConfigured: true });

    expect(useUIStore.getState().enterToSend).toBe(false);
    expect(useUIStore.getState().enterToSendConfigured).toBe(true);
  });

  test('reports an error without applying a malformed fallback settings response', async () => {
    const previousFetch = globalThis.fetch;
    const fallbackFetch: typeof fetch = async () => new Response(JSON.stringify('ok'), {
      headers: { 'Content-Type': 'application/json' },
    });
    const states: string[] = [];
    const unsubscribe = subscribeToSettingsSaveState(() => {
      states.push(getSettingsSaveState());
    });
    try {
      globalThis.fetch = fallbackFetch;
      useUIStore.getState().setTerminalShell('fish');

      await updateDesktopSettings({ terminalShell: 'zsh' });

      expect(useUIStore.getState().terminalShell).toBe('fish');
      expect(states).toEqual(['saving', 'error']);
    } finally {
      unsubscribe();
      globalThis.fetch = previousFetch;
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
      settings: { terminalShell: 'fish', draftStartersCraftGoalAdded: true, draftStartersScheduleTaskAdded: true },
      source: 'web',
    }));
    await syncDesktopSettings();
    expect(useUIStore.getState().terminalShell).toBe('fish');

    switchRuntimeEndpoint({ apiBaseUrl: 'https://load-a.example', runtimeKey: 'load-a' });
    registerSettingsApi(async () => ({}), async () => ({
      settings: { terminalShell: 'bash', draftStartersCraftGoalAdded: true, draftStartersScheduleTaskAdded: true },
      source: 'web',
    }));
    await syncDesktopSettings();
    expect(useUIStore.getState().terminalShell).toBe('bash');

    originalLoad.resolve({
      settings: { terminalShell: 'zsh', draftStartersCraftGoalAdded: true, draftStartersScheduleTaskAdded: true },
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
        draftStartersCraftGoalAdded: true, draftStartersScheduleTaskAdded: true,
      },
      source: 'web',
    }));
    await syncDesktopSettings();

    switchRuntimeEndpoint({ apiBaseUrl: 'https://mirror-b.example', runtimeKey: 'mirror-b' });
    registerSettingsApi(async () => ({}), async () => ({
      settings: { draftStartersCraftGoalAdded: true, draftStartersScheduleTaskAdded: true },
      source: 'web',
    }));
    await syncDesktopSettings();

    expect(localStorage.getItem('selectedThemeId')).toBeNull();
    expect(localStorage.getItem('directoryTreeShowHidden')).toBeNull();
    expect(localStorage.getItem('sttModel')).toBeNull();
    // The mirror carries every user-owned field the server returned, so the
    // draft-starter markers ride along with the three values under test.
    expect(JSON.parse(localStorage.getItem(getRuntimeSettingsMirrorStorageKey('mirror-a')) ?? '{}')).toEqual({
      themeId: 'theme-a',
      directoryShowHidden: true,
      sttModel: 'model-a',
      draftStartersCraftGoalAdded: true,
      draftStartersScheduleTaskAdded: true,
    });
    expect(JSON.parse(localStorage.getItem(getRuntimeSettingsMirrorStorageKey('mirror-b')) ?? '{}')).toEqual({
      draftStartersCraftGoalAdded: true,
      draftStartersScheduleTaskAdded: true,
    });
  });

  test('keeps in-memory preferences that an authoritative runtime snapshot omits', async () => {
    getWindow();
    switchRuntimeEndpoint({ apiBaseUrl: 'https://preferences-a.example', runtimeKey: 'preferences-a' });
    registerSettingsApi(async () => ({}), async () => ({
      settings: {
        showReasoningTraces: false,
        terminalShell: 'fish',
        favoriteModels: [{ providerID: 'anthropic', modelID: 'claude-sonnet-4' }],
        toolJsonViewMode: 'raw',
        followUpBehavior: 'steer',
        draftStarters: [{ type: 'command', name: 'runtime-a' }],
        draftStartersVisible: false,
        draftStartersCraftGoalAdded: true, draftStartersScheduleTaskAdded: true,
      },
      source: 'web',
    }));
    await syncDesktopSettings();

    expect(useUIStore.getState().showReasoningTraces).toBe(false);
    expect(useUIStore.getState().terminalShell).toBe('fish');
    expect(useUIStore.getState().favoriteModels).toHaveLength(1);
    expect(useUIStore.getState().toolJsonViewMode).toBe('raw');
    expect(useUIStore.getState().globalDraftStarters).toEqual([{ type: 'command', name: 'runtime-a' }]);
    expect(useUIStore.getState().draftStartersVisible).toBe(false);
    expect(useMessageQueueStore.getState().followUpBehavior).toBe('steer');

    switchRuntimeEndpoint({ apiBaseUrl: 'https://preferences-b.example', runtimeKey: 'preferences-b' });
    registerSettingsApi(async () => ({}), async () => ({
      settings: { draftStartersCraftGoalAdded: true, draftStartersScheduleTaskAdded: true },
      source: 'web',
    }));
    await syncDesktopSettings();

    // An omitted key is "unset", not "reset to default": the window keeps what
    // it holds and nothing is written back.
    expect(useUIStore.getState().showReasoningTraces).toBe(false);
    expect(useUIStore.getState().terminalShell).toBe('fish');
    expect(useUIStore.getState().favoriteModels).toHaveLength(1);
    expect(useUIStore.getState().toolJsonViewMode).toBe('raw');
    expect(useUIStore.getState().globalDraftStarters).toEqual([{ type: 'command', name: 'runtime-a' }]);
    expect(useUIStore.getState().draftStartersVisible).toBe(false);
    expect(useMessageQueueStore.getState().followUpBehavior).toBe('steer');
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

  test('ignores an invalid JSON view mode in a settings save response', async () => {
    getWindow();
    useUIStore.getState().setToolJsonViewMode('formatted');
    const invalidSettings: SettingsPayload = {};
    Object.defineProperty(invalidSettings, 'toolJsonViewMode', { value: 'invalid', enumerable: true });
    registerSettingsSave(async () => invalidSettings);

    await updateDesktopSettings({ showReasoningTraces: false });

    expect(useUIStore.getState().toolJsonViewMode).toBe('formatted');
  });

  test('applies authoritative shared sidebar preferences without replacing local-only sidebar state', async () => {
    getWindow();
    useSessionDisplayStore.setState({
      projectDisplayMode: 'all',
      sessionGroupingMode: 'by-worktree',
      projectSortOrder: 'manual',
      showRecentSection: true,
      singleProjectId: 'local-project',
      stickyZoneHeaders: false,
    });
    registerSettingsApi(async () => ({}), async () => ({
      settings: {
        sidebarProjectDisplayMode: 'single',
        sidebarSessionGroupingMode: 'flat',
        sidebarProjectSortOrder: 'recent',
        sidebarShowRecentSection: false,
        autoSaveEnabled: true,
        draftStartersCraftGoalAdded: true,
        draftStartersScheduleTaskAdded: true,
      },
      source: 'web',
    }));

    await syncDesktopSettings();

    const state = useSessionDisplayStore.getState();
    expect({
      projectDisplayMode: state.projectDisplayMode,
      sessionGroupingMode: state.sessionGroupingMode,
      projectSortOrder: state.projectSortOrder,
      showRecentSection: state.showRecentSection,
      singleProjectId: state.singleProjectId,
      stickyZoneHeaders: state.stickyZoneHeaders,
    }).toEqual({
      projectDisplayMode: 'single',
      sessionGroupingMode: 'flat',
      projectSortOrder: 'recent',
      showRecentSection: false,
      singleProjectId: 'local-project',
      stickyZoneHeaders: false,
    });
  });

  test('keeps hydrated sidebar preferences the server omits and writes nothing back', async () => {
    getWindow();
    const saves: Array<Partial<SettingsPayload>> = [];
    useSessionDisplayStore.setState({
      projectDisplayMode: 'single',
      sessionGroupingMode: 'flat',
      projectSortOrder: 'a-z',
      showRecentSection: false,
    });
    registerSettingsApi(async (changes) => {
      saves.push(changes);
      return changes;
    }, async () => ({
      settings: {
        autoSaveEnabled: true,
        draftStartersCraftGoalAdded: true,
        draftStartersScheduleTaskAdded: true,
      },
      source: 'web',
    }));

    await syncDesktopSettings();
    await delay(300);

    expect(saves).toEqual([]);
    const state = useSessionDisplayStore.getState();
    expect({
      projectDisplayMode: state.projectDisplayMode,
      sessionGroupingMode: state.sessionGroupingMode,
      projectSortOrder: state.projectSortOrder,
      showRecentSection: state.showRecentSection,
    }).toEqual({
      projectDisplayMode: 'single',
      sessionGroupingMode: 'flat',
      projectSortOrder: 'a-z',
      showRecentSection: false,
    });
  });

  test('preserves local sidebar preferences when the authoritative load fails', async () => {
    getWindow();
    useSessionDisplayStore.setState({
      projectDisplayMode: 'single',
      sessionGroupingMode: 'flat',
      projectSortOrder: 'z-a',
      showRecentSection: false,
    });
    registerSettingsApi(async () => ({}), async () => {
      throw new Error('offline');
    });

    await syncDesktopSettings();

    const state = useSessionDisplayStore.getState();
    expect({
      projectDisplayMode: state.projectDisplayMode,
      sessionGroupingMode: state.sessionGroupingMode,
      projectSortOrder: state.projectSortOrder,
      showRecentSection: state.showRecentSection,
    }).toEqual({
      projectDisplayMode: 'single',
      sessionGroupingMode: 'flat',
      projectSortOrder: 'z-a',
      showRecentSection: false,
    });
  });

  test('applies validated input history scope from shared settings save responses', async () => {
    getWindow();
    registerSettingsSave(async () => ({ inputHistoryScope: 'session' }));

    await updateDesktopSettings({ inputHistoryScope: 'session' });

    expect(useInputHistoryStore.getState().scope).toBe('session');
  });

  test('applies validated input history limit from shared settings save responses', async () => {
    getWindow();
    registerSettingsSave(async () => ({ inputHistoryLimit: 100 }));

    await updateDesktopSettings({ inputHistoryLimit: 100 });

    expect(useInputHistoryStore.getState().entryLimit).toBe(100);
  });

  test('does not broadcast a stale project selection over a newer pending update', async () => {
    const firstSave = deferred<SettingsPayload>();
    const savedChanges: Array<Partial<SettingsPayload>> = [];
    registerSettingsSave(async (changes) => {
      savedChanges.push(changes);
      if (savedChanges.length === 1) return firstSave.promise;
      return changes as SettingsPayload;
    });
    const syncedSettings: SettingsPayload[] = [];
    const handleSettingsSynced = (event: Event) => {
      syncedSettings.push((event as CustomEvent<{ settings: SettingsPayload }>).detail.settings);
    };
    getWindow().addEventListener('openchamber:settings-synced', handleSettingsSynced);

    try {
      const firstUpdate = updateDesktopSettings({ activeProjectId: 'project-a' });
      await delay(250);
      const secondUpdate = updateDesktopSettings({ activeProjectId: 'project-b' });

      firstSave.resolve({ activeProjectId: 'project-a' });
      await firstUpdate;

      expect(syncedSettings.at(-1)?.activeProjectId).toBe('project-b');

      await secondUpdate;
    } finally {
      getWindow().removeEventListener('openchamber:settings-synced', handleSettingsSynced);
    }
  });

  test('does not broadcast a stale loaded project selection over a newer pending update', async () => {
    const loadedSettings = deferred<{ settings: SettingsPayload; source: 'web' | 'vscode' }>();
    registerSettingsApi(async (changes) => changes as SettingsPayload, () => loadedSettings.promise);
    invalidateSettingsCache();
    const syncedSettings: SettingsPayload[] = [];
    const handleSettingsSynced = (event: Event) => {
      syncedSettings.push((event as CustomEvent<{ settings: SettingsPayload }>).detail.settings);
    };
    getWindow().addEventListener('openchamber:settings-synced', handleSettingsSynced);

    try {
      const sync = syncDesktopSettings();
      const update = updateDesktopSettings({ activeProjectId: 'project-b' });

      loadedSettings.resolve({
        settings: {
          activeProjectId: 'project-a',
          draftStartersCraftGoalAdded: true,
          draftStartersScheduleTaskAdded: true,
        },
        source: 'web',
      });
      await sync;

      expect(syncedSettings.at(-1)?.activeProjectId).toBe('project-b');

      await update;
    } finally {
      getWindow().removeEventListener('openchamber:settings-synced', handleSettingsSynced);
    }
  });

  test('does not broadcast a stale load after a newer project update has saved', async () => {
    const loadedSettings = deferred<{ settings: SettingsPayload; source: 'web' | 'vscode' }>();
    registerSettingsApi(async (changes) => changes as SettingsPayload, () => loadedSettings.promise);
    invalidateSettingsCache();
    const syncedSettings: SettingsPayload[] = [];
    const handleSettingsSynced = (event: Event) => {
      syncedSettings.push((event as CustomEvent<{ settings: SettingsPayload }>).detail.settings);
    };
    getWindow().addEventListener('openchamber:settings-synced', handleSettingsSynced);

    try {
      const sync = syncDesktopSettings();
      const update = updateDesktopSettings({ activeProjectId: 'project-b' });
      await update;

      loadedSettings.resolve({
        settings: {
          activeProjectId: 'project-a',
          draftStartersCraftGoalAdded: true,
          draftStartersScheduleTaskAdded: true,
        },
        source: 'web',
      });
      await sync;

      expect(syncedSettings.at(-1)?.activeProjectId).toBe('project-b');
    } finally {
      getWindow().removeEventListener('openchamber:settings-synced', handleSettingsSynced);
    }
  });

  test('preserves only the latest settings values across repeated pending updates', async () => {
    const loadedSettings = deferred<{ settings: SettingsPayload; source: 'web' | 'vscode' }>();
    registerSettingsApi(async (changes) => changes as SettingsPayload, () => loadedSettings.promise);
    invalidateSettingsCache();
    const syncedSettings: SettingsPayload[] = [];
    const handleSettingsSynced = (event: Event) => {
      syncedSettings.push((event as CustomEvent<{ settings: SettingsPayload }>).detail.settings);
    };
    getWindow().addEventListener('openchamber:settings-synced', handleSettingsSynced);

    try {
      const sync = syncDesktopSettings();
      const updates = Array.from({ length: 100 }, (_, index) => updateDesktopSettings({
        activeProjectId: `project-${index}`,
        showReasoningTraces: index % 2 === 0,
      }));

      loadedSettings.resolve({
        settings: {
          activeProjectId: 'stale-project',
          showReasoningTraces: true,
          draftStartersCraftGoalAdded: true,
          draftStartersScheduleTaskAdded: true,
        },
        source: 'web',
      });
      await sync;

      expect(syncedSettings.at(-1)?.activeProjectId).toBe('project-99');
      expect(syncedSettings.at(-1)?.showReasoningTraces).toBe(false);

      await Promise.all(updates);
    } finally {
      getWindow().removeEventListener('openchamber:settings-synced', handleSettingsSynced);
    }
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
      draftStartersCraftGoalAdded: true, draftStartersScheduleTaskAdded: true,
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

  test('leaves the local git review layout alone when the server omits the key', async () => {
    getWindow();
    invalidateSettingsCache();
    useUIStore.getState().setGitReviewLayout('combined');
    registerSettingsApi(async () => ({}), async () => ({
      settings: { draftStartersCraftGoalAdded: true, draftStartersScheduleTaskAdded: true },
      source: 'web',
    }));

    await syncDesktopSettings();

    // A server document without the key means "not set", not "reset": the
    // registry leaves the local store untouched instead of inventing a default.
    expect(useUIStore.getState().gitReviewLayout).toBe('combined');
  });

  test('hydrates the persisted git review layout from server settings', async () => {
    getWindow();
    invalidateSettingsCache();
    useUIStore.getState().setGitReviewLayout('separate');
    registerSettingsApi(async () => ({}), async () => ({
      settings: {
        gitReviewLayout: 'combined',
        draftStartersCraftGoalAdded: true,
        draftStartersScheduleTaskAdded: true,
      },
      source: 'web',
    }));

    await syncDesktopSettings();

    expect(useUIStore.getState().gitReviewLayout).toBe('combined');
  });

  test('drops an invalid git review layout from server settings at the parse boundary', async () => {
    getWindow();
    invalidateSettingsCache();
    useUIStore.getState().setGitReviewLayout('combined');
    const settings: SettingsPayload = {
      draftStartersCraftGoalAdded: true,
      draftStartersScheduleTaskAdded: true,
    };
    Object.defineProperty(settings, 'gitReviewLayout', {
      value: 'invalid',
      enumerable: true,
      configurable: true,
      writable: true,
    });
    registerSettingsApi(async () => ({}), async () => ({
      settings,
      source: 'web',
    }));

    await syncDesktopSettings();

    // The registry parser rejects the value, so the document is treated as if
    // the key were absent and the local choice survives.
    expect(useUIStore.getState().gitReviewLayout).toBe('combined');
  });

  test('treats git review layout save responses as partial patches', async () => {
    getWindow();
    useUIStore.getState().setTerminalShell('fish');
    useUIStore.getState().setGitReviewLayout('separate');
    registerSettingsSave(async () => ({ gitReviewLayout: 'combined' }));

    await updateDesktopSettings({ gitReviewLayout: 'combined' });

    expect(useUIStore.getState().gitReviewLayout).toBe('combined');
    expect(useUIStore.getState().terminalShell).toBe('fish');
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

  test('autosaves the first model preference change', async () => {
    getWindow();
    const saveCalls: Array<Partial<SettingsPayload>> = [];
    registerSettingsSave(async (changes) => {
      saveCalls.push(changes);
      return changes as SettingsPayload;
    });
    const stop = startModelPrefsAutoSave();

    try {
      useUIStore.setState({ favoriteModels: [{ providerID: 'anthropic', modelID: 'claude-haiku-4' }] });
      await delay(300);

      expect(saveCalls).toEqual([{
        favoriteModels: [{ providerID: 'anthropic', modelID: 'claude-haiku-4' }],
        hiddenModels: [],
        collapsedModelProviders: [],
        recentModels: [],
        recentAgents: [],
        recentEfforts: {},
      }]);
    } finally {
      stop();
    }
  });

  test('autosaves appearance preferences to shared settings', async () => {
    getWindow();
    useUIStore.getState().setTerminalShell('auto');
    useUIStore.getState().setTerminalLoginShells([]);
    useUIStore.getState().setToolJsonViewMode('summary');
    const saveCalls: Array<Partial<SettingsPayload>> = [];
    registerSettingsSave(async (changes) => {
      saveCalls.push(changes);
      return changes as SettingsPayload;
    });
    startAppearanceAutoSave();

    useUIStore.getState().setTerminalShell('zsh');
    useUIStore.getState().setTerminalLoginShells(['zsh']);
    useUIStore.getState().setToolJsonViewMode('formatted');
    await delay(500);

    expect(saveCalls.some((changes) => changes.terminalShell === 'zsh')).toBe(true);
    expect(saveCalls.some((changes) => changes.terminalLoginShells?.includes('zsh'))).toBe(true);
    expect(saveCalls.some((changes) => changes.toolJsonViewMode === 'formatted')).toBe(true);
  });

  test('legacy server lists show telemetry, while explicit hiding survives hydration', async () => {
    getWindow();
    for (const explicit of [undefined, false, true]) {
      invalidateSettingsCache();
      registerSettingsApi(async (changes) => changes, async () => ({
        settings: { workStatusHiddenSections: ['mcp', 'telemetry'], workStatusHiddenSectionsExplicit: explicit,
          draftStartersCraftGoalAdded: true, draftStartersScheduleTaskAdded: true },
        source: 'web',
      }));
      await syncDesktopSettings();
      expect(useUIStore.getState().workStatusHiddenSections).toEqual(explicit ? ['mcp', 'telemetry'] : ['mcp']);
      expect(useUIStore.getState().workStatusHiddenSectionsExplicit).toBe(explicit === true);
    }
  });

  test('autosaves telemetry hiding and its list together, then restores them through settings load', async () => {
    getWindow();
    invalidateSettingsCache();
    let server: SettingsPayload = { workStatusHiddenSections: [], draftStartersCraftGoalAdded: true, draftStartersScheduleTaskAdded: true };
    const saves: Partial<SettingsPayload>[] = [];
    registerSettingsApi(async (changes) => { saves.push(changes); server = { ...server, ...changes }; return changes; },
      async () => ({ settings: server, source: 'web' }));
    await syncDesktopSettings();
    expect(useUIStore.getState().workStatusHiddenSections).toEqual([]);
    startAppearanceAutoSave();
    useUIStore.getState().setWorkStatusSectionVisible('telemetry', false);
    await delay(600);
    expect(saves.some((changes) => changes.workStatusHiddenSectionsExplicit === true)).toBe(true);
    expect(server.workStatusHiddenSections).toEqual(['telemetry']);
    expect(server.workStatusHiddenSectionsExplicit).toBe(true);
    invalidateSettingsCache();
    await syncDesktopSettings();
    expect(useUIStore.getState().workStatusHiddenSections).toEqual(['telemetry']);
    expect(useUIStore.getState().workStatusHiddenSectionsExplicit).toBe(true);
    // An unrelated partial save response must not re-enable a hidden section.
    await updateDesktopSettings({ workStatusPanelEnabled: useUIStore.getState().workStatusPanelEnabled });
    expect(useUIStore.getState().workStatusHiddenSections).toEqual(['telemetry']);
  });

  test('autosaves git review layout changes to shared settings', async () => {
    getWindow();
    useUIStore.getState().setGitReviewLayout('separate');
    const saveCalls: Array<Partial<SettingsPayload>> = [];
    registerSettingsSave(async (changes) => {
      saveCalls.push(changes);
      return changes as SettingsPayload;
    });
    startAppearanceAutoSave();

    useUIStore.getState().setGitReviewLayout('combined');
    await delay(500);

    expect(saveCalls.some((changes) => changes.gitReviewLayout === 'combined')).toBe(true);
  });

  test('applies persisted autoSaveEnabled from server settings', async () => {
    getWindow();
    invalidateSettingsCache();
    useUIStore.getState().setAutoSaveEnabled(true);
    registerSettingsApi(async () => ({}), async () => ({
      settings: { autoSaveEnabled: false, draftStartersCraftGoalAdded: true, draftStartersScheduleTaskAdded: true },
      source: 'web',
    }));

    await syncDesktopSettings();

    expect(useUIStore.getState().autoSaveEnabled).toBe(false);
  });

  test('applies persisted input history scope from server settings', async () => {
    getWindow();
    invalidateSettingsCache();
    registerSettingsApi(async () => ({}), async () => ({
      settings: {
        inputHistoryScope: 'session',
        autoSaveEnabled: true,
        draftStartersCraftGoalAdded: true,
        draftStartersScheduleTaskAdded: true,
      },
      source: 'web',
    }));

    await syncDesktopSettings();

    expect(useInputHistoryStore.getState().scope).toBe('session');
  });

  test('applies persisted input history limit from server settings', async () => {
    getWindow();
    invalidateSettingsCache();
    registerSettingsApi(async () => ({}), async () => ({
      settings: {
        inputHistoryLimit: 100,
        autoSaveEnabled: true,
        draftStartersCraftGoalAdded: true,
        draftStartersScheduleTaskAdded: true,
      },
      source: 'web',
    }));

    await syncDesktopSettings();

    expect(useInputHistoryStore.getState().entryLimit).toBe(100);
  });

  test('keeps the hydrated input history scope when the server omits it and writes nothing', async () => {
    getWindow();
    invalidateSettingsCache();
    useInputHistoryStore.getState().applyScope('session');
    const saveCalls: Array<Partial<SettingsPayload>> = [];
    registerSettingsApi(async (changes) => {
      saveCalls.push(changes);
      return changes as SettingsPayload;
    }, async () => ({
      settings: {
        autoSaveEnabled: true,
        draftStartersCraftGoalAdded: true,
        draftStartersScheduleTaskAdded: true,
      },
      source: 'web',
    }));

    await syncDesktopSettings();

    expect(useInputHistoryStore.getState().scope).toBe('session');
    expect(saveCalls.some((changes) => changes.inputHistoryScope !== undefined)).toBe(false);
  });

  test('keeps the hydrated input history limit when the server omits it and writes nothing', async () => {
    getWindow();
    invalidateSettingsCache();
    useInputHistoryStore.getState().applyEntryLimit(100);
    const saveCalls: Array<Partial<SettingsPayload>> = [];
    registerSettingsApi(async (changes) => {
      saveCalls.push(changes);
      return changes as SettingsPayload;
    }, async () => ({
      settings: {
        autoSaveEnabled: true,
        draftStartersCraftGoalAdded: true,
        draftStartersScheduleTaskAdded: true,
      },
      source: 'web',
    }));

    await syncDesktopSettings();

    expect(useInputHistoryStore.getState().entryLimit).toBe(100);
    expect(saveCalls.some((changes) => changes.inputHistoryLimit !== undefined)).toBe(false);
  });

  test('does not reapply the hydrated input history scope when it already matches', async () => {
    getWindow();
    invalidateSettingsCache();
    useInputHistoryStore.getState().applyScope('session');
    let applyScopeCalls = 0;
    useInputHistoryStore.setState({
      applyScope: (scope) => {
        applyScopeCalls += 1;
        originalInputHistoryApplyScope(scope);
      },
    });
    registerSettingsApi(async () => ({}), async () => ({
      settings: {
        inputHistoryScope: 'session',
        autoSaveEnabled: true,
        draftStartersCraftGoalAdded: true,
        draftStartersScheduleTaskAdded: true,
      },
      source: 'web',
    }));

    try {
      await syncDesktopSettings();
    } finally {
      useInputHistoryStore.setState({ applyScope: originalInputHistoryApplyScope });
    }

    expect(applyScopeCalls).toBe(0);
    expect(useInputHistoryStore.getState().scope).toBe('session');
  });

  test('does not reapply the hydrated input history limit when it already matches', async () => {
    getWindow();
    invalidateSettingsCache();
    useInputHistoryStore.getState().applyEntryLimit(100);
    let applyEntryLimitCalls = 0;
    useInputHistoryStore.setState({
      applyEntryLimit: (limit) => {
        applyEntryLimitCalls += 1;
        originalInputHistoryApplyEntryLimit(limit);
      },
    });
    registerSettingsApi(async () => ({}), async () => ({
      settings: {
        inputHistoryLimit: 100,
        autoSaveEnabled: true,
        draftStartersCraftGoalAdded: true,
        draftStartersScheduleTaskAdded: true,
      },
      source: 'web',
    }));

    try {
      await syncDesktopSettings();
    } finally {
      useInputHistoryStore.setState({ applyEntryLimit: originalInputHistoryApplyEntryLimit });
    }

    expect(applyEntryLimitCalls).toBe(0);
    expect(useInputHistoryStore.getState().entryLimit).toBe(100);
  });

  test('autosaves autoSaveEnabled changes to shared settings', async () => {
    getWindow();
    useUIStore.getState().setAutoSaveEnabled(true);
    const saveCalls: Array<Partial<SettingsPayload>> = [];
    registerSettingsSave(async (changes) => {
      saveCalls.push(changes);
      return changes as SettingsPayload;
    });
    startAppearanceAutoSave();

    useUIStore.getState().setAutoSaveEnabled(false);
    await delay(500);

    expect(saveCalls.some((changes) => changes.autoSaveEnabled === false)).toBe(true);
  });

  test('keeps the hydrated autoSaveEnabled when the server omits it and writes nothing', async () => {
    getWindow();
    invalidateSettingsCache();
    useUIStore.getState().setAutoSaveEnabled(false);
    const saveCalls: Array<Partial<SettingsPayload>> = [];
    registerSettingsApi(async (changes) => {
      saveCalls.push(changes);
      return { ...changes } as SettingsPayload;
    }, async () => ({
      settings: { draftStartersCraftGoalAdded: true, draftStartersScheduleTaskAdded: true },
      source: 'web',
    }));

    await syncDesktopSettings();
    await delay(500);

    expect(useUIStore.getState().autoSaveEnabled).toBe(false);
    expect(saveCalls).toEqual([]);
  });

  test('a bootstrap that adopts server values produces zero writes even with the auto-savers running', async () => {
    getWindow();
    invalidateSettingsCache();
    // The setup below is itself "a person changing things" as far as the
    // auto-savers can tell; let those writes drain before recording.
    const saveCalls: Array<Partial<SettingsPayload>> = [];
    let recording = false;
    registerSettingsApi(async (changes) => {
      if (recording) saveCalls.push(changes);
      return { ...changes } as SettingsPayload;
    }, async () => ({
      settings: {
        showReasoningTraces: false,
        terminalShell: 'fish',
        favoriteModels: [{ providerID: 'anthropic', modelID: 'claude-sonnet-4' }],
        // A legacy list the client normalises on read: the normalised copy is
        // still not this window's change and must not be written back.
        workStatusHiddenSections: ['mcp', 'telemetry'],
        draftStartersCraftGoalAdded: true,
        draftStartersScheduleTaskAdded: true,
      },
      source: 'web',
    }));
    startAppearanceAutoSave();
    const stopModelPrefs = startModelPrefsAutoSave();
    useUIStore.getState().setShowReasoningTraces(true);
    useUIStore.getState().setTerminalShell('auto');
    resetModelPrefsState();
    await delay(1500);
    recording = true;

    try {
      await syncDesktopSettings();
      await delay(1500);

      expect(useUIStore.getState().showReasoningTraces).toBe(false);
      expect(useUIStore.getState().terminalShell).toBe('fish');
      expect(useUIStore.getState().favoriteModels).toHaveLength(1);
      expect(useUIStore.getState().workStatusHiddenSections).toEqual(['mcp']);
      expect(saveCalls).toEqual([]);
    } finally {
      stopModelPrefs();
    }
  });

  test('drops a write whose value the server already holds', async () => {
    getWindow();
    invalidateSettingsCache();
    const saveCalls: Array<Partial<SettingsPayload>> = [];
    registerSettingsApi(async (changes) => {
      saveCalls.push(changes);
      return { ...changes } as SettingsPayload;
    }, async () => ({
      settings: { fontSize: 15, draftStartersCraftGoalAdded: true, draftStartersScheduleTaskAdded: true },
      source: 'web',
    }));
    await syncDesktopSettings();

    await updateDesktopSettings({ fontSize: 15 });
    expect(saveCalls).toEqual([]);
    expect(getSettingsSaveState()).toBe('idle');

    await updateDesktopSettings({ fontSize: 16 });
    expect(saveCalls).toEqual([{ fontSize: 16 }]);
  });

  test('reconciles warm cached reads with pending and in-flight settings writes', async () => {
    const saveResult = deferred<SettingsPayload>();
    const savedSettings = { defaultModel: 'provider/new-model' } satisfies SettingsPayload;
    const saveCalls: Array<Partial<SettingsPayload>> = [];
    registerSettingsApi(
      async (changes) => {
        saveCalls.push(changes);
        return saveResult.promise;
      },
      async () => ({
        settings: { defaultModel: 'provider/old-model' },
        source: 'web',
      }),
    );

    const initialSettings = await loadDesktopSettings();
    expect(initialSettings?.defaultModel).toBe('provider/old-model');
    const update = updateDesktopSettings({ defaultModel: 'provider/new-model' });

    const pendingSettings = await loadDesktopSettings();
    expect(pendingSettings?.defaultModel).toBe('provider/new-model');
    await delay(250);
    expect(saveCalls).toEqual([{ defaultModel: 'provider/new-model' }]);
    const inFlightSettings = await loadDesktopSettings();
    expect(inFlightSettings?.defaultModel).toBe('provider/new-model');

    saveResult.resolve(savedSettings);
    await update;
  });

  test('a delayed read retains an edit whose write finishes before the read', async () => {
    const readResult = deferred<{ settings: SettingsPayload; source: 'web' }>();
    const newDefaults = { defaultModel: 'provider/new', defaultVariant: 'high', defaultAgent: 'review' };
    const writes: Array<Partial<SettingsPayload>> = [];
    registerSettingsApi(async (changes) => { writes.push(changes); return { ...changes }; }, () => readResult.promise);
    const update = updateDesktopSettings(newDefaults);
    const read = loadDesktopSettings();
    await update;
    readResult.resolve({ settings: { defaultModel: 'provider/old', defaultVariant: 'low', defaultAgent: 'build' }, source: 'web' });
    expect(await read).toMatchObject(newDefaults);
    expect(await loadDesktopSettings()).toMatchObject(newDefaults);
    await updateDesktopSettings({ defaultModel: 'provider/old' });
    expect(writes).toHaveLength(2);
  });

  test('a read started before an edit cannot undo its completed write', async () => {
    const readResult = deferred<{ settings: SettingsPayload; source: 'web' }>();
    registerSettingsApi(async (changes) => ({ ...changes }), () => readResult.promise);
    const read = loadDesktopSettings();
    await updateDesktopSettings({ defaultModel: 'provider/new' });
    readResult.resolve({ settings: { defaultModel: 'provider/old' }, source: 'web' });
    expect((await read)?.defaultModel).toBe('provider/new');
    expect((await loadDesktopSettings())?.defaultModel).toBe('provider/new');
  });

  test('toggling back to the server value inside the debounce window cancels the pending write', async () => {
    getWindow();
    invalidateSettingsCache();
    const saveCalls: Array<Partial<SettingsPayload>> = [];
    registerSettingsApi(async (changes) => {
      saveCalls.push(changes);
      return { ...changes } as SettingsPayload;
    }, async () => ({
      settings: { showDeletionDialog: true, draftStartersCraftGoalAdded: true, draftStartersScheduleTaskAdded: true },
      source: 'web',
    }));
    await syncDesktopSettings();

    void updateDesktopSettings({ showDeletionDialog: false, fontSize: 17 });
    await updateDesktopSettings({ showDeletionDialog: true });

    expect(saveCalls).toEqual([{ fontSize: 17 }]);
  });

  test('a failed save forgets its optimistic value so the retry is sent', async () => {
    getWindow();
    invalidateSettingsCache();
    let fail = true;
    const saveCalls: Array<Partial<SettingsPayload>> = [];
    registerSettingsSave(async (changes) => {
      saveCalls.push(changes);
      if (fail) throw new Error('offline');
      return { ...changes } as SettingsPayload;
    });

    await updateDesktopSettings({ fontSize: 18 });
    fail = false;
    await updateDesktopSettings({ fontSize: 18 });

    expect(saveCalls).toEqual([{ fontSize: 18 }, { fontSize: 18 }]);
  });

  test('does not invent theme defaults when the authoritative snapshot omits theme fields', async () => {
    getWindow();
    invalidateSettingsCache();
    registerSettingsApi(
      // SAFETY: this mock echoes back exactly the partial changes it received;
      // the tests below only read fields the changes actually contain.
      async (changes) => ({ ...changes } as SettingsPayload),
      async () => ({
        settings: { draftStartersCraftGoalAdded: true, draftStartersScheduleTaskAdded: true },
        source: 'web',
      }),
    );

    const synced: SettingsSyncedDetail[] = [];
    const listener = (event: Event): void => {
      // SAFETY: dispatchSettingsSynced is the only emitter for this key and
      // always sends a CustomEvent<SettingsSyncedDetail>.
      const detail = (event as CustomEvent<SettingsSyncedDetail>).detail;
      if (detail) synced.push(detail);
    };
    window.addEventListener('openchamber:settings-synced', listener);
    try {
      await syncDesktopSettings();
    } finally {
      window.removeEventListener('openchamber:settings-synced', listener);
    }

    expect(synced.length).toBeGreaterThan(0);
    const bootstrapSync = synced.find((detail) => detail.bootstrap);
    expect(bootstrapSync).toBeTruthy();
    expect(bootstrapSync?.adoptTheme).toBe(true);
    expect(bootstrapSync?.settings.useSystemTheme).toBe(undefined);
    expect(bootstrapSync?.settings.lightThemeId).toBe(undefined);
    expect(bootstrapSync?.settings.darkThemeId).toBe(undefined);
  });

  test('marks settings save echoes as non-bootstrap syncs', async () => {
    getWindow();
    invalidateSettingsCache();
    registerSettingsApi(
      // SAFETY: this mock echoes back exactly the partial changes it received;
      // the assertions below only read fields the changes actually contain.
      async (changes) => ({ ...changes } as SettingsPayload),
    );

    const synced: SettingsSyncedDetail[] = [];
    const listener = (event: Event): void => {
      // SAFETY: dispatchSettingsSynced is the only emitter for this key and
      // always sends a CustomEvent<SettingsSyncedDetail>.
      const detail = (event as CustomEvent<SettingsSyncedDetail>).detail;
      if (detail) synced.push(detail);
    };
    window.addEventListener('openchamber:settings-synced', listener);
    try {
      await updateDesktopSettings({ themeVariant: 'dark' });
    } finally {
      window.removeEventListener('openchamber:settings-synced', listener);
    }

    expect(synced.length).toBeGreaterThan(0);
    expect(synced.every((detail) => detail.bootstrap === false)).toBe(true);
    expect(synced.every((detail) => detail.adoptTheme === false)).toBe(true);
    expect(synced.every((detail) => detail.settings.themeVariant === 'dark')).toBe(true);
  });

  test('allows a bootstrap sync to preserve the current window theme', async () => {
    getWindow();
    invalidateSettingsCache();
    registerSettingsApi(
      async (changes) => ({ ...changes } as SettingsPayload),
      async () => ({
        settings: { activeProjectId: 'project-a', themeVariant: 'dark' },
        source: 'web',
      }),
    );

    const synced: SettingsSyncedDetail[] = [];
    const listener = (event: Event): void => {
      const detail = (event as CustomEvent<SettingsSyncedDetail>).detail;
      if (detail) synced.push(detail);
    };
    window.addEventListener('openchamber:settings-synced', listener);
    try {
      await syncDesktopSettings({ adoptTheme: false });
    } finally {
      window.removeEventListener('openchamber:settings-synced', listener);
    }

    const broadcastSync = synced.find((detail) => detail.bootstrap && !detail.adoptTheme);
    expect(broadcastSync).toBeTruthy();
    expect(broadcastSync?.settings.activeProjectId).toBe('project-a');
    expect(broadcastSync?.settings.themeVariant).toBe('dark');
  });
});

describe('unload lifecycle flush (#2197)', () => {
  beforeEach(() => {
    getWindow();
    isolateRuntime();
    registerRuntimeAPIs(null);
    invalidateSettingsCache();
  });

  test('flushes a pending debounced settings save on pagehide without a double write', async () => {
    const saveCalls: Array<Partial<SettingsPayload>> = [];
    registerSettingsSave(async (changes) => {
      saveCalls.push(changes);
      return {};
    });

    const update = updateDesktopSettings({ showDeletionDialog: false });
    expect(saveCalls).toEqual([]);

    getWindow().dispatchEvent(new Event('pagehide'));

    // The flush must hand the pending changes to the settings backend
    // synchronously inside the lifecycle listener — an unloading window has
    // no later turn for the debounce timer.
    expect(saveCalls).toEqual([{ showDeletionDialog: false }]);

    await update;
    await delay(300);
    // The canceled debounce timer must not replay the same write.
    expect(saveCalls).toHaveLength(1);
  });

  test('flushes a pending debounced settings save on beforeunload without a double write', async () => {
    const saveCalls: Array<Partial<SettingsPayload>> = [];
    registerSettingsSave(async (changes) => {
      saveCalls.push(changes);
      return {};
    });

    const update = updateDesktopSettings({ gitChangesViewMode: 'tree' });
    expect(saveCalls).toEqual([]);

    getWindow().dispatchEvent(new Event('beforeunload'));

    expect(saveCalls).toEqual([{ gitChangesViewMode: 'tree' }]);

    await update;
    await delay(300);
    expect(saveCalls).toHaveLength(1);
  });

  test('persists a showDeletionDialog toggle followed by an immediate unload', async () => {
    const saveCalls: Array<Partial<SettingsPayload>> = [];
    registerSettingsSave(async (changes) => {
      saveCalls.push(changes);
      return {};
    });
    startAppearanceAutoSave();

    try {
      useUIStore.getState().setShowDeletionDialog(false);
      getWindow().dispatchEvent(new Event('pagehide'));

      expect(saveCalls.some((changes) => changes.showDeletionDialog === false)).toBe(true);
    } finally {
      useUIStore.getState().setShowDeletionDialog(true);
      // Let the restore write drain so it cannot leak into other tests.
      await delay(300);
    }
  });

  test('persists a first model preference followed by an immediate unload', async () => {
    const saveCalls: Array<Partial<SettingsPayload>> = [];
    registerSettingsSave(async (changes) => {
      saveCalls.push(changes);
      return {};
    });
    const stopModelPrefs = startModelPrefsAutoSave();

    try {
      useUIStore.setState({ favoriteModels: [{ providerID: 'anthropic', modelID: 'claude-haiku-4' }] });
      getWindow().dispatchEvent(new Event('pagehide'));

      expect(saveCalls).toEqual([{
        favoriteModels: [{ providerID: 'anthropic', modelID: 'claude-haiku-4' }],
        hiddenModels: [],
        collapsedModelProviders: [],
        recentModels: [],
        recentAgents: [],
        recentEfforts: {},
      }]);
    } finally {
      stopModelPrefs();
      await delay(300);
    }
  });

  test('sends the unload flush with keepalive so the browser cannot cancel it', async () => {
    // No runtime settings API: the write has to take the HTTP branch, which is
    // the one the browser cancels on unload without `keepalive`.
    registerRuntimeAPIs(null);
    const inits: RequestInit[] = [];
    const previousFetch = globalThis.fetch;
    // SAFETY: the mock receives only the (input, init) pair production code
    // passes and always resolves to a Response; the assertion supplies the
    // overload signatures a plain arrow function cannot declare.
    globalThis.fetch = (async (_input, init) => {
      inits.push(init ?? {});
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    try {
      const update = updateDesktopSettings({ gitChangesViewMode: 'flat' });
      getWindow().dispatchEvent(new Event('pagehide'));
      await update;
      await delay(50);

      expect(inits).toHaveLength(1);
      expect(inits[0].method).toBe('PUT');
      expect(inits[0].keepalive).toBe(true);

      // The ordinary debounced write stays a plain fetch.
      inits.length = 0;
      await updateDesktopSettings({ gitChangesViewMode: 'tree' });
      await delay(300);
      expect(inits).toHaveLength(1);
      expect(inits[0].keepalive).toBe(false);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  test('ignores lifecycle events when no settings write is pending', async () => {
    const saveCalls: Array<Partial<SettingsPayload>> = [];
    registerSettingsSave(async (changes) => {
      saveCalls.push(changes);
      return {};
    });

    getWindow().dispatchEvent(new Event('pagehide'));
    getWindow().dispatchEvent(new Event('beforeunload'));
    await delay(50);

    expect(saveCalls).toEqual([]);
  });
});
