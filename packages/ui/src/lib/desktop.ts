import type { ProjectEntry } from '@/lib/api/types';

export type AssistantNotificationPayload = {
  title?: string;
  body?: string;
};

export type UpdateInfo = {
  available: boolean;
  version?: string;
  currentVersion: string;
  body?: string;
  date?: string;
  // Web-specific fields
  packageManager?: string;
  updateCommand?: string;
};

export type UpdateProgress = {
  downloaded: number;
  total?: number;
};

export type SkillCatalogConfig = {
  id: string;
  label: string;
  source: string;
  subpath?: string;
  gitIdentityId?: string;
};

export type DesktopSettings = {
  themeId?: string;
  useSystemTheme?: boolean;
  themeVariant?: 'light' | 'dark';
  lightThemeId?: string;
  darkThemeId?: string;
  lastDirectory?: string;
  homeDirectory?: string;
  // Optional absolute path to `opencode` binary.
  opencodeBinary?: string;
  projects?: ProjectEntry[];
  activeProjectId?: string;
  approvedDirectories?: string[];
  securityScopedBookmarks?: string[];
  pinnedDirectories?: string[];
  showReasoningTraces?: boolean;
  showTextJustificationActivity?: boolean;
  showDeletionDialog?: boolean;
  nativeNotificationsEnabled?: boolean;
  notificationMode?: 'always' | 'hidden-only';
  notifyOnSubtasks?: boolean;

  // Event toggles (which events trigger notifications)
  notifyOnCompletion?: boolean;
  notifyOnError?: boolean;
  notifyOnQuestion?: boolean;

  // Per-event notification templates
  notificationTemplates?: {
    completion: { title: string; message: string };
    error: { title: string; message: string };
    question: { title: string; message: string };
    subtask: { title: string; message: string };
  };

  // Summarization settings
  summarizeLastMessage?: boolean;
  summaryThreshold?: number;
  summaryLength?: number;
  maxLastMessageLength?: number;

  usageAutoRefresh?: boolean;
  usageRefreshIntervalMs?: number;
  usageDisplayMode?: 'usage' | 'remaining';
  usageDropdownProviders?: string[];
  usageSelectedModels?: Record<string, string[]>;  // Map of providerId -> selected model names
  usageCollapsedFamilies?: Record<string, string[]>;  // Map of providerId -> collapsed family IDs (UsagePage)
  usageExpandedFamilies?: Record<string, string[]>;  // Map of providerId -> EXPANDED family IDs (header dropdown - inverted)
  usageModelGroups?: Record<string, {
    customGroups?: Array<{id: string; label: string; models: string[]; order: number}>;
    modelAssignments?: Record<string, string>;  // modelName -> groupId
    renamedGroups?: Record<string, string>;  // groupId -> custom label
  }>;  // Per-provider custom model groups configuration
  autoDeleteEnabled?: boolean;
  autoDeleteAfterDays?: number;
  defaultModel?: string; // format: "provider/model"
  defaultVariant?: string;
  defaultAgent?: string;
  defaultGitIdentityId?: string; // ''/undefined = unset, 'global' or profile id
  openInAppId?: string;
  autoCreateWorktree?: boolean;
  queueModeEnabled?: boolean;
  gitmojiEnabled?: boolean;
  zenModel?: string;
  toolCallExpansion?: 'collapsed' | 'activity' | 'detailed';
  fontSize?: number;
  terminalFontSize?: number;
  padding?: number;
  cornerRadius?: number;
  inputBarOffset?: number;

  favoriteModels?: Array<{ providerID: string; modelID: string }>;
  recentModels?: Array<{ providerID: string; modelID: string }>;
  diffLayoutPreference?: 'dynamic' | 'inline' | 'side-by-side';
  diffViewMode?: 'single' | 'stacked';
  directoryShowHidden?: boolean;
  filesViewShowGitignored?: boolean;

  // Message limit — controls fetch, trim, and Load More chunk size (default: 200)
  messageLimit?: number;

  // User-added skills catalogs (persisted to ~/.config/openchamber/settings.json)
  skillCatalogs?: SkillCatalogConfig[];
};

type TauriGlobal = {
  core?: {
    invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
  dialog?: {
    open?: (options: Record<string, unknown>) => Promise<unknown>;
  };
  event?: {
    listen?: (
      event: string,
      handler: (evt: { payload?: unknown }) => void,
    ) => Promise<() => void>;
  };
};

export const isTauriShell = (): boolean => {
  if (typeof window === 'undefined') return false;
  const tauri = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
  return typeof tauri?.core?.invoke === 'function';
};

const normalizeOrigin = (raw: string): string | null => {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    return new URL(trimmed).origin;
  } catch {
    try {
      return new URL(trimmed.endsWith('/') ? trimmed : `${trimmed}/`).origin;
    } catch {
      return null;
    }
  }
};

export const isDesktopLocalOriginActive = (): boolean => {
  if (typeof window === 'undefined') return false;
  const local = typeof window.__OPENCHAMBER_LOCAL_ORIGIN__ === 'string' ? window.__OPENCHAMBER_LOCAL_ORIGIN__ : '';
  const localOrigin = normalizeOrigin(local);
  const currentOrigin = normalizeOrigin(window.location.origin) || window.location.origin;
  return Boolean(localOrigin && currentOrigin && localOrigin === currentOrigin);
};

// Desktop shell detection that doesn't require Tauri IPC availability.
// (Remote pages can temporarily lose window.__TAURI__ if URL doesn't match remote allowlist.)
export const isDesktopShell = (): boolean => {
  if (typeof window === 'undefined') return false;
  if (typeof window.__OPENCHAMBER_LOCAL_ORIGIN__ === 'string' && window.__OPENCHAMBER_LOCAL_ORIGIN__.length > 0) {
    return true;
  }
  return isTauriShell();
};

export const isVSCodeRuntime = (): boolean => {
  if (typeof window === "undefined") return false;
  const apis = (window as { __OPENCHAMBER_RUNTIME_APIS__?: { runtime?: { isVSCode?: boolean } } }).__OPENCHAMBER_RUNTIME_APIS__;
  return apis?.runtime?.isVSCode === true;
};

export const isWebRuntime = (): boolean => {
  if (typeof window === "undefined") return false;
  const apis = (window as { __OPENCHAMBER_RUNTIME_APIS__?: { runtime?: { platform?: string } } }).__OPENCHAMBER_RUNTIME_APIS__;
  const platform = apis?.runtime?.platform;
  if (platform === 'web') {
    return true;
  }
  if (platform === 'desktop' || platform === 'vscode') {
    return false;
  }
  // Default: anything that's not VSCode behaves like web (HTTP UI).
  return !isVSCodeRuntime();
};

export const getDesktopHomeDirectory = async (): Promise<string | null> => {
  if (typeof window !== 'undefined') {
    const embedded = window.__OPENCHAMBER_HOME__;
    if (embedded && embedded.length > 0) {
      return embedded;
    }
  }

  return null;
};

export const requestDirectoryAccess = async (
  directoryPath: string
): Promise<{ success: boolean; path?: string; projectId?: string; error?: string }> => {
  // Desktop shell on local instance: use native folder picker.
  if (isTauriShell() && isDesktopLocalOriginActive()) {
    try {
      const tauri = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
      const selected = await tauri?.dialog?.open?.({
        directory: true,
        multiple: false,
        title: 'Select Working Directory',
      });
      if (!selected || typeof selected !== 'string') {
        return { success: false, error: 'Directory selection cancelled' };
      }
      return { success: true, path: selected };
    } catch (error) {
      console.warn('Failed to request directory access (tauri)', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  return { success: true, path: directoryPath };
};

export const startAccessingDirectory = async (
  directoryPath: string
): Promise<{ success: boolean; error?: string }> => {
  void directoryPath;
  return { success: true };
};

export const stopAccessingDirectory = async (
  directoryPath: string
): Promise<{ success: boolean; error?: string }> => {
  void directoryPath;
  return { success: true };
};

export const sendAssistantCompletionNotification = async (
  payload?: AssistantNotificationPayload
): Promise<boolean> => {
  if (isTauriShell()) {
    try {
      const tauri = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
      await tauri?.core?.invoke?.('desktop_notify', {
        payload: {
          title: payload?.title,
          body: payload?.body,
          tag: 'openchamber-agent-complete',
        },
      });
      return true;
    } catch (error) {
      console.warn('Failed to send assistant completion notification (tauri)', error);
      return false;
    }
  }

  return false;
};

export const checkForDesktopUpdates = async (): Promise<UpdateInfo | null> => {
  if (!isTauriShell() || !isDesktopLocalOriginActive()) {
    return null;
  }

  try {
    const tauri = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
    const info = await tauri?.core?.invoke?.('desktop_check_for_updates');
    return info as UpdateInfo;
  } catch (error) {
    console.warn('Failed to check for updates (tauri)', error);
    return null;
  }
};

export const downloadDesktopUpdate = async (
  onProgress?: (progress: UpdateProgress) => void
): Promise<boolean> => {
  if (!isTauriShell() || !isDesktopLocalOriginActive()) {
    return false;
  }

  const tauri = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
  let unlisten: null | (() => void | Promise<void>) = null;
  let downloaded = 0;
  let total: number | undefined;

  try {
    if (typeof onProgress === 'function' && tauri?.event?.listen) {
      unlisten = await tauri.event.listen('openchamber:update-progress', (evt) => {
        const payload = evt?.payload;
        if (!payload || typeof payload !== 'object') return;
        const data = payload as { event?: unknown; data?: unknown };
        const eventName = typeof data.event === 'string' ? data.event : null;
        const eventData = data.data && typeof data.data === 'object' ? (data.data as Record<string, unknown>) : null;

        if (eventName === 'Started') {
          downloaded = 0;
          total = typeof eventData?.contentLength === 'number' ? (eventData.contentLength as number) : undefined;
          onProgress({ downloaded, total });
          return;
        }

        if (eventName === 'Progress') {
          const d = eventData?.downloaded;
          const t = eventData?.total;
          if (typeof d === 'number') downloaded = d;
          if (typeof t === 'number') total = t;
          onProgress({ downloaded, total });
          return;
        }

        if (eventName === 'Finished') {
          onProgress({ downloaded, total });
        }
      });
    }

    await tauri?.core?.invoke?.('desktop_download_and_install_update');
    return true;
  } catch (error) {
    console.warn('Failed to download update (tauri)', error);
    return false;
  } finally {
    if (unlisten) {
      try {
        const result = unlisten();
        if (result instanceof Promise) {
          await result;
        }
      } catch {
        // ignored
      }
    }
  }
};

export const restartToApplyUpdate = async (): Promise<boolean> => {
  if (!isTauriShell() || !isDesktopLocalOriginActive()) {
    return false;
  }

  try {
    const tauri = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
    await tauri?.core?.invoke?.('desktop_restart');
    return true;
  } catch (error) {
    console.warn('Failed to restart for update (tauri)', error);
    return false;
  }
};

export const openDesktopPath = async (path: string, app?: string | null): Promise<boolean> => {
  if (!isTauriShell() || !isDesktopLocalOriginActive()) {
    return false;
  }

  const trimmed = path?.trim();
  if (!trimmed) {
    return false;
  }

  try {
    const tauri = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
    await tauri?.core?.invoke?.('desktop_open_path', {
      path: trimmed,
      app: typeof app === 'string' && app.trim().length > 0 ? app.trim() : undefined,
    });
    return true;
  } catch (error) {
    console.warn('Failed to open path (tauri)', error);
    return false;
  }
};

export const filterInstalledDesktopApps = async (apps: string[]): Promise<string[]> => {
  if (!isTauriShell() || !isDesktopLocalOriginActive()) {
    return [];
  }

  const candidate = Array.isArray(apps) ? apps.filter((value) => typeof value === 'string') : [];
  if (candidate.length === 0) {
    return [];
  }

  try {
    const tauri = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
    const result = await tauri?.core?.invoke?.('desktop_filter_installed_apps', {
      apps: candidate,
    });
    return Array.isArray(result) ? result.filter((value) => typeof value === 'string') : [];
  } catch (error) {
    console.warn('Failed to check installed apps (tauri)', error);
    return [];
  }
};

export const fetchDesktopAppIcons = async (apps: string[]): Promise<Record<string, string>> => {
  if (!isTauriShell() || !isDesktopLocalOriginActive()) {
    return {};
  }

  const candidate = Array.isArray(apps) ? apps.filter((value) => typeof value === 'string') : [];
  if (candidate.length === 0) {
    return {};
  }

  try {
    const tauri = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
    const result = await tauri?.core?.invoke?.('desktop_fetch_app_icons', {
      apps: candidate,
    });
    if (!Array.isArray(result)) {
      return {};
    }
    const map: Record<string, string> = {};
    for (const entry of result) {
      if (!entry || typeof entry !== 'object') continue;
      const candidateEntry = entry as { app?: unknown; data_url?: unknown };
      if (typeof candidateEntry.app !== 'string' || typeof candidateEntry.data_url !== 'string') continue;
      map[candidateEntry.app] = candidateEntry.data_url;
    }
    return map;
  } catch (error) {
    console.warn('Failed to fetch installed app icons (tauri)', error);
    return {};
  }
};

export type InstalledDesktopAppInfo = {
  name: string;
  iconDataUrl?: string | null;
};

export type FetchDesktopInstalledAppsResult = {
  apps: InstalledDesktopAppInfo[];
  success: boolean;
  hasCache: boolean;
  isCacheStale: boolean;
};

export const fetchDesktopInstalledApps = async (
  apps: string[],
  force?: boolean
): Promise<FetchDesktopInstalledAppsResult> => {
  if (!isTauriShell() || !isDesktopLocalOriginActive()) {
    return { apps: [], success: false, hasCache: false, isCacheStale: false };
  }

  const candidate = Array.isArray(apps) ? apps.filter((value) => typeof value === 'string') : [];
  if (candidate.length === 0) {
    return { apps: [], success: true, hasCache: false, isCacheStale: false };
  }

  try {
    const tauri = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
    const result = await tauri?.core?.invoke?.('desktop_get_installed_apps', {
      apps: candidate,
      force: force === true ? true : undefined,
    });
    if (!result || typeof result !== 'object') {
      return { apps: [], success: false, hasCache: false, isCacheStale: false };
    }
    const payload = result as { apps?: unknown; hasCache?: unknown; isCacheStale?: unknown };
    if (!Array.isArray(payload.apps)) {
      return { apps: [], success: false, hasCache: false, isCacheStale: false };
    }
    const installedApps = payload.apps
      .filter((entry) => entry && typeof entry === 'object')
      .map((entry) => {
        const record = entry as { name?: unknown; iconDataUrl?: unknown };
        return {
          name: typeof record.name === 'string' ? record.name : '',
          iconDataUrl: typeof record.iconDataUrl === 'string' ? record.iconDataUrl : null,
        };
      })
      .filter((entry) => entry.name.length > 0);
    return {
      apps: installedApps,
      success: true,
      hasCache: payload.hasCache === true,
      isCacheStale: payload.isCacheStale === true,
    };
  } catch (error) {
    console.warn('Failed to fetch installed apps (tauri)', error);
    return { apps: [], success: false, hasCache: false, isCacheStale: false };
  }
};

export const clearDesktopCache = async (): Promise<boolean> => {
  if (!isTauriShell() || !isDesktopLocalOriginActive()) {
    return false;
  }

  try {
    const tauri = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
    await tauri?.core?.invoke?.('desktop_clear_cache');
    return true;
  } catch (error) {
    console.warn('Failed to clear cache', error);
    return false;
  }
};
