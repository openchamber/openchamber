import React from 'react';

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
