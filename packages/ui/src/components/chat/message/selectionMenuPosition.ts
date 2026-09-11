export const DESKTOP_MENU_SIDE_MARGIN_PX = 8;
export const DESKTOP_MENU_FALLBACK_WIDTH_PX = 280;
export const DESKTOP_MENU_FALLBACK_HEIGHT_PX = 38;
export const DESKTOP_MENU_SELECTION_GAP_PX = 10;

export const getDesktopClampedX = (anchorX: number, viewportWidth: number, menuWidth: number): number => {
  const halfWidth = menuWidth / 2;
  const minX = DESKTOP_MENU_SIDE_MARGIN_PX + halfWidth;
  const maxX = viewportWidth - DESKTOP_MENU_SIDE_MARGIN_PX - halfWidth;

  if (minX > maxX) {
    return viewportWidth / 2;
  }

  return Math.min(Math.max(anchorX, minX), maxX);
};

// The desktop menu renders with `transform: translate(-50%, -100%)`, so the
// anchor Y marks the menu's bottom edge and the menu extends `menuHeight`
// upward from it. The minimum keeps the whole menu below the top margin.
export const getDesktopClampedY = (anchorY: number, viewportHeight: number, menuHeight: number): number => {
  const minY = DESKTOP_MENU_SIDE_MARGIN_PX + menuHeight;
  const maxY = viewportHeight - DESKTOP_MENU_SIDE_MARGIN_PX;

  if (minY > maxY) {
    return viewportHeight / 2;
  }

  return Math.min(Math.max(anchorY, minY), maxY);
};

// The desktop menu prefers to hang above the selection. `minTop` is the topmost
// screen Y it may occupy; when the menu does not fit above the selection it is
// placed below it instead of over it. Painting the menu across the selected text
// hides what the menu acts on and drops a button under the pointer, where it
// swallows the next click of a multi-click sequence.
export const getDesktopSelectionAnchorY = (
  selection: { top: number; bottom: number },
  menuHeight: number,
  minTop: number,
): number => {
  const above = selection.top - DESKTOP_MENU_SELECTION_GAP_PX;

  if (above - menuHeight >= minTop) {
    return above;
  }

  return selection.bottom + DESKTOP_MENU_SELECTION_GAP_PX + menuHeight;
};
