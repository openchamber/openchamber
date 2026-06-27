import { useSyncExternalStore } from 'react';

/**
 * Tracks whether the Shift key is currently held, shared across all consumers
 * via a single set of window listeners.
 *
 * Using one module-level listener set (instead of per-component listeners)
 * keeps this cheap even when many rows subscribe, and `useSyncExternalStore`
 * lets unrelated subtrees stay isolated — only components that actually call
 * this hook re-render when the Shift state flips.
 */
let shiftHeld = false;
const listeners = new Set<() => void>();
let initialized = false;

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

function setShiftHeld(next: boolean): void {
  if (shiftHeld === next) {
    return;
  }
  shiftHeld = next;
  emit();
}

function handleKeyDown(event: KeyboardEvent): void {
  if (event.key === 'Shift') {
    setShiftHeld(true);
  }
}

function handleKeyUp(event: KeyboardEvent): void {
  if (event.key === 'Shift') {
    setShiftHeld(false);
  }
}

// The window can lose focus while Shift is held (e.g. alt-tab), and the
// matching keyup never arrives — reset so the UI doesn't get stuck in the
// "delete" affordance.
function handleReset(): void {
  setShiftHeld(false);
}

function ensureListeners(): void {
  if (initialized || typeof window === 'undefined') {
    return;
  }
  initialized = true;
  window.addEventListener('keydown', handleKeyDown);
  window.addEventListener('keyup', handleKeyUp);
  window.addEventListener('blur', handleReset);
}

function subscribe(onStoreChange: () => void): () => void {
  ensureListeners();
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
  };
}

function getSnapshot(): boolean {
  return shiftHeld;
}

function getServerSnapshot(): boolean {
  return false;
}

export function useShiftKeyHeld(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
