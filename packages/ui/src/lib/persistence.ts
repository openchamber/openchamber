import type { DesktopSettings } from '@/lib/desktop';
import { useUIStore } from '@/stores/useUIStore';
import { loadAppearancePreferences, applyAppearancePreferences } from '@/lib/appearancePersistence';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { setStoredMobileKeyboardMode } from '@/lib/mobileKeyboardMode';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { isCapacitorApp } from '@/lib/platform';
import { getRuntimeKey, subscribeRuntimeEndpointChanged, subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
import {
  applySettingsToStores,
  isDeviceSettingsKey,
  isWritableSettingsKey,
  MIRRORED_KEYS,
  parseSettingsDocument,
  SETTINGS_KEYS,
} from '@/lib/settings/registry';
import { SETTINGS_SURFACE_QUERY, getSettingsSurface } from '@/lib/settings/surface';

export const applyPersistedHomeDirectoryToWindow = (homeDirectory: string): void => {
  if (typeof window === 'undefined') {
    return;
  }
  if (typeof window.__OPENCHAMBER_HOME__ === 'string' && window.__OPENCHAMBER_HOME__.length > 0) {
    return;
  }

  try {
    window.__OPENCHAMBER_HOME__ = homeDirectory;
  } catch {
    /* read-only contextBridge property — leave preload-seeded value */
  }
};

const SETTINGS_MIRROR_INDEX_KEY = 'openchamber.settingsMirror.v2.index';
const DEVICE_SEED_KEY_PREFIX = 'openchamber.deviceSeeded.v1:';
const getDeviceSeedStorageKey = (runtimeKey: string): string => `${DEVICE_SEED_KEY_PREFIX}${encodeURIComponent(runtimeKey)}`;

const withoutStaleDeviceFields = (settings: DesktopSettings, runtimeKey: string): DesktopSettings => {
  const seedKey = getDeviceSeedStorageKey(runtimeKey);
  let seedDevice = false;
  try {
    seedDevice = localStorage.getItem(seedKey) === null;
    if (seedDevice) localStorage.setItem(seedKey, String(Date.now()));
  } catch {
    seedDevice = false;
  }
  if (seedDevice) return settings;
  const next: DesktopSettings = {};
  for (const key of SETTINGS_KEYS) {
    if (settings[key] === undefined || isDeviceSettingsKey(key)) continue;
    Object.assign(next, { [key]: settings[key] });
  }
  return next;
};
const SETTINGS_MIRROR_KEY_PREFIX = 'openchamber.settingsMirror.v2:';
const MAX_SETTINGS_MIRROR_RUNTIMES = 5;

export const getRuntimeSettingsMirrorStorageKey = (runtimeKey: string): string =>
  `${SETTINGS_MIRROR_KEY_PREFIX}${encodeURIComponent(runtimeKey)}`;

const setOrRemoveLocalStorage = (key: string, value: string | null): void => {
  if (value === null) {
    localStorage.removeItem(key);
  } else {
    localStorage.setItem(key, value);
  }
};

const persistRuntimeSettingsMirror = (settings: DesktopSettings, runtimeKey: string): void => {
  const mirror: DesktopSettings = {};
  for (const key of MIRRORED_KEYS) {
    if (settings[key] !== undefined) Object.assign(mirror, { [key]: settings[key] });
  }
  localStorage.setItem(getRuntimeSettingsMirrorStorageKey(runtimeKey), JSON.stringify(mirror));

  let previous: string[] = [];
  try {
    const parsed = JSON.parse(localStorage.getItem(SETTINGS_MIRROR_INDEX_KEY) ?? '[]') as unknown;
    if (Array.isArray(parsed)) previous = parsed.filter((entry): entry is string => typeof entry === 'string');
  } catch {
    previous = [];
  }
  const runtimes = [runtimeKey, ...previous.filter((entry) => entry !== runtimeKey)].slice(0, MAX_SETTINGS_MIRROR_RUNTIMES);
  for (const staleRuntime of previous) {
    if (!runtimes.includes(staleRuntime)) localStorage.removeItem(getRuntimeSettingsMirrorStorageKey(staleRuntime));
  }
  localStorage.setItem(SETTINGS_MIRROR_INDEX_KEY, JSON.stringify(runtimes));
};

const persistToLocalStorage = (settings: DesktopSettings) => {
  if (typeof window === 'undefined') {
    return;
  }

  persistRuntimeSettingsMirror(settings, getRuntimeKey());
  setOrRemoveLocalStorage('lastDirectory', settings.lastDirectory || null);
  if (settings.homeDirectory) {
    localStorage.setItem('homeDirectory', settings.homeDirectory);
    applyPersistedHomeDirectoryToWindow(settings.homeDirectory);
  } else {
    localStorage.removeItem('homeDirectory');
  }
  if (Array.isArray(settings.projects) && settings.projects.length > 0) {
    localStorage.setItem('projects', JSON.stringify(settings.projects));
  } else {
    localStorage.removeItem('projects');
  }
  if (settings.activeProjectId) {
    localStorage.setItem('activeProjectId', settings.activeProjectId);
  } else {
    localStorage.removeItem('activeProjectId');
  }
  if (Array.isArray(settings.pinnedDirectories) && settings.pinnedDirectories.length > 0) {
    localStorage.setItem('pinnedDirectories', JSON.stringify(settings.pinnedDirectories));
  } else {
    localStorage.removeItem('pinnedDirectories');
  }

  if (Array.isArray(settings.projects) && settings.projects.length > 0) {
    const collapsed = settings.projects
      .filter((project) => project.sidebarCollapsed === true)
      .map((project) => project.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    if (collapsed.length > 0) {
      localStorage.setItem('oc.sessions.projectCollapse', JSON.stringify(collapsed));
    } else {
      localStorage.removeItem('oc.sessions.projectCollapse');
    }
  } else {
    localStorage.removeItem('oc.sessions.projectCollapse');
  }
  if (typeof settings.gitmojiEnabled === 'boolean') {
    localStorage.setItem('gitmojiEnabled', String(settings.gitmojiEnabled));
  } else {
    localStorage.removeItem('gitmojiEnabled');
  }
  if (typeof settings.directoryShowHidden === 'boolean') {
    localStorage.setItem('directoryTreeShowHidden', settings.directoryShowHidden ? 'true' : 'false');
  } else {
    localStorage.removeItem('directoryTreeShowHidden');
  }
  if (typeof settings.filesViewShowGitignored === 'boolean') {
    localStorage.setItem('filesViewShowGitignored', settings.filesViewShowGitignored ? 'true' : 'false');
  } else {
    localStorage.removeItem('filesViewShowGitignored');
  }
  setOrRemoveLocalStorage('openInAppId', typeof settings.openInAppId === 'string' && settings.openInAppId.length > 0 ? settings.openInAppId : null);
  if (typeof settings.pwaAppName === 'string') {
    const normalized = settings.pwaAppName.trim().replace(/\s+/g, ' ').slice(0, 64);
    if (normalized.length > 0) {
      localStorage.setItem('openchamber.pwaName', normalized);
    } else {
      localStorage.removeItem('openchamber.pwaName');
    }
  } else {
    localStorage.removeItem('openchamber.pwaName');
  }
  setStoredMobileKeyboardMode(settings.mobileKeyboardMode);
  if (typeof settings.openCodeUpdateToastDismissedVersion === 'string') {
    const version = settings.openCodeUpdateToastDismissedVersion.trim();
    if (version) {
      localStorage.setItem('opencode-update-toast-dismissed-version', version);
    } else {
      localStorage.removeItem('opencode-update-toast-dismissed-version');
    }
  } else {
    localStorage.removeItem('opencode-update-toast-dismissed-version');
  }
  if (typeof settings.dictationEnabled === 'boolean') {
    localStorage.setItem('dictationEnabled', String(settings.dictationEnabled));
  } else {
    localStorage.removeItem('dictationEnabled');
  }
  if (settings.dictationAutoSend !== undefined) {
    localStorage.setItem('dictationAutoSend', String(settings.dictationAutoSend));
  } else {
    localStorage.removeItem('dictationAutoSend');
  }
  if (settings.sttProvider === 'local' || settings.sttProvider === 'openai-compatible') {
    localStorage.setItem('sttProvider', settings.sttProvider);
  } else {
    localStorage.removeItem('sttProvider');
  }
  setOrRemoveLocalStorage('sttServerUrl', typeof settings.sttServerUrl === 'string' ? settings.sttServerUrl : null);
  setOrRemoveLocalStorage('sttEndpointPath', settings.sttEndpointPath ?? null);
  setOrRemoveLocalStorage('sttModel', typeof settings.sttModel === 'string' ? settings.sttModel : null);
  setOrRemoveLocalStorage('sttLocalModel', typeof settings.sttLocalModel === 'string' ? settings.sttLocalModel : null);
  setOrRemoveLocalStorage('sttLanguage', typeof settings.sttLanguage === 'string' ? settings.sttLanguage : null);
  setOrRemoveLocalStorage('sttCorrectTranscript', settings.sttCorrectTranscript === undefined ? null : String(settings.sttCorrectTranscript));
};

export interface SettingsSyncedDetail {
  settings: DesktopSettings;
  bootstrap: boolean;
  adoptTheme: boolean;
}

const dispatchSettingsSynced = (settings: DesktopSettings, bootstrap: boolean, adoptTheme = bootstrap): void => {
  if (typeof window === 'undefined') {
    return;
  }
  window.dispatchEvent(new CustomEvent<SettingsSyncedDetail>('openchamber:settings-synced', {
    detail: { settings, bootstrap, adoptTheme },
  }));
};

type SettingsSaveState = 'idle' | 'saving' | 'error';

let _settingsSaveState: SettingsSaveState = 'idle';
let _settingsSaveStateResetTimer: ReturnType<typeof setTimeout> | null = null;
const _settingsSaveStateListeners = new Set<() => void>();

export const getSettingsSaveState = (): SettingsSaveState => _settingsSaveState;

export const subscribeToSettingsSaveState = (listener: () => void): (() => void) => {
  _settingsSaveStateListeners.add(listener);
  return () => _settingsSaveStateListeners.delete(listener);
};

export const reportSettingsSaveState = (state: 'saving' | 'saved' | 'error'): void => {
  ensureSettingsRuntimeLifecycle();
  dispatchSettingsSaveState(state);
};

const dispatchSettingsSaveState = (state: 'saving' | 'saved' | 'error'): void => {
  if (_settingsSaveStateResetTimer) {
    clearTimeout(_settingsSaveStateResetTimer);
    _settingsSaveStateResetTimer = null;
  }

  const nextState: SettingsSaveState = state === 'saved' ? 'idle' : state;
  if (nextState !== _settingsSaveState) {
    _settingsSaveState = nextState;
    _settingsSaveStateListeners.forEach((listener) => listener());
  }

  if (nextState === 'error') {
    _settingsSaveStateResetTimer = setTimeout(() => dispatchSettingsSaveState('saved'), 6000);
  }

  if (typeof window === 'undefined') {
    return;
  }
  window.dispatchEvent(new CustomEvent<'saving' | 'saved' | 'error'>('openchamber:settings-save-state', { detail: state }));
};

type PersistApi = {
  hasHydrated?: () => boolean;
  onFinishHydration?: (callback: () => void) => (() => void) | undefined;
};

const getPersistApi = (): PersistApi | undefined => {
  const candidate = useUIStore.persist;
  if (candidate && typeof candidate === 'object') {
    return candidate;
  }
  return undefined;
};

const getRuntimeSettingsAPI = () => getRegisteredRuntimeAPIs()?.settings ?? null;

const settingsEndpointForSurface = (): string => `/api/config/settings?${SETTINGS_SURFACE_QUERY}=${getSettingsSurface()}`;

const applyDesktopUiPreferences = (settings: DesktopSettings): void => {
  applySettingsToStores(settings);
};

const sanitizeWebSettings = (payload: unknown): DesktopSettings | null => parseSettingsDocument(payload);

type SettingsRuntimeContext = { runtimeKey: string; generation: number };
type SettingsWrite = {
  context: SettingsRuntimeContext;
  changes: Partial<DesktopSettings>;
};
type SettingsWriteResult = { ok: boolean };
type SettingsMutation = { revision: number; changes: Partial<DesktopSettings> };
type SettingsOperation = { revision: number };

class SettingsMutationTracker {
  private revision = 0;
  private mutations: SettingsMutation[] = [];
  private operations = new Set<SettingsOperation>();

  record(changes: Partial<DesktopSettings>): number {
    this.revision += 1;
    if (this.operations.size > 0) {
      const latest = this.mutations.at(-1);
      const crossedOperationBoundary = latest
        ? [...this.operations].some((operation) => operation.revision >= latest.revision)
        : true;
      if (latest && !crossedOperationBoundary) {
        latest.revision = this.revision;
        latest.changes = { ...latest.changes, ...changes };
      } else {
        this.mutations.push({ revision: this.revision, changes });
      }
    }
    return this.revision;
  }

  begin(revision = this.revision): SettingsOperation {
    const operation = { revision };
    this.operations.add(operation);
    return operation;
  }

  reconcile(settings: DesktopSettings, operation: SettingsOperation): DesktopSettings {
    let reconciled = settings;
    for (const mutation of this.mutations) {
      if (mutation.revision <= operation.revision) continue;
      reconciled = { ...reconciled, ...mutation.changes };
    }
    return reconciled;
  }

  finish(operation: SettingsOperation): void {
    if (!this.operations.delete(operation)) return;
    if (this.operations.size === 0) {
      this.mutations = [];
      return;
    }
    const oldestRevision = Math.min(...[...this.operations].map(({ revision }) => revision));
    this.mutations = this.mutations.filter((mutation) => mutation.revision > oldestRevision);
  }

  reset(): void {
    this.mutations = [];
    this.operations.clear();
  }
}

let _settingsRuntimeGeneration = 0;
let _settingsCache: { value: DesktopSettings | null; at: number; context: SettingsRuntimeContext } | null = null;
let _serverKnownSettings: Partial<DesktopSettings> = {};
let _applyingServerSettings = false;

export const isApplyingServerSettings = (): boolean => _applyingServerSettings;

const applyServerSettings = (settings: DesktopSettings): void => {
  _applyingServerSettings = true;
  try {
    applyDesktopUiPreferences(settings);
  } finally {
    _applyingServerSettings = false;
  }
};
let _settingsInflight: { promise: Promise<DesktopSettings | null>; context: SettingsRuntimeContext } | null = null;
let _pendingSettingsChanges: Partial<DesktopSettings> | null = null;
let _pendingSettingsContext: SettingsRuntimeContext | null = null;
let _settingsFlushTimer: ReturnType<typeof setTimeout> | null = null;
let _settingsFlushWaiters: Array<(result: SettingsWriteResult) => void> = [];
let _settingsLifecycleInitialized = false;
let _pendingSettingsRevision = 0;
let _settingsWritesInFlight: SettingsWrite[] = [];
const _settingsMutationTracker = new SettingsMutationTracker();
const SETTINGS_CACHE_TTL = 2_000;
const SETTINGS_DEBOUNCE_MS = 200;

const captureSettingsRuntimeContext = (): SettingsRuntimeContext => ({
  runtimeKey: getRuntimeKey(),
  generation: _settingsRuntimeGeneration,
});

type SettingsKey = keyof DesktopSettings;
type SettingsValue = DesktopSettings[SettingsKey];

// SAFETY: a Partial<DesktopSettings> here always comes from the typed stores or
// from `sanitizeWebSettings`, both of which only ever set DesktopSettings keys.
const settingsKeysOf = (changes: Partial<DesktopSettings>): SettingsKey[] => Object.keys(changes) as SettingsKey[];

const isSameSettingValue = (left: SettingsValue | undefined, right: SettingsValue | undefined): boolean => {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  return JSON.stringify(left) === JSON.stringify(right);
};

const rememberServerSettings = (settings: Partial<DesktopSettings>): void => {
  _serverKnownSettings = { ..._serverKnownSettings, ...settings };
};

const forgetServerSettings = (keys: SettingsKey[]): void => {
  const next: Partial<DesktopSettings> = { ..._serverKnownSettings };
  for (const key of keys) delete next[key];
  _serverKnownSettings = next;
};

const withoutRedundantSettings = (changes: Partial<DesktopSettings>): Partial<DesktopSettings> => {
  const next: Partial<DesktopSettings> = {};
  for (const key of settingsKeysOf(changes)) {
    if (isSameSettingValue(changes[key], _serverKnownSettings[key])) continue;
    Object.assign(next, { [key]: changes[key] });
  }
  return next;
};

const isSameSettingsRuntimeContext = (left: SettingsRuntimeContext, right: SettingsRuntimeContext): boolean => (
  left.runtimeKey === right.runtimeKey && left.generation === right.generation
);

const getSettingsWriteOverlay = (context: SettingsRuntimeContext): Partial<DesktopSettings> | null => {
  let overlay: Partial<DesktopSettings> | null = null;

  for (const write of _settingsWritesInFlight) {
    if (isSameSettingsRuntimeContext(write.context, context)) {
      overlay = { ...(overlay ?? {}), ...write.changes };
    }
  }

  if (_pendingSettingsChanges && _pendingSettingsContext && isSameSettingsRuntimeContext(_pendingSettingsContext, context)) {
    overlay = { ...(overlay ?? {}), ..._pendingSettingsChanges };
  }

  return overlay;
};

const reconcileSettingsRead = (
  settings: DesktopSettings | null,
  context: SettingsRuntimeContext,
): DesktopSettings | null => {
  const overlay = getSettingsWriteOverlay(context);
  return settings && overlay ? { ...settings, ...overlay } : settings;
};

const isSettingsRuntimeContextCurrent = (context: SettingsRuntimeContext): boolean => (
  context.generation === _settingsRuntimeGeneration && context.runtimeKey === getRuntimeKey()
);

const flushPendingSettingsBeforeSuspend = (): void => {
  if (!_pendingSettingsChanges) return;
  if (_settingsFlushTimer) {
    clearTimeout(_settingsFlushTimer);
    _settingsFlushTimer = null;
  }
  void _flushSettingsUpdate({ keepalive: true });
};

const ensureSettingsRuntimeLifecycle = (): void => {
  if (_settingsLifecycleInitialized || typeof window === 'undefined') return;
  _settingsLifecycleInitialized = true;

  subscribeRuntimeEndpointWillChange((detail) => {
    if (detail.runtimeKey === detail.previousRuntimeKey) return;
    if (_settingsFlushTimer) clearTimeout(_settingsFlushTimer);
    if (_pendingSettingsChanges) void _flushSettingsUpdate();
  });
  subscribeRuntimeEndpointChanged((detail) => {
    if (detail.runtimeKey === detail.previousRuntimeKey) return;
    _settingsRuntimeGeneration += 1;
    _settingsMutationTracker.reset();
    _pendingSettingsRevision = 0;
    _settingsCache = null;
    _settingsInflight = null;
    _serverKnownSettings = {};
    dispatchSettingsSaveState('saved');
  });

  try {
    window.addEventListener('pagehide', flushPendingSettingsBeforeSuspend, { capture: true });
    window.addEventListener('beforeunload', flushPendingSettingsBeforeSuspend, { capture: true });
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flushPendingSettingsBeforeSuspend();
      });
      document.addEventListener('freeze', flushPendingSettingsBeforeSuspend);
    }
    if (isCapacitorApp()) {
      void import('@capacitor/app')
        .then(({ App }) => App.addListener('appStateChange', ({ isActive }) => {
          if (!isActive) flushPendingSettingsBeforeSuspend();
        }))
        .catch(() => undefined);
    }
  } catch {
    // Restricted environments can reject listeners; the debounce timer still flushes.
  }
};

const fetchWebSettings = async (context = captureSettingsRuntimeContext()): Promise<DesktopSettings | null> => {
  ensureSettingsRuntimeLifecycle();
  if (_settingsCache && isSameSettingsRuntimeContext(_settingsCache.context, context) && Date.now() - _settingsCache.at < SETTINGS_CACHE_TTL) {
    return reconcileSettingsRead(_settingsCache.value, context);
  }

  if (_settingsInflight && isSameSettingsRuntimeContext(_settingsInflight.context, context)) return _settingsInflight.promise;

  const operation = _settingsMutationTracker.begin();
  const initialOverlay = getSettingsWriteOverlay(context);
  const commitRead = (settings: DesktopSettings | null): DesktopSettings | null => {
    if (!isSettingsRuntimeContextCurrent(context) || !settings) return null;
    const reconciled = reconcileSettingsRead(
      _settingsMutationTracker.reconcile({ ...settings, ...initialOverlay }, operation),
      context,
    );
    _settingsCache = { value: reconciled, at: Date.now(), context };
    const unchanged: Partial<DesktopSettings> = {};
    for (const key of settingsKeysOf(settings)) {
      if (isSameSettingValue(settings[key], reconciled?.[key])) {
        Object.assign(unchanged, { [key]: settings[key] });
      }
    }
    rememberServerSettings(unchanged);
    return reconciled;
  };

  const inflight = {
    context,
    promise: (async (): Promise<DesktopSettings | null> => {
      const runtimeSettings = getRuntimeSettingsAPI();
      if (runtimeSettings) {
        try {
          const result = await runtimeSettings.load();
          if (!isSettingsRuntimeContextCurrent(context)) return null;
          const settings = sanitizeWebSettings(result.settings);
          return commitRead(settings);
        } catch (error) {
          if (!isSettingsRuntimeContextCurrent(context)) return null;
          console.warn('Failed to load shared settings from runtime settings API:', error);
        }
      }

      if (!isSettingsRuntimeContextCurrent(context)) return null;
      try {
        const response = await runtimeFetch(settingsEndpointForSurface(), {
          method: 'GET',
          headers: { Accept: 'application/json' },
        });
        if (!isSettingsRuntimeContextCurrent(context)) return null;
        if (!response.ok) {
          return null;
        }
        const data = await response.json().catch(() => null);
        if (!isSettingsRuntimeContextCurrent(context)) return null;
        const settings = sanitizeWebSettings(data);
        return commitRead(settings);
      } catch (error) {
        if (!isSettingsRuntimeContextCurrent(context)) return null;
        console.warn('Failed to load shared settings from server:', error);
        return null;
      }
    })(),
  };
  _settingsInflight = inflight;
  void inflight.promise.finally(() => {
    _settingsMutationTracker.finish(operation);
    if (_settingsInflight === inflight) _settingsInflight = null;
  });

  return inflight.promise;
};

export const invalidateSettingsCache = (): void => {
  _settingsCache = null;
  _serverKnownSettings = {};
};

export const syncDesktopSettings = async (options?: { bootstrap?: boolean; adoptTheme?: boolean }): Promise<void> => {
  const bootstrap = options?.bootstrap !== false;
  const adoptTheme = options?.adoptTheme ?? bootstrap;
  if (typeof window === 'undefined') {
    return;
  }
  ensureSettingsRuntimeLifecycle();
  const context = captureSettingsRuntimeContext();
  const operation = _settingsMutationTracker.begin();

  const persistApis = [getPersistApi(), useSessionDisplayStore.persist];

  const waitForPersistHydration = (persistApi: PersistApi | undefined): Promise<void> => {
    if (!persistApi?.hasHydrated || persistApi.hasHydrated()) {
      return Promise.resolve();
    }
    if (!persistApi.onFinishHydration) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const unsubscribe = persistApi.onFinishHydration!(() => {
        unsubscribe?.();
        finish();
      });
      if (persistApi.hasHydrated?.()) finish();
    });
  };
  const waitForHydration = (): Promise<void> => Promise.all(
    persistApis.map(waitForPersistHydration),
  ).then(() => undefined);

  const overlayPendingChanges = (settings: DesktopSettings): DesktopSettings => {
    if (!_pendingSettingsChanges || !_pendingSettingsContext) return settings;
    if (!isSettingsRuntimeContextCurrent(_pendingSettingsContext)) return settings;
    return { ...settings, ..._pendingSettingsChanges };
  };

  const applySettings = async (loadedSettings: DesktopSettings) => {
    if (!isSettingsRuntimeContextCurrent(context)) return;
    let settings = overlayPendingChanges(_settingsMutationTracker.reconcile(loadedSettings, operation));
    await waitForHydration();
    if (!isSettingsRuntimeContextCurrent(context)) return;
    settings = withoutStaleDeviceFields(
      overlayPendingChanges(_settingsMutationTracker.reconcile(loadedSettings, operation)),
      context.runtimeKey,
    );
    try {
      persistToLocalStorage(settings);
    } catch (error) {
      console.warn('persistToLocalStorage failed:', error);
    }
    try {
      applyServerSettings(settings);
    } catch (error) {
      console.warn('applyDesktopUiPreferences failed:', error);
    }

    dispatchSettingsSynced(settings, bootstrap, adoptTheme);
  };

  try {
    const webSettings = await fetchWebSettings(context);
    if (webSettings && isSettingsRuntimeContextCurrent(context)) {
      await applySettings(webSettings);
    } else if (isSettingsRuntimeContextCurrent(context)) {
      window.dispatchEvent(new Event('openchamber:settings-sync-failed'));
    }
  } catch (error) {
    if (isSettingsRuntimeContextCurrent(context)) window.dispatchEvent(new Event('openchamber:settings-sync-failed'));
    console.warn('Failed to synchronise settings:', error);
  } finally {
    _settingsMutationTracker.finish(operation);
  }
};

async function _flushSettingsUpdate({ keepalive = false }: { keepalive?: boolean } = {}): Promise<void> {
  let ok = false;
  const changes = _pendingSettingsChanges;
  const context = _pendingSettingsContext;
  const revision = _pendingSettingsRevision;
  const waiters = _settingsFlushWaiters;
  _pendingSettingsChanges = null;
  _pendingSettingsContext = null;
  _pendingSettingsRevision = 0;
  _settingsFlushTimer = null;
  _settingsFlushWaiters = [];
  try {
    if (!changes || !context || Object.keys(changes).length === 0 || !isSettingsRuntimeContextCurrent(context)) {
      ok = true;
      dispatchSettingsSaveState('saved');
      return;
    }
    const operation = _settingsMutationTracker.begin(revision);
    const inFlightWrite: SettingsWrite = { context, changes: { ...changes } };
    _settingsWritesInFlight.push(inFlightWrite);
    rememberServerSettings(changes);
    const forgetSentSettings = () => forgetServerSettings(settingsKeysOf(changes));

    try {
      const runtimeSettings = getRuntimeSettingsAPI();
      if (runtimeSettings) {
        try {
          const updated = sanitizeWebSettings(await runtimeSettings.save(changes));
          if (!isSettingsRuntimeContextCurrent(context)) return;
          if (updated) {
            rememberServerSettings(updated);
            const reconciled = _settingsMutationTracker.reconcile(updated, operation);
            applyServerSettings(reconciled);
            dispatchSettingsSynced(reconciled, false);
            _settingsCache = null;
          }
          if (!updated) forgetSentSettings();
          ok = Boolean(updated);
          dispatchSettingsSaveState(updated ? 'saved' : 'error');
          return;
        } catch (error) {
          if (!isSettingsRuntimeContextCurrent(context)) return;
          console.warn('Failed to update settings via runtime settings API:', error);
        }
      }

      if (!isSettingsRuntimeContextCurrent(context)) return;
      try {
        const response = await runtimeFetch(settingsEndpointForSurface(), {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify(changes),
          keepalive,
        });

        if (!isSettingsRuntimeContextCurrent(context)) return;
        if (!response.ok) {
          console.warn('Failed to update shared settings via API:', response.status, response.statusText);
          forgetSentSettings();
          dispatchSettingsSaveState('error');
          return;
        }

        const updated = sanitizeWebSettings(await response.json().catch(() => null));
        if (!isSettingsRuntimeContextCurrent(context)) return;
        if (updated) {
          rememberServerSettings(updated);
          const reconciled = _settingsMutationTracker.reconcile(updated, operation);
          applyServerSettings(reconciled);
          dispatchSettingsSynced(reconciled, false);
          ok = true;
          dispatchSettingsSaveState('saved');
          _settingsCache = null;
        } else {
          forgetSentSettings();
          dispatchSettingsSaveState('error');
        }
      } catch (error) {
        if (isSettingsRuntimeContextCurrent(context)) {
          console.warn('Failed to update shared settings via API:', error);
          forgetSentSettings();
          dispatchSettingsSaveState('error');
        }
      }
    } finally {
      _settingsWritesInFlight = _settingsWritesInFlight.filter((write) => write !== inFlightWrite);
      _settingsMutationTracker.finish(operation);
    }
  } finally {
    waiters.forEach((resolve) => resolve({ ok }));
  }
}

export const loadDesktopSettings = (): Promise<DesktopSettings | null> => fetchWebSettings();

export const updateDesktopSettings = async (changes: Partial<DesktopSettings>): Promise<SettingsWriteResult> => {
  if (typeof window === 'undefined') {
    return { ok: false };
  }
  ensureSettingsRuntimeLifecycle();
  const context = captureSettingsRuntimeContext();

  if (_pendingSettingsContext && !isSameSettingsRuntimeContext(_pendingSettingsContext, context)) {
    if (_settingsFlushTimer) clearTimeout(_settingsFlushTimer);
    void _flushSettingsUpdate();
  }

  const writable: Partial<DesktopSettings> = {};
  for (const key of settingsKeysOf(changes)) {
    if (isWritableSettingsKey(key)) Object.assign(writable, { [key]: changes[key] });
  }
  const revision = _settingsMutationTracker.record(writable);
  const pending = withoutRedundantSettings({ ...(_pendingSettingsChanges ?? {}), ...writable });
  if (Object.keys(pending).length === 0) {
    _pendingSettingsChanges = null;
    _pendingSettingsContext = null;
    if (_settingsFlushTimer) {
      clearTimeout(_settingsFlushTimer);
      _settingsFlushTimer = null;
    }
    const waiters = _settingsFlushWaiters;
    _settingsFlushWaiters = [];
    waiters.forEach((resolve) => resolve({ ok: true }));
    dispatchSettingsSaveState('saved');
    return { ok: true };
  }
  _pendingSettingsChanges = pending;
  _pendingSettingsContext = context;
  _pendingSettingsRevision = revision;
  dispatchSettingsSaveState('saving');

  if (_settingsFlushTimer) {
    clearTimeout(_settingsFlushTimer);
  }
  const flushed = new Promise<SettingsWriteResult>((resolve) => {
    _settingsFlushWaiters.push(resolve);
  });
  _settingsFlushTimer = setTimeout(() => void _flushSettingsUpdate(), SETTINGS_DEBOUNCE_MS);
  return flushed;
};

export const initializeAppearancePreferences = async (): Promise<void> => {
  if (typeof window === 'undefined') {
    return;
  }

  const persistApi = getPersistApi();

  try {
    const appearance = await loadAppearancePreferences();
    if (!appearance) {
      return;
    }

    const applyAppearance = () => applyAppearancePreferences(appearance);

    if (persistApi?.hasHydrated?.()) {
      applyAppearance();
      return;
    }

    applyAppearance();
    if (persistApi?.onFinishHydration) {
      const unsubscribe = persistApi.onFinishHydration(() => {
        unsubscribe?.();
        applyAppearance();
      });
    }
  } catch (error) {
    console.warn('Failed to load appearance preferences:', error);
  }
};
