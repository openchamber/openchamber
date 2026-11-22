const getWindowStateSnapshot = (browserWindow, { minWidth, minHeight }) => {
  if (browserWindow.isMinimized()) return null;

  const bounds = browserWindow.getBounds();
  return {
    x: bounds.x,
    y: bounds.y,
    width: Math.max(bounds.width, minWidth),
    height: Math.max(bounds.height, minHeight),
    maximized: browserWindow.isMaximized(),
    fullscreen: browserWindow.isFullScreen(),
  };
};

export const persistMainWindowState = async ({
  browserWindow,
  mainWindowId,
  quakeActive,
  minWidth,
  minHeight,
  mutateSettingsRoot,
}) => {
  if (!browserWindow || browserWindow.isDestroyed()) return;
  if (browserWindow.id !== mainWindowId || quakeActive) return;

  const windowState = getWindowStateSnapshot(browserWindow, { minWidth, minHeight });
  if (!windowState) return;

  await mutateSettingsRoot((root) => {
    if (browserWindow.isDestroyed()) return root;
    root.desktopWindowState = windowState;
  });
};
