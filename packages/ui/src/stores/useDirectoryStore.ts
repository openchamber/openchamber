import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { opencodeClient } from '@/lib/opencode/client';
import { getDesktopHomeDirectory, isVSCodeRuntime } from '@/lib/desktop';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { updateDesktopSettings } from '@/lib/persistence';
import { useFileSearchStore } from '@/stores/useFileSearchStore';
import { streamDebugEnabled } from '@/stores/utils/streamDebug';
import { getDeferredSafeStorage } from './utils/safeStorage';

interface DirectoryStore {

  currentDirectory: string;
  directoryHistory: string[];
  historyIndex: number;
  homeDirectory: string;
  hasPersistedDirectory: boolean;
  isHomeReady: boolean;
  isSwitchingDirectory: boolean;

  setDirectory: (path: string, options?: { showOverlay?: boolean }) => void;
  goBack: () => void;
  goForward: () => void;
  goToParent: () => void;
  goHome: () => Promise<void>;
  synchronizeHomeDirectory: (path: string, options?: { persistDirectory?: boolean; runtimeContext?: HomeResolutionContext }) => void;
}

type HomeResolutionContext = { runtimeKey: string; generation: number };

let cachedHomeDirectory: string | null = null;
let homeResolveGeneration = 0;
const safeStorage = getDeferredSafeStorage();
const captureHomeResolutionContext = (): HomeResolutionContext => ({
  runtimeKey: getRuntimeKey(),
  generation: homeResolveGeneration,
});
const isHomeResolutionContextCurrent = (context: HomeResolutionContext): boolean => (
  context.runtimeKey === getRuntimeKey() && context.generation === homeResolveGeneration
);
const persistLocalHomeDirectory = (value: string, context?: HomeResolutionContext): void => {
  if (getRuntimeKey() === 'local' && (!context || isHomeResolutionContextCurrent(context))) {
    safeStorage.setItem('homeDirectory', value);
  }
};
const persistLocalLastDirectory = (value: string): void => {
  if (getRuntimeKey() === 'local') {
    safeStorage.setItem('lastDirectory', value);
  }
};
const persistedLastDirectory = getRuntimeKey() === 'local' ? safeStorage.getItem('lastDirectory') : null;
const initialHasPersistedDirectory =
  typeof persistedLastDirectory === 'string' && persistedLastDirectory.length > 0;


const invalidateFileSearchCache = (scope?: string | null) => {
  try {
    useFileSearchStore.getState().invalidateDirectory(scope);
  } catch (error) {
    console.warn('Failed to invalidate file search cache:', error);
  }
};

const normalizeDirectoryPath = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) {
    return trimmed;
  }
  const normalized = trimmed
    .replace(/\\/g, '/')
    .replace(/^([a-z]):/, (_, letter: string) => letter.toUpperCase() + ':');
  if (normalized.length > 1) {
    return normalized.replace(/\/+$/, '');
  }
  return normalized;
};

const resolveTildePath = (path: string, homeDir?: string | null): string => {
  const trimmed = path.trim();
  if (!trimmed.startsWith('~')) {
    return trimmed;
  }
  if (trimmed === '~') {
    return homeDir || trimmed;
  }
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return homeDir ? `${homeDir}${trimmed.slice(1)}` : trimmed;
  }
  return trimmed;
};

const resolveDirectoryPath = (path: string, homeDir?: string | null): string => {
  const expanded = resolveTildePath(path, homeDir);
  return normalizeDirectoryPath(expanded);
};

const getStoredHomeDirectory = (): string | null => {
  const raw = safeStorage.getItem('homeDirectory');
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return null;
  }
  const normalized = normalizeDirectoryPath(raw);
  return normalized.length > 0 ? normalized : null;
};

const getStoredLastDirectory = (): string | null => {
  const raw = safeStorage.getItem('lastDirectory');
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return null;
  }
  const normalized = normalizeDirectoryPath(raw);
  return normalized.length > 0 ? normalized : null;
};

const getProcessHomeDirectory = (): string | null => {
  if (typeof process === 'undefined') {
    return null;
  }

  const env = process?.env;
  const nodeHome = env?.HOME || env?.USERPROFILE || ((env?.HOMEDRIVE && env?.HOMEPATH) ? `${env.HOMEDRIVE}${env.HOMEPATH}` : undefined);
  if (typeof nodeHome === 'string' && nodeHome.trim().length > 0) {
    const normalized = normalizeDirectoryPath(nodeHome);
    return normalized.length > 0 ? normalized : null;
  }

  const cwd = process?.cwd?.();
  if (typeof cwd === 'string' && cwd.trim().length > 0) {
    const normalized = normalizeDirectoryPath(cwd);
    return normalized.length > 0 ? normalized : null;
  }

  return null;
};

const getHomeDirectory = (context?: HomeResolutionContext) => {
  if (context && !isHomeResolutionContextCurrent(context)) {
    return '/';
  }
  const isLocalRuntime = getRuntimeKey() === 'local';

  if (isLocalRuntime && typeof window !== 'undefined') {
    if (cachedHomeDirectory) return cachedHomeDirectory;

    const desktopHome =
      (typeof window.__OPENCHAMBER_HOME__ === 'string' && window.__OPENCHAMBER_HOME__.length > 0
        ? window.__OPENCHAMBER_HOME__
        : null);

    if (desktopHome && desktopHome.length > 0) {
      if (context && !isHomeResolutionContextCurrent(context)) {
        return '/';
      }
      cachedHomeDirectory = desktopHome;
      persistLocalHomeDirectory(desktopHome, context);
      return desktopHome;
    }

    const storedHome = getStoredHomeDirectory();
    if (storedHome && !isVSCodeRuntime()) {
      if (context && !isHomeResolutionContextCurrent(context)) {
        return '/';
      }
      cachedHomeDirectory = storedHome;
      return storedHome;
    }
  }

  if (isLocalRuntime) {
    const processHome = getProcessHomeDirectory();
    if (processHome) {
      return processHome;
    }
  }
  return '/';
};


const normalizeHomeCandidate = (value?: string | null) => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const normalized = trimmed.replace(/\\/g, '/');
  if (normalized.length > 1) {
    const withoutTrailingSlash = normalized.replace(/\/+$/, '');
    if (withoutTrailingSlash && withoutTrailingSlash.length > 0) {
      if (withoutTrailingSlash === '/') {
        return null;
      }
      return withoutTrailingSlash;
    }
  }
  if (normalized === '/' || normalized.length === 0) {
    return null;
  }
  return normalized;
};

const persistResolvedHome = (resolved: string, context: HomeResolutionContext): string | null => {
  if (!isHomeResolutionContextCurrent(context)) {
    return null;
  }
  cachedHomeDirectory = resolved;
  if (typeof window !== 'undefined' && isHomeResolutionContextCurrent(context)) {
    persistLocalHomeDirectory(resolved, context);
  }
  if (isHomeResolutionContextCurrent(context)) {
    void updateDesktopSettings({ homeDirectory: resolved });
  }
  return isHomeResolutionContextCurrent(context) ? resolved : null;
};

const initializeHomeDirectory = async (
  context = captureHomeResolutionContext(),
): Promise<string | null> => {
  const isCurrentRuntime = () => isHomeResolutionContextCurrent(context);
  const acceptCandidate = (candidate?: string | null) => {
    if (!isCurrentRuntime()) {
      return null;
    }
    const normalized = normalizeHomeCandidate(candidate);
    return normalized ? persistResolvedHome(normalized, context) : null;
  };

  try {
    const fsHome = await opencodeClient.getFilesystemHome();
    if (!isCurrentRuntime()) return null;
    const resolved = acceptCandidate(fsHome);
    if (resolved) {
      return resolved;
    }
  } catch (filesystemError) {
    console.warn('Failed to obtain filesystem home directory:', filesystemError);
  }
  if (!isCurrentRuntime()) return null;

  try {
    const info = await opencodeClient.getSystemInfo();
    if (!isCurrentRuntime()) return null;
    const resolved = acceptCandidate(info?.homeDirectory);
    if (resolved) {
      return resolved;
    }
  } catch (error) {
    console.warn('Failed to get home directory from system info:', error);
  }
  if (!isCurrentRuntime()) return null;

  if (context.runtimeKey === 'local') {
    try {
      const desktopHome = await getDesktopHomeDirectory();
      if (!isCurrentRuntime()) return null;
      const resolved = acceptCandidate(desktopHome);
      if (resolved) {
        return resolved;
      }
    } catch (desktopError) {
      console.warn('Failed to obtain desktop-integrated home directory:', desktopError);
    }

    const fallback = getHomeDirectory(context);
    const resolvedFallback = acceptCandidate(fallback);
    if (resolvedFallback) {
      return resolvedFallback;
    }

    return fallback;
  }

  return null;
};

const getVsCodeWorkspaceFolder = (): string | null => {
  if (!isVSCodeRuntime()) {
    return null;
  }
  const workspaceFolder = (window as unknown as { __VSCODE_CONFIG__?: { workspaceFolder?: unknown } }).__VSCODE_CONFIG__?.workspaceFolder;
  if (typeof workspaceFolder !== 'string' || workspaceFolder.trim().length === 0) {
    return null;
  }
  const normalized = normalizeDirectoryPath(workspaceFolder);
  return normalized.length > 0 ? normalized : null;
};

const initialHomeDirectory = getVsCodeWorkspaceFolder() || getHomeDirectory();
const initialCurrentDirectory = (() => {
  const persisted = getRuntimeKey() === 'local' ? getStoredLastDirectory() : null;
  if (persisted && !isVSCodeRuntime()) {
    return resolveDirectoryPath(persisted, initialHomeDirectory);
  }
  return initialHomeDirectory;
})();

if (initialCurrentDirectory) {
  opencodeClient.setDirectory(initialCurrentDirectory);
}
const initialIsHomeReady = Boolean(initialHomeDirectory && initialHomeDirectory !== '/');

export const useDirectoryStore = create<DirectoryStore>()(
  devtools(
    (set, get) => ({

      currentDirectory: initialCurrentDirectory,
      directoryHistory: [initialCurrentDirectory],
      historyIndex: 0,
      homeDirectory: initialHomeDirectory,
      hasPersistedDirectory: initialHasPersistedDirectory,
      isHomeReady: initialIsHomeReady,
      isSwitchingDirectory: false,

      setDirectory: (path: string, options?: { showOverlay?: boolean }) => {
        void options;
        const storedHomeDirectory = getRuntimeKey() === 'local' ? safeStorage.getItem('homeDirectory') : null;
        const homeDir = cachedHomeDirectory || get().homeDirectory || storedHomeDirectory;
        const resolvedPath = resolveDirectoryPath(path, homeDir);
        if (streamDebugEnabled()) {
          console.log('[DirectoryStore] setDirectory called with path:', resolvedPath);
        }

        opencodeClient.setDirectory(resolvedPath);
        invalidateFileSearchCache();

        set((state) => {
          const newHistory = [...state.directoryHistory.slice(0, state.historyIndex + 1), resolvedPath];

          persistLocalLastDirectory(resolvedPath);
          void updateDesktopSettings({ lastDirectory: resolvedPath });

          return {
            currentDirectory: resolvedPath,
            directoryHistory: newHistory,
            historyIndex: newHistory.length - 1,
            hasPersistedDirectory: true,
            isHomeReady: true,
            isSwitchingDirectory: false,
          };
        });
      },

      goBack: () => {
        const state = get();
        if (state.historyIndex > 0) {
          const newIndex = state.historyIndex - 1;
          const newDirectory = state.directoryHistory[newIndex];

          opencodeClient.setDirectory(newDirectory);
          invalidateFileSearchCache();

          persistLocalLastDirectory(newDirectory);

          void updateDesktopSettings({ lastDirectory: newDirectory });

          set({
            currentDirectory: newDirectory,
            historyIndex: newIndex,
            hasPersistedDirectory: true,
            isHomeReady: true,
            isSwitchingDirectory: false,
          });
        }
      },

      goForward: () => {
        const state = get();
        if (state.historyIndex < state.directoryHistory.length - 1) {
          const newIndex = state.historyIndex + 1;
          const newDirectory = state.directoryHistory[newIndex];

          opencodeClient.setDirectory(newDirectory);
          invalidateFileSearchCache();

          persistLocalLastDirectory(newDirectory);

          void updateDesktopSettings({ lastDirectory: newDirectory });

          set({
            currentDirectory: newDirectory,
            historyIndex: newIndex,
            hasPersistedDirectory: true,
            isHomeReady: true,
            isSwitchingDirectory: false,
          });
        }
      },

      goToParent: () => {
        const { currentDirectory, setDirectory } = get();
        const homeDir = cachedHomeDirectory || get().homeDirectory || getHomeDirectory();

        if (currentDirectory === homeDir || currentDirectory === '/') {
          return;
        }

        const cleanPath = currentDirectory.endsWith('/')
          ? currentDirectory.slice(0, -1)
          : currentDirectory;

        const lastSlash = cleanPath.lastIndexOf('/');
        if (lastSlash === -1) {
          const home = cachedHomeDirectory || getHomeDirectory();
          setDirectory(home);
        } else if (lastSlash === 0) {
          setDirectory('/');
        } else {
          setDirectory(cleanPath.substring(0, lastSlash));
        }
      },

      goHome: async () => {
        const homeDir =
          cachedHomeDirectory ||
          get().homeDirectory ||
          (await initializeHomeDirectory());
        if (homeDir) {
          get().setDirectory(homeDir);
        }
      },

      synchronizeHomeDirectory: (homePath: string, options?: { persistDirectory?: boolean; runtimeContext?: HomeResolutionContext }) => {
        const isCurrentResolution = () => (
          !options?.runtimeContext || isHomeResolutionContextCurrent(options.runtimeContext)
        );
        if (!isCurrentResolution()) {
          return;
        }
        const state = get();
        const resolvedHome = homePath;
        cachedHomeDirectory = resolvedHome;
        const needsUpdate = state.homeDirectory !== resolvedHome;
        const savedLastDirectory = getRuntimeKey() === 'local' ? safeStorage.getItem('lastDirectory') : null;
        const hasSavedLastDirectory = typeof savedLastDirectory === 'string' && savedLastDirectory.length > 0;
        const shouldReplaceCurrent =
          !hasSavedLastDirectory &&
          (
            state.currentDirectory === '/' ||
            state.currentDirectory === state.homeDirectory ||
            !state.currentDirectory
          );

        if (!needsUpdate && !shouldReplaceCurrent) {
          if (!state.isHomeReady && isCurrentResolution()) {
            set({ isHomeReady: true });
          }
          return;
        }

        const resolvedReady = typeof resolvedHome === 'string' && resolvedHome !== '' && resolvedHome !== '/';

        const resolvedCurrent = state.currentDirectory
          ? resolveDirectoryPath(state.currentDirectory, resolvedHome)
          : state.currentDirectory;
        const resolvedHistory = state.directoryHistory.map((entry) => resolveDirectoryPath(entry, resolvedHome));
        const historyChanged = resolvedHistory.some((entry, index) => entry !== state.directoryHistory[index]);
        const currentChanged = Boolean(resolvedCurrent && resolvedCurrent !== state.currentDirectory);

        const updates: Partial<DirectoryStore> = {
          homeDirectory: resolvedHome,
          hasPersistedDirectory: hasSavedLastDirectory,
          isHomeReady: resolvedReady
        };

        if (shouldReplaceCurrent) {
          updates.currentDirectory = resolvedHome;
          updates.directoryHistory = [resolvedHome];
          updates.historyIndex = 0;
          updates.isSwitchingDirectory = false;
        } else if (currentChanged || historyChanged) {
          updates.currentDirectory = resolvedCurrent as string;
          updates.directoryHistory = resolvedHistory;
          updates.historyIndex = Math.min(state.historyIndex, resolvedHistory.length - 1);
          updates.isSwitchingDirectory = false;
        }

        if (!isCurrentResolution()) {
          return;
        }
        set(() => updates as Partial<DirectoryStore>);

        if ((shouldReplaceCurrent || currentChanged) && resolvedReady && isCurrentResolution()) {
          const nextDirectory = shouldReplaceCurrent ? resolvedHome : (resolvedCurrent as string);
          opencodeClient.setDirectory(nextDirectory);
          invalidateFileSearchCache();
          if (options?.persistDirectory !== false) {
            persistLocalLastDirectory(nextDirectory);
            if (isCurrentResolution()) {
              void updateDesktopSettings({ lastDirectory: nextDirectory });
            }
          }

        }

        if (resolvedReady && isCurrentResolution()) {
          void updateDesktopSettings({ homeDirectory: resolvedHome });
        }
      }
    }),
    {
      name: 'directory-store'
    }
  )
);

if (typeof window !== 'undefined') {
  const initialResolutionContext = captureHomeResolutionContext();
  initializeHomeDirectory(initialResolutionContext).then((home) => {
    if (home && isHomeResolutionContextCurrent(initialResolutionContext)) {
      useDirectoryStore.getState().synchronizeHomeDirectory(home, { runtimeContext: initialResolutionContext });
    }
  });

  // Host switches happen in place (no page reload), so the home directory
  // must be re-resolved from the new runtime's authoritative source instead
  // of keeping the previous host's value cached.
  subscribeRuntimeEndpointChanged((detail) => {
    if (detail.runtimeKey === detail.previousRuntimeKey) {
      return;
    }
    cachedHomeDirectory = null;
    homeResolveGeneration += 1;
    const context = captureHomeResolutionContext();
    useDirectoryStore.setState({
      currentDirectory: '/',
      directoryHistory: ['/'],
      historyIndex: 0,
      homeDirectory: '/',
      hasPersistedDirectory: false,
      isHomeReady: false,
      isSwitchingDirectory: true,
    });
    opencodeClient.setDirectory(undefined);
    initializeHomeDirectory(context).then((home) => {
      if (!isHomeResolutionContextCurrent(context)) return;
      if (!home) {
        if (useDirectoryStore.getState().isSwitchingDirectory) {
          useDirectoryStore.setState({ isSwitchingDirectory: false, isHomeReady: false });
        }
        return;
      }
      useDirectoryStore.getState().synchronizeHomeDirectory(home, {
        persistDirectory: false,
        runtimeContext: context,
      });
    });
  });

  window.addEventListener('openchamber:settings-synced', (event: Event) => {
    const settings = (event as CustomEvent<{ homeDirectory?: unknown; lastDirectory?: unknown }>).detail;
    if (!settings || typeof settings !== 'object') {
      return;
    }

    const homeDirectory = typeof settings.homeDirectory === 'string' ? settings.homeDirectory : null;
    if (homeDirectory) {
      useDirectoryStore.getState().synchronizeHomeDirectory(homeDirectory);
    }

    const lastDirectory = typeof settings.lastDirectory === 'string' ? settings.lastDirectory : null;
    if (lastDirectory && lastDirectory !== useDirectoryStore.getState().currentDirectory) {
      useDirectoryStore.getState().setDirectory(lastDirectory, { showOverlay: false });
    }
  });
}
