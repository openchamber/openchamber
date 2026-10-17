import React from 'react';

// One visibility coordinator per open command or skill list.
export function useAutocompleteDetails(
  selectedIndex: number,
  itemRefs: React.RefObject<(HTMLDivElement | null)[]>,
) {
  const listRef = React.useRef<HTMLElement | null>(null);
  const [detailsVisible, setDetailsVisible] = React.useState(true);
  const [keyboardRequest, requestKeyboardScroll] = React.useReducer((value: number) => value + 1, 0);
  const scrollPositionRef = React.useRef<{ top: number; left: number } | null>(null);
  const lastScrollAtRef = React.useRef(-Infinity);

  React.useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const beforeTop = list.scrollTop;
    const beforeLeft = list.scrollLeft;
    itemRefs.current[selectedIndex]?.scrollIntoView({ block: 'nearest' });
    // Native scroll events arrive after scrollIntoView changes the position.
    // Record only our own movement; don't swallow a pending user scroll.
    if (!scrollPositionRef.current || list.scrollTop !== beforeTop || list.scrollLeft !== beforeLeft) {
      scrollPositionRef.current = { top: list.scrollTop, left: list.scrollLeft };
    }
  }, [selectedIndex, keyboardRequest, itemRefs]);

  const onListScroll = React.useCallback<React.UIEventHandler<HTMLElement>>((event) => {
    const list = event.currentTarget;
    const previous = scrollPositionRef.current;
    if (previous?.top === list.scrollTop && previous.left === list.scrollLeft) return;
    scrollPositionRef.current = { top: list.scrollTop, left: list.scrollLeft };
    lastScrollAtRef.current = performance.now();
    setDetailsVisible(false);
  }, []);

  const onItemMouseMove = React.useCallback(() => {
    // Rows can pass under a stationary pointer during wheel/trackpad scrolling.
    // Wait for a 150ms scroll gap before accepting a fresh mouse move.
    // No timer reopens details: a fresh user interaction is still required.
    if (performance.now() - lastScrollAtRef.current < 150) return;
    setDetailsVisible(true);
  }, []);

  const onKeyboardNavigate = React.useCallback(() => {
    setDetailsVisible(true);
    // Also handles a one-item list, where the selected index does not change.
    requestKeyboardScroll();
  }, []);

  return { listRef, detailsVisible, onListScroll, onItemMouseMove, onKeyboardNavigate };
}
