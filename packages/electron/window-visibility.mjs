// Chromium's Page Visibility remains visible with backgroundThrottling disabled.
export const isNativeWindowVisible = (window) => Boolean(
  window && !window.isDestroyed() && window.isVisible() && !window.isMinimized(),
);

export const attachWindowVisibility = (window, emit) => {
  const report = () => emit(window, 'openchamber:window-visibility', isNativeWindowVisible(window));
  for (const event of ['show', 'hide', 'minimize', 'restore']) window.on(event, report);
};
