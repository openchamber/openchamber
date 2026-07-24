import React from 'react';
import { isTerminalEventTarget } from '@/lib/terminalFocus';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSelectionStore } from '@/sync/selection-store';
import * as sessionActions from '@/sync/session-actions';
import { useUIStore } from '@/stores/useUIStore';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useAssistantStatus } from '@/hooks/useAssistantStatus';
import { createWorktreeSession } from '@/lib/worktreeSessionCreator';
import { useConfigStore } from '@/stores/useConfigStore';
import { canUseElectronDesktopIPC, invokeDesktop, isVSCodeRuntime } from '@/lib/desktop';
import { showOpenCodeStatus } from '@/lib/openCodeStatus';
import { eventMatchesShortcut, getEffectiveShortcutCombo, normalizeCombo } from '@/lib/shortcuts';
import { readEmbeddedThemeSearchParams } from '@/contexts/theme-embedded-bootstrap';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { getCycledPrimaryAgentName } from '@/components/chat/mobileControlsUtils';
import { sessionMRU } from '@/sync/session-mru';
import { getAllSyncSessionMap } from '@/sync/sync-refs';

export const useKeyboardShortcuts = () => {
  const openNewSessionDraft = useSessionUIStore((s) => s.openNewSessionDraft);
  const armAbortPrompt = useSessionUIStore((s) => s.armAbortPrompt);
  const clearAbortPrompt = useSessionUIStore((s) => s.clearAbortPrompt);
  const currentSessionId = useSessionUIStore((s) => s.currentSessionId);
  const currentSessionIdRef = React.useRef(currentSessionId);
  React.useEffect(() => {
    currentSessionIdRef.current = currentSessionId;
  }, [currentSessionId]);
    const abortCurrentOperation = sessionActions.abortCurrentOperation;;
  const toggleCommandPalette = useUIStore((s) => s.toggleCommandPalette);
  const toggleHelpDialog = useUIStore((s) => s.toggleHelpDialog);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const toggleRightSidebar = useUIStore((s) => s.toggleRightSidebar);
  const setRightSidebarOpen = useUIStore((s) => s.setRightSidebarOpen);
  const setRightSidebarTab = useUIStore((s) => s.setRightSidebarTab);
  const toggleBottomTerminal = useUIStore((s) => s.toggleBottomTerminal);
  const setBottomTerminalExpanded = useUIStore((s) => s.setBottomTerminalExpanded);
  const isMobile = useUIStore((s) => s.isMobile);
  const setSessionSwitcherOpen = useUIStore((s) => s.setSessionSwitcherOpen);
  const setActiveMainTab = useUIStore((s) => s.setActiveMainTab);
  const setSettingsDialogOpen = useUIStore((s) => s.setSettingsDialogOpen);
  const setModelSelectorOpen = useUIStore((s) => s.setModelSelectorOpen);
  const setTimelineDialogOpen = useUIStore((s) => s.setTimelineDialogOpen);
  const setSessionPickerOpen = useUIStore((s) => s.setSessionPickerOpen);
  const togglePromptNavigatorPanel = useUIStore((s) => s.togglePromptNavigatorPanel);
  const setPromptNavigatorPanelOpen = useUIStore((s) => s.setPromptNavigatorPanelOpen);
  const toggleExpandedInput = useUIStore((s) => s.toggleExpandedInput);
  const shortcutOverrides = useUIStore((s) => s.shortcutOverrides);
  const currentDirectory = useDirectoryStore((s) => s.currentDirectory);
  const activeProject = useProjectsStore((s) => s.getActiveProject());
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
    const dropdownTargetSelector = [
      '[data-slot="dropdown-menu-content"]',
      '[data-slot="select-content"]',
      '[role="combobox"]',
      '[role="listbox"]',
      '[role="menu"]',
      '[role="menuitem"]',
      '[role="option"]',
      '[data-radix-popper-content-wrapper]',
    ].join(',');

    const isDropdownEventTarget = (target: EventTarget | null) => {
      return target instanceof Element && Boolean(target.closest(dropdownTargetSelector));
    };

    const hasOpenDropdown = () => {
      const openDropdowns = document.querySelectorAll<HTMLElement>(
        '[data-slot="dropdown-menu-content"], [data-slot="select-content"], [role="listbox"], [role="menu"], [data-radix-popper-content-wrapper]'
      );
      return Array.from(openDropdowns).some((element) => element.getClientRects().length > 0);
    };

    const handleTerminalShortcutCapture = (e: KeyboardEvent) => {
      if (!isTerminalEventTarget(e.target)) {
        return;
      }

      if (eventMatchesShortcut(e, combo('toggle_terminal'))) {
        const { isMobile } = useUIStore.getState();
        if (isMobile) {
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        toggleBottomTerminal();
        return;
      }

      if (eventMatchesShortcut(e, combo('toggle_terminal_expanded'))) {
        const { isMobile, isBottomTerminalExpanded } = useUIStore.getState();
        if (isMobile) {
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        setBottomTerminalExpanded(!isBottomTerminalExpanded);
        return;
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (isTerminalEventTarget(e.target)) {
        return;
      }

      const isChatInputTarget = (target: EventTarget | null) => {
        return target instanceof HTMLTextAreaElement && target.getAttribute('data-chat-input') === 'true';
      };

      if (eventMatchesShortcut(e, combo('open_command_palette'))) {
        e.preventDefault();
        toggleCommandPalette();
        return;
      }

      if (eventMatchesShortcut(e, combo('open_timeline_dialog'))) {
        e.preventDefault();
        setTimelineDialogOpen(true);
        return;
      }

      if (eventMatchesShortcut(e, combo('switch_session'))) {
        e.preventDefault();
        const { isSessionPickerOpen } = useUIStore.getState();
        setSessionPickerOpen(!isSessionPickerOpen);
        return;
      }

      if (eventMatchesShortcut(e, combo('toggle_prompt_navigator'))) {
        const {
          activeMainTab,
          promptNavigatorEnabled,
          isSettingsDialogOpen,
          isCommandPaletteOpen,
          isHelpDialogOpen,
          isSessionSwitcherOpen,
          isAboutDialogOpen,
          isTimelineDialogOpen,
          isMultiRunLauncherOpen,
          isImagePreviewOpen,
        } = useUIStore.getState();

        if (!promptNavigatorEnabled || isMobile || isVSCodeRuntime() || activeMainTab !== 'chat') {
          return;
        }

        const hasOverlay = isSettingsDialogOpen
          || isCommandPaletteOpen
          || isHelpDialogOpen
          || isSessionSwitcherOpen
          || isAboutDialogOpen
          || isTimelineDialogOpen
          || isMultiRunLauncherOpen
          || isImagePreviewOpen;

        if (hasOverlay) {
          return;
        }

        e.preventDefault();
        togglePromptNavigatorPanel();
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

      if (canUseElectronDesktopIPC() && eventMatchesShortcut(e, combo('new_mini_chat'))) {
        e.preventDefault();
        void invokeDesktop('desktop_open_draft_mini_chat_window', {
          directory: currentDirectory || activeProject?.path || '',
          projectId: activeProject?.id ?? null,
        }).catch((error) => {
          console.warn('[keyboard-shortcuts] failed to open draft mini chat window', error);
        });
        return;
      }

      const matchedNewSessionShortcut = eventMatchesShortcut(e, combo('new_chat'));
      const matchedWorktreeShortcut = eventMatchesShortcut(e, combo('new_chat_worktree'));

      if (matchedNewSessionShortcut || matchedWorktreeShortcut) {
        e.preventDefault();

        setActiveMainTab('chat');
        setSessionSwitcherOpen(false);

        if (!isVSCodeRuntime() && matchedWorktreeShortcut) {
          createWorktreeSession();
          return;
        }

        openNewSessionDraft();
        return;
      }

      if (eventMatchesShortcut(e, combo('cycle_theme'))) {
        e.preventDefault();
        if (readEmbeddedThemeSearchParams() !== null && window.parent && window.parent !== window) {
          window.parent.postMessage({ type: 'openchamber:cycle-theme-request' }, window.location.origin);
          return;
        }
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

      const cycleAgentCombo = combo('cycle_agent');
      const cycleAgentBackwardCombo = cycleAgentCombo && !cycleAgentCombo.includes('shift')
        ? normalizeCombo(`shift+${cycleAgentCombo}`)
        : '';
      const cycleAgentDirection = cycleAgentBackwardCombo && eventMatchesShortcut(e, cycleAgentBackwardCombo)
        ? -1
        : eventMatchesShortcut(e, cycleAgentCombo)
          ? 1
          : 0;

      if (cycleAgentDirection !== 0) {
        const {
          isSettingsDialogOpen,
          isCommandPaletteOpen,
          isHelpDialogOpen,
          isSessionSwitcherOpen,
          isAboutDialogOpen,
          activeMainTab,
        } = useUIStore.getState();

        const hasOverlay = isSettingsDialogOpen || isCommandPaletteOpen || isHelpDialogOpen || isSessionSwitcherOpen || isAboutDialogOpen;
        if (hasOverlay || activeMainTab !== 'chat' || !isChatInputTarget(e.target)) {
          return;
        }

        const configState = useConfigStore.getState();
        const nextAgentName = getCycledPrimaryAgentName(
          configState.getVisibleAgents(),
          configState.currentAgentName,
          cycleAgentDirection,
        );

        if (!nextAgentName) {
          return;
        }

        e.preventDefault();
        configState.setAgent(nextAgentName);
        useUIStore.getState().addRecentAgent(nextAgentName);

        const sessionId = useSessionUIStore.getState().currentSessionId;
        if (sessionId) {
          useSelectionStore.getState().saveSessionAgentSelection(sessionId, nextAgentName);
        }
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

        const tabs = ['git', 'files', 'context'] as const;
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
        const sessionId = useSessionUIStore.getState().currentSessionId;
        const agentName = useConfigStore.getState().currentAgentName;
        const providerId = useConfigStore.getState().currentProviderId;
        const modelId = useConfigStore.getState().currentModelId;

        if (sessionId && agentName && providerId && modelId) {
          useSelectionStore.getState().saveAgentModelVariantForSession(sessionId, agentName, providerId, modelId, nextVariant);
        }

        return;
      }

      // Ctrl+] / Ctrl+[: Cycle through starred models (same gating as Shift+M)
      if (
        eventMatchesShortcut(e, combo('cycle_favorite_model_forward')) ||
        eventMatchesShortcut(e, combo('cycle_favorite_model_backward'))
      ) {
        const {
          isSettingsDialogOpen,
          isCommandPaletteOpen,
          isHelpDialogOpen,
          isSessionSwitcherOpen,
          isAboutDialogOpen,
          activeMainTab,
          favoriteModels,
          addRecentModel,
        } = useUIStore.getState();

        if (isSettingsDialogOpen) {
          return;
        }

        const hasOverlay = isCommandPaletteOpen || isHelpDialogOpen || isSessionSwitcherOpen || isAboutDialogOpen;
        const isChatActive = activeMainTab === 'chat';

        if (hasOverlay || !isChatActive || favoriteModels.length === 0) {
          return;
        }

        e.preventDefault();

        const { currentProviderId, currentModelId, setProvider, setModel } = useConfigStore.getState();
        const len = favoriteModels.length;
        const currentIdx = favoriteModels.findIndex(
          (f) => f.providerID === currentProviderId && f.modelID === currentModelId,
        );
        const delta = eventMatchesShortcut(e, combo('cycle_favorite_model_forward')) ? 1 : -1;
        const next = favoriteModels[(currentIdx + delta + len) % len];

        setProvider(next.providerID);
        setModel(next.modelID);
        addRecentModel(next.providerID, next.modelID);
        return;
      }

      if (
        eventMatchesShortcut(e, combo('cycle_session_mru_forward')) ||
        eventMatchesShortcut(e, combo('cycle_session_mru_backward'))
      ) {
        if (e.repeat) {
          e.preventDefault();
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
          isModelSelectorOpen,
          isTimelineDialogOpen,
          isSessionPickerOpen,
          activeMainTab,
        } = useUIStore.getState();

        const hasOverlay = isSettingsDialogOpen
          || isCommandPaletteOpen
          || isHelpDialogOpen
          || isSessionSwitcherOpen
          || isAboutDialogOpen
          || isMultiRunLauncherOpen
          || isImagePreviewOpen
          || isModelSelectorOpen
          || isTimelineDialogOpen
          || isSessionPickerOpen;
        if (hasOverlay || activeMainTab !== 'chat') {
          return;
        }

        const direction: 1 | -1 = eventMatchesShortcut(e, combo('cycle_session_mru_forward'))
          ? 1
          : -1;

        const sessionMap = getAllSyncSessionMap();
        const currentSid = currentSessionIdRef.current;
        const recentSessions = Array.from(sessionMap.values())
          .filter((s) => s.id !== currentSid && !s.time?.archived)
          .sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))
          .map((s) => s.id);
        sessionMRU.seedIfEmpty(recentSessions);

        let targetSessionId: string | null = null;
        for (let attempt = 0; attempt < 60; attempt++) {
          const candidate = sessionMRU.cycle(direction);
          if (!candidate) break;

          const session = sessionMap.get(candidate);
          if (!session || session.time?.archived) {
            sessionMRU.removeSession(candidate);
            continue;
          }

          targetSessionId = candidate;
          break;
        }

        if (!targetSessionId) {
          return;
        }

        e.preventDefault();
        useSessionUIStore.getState().setCurrentSession(targetSessionId);
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

      if (eventMatchesShortcut(e, combo('toggle_dictation'))) {
        const { activeMainTab, isCommandPaletteOpen, isHelpDialogOpen, isSessionSwitcherOpen, isSettingsDialogOpen } = useUIStore.getState();
        if (activeMainTab !== 'chat' || isCommandPaletteOpen || isHelpDialogOpen || isSessionSwitcherOpen || isSettingsDialogOpen) {
          return;
        }
        e.preventDefault();
        // Dictation state lives inside the composer's isolated component;
        // toggle it via an event instead of subscribing this hot hook to it.
        window.dispatchEvent(new CustomEvent('openchamber:dictation-toggle'));
        return;
      }

      if (e.key === 'Escape') {
        const target = e.target as Element | null;
        const isInsideDialog = Boolean(target?.closest('[role="dialog"]'));
        const isSettingsMounted = Boolean(document.querySelector('[data-settings-view="true"]'));
        const isInsideTerminal = isTerminalEventTarget(target);
        const hasDropdownInteraction = isDropdownEventTarget(target) || hasOpenDropdown();

        const {
          isSettingsDialogOpen,
          isCommandPaletteOpen,
          isHelpDialogOpen,
          isSessionSwitcherOpen,
          isAboutDialogOpen,
          isMultiRunLauncherOpen,
          isImagePreviewOpen,
          activeMainTab,
          isPromptNavigatorPanelOpen,
        } = useUIStore.getState();

        if (isInsideDialog || isInsideTerminal || hasDropdownInteraction) {
          resetAbortPriming();
          return;
        }

        if (isPromptNavigatorPanelOpen) {
          e.preventDefault();
          setPromptNavigatorPanelOpen(false);
          resetAbortPriming();
          return;
        }

        // If settings is open, close it
        if (isSettingsDialogOpen) {
          e.preventDefault();
          setSettingsDialogOpen(false);
          resetAbortPriming();
          return;
        }

        if (isSettingsMounted) {
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
        const sessionId = currentSessionIdRef.current;
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
          void abortCurrentOperation(sessionId ?? '');
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

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Control' || e.key === 'Meta') {
        sessionMRU.resetCursor();
      }
    };

    window.addEventListener('keydown', handleTerminalShortcutCapture, true);
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    return () => {
      window.removeEventListener('keydown', handleTerminalShortcutCapture, true);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
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
    setTimelineDialogOpen,
    setSessionPickerOpen,
    togglePromptNavigatorPanel,
    setPromptNavigatorPanelOpen,
    toggleExpandedInput,
    setThemeMode,
    working,
    armAbortPrompt,
    resetAbortPriming,
    currentDirectory,
    activeProject?.id,
    activeProject?.path,
    shortcutOverrides,
  ]);

  React.useEffect(() => {
    return () => {
      resetAbortPriming();
    };
  }, [resetAbortPriming]);
};
