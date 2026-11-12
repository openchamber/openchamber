// Copy the focused document, including guests and undocked DevTools (#6012).
export const createCopyMenuAction = ({ getFocusedWebContents, getAppWindows, dispatchAppCopy }) => () => {
  const focused = getFocusedWebContents();
  if (!focused) return;
  focused.copy();
  // DevTools can have no host; only an app window's exact document qualifies.
  const appWindow = getAppWindows().find((window) => window.webContents === focused);
  if (appWindow) dispatchAppCopy(appWindow);
};
