import React, {
  useEffect,
  useMemo,
  useCallback,
  useState,
} from 'react';
import { flushSync } from 'react-dom';
import type { Theme, ThemeMode } from '@/types/theme';
import type { DesktopSettings } from '@/lib/desktop';
import { isDesktopLocalOriginActive, isTauriShell, isVSCodeRuntime } from '@/lib/desktop';
import { setDesktopWindowTheme } from '@/lib/desktopNative';
import { CSSVariableGenerator } from '@/lib/theme/cssGenerator';
import { updateDesktopSettings } from '@/lib/persistence';
import {
  themes,
  getThemeById,
  getDefaultTheme,
  DEFAULT_LIGHT_THEME_ID,
  DEFAULT_DARK_THEME_ID,
} from '@/lib/theme/themes';
import { ThemeSystemContext, type ThemeContextValue } from './theme-system-context';
import type { VSCodeThemePayload } from '@/lib/theme/vscode/adapter';

type ThemePreferences = {
  themeMode: ThemeMode;
  lightThemeId: string;
  darkThemeId: string;
};

type ThemeSyncPayload = {
  themeMode?: unknown;
  lightThemeId?: unknown;
  darkThemeId?: unknown;
};

const DEFAULT_LIGHT_ID = DEFAULT_LIGHT_THEME_ID;
const DEFAULT_DARK_ID = DEFAULT_DARK_THEME_ID;

const getSystemPreference = (): boolean => {
  if (typeof window === 'undefined') {
    return true;
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
};

const fallbackThemeForVariant = (variant: 'light' | 'dark'): Theme =>
  getDefaultTheme(variant === 'dark');

const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? React.useLayoutEffect : React.useEffect;

const suppressTransitionsForThemeSwitch = () => {
  if (typeof document === 'undefined') {
    return;
  }

  const root = document.documentElement;
  root.classList.add('oc-theme-switching');

  const frame = window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      root.classList.remove('oc-theme-switching');
    });
  });

  return () => {
    window.cancelAnimationFrame(frame);
    root.classList.remove('oc-theme-switching');
  };
};

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const getNested = (value: unknown, path: string[]): unknown =>
  path.reduce<unknown>((acc, key) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined), value);

const isValidCustomTheme = (value: unknown): value is Theme => {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const requiredPaths = [
    ['metadata', 'id'],
    ['metadata', 'name'],
    ['metadata', 'variant'],
    ['colors', 'primary', 'base'],
    ['colors', 'primary', 'foreground'],
    ['colors', 'surface', 'background'],
    ['colors', 'surface', 'foreground'],
    ['colors', 'surface', 'muted'],
    ['colors', 'surface', 'mutedForeground'],
    ['colors', 'surface', 'elevated'],
    ['colors', 'surface', 'elevatedForeground'],
    ['colors', 'surface', 'subtle'],
    ['colors', 'interactive', 'border'],
    ['colors', 'interactive', 'selection'],
    ['colors', 'interactive', 'selectionForeground'],
    ['colors', 'interactive', 'focusRing'],
    ['colors', 'interactive', 'hover'],
    ['colors', 'status', 'error'],
    ['colors', 'status', 'errorForeground'],
    ['colors', 'status', 'errorBackground'],
    ['colors', 'status', 'errorBorder'],
    ['colors', 'status', 'warning'],
    ['colors', 'status', 'warningForeground'],
    ['colors', 'status', 'warningBackground'],
    ['colors', 'status', 'warningBorder'],
    ['colors', 'status', 'success'],
    ['colors', 'status', 'successForeground'],
    ['colors', 'status', 'successBackground'],
    ['colors', 'status', 'successBorder'],
    ['colors', 'status', 'info'],
    ['colors', 'status', 'infoForeground'],
    ['colors', 'status', 'infoBackground'],
    ['colors', 'status', 'infoBorder'],
    ['colors', 'syntax', 'base', 'background'],
    ['colors', 'syntax', 'base', 'foreground'],
    ['colors', 'syntax', 'base', 'keyword'],
    ['colors', 'syntax', 'base', 'string'],
    ['colors', 'syntax', 'base', 'number'],
    ['colors', 'syntax', 'base', 'function'],
    ['colors', 'syntax', 'base', 'variable'],
    ['colors', 'syntax', 'base', 'type'],
    ['colors', 'syntax', 'base', 'comment'],
    ['colors', 'syntax', 'base', 'operator'],
    ['colors', 'syntax', 'highlights', 'diffAdded'],
    ['colors', 'syntax', 'highlights', 'diffRemoved'],
    ['colors', 'syntax', 'highlights', 'lineNumber'],
  ];

  for (const path of requiredPaths) {
    if (!isNonEmptyString(getNested(value, path))) {
      return false;
    }
  }

  const variant = getNested(value, ['metadata', 'variant']);
  return variant === 'light' || variant === 'dark';
};

const buildInitialPreferences = (defaultThemeId?: string): ThemePreferences => {
  let lightThemeId: string = DEFAULT_LIGHT_ID;
  let darkThemeId: string = DEFAULT_DARK_ID;
  let themeMode: ThemeMode = 'system';

  if (typeof window !== 'undefined') {
    const storedMode = localStorage.getItem('themeMode');
    const storedLightId = localStorage.getItem('lightThemeId');
    const storedDarkId = localStorage.getItem('darkThemeId');
    const legacyUseSystem = localStorage.getItem('useSystemTheme');
    const legacyThemeId = localStorage.getItem('selectedThemeId');
    const legacyVariant = localStorage.getItem('selectedThemeVariant');

    if (storedMode === 'light' || storedMode === 'dark' || storedMode === 'system') {
      themeMode = storedMode;
    } else if (legacyUseSystem !== null) {
      const useSystem = legacyUseSystem === 'true';
      if (useSystem) {
        themeMode = 'system';
      } else if (legacyThemeId) {
        const legacyTheme = getThemeById(legacyThemeId);
        if (legacyTheme) {
          themeMode = legacyTheme.metadata.variant === 'dark' ? 'dark' : 'light';
          if (legacyTheme.metadata.variant === 'dark') {
            darkThemeId = legacyTheme.metadata.id;
          } else {
            lightThemeId = legacyTheme.metadata.id;
          }
        }
      }
    } else if (legacyVariant === 'light' || legacyVariant === 'dark') {
      themeMode = legacyVariant;
    }

    if (typeof storedLightId === 'string' && storedLightId.trim().length > 0) {
      lightThemeId = storedLightId.trim();
    }

    if (typeof storedDarkId === 'string' && storedDarkId.trim().length > 0) {
      darkThemeId = storedDarkId.trim();
    }
  }

  if (defaultThemeId) {
    const defaultTheme = getThemeById(defaultThemeId);
    if (defaultTheme) {
      if (defaultTheme.metadata.variant === 'light') {
        lightThemeId = defaultTheme.metadata.id;
      } else {
        darkThemeId = defaultTheme.metadata.id;
      }
    }
  }

  return {
    themeMode,
    lightThemeId,
    darkThemeId,
  };
};

interface ThemeSystemProviderProps {
  children: React.ReactNode;
  defaultThemeId?: string;
}

export function ThemeSystemProvider({ children, defaultThemeId }: ThemeSystemProviderProps) {
  const cssGenerator = useMemo(() => new CSSVariableGenerator(), []);
  const [preferences, setPreferences] = useState<ThemePreferences>(() => buildInitialPreferences(defaultThemeId));
  const [systemPrefersDark, setSystemPrefersDark] = useState<boolean>(() => getSystemPreference());
  const [customThemes, setCustomThemes] = useState<Theme[]>([]);
  const [customThemesLoading, setCustomThemesLoading] = useState(false);
  const [vscodeTheme, setVSCodeTheme] = useState<Theme | null>(() => {
    if (typeof window === 'undefined' || !isVSCodeRuntime()) {
      return null;
    }
    const existing = (window as unknown as { __OPENCHAMBER_VSCODE_THEME__?: Theme }).__OPENCHAMBER_VSCODE_THEME__;
    return existing || null;
  });
  const isVSCode = useMemo(() => isVSCodeRuntime(), []);
  const isLocalDesktopOrigin = useMemo(() => isDesktopLocalOriginActive(), []);
  const isDesktopShell = useMemo(() => isTauriShell(), []);

  const availableThemes = useMemo(() => {
    const merged: Theme[] = [];
    const seen = new Set<string>();

    const add = (theme: Theme) => {
      const id = theme.metadata.id;
      if (seen.has(id)) return;
      seen.add(id);
      merged.push(theme);
    };

    if (isVSCode && vscodeTheme) {
      add(vscodeTheme);
    }

    // Custom themes first so they can override built-ins with the same id.
    customThemes.forEach(add);
    themes.forEach(add);

    return merged;
  }, [customThemes, isVSCode, vscodeTheme]);

  const getThemeByIdFromAvailable = useCallback(
    (themeId: string): Theme | undefined => availableThemes.find((theme) => theme.metadata.id === themeId),
    [availableThemes],
  );

  const ensureThemeById = useCallback(
    (themeId: string, variant: 'light' | 'dark'): Theme => {
      const theme = getThemeByIdFromAvailable(themeId);
      if (theme && theme.metadata.variant === variant) {
        return theme;
      }

      const fallback = availableThemes.find((candidate) => candidate.metadata.variant === variant);
      return fallback ?? fallbackThemeForVariant(variant);
    },
    [availableThemes, getThemeByIdFromAvailable],
  );

  const currentTheme = useMemo(() => {
    if (isVSCode && vscodeTheme) {
      return vscodeTheme;
    }
    if (preferences.themeMode === 'light') {
      return ensureThemeById(preferences.lightThemeId, 'light');
    }
    if (preferences.themeMode === 'dark') {
      return ensureThemeById(preferences.darkThemeId, 'dark');
    }
    return systemPrefersDark
      ? ensureThemeById(preferences.darkThemeId, 'dark')
      : ensureThemeById(preferences.lightThemeId, 'light');
  }, [ensureThemeById, isVSCode, preferences, systemPrefersDark, vscodeTheme]);

  const reloadCustomThemes = useCallback(async () => {
    if (typeof window === 'undefined' || isVSCode) {
      return;
    }

    setCustomThemesLoading(true);
    try {
      const res = await fetch('/api/config/themes', {
        method: 'GET',
        credentials: isLocalDesktopOrigin ? 'omit' : 'include',
        headers: {
          Accept: 'application/json',
        },
      });

      if (res.status === 401) {
        // UI auth gate will handle prompting; avoid noisy retries here.
        return;
      }

      if (!res.ok) {
        return;
      }

      const payload = await res.json();
      const incoming = Array.isArray(payload?.themes) ? payload.themes : [];
      const normalized = incoming.filter(isValidCustomTheme);
      setCustomThemes(normalized);
    } catch {
      // ignore
    } finally {
      setCustomThemesLoading(false);
    }
  }, [isLocalDesktopOrigin, isVSCode]);

  useEffect(() => {
    void reloadCustomThemes();
  }, [reloadCustomThemes]);

  useEffect(() => {
    if (!isVSCode) {
      return;
    }

    const applyVSCodeTheme = (theme: Theme) => {
      setVSCodeTheme(theme);
    };

    const handleThemeEvent = (event: Event) => {
      const detail = (event as CustomEvent<VSCodeThemePayload>).detail;
      if (detail?.theme) {
        applyVSCodeTheme(detail.theme);
      }
    };

    const existing = (window as unknown as { __OPENCHAMBER_VSCODE_THEME__?: Theme }).__OPENCHAMBER_VSCODE_THEME__;
    if (existing) {
      applyVSCodeTheme(existing);
    }

    window.addEventListener('openchamber:vscode-theme', handleThemeEvent as EventListener);
    return () => window.removeEventListener('openchamber:vscode-theme', handleThemeEvent as EventListener);
  }, [isVSCode]);

  const updateBrowserChrome = useCallback((theme: Theme) => {
    if (typeof document === 'undefined') {
      return;
    }
    const chromeColor = theme.colors.surface.background;

    document.body.style.backgroundColor = chromeColor;

    let metaThemeColor = document.querySelector('meta[name="theme-color"]') as HTMLMetaElement;
    if (!metaThemeColor) {
      metaThemeColor = document.createElement('meta');
      metaThemeColor.setAttribute('name', 'theme-color');
      document.head.appendChild(metaThemeColor);
    }
    metaThemeColor.setAttribute('content', chromeColor);

    const mediaQuery =
      theme.metadata.variant === 'dark'
        ? '(prefers-color-scheme: dark)'
        : '(prefers-color-scheme: light)';
    let metaThemeColorMedia = document.querySelector(
      `meta[name="theme-color"][media="${mediaQuery}"]`,
    ) as HTMLMetaElement;
    if (!metaThemeColorMedia) {
      metaThemeColorMedia = document.createElement('meta');
      metaThemeColorMedia.setAttribute('name', 'theme-color');
      metaThemeColorMedia.setAttribute('media', mediaQuery);
      document.head.appendChild(metaThemeColorMedia);
    }
    metaThemeColorMedia.setAttribute('content', chromeColor);
  }, []);

  const applyVSCodeRuntimeClass = useCallback((enabled: boolean) => {
    if (typeof document === 'undefined') {
      return;
    }
    document.documentElement.classList.toggle('vscode-runtime', enabled);
  }, []);

  useIsomorphicLayoutEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    const restoreTransitions = suppressTransitionsForThemeSwitch();
    cssGenerator.apply(currentTheme);
    applyVSCodeRuntimeClass(isVSCode);
    updateBrowserChrome(currentTheme);

    const root = document.documentElement;
    root.classList.remove('light', 'dark');
    root.classList.add(currentTheme.metadata.variant);

    return restoreTransitions;
  }, [applyVSCodeRuntimeClass, cssGenerator, currentTheme, isVSCode, updateBrowserChrome]);

  useEffect(() => {
    if (preferences.themeMode !== 'system' || typeof window === 'undefined') {
      return;
    }

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = (event: MediaQueryListEvent) => {
      setSystemPrefersDark(event.matches);
    };

    setSystemPrefersDark(mediaQuery.matches);
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, [preferences.themeMode]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    localStorage.setItem('themeMode', preferences.themeMode);
    localStorage.setItem('lightThemeId', preferences.lightThemeId);
    localStorage.setItem('darkThemeId', preferences.darkThemeId);
    localStorage.setItem('useSystemTheme', String(preferences.themeMode === 'system'));
    localStorage.setItem('selectedThemeId', currentTheme.metadata.id);
    localStorage.setItem(
      'selectedThemeVariant',
      currentTheme.metadata.variant === 'light' ? 'light' : 'dark',
    );

    // Splash screen (packages/web/index.html) runs before the theme CSS vars load.
    // Persist just enough to theme it on next boot.
    const lightTheme = ensureThemeById(preferences.lightThemeId, 'light');
    const darkTheme = ensureThemeById(preferences.darkThemeId, 'dark');

    localStorage.setItem('splashBgLight', lightTheme.colors.surface.background);
    localStorage.setItem('splashFgLight', lightTheme.colors.surface.foreground);
    localStorage.setItem('splashBgDark', darkTheme.colors.surface.background);
    localStorage.setItem('splashFgDark', darkTheme.colors.surface.foreground);
  }, [preferences, currentTheme, ensureThemeById]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const handleStorage = (event: StorageEvent) => {
      if (event.storageArea !== window.localStorage) {
        return;
      }

      if (event.key !== 'themeMode' && event.key !== 'lightThemeId' && event.key !== 'darkThemeId') {
        return;
      }

      setPreferences((prev) => {
        const nextModeRaw = localStorage.getItem('themeMode');
        const nextMode: ThemeMode =
          nextModeRaw === 'light' || nextModeRaw === 'dark' || nextModeRaw === 'system'
            ? nextModeRaw
            : prev.themeMode;

        const nextLightRaw = localStorage.getItem('lightThemeId');
        const nextLight = typeof nextLightRaw === 'string' && nextLightRaw.trim().length > 0
          ? nextLightRaw.trim()
          : prev.lightThemeId;

        const nextDarkRaw = localStorage.getItem('darkThemeId');
        const nextDark = typeof nextDarkRaw === 'string' && nextDarkRaw.trim().length > 0
          ? nextDarkRaw.trim()
          : prev.darkThemeId;

        if (nextMode === prev.themeMode && nextLight === prev.lightThemeId && nextDark === prev.darkThemeId) {
          return prev;
        }

        return {
          themeMode: nextMode,
          lightThemeId: nextLight,
          darkThemeId: nextDark,
        };
      });
    };

    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  const applyIncomingThemeSync = useCallback((payload: ThemeSyncPayload) => {
    const mode = payload.themeMode;
    const light = payload.lightThemeId;
    const dark = payload.darkThemeId;

    if ((mode !== 'light' && mode !== 'dark' && mode !== 'system') || typeof light !== 'string' || typeof dark !== 'string') {
      return;
    }

    const normalizedLight = light.trim();
    const normalizedDark = dark.trim();
    if (!normalizedLight || !normalizedDark) {
      return;
    }

    suppressTransitionsForThemeSwitch();
    flushSync(() => {
      setPreferences((prev) => {
        if (prev.themeMode === mode && prev.lightThemeId === normalizedLight && prev.darkThemeId === normalizedDark) {
          return prev;
        }

        return {
          themeMode: mode,
          lightThemeId: normalizedLight,
          darkThemeId: normalizedDark,
        };
      });
    });
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const scopedWindow = window as unknown as {
      __openchamberApplyThemeSync?: (payload: ThemeSyncPayload) => void;
    };

    scopedWindow.__openchamberApplyThemeSync = applyIncomingThemeSync;

    return () => {
      if (scopedWindow.__openchamberApplyThemeSync === applyIncomingThemeSync) {
        delete scopedWindow.__openchamberApplyThemeSync;
      }
    };
  }, [applyIncomingThemeSync]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) {
        return;
      }

      const data = event.data as {
        type?: unknown;
        payload?: ThemeSyncPayload;
      };

      if (data?.type !== 'openchamber:theme-sync' || !data.payload) {
        return;
      }

      applyIncomingThemeSync(data.payload);
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [applyIncomingThemeSync]);

  useEffect(() => {
    const lightTheme = ensureThemeById(preferences.lightThemeId, 'light');
    const darkTheme = ensureThemeById(preferences.darkThemeId, 'dark');

    void updateDesktopSettings({
      themeId: currentTheme.metadata.id,
      themeVariant: currentTheme.metadata.variant === 'light' ? 'light' : 'dark',
      useSystemTheme: preferences.themeMode === 'system',
      lightThemeId: preferences.lightThemeId,
      darkThemeId: preferences.darkThemeId,
      splashBgLight: lightTheme.colors.surface.background,
      splashFgLight: lightTheme.colors.surface.foreground,
      splashBgDark: darkTheme.colors.surface.background,
      splashFgDark: darkTheme.colors.surface.foreground,
    });
  }, [currentTheme.metadata.id, currentTheme.metadata.variant, ensureThemeById, preferences.themeMode, preferences.lightThemeId, preferences.darkThemeId]);

  useEffect(() => {
    if (!isDesktopShell) {
      return;
    }

    void (async () => {
      await setDesktopWindowTheme(preferences.themeMode, currentTheme.metadata.variant);
    })();
  }, [currentTheme.metadata.variant, isDesktopShell, preferences.themeMode]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    const handleSettingsSynced = (event: Event) => {
      const detail = (event as CustomEvent<DesktopSettings>).detail;
      if (!detail) {
        return;
      }

      setPreferences((prev) => {
        let nextMode = prev.themeMode;
        if (detail.useSystemTheme === true) {
          nextMode = 'system';
        } else if (detail.useSystemTheme === false) {
          if (detail.themeVariant === 'dark' || detail.themeVariant === 'light') {
            nextMode = detail.themeVariant;
          }
        }

        let nextLight = prev.lightThemeId;
        if (typeof detail.lightThemeId === 'string' && detail.lightThemeId.length > 0) {
          nextLight = detail.lightThemeId.trim();
        }

        let nextDark = prev.darkThemeId;
        if (typeof detail.darkThemeId === 'string' && detail.darkThemeId.length > 0) {
          nextDark = detail.darkThemeId.trim();
        }

        const same =
          nextMode === prev.themeMode &&
          nextLight === prev.lightThemeId &&
          nextDark === prev.darkThemeId;

        if (same) {
          return prev;
        }

        return {
          themeMode: nextMode,
          lightThemeId: nextLight,
          darkThemeId: nextDark,
        };
      });
    };

    window.addEventListener('openchamber:settings-synced', handleSettingsSynced);
    return () => window.removeEventListener('openchamber:settings-synced', handleSettingsSynced);
  }, []);

  const setTheme = useCallback(
    (themeId: string) => {
      const theme = availableThemes.find((candidate) => candidate.metadata.id === themeId);
      if (!theme) {
        return;
      }

      setPreferences((prev) => {
        if (theme.metadata.variant === 'dark') {
          if (prev.darkThemeId === theme.metadata.id && prev.themeMode === 'dark') {
            return prev;
          }
          return {
            ...prev,
            darkThemeId: theme.metadata.id,
            themeMode: 'dark',
          };
        }

        if (prev.lightThemeId === theme.metadata.id && prev.themeMode === 'light') {
          return prev;
        }

        return {
          ...prev,
          lightThemeId: theme.metadata.id,
          themeMode: 'light',
        };
      });
    },
    [availableThemes],
  );

  const setThemeModeHandler = useCallback((mode: ThemeMode) => {
    setPreferences((prev) => {
      if (prev.themeMode === mode) {
        return prev;
      }
      return {
        ...prev,
        themeMode: mode,
      };
    });
  }, []);

  const setSystemPreferenceHandler = useCallback(
    (use: boolean) => {
      if (use) {
        setPreferences((prev) => {
          if (prev.themeMode === 'system') {
            return prev;
          }
          return {
            ...prev,
            themeMode: 'system',
          };
        });
        return;
      }

      const fallbackMode: ThemeMode =
        currentTheme.metadata.variant === 'dark' ? 'dark' : 'light';
      setPreferences((prev) => {
        if (prev.themeMode === fallbackMode) {
          return prev;
        }
        return {
          ...prev,
          themeMode: fallbackMode,
        };
      });
    },
    [currentTheme.metadata.variant],
  );

  const setLightThemePreference = useCallback(
    (themeId: string) => {
      const theme = availableThemes.find(
        (candidate) =>
          candidate.metadata.id === themeId && candidate.metadata.variant === 'light',
      );
      if (!theme) {
        return;
      }

      setPreferences((prev) => {
        if (prev.lightThemeId === theme.metadata.id) {
          return prev;
        }
        return {
          ...prev,
          lightThemeId: theme.metadata.id,
        };
      });
    },
    [availableThemes],
  );

  const setDarkThemePreference = useCallback(
    (themeId: string) => {
      const theme = availableThemes.find(
        (candidate) =>
          candidate.metadata.id === themeId && candidate.metadata.variant === 'dark',
      );
      if (!theme) {
        return;
      }

      setPreferences((prev) => {
        if (prev.darkThemeId === theme.metadata.id) {
          return prev;
        }
        return {
          ...prev,
          darkThemeId: theme.metadata.id,
        };
      });
    },
    [availableThemes],
  );

  const value: ThemeContextValue = {
    currentTheme,
    availableThemes,
    setTheme,
    customThemesLoading,
    reloadCustomThemes,
    isSystemPreference: preferences.themeMode === 'system',
    setSystemPreference: setSystemPreferenceHandler,
    themeMode: preferences.themeMode,
    setThemeMode: setThemeModeHandler,
    lightThemeId: preferences.lightThemeId,
    darkThemeId: preferences.darkThemeId,
    setLightThemePreference,
    setDarkThemePreference,
  };

  return (
    <ThemeSystemContext.Provider value={value}>
      {children}
    </ThemeSystemContext.Provider>
  );
}
