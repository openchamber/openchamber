// macOS gives a window in native full screen a Space of its own, and hiding
// the window leaves that Space on screen, empty and black. Such a window
// leaves full screen first and hides once the transition has ended. If it
// never leaves full screen, it stays visible, which the user can act on.
export const hideWindow = (browserWindow, platform = process.platform) => {
  if (!browserWindow || browserWindow.isDestroyed()) return;
  if (platform !== 'darwin' || !browserWindow.isFullScreen()) {
    browserWindow.hide();
    return;
  }
  browserWindow.once('leave-full-screen', () => {
    if (!browserWindow.isDestroyed()) browserWindow.hide();
  });
  browserWindow.setFullScreen(false);
};
