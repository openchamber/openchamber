export const createCopyMenuAction = ({ getFocusedWebContents, getAppWindows, dispatchAppCopy }) => () => {
  const focused = getFocusedWebContents();
  if (!focused) return;
  focused.copy();
  const appWindow = getAppWindows().find((window) => window.webContents === focused);
  if (appWindow) dispatchAppCopy(appWindow);
};
