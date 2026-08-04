/**
 * "Is a hardware keyboard attached?" — the input the mobile layout uses to
 * decide whether a soft keyboard will ever eat the screen.
 *
 * Two sources, in priority order:
 *
 * 1. The native answer. On iOS the shell reads `GCKeyboard` and stamps
 *    `window.__OPENCHAMBER_HARDWARE_KEYBOARD__` at document start, then keeps it
 *    live via `oc:hardware-keyboard` (see BridgeViewController). This is
 *    authoritative and — crucially — known BEFORE the user focuses anything, so
 *    the draft screen and composer start in the right shape instead of
 *    re-laying-out after the first focus.
 * 2. Inference, for runtimes with no native answer (Android, hosted mobile).
 *    A `keyboardWillShow` with a real height means there IS a soft keyboard; a
 *    tiny height means only iOS' shortcut strip; focus with no event at all
 *    within a short window means nothing was presented. Inference is ignored
 *    entirely once the native source has spoken.
 *
 * Everything else stays `false`, which is the safe default: the layout then
 * behaves exactly as it does on a phone.
 *
 * In memory only — a keyboard can be attached and detached while the app runs,
 * and both sources re-answer the question continuously.
 */

import React from 'react';

/** Below this the "keyboard" is only iOS' shortcut bar, not a real keyboard. */
const SOFTWARE_KEYBOARD_MIN_HEIGHT_PX = 120;
/** iOS starts its keyboard animation well inside this window after focus. */
const KEYBOARD_EVENT_GRACE_MS = 600;

declare global {
  interface Window {
    __OPENCHAMBER_HARDWARE_KEYBOARD__?: boolean;
  }
}

// Read at module init, not just from the bridge effect: the stamp exists from
// document start, and the very first render of the draft screen / composer must
// already see it — otherwise the layout still settles one frame late.
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

/**
 * Adopt the native shell's answer and stop inferring. Idempotent; safe to call
 * before the shell has stamped anything (then it is a no-op and inference
 * stays in charge).
 */
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

/**
 * Feed a native `keyboardWillShow` height in. Called by the Capacitor keyboard
 * bridge (see `mobileNativeChrome`) on both platforms. An arriving event always
 * settles the question, so it cancels any pending focus probe.
 */
export const observeNativeKeyboardHeight = (heightPx: number): void => {
  if (hasNativeAnswer || !Number.isFinite(heightPx)) return;
  clearFocusProbe();
  setHardwareKeyboardAttached(heightPx > 0 && heightPx < SOFTWARE_KEYBOARD_MIN_HEIGHT_PX);
};

/**
 * Report that an editor just took focus. If no keyboard event follows, nothing
 * was presented — which means a hardware keyboard is attached.
 *
 * Deliberately one-directional within the window: only the SILENCE concludes
 * "hardware". A real `keyboardWillShow` cancels the probe above, so a slow
 * keyboard can never be misread.
 */
export const observeEditorFocus = (): void => {
  if (hasNativeAnswer || typeof window === 'undefined' || typeof document === 'undefined') return;
  // A soft keyboard already up sends no second `keyboardWillShow` — a refocus
  // through it (the overlay-close keyboard restore) would look like silence.
  if (document.documentElement.classList.contains('oc-keyboard-open')) return;
  clearFocusProbe();
  focusProbeTimer = window.setTimeout(() => {
    focusProbeTimer = null;
    setHardwareKeyboardAttached(true);
  }, KEYBOARD_EVENT_GRACE_MS);
};

/** Drop the inferred state when the native bridge tears down. */
export const resetHardwareKeyboardDetection = (): void => {
  clearFocusProbe();
  if (hasNativeAnswer) return;
  setHardwareKeyboardAttached(false);
};

export const isHardwareKeyboardAttached = (): boolean => hardwareKeyboardAttached;

export const subscribeHardwareKeyboard = (listener: () => void): (() => void) => {
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
