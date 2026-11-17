
import React from 'react';

const SOFTWARE_KEYBOARD_MIN_HEIGHT_PX = 120;
const KEYBOARD_EVENT_GRACE_MS = 600;

declare global {
  interface Window {
    __OPENCHAMBER_HARDWARE_KEYBOARD__?: boolean;
  }
}

const initialNativeAnswer = typeof window !== 'undefined'
  && typeof window.__OPENCHAMBER_HARDWARE_KEYBOARD__ === 'boolean'
  ? window.__OPENCHAMBER_HARDWARE_KEYBOARD__
  : null;

let hardwareKeyboardAttached = initialNativeAnswer === true;
let hasNativeAnswer = initialNativeAnswer !== null;
let focusProbeTimer: number | null = null;
let bridgeStarted = false;
const subscribers = new Set<() => void>();

if (hardwareKeyboardAttached && typeof document !== 'undefined') {
  document.documentElement.classList.add('oc-hardware-keyboard');
}

const clearFocusProbe = (): void => {
  if (focusProbeTimer === null) return;
  window.clearTimeout(focusProbeTimer);
  focusProbeTimer = null;
};

const setHardwareKeyboardAttached = (value: boolean): void => {
  if (hardwareKeyboardAttached === value) return;
  hardwareKeyboardAttached = value;
  if (typeof document !== 'undefined') {
    document.documentElement.classList.toggle('oc-hardware-keyboard', value);
  }
  for (const listener of subscribers) listener();
};

export const startHardwareKeyboardBridge = (): (() => void) => {
  if (typeof window === 'undefined') return () => {};

  const adopt = (value: boolean) => {
    hasNativeAnswer = true;
    clearFocusProbe();
    setHardwareKeyboardAttached(value);
  };

  if (typeof window.__OPENCHAMBER_HARDWARE_KEYBOARD__ === 'boolean') {
    adopt(window.__OPENCHAMBER_HARDWARE_KEYBOARD__);
  }

  if (bridgeStarted) return () => {};
  bridgeStarted = true;

  const handleNativeChange = (event: Event) => {
    const detail = (event as CustomEvent<{ attached?: boolean }>).detail;
    adopt(detail?.attached === true);
  };
  window.addEventListener('oc:hardware-keyboard', handleNativeChange);
  return () => {
    window.removeEventListener('oc:hardware-keyboard', handleNativeChange);
    bridgeStarted = false;
  };
};

export const observeNativeKeyboardHeight = (heightPx: number): void => {
  if (hasNativeAnswer || !Number.isFinite(heightPx)) return;
  clearFocusProbe();
  setHardwareKeyboardAttached(heightPx > 0 && heightPx < SOFTWARE_KEYBOARD_MIN_HEIGHT_PX);
};

export const observeEditorFocus = (): void => {
  if (hasNativeAnswer || typeof window === 'undefined' || typeof document === 'undefined') return;
  if (document.documentElement.classList.contains('oc-keyboard-open')) return;
  clearFocusProbe();
  focusProbeTimer = window.setTimeout(() => {
    focusProbeTimer = null;
    setHardwareKeyboardAttached(true);
  }, KEYBOARD_EVENT_GRACE_MS);
};

export const resetHardwareKeyboardDetection = (): void => {
  clearFocusProbe();
  if (hasNativeAnswer) return;
  setHardwareKeyboardAttached(false);
};

const isHardwareKeyboardAttached = (): boolean => hardwareKeyboardAttached;

const subscribeHardwareKeyboard = (listener: () => void): (() => void) => {
  subscribers.add(listener);
  return () => {
    subscribers.delete(listener);
  };
};

export function useHardwareKeyboard(): boolean {
  return React.useSyncExternalStore(
    subscribeHardwareKeyboard,
    isHardwareKeyboardAttached,
    () => false,
  );
}
