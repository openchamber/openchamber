import { createDeferredSafeJSONStorage, getSafeStorage } from '../utils/safeStorage';
import { contextWindowOwnerId } from '@/lib/contextWindow/role';
import { createContextWindowUIStorage } from '@/lib/contextWindow/storage';
import type { ContextWindowRecord } from '@/lib/contextWindow/layoutState';
import { EMPTY_NOTIFICATION_TEMPLATES, isLegacyDefaultTemplates } from '../utils/notificationTemplates';
import { zonePlacementSchema } from '@/lib/workspace/zones';
import { sanitizeWorkStatusSectionOrder } from '@/components/chat/work-status/sections';
import type { PersistOptions } from 'zustand/middleware';
import {
  normalizeLargeTextPasteBehavior,
  documentAttachBehaviorSchema,
  normalizeFileEditorKeymap,
  DEFAULT_EDITOR_FONT_SIZE,
  DEFAULT_CONTEXT_EDITOR_TREE_WIDTH,
} from './preferences';
import { withoutForeignComparisons, sanitizeContextPanelByDirectory } from './contextPanelState';
import type { LegacyZoneSizes, UIStore } from './types';

const uiStorePersistOptions = {
  name: 'ui-store',
  storage: createDeferredSafeJSONStorage(),
  version: 30,
  migrate: (persistedState, version) => {
    if (!persistedState || typeof persistedState !== 'object') {
      return persistedState;
    }
    const state = persistedState as Record<string, unknown>;

    if (version < 23) {
      state.tableCellWrap = true;
    }

    if (version < 27 && Array.isArray(state.workStatusSectionOrder)) {
      state.workStatusSectionOrder = sanitizeWorkStatusSectionOrder(state.workStatusSectionOrder, false);
    }

    if (version < 28 && state.editorFontSize === 13) {
      state.editorFontSize = DEFAULT_EDITOR_FONT_SIZE;
    }

    if (version < 29 && state.contextEditorTreeWidth === 240) {
      state.contextEditorTreeWidth = DEFAULT_CONTEXT_EDITOR_TREE_WIDTH;
    }

    if (version < 30) {
      state.chatWidth = state.wideChatLayoutEnabled === true ? 'full' : 'default';
      delete state.wideChatLayoutEnabled;
    }

    if (version < 21 && state.workStatusHiddenSectionsExplicit !== true) {
      state.workStatusHiddenSections = Array.isArray(state.workStatusHiddenSections)
        ? state.workStatusHiddenSections.filter((id) => id !== 'telemetry')
        : [];
      state.workStatusHiddenSectionsExplicit = false;
    }

    if (version < 16) {
      delete state.activeMainTab;
      delete state.activeSurface;
    }

    if (version < 17) {
      delete state.expandedEditorToolbar;
    }

    if (version < 18) {
      delete state.shortcutOverrides;
    }

    if (version < 14) {
      const byDirectory = state.contextPanelByDirectory;
      if (byDirectory && typeof byDirectory === 'object') {
        for (const directoryState of Object.values(byDirectory as Record<string, unknown>)) {
          if (!directoryState || typeof directoryState !== 'object') continue;
          const entry = directoryState as Record<string, unknown>;

          const widths = entry.widthByMode;
          if (widths && typeof widths === 'object') {
            const widthRecord = widths as Record<string, unknown>;
            if (widthRecord.preview !== undefined) {
              if (widthRecord.browser === undefined) widthRecord.browser = widthRecord.preview;
              delete widthRecord.preview;
            }
          }

          if (!Array.isArray(entry.tabs)) continue;
          const seenIds = new Set<string>();
          const migrated: Array<Record<string, unknown>> = [];
          for (const rawTab of entry.tabs as Array<unknown>) {
            if (!rawTab || typeof rawTab !== 'object') continue;
            const tab = rawTab as Record<string, unknown>;
            if (tab.mode !== 'preview') {
              if (typeof tab.id === 'string') seenIds.add(tab.id);
              migrated.push(tab);
              continue;
            }

            const targetPath = typeof tab.targetPath === 'string' ? tab.targetPath : '';
            const dedupeKey = typeof tab.dedupeKey === 'string' && tab.dedupeKey.trim()
              ? tab.dedupeKey.trim()
              : (targetPath || 'browser');
            const id = dedupeKey === 'browser' ? 'browser' : `browser:${dedupeKey}`;
            if (seenIds.has(id)) continue;
            seenIds.add(id);
            migrated.push({ ...tab, mode: 'browser', id, dedupeKey });
          }
          entry.tabs = migrated;

          if (typeof entry.activeTabId === 'string' && entry.activeTabId.startsWith('preview')) {
            const nextActive = migrated.find((tab) => typeof tab.id === 'string');
            entry.activeTabId = nextActive && typeof nextActive.id === 'string' ? nextActive.id : null;
          }
        }
      }
    }

    if (version < 13) {
      if (typeof state.autoSaveEnabled !== 'boolean') {
        let legacyEnabled = true;
        try {
          if (typeof localStorage !== 'undefined') {
            const legacy = localStorage.getItem('openchamber:files:auto-save-enabled');
            if (legacy !== null) {
              legacyEnabled = legacy !== 'false';
              localStorage.removeItem('openchamber:files:auto-save-enabled');
            }
          }
        } catch {
          legacyEnabled = true;
        }
        state.autoSaveEnabled = legacyEnabled;
      }
    }

    if (version < 12) {
      if (state.desktopWindowControlsPosition === 'auto' || state.desktopWindowControlsPosition == null) {
        state.desktopWindowControlsPosition = 'right';
      }
    }

    if (version < 11 && state.terminalFontSize === 13) {
      state.terminalFontSize = 14;
    }

    if (version < 10) {
      delete state.diffViewMode;
    }

    if (version < 9) {
      if (!state.workStatusExpandedSections || typeof state.workStatusExpandedSections !== 'object') {
        state.workStatusExpandedSections = {};
      }
      if (typeof state.workStatusScrollTop !== 'number' || !Number.isFinite(state.workStatusScrollTop)) {
        state.workStatusScrollTop = 0;
      }
      if (typeof state.workStatusPanelEnabled !== 'boolean') {
        state.workStatusPanelEnabled = true;
      }
      if (!Array.isArray(state.workStatusHiddenSections)) {
        state.workStatusHiddenSections = [];
      }
    }

    if (version < 1) {
      if (isLegacyDefaultTemplates(state.notificationTemplates)) {
        state.notificationTemplates = {
          completion: { ...EMPTY_NOTIFICATION_TEMPLATES.completion },
          error: { ...EMPTY_NOTIFICATION_TEMPLATES.error },
          question: { ...EMPTY_NOTIFICATION_TEMPLATES.question },
          subtask: { ...EMPTY_NOTIFICATION_TEMPLATES.subtask },
        };
      }
    }

    if (version < 3) {
      const OLD_DEFAULTS = new Set([90, 120, 180, 220]);
      const hist = state.memoryLimitHistorical as number | undefined;
      const active = state.memoryLimitActiveSession as number | undefined;

      if (typeof hist === 'number' && !OLD_DEFAULTS.has(hist)) {
        state.messageLimit = hist;
      } else if (typeof active === 'number' && !OLD_DEFAULTS.has(active)) {
        state.messageLimit = active;
      }

      delete state.memoryLimitHistorical;
      delete state.memoryLimitViewport;
      delete state.memoryLimitActiveSession;
    }

    delete state.isRightSidebarOpen;
    delete state.rightSidebarWidth;
    delete state.rightSidebarTab;

    const legacySizes: LegacyZoneSizes[] = [];
    state.contextPanelByDirectory = sanitizeContextPanelByDirectory(state.contextPanelByDirectory, legacySizes);
    if (version < 26) {
      const latest = legacySizes
        .filter((entry) => Object.keys(entry.sizes).length > 0)
        .sort((a, b) => b.touchedAt - a.touchedAt)[0];
      state.contextZoneSizes = latest?.sizes ?? {};
    }

    if (version < 5) {
      if (!state.shortcutOverrides || typeof state.shortcutOverrides !== 'object') {
        state.shortcutOverrides = {};
      } else {
        const overrides = state.shortcutOverrides as Record<string, unknown>;
        const cleaned: Record<string, string> = {};
        for (const [key, value] of Object.entries(overrides)) {
          if (typeof key === 'string' && typeof value === 'string') {
            cleaned[key] = value;
          }
        }
        state.shortcutOverrides = cleaned;
      }
    }

    if (version < 6) {
      state.contextPanelByDirectory = sanitizeContextPanelByDirectory(state.contextPanelByDirectory);
    }

    if (version < 7) {
      state.contextPanelByDirectory = sanitizeContextPanelByDirectory(state.contextPanelByDirectory);
    }

    if (version < 8) {
      if (state.gitChangesViewMode !== 'flat' && state.gitChangesViewMode !== 'tree') {
        state.gitChangesViewMode = 'flat';
      }
    }

    delete state.linearIssueListStatus;
    delete state.linearIssueListAssignee;
    delete state.linearIssueListTeamId;
    delete state.linearIssueListTeamIdByRuntime;
    delete state.linearIssueListPriority;

    state.fileEditorKeymap = normalizeFileEditorKeymap(state.fileEditorKeymap);
    state.largeTextPasteBehavior = normalizeLargeTextPasteBehavior(state.largeTextPasteBehavior);
    state.documentAttachBehavior = documentAttachBehaviorSchema.parse(state.documentAttachBehavior);

    if (state.toolJsonViewMode !== 'summary'
      && state.toolJsonViewMode !== 'formatted'
      && state.toolJsonViewMode !== 'raw') {
      state.toolJsonViewMode = 'summary';
    }

    if (typeof state.autoSaveEnabled !== 'boolean') {
      state.autoSaveEnabled = true;
    }

    state.contextRailHiddenSurfaces = Array.isArray(state.contextRailHiddenSurfaces)
      ? (state.contextRailHiddenSurfaces as unknown[]).filter((id): id is string => typeof id === 'string' && id.trim() !== '')
      : [];
    state.contextRailOrder = Array.isArray(state.contextRailOrder)
      ? (state.contextRailOrder as unknown[]).filter((id): id is string => typeof id === 'string' && id.trim() !== '')
      : [];
    for (const key of ['mobileWorkspaceTabOrder', 'mobileWorkspaceHiddenTabs']) {
      const value = state[key];
      state[key] = Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
    }

    state.contextSurfaceZones = zonePlacementSchema.parse(state.contextSurfaceZones);

    return state;
  },
  partialize: (state) => ({
    theme: state.theme,
    isSidebarOpen: state.isSidebarOpen,
    sidebarFoldedForExpandedZone: state.sidebarFoldedForExpandedZone,
    sidebarWidth: state.sidebarWidth,
    contextPanelByDirectory: withoutForeignComparisons(state.contextPanelByDirectory),
    contextRailOrder: state.contextRailOrder,
    contextRailHiddenSurfaces: state.contextRailHiddenSurfaces,
    mobileWorkspaceTabOrder: state.mobileWorkspaceTabOrder,
    mobileWorkspaceHiddenTabs: state.mobileWorkspaceHiddenTabs,
    mobileWorkStatusHiddenSections: state.mobileWorkStatusHiddenSections,
    contextSurfaceZones: state.contextSurfaceZones,
    contextEditorTreeVisible: state.contextEditorTreeVisible,
    fileTreeSide: state.fileTreeSide,
    contextEditorVisible: state.contextEditorVisible,
    contextEditorTreeWidth: state.contextEditorTreeWidth,
    contextZoneSizes: state.contextZoneSizes,
    contextZoneExpandedChatSizes: state.contextZoneExpandedChatSizes,
    workStatusExpandedSections: state.workStatusExpandedSections,
    messageQueueExpanded: state.messageQueueExpanded,
    workStatusScrollTop: state.workStatusScrollTop,
    workStatusPanelEnabled: state.workStatusPanelEnabled,
    workStatusHiddenSections: state.workStatusHiddenSections,
    workStatusSectionOrder: state.workStatusSectionOrder,
    workStatusSectionOrderExplicit: state.workStatusSectionOrderExplicit,
    workStatusHiddenSectionsExplicit: state.workStatusHiddenSectionsExplicit,
    isSessionSwitcherOpen: state.isSessionSwitcherOpen,
    sidebarSection: state.sidebarSection,
    settingsPage: state.settingsPage,
    settingsHasOpenedOnce: state.settingsHasOpenedOnce,
    settingsProjectsSelectedId: state.settingsProjectsSelectedId,
    settingsRemoteInstancesSelectedId: state.settingsRemoteInstancesSelectedId,
    isSessionCreateDialogOpen: state.isSessionCreateDialogOpen,
    showReasoningTraces: state.showReasoningTraces,
    streamingAutoFollowEnabled: state.streamingAutoFollowEnabled,
    sessionRecapEnabled: state.sessionRecapEnabled,
    sessionSuggestionEnabled: state.sessionSuggestionEnabled,
    sessionWorkEnabled: state.sessionWorkEnabled,
    sessionReviewOfferEnabled: state.sessionReviewOfferEnabled,
    sessionGoalEnabled: state.sessionGoalEnabled,
    sessionGoalChecker: state.sessionGoalChecker,
    sessionGoalMaxAutoTurns: state.sessionGoalMaxAutoTurns,
    sessionGoalDefaultBudgetEnabled: state.sessionGoalDefaultBudgetEnabled,
    sessionGoalDefaultBudget: state.sessionGoalDefaultBudget,
    collapsibleThinkingBlocks: state.collapsibleThinkingBlocks,
    expandReasoningWhileStreaming: state.expandReasoningWhileStreaming,
    activityRenderMode: state.activityRenderMode,
    showDeletionDialog: state.showDeletionDialog,
    autoDeleteEnabled: state.autoDeleteEnabled,
    autoSaveEnabled: state.autoSaveEnabled,
    fileEditorWrapLines: state.fileEditorWrapLines,
    confirmFileTreeMove: state.confirmFileTreeMove,
    layoutAnimations: state.layoutAnimations,
    openLinksInBrowserPanel: state.openLinksInBrowserPanel,
    liveBrowserTabLimit: state.liveBrowserTabLimit,
    agentBrowserSharesLogins: state.agentBrowserSharesLogins,
    openTrackerLinksOnBoard: state.openTrackerLinksOnBoard,
    autoDeleteAfterDays: state.autoDeleteAfterDays,
    sessionRetentionAction: state.sessionRetentionAction,
    sessionRetentionOnlyArchived: state.sessionRetentionOnlyArchived,
    sessionRetentionIncludeInWork: state.sessionRetentionIncludeInWork,
    mergedWorktreeCleanupEnabled: state.mergedWorktreeCleanupEnabled,
    worktreeArchiveOnDoneEnabled: state.worktreeArchiveOnDoneEnabled,
    autoDeleteLastRunAt: state.autoDeleteLastRunAt,
    messageLimit: state.messageLimit,
    fontSize: state.fontSize,
    chatFontSize: state.chatFontSize,
    globalDraftStarters: state.globalDraftStarters,
    terminalFontSize: state.terminalFontSize,
    terminalShell: state.terminalShell,
    terminalLoginShells: state.terminalLoginShells,
    terminalCloseOnExit: state.terminalCloseOnExit,
    terminalOpenOnProjectAction: state.terminalOpenOnProjectAction,
    editorFontSize: state.editorFontSize,
    uiFont: state.uiFont,
    monoFont: state.monoFont,
    customUiFont: state.customUiFont,
    customMonoFont: state.customMonoFont,
    uiFontWeight: state.uiFontWeight,
    padding: state.padding,
    cornerRadius: state.cornerRadius,
    favoriteModels: state.favoriteModels,
    hiddenModels: state.hiddenModels,
    providerOrder: state.providerOrder,
    collapsedModelProviders: state.collapsedModelProviders,
    customProviderIcons: state.customProviderIcons,
    customProviderLogos: state.customProviderLogos,
    recentModels: state.recentModels,
    lastSelectedModel: state.lastSelectedModel,
    recentAgents: state.recentAgents,
    favoriteAgents: state.favoriteAgents,
    recentEfforts: state.recentEfforts,
    lastUsedEfforts: state.lastUsedEfforts,
    diffLayoutPreference: state.diffLayoutPreference,
    diffWrapLines: state.diffWrapLines,
    diffHideWhitespace: state.diffHideWhitespace,
    diffFileListMode: state.diffFileListMode,
    diffFileTreeWidth: state.diffFileTreeWidth,
    walkthroughTocWidth: state.walkthroughTocWidth,
    gitChangesViewMode: state.gitChangesViewMode,
    toolJsonViewMode: state.toolJsonViewMode,
    nativeNotificationsEnabled: state.nativeNotificationsEnabled,
    notificationMode: state.notificationMode,
    showTerminalQuickKeysOnDesktop: state.showTerminalQuickKeysOnDesktop,
    sessionTabsEnabled: state.sessionTabsEnabled,
    sessionTabsPerWorkspace: state.sessionTabsPerWorkspace,
    notifyOnSubtasks: state.notifyOnSubtasks,
    dockBadgeEnabled: state.dockBadgeEnabled,
    alwaysShowScrollbars: state.alwaysShowScrollbars,
    mobileKeepScreenAwake: state.mobileKeepScreenAwake,
    questionsInChat: state.questionsInChat,
    notifyOnCompletion: state.notifyOnCompletion,
    notifyOnPullRequests: state.notifyOnPullRequests,
    notifyOnError: state.notifyOnError,
    notifyOnQuestion: state.notifyOnQuestion,
    notificationTemplates: state.notificationTemplates,
    summarizeLastMessage: state.summarizeLastMessage,
    summaryThreshold: state.summaryThreshold,
    summaryLength: state.summaryLength,
    maxLastMessageLength: state.maxLastMessageLength,
    showOpenCodeUpdateNotifications: state.showOpenCodeUpdateNotifications,
    agentControlToolEnabled: state.agentControlToolEnabled,
    agentScheduleToolEnabled: state.agentScheduleToolEnabled,
    agentWebToolEnabled: state.agentWebToolEnabled,
    messageSearchEnabled: state.messageSearchEnabled,
    messageSearchReasoningEnabled: state.messageSearchReasoningEnabled,
    browserProvider: state.browserProvider,
    agentMemoryToolEnabled: state.agentMemoryToolEnabled,
    agentKnowledgeToolEnabled: state.agentKnowledgeToolEnabled,
    agentNotifyToolEnabled: state.agentNotifyToolEnabled,
    agentUsageToolEnabled: state.agentUsageToolEnabled,
    agentTerminalToolEnabled: state.agentTerminalToolEnabled,
    agentActionsToolEnabled: state.agentActionsToolEnabled,
    agentImageToolEnabled: state.agentImageToolEnabled,
    agentImageModel: state.agentImageModel,
    agentMemoryDreamingEnabled: state.agentMemoryDreamingEnabled,
    agentMemoryDreamingModel: state.agentMemoryDreamingModel,
    agentMemoryDreamingVariant: state.agentMemoryDreamingVariant,
    agentRenderToolEnabled: state.agentRenderToolEnabled,
    agentSecretToolEnabled: state.agentSecretToolEnabled,
    agentWorkflowToolEnabled: state.agentWorkflowToolEnabled,
    isolatedSpacesEnabled: state.isolatedSpacesEnabled,
    permissionDefaultMode: state.permissionDefaultMode,
    agentMemoryViewedAt: state.agentMemoryViewedAt,
    inputSpellcheckEnabled: state.inputSpellcheckEnabled,
    largeTextPasteBehavior: state.largeTextPasteBehavior,
    documentAttachBehavior: state.documentAttachBehavior,
    enterToSend: state.enterToSend,
    enterToSendConfigured: state.enterToSendConfigured,
    mobileReturnKeySends: state.mobileReturnKeySends,
    chatWidth: state.chatWidth,
    codeBlockLineWrap: state.codeBlockLineWrap,
    tableCellWrap: state.tableCellWrap,
    copyMessagesAsPlainText: state.copyMessagesAsPlainText,
    selectionApprovalText: state.selectionApprovalText,
    showToolFileIcons: state.showToolFileIcons,
    showTurnChangedFiles: state.showTurnChangedFiles,
    timeFormatPreference: state.timeFormatPreference,
    weekStartPreference: state.weekStartPreference,
    desktopWindowControlsPosition: state.desktopWindowControlsPosition,
    desktopWindowControlsStyle: state.desktopWindowControlsStyle,
    inputBarOffset: state.inputBarOffset,
    mermaidRenderingMode: state.mermaidRenderingMode,
    userMessageRenderingMode: state.userMessageRenderingMode,
    collapsibleUserMessages: state.collapsibleUserMessages,
    stickyUserHeader: state.stickyUserHeader,
    promptNavigatorEnabled: state.promptNavigatorEnabled,
    showSplitAssistantMessageActions: state.showSplitAssistantMessageActions,
    allowPromptingSubagentSessions: state.allowPromptingSubagentSessions,
    savePastedImagesAsFiles: state.savePastedImagesAsFiles,
    draftStartersVisible: state.draftStartersVisible,
    shortcutOverrides: state.shortcutOverrides,
    fileEditorKeymap: state.fileEditorKeymap,
    fileEditorVimMappings: state.fileEditorVimMappings,
  })
} satisfies PersistOptions<UIStore, unknown>;

export const contextWindowPersistOptions = (): PersistOptions<UIStore, unknown> => {
  const ownerId = contextWindowOwnerId();
  const layoutStorage = ownerId ? createDeferredSafeJSONStorage<ContextWindowRecord>() : undefined;
  if (!ownerId || !layoutStorage) return uiStorePersistOptions;
  return {
    ...uiStorePersistOptions,
    partialize: (state) => ({ ...uiStorePersistOptions.partialize(state), contextPanelByDirectory: state.contextPanelByDirectory }),
    storage: createContextWindowUIStorage({
      ownerId,
      version: uiStorePersistOptions.version,
      storage: getSafeStorage,
      layoutStorage,
    }),
  };
};
