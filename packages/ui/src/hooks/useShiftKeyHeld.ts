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

// Every keyboard and pointer event carries the real modifier state, so the
// flag follows `shiftKey` rather than pairing Shift keydown with keyup: a
// keyup can be swallowed (a handler stopping propagation, focus inside an
// iframe or the terminal), and a missed one left rows offering only Delete.
// Shift's own keydown reports `shiftKey: true` and its keyup `false`.
function handleModifierEvent(event: KeyboardEvent | PointerEvent): void {
  setShiftHeld(event.shiftKey);
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
  // Capture phase: runs before any handler can stop propagation.
  const capture = { capture: true, passive: true };
  window.addEventListener('keydown', handleModifierEvent, capture);
  window.addEventListener('keyup', handleModifierEvent, capture);
  window.addEventListener('pointermove', handleModifierEvent, capture);
  window.addEventListener('pointerdown', handleModifierEvent, capture);
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
