import type React from 'react';

/**
 * Detects if a keyboard event is part of IME composition.
 * Uses both `isComposing` and the `keyCode === 229` fallback.
 *
 * Note: `keyCode` is deprecated, but `229` remains a practical fallback for
 * some WebKit-based environments where composition
 * events can be ordered unexpectedly.
 */
export const isIMECompositionEvent = (e: React.KeyboardEvent): boolean => {
  return e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229;
};
