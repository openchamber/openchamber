import { create } from 'zustand';

import { fetchDesktopInstalledApps, isDesktopLocalOriginActive, isTauriShell, type DesktopSettings, type InstalledDesktopAppInfo } from '@/lib/desktop';
import { OPEN_IN_APPS, DEFAULT_OPEN_IN_APP_ID, OPEN_IN_ALWAYS_AVAILABLE_APP_IDS, getOpenInAppById, type OpenInApp } from '@/lib/openInApps';
import { updateDesktopSettings } from '@/lib/persistence';

export type OpenInAppOption = OpenInApp & {
  iconDataUrl?: string;
};

type OpenInAppsState = {
  selectedAppId: string;
  availableApps: OpenInAppOption[];
  hasLoadedApps: boolean;
  isCacheStale: boolean;
  isScanning: boolean;
  initialize: () => void;
  loadInstalledApps: (force?: boolean) => Promise<void>;
  selectApp: (appId: string) => Promise<void>;
};

const getAlwaysAvailableApps = (): OpenInAppOption[] => {
  return OPEN_IN_APPS
    .filter((app) => OPEN_IN_ALWAYS_AVAILABLE_APP_IDS.has(app.id))
    .map((app) => ({ ...app }));
};

const getStoredAppId = (): string => {
  if (typeof window === 'undefined') {
    return DEFAULT_OPEN_IN_APP_ID;
  }

  const stored = window.localStorage.getItem('openInAppId');
  if (stored && getOpenInAppById(stored)) {
    return stored;
  }

  return DEFAULT_OPEN_IN_APP_ID;
};

let initialized = false;
let loading = false;
let keepScanning = false;
let retryAttempt = 0;
let retryTimeout: ReturnType<typeof setTimeout> | null = null;

const clearRetryTimeout = () => {
  if (retryTimeout) {
    clearTimeout(retryTimeout);
    retryTimeout = null;
  }
};

export const useOpenInAppsStore = create<OpenInAppsState>()((set, get) => ({
  selectedAppId: getStoredAppId(),
  availableApps: getAlwaysAvailableApps(),
  hasLoadedApps: false,
  isCacheStale: false,
  isScanning: false,

  initialize: () => {
    if (initialized || typeof window === 'undefined') {
      return;
    }
    initialized = true;

    const applyInstalledApps = (installed: InstalledDesktopAppInfo[]) => {
      if (!Array.isArray(installed) || installed.length === 0) {
        set({ availableApps: getAlwaysAvailableApps(), hasLoadedApps: false });
        return;
      }

      const allowed = new Set(installed.map((app) => app.name));
      const iconMap = new Map(installed.map((app) => [app.name, app.iconDataUrl ?? undefined]));

      const filtered = OPEN_IN_APPS.filter(
        (app) => allowed.has(app.appName) || OPEN_IN_ALWAYS_AVAILABLE_APP_IDS.has(app.id)
      );

      const withIcons = filtered.map((app) => ({
        ...app,
        iconDataUrl: iconMap.get(app.appName),
      }));

      set({ availableApps: withIcons, hasLoadedApps: true });
    };

    const loadInstalledApps = async (force?: boolean) => {
      if (!isTauriShell() || !isDesktopLocalOriginActive()) {
        return;
      }

      if (loading) {
        return;
      }

      const state = get();
      if (state.hasLoadedApps && !force) {
        return;
      }

      const appNames = OPEN_IN_APPS.map((app) => app.appName);
      clearRetryTimeout();

      if (force) {
        set({ hasLoadedApps: false });
      }

      loading = true;
      keepScanning = false;
      set({ isScanning: true });

      try {
        const {
          apps: installed,
          success,
          hasCache,
          isCacheStale,
        } = await fetchDesktopInstalledApps(appNames, force);

        set({ isCacheStale: hasCache ? isCacheStale : false });
        applyInstalledApps(installed);

        if (success) {
          if (!hasCache && installed.length === 0 && retryAttempt < 3) {
            const delays = [800, 1600, 3200];
            const delay = delays[retryAttempt] ?? 3200;
            retryAttempt += 1;
            keepScanning = true;
            retryTimeout = setTimeout(() => {
              void loadInstalledApps();
            }, delay);
            return;
          }

          retryAttempt = 0;
          keepScanning = false;
          return;
        }

        if (retryAttempt < 3) {
          const delays = [1000, 3000, 7000];
          const delay = delays[retryAttempt] ?? 7000;
          retryAttempt += 1;
          keepScanning = true;
          retryTimeout = setTimeout(() => {
            void loadInstalledApps();
          }, delay);
        }
      } finally {
        loading = false;
        if (!keepScanning) {
          set({ isScanning: false });
        }
      }
    };

    void loadInstalledApps();

    const settingsHandler = (event: Event) => {
      const detail = (event as CustomEvent<DesktopSettings>).detail;
      const nextId = detail
        && typeof detail.openInAppId === 'string'
        && detail.openInAppId.length > 0
        && getOpenInAppById(detail.openInAppId)
        ? detail.openInAppId
        : null;

      if (!nextId) {
        return;
      }

      window.localStorage.setItem('openInAppId', nextId);
      set({ selectedAppId: nextId });
    };

    const appReadyHandler = () => {
      void loadInstalledApps();
    };

    const updateHandler = (event: Event) => {
      const detail = (event as CustomEvent<InstalledDesktopAppInfo[]>).detail;
      if (!Array.isArray(detail)) {
        return;
      }

      retryAttempt = 3;
      keepScanning = false;
      set({ isScanning: false, isCacheStale: false });
      applyInstalledApps(detail);
    };

    window.addEventListener('openchamber:settings-synced', settingsHandler);
    window.addEventListener('openchamber:app-ready', appReadyHandler);
    window.addEventListener('openchamber:installed-apps-updated', updateHandler);

    const appReady = (window as unknown as { __openchamberAppReady?: boolean }).__openchamberAppReady;
    if (appReady) {
      void loadInstalledApps();
    }

    window.setTimeout(() => {
      if (!get().hasLoadedApps) {
        void loadInstalledApps();
      }
    }, 5000);
  },

  loadInstalledApps: async (force?: boolean) => {
    if (!initialized) {
      get().initialize();
    }

    if (!isTauriShell() || !isDesktopLocalOriginActive()) {
      return;
    }

    if (loading) {
      return;
    }

    const state = get();
    if (state.hasLoadedApps && !force) {
      return;
    }

    const appNames = OPEN_IN_APPS.map((app) => app.appName);
    clearRetryTimeout();

    if (force) {
      set({ hasLoadedApps: false });
    }

    loading = true;
    keepScanning = false;
    set({ isScanning: true });

    try {
      const {
        apps: installed,
        hasCache,
        isCacheStale,
      } = await fetchDesktopInstalledApps(appNames, force);

      const allowed = new Set(installed.map((app) => app.name));
      const iconMap = new Map(installed.map((app) => [app.name, app.iconDataUrl ?? undefined]));
      const filtered = OPEN_IN_APPS.filter(
        (app) => allowed.has(app.appName) || OPEN_IN_ALWAYS_AVAILABLE_APP_IDS.has(app.id)
      );
      const withIcons = filtered.map((app) => ({
        ...app,
        iconDataUrl: iconMap.get(app.appName),
      }));

      set({
        availableApps: withIcons.length > 0 ? withIcons : getAlwaysAvailableApps(),
        hasLoadedApps: withIcons.length > 0,
        isCacheStale: hasCache ? isCacheStale : false,
      });
    } finally {
      loading = false;
      if (!keepScanning) {
        set({ isScanning: false });
      }
    }
  },

  selectApp: async (appId: string) => {
    if (!getOpenInAppById(appId)) {
      return;
    }

    set({ selectedAppId: appId });

    if (typeof window !== 'undefined') {
      window.localStorage.setItem('openInAppId', appId);
    }

    await updateDesktopSettings({ openInAppId: appId });
  },
}));
