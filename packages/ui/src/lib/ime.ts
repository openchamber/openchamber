import type React from 'react';

/**
 * Detects if a keyboard event is part of IME composition.
 * Uses both `isComposing` and the `keyCode === 229` fallback.
 *
 * Note: `keyCode` is deprecated, but `229` remains a practical fallback for
 * some WebKit-based environments where composition
 * events can be ordered unexpectedly.
 */
export const isIMECompositionEvent = (e: KeyboardEvent | React.KeyboardEvent): boolean => {
  // CodeMirror keymaps hand out the native event; React handlers wrap it.
  const native = 'nativeEvent' in e ? e.nativeEvent : e;
  return native.isComposing || native.keyCode === 229;
};
