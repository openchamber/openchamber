const requests = new WeakMap();

export const isWindowHidePending = (browserWindow) => requests.get(browserWindow)?.hidden === true;

// macOS full-screen transitions are asynchronous. Keep the latest visibility
// intent until the native transition finishes, including an in-flight entry.
export const hideWindow = (browserWindow, platform = process.platform, { restoreFullScreen = true } = {}) => {
  if (!browserWindow || browserWindow.isDestroyed()) return;
  if (platform !== 'darwin') {
    browserWindow.hide();
    return;
  }
  const previous = requests.get(browserWindow);
  if (previous) {
    previous.hidden = true;
    previous.restoreFullScreen &&= restoreFullScreen;
    return;
  }
  const request = {
    hidden: true,
    restoreFullScreen,
    wasFullScreen: browserWindow.isFullScreen(),
    exiting: false,
  };
  const cleanup = () => {
    browserWindow.removeListener('enter-full-screen', onEnter);
    browserWindow.removeListener('leave-full-screen', onLeave);
    browserWindow.removeListener('closed', cleanup);
    requests.delete(browserWindow);
  };
  const exitFullScreen = () => {
    request.wasFullScreen = true;
    request.exiting = true;
    browserWindow.setFullScreen(false);
  };
  const onEnter = () => {
    if (browserWindow.isDestroyed()) cleanup();
    else if (request.hidden) exitFullScreen();
    // Electron queues an exit requested during entry. A show cancels hiding,
    // but restoration must still wait for that queued exit to finish.
    else if (!request.exiting) cleanup();
  };
  const onLeave = () => {
    request.exiting = false;
    if (browserWindow.isDestroyed()) {
      cleanup();
    } else if (request.hidden) {
      browserWindow.hide();
    } else {
      cleanup();
      if (request.restoreFullScreen && request.wasFullScreen) browserWindow.setFullScreen(true);
    }
  };
  request.show = () => {
    request.hidden = false;
    if (!request.exiting) {
      cleanup();
      return request.restoreFullScreen && request.wasFullScreen && !browserWindow.isFullScreen();
    }
    return false;
  };
  requests.set(browserWindow, request);
  browserWindow.on('enter-full-screen', onEnter);
  browserWindow.on('leave-full-screen', onLeave);
  browserWindow.once('closed', cleanup);
  if (request.wasFullScreen) exitFullScreen();
  else browserWindow.hide();
};

export const showWindow = (browserWindow) => {
  if (!browserWindow || browserWindow.isDestroyed()) return;
  const restoreFullScreen = requests.get(browserWindow)?.show();
  browserWindow.show();
  if (restoreFullScreen) browserWindow.setFullScreen(true);
};
