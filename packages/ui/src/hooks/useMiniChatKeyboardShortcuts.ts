import React from 'react';
import { focusChatInput } from '@/components/chat/composer/editor/dom';
import { canUseElectronDesktopIPC, invokeDesktop } from '@/lib/desktop';
import { ShortcutDispatcher, getEffectiveShortcutCombo, shortcutRegistry } from '@/lib/shortcuts';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSelectionStore } from '@/sync/selection-store';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useKeybinds } from './useKeybind';
import { isEditableEventTarget } from './keyboard-shortcut-dom';

export const useMiniChatKeyboardShortcuts = () => {
  const openNewSessionDraft = useSessionUIStore((state) => state.openNewSessionDraft);
  const dispatcherRef = React.useRef<ShortcutDispatcher | null>(null);

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
    const { favoriteModels, addRecentModel } = useUIStore.getState();
    if (favoriteModels.length === 0) return false;

    const {
      currentProviderId,
      currentModelId,
      setProvider,
      setModel,
    } = useConfigStore.getState();
    const currentIndex = favoriteModels.findIndex(
      (favorite) => favorite.providerID === currentProviderId && favorite.modelID === currentModelId,
    );
    const next = favoriteModels[(currentIndex + delta + favoriteModels.length) % favoriteModels.length];
    setProvider(next.providerID);
    setModel(next.modelID);
    addRecentModel(next.providerID, next.modelID);
  };

  useKeybinds({
    focus_input: () => {
      focusChatInput();
    },
    new_mini_chat: () => {
      if (!canUseElectronDesktopIPC()) return false;
      void invokeDesktop('desktop_open_draft_mini_chat_window', {
        directory: '',
        projectId: null,
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
      const { isModelSelectorOpen, setModelSelectorOpen } = useUIStore.getState();
      setModelSelectorOpen(!isModelSelectorOpen);
    },
    cycle_thinking_variant: () => {
      const configState = useConfigStore.getState();
      if (configState.getCurrentModelVariants().length === 0) return false;

      configState.cycleCurrentVariant();
      const sessionId = useSessionUIStore.getState().currentSessionId;
      const {
        currentVariant,
        currentAgentName,
        currentProviderId,
        currentModelId,
      } = useConfigStore.getState();
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
  });

  React.useEffect(() => {
    const handleActivePrefixKeyDownCapture = (event: KeyboardEvent) => {
      if (!dispatcher.hasActivePrefix()) return;
      // An unmodified completion key typed into an editable target is only a
      // deliberate sequence when the prefix was armed from that same target;
      // otherwise it is regular typing and must not be swallowed.
      if (
        !event.ctrlKey && !event.metaKey && !event.altKey
        && isEditableEventTarget(event.target)
        && dispatcher.getActivePrefixTarget() !== event.target
      ) {
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
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('blur', handleBlur);
    return () => {
      window.removeEventListener('keydown', handleActivePrefixKeyDownCapture, true);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('blur', handleBlur);
    };
  }, [dispatcher]);
};
