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
