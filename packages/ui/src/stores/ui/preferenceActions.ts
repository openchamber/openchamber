import { isSessionGoalMaxAutoTurns } from '@/lib/sessionGoalTurnLimit';
import { clampLiveBrowserTabs } from '@/lib/browser/liveTabs';
import { normalizeLargeTextPasteBehavior, normalizeFileEditorKeymap } from './preferences';
import type { UIStoreSlice } from './types';

export const createPreferenceActions: UIStoreSlice<
  | 'setTerminalShell'
  | 'setTerminalLoginShells'
  | 'setTerminalCloseOnExit'
  | 'setTerminalOpenOnProjectAction'
  | 'setShowReasoningTraces'
  | 'setStreamingAutoFollowEnabled'
  | 'setSessionRecapEnabled'
  | 'setSessionSuggestionEnabled'
  | 'setSessionWorkEnabled'
  | 'setSessionReviewOfferEnabled'
  | 'setSessionGoalEnabled'
  | 'setSessionGoalChecker'
  | 'setSessionGoalMaxAutoTurns'
  | 'setSessionGoalDefaultBudgetEnabled'
  | 'setSessionGoalDefaultBudget'
  | 'setCollapsibleThinkingBlocks'
  | 'setExpandReasoningWhileStreaming'
  | 'setActivityRenderMode'
  | 'setShowDeletionDialog'
  | 'setAutoDeleteEnabled'
  | 'setMergedWorktreeCleanupEnabled'
  | 'setWorktreeArchiveOnDoneEnabled'
  | 'setAutoSaveEnabled'
  | 'setFileEditorWrapLines'
  | 'setConfirmFileTreeMove'
  | 'setLayoutAnimations'
  | 'setOpenLinksInBrowserPanel'
  | 'setLiveBrowserTabLimit'
  | 'setAgentBrowserSharesLogins'
  | 'setOpenTrackerLinksOnBoard'
  | 'setFileTreeSide'
  | 'setAutoDeleteAfterDays'
  | 'setSessionRetentionAction'
  | 'setSessionRetentionOnlyArchived'
  | 'setSessionRetentionIncludeInWork'
  | 'setAutoDeleteLastRunAt'
  | 'setMessageLimit'
  | 'setGlobalDraftStarters'
  | 'setDraftStartersVisible'
  | 'setDiffLayoutPreference'
  | 'setDiffLayoutForAllFiles'
  | 'setDiffFileLayout'
  | 'setDiffFileListMode'
  | 'setDiffFileTreeWidth'
  | 'setDiffWrapLines'
  | 'setDiffHideWhitespace'
  | 'setWalkthroughTocWidth'
  | 'setGitChangesViewMode'
  | 'setToolJsonViewMode'
  | 'setInputBarOffset'
  | 'setMobileKeyboardMode'
  | 'setShowTerminalQuickKeysOnDesktop'
  | 'setSessionTabsEnabled'
  | 'setSessionTabsPerWorkspace'
  | 'setAlwaysShowScrollbars'
  | 'setMobileKeepScreenAwake'
  | 'setQuestionsInChat'
  | 'setShowOpenCodeUpdateNotifications'
  | 'setInputSpellcheckEnabled'
  | 'setLargeTextPasteBehavior'
  | 'setEnterToSend'
  | 'setEnterToSendConfigured'
  | 'setMobileReturnKeySends'
  | 'setChatWidth'
  | 'setCodeBlockLineWrap'
  | 'setTableCellWrap'
  | 'setSelectionApprovalText'
  | 'setCopyMessagesAsPlainText'
  | 'setShowToolFileIcons'
  | 'setShowTurnChangedFiles'
  | 'setTimeFormatPreference'
  | 'setWeekStartPreference'
  | 'setDesktopWindowControlsPosition'
  | 'setDesktopWindowControlsStyle'
  | 'setMermaidRenderingMode'
  | 'setUserMessageRenderingMode'
  | 'setCollapsibleUserMessages'
  | 'setStickyUserHeader'
  | 'setPromptNavigatorEnabled'
  | 'setShowSplitAssistantMessageActions'
  | 'setAllowPromptingSubagentSessions'
  | 'setSavePastedImagesAsFiles'
  | 'setReportUsage'
  | 'setShortcutOverride'
  | 'clearShortcutOverride'
  | 'resetAllShortcutOverrides'
  | 'setFileEditorKeymap'
  | 'setFileEditorVimMappings'
> = (set) => ({
  setTerminalShell: (shell) => {
    set({ terminalShell: shell });
  },

  setTerminalLoginShells: (shells) => {
    set({ terminalLoginShells: [...new Set(shells)] });
  },

  setTerminalCloseOnExit: (value) => {
    set({ terminalCloseOnExit: value });
  },

  setTerminalOpenOnProjectAction: (value) => {
    set({ terminalOpenOnProjectAction: value });
  },
  setShowReasoningTraces: (value) => {
    set({ showReasoningTraces: value });
  },

  setStreamingAutoFollowEnabled: (value) => {
    set({ streamingAutoFollowEnabled: value });
  },

  setSessionRecapEnabled: (value) => {
    set({ sessionRecapEnabled: value });
  },

  setSessionSuggestionEnabled: (value) => {
    set({ sessionSuggestionEnabled: value });
  },

  setSessionWorkEnabled: (value) => {
    set({ sessionWorkEnabled: value });
  },

  setSessionReviewOfferEnabled: (value) => {
    set({ sessionReviewOfferEnabled: value });
  },

  setSessionGoalEnabled: (value) => {
    set({ sessionGoalEnabled: value });
  },

  setSessionGoalChecker: (value) => {
    set({ sessionGoalChecker: value });
  },

  setSessionGoalMaxAutoTurns: (value) => {
    if (!isSessionGoalMaxAutoTurns(value)) return;
    set({ sessionGoalMaxAutoTurns: value });
  },

  setSessionGoalDefaultBudgetEnabled: (value) => {
    set({ sessionGoalDefaultBudgetEnabled: value });
  },

  setSessionGoalDefaultBudget: (value) => {
    set({ sessionGoalDefaultBudget: value });
  },

  setCollapsibleThinkingBlocks: (value) => {
    set({ collapsibleThinkingBlocks: value });
  },

  setExpandReasoningWhileStreaming: (value) => {
    set({ expandReasoningWhileStreaming: value });
  },

  setActivityRenderMode: (value) => {
    set({ activityRenderMode: value });
  },

  setShowDeletionDialog: (value) => {
    set({ showDeletionDialog: value });
  },

  setAutoDeleteEnabled: (value) => {
    set({ autoDeleteEnabled: value });
  },

  setMergedWorktreeCleanupEnabled: (value) => {
    set({ mergedWorktreeCleanupEnabled: value });
  },

  setWorktreeArchiveOnDoneEnabled: (value) => {
    set({ worktreeArchiveOnDoneEnabled: value });
  },

  setAutoSaveEnabled: (value) => {
    set({ autoSaveEnabled: value });
  },

  setFileEditorWrapLines: (value) => {
    set({ fileEditorWrapLines: value });
  },

  setConfirmFileTreeMove: (value) => {
    set({ confirmFileTreeMove: value });
  },

  setLayoutAnimations: (value) => {
    set({ layoutAnimations: value });
  },

  setOpenLinksInBrowserPanel: (value) => {
    set({ openLinksInBrowserPanel: value });
  },

  setLiveBrowserTabLimit: (value) => {
    set({ liveBrowserTabLimit: clampLiveBrowserTabs(value) });
  },

  setAgentBrowserSharesLogins: (value) => {
    set({ agentBrowserSharesLogins: value });
  },

  setOpenTrackerLinksOnBoard: (value) => {
    set({ openTrackerLinksOnBoard: value });
  },

  setFileTreeSide: (side) => {
    set({ fileTreeSide: side === 'left' ? 'left' : 'right' });
  },

  setAutoDeleteAfterDays: (days) => {
    const clampedDays = Math.max(1, Math.min(365, days));
    set({ autoDeleteAfterDays: clampedDays });
  },

  setSessionRetentionAction: (value) => {
    set((state) => ({ sessionRetentionAction: state.sessionRetentionOnlyArchived ? 'delete' : value }));
  },

  setSessionRetentionOnlyArchived: (value) => {
    set((state) => ({
      sessionRetentionOnlyArchived: value,
      sessionRetentionAction: value ? 'delete' : state.sessionRetentionAction,
    }));
  },

  setSessionRetentionIncludeInWork: (value) => {
    set({ sessionRetentionIncludeInWork: value });
  },

  setAutoDeleteLastRunAt: (timestamp) => {
    set({ autoDeleteLastRunAt: timestamp });
  },

  setMessageLimit: (value) => {
    const clamped = Math.max(10, Math.min(500, Math.round(value)));
    set({ messageLimit: clamped });
  },

  setGlobalDraftStarters: (refs) => {
    set({ globalDraftStarters: refs });
  },

  setDraftStartersVisible: (value) => {
    set({ draftStartersVisible: value });
  },

  setDiffLayoutPreference: (mode) => {
    set({ diffLayoutPreference: mode });
  },

  setDiffLayoutForAllFiles: (mode) => {
    set({ diffLayoutPreference: mode, diffFileLayout: {} });
  },

  setDiffFileLayout: (filePath, mode) => {
    set((state) => ({
      diffFileLayout: {
        ...state.diffFileLayout,
        [filePath]: mode,
      },
    }));
  },

  setDiffFileListMode: (mode) => {
    set({ diffFileListMode: mode });
  },

  setDiffFileTreeWidth: (width) => {
    set({ diffFileTreeWidth: Math.round(width) });
  },

  setDiffWrapLines: (wrap) => {
    set({ diffWrapLines: wrap });
  },

  setDiffHideWhitespace: (hide) => {
    set({ diffHideWhitespace: hide });
  },

  setWalkthroughTocWidth: (width) => {
    set({ walkthroughTocWidth: Math.round(width) });
  },

  setGitChangesViewMode: (mode) => {
    set({ gitChangesViewMode: mode });
  },

  setToolJsonViewMode: (mode) => {
    set({ toolJsonViewMode: mode });
  },

  setInputBarOffset: (offset) => {
    set({ inputBarOffset: offset });
  },

  setMobileKeyboardMode: (mode) => {
    set((state) => state.mobileKeyboardMode === mode ? state : { mobileKeyboardMode: mode });
  },

  setShowTerminalQuickKeysOnDesktop: (value) => {
    set({ showTerminalQuickKeysOnDesktop: value });
  },

  setSessionTabsEnabled: (value) => {
    set({ sessionTabsEnabled: value });
  },

  setSessionTabsPerWorkspace: (value) => {
    set({ sessionTabsPerWorkspace: value });
  },

  setAlwaysShowScrollbars: (value) => {
    set({ alwaysShowScrollbars: value });
  },

  setMobileKeepScreenAwake: (value) => {
    set({ mobileKeepScreenAwake: value });
  },

  setQuestionsInChat: (value) => {
    set({ questionsInChat: value });
  },

  setShowOpenCodeUpdateNotifications: (value) => {
    set({ showOpenCodeUpdateNotifications: value });
  },

  setInputSpellcheckEnabled: (value) => {
    set({ inputSpellcheckEnabled: value });
  },

  setLargeTextPasteBehavior: (value) => {
    set({ largeTextPasteBehavior: normalizeLargeTextPasteBehavior(value) });
  },

  setEnterToSend: (value) => {
    set({ enterToSend: value });
  },

  setEnterToSendConfigured: (value) => {
    set({ enterToSendConfigured: value });
  },

  setMobileReturnKeySends: (value) => {
    set({ mobileReturnKeySends: value });
  },

  setChatWidth: (value) => {
    set({ chatWidth: value });
  },

  setCodeBlockLineWrap: (value) => {
    set({ codeBlockLineWrap: value });
  },

  setTableCellWrap: (value) => {
    set({ tableCellWrap: value });
  },

  setSelectionApprovalText: (value) => {
    set({ selectionApprovalText: value });
  },

  setCopyMessagesAsPlainText: (value) => {
    set({ copyMessagesAsPlainText: value });
  },

  setShowToolFileIcons: (value) => {
    set({ showToolFileIcons: value });
  },

  setShowTurnChangedFiles: (value) => {
    set({ showTurnChangedFiles: value });
  },

  setTimeFormatPreference: (value) => {
    set({ timeFormatPreference: value });
  },

  setWeekStartPreference: (value) => {
    set({ weekStartPreference: value });
  },

  setDesktopWindowControlsPosition: (value) => {
    set({ desktopWindowControlsPosition: value === 'left' ? 'left' : 'right' });
  },

  setDesktopWindowControlsStyle: (value) => {
    set({ desktopWindowControlsStyle: value === 'traffic-lights' ? 'traffic-lights' : 'classic' });
  },

  setMermaidRenderingMode: (value) => {
    set({ mermaidRenderingMode: value });
  },

  setUserMessageRenderingMode: (value) => {
    set({ userMessageRenderingMode: value });
  },

  setCollapsibleUserMessages: (value) => {
    set({ collapsibleUserMessages: value });
  },

  setStickyUserHeader: (value) => {
    set({ stickyUserHeader: value });
  },

  setPromptNavigatorEnabled: (value) => {
    set({ promptNavigatorEnabled: value });
  },

  setShowSplitAssistantMessageActions: (value) => {
    set({ showSplitAssistantMessageActions: value });
  },

  setAllowPromptingSubagentSessions: (value) => {
    set({ allowPromptingSubagentSessions: value });
  },

  setSavePastedImagesAsFiles: (value) => {
    set({ savePastedImagesAsFiles: value });
  },

  setReportUsage: (value) => {
    set({ reportUsage: value });
  },

  setShortcutOverride: (actionId, combo) => {
    set((state) => ({
      shortcutOverrides: {
        ...state.shortcutOverrides,
        [actionId]: combo,
      },
    }));
  },

  clearShortcutOverride: (actionId) => {
    set((state) => {
      const rest = { ...state.shortcutOverrides };
      delete rest[actionId];
      return { shortcutOverrides: rest };
    });
  },

  resetAllShortcutOverrides: () => {
    set({ shortcutOverrides: {} });
  },

  setFileEditorKeymap: (value) => {
    set({ fileEditorKeymap: normalizeFileEditorKeymap(value) });
  },

  setFileEditorVimMappings: (value) => {
    set({ fileEditorVimMappings: value.slice(0, 10_000) });
  },

});
