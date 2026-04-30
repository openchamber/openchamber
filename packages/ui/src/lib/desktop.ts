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
  nextSuggestedCheckInSec?: number;
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

export type ManagedRemoteTunnelPreset = {
  id: string;
  name: string;
  hostname: string;
};

export type DesktopSettings = {
  themeId?: string;
  useSystemTheme?: boolean;
  themeVariant?: 'light' | 'dark';
  lightThemeId?: string;
  darkThemeId?: string;
  splashBgLight?: string;
  splashFgLight?: string;
  splashBgDark?: string;
  splashFgDark?: string;
  lastDirectory?: string;
  homeDirectory?: string;
  // Optional absolute path to `opencode` binary.
  opencodeBinary?: string;
  desktopLanAccessEnabled?: boolean;
  projects?: ProjectEntry[];
  activeProjectId?: string;
  approvedDirectories?: string[];
  securityScopedBookmarks?: string[];
  pinnedDirectories?: string[];
  showReasoningTraces?: boolean;
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
  sessionRetentionAction?: 'archive' | 'delete';
  tunnelProvider?: string;
  tunnelMode?: 'quick' | 'managed-remote' | 'managed-local';
  tunnelBootstrapTtlMs?: number | null;
  tunnelSessionTtlMs?: number;
  managedLocalTunnelConfigPath?: string | null;
  managedRemoteTunnelHostname?: string;
  managedRemoteTunnelToken?: string | null;
  hasManagedRemoteTunnelToken?: boolean;
  managedRemoteTunnelPresets?: ManagedRemoteTunnelPreset[];
  managedRemoteTunnelSelectedPresetId?: string;
  managedRemoteTunnelPresetTokens?: Record<string, string>;
  defaultModel?: string; // format: "provider/model"
  defaultVariant?: string;
  defaultAgent?: string;
  defaultGitIdentityId?: string; // ''/undefined = unset, 'global' or profile id
  openInAppId?: string;
  autoCreateWorktree?: boolean;
  queueModeEnabled?: boolean;
  gitmojiEnabled?: boolean;
  defaultFileViewerPreview?: boolean;
  zenModel?: string;
  gitProviderId?: string;
  gitModelId?: string;
  pwaAppName?: string;
  pwaOrientation?: 'system' | 'portrait' | 'landscape';
  inputSpellcheckEnabled?: boolean;
  showToolFileIcons?: boolean;
  showExpandedBashTools?: boolean;
  showExpandedEditTools?: boolean;
  timeFormatPreference?: 'auto' | '12h' | '24h';
  weekStartPreference?: 'auto' | 'sunday' | 'monday';
  chatRenderMode?: 'sorted' | 'live';
  messageStreamTransport?: 'auto' | 'ws' | 'sse';
  activityRenderMode?: 'collapsed' | 'summary';
  mermaidRenderingMode?: 'svg' | 'ascii';
  userMessageRenderingMode?: 'markdown' | 'plain';
  stickyUserHeader?: boolean;
  wideChatLayoutEnabled?: boolean;
  showSplitAssistantMessageActions?: boolean;
  fontSize?: number;
  terminalFontSize?: number;
  uiFont?: string;
  monoFont?: string;
  padding?: number;
  cornerRadius?: number;
  inputBarOffset?: number;

  favoriteModels?: Array<{ providerID: string; modelID: string }>;
  recentModels?: Array<{ providerID: string; modelID: string }>;
  diffLayoutPreference?: 'dynamic' | 'inline' | 'side-by-side';
  diffViewMode?: 'single' | 'stacked';
  gitChangesViewMode?: 'flat' | 'tree';
  directoryShowHidden?: boolean;
  filesViewShowGitignored?: boolean;

  // Message limit — controls fetch, trim, and Load More chunk size (default: 200)
  messageLimit?: number;

  // User-added skills catalogs (persisted to ~/.config/openchamber/settings.json)
  skillCatalogs?: SkillCatalogConfig[];
  // Opt-in to send anonymous usage reports for update checks (default: true)
  reportUsage?: boolean;

  // Global behavior prompt — synced to ~/.config/opencode/AGENTS.md
  globalBehaviorPrompt?: string;
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

type ElectronRuntimeGlobal = {
  runtime?: string;
};

const getElectronRuntime = (): ElectronRuntimeGlobal | null => {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { __OPENCHAMBER_ELECTRON__?: ElectronRuntimeGlobal }).__OPENCHAMBER_ELECTRON__ ?? null;
};

export const isTauriShell = (): boolean => {
  if (typeof window === 'undefined') return false;
  const tauri = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
  return typeof tauri?.core?.invoke === 'function';
};

export const isElectronShell = (): boolean => getElectronRuntime()?.runtime === 'electron';

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

const parseUrl = (raw: string): URL | null => {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    return new URL(trimmed);
  } catch {
    try {
      return new URL(trimmed.endsWith('/') ? trimmed : `${trimmed}/`);
    } catch {
      return null;
    }
  }
};

const normalizeHost = (rawHost: string): string => rawHost.replace(/^\[|\]$/g, '').toLowerCase();

const isLoopbackHost = (host: string): boolean => {
  const normalized = normalizeHost(host);
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
};

export const isDesktopLocalOriginActive = (): boolean => {
  if (typeof window === 'undefined') return false;
  if (!isDesktopShell()) return false;

  const local = typeof window.__OPENCHAMBER_LOCAL_ORIGIN__ === 'string' ? window.__OPENCHAMBER_LOCAL_ORIGIN__ : '';
  const localUrl = parseUrl(local);
  const currentUrl = parseUrl(window.location.origin);

  if (localUrl && currentUrl) {
    if (localUrl.origin === currentUrl.origin) {
      return true;
    }

    const localPort = localUrl.port || (localUrl.protocol === 'https:' ? '443' : '80');
    const currentPort = currentUrl.port || (currentUrl.protocol === 'https:' ? '443' : '80');

    return (
      localUrl.protocol === currentUrl.protocol &&
      localPort === currentPort &&
      isLoopbackHost(localUrl.hostname) &&
      isLoopbackHost(currentUrl.hostname)
    );
  }

  const localOrigin = normalizeOrigin(local);
  const currentOrigin = normalizeOrigin(window.location.origin) || window.location.origin;
  if (localOrigin && currentOrigin && localOrigin === currentOrigin) {
    return true;
  }

  return Boolean(currentUrl && isLoopbackHost(currentUrl.hostname));
};

export const isDesktopShell = (): boolean => {
  if (typeof window === 'undefined') return false;
  return isTauriShell() || isElectronShell();
};

export const startDesktopWindowDrag = async (): Promise<boolean> => {
  if (!isDesktopShell() || !isTauriShell()) {
    return false;
  }

  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const appWindow = getCurrentWindow();
    await appWindow.startDragging();
    return true;
  } catch {
    return false;
  }
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

export const requestFileAccess = async (
  options?: { filters?: Array<{ name: string; extensions: string[] }> }
): Promise<{ success: boolean; path?: string; error?: string }> => {
  if (isTauriShell() && isDesktopLocalOriginActive()) {
    try {
      const tauri = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
      const selected = await tauri?.dialog?.open?.({
        directory: false,
        multiple: false,
        title: 'Select File',
        ...(options?.filters ? { filters: options.filters } : {}),
      });
      if (!selected || typeof selected !== 'string') {
        return { success: false, error: 'File selection cancelled' };
      }
      return { success: true, path: selected };
    } catch (error) {
      console.warn('Failed to request file access (tauri)', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  return { success: false, error: 'Native file picker not available' };
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

  return restartDesktopApp();
};

export const restartDesktopApp = async (): Promise<boolean> => {
  if (!isTauriShell()) {
    return false;
  }

  try {
    const tauri = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
    await tauri?.core?.invoke?.('desktop_restart');
    return true;
  } catch (error) {
    console.warn('Failed to restart desktop app (tauri)', error);
    return false;
  }
};

export const getDesktopLanAddress = async (): Promise<string | null> => {
  if (!isTauriShell() || !isDesktopLocalOriginActive()) {
    return null;
  }

  try {
    const tauri = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
    const result = await tauri?.core?.invoke?.('desktop_get_lan_address');
    return typeof result === 'string' && result.trim().length > 0 ? result.trim() : null;
  } catch (error) {
    console.warn('Failed to get desktop LAN address (tauri)', error);
    return null;
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

export const revealDesktopPath = async (path: string): Promise<boolean> => {
  if (!isTauriShell() || !isDesktopLocalOriginActive()) {
    return false;
  }

  const trimmed = path?.trim();
  if (!trimmed) {
    return false;
  }

  try {
    const tauri = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
    await tauri?.core?.invoke?.('desktop_reveal_path', {
      path: trimmed,
    });
    return true;
  } catch {
    return openDesktopPath(trimmed);
  }
};

export const saveDesktopMarkdownFile = async (
  defaultFileName: string,
  content: string,
): Promise<string | null> => {
  if (!isTauriShell() || !isDesktopLocalOriginActive()) {
    return null;
  }

  const trimmedFileName = defaultFileName?.trim();
  if (!trimmedFileName) {
    return null;
  }

  try {
    const tauri = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
    const result = await tauri?.core?.invoke?.('desktop_save_markdown_file', {
      defaultFileName: trimmedFileName,
      content,
    });
    return typeof result === 'string' && result.trim().length > 0 ? result : null;
  } catch (error) {
    console.warn('Failed to save markdown file (tauri)', error);
    return null;
  }
};

export const openDesktopProjectInApp = async (
  projectPath: string,
  appId: string,
  appName: string,
): Promise<boolean> => {
  if (!isTauriShell() || !isDesktopLocalOriginActive()) {
    return false;
  }

  const trimmedProjectPath = projectPath?.trim();
  const trimmedAppId = appId?.trim();
  const trimmedAppName = appName?.trim();

  if (!trimmedProjectPath || !trimmedAppId || !trimmedAppName) {
    return false;
  }

  try {
    const tauri = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
    await tauri?.core?.invoke?.('desktop_open_in_app', {
      projectPath: trimmedProjectPath,
      appId: trimmedAppId,
      appName: trimmedAppName,
    });
    return true;
  } catch (error) {
    console.warn('Failed to open project in app', error);
    return false;
  }
};

export const openDesktopFileInApp = async (
  filePath: string,
  appId: string,
  appName: string,
): Promise<boolean> => {
  if (!isTauriShell() || !isDesktopLocalOriginActive()) {
    return false;
  }

  const trimmedFilePath = filePath?.trim();
  const trimmedAppId = appId?.trim();
  const trimmedAppName = appName?.trim();

  if (!trimmedFilePath || !trimmedAppId || !trimmedAppName) {
    return false;
  }

  try {
    const tauri = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
    await tauri?.core?.invoke?.('desktop_open_file_in_app', {
      filePath: trimmedFilePath,
      appId: trimmedAppId,
      appName: trimmedAppName,
    });
    return true;
  } catch (error) {
    console.warn('Failed to open file in app', error);
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
