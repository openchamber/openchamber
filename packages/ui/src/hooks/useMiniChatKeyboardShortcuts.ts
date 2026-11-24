import React from 'react';
import { focusChatInput } from '@/components/chat/composer/editor/dom';
import { canUseElectronDesktopIPC, getMiniChatRuntimeArgs, invokeDesktop } from '@/lib/desktop';
import { getNextFavoriteModel } from '@/lib/modelRefs';
import { ShortcutDispatcher, getEffectiveShortcutCombo, shortcutRegistry } from '@/lib/shortcuts';
import { activeSpaceTarget, providersOfSpaceOffer, spaceModelOffer } from '@/lib/spaces/space-model-offer';
import { useConfigStore } from '@/stores/useConfigStore';
import { cycleThinkingVariant } from '@/lib/cycleThinkingVariant';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSelectionStore } from '@/sync/selection-store';
import { useKeybinds } from './useKeybind';
import { hasActiveBtwComposer, hasOpenDropdown, isEditableEventTarget, typesOutsidePrefixField } from './keyboard-shortcut-dom';
import { useComposerAbortEscape } from './useComposerAbortEscape';
import { useCurrentSessionActivity } from './useSessionActivity';
import * as sessionActions from '@/sync/session-actions';
import { dispatchPromptHistorySearch } from '@/components/chat/composer/state/promptHistorySearchRoute';

export const useMiniChatKeyboardShortcuts = () => {
  const openNewSessionDraft = useSessionUIStore((state) => state.openNewSessionDraft);
  const dispatcherRef = React.useRef<ShortcutDispatcher | null>(null);
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const { phase: sessionPhase } = useCurrentSessionActivity();
  const { handleKeyDown: handleAbortEscapeKeyDown } = useComposerAbortEscape({
    isBlocked: () => hasOpenDropdown() || Boolean(document.querySelector('[role="dialog"], [role="alertdialog"]')),
    resolveTarget: () => ({ sessionId: currentSessionId, working: sessionPhase !== 'idle' }),
    abort: (sessionId) => { void sessionActions.abortCurrentOperation(sessionId); },
  });

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

  const cycleFavoriteModel = (delta: number): boolean | void => {
    if (hasActiveBtwComposer()) return false;
    const { favoriteModels, hiddenModels, addRecentModel, setLastSelectedModel } = useUIStore.getState();
    const {
      providers,
      currentProviderId,
      currentModelId,
      setProvider,
      setModel,
    } = useConfigStore.getState();
    const next = getNextFavoriteModel(
      favoriteModels,
      providersOfSpaceOffer(spaceModelOffer(activeSpaceTarget()), providers),
      hiddenModels,
      { providerID: currentProviderId, modelID: currentModelId },
      delta,
    );
    if (!next) return false;
    setProvider(next.providerID);
    setModel(next.modelID);
    const sessionId = useSessionUIStore.getState().currentSessionId;
    if (sessionId) useSelectionStore.getState().pickSessionModel(sessionId, next.providerID, next.modelID);
    addRecentModel(next.providerID, next.modelID);
    setLastSelectedModel(next.providerID, next.modelID);
  };

  useKeybinds({
    focus_input: () => {
      focusChatInput();
    },
    search_prompt_history: (event) => dispatchPromptHistorySearch(event),
    new_mini_chat: () => {
      if (!canUseElectronDesktopIPC()) return false;
      void invokeDesktop('desktop_open_draft_mini_chat_window', {
        directory: '',
        projectId: null,
        ...getMiniChatRuntimeArgs(),
      })?.catch((error) => {
        console.warn('[mini-chat-shortcuts] failed to open draft mini chat window', error);
      });
    },
    new_chat: () => {
      const sessionState = useSessionUIStore.getState();
      openNewSessionDraft(sessionState.currentSessionId && sessionState.currentSessionDirectory
        ? { directoryOverride: sessionState.currentSessionDirectory }
        : undefined);
      focusChatInput();
    },
    open_model_selector: () => {
      if (hasActiveBtwComposer()) return false;
      const { isModelSelectorOpen, setModelSelectorOpen } = useUIStore.getState();
      setModelSelectorOpen(!isModelSelectorOpen);
    },
    cycle_thinking_variant: () => {
      if (hasActiveBtwComposer()) return false;
      if (!cycleThinkingVariant(useSessionUIStore.getState().currentSessionId)) return false;
    },
    cycle_favorite_model_forward: () => cycleFavoriteModel(1),
    cycle_favorite_model_backward: () => cycleFavoriteModel(-1),
    toggle_dictation: () => {
      if (hasActiveBtwComposer()) return false;
      window.dispatchEvent(new CustomEvent('openchamber:dictation-toggle'));
    },
  });

  React.useEffect(() => {
    const handlePrefixPress = (event: PointerEvent) => {
      if (isEditableEventTarget(event.target)) dispatcher.clear();
    };
    const handleActivePrefixKeyDownCapture = (event: KeyboardEvent) => {
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
      if (dispatcher.dispatch(event)) event.preventDefault();
    };
    const handleBlur = () => dispatcher.handleBlur();

    window.addEventListener('keydown', handleActivePrefixKeyDownCapture, true);
    window.addEventListener('pointerdown', handlePrefixPress, true);
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keydown', handleAbortEscapeKeyDown);
    window.addEventListener('blur', handleBlur);
    return () => {
      window.removeEventListener('keydown', handleActivePrefixKeyDownCapture, true);
      window.removeEventListener('pointerdown', handlePrefixPress, true);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keydown', handleAbortEscapeKeyDown);
      window.removeEventListener('blur', handleBlur);
    };
  }, [dispatcher, handleAbortEscapeKeyDown]);
};
