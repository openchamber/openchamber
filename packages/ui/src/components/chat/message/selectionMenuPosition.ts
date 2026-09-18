export const DESKTOP_MENU_SIDE_MARGIN_PX = 8;
export const DESKTOP_MENU_FALLBACK_WIDTH_PX = 280;
export const DESKTOP_MENU_FALLBACK_HEIGHT_PX = 38;

export const getDesktopClampedX = (anchorX: number, viewportWidth: number, menuWidth: number): number => {
  const halfWidth = menuWidth / 2;
  const minX = DESKTOP_MENU_SIDE_MARGIN_PX + halfWidth;
  const maxX = viewportWidth - DESKTOP_MENU_SIDE_MARGIN_PX - halfWidth;

  if (minX > maxX) {
    return viewportWidth / 2;
  }

  return Math.min(Math.max(anchorX, minX), maxX);
};

export const DESKTOP_MENU_SELECTION_GAP_PX = 10;

export type DesktopMenuPlacement = 'above' | 'below';

interface DesktopMenuYInput {
  selectionTop: number;
  selectionBottom: number;
  menuHeight: number;
  viewportHeight: number;
  // Top edge of the area the menu may cover: the chat viewport, which keeps
  // the menu off the header (a window drag zone on the desktop shell).
  boundaryTop: number;
}

interface DesktopMenuY {
  // With 'above' the anchor Y is the menu's bottom edge
  // (`translate(-50%, -100%)`); with 'below' it is the menu's top edge.
  y: number;
  placement: DesktopMenuPlacement;
}

// The menu sits above the selection and flips below it when there is no room
// above, so it never covers the text the user is about to copy. When neither
// side has room (a selection filling the visible area, or one scrolled out of
// view) the menu is clamped on screen instead.
export const getDesktopMenuY = ({
  selectionTop,
  selectionBottom,
  menuHeight,
  viewportHeight,
  boundaryTop,
}: DesktopMenuYInput): DesktopMenuY => {
  const minTop = Math.max(boundaryTop, 0) + DESKTOP_MENU_SIDE_MARGIN_PX;
  const maxBottom = viewportHeight - DESKTOP_MENU_SIDE_MARGIN_PX;

  const aboveY = selectionTop - DESKTOP_MENU_SELECTION_GAP_PX;
  if (aboveY - menuHeight >= minTop && aboveY <= maxBottom) {
    return { y: aboveY, placement: 'above' };
  }

  const belowY = selectionBottom + DESKTOP_MENU_SELECTION_GAP_PX;
  if (belowY >= minTop && belowY + menuHeight <= maxBottom) {
    return { y: belowY, placement: 'below' };
  }

  if (minTop + menuHeight > maxBottom) {
    return { y: viewportHeight / 2, placement: 'above' };
  }

  return { y: Math.min(Math.max(aboveY, minTop + menuHeight), maxBottom), placement: 'above' };
};
