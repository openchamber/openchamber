import React from 'react';
import { useSessionStore } from '@/stores/useSessionStore';
import { useUIStore } from '@/stores/useUIStore';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useAssistantStatus } from '@/hooks/useAssistantStatus';
import { createWorktreeSession } from '@/lib/worktreeSessionCreator';
import { useConfigStore } from '@/stores/useConfigStore';
import { isVSCodeRuntime } from '@/lib/desktop';
import { showOpenCodeStatus } from '@/lib/openCodeStatus';
import { eventMatchesShortcut, getEffectiveShortcutCombo } from '@/lib/shortcuts';

export const useKeyboardShortcuts = () => {
  const { openNewSessionDraft, abortCurrentOperation, armAbortPrompt, clearAbortPrompt, currentSessionId } = useSessionStore();
  const {
    toggleCommandPalette,
    toggleHelpDialog,
    toggleSidebar,
    toggleRightSidebar,
    setRightSidebarOpen,
    setRightSidebarTab,
    toggleBottomTerminal,
    setBottomTerminalExpanded,
    isMobile,
    setSessionSwitcherOpen,
    setActiveMainTab,
    setSettingsDialogOpen,
    setModelSelectorOpen,
    toggleExpandedInput,
    shortcutOverrides,
  } = useUIStore();
  const { themeMode, setThemeMode } = useThemeSystem();
  const { working } = useAssistantStatus();
  const abortPrimedUntilRef = React.useRef<number | null>(null);
  const abortPrimedTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const themeModeRef = React.useRef(themeMode);

  React.useEffect(() => {
    themeModeRef.current = themeMode;
  }, [themeMode]);

  const resetAbortPriming = React.useCallback(() => {
    if (abortPrimedTimeoutRef.current) {
      clearTimeout(abortPrimedTimeoutRef.current);
      abortPrimedTimeoutRef.current = null;
    }
    abortPrimedUntilRef.current = null;
    clearAbortPrompt();
  }, [clearAbortPrompt]);

  React.useEffect(() => {
    const combo = (actionId: string) => getEffectiveShortcutCombo(actionId, shortcutOverrides);

    const handleKeyDown = (e: KeyboardEvent) => {
      if (eventMatchesShortcut(e, combo('open_command_palette'))) {
        e.preventDefault();
        toggleCommandPalette();
        return;
      }

      if (eventMatchesShortcut(e, combo('open_status'))) {
        e.preventDefault();
        void showOpenCodeStatus();
        return;
      }

      if (eventMatchesShortcut(e, combo('open_help'))) {
        e.preventDefault();
        toggleHelpDialog();
        return;
      }

      if (eventMatchesShortcut(e, combo('new_chat')) || eventMatchesShortcut(e, combo('new_chat_worktree'))) {
        e.preventDefault();

        const isVSCode = isVSCodeRuntime();
        const autoWorktree = useConfigStore.getState().settingsAutoCreateWorktree;
        const matchedPrimaryShortcut = eventMatchesShortcut(e, combo('new_chat'));
        const shouldCreateWorktree = isVSCode
          ? false
          : (matchedPrimaryShortcut ? autoWorktree : !autoWorktree);

        if (shouldCreateWorktree) {
          setActiveMainTab('chat');
          setSessionSwitcherOpen(false);
          createWorktreeSession();
          return;
        }

        setActiveMainTab('chat');
        setSessionSwitcherOpen(false);
        openNewSessionDraft();
        return;
      }

      if (eventMatchesShortcut(e, combo('cycle_theme'))) {
        e.preventDefault();
        const modes: Array<'light' | 'dark' | 'system'> = ['light', 'dark', 'system'];
        const activeElement = document.activeElement as HTMLElement | null;
        const currentIndex = modes.indexOf(themeModeRef.current);
        const nextIndex = (currentIndex + 1) % modes.length;
        setThemeMode(modes[nextIndex]);
        requestAnimationFrame(() => {
          if (typeof document === 'undefined' || typeof window === 'undefined') {
            return;
          }
          if (!document.hasFocus()) {
            window.focus();
          }
          if (activeElement && document.contains(activeElement)) {
            activeElement.focus({ preventScroll: true });
          }
        });
        return;
      }

      if (eventMatchesShortcut(e, combo('open_timeline'))) {
        e.preventDefault();
        const { isTimelineDialogOpen, setTimelineDialogOpen } = useUIStore.getState();
        setTimelineDialogOpen(!isTimelineDialogOpen);
        return;
      }

      if (eventMatchesShortcut(e, combo('open_settings'))) {
        e.preventDefault();
        const { isSettingsDialogOpen } = useUIStore.getState();
        setSettingsDialogOpen(!isSettingsDialogOpen);
        return;
      }

      if (eventMatchesShortcut(e, combo('toggle_sidebar'))) {
        e.preventDefault();
        const { isMobile, isSessionSwitcherOpen } = useUIStore.getState();
        if (isMobile) {
          setSessionSwitcherOpen(!isSessionSwitcherOpen);
        } else {
          toggleSidebar();
        }
        return;
      }

      if (eventMatchesShortcut(e, combo('focus_input'))) {
        e.preventDefault();
        const textarea = document.querySelector<HTMLTextAreaElement>('textarea[data-chat-input="true"]');
        textarea?.focus();
        return;
      }

      if (eventMatchesShortcut(e, combo('toggle_right_sidebar'))) {
        const { isMobile } = useUIStore.getState();
        if (isMobile) {
          return;
        }
        e.preventDefault();
        toggleRightSidebar();
        return;
      }

      if (eventMatchesShortcut(e, combo('open_right_sidebar_git'))) {
        const { isMobile } = useUIStore.getState();
        if (isMobile) {
          return;
        }
        e.preventDefault();
        setRightSidebarOpen(true);
        setRightSidebarTab('git');
        return;
      }

      if (eventMatchesShortcut(e, combo('open_right_sidebar_files'))) {
        const { isMobile } = useUIStore.getState();
        if (isMobile) {
          return;
        }
        e.preventDefault();
        setRightSidebarOpen(true);
        setRightSidebarTab('files');
        return;
      }

      if (eventMatchesShortcut(e, combo('cycle_right_sidebar_tab'))) {
        const { isMobile, rightSidebarTab } = useUIStore.getState();
        if (isMobile) {
          return;
        }

        const tabs = ['git', 'files'] as const;
        const currentIndex = tabs.indexOf(rightSidebarTab);
        const nextTab = tabs[(currentIndex + 1) % tabs.length];

        e.preventDefault();
        setRightSidebarOpen(true);
        setRightSidebarTab(nextTab);
        return;
      }

      if (eventMatchesShortcut(e, combo('toggle_terminal'))) {
        const { isMobile } = useUIStore.getState();
        if (isMobile) {
          return;
        }
        e.preventDefault();
        toggleBottomTerminal();
        return;
      }

      if (eventMatchesShortcut(e, combo('toggle_terminal_expanded'))) {
        const { isMobile, isBottomTerminalExpanded } = useUIStore.getState();
        if (isMobile) {
          return;
        }
        e.preventDefault();
        setBottomTerminalExpanded(!isBottomTerminalExpanded);
        return;
      }

      // Cmd/Ctrl+Shift+M: Open model selector (same conditions as double-ESC: chat tab, no overlays)
      if (eventMatchesShortcut(e, combo('open_model_selector'))) {
        const {
          isSettingsDialogOpen,
          isCommandPaletteOpen,
          isHelpDialogOpen,
          isSessionSwitcherOpen,
          isAboutDialogOpen,
          activeMainTab,
          isModelSelectorOpen,
        } = useUIStore.getState();

        // Skip if settings open
        if (isSettingsDialogOpen) {
          return;
        }

        // Skip if any overlay open or not on chat tab
        const hasOverlay = isCommandPaletteOpen || isHelpDialogOpen || isSessionSwitcherOpen || isAboutDialogOpen;
        const isChatActive = activeMainTab === 'chat';

        if (hasOverlay || !isChatActive) {
          return;
        }

        e.preventDefault();
        setModelSelectorOpen(!isModelSelectorOpen);
        return;
      }

      // Cmd/Ctrl+Shift+T: Cycle thinking variant (same gating as Shift+M)
      if (eventMatchesShortcut(e, combo('cycle_thinking_variant'))) {
        const {
          isSettingsDialogOpen,
          isCommandPaletteOpen,
          isHelpDialogOpen,
          isSessionSwitcherOpen,
          isAboutDialogOpen,
          activeMainTab,
        } = useUIStore.getState();

        if (isSettingsDialogOpen) {
          return;
        }

        const hasOverlay = isCommandPaletteOpen || isHelpDialogOpen || isSessionSwitcherOpen || isAboutDialogOpen;
        const isChatActive = activeMainTab === 'chat';

        if (hasOverlay || !isChatActive) {
          return;
        }

        const configState = useConfigStore.getState();
        const variants = configState.getCurrentModelVariants();
        if (variants.length === 0) {
          return;
        }

        e.preventDefault();
        configState.cycleCurrentVariant();

        const nextVariant = useConfigStore.getState().currentVariant;
        const sessionState = useSessionStore.getState();
        const sessionId = sessionState.currentSessionId;
        const agentName = useConfigStore.getState().currentAgentName;
        const providerId = useConfigStore.getState().currentProviderId;
        const modelId = useConfigStore.getState().currentModelId;

        if (sessionId && agentName && providerId && modelId) {
          sessionState.saveAgentModelVariantForSession(sessionId, agentName, providerId, modelId, nextVariant);
        }

        return;
      }

      if (eventMatchesShortcut(e, combo('expand_input'))) {
        if (isMobile) {
          return;
        }
        e.preventDefault();
        toggleExpandedInput();
        return;
      }

      if (e.key === 'Escape') {
        const target = e.target as Element | null;
        const isInsideDialog = Boolean(target?.closest('[role="dialog"]'));
        const isSettingsMounted = Boolean(document.querySelector('[data-settings-view="true"]'));

        if (isInsideDialog || isSettingsMounted) {
          resetAbortPriming();
          return;
        }

        const {
          isSettingsDialogOpen,
          isCommandPaletteOpen,
          isHelpDialogOpen,
          isSessionSwitcherOpen,
          isAboutDialogOpen,
          isMultiRunLauncherOpen,
          isImagePreviewOpen,
          activeMainTab,
        } = useUIStore.getState();

        // If settings is open, close it
        if (isSettingsDialogOpen) {
          e.preventDefault();
          setSettingsDialogOpen(false);
          resetAbortPriming();
          return;
        }

        // Check if any overlay is open or not on chat tab - don't process abort
        const hasOverlay = isCommandPaletteOpen || isHelpDialogOpen || isSessionSwitcherOpen || isAboutDialogOpen || isMultiRunLauncherOpen || isImagePreviewOpen;
        const isChatActive = activeMainTab === 'chat';

        if (hasOverlay || !isChatActive) {
          resetAbortPriming();
          return;
        }

        // Double-ESC abort logic - only when on chat tab with no overlays
        const sessionId = currentSessionId;
        const canAbortNow = working.canAbort && Boolean(sessionId);
        if (!canAbortNow) {
          resetAbortPriming();
          return;
        }

        const now = Date.now();
        const primedUntil = abortPrimedUntilRef.current;

        if (primedUntil && now < primedUntil) {
          e.preventDefault();
          resetAbortPriming();
          void abortCurrentOperation();
          return;
        }

        e.preventDefault();
        const expiresAt = armAbortPrompt(3000) ?? now + 3000;
        abortPrimedUntilRef.current = expiresAt;

        if (abortPrimedTimeoutRef.current) {
          clearTimeout(abortPrimedTimeoutRef.current);
        }

        const delay = Math.max(expiresAt - now, 0);
        abortPrimedTimeoutRef.current = setTimeout(() => {
          if (abortPrimedUntilRef.current && Date.now() >= abortPrimedUntilRef.current) {
            resetAbortPriming();
          }
        }, delay || 0);
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [
    openNewSessionDraft,
    abortCurrentOperation,
    toggleCommandPalette,
    toggleHelpDialog,
    toggleSidebar,
    toggleRightSidebar,
    setRightSidebarOpen,
    setRightSidebarTab,
    toggleBottomTerminal,
    setBottomTerminalExpanded,
    isMobile,
    setSessionSwitcherOpen,
    setActiveMainTab,
    setSettingsDialogOpen,
    setModelSelectorOpen,
    toggleExpandedInput,
    setThemeMode,
    working,
    armAbortPrompt,
    resetAbortPriming,
    currentSessionId,
    shortcutOverrides,
  ]);

  React.useEffect(() => {
    return () => {
      resetAbortPriming();
    };
  }, [resetAbortPriming]);
};
