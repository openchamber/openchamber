export const createSettingsHelpers = (dependencies) => {
  const {
    normalizePathForPersistence,
    normalizeDirectoryPath,
    normalizeTunnelBootstrapTtlMs,
    normalizeTunnelSessionTtlMs,
    normalizeTunnelProvider,
    normalizeTunnelMode,
    normalizeOptionalPath,
    normalizeManagedRemoteTunnelHostname,
    normalizeManagedRemoteTunnelPresets,
    normalizeManagedRemoteTunnelPresetTokens,
    sanitizeTypographySizesPartial,
    normalizeStringArray,
    sanitizeModelRefs,
    sanitizeSkillCatalogs,
    sanitizeProjects,
  } = dependencies;

  const PWA_APP_NAME_MAX_LENGTH = 64;
  const STT_SERVER_URL_MAX_LENGTH = 2048;
  const STT_MODEL_MAX_LENGTH = 256;
  const STT_LANGUAGE_MAX_LENGTH = 64;
  const VERSION_STRING_MAX_LENGTH = 128;
  const SHORTCUT_OVERRIDE_KEY_MAX_LENGTH = 128;
  const SHORTCUT_OVERRIDE_VALUE_MAX_LENGTH = 128;
  const PWA_ORIENTATION_VALUES = new Set(['system', 'portrait', 'landscape']);
  const MOBILE_KEYBOARD_MODE_VALUES = new Set(['native', 'resize-content']);
  const HIDDEN_MODELS_MAX = 1024;
  const RECENT_EFFORTS_MAX_KEYS = 128;
  const RECENT_EFFORTS_MAX_VARIANTS_PER_KEY = 5;

  const sanitizeShortcutOverrides = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    const result = {};
    for (const [rawKey, rawValue] of Object.entries(value)) {
      const key = typeof rawKey === 'string' ? rawKey.trim() : '';
      const combo = typeof rawValue === 'string' ? rawValue.trim() : '';
      if (!key || !combo) continue;
      result[key.slice(0, SHORTCUT_OVERRIDE_KEY_MAX_LENGTH)] = combo.slice(0, SHORTCUT_OVERRIDE_VALUE_MAX_LENGTH);
    }
    return result;
  };

  const sanitizeRecentEfforts = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    const result = {};
    const seenKeys = new Set();
    let count = 0;
    for (const [rawKey, rawVariants] of Object.entries(value)) {
      const key = typeof rawKey === 'string' ? rawKey.trim() : '';
      if (!key || seenKeys.has(key)) continue;
      if (!Array.isArray(rawVariants)) continue;
      const variants = [];
      const seenVariants = new Set();
      for (const rawVariant of rawVariants) {
        const variant = typeof rawVariant === 'string' ? rawVariant.trim() : '';
        if (!variant || seenVariants.has(variant)) continue;
        seenVariants.add(variant);
        variants.push(variant);
        if (variants.length >= RECENT_EFFORTS_MAX_VARIANTS_PER_KEY) break;
      }
      if (variants.length === 0) continue;
      seenKeys.add(key);
      result[key] = variants;
      count += 1;
      if (count >= RECENT_EFFORTS_MAX_KEYS) break;
    }
    return count > 0 ? result : null;
  };

  const normalizePwaAppName = (value, fallback = '') => {
    if (typeof value !== 'string') {
      return fallback;
    }
    const normalized = value.trim().replace(/\s+/g, ' ');
    if (!normalized) {
      return fallback;
    }
    return normalized.slice(0, PWA_APP_NAME_MAX_LENGTH);
  };

  const normalizePwaOrientation = (value, fallback = 'system') => {
    if (typeof value !== 'string') {
      return fallback;
    }
    const normalized = value.trim();
    if (PWA_ORIENTATION_VALUES.has(normalized)) {
      return normalized;
    }
    return fallback;
  };

  const normalizeMobileKeyboardMode = (value, fallback = 'native') => {
    if (typeof value !== 'string') {
      return fallback;
    }
    const normalized = value.trim();
    if (MOBILE_KEYBOARD_MODE_VALUES.has(normalized)) {
      return normalized;
    }
    return fallback;
  };

  const normalizeFollowUpBehavior = (value, legacyQueueModeEnabled = null) => {
    // "immediate" was removed (it was wire-identical to "steer"); collapse it.
    if (value === 'immediate') {
      return 'steer';
    }
    if (value === 'steer' || value === 'queue') {
      return value;
    }
    if (legacyQueueModeEnabled === false) {
      return 'steer';
    }
    return 'queue';
  };

  const sanitizeSettingsUpdate = (payload) => {
    if (!payload || typeof payload !== 'object') {
      return {};
    }

    const candidate = payload;
    const result = {};

    if (typeof candidate.themeId === 'string' && candidate.themeId.length > 0) {
      result.themeId = candidate.themeId;
    }
    if (typeof candidate.themeVariant === 'string' && (candidate.themeVariant === 'light' || candidate.themeVariant === 'dark')) {
      result.themeVariant = candidate.themeVariant;
    }
    if (typeof candidate.useSystemTheme === 'boolean') {
      result.useSystemTheme = candidate.useSystemTheme;
    }
    if (typeof candidate.lightThemeId === 'string' && candidate.lightThemeId.length > 0) {
      result.lightThemeId = candidate.lightThemeId;
    }
    if (typeof candidate.darkThemeId === 'string' && candidate.darkThemeId.length > 0) {
      result.darkThemeId = candidate.darkThemeId;
    }
    if (typeof candidate.splashBgLight === 'string' && candidate.splashBgLight.trim().length > 0) {
      result.splashBgLight = candidate.splashBgLight.trim();
    }
    if (typeof candidate.splashFgLight === 'string' && candidate.splashFgLight.trim().length > 0) {
      result.splashFgLight = candidate.splashFgLight.trim();
    }
    if (typeof candidate.splashBgDark === 'string' && candidate.splashBgDark.trim().length > 0) {
      result.splashBgDark = candidate.splashBgDark.trim();
    }
    if (typeof candidate.splashFgDark === 'string' && candidate.splashFgDark.trim().length > 0) {
      result.splashFgDark = candidate.splashFgDark.trim();
    }
    if (typeof candidate.lastDirectory === 'string' && candidate.lastDirectory.length > 0) {
      const normalized = normalizePathForPersistence(candidate.lastDirectory);
      if (typeof normalized === 'string' && normalized.length > 0) {
        result.lastDirectory = normalized;
      }
    }
    if (typeof candidate.homeDirectory === 'string' && candidate.homeDirectory.length > 0) {
      const normalized = normalizePathForPersistence(candidate.homeDirectory);
      if (typeof normalized === 'string' && normalized.length > 0) {
        result.homeDirectory = normalized;
      }
    }

    // Absolute path to the opencode CLI binary (optional override).
    // Accept empty-string to clear (we persist an empty string sentinel so the running
    // process can reliably drop a previously applied OPENCODE_BINARY override).
    if (typeof candidate.opencodeBinary === 'string') {
      const normalized = normalizeDirectoryPath(candidate.opencodeBinary).trim();
      result.opencodeBinary = normalized;
    }
    if (typeof candidate.desktopLanAccessEnabled === 'boolean') {
      result.desktopLanAccessEnabled = candidate.desktopLanAccessEnabled;
    }
    if (typeof candidate.desktopKeepAwakeEnabled === 'boolean') {
      result.desktopKeepAwakeEnabled = candidate.desktopKeepAwakeEnabled;
    }
    if (typeof candidate.desktopMinimizeToTrayEnabled === 'boolean') {
      result.desktopMinimizeToTrayEnabled = candidate.desktopMinimizeToTrayEnabled;
    }
    if (typeof candidate.desktopUiPassword === 'string') {
      result.desktopUiPassword = candidate.desktopUiPassword.trim();
    }
    if (Array.isArray(candidate.projects)) {
      const projects = sanitizeProjects(candidate.projects);
      if (projects) {
        result.projects = projects;
      }
    }
    if (typeof candidate.activeProjectId === 'string' && candidate.activeProjectId.length > 0) {
      result.activeProjectId = candidate.activeProjectId;
    }

    if (Array.isArray(candidate.securityScopedBookmarks)) {
      result.securityScopedBookmarks = normalizeStringArray(candidate.securityScopedBookmarks);
    }
    if (Array.isArray(candidate.pinnedDirectories)) {
      result.pinnedDirectories = normalizeStringArray(
        candidate.pinnedDirectories
          .map((entry) => (typeof entry === 'string' ? normalizePathForPersistence(entry) : entry))
          .filter((entry) => typeof entry === 'string' && entry.length > 0)
      );
    }
    if (Array.isArray(candidate.draftStarters)) {
      const seenStarters = new Set();
      const starters = [];
      for (const entry of candidate.draftStarters) {
        if (!entry || typeof entry !== 'object') continue;
        const type = entry.type === 'command' || entry.type === 'skill' ? entry.type : null;
        const name = typeof entry.name === 'string' ? entry.name.trim() : '';
        if (!type || !name) continue;
        const key = `${type}:${name}`;
        if (seenStarters.has(key)) continue;
        seenStarters.add(key);
        starters.push({ type, name });
      }
      result.draftStarters = starters;
    }


    if (typeof candidate.uiFont === 'string' && candidate.uiFont.length > 0) {
      result.uiFont = candidate.uiFont;
    }
    if (typeof candidate.monoFont === 'string' && candidate.monoFont.length > 0) {
      result.monoFont = candidate.monoFont;
    }
    if (typeof candidate.markdownDisplayMode === 'string' && candidate.markdownDisplayMode.length > 0) {
      result.markdownDisplayMode = candidate.markdownDisplayMode;
    }
    if (typeof candidate.githubClientId === 'string') {
      const trimmed = candidate.githubClientId.trim();
      if (trimmed.length > 0) {
        result.githubClientId = trimmed;
      }
    }
    if (typeof candidate.githubScopes === 'string') {
      const trimmed = candidate.githubScopes.trim();
      if (trimmed.length > 0) {
        result.githubScopes = trimmed;
      }
    }
    if (typeof candidate.showReasoningTraces === 'boolean') {
      result.showReasoningTraces = candidate.showReasoningTraces;
    }
    if (typeof candidate.sessionRecapEnabled === 'boolean') {
      result.sessionRecapEnabled = candidate.sessionRecapEnabled;
    }
    if (typeof candidate.sessionSuggestionEnabled === 'boolean') {
      result.sessionSuggestionEnabled = candidate.sessionSuggestionEnabled;
    }
    if (typeof candidate.sessionGoalEnabled === 'boolean') {
      result.sessionGoalEnabled = candidate.sessionGoalEnabled;
    }
    if (typeof candidate.sessionGoalDefaultBudgetEnabled === 'boolean') {
      result.sessionGoalDefaultBudgetEnabled = candidate.sessionGoalDefaultBudgetEnabled;
    }
    if (typeof candidate.sessionGoalDefaultBudget === 'number' && Number.isFinite(candidate.sessionGoalDefaultBudget) && candidate.sessionGoalDefaultBudget > 0) {
      result.sessionGoalDefaultBudget = Math.floor(candidate.sessionGoalDefaultBudget);
    }
    if (typeof candidate.collapsibleThinkingBlocks === 'boolean') {
      result.collapsibleThinkingBlocks = candidate.collapsibleThinkingBlocks;
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
    if (typeof candidate.notificationMode === 'string') {
      const mode = candidate.notificationMode.trim();
      if (mode === 'always' || mode === 'hidden-only') {
        result.notificationMode = mode;
      }
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
      result.notificationTemplates = candidate.notificationTemplates;
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
      result.usageRefreshIntervalMs = Math.max(30000, Math.min(300000, Math.round(candidate.usageRefreshIntervalMs)));
    }
    if (candidate.usageDisplayMode === 'usage' || candidate.usageDisplayMode === 'remaining') {
      result.usageDisplayMode = candidate.usageDisplayMode;
    }
    if (typeof candidate.usageShowPredValues === 'boolean') {
      result.usageShowPredValues = candidate.usageShowPredValues;
    }
    if (Array.isArray(candidate.usageDropdownProviders)) {
      result.usageDropdownProviders = normalizeStringArray(candidate.usageDropdownProviders);
    }
    if (typeof candidate.autoDeleteEnabled === 'boolean') {
      result.autoDeleteEnabled = candidate.autoDeleteEnabled;
    }
    if (typeof candidate.autoDeleteAfterDays === 'number' && Number.isFinite(candidate.autoDeleteAfterDays)) {
      const normalizedDays = Math.max(1, Math.min(365, Math.round(candidate.autoDeleteAfterDays)));
      result.autoDeleteAfterDays = normalizedDays;
    }
    if (candidate.tunnelBootstrapTtlMs === null) {
      result.tunnelBootstrapTtlMs = null;
    } else if (typeof candidate.tunnelBootstrapTtlMs === 'number' && Number.isFinite(candidate.tunnelBootstrapTtlMs)) {
      result.tunnelBootstrapTtlMs = normalizeTunnelBootstrapTtlMs(candidate.tunnelBootstrapTtlMs);
    }
    if (typeof candidate.tunnelSessionTtlMs === 'number' && Number.isFinite(candidate.tunnelSessionTtlMs)) {
      result.tunnelSessionTtlMs = normalizeTunnelSessionTtlMs(candidate.tunnelSessionTtlMs);
    }
    if (typeof candidate.tunnelProvider === 'string') {
      const provider = normalizeTunnelProvider(candidate.tunnelProvider);
      if (provider) {
        result.tunnelProvider = provider;
      }
    }
    if (typeof candidate.tunnelMode === 'string') {
      result.tunnelMode = normalizeTunnelMode(candidate.tunnelMode);
    }
    if (candidate.managedLocalTunnelConfigPath === null) {
      result.managedLocalTunnelConfigPath = null;
    } else if (typeof candidate.managedLocalTunnelConfigPath === 'string') {
      const trimmed = candidate.managedLocalTunnelConfigPath.trim();
      result.managedLocalTunnelConfigPath = trimmed.length > 0 ? normalizeOptionalPath(trimmed) : null;
    }
    if (typeof candidate.managedRemoteTunnelHostname === 'string') {
      const hostname = normalizeManagedRemoteTunnelHostname(candidate.managedRemoteTunnelHostname);
      result.managedRemoteTunnelHostname = hostname;
    }
    if (candidate.managedRemoteTunnelToken === null) {
      result.managedRemoteTunnelToken = null;
    } else if (typeof candidate.managedRemoteTunnelToken === 'string') {
      result.managedRemoteTunnelToken = candidate.managedRemoteTunnelToken.trim();
    }
    const managedRemoteTunnelPresets = normalizeManagedRemoteTunnelPresets(candidate.managedRemoteTunnelPresets);
    if (managedRemoteTunnelPresets) {
      result.managedRemoteTunnelPresets = managedRemoteTunnelPresets;
    }
    const managedRemoteTunnelPresetTokens = normalizeManagedRemoteTunnelPresetTokens(candidate.managedRemoteTunnelPresetTokens);
    if (managedRemoteTunnelPresetTokens) {
      result.managedRemoteTunnelPresetTokens = managedRemoteTunnelPresetTokens;
    }
    if (typeof candidate.managedRemoteTunnelSelectedPresetId === 'string') {
      const id = candidate.managedRemoteTunnelSelectedPresetId.trim();
      result.managedRemoteTunnelSelectedPresetId = id || undefined;
    }

    const typography = sanitizeTypographySizesPartial(candidate.typographySizes);
    if (typography) {
      result.typographySizes = typography;
    }

    if (typeof candidate.defaultModel === 'string') {
      const trimmed = candidate.defaultModel.trim();
      result.defaultModel = trimmed.length > 0 ? trimmed : undefined;
    }
    if (typeof candidate.defaultVariant === 'string') {
      const trimmed = candidate.defaultVariant.trim();
      result.defaultVariant = trimmed.length > 0 ? trimmed : undefined;
    }
    if (typeof candidate.defaultAgent === 'string') {
      const trimmed = candidate.defaultAgent.trim();
      result.defaultAgent = trimmed.length > 0 ? trimmed : undefined;
    }
    if (typeof candidate.smallModelUseDefault === 'boolean') {
      result.smallModelUseDefault = candidate.smallModelUseDefault;
    }
    if (typeof candidate.smallModelOverride === 'string') {
      const trimmed = candidate.smallModelOverride.trim();
      result.smallModelOverride = trimmed.length > 0 ? trimmed : undefined;
    }
    if (typeof candidate.defaultGitIdentityId === 'string') {
      const trimmed = candidate.defaultGitIdentityId.trim();
      result.defaultGitIdentityId = trimmed.length > 0 ? trimmed : undefined;
    }
    if (typeof candidate.followUpBehavior === 'string') {
      result.followUpBehavior = normalizeFollowUpBehavior(candidate.followUpBehavior);
    } else if (typeof candidate.queueModeEnabled === 'boolean') {
      result.followUpBehavior = normalizeFollowUpBehavior(undefined, candidate.queueModeEnabled);
    }
    if (typeof candidate.autoCreateWorktree === 'boolean') {
      result.autoCreateWorktree = candidate.autoCreateWorktree;
    }
    if (typeof candidate.gitmojiEnabled === 'boolean') {
      result.gitmojiEnabled = candidate.gitmojiEnabled;
    }
    if (typeof candidate.defaultFileViewerPreview === 'boolean') {
      result.defaultFileViewerPreview = candidate.defaultFileViewerPreview;
    }
    if (typeof candidate.zenModel === 'string') {
      const trimmed = candidate.zenModel.trim();
      result.zenModel = trimmed.length > 0 ? trimmed : undefined;
    }
    if (typeof candidate.gitProviderId === 'string') {
      const trimmed = candidate.gitProviderId.trim();
      result.gitProviderId = trimmed.length > 0 ? trimmed : undefined;
    }
    if (typeof candidate.gitModelId === 'string') {
      const trimmed = candidate.gitModelId.trim();
      result.gitModelId = trimmed.length > 0 ? trimmed : undefined;
    }
    if (typeof candidate.pwaAppName === 'string') {
      result.pwaAppName = normalizePwaAppName(candidate.pwaAppName, undefined);
    }
    if (typeof candidate.pwaOrientation === 'string') {
      result.pwaOrientation = normalizePwaOrientation(candidate.pwaOrientation, undefined);
    }
    if (typeof candidate.mobileKeyboardMode === 'string') {
      const mode = normalizeMobileKeyboardMode(candidate.mobileKeyboardMode, null);
      if (mode) {
        result.mobileKeyboardMode = mode;
      }
    }
    if (typeof candidate.toolCallExpansion === 'string') {
      const mode = candidate.toolCallExpansion.trim();
      if (mode === 'collapsed' || mode === 'activity' || mode === 'detailed' || mode === 'changes') {
        result.toolCallExpansion = mode;
      }
    }
    if (typeof candidate.inputSpellcheckEnabled === 'boolean') {
      result.inputSpellcheckEnabled = candidate.inputSpellcheckEnabled;
    }
    if (typeof candidate.showOpenCodeUpdateNotifications === 'boolean') {
      result.showOpenCodeUpdateNotifications = candidate.showOpenCodeUpdateNotifications;
    }
    if (typeof candidate.openCodeUpdateToastDismissedVersion === 'string') {
      const version = candidate.openCodeUpdateToastDismissedVersion.trim();
      result.openCodeUpdateToastDismissedVersion = version.slice(0, VERSION_STRING_MAX_LENGTH);
    }
    if (typeof candidate.showToolFileIcons === 'boolean') {
      result.showToolFileIcons = candidate.showToolFileIcons;
    }
    if (typeof candidate.showTurnChangedFiles === 'boolean') {
      result.showTurnChangedFiles = candidate.showTurnChangedFiles;
    }
    if (typeof candidate.showExpandedBashTools === 'boolean') {
      result.showExpandedBashTools = candidate.showExpandedBashTools;
    }
    if (typeof candidate.showExpandedEditTools === 'boolean') {
      result.showExpandedEditTools = candidate.showExpandedEditTools;
    }
    if (typeof candidate.timeFormatPreference === 'string') {
      const mode = candidate.timeFormatPreference.trim();
      if (mode === 'auto' || mode === '12h' || mode === '24h') {
        result.timeFormatPreference = mode;
      }
    }
    if (typeof candidate.weekStartPreference === 'string') {
      const mode = candidate.weekStartPreference.trim();
      if (mode === 'auto' || mode === 'sunday' || mode === 'monday') {
        result.weekStartPreference = mode;
      }
    }
    if (typeof candidate.chatRenderMode === 'string') {
      const mode = candidate.chatRenderMode.trim();
      if (mode === 'sorted' || mode === 'live') {
        result.chatRenderMode = mode;
      }
    }
    if (typeof candidate.messageStreamTransport === 'string') {
      const mode = candidate.messageStreamTransport.trim();
      if (mode === 'auto' || mode === 'ws' || mode === 'sse') {
        result.messageStreamTransport = mode;
      }
    }
    if (typeof candidate.activityRenderMode === 'string') {
      const mode = candidate.activityRenderMode.trim();
      if (mode === 'collapsed' || mode === 'summary') {
        result.activityRenderMode = mode;
      }
    }
    if (typeof candidate.mermaidRenderingMode === 'string') {
      const mode = candidate.mermaidRenderingMode.trim();
      if (mode === 'svg' || mode === 'ascii') {
        result.mermaidRenderingMode = mode;
      }
    }
    if (typeof candidate.userMessageRenderingMode === 'string') {
      const mode = candidate.userMessageRenderingMode.trim();
      if (mode === 'markdown' || mode === 'plain') {
        result.userMessageRenderingMode = mode;
      }
    }
    if (typeof candidate.chatMessageWidthMode === 'string') {
      const mode = candidate.chatMessageWidthMode.trim();
      if (mode === 'narrow' || mode === 'wide' || mode === 'fluid') {
        result.chatMessageWidthMode = mode;
      }
    }
    if (!result.chatMessageWidthMode && typeof candidate.wideChatLayoutEnabled === 'boolean') {
      result.chatMessageWidthMode = candidate.wideChatLayoutEnabled ? 'wide' : 'narrow';
    }
    if (typeof candidate.stickyUserHeader === 'boolean') {
      result.stickyUserHeader = candidate.stickyUserHeader;
    }
    if (typeof candidate.expandedEditorToolbar === 'boolean') {
      result.expandedEditorToolbar = candidate.expandedEditorToolbar;
    }
    if (typeof candidate.showSplitAssistantMessageActions === 'boolean') {
      result.showSplitAssistantMessageActions = candidate.showSplitAssistantMessageActions;
    }
    if (typeof candidate.fontSize === 'number' && Number.isFinite(candidate.fontSize)) {
      result.fontSize = Math.max(50, Math.min(200, Math.round(candidate.fontSize)));
    }
    if (typeof candidate.terminalFontSize === 'number' && Number.isFinite(candidate.terminalFontSize)) {
      result.terminalFontSize = Math.max(9, Math.min(52, Math.round(candidate.terminalFontSize)));
    }
    if (typeof candidate.padding === 'number' && Number.isFinite(candidate.padding)) {
      result.padding = Math.max(50, Math.min(200, Math.round(candidate.padding)));
    }
    if (typeof candidate.cornerRadius === 'number' && Number.isFinite(candidate.cornerRadius)) {
      result.cornerRadius = Math.max(0, Math.min(32, Math.round(candidate.cornerRadius)));
    }
    if (typeof candidate.inputBarOffset === 'number' && Number.isFinite(candidate.inputBarOffset)) {
      result.inputBarOffset = Math.max(0, Math.min(100, Math.round(candidate.inputBarOffset)));
    }

    const shortcutOverrides = sanitizeShortcutOverrides(candidate.shortcutOverrides);
    if (shortcutOverrides) {
      result.shortcutOverrides = shortcutOverrides;
    }

    const favoriteModels = sanitizeModelRefs(candidate.favoriteModels, 64);
    if (favoriteModels) {
      result.favoriteModels = favoriteModels;
    }

    const recentModels = sanitizeModelRefs(candidate.recentModels, 16);
    if (recentModels) {
      result.recentModels = recentModels;
    }

    // Cap at 1024: users with several providers (anthropic, openai, google,
    // bedrock, azure, etc.) each exposing dozens-to-hundreds of models can
    // exceed 256 hidden entries quickly. 1024 covers dense multi-provider
    // setups while still bounding persistence/memory.
    const hiddenModels = sanitizeModelRefs(candidate.hiddenModels, HIDDEN_MODELS_MAX);
    if (hiddenModels) {
      result.hiddenModels = hiddenModels;
    }

    if (Array.isArray(candidate.collapsedModelProviders)) {
      result.collapsedModelProviders = normalizeStringArray(candidate.collapsedModelProviders);
    }

    if (Array.isArray(candidate.recentAgents)) {
      result.recentAgents = normalizeStringArray(candidate.recentAgents);
    }

    const recentEfforts = sanitizeRecentEfforts(candidate.recentEfforts);
    if (recentEfforts) {
      result.recentEfforts = recentEfforts;
    }
    if (typeof candidate.diffLayoutPreference === 'string') {
      const mode = candidate.diffLayoutPreference.trim();
      if (mode === 'dynamic' || mode === 'inline' || mode === 'side-by-side') {
        result.diffLayoutPreference = mode;
      }
    }
    if (typeof candidate.gitChangesViewMode === 'string') {
      const mode = candidate.gitChangesViewMode.trim();
      if (mode === 'flat' || mode === 'tree') {
        result.gitChangesViewMode = mode;
      }
    }
    if (typeof candidate.directoryShowHidden === 'boolean') {
      result.directoryShowHidden = candidate.directoryShowHidden;
    }
    if (typeof candidate.filesViewShowGitignored === 'boolean') {
      result.filesViewShowGitignored = candidate.filesViewShowGitignored;
    }
    if (typeof candidate.openInAppId === 'string') {
      const trimmed = candidate.openInAppId.trim();
      if (trimmed.length > 0) {
        result.openInAppId = trimmed;
      }
    }

    // Message limit — single setting for fetch / trim / Load More chunk
    if (typeof candidate.messageLimit === 'number' && Number.isFinite(candidate.messageLimit)) {
      result.messageLimit = Math.max(10, Math.min(500, Math.round(candidate.messageLimit)));
    }

    const skillCatalogs = sanitizeSkillCatalogs(candidate.skillCatalogs);
    if (skillCatalogs) {
      result.skillCatalogs = skillCatalogs;
    }

    // Usage model selections - which models appear in dropdown
    if (candidate.usageSelectedModels && typeof candidate.usageSelectedModels === 'object') {
      const sanitized = {};
      for (const [providerId, models] of Object.entries(candidate.usageSelectedModels)) {
        if (typeof providerId === 'string' && Array.isArray(models)) {
          const validModels = models.filter((m) => typeof m === 'string' && m.length > 0);
          if (validModels.length > 0) {
            sanitized[providerId] = validModels;
          }
        }
      }
      if (Object.keys(sanitized).length > 0) {
        result.usageSelectedModels = sanitized;
      }
    }

    // Usage page collapsed families - for "Other Models" section
    if (candidate.usageCollapsedFamilies && typeof candidate.usageCollapsedFamilies === 'object') {
      const sanitized = {};
      for (const [providerId, families] of Object.entries(candidate.usageCollapsedFamilies)) {
        if (typeof providerId === 'string' && Array.isArray(families)) {
          const validFamilies = families.filter((f) => typeof f === 'string' && f.length > 0);
          if (validFamilies.length > 0) {
            sanitized[providerId] = validFamilies;
          }
        }
      }
      if (Object.keys(sanitized).length > 0) {
        result.usageCollapsedFamilies = sanitized;
      }
    }

    // Header dropdown expanded families (inverted - stores EXPANDED, default all collapsed)
    if (candidate.usageExpandedFamilies && typeof candidate.usageExpandedFamilies === 'object') {
      const sanitized = {};
      for (const [providerId, families] of Object.entries(candidate.usageExpandedFamilies)) {
        if (typeof providerId === 'string' && Array.isArray(families)) {
          const validFamilies = families.filter((f) => typeof f === 'string' && f.length > 0);
          if (validFamilies.length > 0) {
            sanitized[providerId] = validFamilies;
          }
        }
      }
      if (Object.keys(sanitized).length > 0) {
        result.usageExpandedFamilies = sanitized;
      }
    }

    // Custom model groups configuration
    if (candidate.usageModelGroups && typeof candidate.usageModelGroups === 'object') {
      const sanitized = {};
      for (const [providerId, config] of Object.entries(candidate.usageModelGroups)) {
        if (typeof providerId !== 'string') continue;

        const providerConfig = {};

        // customGroups: array of {id, label, models, order}
        if (Array.isArray(config.customGroups)) {
          const validGroups = config.customGroups
            .filter((g) => g && typeof g.id === 'string' && typeof g.label === 'string')
            .map((g) => ({
              id: g.id.slice(0, 64),
              label: g.label.slice(0, 128),
              models: Array.isArray(g.models)
                ? g.models.filter((m) => typeof m === 'string').slice(0, 500)
                : [],
              order: typeof g.order === 'number' ? g.order : 0,
            }));
          if (validGroups.length > 0) {
            providerConfig.customGroups = validGroups;
          }
        }

        // modelAssignments: Record<modelName, groupId>
        if (config.modelAssignments && typeof config.modelAssignments === 'object') {
          const assignments = {};
          for (const [model, groupId] of Object.entries(config.modelAssignments)) {
            if (typeof model === 'string' && typeof groupId === 'string') {
              assignments[model] = groupId;
            }
          }
          if (Object.keys(assignments).length > 0) {
            providerConfig.modelAssignments = assignments;
          }
        }

        // renamedGroups: Record<groupId, label>
        if (config.renamedGroups && typeof config.renamedGroups === 'object') {
          const renamed = {};
          for (const [groupId, label] of Object.entries(config.renamedGroups)) {
            if (typeof groupId === 'string' && typeof label === 'string') {
              renamed[groupId] = label.slice(0, 128);
            }
          }
          if (Object.keys(renamed).length > 0) {
            providerConfig.renamedGroups = renamed;
          }
        }

        if (Object.keys(providerConfig).length > 0) {
          sanitized[providerId] = providerConfig;
        }
      }
      if (Object.keys(sanitized).length > 0) {
        result.usageModelGroups = sanitized;
      }
    }

    // Usage reporting opt-out (default: true/enabled)
    if (typeof candidate.reportUsage === 'boolean') {
      result.reportUsage = candidate.reportUsage;
    }

    // Global behavior prompt — synced to ~/.config/opencode/AGENTS.md
    if (typeof candidate.globalBehaviorPrompt === 'string') {
      const value = candidate.globalBehaviorPrompt;
      if (value.length <= 1024 * 1024) {
        result.globalBehaviorPrompt = value;
      }
    }

    if (typeof candidate.responseStyleEnabled === 'boolean') {
      result.responseStyleEnabled = candidate.responseStyleEnabled;
    }

    if (
      typeof candidate.responseStylePreset === 'string' &&
      ['concise', 'detailed', 'mentor', 'pushback', 'noFiller', 'matchEnergy', 'warmPeer', 'custom'].includes(candidate.responseStylePreset)
    ) {
      result.responseStylePreset = candidate.responseStylePreset;
    }

    if (typeof candidate.responseStyleCustomInstructions === 'string') {
      const value = candidate.responseStyleCustomInstructions;
      if (value.length <= 50_000) {
        result.responseStyleCustomInstructions = value;
      }
    }

    if (typeof candidate.dictationEnabled === 'boolean') {
      result.dictationEnabled = candidate.dictationEnabled;
    }
    if (typeof candidate.sttProvider === 'string') {
      const provider = candidate.sttProvider.trim();
      if (provider === 'local' || provider === 'openai-compatible') {
        result.sttProvider = provider;
      } else if (provider === 'server') {
        // Legacy provider migration: 'server' was the OpenAI-compatible endpoint.
        result.sttProvider = 'openai-compatible';
      } else if (provider === 'browser' || provider === 'wasm') {
        result.sttProvider = 'local';
      }
    }
    if (typeof candidate.sttServerUrl === 'string') {
      const trimmed = candidate.sttServerUrl.trim();
      if (trimmed.length <= STT_SERVER_URL_MAX_LENGTH) {
        result.sttServerUrl = trimmed;
      }
    }
    if (typeof candidate.sttModel === 'string') {
      const trimmed = candidate.sttModel.trim();
      if (trimmed.length <= STT_MODEL_MAX_LENGTH) {
        result.sttModel = trimmed;
      }
    }
    if (typeof candidate.sttLocalModel === 'string') {
      const trimmed = candidate.sttLocalModel.trim();
      if (trimmed.length <= STT_MODEL_MAX_LENGTH) {
        result.sttLocalModel = trimmed;
      }
    }
    if (typeof candidate.sttLanguage === 'string') {
      const trimmed = candidate.sttLanguage.trim();
      if (trimmed.length <= STT_LANGUAGE_MAX_LENGTH) {
        result.sttLanguage = trimmed;
      }
    }

    return result;
  };

  const mergePersistedSettings = (current, changes) => {
    const baseBookmarks = Array.isArray(changes.securityScopedBookmarks)
      ? changes.securityScopedBookmarks
      : Array.isArray(current.securityScopedBookmarks)
        ? current.securityScopedBookmarks
        : [];

    const nextTypographySizes = changes.typographySizes
      ? {
          ...(current.typographySizes || {}),
          ...changes.typographySizes
        }
      : current.typographySizes;

    const next = {
      ...current,
      ...changes,
      securityScopedBookmarks: Array.from(
        new Set(
          baseBookmarks.filter((entry) => typeof entry === 'string' && entry.length > 0)
        )
      ),
      typographySizes: nextTypographySizes
    };

    if (typeof next.chatMessageWidthMode === 'string') {
      delete next.wideChatLayoutEnabled;
    }

    return next;
  };

  const formatSettingsResponse = (settings) => {
    const sanitized = sanitizeSettingsUpdate(settings);
    delete sanitized.managedRemoteTunnelToken;
    const bookmarks = normalizeStringArray(settings.securityScopedBookmarks);
    const hasManagedRemoteTunnelToken = typeof settings?.managedRemoteTunnelToken === 'string' && settings.managedRemoteTunnelToken.trim().length > 0;
    const pwaAppName = normalizePwaAppName(settings?.pwaAppName, '');
    const pwaOrientation = normalizePwaOrientation(settings?.pwaOrientation, 'system');
    const mobileKeyboardMode = normalizeMobileKeyboardMode(settings?.mobileKeyboardMode, 'native');

    return {
      ...sanitized,
      hasManagedRemoteTunnelToken,
      ...(pwaAppName ? { pwaAppName } : {}),
      pwaOrientation,
      mobileKeyboardMode,
      securityScopedBookmarks: bookmarks,
      pinnedDirectories: normalizeStringArray(settings.pinnedDirectories),
      typographySizes: sanitizeTypographySizesPartial(settings.typographySizes),
      ...(process.env.OPENCHAMBER_RUNTIME === 'desktop'
        ? {
            desktopLanAccessActive: process.env.OPENCHAMBER_DESKTOP_LAN_ACCESS_ACTIVE === 'true',
            desktopLanAccessBlockedReason:
              process.env.OPENCHAMBER_DESKTOP_LAN_ACCESS_BLOCKED_REASON === 'missing-password'
                ? 'missing-password'
                : null,
          }
        : {}),
      showReasoningTraces:
        typeof settings.showReasoningTraces === 'boolean'
          ? settings.showReasoningTraces
          : typeof sanitized.showReasoningTraces === 'boolean'
            ? sanitized.showReasoningTraces
            : false,
      collapsibleThinkingBlocks:
        typeof settings.collapsibleThinkingBlocks === 'boolean'
          ? settings.collapsibleThinkingBlocks
          : typeof sanitized.collapsibleThinkingBlocks === 'boolean'
            ? sanitized.collapsibleThinkingBlocks
            : true,
    };
  };

  return {
    normalizePwaAppName,
    normalizePwaOrientation,
    normalizeMobileKeyboardMode,
    sanitizeSettingsUpdate,
    mergePersistedSettings,
    formatSettingsResponse,
  };
};
