import React from 'react';
import { isTerminalEventTarget } from '@/lib/terminalFocus';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSelectionStore } from '@/sync/selection-store';
import * as sessionActions from '@/sync/session-actions';
import { normalizeContextPanelDirectoryKey, useUIStore } from '@/stores/useUIStore';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useCurrentSessionActivity } from '@/hooks/useSessionActivity';
import { createWorktreeSession } from '@/lib/worktreeSessionCreator';
import { useConfigStore } from '@/stores/useConfigStore';
import { canUseElectronDesktopIPC, invokeDesktop, isVSCodeRuntime } from '@/lib/desktop';
import { showOpenCodeStatus } from '@/lib/openCodeStatus';
import {
  eventMatchesShortcut,
  eventMatchesShortcutPrefix,
  getEffectiveShortcutCombo,
  getEffectiveShortcutPrefix,
  normalizeCombo,
} from '@/lib/shortcuts';
import { getVisibleContextRailSurfaces } from '@/lib/surfaces/registry';
import { readEmbeddedThemeSearchParams } from '@/contexts/theme-embedded-bootstrap';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useFeatureFlagsStore } from '@/stores/useFeatureFlagsStore';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { getCycledPrimaryAgentName } from '@/components/chat/mobileControlsUtils';
import { focusChatInput } from '@/components/chat/composer/editor/dom';
import { addSelectionToChat } from '@/lib/addSelectionToChat';
import { hasOpenDropdown } from './keyboard-shortcut-dom';

export const useKeyboardShortcuts = () => {
  const openNewSessionDraft = useSessionUIStore((s) => s.openNewSessionDraft);
  const armAbortPrompt = useSessionUIStore((s) => s.armAbortPrompt);
  const clearAbortPrompt = useSessionUIStore((s) => s.clearAbortPrompt);
  const currentSessionId = useSessionUIStore((s) => s.currentSessionId);
  const abortCurrentOperation = sessionActions.abortCurrentOperation;
  const toggleCommandPalette = useUIStore((s) => s.toggleCommandPalette);
  const toggleHelpDialog = useUIStore((s) => s.toggleHelpDialog);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const currentShortcutDirectory = useDirectoryStore((s) => s.currentDirectory);
  const effectiveDirectory = useEffectiveDirectory();

  // The terminal lives in the context panel; these mirror the rail behavior.
  const toggleTerminalSurface = React.useCallback(() => {
    if (!currentShortcutDirectory) return;
    useUIStore.getState().openContextSurface(normalizeContextPanelDirectoryKey(currentShortcutDirectory), 'terminal');
  }, [currentShortcutDirectory]);

  const toggleTerminalSurfaceExpanded = React.useCallback(() => {
    if (!currentShortcutDirectory) return;
    const key = normalizeContextPanelDirectoryKey(currentShortcutDirectory);
    const state = useUIStore.getState();
    const panel = state.contextPanelByDirectory[key];
    const activeMode = panel?.isOpen ? panel.tabs.find((tab) => tab.id === panel.activeTabId)?.mode : null;
    if (activeMode !== 'terminal') {
      state.openContextSurface(key, 'terminal');
    }
    state.toggleContextPanelExpanded(key);
  }, [currentShortcutDirectory]);
  const isMobile = useUIStore((s) => s.isMobile);
  const setSessionSwitcherOpen = useUIStore((s) => s.setSessionSwitcherOpen);
  const setActiveMainTab = useUIStore((s) => s.setActiveMainTab);
  const setSettingsDialogOpen = useUIStore((s) => s.setSettingsDialogOpen);
  const setModelSelectorOpen = useUIStore((s) => s.setModelSelectorOpen);
  const setTimelineDialogOpen = useUIStore((s) => s.setTimelineDialogOpen);
  const togglePromptNavigatorPanel = useUIStore((s) => s.togglePromptNavigatorPanel);
  const setPromptNavigatorPanelOpen = useUIStore((s) => s.setPromptNavigatorPanelOpen);
  const toggleExpandedInput = useUIStore((s) => s.toggleExpandedInput);
  const shortcutOverrides = useUIStore((s) => s.shortcutOverrides);
  const currentDirectory = useDirectoryStore((s) => s.currentDirectory);
  const activeProject = useProjectsStore((s) => s.getActiveProject());
  const { themeMode, setThemeMode } = useThemeSystem();
  const { phase: sessionPhase } = useCurrentSessionActivity();
  const abortPrimedUntilRef = React.useRef<number | null>(null);
  const abortPrimedTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const themeModeRef = React.useRef(themeMode);
  // Currently held physical keys (lowercased), used to match chord prefixes
  // whose primary key must be held while the activating key is pressed.
  const heldKeysRef = React.useRef<Set<string>>(new Set());

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
    const switchSurfacePrefix = getEffectiveShortcutPrefix('switch_context_surface', shortcutOverrides);
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
        toggleTerminalSurface();
        return;
      }

      if (eventMatchesShortcut(e, combo('toggle_terminal_expanded'))) {
        const { isMobile } = useUIStore.getState();
        if (isMobile) {
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        toggleTerminalSurfaceExpanded();
        return;
      }
    };

    const handleEscapeKeyDownCapture = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;

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

      const hasOverlay = isCommandPaletteOpen || isHelpDialogOpen || isSessionSwitcherOpen || isAboutDialogOpen || isMultiRunLauncherOpen || isImagePreviewOpen;
      const isChatActive = activeMainTab === 'chat';

      if (hasOverlay || !isChatActive) {
        resetAbortPriming();
        return;
      }

      const sessionId = currentSessionId;
      if (sessionPhase === 'idle' || !sessionId) {
        resetAbortPriming();
        return;
      }

      const now = Date.now();
      const primedUntil = abortPrimedUntilRef.current;

      if (primedUntil && now < primedUntil) {
        e.preventDefault();
        resetAbortPriming();
        void abortCurrentOperation(sessionId);
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
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || isTerminalEventTarget(e.target)) {
        return;
      }

      const isChatInputTarget = (target: EventTarget | null) => {
        return target instanceof Element && Boolean(target.closest('[data-chat-input="true"]'));
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

      if (eventMatchesShortcut(e, combo('add_selection_to_chat'))) {
        e.preventDefault();
        addSelectionToChat();
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
        focusChatInput();
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

      // Legacy right-sidebar shortcuts now target the context surfaces that
      // replaced the sidebar's tabs.
      if (eventMatchesShortcut(e, combo('toggle_right_sidebar'))) {
        const state = useUIStore.getState();
        if (state.isMobile || !currentDirectory) {
          return;
        }
        e.preventDefault();
        const directory = normalizeContextPanelDirectoryKey(currentDirectory);
        const panelState = state.contextPanelByDirectory[directory];
        if (panelState?.isOpen) {
          state.closeContextPanel(directory);
        } else if (panelState?.activeTabId) {
          state.setActiveContextPanelTab(directory, panelState.activeTabId);
        } else {
          state.openContextSurface(directory, 'git');
        }
        return;
      }

      if (eventMatchesShortcut(e, combo('open_right_sidebar_git'))) {
        const state = useUIStore.getState();
        if (state.isMobile || !currentDirectory) {
          return;
        }
        e.preventDefault();
        state.openContextSurface(normalizeContextPanelDirectoryKey(currentDirectory), 'git');
        return;
      }

      if (eventMatchesShortcut(e, combo('open_right_sidebar_files'))) {
        const state = useUIStore.getState();
        if (state.isMobile || !currentDirectory) {
          return;
        }
        e.preventDefault();
        state.openContextSurface(normalizeContextPanelDirectoryKey(currentDirectory), 'file');
        return;
      }

      if (eventMatchesShortcut(e, combo('toggle_terminal'))) {
        const { isMobile } = useUIStore.getState();
        if (isMobile) {
          return;
        }
        e.preventDefault();
        toggleTerminalSurface();
        return;
      }

      if (eventMatchesShortcut(e, combo('toggle_terminal_expanded'))) {
        const { isMobile } = useUIStore.getState();
        if (isMobile) {
          return;
        }
        e.preventDefault();
        toggleTerminalSurfaceExpanded();
        return;
      }

      // Configured prefix + digit (default: Cmd/Ctrl + 1..9, with 0 for the
      // 10th surface): open/close the matching context panel rail surface. The
      // digit maps to the currently visible rail order, matching the number
      // badges shown while holding the modifier. `e.repeat` guard keeps
      // holding a digit from toggling.
      const switchSurfaceDigit = e.key.length === 1 && e.key >= '0' && e.key <= '9'
        ? (e.key === '0' ? 10 : Number(e.key))
        : null;
      if (switchSurfaceDigit !== null
        && !e.repeat
        && eventMatchesShortcutPrefix(e, switchSurfacePrefix, heldKeysRef.current)) {
        const state = useUIStore.getState();
        if (state.isMobile || !effectiveDirectory) {
          return;
        }
        const directory = normalizeContextPanelDirectoryKey(effectiveDirectory);
        const panelState = state.contextPanelByDirectory[directory];
        const visibleSurfaces = getVisibleContextRailSurfaces({
          railOrder: state.contextRailOrder,
          planModeEnabled: useFeatureFlagsStore.getState().planModeEnabled,
          isVSCode: isVSCodeRuntime(),
          screenWidth: window.innerWidth,
          tabs: panelState?.tabs ?? [],
        });
        const target = visibleSurfaces[switchSurfaceDigit - 1];
        if (!target) {
          return;
        }
        e.preventDefault();
        state.openContextSurface(directory, target.mode);
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

    };

    // Track held physical keys so chord prefixes (e.g. a configured
    // `mod+p`) can require their primary key to stay held. Capture phase runs
    // before handleKeyDown, so the set is current when chord matching runs.
    const handleKeyHoldDown = (e: KeyboardEvent) => {
      heldKeysRef.current.add(e.key.toLowerCase());
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      heldKeysRef.current.delete(e.key.toLowerCase());
    };
    const handleWindowBlur = () => {
      heldKeysRef.current.clear();
    };

    window.addEventListener('keydown', handleKeyHoldDown, true);
    window.addEventListener('keyup', handleKeyUp, true);
    window.addEventListener('blur', handleWindowBlur);
    window.addEventListener('keydown', handleTerminalShortcutCapture, true);
    window.addEventListener('keydown', handleEscapeKeyDownCapture, true);
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('keydown', handleKeyHoldDown, true);
      window.removeEventListener('keyup', handleKeyUp, true);
      window.removeEventListener('blur', handleWindowBlur);
      window.removeEventListener('keydown', handleTerminalShortcutCapture, true);
      window.removeEventListener('keydown', handleEscapeKeyDownCapture, true);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [
    openNewSessionDraft,
    abortCurrentOperation,
    toggleCommandPalette,
    toggleHelpDialog,
    toggleSidebar,
    toggleTerminalSurface,
    toggleTerminalSurfaceExpanded,
    isMobile,
    setSessionSwitcherOpen,
    setActiveMainTab,
    setSettingsDialogOpen,
    setModelSelectorOpen,
    setTimelineDialogOpen,
    togglePromptNavigatorPanel,
    setPromptNavigatorPanelOpen,
    toggleExpandedInput,
    setThemeMode,
    sessionPhase,
    armAbortPrompt,
    resetAbortPriming,
    currentSessionId,
    currentDirectory,
    effectiveDirectory,
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
