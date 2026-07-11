import { useSyncExternalStore } from 'react';
import { isMacOS } from '@/lib/utils';

export const MODIFIER_SHORTCUT_HINT_DELAY_MS = 500;

let shortcutHintsVisible = false;
let initialized = false;
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((listener) => listener());
}

function setShortcutHintsVisible(next: boolean): void {
  if (shortcutHintsVisible === next) return;
  shortcutHintsVisible = next;
  emit();
}

function isPrimaryModifierKey(event: KeyboardEvent): boolean {
  return isMacOS() ? event.key === 'Meta' : event.key === 'Control';
}

export const createDelayedModifierHintController = ({
  setVisible,
  schedule = (callback, delayMs) => setTimeout(callback, delayMs),
  cancel = (timer) => clearTimeout(timer),
}: {
  setVisible: (visible: boolean) => void;
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  cancel?: (timer: ReturnType<typeof setTimeout>) => void;
}) => {
  let held = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clearTimer = () => {
    if (timer === null) return;
    cancel(timer);
    timer = null;
  };

  return {
    press() {
      if (held) return;
      held = true;
      clearTimer();
      timer = schedule(() => {
        timer = null;
        if (held) setVisible(true);
      }, MODIFIER_SHORTCUT_HINT_DELAY_MS);
    },
    release() {
      held = false;
      clearTimer();
      setVisible(false);
    },
  };
};

const modifierHintController = createDelayedModifierHintController({
  setVisible: setShortcutHintsVisible,
});

function handleKeyDown(event: KeyboardEvent): void {
  if (isPrimaryModifierKey(event)) modifierHintController.press();
}

function resetModifierState(): void {
  modifierHintController.release();
}

function handleKeyUp(event: KeyboardEvent): void {
  if (isPrimaryModifierKey(event)) {
    resetModifierState();
  }
}

function handleVisibilityChange(): void {
  if (document.visibilityState !== 'visible') {
    resetModifierState();
  }
}

function ensureListeners(): void {
  if (initialized || typeof window === 'undefined') return;
  initialized = true;
  window.addEventListener('keydown', handleKeyDown);
  window.addEventListener('keyup', handleKeyUp);
  window.addEventListener('blur', resetModifierState);
  document.addEventListener('visibilitychange', handleVisibilityChange);
}

function subscribe(onStoreChange: () => void): () => void {
  ensureListeners();
  listeners.add(onStoreChange);
  return () => listeners.delete(onStoreChange);
}

function getSnapshot(): boolean {
  return shortcutHintsVisible;
}

function getServerSnapshot(): boolean {
  return false;
}

/** Only the numbered hint chips subscribe, so modifier transitions never repaint the sidebar tree. */
export function useDelayedModKeyHeld(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
