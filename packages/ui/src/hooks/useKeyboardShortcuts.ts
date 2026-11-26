import React from 'react';
import { stopCurrentOperation } from '@/sync/prompt-take-back';
import { hasReceivedPages, useReceivedPagesStore } from '@/components/chat/sharePages/received/receivedPagesStore';
import { isVimEditorEventTarget } from '@/lib/editorFocus';
import { getTerminalFocusOwner, isTerminalEventTarget } from '@/lib/terminalFocus';
import { isMobileSurfaceRuntime } from '@/lib/runtimeSurface';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { activateAdjacentSessionTab, activateSessionTabByIndex, closeSessionTabAndActivateNeighbour } from '@/lib/sessionTabs';
import { navigateSessionHistory } from '@/lib/sessionNavigationHistory';
import { useSelectionStore } from '@/sync/selection-store';
import { normalizeContextPanelDirectoryKey, useUIStore } from '@/stores/useUIStore';
import { toggleExpandedContextZone } from '@/lib/workspace/toggleExpandedZone';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useCurrentSessionActivity } from '@/hooks/useSessionActivity';
import { useKeybinds } from '@/hooks/useKeybind';
import { handleSettingsShortcut } from './useSettingsKeyboardShortcuts';
import { createWorktreeSession } from '@/lib/worktreeSessionCreator';
import { activeSpaceTarget, providersOfSpaceOffer, spaceModelOffer } from '@/lib/spaces/space-model-offer';
import { useConfigStore } from '@/stores/useConfigStore';
import { cycleThinkingVariant } from '@/lib/cycleThinkingVariant';
import { canUseElectronDesktopIPC, getMiniChatRuntimeArgs, invokeDesktop, isDesktopShell, isVSCodeRuntime } from '@/lib/desktop';
import {
  eventMatchesShortcut,
  eventMatchesShortcutPrefix,
  getEffectiveShortcutCombo,
  getEffectiveShortcutPrefix,
  normalizeCombo,
  resolveShortcutEventDigit,
  resolveShortcutEventKey,
  ShortcutDispatcher,
  shortcutRegistry,
  type ShortcutActionId,
} from '@/lib/shortcuts';
import { ShortcutRegistry } from '@/lib/shortcuts/registry';
import { enabledGuestSurfaces } from '@/lib/guests/surfaces';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';
import { useGuestsStore } from '@/lib/guests/store';
import { getVisibleContextRailSurfaces } from '@/lib/surfaces/registry';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSourceControlAuthStore } from '@/stores/useSourceControlAuthStore';
import { isWorkflowsSurfaceShown } from '@/lib/workflows/panel';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { getCycledPrimaryAgentName } from '@/components/chat/mobileControlsUtils';
import { focusChatInput } from '@/components/chat/composer/editor/dom';
import { createComposerInputRedirect, type ComposerInputRedirect } from '@/components/chat/composer/editor/inputRedirect';
import {
  addSelectionToChat,
  dismissActiveSelectionToolbar,
  getActiveSelectionToolbarVersion,
  hasActiveSelectionToolbar,
  invokeActiveSelectionAddToChat,
} from '@/lib/addSelectionToChat';
import { isIMECompositionEvent } from '@/lib/ime';
import { useComposerAbortEscape } from './useComposerAbortEscape';
import { getNextFavoriteModel } from '@/lib/modelRefs';
import { dispatchPromptHistorySearch } from '@/components/chat/composer/state/promptHistorySearchRoute';
import { isLinuxPlatform } from '@/lib/platform';
import { openOrToggleLeadDraft } from '@/sync/session-lead';
import { canUseDigitShortcut, hasActiveBtwComposer, hasOpenDropdown, isEditableEventTarget, typesOutsidePrefixField, shouldStopDropdownImeEscape } from './keyboard-shortcut-dom';

const dropdownTargetSelector = [
  '[data-slot="dropdown-menu-content"]', '[data-slot="select-content"]', '[role="combobox"]',
  '[role="listbox"]', '[role="menu"]', '[role="menuitem"]', '[role="option"]',
  '[data-radix-popper-content-wrapper]',
].join(',');

function hasOverlayOpen(): boolean {
  const state = useUIStore.getState();
  return state.isCommandPaletteOpen
    || state.isHelpDialogOpen
    || state.isProjectActionsDialogOpen
    || state.isSessionSwitcherOpen
    || state.isAboutDialogOpen
    || state.isSettingsDialogOpen
    || state.runOverviewKey !== null
    || state.isImagePreviewOpen;
}

export const useKeyboardShortcuts = () => {
  const openNewSessionDraft = useSessionUIStore((s) => s.openNewSessionDraft);
  const currentSessionId = useSessionUIStore((s) => s.currentSessionId);
  const currentDirectory = useDirectoryStore((s) => s.currentDirectory);
  const effectiveDirectory = useEffectiveDirectory();
  const activeProject = useProjectsStore((s) => s.getActiveProject());
  const { themeMode, setThemeMode } = useThemeSystem();
  const { phase: sessionPhase } = useCurrentSessionActivity();
  const { handleKeyDown: handleAbortEscapeKeyDown, reset: resetAbortPriming } = useComposerAbortEscape({
    isBlocked: () => hasOverlayOpen() || hasOpenDropdown(),
    resolveTarget: (target) => {
      const pinnedColumn = target.closest<HTMLElement>('[data-chat-column="pinned"]');
      return pinnedColumn
        ? { sessionId: pinnedColumn.dataset.chatSessionId ?? null, working: pinnedColumn.dataset.chatWorking === 'true' }
        : { sessionId: currentSessionId, working: sessionPhase !== 'idle' };
    },
    abort: (sessionId) => { void stopCurrentOperation(sessionId); },
  });
  const themeModeRef = React.useRef(themeMode);
  const dispatcherRef = React.useRef<ShortcutDispatcher | null>(null);
  const selectionToolbarDispatcherRef = React.useRef<ShortcutDispatcher | null>(null);
  const selectionToolbarVersionRef = React.useRef(-1);
  const heldKeysRef = React.useRef<Set<string>>(new Set());
  const inputRedirectRef = React.useRef<ComposerInputRedirect | null>(null);
  if (!inputRedirectRef.current) inputRedirectRef.current = createComposerInputRedirect();
  const inputRedirect = inputRedirectRef.current;

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

  const toggleTerminalSurface = () => {
    if (!currentDirectory) return;
    useUIStore.getState().openContextSurface(normalizeContextPanelDirectoryKey(currentDirectory), 'terminal');
  };

  useKeybinds({
    open_command_palette: () => {
      if (isVSCodeRuntime()) return false;
      useUIStore.getState().toggleCommandPalette();
    },
    search_prompt_history: (event) => dispatchPromptHistorySearch(event),
    open_timeline_dialog: () => {
      useUIStore.getState().setTimelineDialogOpen(true);
    },
    toggle_source_board: () => {
      const state = useUIStore.getState();
      if (state.isMobile || isVSCodeRuntime()) return false;
      state.setSourceBoardOpen(!state.isSourceBoardOpen);
    },
    open_session_list: () => {
      const state = useUIStore.getState();
      if (state.isMobile) {
        state.setSessionSwitcherOpen(true);
        return;
      }
      if (state.isSidebarOpen) {
        window.dispatchEvent(new CustomEvent('openchamber:sidebar-session-search'));
        return;
      }
      state.setSessionDropdownOpen(true);
    },
    toggle_prompt_navigator: () => {
      const state = useUIStore.getState();
      const hasOverlay = state.isSettingsDialogOpen
        || state.isCommandPaletteOpen
        || state.isHelpDialogOpen
        || state.isSessionSwitcherOpen
        || state.isAboutDialogOpen
        || state.isTimelineDialogOpen
        || state.runOverviewKey !== null
        || state.isImagePreviewOpen;
      if (
        !state.promptNavigatorEnabled
        || state.isMobile
        || hasOverlay
      ) {
        return false;
      }
      state.togglePromptNavigatorPanel();
    },
    open_help: () => {
      useUIStore.getState().toggleHelpDialog();
    },
    open_project_actions: () => {
      const state = useUIStore.getState();
      if (state.isMobile || isVSCodeRuntime()) return false;
      state.setProjectActionsDialogOpen(!state.isProjectActionsDialogOpen);
    },
    new_mini_chat: () => {
      if (!canUseElectronDesktopIPC()) return false;
      void invokeDesktop('desktop_open_draft_mini_chat_window', {
        directory: currentDirectory || activeProject?.path || '',
        projectId: activeProject?.id ?? null,
        ...getMiniChatRuntimeArgs(),
      }).catch((error) => {
        console.warn('[keyboard-shortcuts] failed to open draft mini chat window', error);
      });
    },
    switch_session_previous: () => {
      if (!isVSCodeRuntime() && useUIStore.getState().sessionTabsEnabled && activateAdjacentSessionTab(-1)) return;
      return navigateSessionHistory(-1) ? undefined : false;
    },
    switch_session_next: () => {
      if (!isVSCodeRuntime() && useUIStore.getState().sessionTabsEnabled && activateAdjacentSessionTab(1)) return;
      return navigateSessionHistory(1) ? undefined : false;
    },
    session_history_back: (event) => navigateSessionHistoryByShortcut(event, -1),
    session_history_forward: (event) => navigateSessionHistoryByShortcut(event, 1),
    close_session_tab: () => {
      if (isVSCodeRuntime() || !useUIStore.getState().sessionTabsEnabled) return false;
      if (currentSessionId) {
        closeSessionTabAndActivateNeighbour(currentSessionId);
      }
    },
    new_chat: () => {
      useUIStore.getState().setSessionSwitcherOpen(false);
      openNewSessionDraft(currentSessionId && currentDirectory
        ? { directoryOverride: currentDirectory }
        : undefined);
    },
    new_chat_worktree: () => {
      useUIStore.getState().setSessionSwitcherOpen(false);
      if (!isVSCodeRuntime()) {
        createWorktreeSession();
        return;
      }
      openNewSessionDraft();
    },
    new_lead: () => {
      if (isVSCodeRuntime()) return false;
      useUIStore.getState().setSessionSwitcherOpen(false);
      openOrToggleLeadDraft(currentSessionId && currentDirectory ? { directoryOverride: currentDirectory } : undefined);
    },
    cycle_theme: () => {
      const modes: Array<'light' | 'dark' | 'system'> = ['light', 'dark', 'system'];
      const activeElement = document.activeElement as HTMLElement | null;
      setThemeMode(modes[(modes.indexOf(themeModeRef.current) + 1) % modes.length]);
      requestAnimationFrame(() => {
        if (!document.hasFocus()) window.focus();
        if (activeElement && document.contains(activeElement)) activeElement.focus({ preventScroll: true });
      });
    },
    open_settings: handleSettingsShortcut,
    add_selection_to_chat: () => addSelectionToChat({ focusWhenEmpty: false }),
    toggle_sidebar: () => {
      const state = useUIStore.getState();
      if (state.isMobile) state.setSessionSwitcherOpen(!state.isSessionSwitcherOpen);
      else state.toggleSidebar();
    },
    focus_input: () => {
      focusChatInput();
    },
    cycle_agent: (event) => {
      if (hasActiveBtwComposer()) return false;
      const state = useUIStore.getState();
      const hasOverlay = state.isSettingsDialogOpen
        || state.isCommandPaletteOpen
        || state.isHelpDialogOpen
        || state.isSessionSwitcherOpen
        || state.isAboutDialogOpen;
      const isChatInputTarget = event.target instanceof Element
        && Boolean(event.target.closest('[data-chat-input="true"]'));
      if (hasOverlay || !isChatInputTarget) return false;
      const combo = getEffectiveShortcutCombo('cycle_agent', state.shortcutOverrides);
      const backward = combo && !combo.includes('shift') ? normalizeCombo(`shift+${combo}`) : '';
      const direction = backward && eventMatchesShortcut(event, backward) ? -1 : 1;
      const config = useConfigStore.getState();
      const sessionId = useSessionUIStore.getState().currentSessionId;
      const shownAgent = (sessionId ? useSelectionStore.getState().getSessionAgentPick(sessionId) : null) ?? config.currentAgentName;
      const next = getCycledPrimaryAgentName(config.getVisibleAgents(), shownAgent, direction, state.favoriteAgents);
      if (!next) return false;
      if (sessionId) {
        useSelectionStore.getState().pickSessionAgent(sessionId, next);
      }
      config.setAgent(next);
      state.addRecentAgent(next);
    },
    toggle_terminal: () => {
      if (useUIStore.getState().isMobile || isVSCodeRuntime()) return false;
      return toggleTerminalSurface();
    },
    toggle_context_panel_expanded: () => {
      if (useUIStore.getState().isMobile || isVSCodeRuntime() || !currentDirectory) return false;
      toggleExpandedContextZone(currentDirectory);
    },
    open_model_selector: () => {
      if (hasActiveBtwComposer()) return false;
      const state = useUIStore.getState();
      const hasOverlay = state.isCommandPaletteOpen
        || state.isHelpDialogOpen
        || state.isSessionSwitcherOpen
        || state.isAboutDialogOpen;
      if (state.isSettingsDialogOpen || hasOverlay) return false;
      state.setModelSelectorOpen(!state.isModelSelectorOpen);
    },
    cycle_thinking_variant: () => {
      if (hasActiveBtwComposer()) return false;
      const state = useUIStore.getState();
      const hasOverlay = state.isCommandPaletteOpen
        || state.isHelpDialogOpen
        || state.isSessionSwitcherOpen
        || state.isAboutDialogOpen;
      if (state.isSettingsDialogOpen || hasOverlay) return false;
      if (!cycleThinkingVariant(useSessionUIStore.getState().currentSessionId)) return false;
    },
    cycle_favorite_model_forward: () => cycleFavoriteModel(1),
    cycle_favorite_model_backward: () => cycleFavoriteModel(-1),
    expand_input: () => {
      if (hasActiveBtwComposer()) return false;
      if (useUIStore.getState().isMobile) return false;
      useUIStore.getState().toggleExpandedInput();
    },
    toggle_dictation: () => {
      if (hasActiveBtwComposer()) return false;
      const state = useUIStore.getState();
      if (
        state.isCommandPaletteOpen
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
      void stopCurrentOperation(currentSessionId);
    },
  });

  function navigateSessionHistoryByShortcut(event: KeyboardEvent, delta: -1 | 1): boolean | void {
    if (event.defaultPrevented) return false;
    return navigateSessionHistory(delta) ? undefined : false;
  }

  function cycleFavoriteModel(delta: number): boolean | void {
    if (hasActiveBtwComposer()) return false;
    const state = useUIStore.getState();
    const hasOverlay = state.isCommandPaletteOpen
      || state.isHelpDialogOpen
      || state.isSessionSwitcherOpen
      || state.isAboutDialogOpen;
    if (state.isSettingsDialogOpen || hasOverlay) return false;
    const config = useConfigStore.getState();
    const next = getNextFavoriteModel(
      state.favoriteModels,
      providersOfSpaceOffer(spaceModelOffer(activeSpaceTarget()), config.providers),
      state.hiddenModels,
      { providerID: config.currentProviderId, modelID: config.currentModelId },
      delta,
    );
    if (!next) return false;
    config.setProvider(next.providerID);
    config.setModel(next.modelID);
    const sessionId = useSessionUIStore.getState().currentSessionId;
    if (sessionId) useSelectionStore.getState().pickSessionModel(sessionId, next.providerID, next.modelID);
    state.addRecentModel(next.providerID, next.modelID);
    state.setLastSelectedModel(next.providerID, next.modelID);
  }

  React.useEffect(() => {
    const invokeRegistered = (actionId: ShortcutActionId, event: KeyboardEvent): boolean => {
      const handler = shortcutRegistry.get(actionId);
      return handler ? handler(event) !== false : false;
    };
    const terminalZoomKeyCodes = new Set<string>();
    const handleTerminalShortcutCapture = (event: KeyboardEvent) => {
      if (!isTerminalEventTarget(event.target)) return;
      const getBinding = (actionId: ShortcutActionId) => getEffectiveShortcutCombo(
        actionId,
        useUIStore.getState().shortcutOverrides,
      );
      const actionId = eventMatchesShortcut(event, getBinding('toggle_terminal')) ? 'toggle_terminal'
        : eventMatchesShortcut(event, getBinding('toggle_context_panel_expanded')) ? 'toggle_context_panel_expanded' : null;
      if (actionId && invokeRegistered(actionId, event)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (getTerminalFocusOwner(event.target) === 'main' && !isDesktopShell() && !isVSCodeRuntime() && !isMobileSurfaceRuntime() && !event.defaultPrevented && !isIMECompositionEvent(event)) {
        const zoom = eventMatchesShortcut(event, getBinding('zoom_in')) ? 'zoom-in'
          : eventMatchesShortcut(event, getBinding('zoom_out')) ? 'zoom-out'
          : eventMatchesShortcut(event, getBinding('zoom_reset')) ? 'zoom-reset' : null;
        if (zoom) {
          event.preventDefault();
          event.stopPropagation();
          terminalZoomKeyCodes.add(event.code);
          window.dispatchEvent(new CustomEvent('openchamber:zoom', { detail: zoom }));
          return;
        }
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
        || target?.closest('[data-btw-composer="true"]')
        || isTerminalEventTarget(target)
        || isVimEditorEventTarget(target)
        || dropdownOpen
        || state.isImagePreviewOpen
      ) {
        return;
      }
      if (state.isPromptNavigatorPanelOpen) {
        event.preventDefault();
        state.setPromptNavigatorPanelOpen(false);
        return;
      }
      if (state.isSettingsDialogOpen) {
        event.preventDefault();
        state.setSettingsDialogOpen(false);
      }
    };
    const handlePrefixPress = (event: PointerEvent) => {
      if (isEditableEventTarget(event.target)) dispatcher.clear();
    };
    const handleActivePrefixKeyDownCapture = (event: KeyboardEvent) => {
      if (isTerminalEventTarget(event.target)) return;
      if (!dispatcher.hasActivePrefix()) return;
      if (typesOutsidePrefixField(event, dispatcher.getActivePrefixTarget())) {
        dispatcher.clear();
        return;
      }
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

      const rawDigit = resolveShortcutEventDigit(event);
      const switchSurfaceDigit = rawDigit !== null
        ? (rawDigit === '0' ? 10 : Number(rawDigit))
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
        if (!canUseDigitShortcut(event)) return;
        const state = useUIStore.getState();
        if (!state.isMobile && effectiveDirectory) {
          const directory = normalizeContextPanelDirectoryKey(effectiveDirectory);
          const panel = state.contextPanelByDirectory[directory];
          const visibleSurfaces = getVisibleContextRailSurfaces({
            railOrder: state.contextRailOrder,
            hiddenSurfaces: state.contextRailHiddenSurfaces,
            isVSCode: isVSCodeRuntime(),
            screenWidth: window.innerWidth,
            tabs: panel?.tabs ?? [],
            sourceControlConnected: Object.values(useSourceControlAuthStore.getState().entries).some((entry) => entry.status?.status === 'connected'),
            workflowsShown: isWorkflowsSurfaceShown(panel?.tabs ?? [], effectiveDirectory),
            receivedPagesShown: hasReceivedPages(useReceivedPagesStore.getState()),
            extras: enabledGuestSurfaces(useGuestsStore.getState().guests, getRuntimeUrlResolver().authenticatedAsset),
          });
          const target = visibleSurfaces[switchSurfaceDigit - 1];
          if (target) {
            event.preventDefault();
            state.openContextSurface(directory, target.mode);
            return;
          }
        }
      }

      const sessionTabDigit = rawDigit !== null && rawDigit !== '0' ? Number(rawDigit) : null;
      if (
        sessionTabDigit !== null
        && !event.repeat
        && !isVSCodeRuntime()
        && canUseDigitShortcut(event)
        && useUIStore.getState().sessionTabsEnabled
        && eventMatchesShortcutPrefix(
          event,
          getEffectiveShortcutPrefix('switch_session_tab', useUIStore.getState().shortcutOverrides),
          heldKeysRef.current,
        )
        && activateSessionTabByIndex(sessionTabDigit - 1)
      ) {
        event.preventDefault();
        return;
      }

      if (dispatcher.dispatch(event)) {
        event.preventDefault();
        return;
      }
      if (!useUIStore.getState().isMobile && !hasOverlayOpen()) inputRedirect.redirectKey(event);
    };
    const handlePaste = (event: ClipboardEvent) => {
      const allowComposerFallback = !useUIStore.getState().isMobile
        && !hasOverlayOpen()
        && !hasActiveSelectionToolbar();
      inputRedirect.redirectPaste(event, allowComposerFallback);
    };
    let windowFocusFrame: number | null = null;
    const handleWindowFocus = () => {
      if (useUIStore.getState().isMobile) return;
      if (windowFocusFrame !== null) cancelAnimationFrame(windowFocusFrame);
      windowFocusFrame = requestAnimationFrame(() => {
        windowFocusFrame = requestAnimationFrame(() => {
          windowFocusFrame = null;
          if (!hasOverlayOpen()) inputRedirect.refocusAfterWindowFocus();
        });
      });
    };
    const handleKeyHoldDown = (event: KeyboardEvent) => {
      inputRedirect.clearPendingMiddleClick();
      heldKeysRef.current.add(event.key.toLowerCase());
      heldKeysRef.current.add(resolveShortcutEventKey(event).toLowerCase());
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      heldKeysRef.current.delete(event.key.toLowerCase());
      heldKeysRef.current.delete(resolveShortcutEventKey(event).toLowerCase());
      if (terminalZoomKeyCodes.delete(event.code)) event.stopPropagation();
    };
    const handleBlur = () => {
      heldKeysRef.current.clear();
      terminalZoomKeyCodes.clear();
      dispatcher.handleBlur();
      selectionToolbarDispatcher.handleBlur();
    };
    window.addEventListener('keydown', handleKeyHoldDown, true);
    window.addEventListener('keydown', handleSelectionToolbarKeyDownCapture, true);
    window.addEventListener('keyup', handleKeyUp, true);
    window.addEventListener('keydown', handleTerminalShortcutCapture, true);
    window.addEventListener('keydown', handleEscapeKeyDownCapture, true);
    window.addEventListener('keydown', handleActivePrefixKeyDownCapture, true);
    window.addEventListener('pointerdown', handlePrefixPress, true);
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keydown', handleAbortEscapeKeyDown);
    window.addEventListener('blur', handleBlur);
    window.addEventListener('pointerdown', inputRedirect.rememberColumn, true);
    window.addEventListener('pointerup', inputRedirect.releaseMiddleClick, true);
    window.addEventListener('pointercancel', inputRedirect.releaseMiddleClick, true);
    window.addEventListener('focusin', inputRedirect.rememberColumn, true);
    const captureMiddleClickPaste = isLinuxPlatform();
    const handleMiddleClickPaste = (event: ClipboardEvent) => {
      inputRedirect.captureMiddleClickPaste(event);
    };
    if (captureMiddleClickPaste) {
      window.addEventListener('paste', handleMiddleClickPaste, true);
    }
    window.addEventListener('paste', handlePaste);
    window.addEventListener('focus', handleWindowFocus);
    return () => {
      window.removeEventListener('pointerdown', inputRedirect.rememberColumn, true);
      window.removeEventListener('pointerup', inputRedirect.releaseMiddleClick, true);
      window.removeEventListener('pointercancel', inputRedirect.releaseMiddleClick, true);
      window.removeEventListener('focusin', inputRedirect.rememberColumn, true);
      if (captureMiddleClickPaste) {
        window.removeEventListener('paste', handleMiddleClickPaste, true);
      }
      window.removeEventListener('paste', handlePaste);
      window.removeEventListener('focus', handleWindowFocus);
      if (windowFocusFrame !== null) cancelAnimationFrame(windowFocusFrame);
      window.removeEventListener('keydown', handleKeyHoldDown, true);
      window.removeEventListener('keydown', handleSelectionToolbarKeyDownCapture, true);
      window.removeEventListener('keyup', handleKeyUp, true);
      window.removeEventListener('keydown', handleTerminalShortcutCapture, true);
      window.removeEventListener('keydown', handleEscapeKeyDownCapture, true);
      window.removeEventListener('keydown', handleActivePrefixKeyDownCapture, true);
      window.removeEventListener('pointerdown', handlePrefixPress, true);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keydown', handleAbortEscapeKeyDown);
      window.removeEventListener('blur', handleBlur);
    };
  }, [currentSessionId, dispatcher, effectiveDirectory, handleAbortEscapeKeyDown, inputRedirect, resetAbortPriming, selectionToolbarDispatcher, sessionPhase]);
};
