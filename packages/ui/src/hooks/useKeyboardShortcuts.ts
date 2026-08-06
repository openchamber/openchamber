import React from 'react';
import { isTerminalEventTarget } from '@/lib/terminalFocus';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSelectionStore } from '@/sync/selection-store';
import * as sessionActions from '@/sync/session-actions';
import { normalizeContextPanelDirectoryKey, useUIStore } from '@/stores/useUIStore';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useCurrentSessionActivity } from '@/hooks/useSessionActivity';
import { useKeybinds } from '@/hooks/useKeybind';
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
  ShortcutDispatcher,
  shortcutRegistry,
  type ShortcutActionId,
} from '@/lib/shortcuts';
import { ShortcutRegistry } from '@/lib/shortcuts/registry';
import { getVisibleContextRailSurfaces } from '@/lib/surfaces/registry';
import { readEmbeddedThemeSearchParams } from '@/contexts/theme-embedded-bootstrap';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useFeatureFlagsStore } from '@/stores/useFeatureFlagsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { getCycledPrimaryAgentName } from '@/components/chat/mobileControlsUtils';
import { focusChatInput } from '@/components/chat/composer/editor/dom';
import {
  dismissActiveSelectionToolbar,
  getActiveSelectionToolbarVersion,
  hasActiveSelectionToolbar,
  invokeActiveSelectionAddToChat,
} from '@/lib/addSelectionToChat';
import { isIMECompositionEvent } from '@/lib/ime';
import { hasOpenDropdown, shouldStopDropdownImeEscape } from './keyboard-shortcut-dom';

const dropdownTargetSelector = [
  '[data-slot="dropdown-menu-content"]', '[data-slot="select-content"]', '[role="combobox"]',
  '[role="listbox"]', '[role="menu"]', '[role="menuitem"]', '[role="option"]',
  '[data-radix-popper-content-wrapper]',
].join(',');

export const useKeyboardShortcuts = () => {
  const openNewSessionDraft = useSessionUIStore((s) => s.openNewSessionDraft);
  const armAbortPrompt = useSessionUIStore((s) => s.armAbortPrompt);
  const clearAbortPrompt = useSessionUIStore((s) => s.clearAbortPrompt);
  const currentSessionId = useSessionUIStore((s) => s.currentSessionId);
  const currentDirectory = useDirectoryStore((s) => s.currentDirectory);
  const effectiveDirectory = useEffectiveDirectory();
  const activeProject = useProjectsStore((s) => s.getActiveProject());
  const { themeMode, setThemeMode } = useThemeSystem();
  const { phase: sessionPhase } = useCurrentSessionActivity();
  const abortPrimedUntilRef = React.useRef<number | null>(null);
  const abortPrimedTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const themeModeRef = React.useRef(themeMode);
  const dispatcherRef = React.useRef<ShortcutDispatcher | null>(null);
  const selectionToolbarDispatcherRef = React.useRef<ShortcutDispatcher | null>(null);
  const selectionToolbarVersionRef = React.useRef(-1);
  const heldKeysRef = React.useRef<Set<string>>(new Set());

  if (!dispatcherRef.current) {
    dispatcherRef.current = new ShortcutDispatcher({
      registry: shortcutRegistry,
      getBinding: (actionId) => getEffectiveShortcutCombo(
        actionId,
        useUIStore.getState().shortcutOverrides,
      ),
    });
  }
  const dispatcher = dispatcherRef.current;
  if (!selectionToolbarDispatcherRef.current) {
    const registry = new ShortcutRegistry();
    registry.register('add_selection_to_chat', invokeActiveSelectionAddToChat);
    selectionToolbarDispatcherRef.current = new ShortcutDispatcher({
      registry,
      getBinding: () => getEffectiveShortcutCombo(
        'add_selection_to_chat',
        useUIStore.getState().shortcutOverrides,
      ),
    });
  }
  const selectionToolbarDispatcher = selectionToolbarDispatcherRef.current;

  React.useEffect(() => { themeModeRef.current = themeMode; }, [themeMode]);

  const resetAbortPriming = React.useCallback(() => {
    if (abortPrimedTimeoutRef.current) {
      clearTimeout(abortPrimedTimeoutRef.current);
      abortPrimedTimeoutRef.current = null;
    }
    abortPrimedUntilRef.current = null;
    clearAbortPrompt();
  }, [clearAbortPrompt]);

  const toggleTerminalSurface = () => {
    if (!currentDirectory) return;
    useUIStore.getState().openContextSurface(normalizeContextPanelDirectoryKey(currentDirectory), 'terminal');
  };

  const toggleTerminalSurfaceExpanded = () => {
    if (!currentDirectory) return;
    const key = normalizeContextPanelDirectoryKey(currentDirectory);
    const state = useUIStore.getState();
    const panel = state.contextPanelByDirectory[key];
    if (panel?.isOpen ? panel.tabs.find((tab) => tab.id === panel.activeTabId)?.mode !== 'terminal' : true) {
      state.openContextSurface(key, 'terminal');
    }
    state.toggleContextPanelExpanded(key);
  };

  useKeybinds({
    open_command_palette: () => {
      useUIStore.getState().toggleCommandPalette();
    },
    open_timeline_dialog: () => {
      useUIStore.getState().setTimelineDialogOpen(true);
    },
    open_session_list: () => {
      const state = useUIStore.getState();
      if (state.isMobile) state.setSessionSwitcherOpen(true);
      else state.setSessionDropdownOpen(true);
    },
    toggle_prompt_navigator: () => {
      const state = useUIStore.getState();
      const hasOverlay = state.isSettingsDialogOpen
        || state.isCommandPaletteOpen
        || state.isHelpDialogOpen
        || state.isSessionSwitcherOpen
        || state.isAboutDialogOpen
        || state.isTimelineDialogOpen
        || state.isMultiRunLauncherOpen
        || state.isImagePreviewOpen;
      if (
        !state.promptNavigatorEnabled
        || state.isMobile
        || isVSCodeRuntime()
        || state.activeMainTab !== 'chat'
        || hasOverlay
      ) {
        return false;
      }
      state.togglePromptNavigatorPanel();
    },
    open_status: () => {
      void showOpenCodeStatus();
    },
    open_help: () => {
      useUIStore.getState().toggleHelpDialog();
    },
    new_mini_chat: () => {
      if (!canUseElectronDesktopIPC()) return false;
      void invokeDesktop('desktop_open_draft_mini_chat_window', {
        directory: currentDirectory || activeProject?.path || '',
        projectId: activeProject?.id ?? null,
      }).catch((error) => {
        console.warn('[keyboard-shortcuts] failed to open draft mini chat window', error);
      });
    },
    new_chat: () => {
      const state = useUIStore.getState();
      state.setActiveMainTab('chat');
      state.setSessionSwitcherOpen(false);
      openNewSessionDraft();
    },
    new_chat_worktree: () => {
      const state = useUIStore.getState();
      state.setActiveMainTab('chat');
      state.setSessionSwitcherOpen(false);
      if (!isVSCodeRuntime()) {
        createWorktreeSession();
        return;
      }
      openNewSessionDraft();
    },
    cycle_theme: () => {
      if (readEmbeddedThemeSearchParams() !== null && window.parent && window.parent !== window) {
        window.parent.postMessage({ type: 'openchamber:cycle-theme-request' }, window.location.origin);
        return;
      }
      const modes: Array<'light' | 'dark' | 'system'> = ['light', 'dark', 'system'];
      const activeElement = document.activeElement as HTMLElement | null;
      setThemeMode(modes[(modes.indexOf(themeModeRef.current) + 1) % modes.length]);
      requestAnimationFrame(() => {
        if (!document.hasFocus()) window.focus();
        if (activeElement && document.contains(activeElement)) activeElement.focus({ preventScroll: true });
      });
    },
    open_settings: () => {
      const state = useUIStore.getState();
      state.setSettingsDialogOpen(!state.isSettingsDialogOpen);
    },
    add_selection_to_chat: invokeActiveSelectionAddToChat,
    toggle_sidebar: () => {
      const state = useUIStore.getState();
      if (state.isMobile) state.setSessionSwitcherOpen(!state.isSessionSwitcherOpen);
      else state.toggleSidebar();
    },
    focus_input: () => {
      focusChatInput();
    },
    cycle_agent: (event) => {
      const state = useUIStore.getState();
      const hasOverlay = state.isSettingsDialogOpen
        || state.isCommandPaletteOpen
        || state.isHelpDialogOpen
        || state.isSessionSwitcherOpen
        || state.isAboutDialogOpen;
      const isChatInputTarget = event.target instanceof Element
        && Boolean(event.target.closest('[data-chat-input="true"]'));
      if (hasOverlay || state.activeMainTab !== 'chat' || !isChatInputTarget) return false;
      const combo = getEffectiveShortcutCombo('cycle_agent', state.shortcutOverrides);
      const backward = combo && !combo.includes('shift') ? normalizeCombo(`shift+${combo}`) : '';
      const direction = backward && eventMatchesShortcut(event, backward) ? -1 : 1;
      const config = useConfigStore.getState();
      const next = getCycledPrimaryAgentName(config.getVisibleAgents(), config.currentAgentName, direction);
      if (!next) return false;
      config.setAgent(next);
      state.addRecentAgent(next);
      const sessionId = useSessionUIStore.getState().currentSessionId;
      if (sessionId) {
        useSelectionStore.getState().saveSessionAgentSelection(sessionId, next);
      }
    },
    toggle_right_sidebar: () => {
      const state = useUIStore.getState();
      if (state.isMobile || !currentDirectory) return false;
      const directory = normalizeContextPanelDirectoryKey(currentDirectory);
      const panel = state.contextPanelByDirectory[directory];
      if (panel?.isOpen) state.closeContextPanel(directory);
      else if (panel?.activeTabId) state.setActiveContextPanelTab(directory, panel.activeTabId);
      else state.openContextSurface(directory, 'git');
    },
    open_right_sidebar_git: () => {
      const state = useUIStore.getState();
      if (state.isMobile || !currentDirectory) return false;
      state.openContextSurface(normalizeContextPanelDirectoryKey(currentDirectory), 'git');
    },
    open_right_sidebar_files: () => {
      const state = useUIStore.getState();
      if (state.isMobile || !currentDirectory) return false;
      state.openContextSurface(normalizeContextPanelDirectoryKey(currentDirectory), 'file');
    },
    toggle_terminal: () => {
      if (useUIStore.getState().isMobile) return false;
      return toggleTerminalSurface();
    },
    toggle_terminal_expanded: () => {
      if (useUIStore.getState().isMobile) return false;
      return toggleTerminalSurfaceExpanded();
    },
    open_model_selector: () => {
      const state = useUIStore.getState();
      const hasOverlay = state.isCommandPaletteOpen
        || state.isHelpDialogOpen
        || state.isSessionSwitcherOpen
        || state.isAboutDialogOpen;
      if (state.isSettingsDialogOpen || hasOverlay || state.activeMainTab !== 'chat') return false;
      state.setModelSelectorOpen(!state.isModelSelectorOpen);
    },
    cycle_thinking_variant: () => {
      const state = useUIStore.getState();
      const hasOverlay = state.isCommandPaletteOpen
        || state.isHelpDialogOpen
        || state.isSessionSwitcherOpen
        || state.isAboutDialogOpen;
      if (state.isSettingsDialogOpen || hasOverlay || state.activeMainTab !== 'chat') return false;
      const config = useConfigStore.getState();
      if (config.getCurrentModelVariants().length === 0) return false;
      config.cycleCurrentVariant();
      const sessionId = useSessionUIStore.getState().currentSessionId;
      const { currentVariant, currentAgentName, currentProviderId, currentModelId } = useConfigStore.getState();
      if (sessionId && currentAgentName && currentProviderId && currentModelId) {
        useSelectionStore.getState().saveAgentModelVariantForSession(
          sessionId,
          currentAgentName,
          currentProviderId,
          currentModelId,
          currentVariant,
        );
      }
    },
    cycle_favorite_model_forward: () => cycleFavoriteModel(1),
    cycle_favorite_model_backward: () => cycleFavoriteModel(-1),
    expand_input: () => {
      if (useUIStore.getState().isMobile) return false;
      useUIStore.getState().toggleExpandedInput();
    },
    toggle_dictation: () => {
      const state = useUIStore.getState();
      if (
        state.activeMainTab !== 'chat'
        || state.isCommandPaletteOpen
        || state.isHelpDialogOpen
        || state.isSessionSwitcherOpen
        || state.isSettingsDialogOpen
      ) {
        return false;
      }
      window.dispatchEvent(new CustomEvent('openchamber:dictation-toggle'));
    },
    abort_run: () => {
      if (sessionPhase === 'idle' || !currentSessionId) return false;
      void sessionActions.abortCurrentOperation(currentSessionId);
    },
  });

  function cycleFavoriteModel(delta: number): boolean | void {
    const state = useUIStore.getState();
    const hasOverlay = state.isCommandPaletteOpen
      || state.isHelpDialogOpen
      || state.isSessionSwitcherOpen
      || state.isAboutDialogOpen;
    if (
      state.isSettingsDialogOpen
      || hasOverlay
      || state.activeMainTab !== 'chat'
      || state.favoriteModels.length === 0
    ) {
      return false;
    }
    const config = useConfigStore.getState();
    const index = state.favoriteModels.findIndex((model) => (
      model.providerID === config.currentProviderId && model.modelID === config.currentModelId
    ));
    const next = state.favoriteModels[(index + delta + state.favoriteModels.length) % state.favoriteModels.length];
    config.setProvider(next.providerID);
    config.setModel(next.modelID);
    state.addRecentModel(next.providerID, next.modelID);
  }

  React.useEffect(() => {
    const invokeRegistered = (actionId: ShortcutActionId, event: KeyboardEvent): boolean => {
      const handler = shortcutRegistry.get(actionId);
      return handler ? handler(event) !== false : false;
    };
    const handleTerminalShortcutCapture = (event: KeyboardEvent) => {
      if (!isTerminalEventTarget(event.target)) return;
      const getBinding = (actionId: ShortcutActionId) => getEffectiveShortcutCombo(
        actionId,
        useUIStore.getState().shortcutOverrides,
      );
      const actionId = eventMatchesShortcut(event, getBinding('toggle_terminal')) ? 'toggle_terminal'
        : eventMatchesShortcut(event, getBinding('toggle_terminal_expanded')) ? 'toggle_terminal_expanded' : null;
      if (actionId && invokeRegistered(actionId, event)) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    const handleSelectionToolbarKeyDownCapture = (event: KeyboardEvent) => {
      const version = getActiveSelectionToolbarVersion();
      if (selectionToolbarVersionRef.current !== version) {
        selectionToolbarVersionRef.current = version;
        selectionToolbarDispatcher.clear();
      }
      if (!hasActiveSelectionToolbar()) return;
      if (isIMECompositionEvent(event)) {
        selectionToolbarDispatcher.clear();
        if (event.key === 'Escape') {
          event.stopImmediatePropagation();
        }
        return;
      }
      if (event.key === 'Escape') {
        selectionToolbarDispatcher.clear();
        if (dismissActiveSelectionToolbar()) {
          event.preventDefault();
          event.stopImmediatePropagation();
          resetAbortPriming();
        }
        return;
      }
      if (selectionToolbarDispatcher.dispatch(event)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    const handleEscapeKeyDownCapture = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (dispatcher.handleEscape()) {
        event.preventDefault();
        resetAbortPriming();
        return;
      }
      const target = event.target as Element | null;
      const state = useUIStore.getState();
      const isDropdownTarget = target instanceof Element
        && target.closest(dropdownTargetSelector);
      const dropdownOpen = Boolean(isDropdownTarget || hasOpenDropdown());
      if (shouldStopDropdownImeEscape(event, dropdownOpen)) {
        event.stopImmediatePropagation();
        resetAbortPriming();
        return;
      }
      if (
        target?.closest('[role="dialog"]')
        || isTerminalEventTarget(target)
        || dropdownOpen
      ) {
        resetAbortPriming();
        return;
      }
      if (state.isPromptNavigatorPanelOpen) {
        event.preventDefault();
        state.setPromptNavigatorPanelOpen(false);
        resetAbortPriming();
        return;
      }
      if (state.isSettingsDialogOpen) {
        event.preventDefault();
        state.setSettingsDialogOpen(false);
        resetAbortPriming();
        return;
      }
      if (document.querySelector('[data-settings-view="true"]')) {
        resetAbortPriming();
        return;
      }
      const hasOverlay = state.isCommandPaletteOpen
        || state.isHelpDialogOpen
        || state.isSessionSwitcherOpen
        || state.isAboutDialogOpen
        || state.isMultiRunLauncherOpen
        || state.isImagePreviewOpen;
      if (
        hasOverlay
        || state.activeMainTab !== 'chat'
        || sessionPhase === 'idle'
        || !currentSessionId
      ) {
        resetAbortPriming();
        return;
      }
      const now = Date.now();
      if (abortPrimedUntilRef.current && now < abortPrimedUntilRef.current) {
        resetAbortPriming();
        if (invokeRegistered('abort_run', event)) event.preventDefault();
        return;
      }
      event.preventDefault();
      const expiresAt = armAbortPrompt(3000) ?? now + 3000;
      abortPrimedUntilRef.current = expiresAt;
      if (abortPrimedTimeoutRef.current) clearTimeout(abortPrimedTimeoutRef.current);
      abortPrimedTimeoutRef.current = setTimeout(() => {
        if (abortPrimedUntilRef.current && Date.now() >= abortPrimedUntilRef.current) {
          resetAbortPriming();
        }
      }, Math.max(expiresAt - now, 0));
    };
    const handleActivePrefixKeyDownCapture = (event: KeyboardEvent) => {
      if (isTerminalEventTarget(event.target)) return;
      if (!dispatcher.hasActivePrefix()) return;
      if (dispatcher.dispatchActivePrefix(event)) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (dispatcher.consumeCapturedPrefixEvent(event)) return;
      if (event.key === 'Escape' || isTerminalEventTarget(event.target)) return;
      if (shortcutRegistry.isSuspended() || hasActiveSelectionToolbar()) return;
      const combo = getEffectiveShortcutCombo('cycle_agent', useUIStore.getState().shortcutOverrides);
      const backward = combo && !combo.includes('shift') ? normalizeCombo(`shift+${combo}`) : '';
      if (backward && eventMatchesShortcut(event, backward)) {
        if (invokeRegistered('cycle_agent', event)) event.preventDefault();
        return;
      }

      const switchSurfaceDigit = event.key.length === 1 && event.key >= '0' && event.key <= '9'
        ? (event.key === '0' ? 10 : Number(event.key))
        : null;
      const switchSurfacePrefix = getEffectiveShortcutPrefix(
        'switch_context_surface',
        useUIStore.getState().shortcutOverrides,
      );
      if (
        switchSurfaceDigit !== null
        && !event.repeat
        && eventMatchesShortcutPrefix(event, switchSurfacePrefix, heldKeysRef.current)
      ) {
        const state = useUIStore.getState();
        if (!state.isMobile && effectiveDirectory) {
          const directory = normalizeContextPanelDirectoryKey(effectiveDirectory);
          const panel = state.contextPanelByDirectory[directory];
          const visibleSurfaces = getVisibleContextRailSurfaces({
            railOrder: state.contextRailOrder,
            planModeEnabled: useFeatureFlagsStore.getState().planModeEnabled,
            isVSCode: isVSCodeRuntime(),
            screenWidth: window.innerWidth,
            tabs: panel?.tabs ?? [],
          });
          const target = visibleSurfaces[switchSurfaceDigit - 1];
          if (target) {
            event.preventDefault();
            state.openContextSurface(directory, target.mode);
            return;
          }
        }
      }

      if (dispatcher.dispatch(event)) event.preventDefault();
    };
    const handleKeyHoldDown = (event: KeyboardEvent) => {
      heldKeysRef.current.add(event.key.toLowerCase());
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      heldKeysRef.current.delete(event.key.toLowerCase());
    };
    const handleBlur = () => {
      heldKeysRef.current.clear();
      dispatcher.handleBlur();
      selectionToolbarDispatcher.handleBlur();
    };
    window.addEventListener('keydown', handleKeyHoldDown, true);
    window.addEventListener('keydown', handleSelectionToolbarKeyDownCapture, true);
    window.addEventListener('keyup', handleKeyUp, true);
    window.addEventListener('keydown', handleTerminalShortcutCapture, true);
    window.addEventListener('keydown', handleEscapeKeyDownCapture, true);
    window.addEventListener('keydown', handleActivePrefixKeyDownCapture, true);
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('blur', handleBlur);
    return () => {
      window.removeEventListener('keydown', handleKeyHoldDown, true);
      window.removeEventListener('keydown', handleSelectionToolbarKeyDownCapture, true);
      window.removeEventListener('keyup', handleKeyUp, true);
      window.removeEventListener('keydown', handleTerminalShortcutCapture, true);
      window.removeEventListener('keydown', handleEscapeKeyDownCapture, true);
      window.removeEventListener('keydown', handleActivePrefixKeyDownCapture, true);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('blur', handleBlur);
    };
  }, [armAbortPrompt, currentSessionId, dispatcher, effectiveDirectory, resetAbortPriming, selectionToolbarDispatcher, sessionPhase]);

  React.useEffect(() => () => resetAbortPriming(), [resetAbortPriming]);
};
