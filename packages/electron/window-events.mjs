// Chromium's Page Visibility remains visible with backgroundThrottling disabled.
export const isNativeWindowVisible = (window) => Boolean(
  window && !window.isDestroyed() && window.isVisible() && !window.isMinimized(),
);

export const attachWindowEvents = (window, emit, platform = process.platform) => {
  const reportVisibility = () => emit(window, 'openchamber:window-visibility', isNativeWindowVisible(window));
  for (const event of ['show', 'hide', 'minimize', 'restore']) window.on(event, reportVisibility);

  if (platform === 'darwin') {
    const reportLayoutChange = () => emit(window, 'openchamber:window-resized');
    for (const event of ['resize', 'enter-full-screen', 'leave-full-screen']) {
      window.on(event, reportLayoutChange);
    }
  }
};
