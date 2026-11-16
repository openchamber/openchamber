import { useSyncExternalStore } from 'react';

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

function handleModifierEvent(event: KeyboardEvent | PointerEvent): void {
  setShiftHeld(event.shiftKey);
}

function handleReset(): void {
  setShiftHeld(false);
}

function ensureListeners(): void {
  if (initialized || typeof window === 'undefined') {
    return;
  }
  initialized = true;
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
