import type React from 'react';

// external: https://developer.mozilla.org/en-US/docs/Web/API/Element/keydown_event#keydown_events_with_ime keyCode 229 covers IME keydowns whose isComposing flag misses composition boundaries.
export const isIMECompositionEvent = (e: KeyboardEvent | React.KeyboardEvent): boolean => {
  const native = 'nativeEvent' in e ? e.nativeEvent : e;
  return native.isComposing || native.keyCode === 229;
};
