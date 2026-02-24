import type { DesktopSettings } from '@/lib/desktop';
import { useUIStore } from '@/stores/useUIStore';
import { useMessageQueueStore } from '@/stores/messageQueueStore';
import { setDirectoryShowHidden } from '@/lib/directoryShowHidden';
import { setFilesViewShowGitignored } from '@/lib/filesViewShowGitignored';
import { loadAppearancePreferences, applyAppearancePreferences } from '@/lib/appearancePersistence';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';

const persistToLocalStorage = (settings: DesktopSettings) => {
  if (typeof window === 'undefined') {
    return;
  }

  if (settings.themeId) {
    localStorage.setItem('selectedThemeId', settings.themeId);
  }
  if (settings.themeVariant) {
    localStorage.setItem('selectedThemeVariant', settings.themeVariant);
  }
  if (settings.lightThemeId) {
    localStorage.setItem('lightThemeId', settings.lightThemeId);
  }
  if (settings.darkThemeId) {
    localStorage.setItem('darkThemeId', settings.darkThemeId);
  }
  if (typeof settings.useSystemTheme === 'boolean') {
    localStorage.setItem('useSystemTheme', String(settings.useSystemTheme));
  }
  if (settings.lastDirectory) {
    localStorage.setItem('lastDirectory', settings.lastDirectory);
  }
  if (settings.homeDirectory) {
    localStorage.setItem('homeDirectory', settings.homeDirectory);
    window.__OPENCHAMBER_HOME__ = settings.homeDirectory;
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
      .filter((project) => (project as unknown as { sidebarCollapsed?: boolean }).sidebarCollapsed === true)
      .map((project) => project.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    if (collapsed.length > 0) {
      localStorage.setItem('oc.sessions.projectCollapse', JSON.stringify(collapsed));
    } else {
      localStorage.removeItem('oc.sessions.projectCollapse');
    }
  }
  if (typeof settings.gitmojiEnabled === 'boolean') {
    localStorage.setItem('gitmojiEnabled', String(settings.gitmojiEnabled));
  } else {
    localStorage.removeItem('gitmojiEnabled');
  }
  if (typeof settings.directoryShowHidden === 'boolean') {
    localStorage.setItem('directoryTreeShowHidden', settings.directoryShowHidden ? 'true' : 'false');
  }
  if (typeof settings.filesViewShowGitignored === 'boolean') {
    localStorage.setItem('filesViewShowGitignored', settings.filesViewShowGitignored ? 'true' : 'false');
  }
  if (typeof settings.openInAppId === 'string' && settings.openInAppId.length > 0) {
    localStorage.setItem('openInAppId', settings.openInAppId);
  }
};

type PersistApi = {
  hasHydrated?: () => boolean;
  onFinishHydration?: (callback: () => void) => (() => void) | undefined;
};

const sanitizeSkillCatalogs = (value: unknown): DesktopSettings['skillCatalogs'] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const result: NonNullable<DesktopSettings['skillCatalogs']> = [];
  const seen = new Set<string>();

  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const candidate = entry as Record<string, unknown>;

    const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
    const label = typeof candidate.label === 'string' ? candidate.label.trim() : '';
    const source = typeof candidate.source === 'string' ? candidate.source.trim() : '';
    const subpath = typeof candidate.subpath === 'string' ? candidate.subpath.trim() : '';
    const gitIdentityId = typeof candidate.gitIdentityId === 'string' ? candidate.gitIdentityId.trim() : '';

    if (!id || !label || !source) continue;
    if (seen.has(id)) continue;
    seen.add(id);

    result.push({
      id,
      label,
      source,
      ...(subpath ? { subpath } : {}),
      ...(gitIdentityId ? { gitIdentityId } : {}),
    });
  }

  return result;
};

const sanitizeProjects = (value: unknown): DesktopSettings['projects'] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const result: NonNullable<DesktopSettings['projects']> = [];
  const seenIds = new Set<string>();
  const seenPaths = new Set<string>();

  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const candidate = entry as Record<string, unknown>;

    const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
    const rawPath = typeof candidate.path === 'string' ? candidate.path.trim() : '';
    if (!id || !rawPath) continue;

    const normalizedPath = rawPath === '/' ? rawPath : rawPath.replace(/\\/g, '/').replace(/\/+$/, '');
    if (!normalizedPath) continue;

    if (seenIds.has(id) || seenPaths.has(normalizedPath)) continue;
    seenIds.add(id);
    seenPaths.add(normalizedPath);

    const project: NonNullable<DesktopSettings['projects']>[number] = {
      id,
      path: normalizedPath,
    };

    if (typeof candidate.label === 'string' && candidate.label.trim().length > 0) {
      project.label = candidate.label.trim();
    }
    if (typeof candidate.icon === 'string' && candidate.icon.trim().length > 0) {
      project.icon = candidate.icon.trim();
    }
    if (typeof candidate.color === 'string' && candidate.color.trim().length > 0) {
      project.color = candidate.color.trim();
    }
    if (typeof candidate.addedAt === 'number' && Number.isFinite(candidate.addedAt) && candidate.addedAt >= 0) {
      project.addedAt = candidate.addedAt;
    }
    if (
      typeof candidate.lastOpenedAt === 'number' &&
      Number.isFinite(candidate.lastOpenedAt) &&
      candidate.lastOpenedAt >= 0
    ) {
      project.lastOpenedAt = candidate.lastOpenedAt;
    }
    if (typeof candidate.sidebarCollapsed === 'boolean') {
      (project as unknown as Record<string, unknown>).sidebarCollapsed = candidate.sidebarCollapsed;
    }
    result.push(project);
  }

  return result.length > 0 ? result : undefined;
};

const sanitizeModelRefs = (value: unknown, limit: number): Array<{ providerID: string; modelID: string }> | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const result: Array<{ providerID: string; modelID: string }> = [];
  const seen = new Set<string>();

  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const candidate = entry as Record<string, unknown>;
    const providerID = typeof candidate.providerID === 'string' ? candidate.providerID.trim() : '';
    const modelID = typeof candidate.modelID === 'string' ? candidate.modelID.trim() : '';
    if (!providerID || !modelID) continue;
    const key = `${providerID}/${modelID}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ providerID, modelID });
    if (result.length >= limit) break;
  }

  return result;
};

const getPersistApi = (): PersistApi | undefined => {
  const candidate = (useUIStore as unknown as { persist?: PersistApi }).persist;
  if (candidate && typeof candidate === 'object') {
    return candidate;
  }
  return undefined;
};

const getRuntimeSettingsAPI = () => getRegisteredRuntimeAPIs()?.settings ?? null;

const applyDesktopUiPreferences = (settings: DesktopSettings) => {
  const store = useUIStore.getState();
  const queueStore = useMessageQueueStore.getState();

  if (typeof settings.showReasoningTraces === 'boolean' && settings.showReasoningTraces !== store.showReasoningTraces) {
    store.setShowReasoningTraces(settings.showReasoningTraces);
  }
  if (typeof settings.autoDeleteEnabled === 'boolean' && settings.autoDeleteEnabled !== store.autoDeleteEnabled) {
    store.setAutoDeleteEnabled(settings.autoDeleteEnabled);
  }
  if (typeof settings.autoDeleteAfterDays === 'number' && Number.isFinite(settings.autoDeleteAfterDays)) {
    const normalized = Math.max(1, Math.min(365, settings.autoDeleteAfterDays));
    if (normalized !== store.autoDeleteAfterDays) {
      store.setAutoDeleteAfterDays(normalized);
    }
  }

  // Apply server-persisted message limit. Ignore stale legacy values.
  const STALE_LIMITS = new Set([90, 120, 180, 220]);
  if (typeof settings.messageLimit === 'number' && Number.isFinite(settings.messageLimit)) {
    if (!STALE_LIMITS.has(settings.messageLimit)) {
      store.setMessageLimit(settings.messageLimit);
    }
  }

  if (typeof settings.queueModeEnabled === 'boolean' && settings.queueModeEnabled !== queueStore.queueModeEnabled) {
    queueStore.setQueueMode(settings.queueModeEnabled);
  }

  if (typeof settings.showTextJustificationActivity === 'boolean' && settings.showTextJustificationActivity !== store.showTextJustificationActivity) {
    store.setShowTextJustificationActivity(settings.showTextJustificationActivity);
  }
  if (typeof settings.showDeletionDialog === 'boolean' && settings.showDeletionDialog !== store.showDeletionDialog) {
    store.setShowDeletionDialog(settings.showDeletionDialog);
  }
  if (typeof settings.nativeNotificationsEnabled === 'boolean' && settings.nativeNotificationsEnabled !== store.nativeNotificationsEnabled) {
    store.setNativeNotificationsEnabled(settings.nativeNotificationsEnabled);
  }
  if (typeof settings.notificationMode === 'string' && (settings.notificationMode === 'always' || settings.notificationMode === 'hidden-only')) {
    if (settings.notificationMode !== store.notificationMode) {
      store.setNotificationMode(settings.notificationMode);
    }
  }
  if (typeof settings.notifyOnSubtasks === 'boolean' && settings.notifyOnSubtasks !== store.notifyOnSubtasks) {
    store.setNotifyOnSubtasks(settings.notifyOnSubtasks);
  }
  if (typeof settings.notifyOnCompletion === 'boolean' && settings.notifyOnCompletion !== store.notifyOnCompletion) {
    store.setNotifyOnCompletion(settings.notifyOnCompletion);
  }
  if (typeof settings.notifyOnError === 'boolean' && settings.notifyOnError !== store.notifyOnError) {
    store.setNotifyOnError(settings.notifyOnError);
  }
  if (typeof settings.notifyOnQuestion === 'boolean' && settings.notifyOnQuestion !== store.notifyOnQuestion) {
    store.setNotifyOnQuestion(settings.notifyOnQuestion);
  }
  if (settings.notificationTemplates && typeof settings.notificationTemplates === 'object') {
    store.setNotificationTemplates(settings.notificationTemplates);
  }
  if (typeof settings.summarizeLastMessage === 'boolean' && settings.summarizeLastMessage !== store.summarizeLastMessage) {
    store.setSummarizeLastMessage(settings.summarizeLastMessage);
  }
  if (typeof settings.summaryThreshold === 'number' && Number.isFinite(settings.summaryThreshold)) {
    store.setSummaryThreshold(settings.summaryThreshold);
  }
  if (typeof settings.summaryLength === 'number' && Number.isFinite(settings.summaryLength)) {
    store.setSummaryLength(settings.summaryLength);
  }
  if (typeof settings.maxLastMessageLength === 'number' && Number.isFinite(settings.maxLastMessageLength)) {
    store.setMaxLastMessageLength(settings.maxLastMessageLength);
  }
  if (typeof settings.toolCallExpansion === 'string'
    && (settings.toolCallExpansion === 'collapsed' || settings.toolCallExpansion === 'activity' || settings.toolCallExpansion === 'detailed')) {
    if (settings.toolCallExpansion !== store.toolCallExpansion) {
      store.setToolCallExpansion(settings.toolCallExpansion);
    }
  }
  if (typeof settings.fontSize === 'number' && Number.isFinite(settings.fontSize) && settings.fontSize !== store.fontSize) {
    store.setFontSize(settings.fontSize);
  }
  if (typeof settings.terminalFontSize === 'number' && Number.isFinite(settings.terminalFontSize) && settings.terminalFontSize !== store.terminalFontSize) {
    store.setTerminalFontSize(settings.terminalFontSize);
  }
  if (typeof settings.padding === 'number' && Number.isFinite(settings.padding) && settings.padding !== store.padding) {
    store.setPadding(settings.padding);
  }
  if (typeof settings.cornerRadius === 'number' && Number.isFinite(settings.cornerRadius) && settings.cornerRadius !== store.cornerRadius) {
    store.setCornerRadius(settings.cornerRadius);
  }
  if (typeof settings.inputBarOffset === 'number' && Number.isFinite(settings.inputBarOffset) && settings.inputBarOffset !== store.inputBarOffset) {
    store.setInputBarOffset(settings.inputBarOffset);
  }

  if (Array.isArray(settings.favoriteModels)) {
    const current = store.favoriteModels;
    const next = settings.favoriteModels;
    const same =
      current.length === next.length &&
      current.every((item, idx) => item.providerID === next[idx]?.providerID && item.modelID === next[idx]?.modelID);
    if (!same) {
      useUIStore.setState({ favoriteModels: next });
    }
  }

  if (Array.isArray(settings.recentModels)) {
    const current = store.recentModels;
    const next = settings.recentModels;
    const same =
      current.length === next.length &&
      current.every((item, idx) => item.providerID === next[idx]?.providerID && item.modelID === next[idx]?.modelID);
    if (!same) {
      useUIStore.setState({ recentModels: next });
    }
  }
  if (typeof settings.diffLayoutPreference === 'string'
    && (settings.diffLayoutPreference === 'dynamic' || settings.diffLayoutPreference === 'inline' || settings.diffLayoutPreference === 'side-by-side')) {
    if (settings.diffLayoutPreference !== store.diffLayoutPreference) {
      store.setDiffLayoutPreference(settings.diffLayoutPreference);
    }
  }
  if (typeof settings.diffViewMode === 'string'
    && (settings.diffViewMode === 'single' || settings.diffViewMode === 'stacked')) {
    if (settings.diffViewMode !== store.diffViewMode) {
      store.setDiffViewMode(settings.diffViewMode);
    }
  }
  if (typeof settings.directoryShowHidden === 'boolean') {
    setDirectoryShowHidden(settings.directoryShowHidden, { persist: false });
  }
  if (typeof settings.filesViewShowGitignored === 'boolean') {
    setFilesViewShowGitignored(settings.filesViewShowGitignored, { persist: false });
  }
};

const sanitizeWebSettings = (payload: unknown): DesktopSettings | null => {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const candidate = payload as Record<string, unknown>;
  const result: DesktopSettings = {};

  if (typeof candidate.themeId === 'string' && candidate.themeId.length > 0) {
    result.themeId = candidate.themeId;
  }
  if (candidate.useSystemTheme === true || candidate.useSystemTheme === false) {
    result.useSystemTheme = candidate.useSystemTheme;
  }
  if (typeof candidate.themeVariant === 'string' && (candidate.themeVariant === 'light' || candidate.themeVariant === 'dark')) {
    result.themeVariant = candidate.themeVariant;
  }
  if (typeof candidate.lightThemeId === 'string' && candidate.lightThemeId.length > 0) {
    result.lightThemeId = candidate.lightThemeId;
  }
  if (typeof candidate.darkThemeId === 'string' && candidate.darkThemeId.length > 0) {
    result.darkThemeId = candidate.darkThemeId;
  }
  if (typeof candidate.lastDirectory === 'string' && candidate.lastDirectory.length > 0) {
    result.lastDirectory = candidate.lastDirectory;
  }
  if (typeof candidate.homeDirectory === 'string' && candidate.homeDirectory.length > 0) {
    result.homeDirectory = candidate.homeDirectory;
  }

  if (typeof candidate.opencodeBinary === 'string') {
    const trimmed = candidate.opencodeBinary.trim();
    result.opencodeBinary = trimmed.length > 0 ? trimmed : undefined;
  }

  const projects = sanitizeProjects(candidate.projects);
  if (projects) {
    result.projects = projects;
  }
  if (typeof candidate.activeProjectId === 'string' && candidate.activeProjectId.length > 0) {
    result.activeProjectId = candidate.activeProjectId;
  }

  if (Array.isArray(candidate.approvedDirectories)) {
    result.approvedDirectories = candidate.approvedDirectories.filter(
      (entry): entry is string => typeof entry === 'string' && entry.length > 0
    );
  }
  if (Array.isArray(candidate.securityScopedBookmarks)) {
    result.securityScopedBookmarks = candidate.securityScopedBookmarks.filter(
      (entry): entry is string => typeof entry === 'string' && entry.length > 0
    );
  }
  if (Array.isArray(candidate.pinnedDirectories)) {
    result.pinnedDirectories = Array.from(
      new Set(
        candidate.pinnedDirectories.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
      )
    );
  }
  if (typeof candidate.showReasoningTraces === 'boolean') {
    result.showReasoningTraces = candidate.showReasoningTraces;
  }
  if (typeof candidate.autoDeleteEnabled === 'boolean') {
    result.autoDeleteEnabled = candidate.autoDeleteEnabled;
  }
  if (typeof candidate.autoDeleteAfterDays === 'number' && Number.isFinite(candidate.autoDeleteAfterDays)) {
    result.autoDeleteAfterDays = candidate.autoDeleteAfterDays;
  }
  if (typeof candidate.defaultModel === 'string' && candidate.defaultModel.length > 0) {
    result.defaultModel = candidate.defaultModel;
  }
  if (typeof candidate.defaultVariant === 'string' && candidate.defaultVariant.length > 0) {
    result.defaultVariant = candidate.defaultVariant;
  }
  if (typeof candidate.defaultAgent === 'string' && candidate.defaultAgent.length > 0) {
    result.defaultAgent = candidate.defaultAgent;
  }
  if (typeof candidate.autoCreateWorktree === 'boolean') {
    result.autoCreateWorktree = candidate.autoCreateWorktree;
  }
  if (typeof candidate.gitmojiEnabled === 'boolean') {
    result.gitmojiEnabled = candidate.gitmojiEnabled;
  }
  if (typeof candidate.queueModeEnabled === 'boolean') {
    result.queueModeEnabled = candidate.queueModeEnabled;
  }
  if (typeof candidate.showTextJustificationActivity === 'boolean') {
    result.showTextJustificationActivity = candidate.showTextJustificationActivity;
  }
  if (typeof candidate.showDeletionDialog === 'boolean') {
    result.showDeletionDialog = candidate.showDeletionDialog;
  }
  if (typeof candidate.nativeNotificationsEnabled === 'boolean') {
    result.nativeNotificationsEnabled = candidate.nativeNotificationsEnabled;
  }
  if (typeof candidate.notificationMode === 'string' && (candidate.notificationMode === 'always' || candidate.notificationMode === 'hidden-only')) {
    result.notificationMode = candidate.notificationMode;
  }
  if (typeof candidate.notifyOnSubtasks === 'boolean') {
    result.notifyOnSubtasks = candidate.notifyOnSubtasks;
  }
  if (typeof candidate.notifyOnCompletion === 'boolean') {
    result.notifyOnCompletion = candidate.notifyOnCompletion;
  }
  if (typeof candidate.notifyOnError === 'boolean') {
    result.notifyOnError = candidate.notifyOnError;
  }
  if (typeof candidate.notifyOnQuestion === 'boolean') {
    result.notifyOnQuestion = candidate.notifyOnQuestion;
  }
  if (candidate.notificationTemplates && typeof candidate.notificationTemplates === 'object') {
    const templates = candidate.notificationTemplates as Record<string, unknown>;
    const validateTemplate = (key: string): { title: string; message: string } | undefined => {
      const value = templates[key];
      if (!value || typeof value !== 'object') return undefined;
      const obj = value as Record<string, unknown>;
      const title = typeof obj.title === 'string' ? obj.title : '';
      const message = typeof obj.message === 'string' ? obj.message : '';
      return { title, message };
    };
    const completion = validateTemplate('completion');
    const error = validateTemplate('error');
    const question = validateTemplate('question');
    const subtask = validateTemplate('subtask');
    if (completion || error || question || subtask) {
      result.notificationTemplates = {
        completion: completion ?? { title: 'Task Complete', message: 'Your task has finished.' },
        error: error ?? { title: 'Error Occurred', message: 'An error occurred while processing your task.' },
        question: question ?? { title: 'Input Needed', message: 'Please provide input to continue.' },
        subtask: subtask ?? { title: 'Subtask Complete', message: 'A subtask has finished.' },
      };
    }
  }
  if (typeof candidate.summarizeLastMessage === 'boolean') {
    result.summarizeLastMessage = candidate.summarizeLastMessage;
  }
  if (typeof candidate.summaryThreshold === 'number' && Number.isFinite(candidate.summaryThreshold)) {
    result.summaryThreshold = Math.max(0, Math.round(candidate.summaryThreshold));
  }
  if (typeof candidate.summaryLength === 'number' && Number.isFinite(candidate.summaryLength)) {
    result.summaryLength = Math.max(10, Math.round(candidate.summaryLength));
  }
  if (typeof candidate.maxLastMessageLength === 'number' && Number.isFinite(candidate.maxLastMessageLength)) {
    result.maxLastMessageLength = Math.max(10, Math.round(candidate.maxLastMessageLength));
  }
  if (typeof candidate.usageAutoRefresh === 'boolean') {
    result.usageAutoRefresh = candidate.usageAutoRefresh;
  }
  if (typeof candidate.usageRefreshIntervalMs === 'number' && Number.isFinite(candidate.usageRefreshIntervalMs)) {
    result.usageRefreshIntervalMs = candidate.usageRefreshIntervalMs;
  }
  if (candidate.usageDisplayMode === 'usage' || candidate.usageDisplayMode === 'remaining') {
    result.usageDisplayMode = candidate.usageDisplayMode;
  }
  if (Array.isArray(candidate.usageDropdownProviders)) {
    result.usageDropdownProviders = candidate.usageDropdownProviders.filter(
      (entry): entry is string => typeof entry === 'string' && entry.length > 0
    );
  }

  // Parse usageSelectedModels (Record<string, string[]>)
  if (candidate.usageSelectedModels && typeof candidate.usageSelectedModels === 'object') {
    const selectedModels: Record<string, string[]> = {};
    for (const [providerId, models] of Object.entries(candidate.usageSelectedModels)) {
      if (Array.isArray(models)) {
        selectedModels[providerId] = models.filter((m): m is string => typeof m === 'string');
      }
    }
    if (Object.keys(selectedModels).length > 0) {
      result.usageSelectedModels = selectedModels;
    }
  }

  // Parse usageCollapsedFamilies (Record<string, string[]>)
  if (candidate.usageCollapsedFamilies && typeof candidate.usageCollapsedFamilies === 'object') {
    const collapsedFamilies: Record<string, string[]> = {};
    for (const [providerId, families] of Object.entries(candidate.usageCollapsedFamilies)) {
      if (Array.isArray(families)) {
        collapsedFamilies[providerId] = families.filter((f): f is string => typeof f === 'string');
      }
    }
    if (Object.keys(collapsedFamilies).length > 0) {
      result.usageCollapsedFamilies = collapsedFamilies;
    }
  }

  // Parse usageExpandedFamilies (Record<string, string[]>) - inverted collapsed logic for header dropdown
  if (candidate.usageExpandedFamilies && typeof candidate.usageExpandedFamilies === 'object') {
    const expandedFamilies: Record<string, string[]> = {};
    for (const [providerId, families] of Object.entries(candidate.usageExpandedFamilies)) {
      if (Array.isArray(families)) {
        expandedFamilies[providerId] = families.filter((f): f is string => typeof f === 'string');
      }
    }
    if (Object.keys(expandedFamilies).length > 0) {
      result.usageExpandedFamilies = expandedFamilies;
    }
  }

  // Parse usageModelGroups - custom model groups configuration per provider
  if (candidate.usageModelGroups && typeof candidate.usageModelGroups === 'object') {
    const modelGroups: Record<string, {
      customGroups?: Array<{id: string; label: string; models: string[]; order: number}>;
      modelAssignments?: Record<string, string>;
      renamedGroups?: Record<string, string>;
    }> = {};
    for (const [providerId, config] of Object.entries(candidate.usageModelGroups)) {
      if (config && typeof config === 'object') {
        const typedConfig = config as Record<string, unknown>;
        const providerConfig: {
          customGroups?: Array<{id: string; label: string; models: string[]; order: number}>;
          modelAssignments?: Record<string, string>;
          renamedGroups?: Record<string, string>;
        } = {};

        // Parse customGroups
        if (Array.isArray(typedConfig.customGroups)) {
          providerConfig.customGroups = typedConfig.customGroups
            .filter((g): g is Record<string, unknown> => g && typeof g === 'object')
            .map((g) => ({
              id: String(g.id ?? ''),
              label: String(g.label ?? ''),
              models: Array.isArray(g.models)
                ? g.models.filter((m): m is string => typeof m === 'string')
                : [],
              order: typeof g.order === 'number' ? g.order : 0,
            }));
        }

        // Parse modelAssignments
        if (typedConfig.modelAssignments && typeof typedConfig.modelAssignments === 'object') {
          providerConfig.modelAssignments = Object.fromEntries(
            Object.entries(typedConfig.modelAssignments as Record<string, unknown>)
              .filter(([, v]) => typeof v === 'string')
              .map(([k, v]) => [k, String(v)])
          );
        }

        // Parse renamedGroups
        if (typedConfig.renamedGroups && typeof typedConfig.renamedGroups === 'object') {
          providerConfig.renamedGroups = Object.fromEntries(
            Object.entries(typedConfig.renamedGroups as Record<string, unknown>)
              .filter(([, v]) => typeof v === 'string')
              .map(([k, v]) => [k, String(v)])
          );
        }

        if (Object.keys(providerConfig).length > 0) {
          modelGroups[providerId] = providerConfig;
        }
      }
    }
    if (Object.keys(modelGroups).length > 0) {
      result.usageModelGroups = modelGroups;
    }
  }

  if (
    typeof candidate.toolCallExpansion === 'string'
    && (candidate.toolCallExpansion === 'collapsed'
      || candidate.toolCallExpansion === 'activity'
      || candidate.toolCallExpansion === 'detailed')
  ) {
    result.toolCallExpansion = candidate.toolCallExpansion;
  }
  if (typeof candidate.fontSize === 'number' && Number.isFinite(candidate.fontSize)) {
    result.fontSize = candidate.fontSize;
  }
  if (typeof candidate.terminalFontSize === 'number' && Number.isFinite(candidate.terminalFontSize)) {
    result.terminalFontSize = candidate.terminalFontSize;
  }
  if (typeof candidate.padding === 'number' && Number.isFinite(candidate.padding)) {
    result.padding = candidate.padding;
  }
  if (typeof candidate.cornerRadius === 'number' && Number.isFinite(candidate.cornerRadius)) {
    result.cornerRadius = candidate.cornerRadius;
  }
  if (typeof candidate.inputBarOffset === 'number' && Number.isFinite(candidate.inputBarOffset)) {
    result.inputBarOffset = candidate.inputBarOffset;
  }

  const favoriteModels = sanitizeModelRefs(candidate.favoriteModels, 64);
  if (favoriteModels) {
    result.favoriteModels = favoriteModels;
  }

  const recentModels = sanitizeModelRefs(candidate.recentModels, 16);
  if (recentModels) {
    result.recentModels = recentModels;
  }
  if (
    typeof candidate.diffLayoutPreference === 'string'
    && (candidate.diffLayoutPreference === 'dynamic'
      || candidate.diffLayoutPreference === 'inline'
      || candidate.diffLayoutPreference === 'side-by-side')
  ) {
    result.diffLayoutPreference = candidate.diffLayoutPreference;
  }
  if (
    typeof candidate.diffViewMode === 'string'
    && (candidate.diffViewMode === 'single' || candidate.diffViewMode === 'stacked')
  ) {
    result.diffViewMode = candidate.diffViewMode;
  }
  if (typeof candidate.directoryShowHidden === 'boolean') {
    result.directoryShowHidden = candidate.directoryShowHidden;
  }
  if (typeof candidate.filesViewShowGitignored === 'boolean') {
    result.filesViewShowGitignored = candidate.filesViewShowGitignored;
  }
  if (typeof candidate.openInAppId === 'string' && candidate.openInAppId.length > 0) {
    result.openInAppId = candidate.openInAppId;
  }

  if (typeof candidate.messageLimit === 'number' && Number.isFinite(candidate.messageLimit)) {
    result.messageLimit = candidate.messageLimit;
  }

  const skillCatalogs = sanitizeSkillCatalogs(candidate.skillCatalogs);
  if (skillCatalogs) {
    result.skillCatalogs = skillCatalogs;
  }

  return result;
};

const fetchWebSettings = async (): Promise<DesktopSettings | null> => {
  const runtimeSettings = getRuntimeSettingsAPI();
  if (runtimeSettings) {
    try {
      const result = await runtimeSettings.load();
      return sanitizeWebSettings(result.settings);
    } catch (error) {
      console.warn('Failed to load shared settings from runtime settings API:', error);

    }
  }

  try {
    const response = await fetch('/api/config/settings', {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      return null;
    }
    const data = await response.json().catch(() => null);
    return sanitizeWebSettings(data);
  } catch (error) {
    console.warn('Failed to load shared settings from server:', error);
    return null;
  }
};

export const syncDesktopSettings = async (): Promise<void> => {
  if (typeof window === 'undefined') {
    return;
  }

  const persistApi = getPersistApi();

  const applySettings = (settings: DesktopSettings) => {
    persistToLocalStorage(settings);
    const apply = () => applyDesktopUiPreferences(settings);

    if (persistApi?.hasHydrated?.()) {
      apply();
    } else {
      apply();
      if (persistApi?.onFinishHydration) {
        const unsubscribe = persistApi.onFinishHydration(() => {
          unsubscribe?.();
          apply();
        });
      }
    }

    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent<DesktopSettings>('openchamber:settings-synced', { detail: settings }));
    }
  };

  try {
    const webSettings = await fetchWebSettings();
    if (webSettings) {
      applySettings(webSettings);
    }
  } catch (error) {
    console.warn('Failed to synchronise settings:', error);
  }
};

export const updateDesktopSettings = async (changes: Partial<DesktopSettings>): Promise<void> => {
  if (typeof window === 'undefined') {
    return;
  }

  // Desktop shell uses the same HTTP settings API as web.

  const runtimeSettings = getRuntimeSettingsAPI();
  if (runtimeSettings) {
    try {
      const updated = await runtimeSettings.save(changes);
      if (updated) {
        persistToLocalStorage(updated);
        applyDesktopUiPreferences(updated);
      }
      return;
    } catch (error) {
      console.warn('Failed to update settings via runtime settings API:', error);
    }
  }

  try {
    const response = await fetch('/api/config/settings', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(changes),
    });

    if (!response.ok) {
      console.warn('Failed to update shared settings via API:', response.status, response.statusText);
      return;
    }

    const updated = (await response.json().catch(() => null)) as DesktopSettings | null;
    if (updated) {
      persistToLocalStorage(updated);
      applyDesktopUiPreferences(updated);
    }
  } catch (error) {
    console.warn('Failed to update shared settings via API:', error);
  }
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
