export type PWADisplayMode =
  | 'browser'
  | 'standalone'
  | 'minimal-ui'
  | 'fullscreen'
  | 'window-controls-overlay'
  | 'twa';

const DISPLAY_MODES: Array<Exclude<PWADisplayMode, 'browser' | 'twa'>> = ['standalone', 'minimal-ui', 'fullscreen', 'window-controls-overlay'];

export const PWA_INSTALL_NAME_STORAGE_KEY = 'openchamber.pwaName';
export const PWA_RECENT_SESSIONS_STORAGE_KEY = 'openchamber.pwaRecentSessions';

const matchesDisplayMode = (mode: Exclude<PWADisplayMode, 'browser' | 'twa'>): boolean => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia(`(display-mode: ${mode})`).matches;
};

export const getPWADisplayMode = (): PWADisplayMode => {
  if (typeof window === 'undefined') {
    return 'browser';
  }

  if (typeof document !== 'undefined' && document.referrer.startsWith('android-app://')) {
    return 'twa';
  }

  const navigatorStandalone = Boolean((window.navigator as Navigator & { standalone?: boolean }).standalone);
  if (navigatorStandalone) {
    return 'standalone';
  }

  const matched = DISPLAY_MODES.find((mode) => matchesDisplayMode(mode));
  return matched ?? 'browser';
};

export const isInstalledPWARuntime = (): boolean => {
  return getPWADisplayMode() !== 'browser';
};
