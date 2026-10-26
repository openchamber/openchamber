import React from 'react';

/**
 * Keeps the selected row of a command, skill or mention list in view as the
 * keyboard moves it. `onKeyboardNavigate` also covers a one-item list, where
 * the selected index does not change.
 */
export function useAutocompleteSelectionScroll(
  selectedIndex: number,
  itemRefs: React.RefObject<(HTMLDivElement | null)[]>,
) {
  const listRef = React.useRef<HTMLElement | null>(null);
  const [keyboardRequest, onKeyboardNavigate] = React.useReducer((value: number) => value + 1, 0);

  React.useLayoutEffect(() => {
    itemRefs.current[selectedIndex]?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex, keyboardRequest, itemRefs]);

  return { listRef, onKeyboardNavigate };
}
