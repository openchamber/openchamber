export const DESKTOP_MENU_SIDE_MARGIN_PX = 8;

export const getDesktopClampedMenuY = (
  anchorY: number,
  viewportHeight: number,
  menuHeight: number,
): number => {
  const minY = DESKTOP_MENU_SIDE_MARGIN_PX + menuHeight;
  const maxY = viewportHeight - DESKTOP_MENU_SIDE_MARGIN_PX;

  if (minY > maxY) {
    return (minY + maxY) / 2;
  }

  return Math.min(Math.max(anchorY, minY), maxY);
};
