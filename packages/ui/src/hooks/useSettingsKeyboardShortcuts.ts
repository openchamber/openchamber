import React from 'react';
import { isVimEditorEventTarget } from '@/lib/editorFocus';
import { isVSCodeRuntime } from '@/lib/desktop';
import { isIMECompositionEvent } from '@/lib/ime';
import { getEffectiveShortcutCombo, ShortcutDispatcher, shortcutRegistry } from '@/lib/shortcuts';
import { useUIStore } from '@/stores/useUIStore';
import { useKeybind } from './useKeybind';
import { hasOpenDropdown, isEditableEventTarget } from './keyboard-shortcut-dom';

export const handleSettingsShortcut = (): boolean | void => {
  const state = useUIStore.getState();
  // VS Code forwards this default key to its workbench, which owns the binding.
  if (isVSCodeRuntime() && getEffectiveShortcutCombo('open_settings', state.shortcutOverrides) === 'mod+comma') {
    return false;
  }
  state.setSettingsDialogOpen(!state.isSettingsDialogOpen);
};

/** A Settings-only webview has no chat selection or session bootstrap demand. */
export const useSettingsKeyboardShortcuts = (): void => {
  useKeybind('open_settings', handleSettingsShortcut);
  const dispatcherRef = React.useRef<ShortcutDispatcher | null>(null);
  if (!dispatcherRef.current) {
    dispatcherRef.current = new ShortcutDispatcher({
      registry: shortcutRegistry,
      getBinding: (actionId) => getEffectiveShortcutCombo(actionId, useUIStore.getState().shortcutOverrides),
    });
  }
  const dispatcher = dispatcherRef.current;

  React.useEffect(() => {
    const handlePrefix = (event: KeyboardEvent) => {
      if (!dispatcher.hasActivePrefix()) return;
      if (!event.ctrlKey && !event.metaKey && !event.altKey
        && isEditableEventTarget(event.target) && dispatcher.getActivePrefixTarget() !== event.target) {
        dispatcher.clear();
        return;
      }
      if (dispatcher.dispatchActivePrefix(event)) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (dispatcher.consumeCapturedPrefixEvent(event) || event.defaultPrevented) return;
      if (event.key === 'Escape') {
        if (isIMECompositionEvent(event) || hasOpenDropdown() || shortcutRegistry.isSuspended()
          || isVimEditorEventTarget(event.target)
          || (event.target instanceof Element && event.target.closest('[role="dialog"]'))) return;
        event.preventDefault();
        if (!dispatcher.handleEscape()) useUIStore.getState().setSettingsDialogOpen(false);
        return;
      }
      if (dispatcher.dispatch(event)) event.preventDefault();
    };
    const handleBlur = () => dispatcher.handleBlur();
    window.addEventListener('keydown', handlePrefix, true);
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('blur', handleBlur);
    return () => {
      window.removeEventListener('keydown', handlePrefix, true);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('blur', handleBlur);
    };
  }, [dispatcher]);
};
