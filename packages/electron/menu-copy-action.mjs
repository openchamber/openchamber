/**
 * The Edit menu's copy action. It cannot be the plain Electron `copy` role:
 * the app also dispatches its own `copy` menu action for the focused page's
 * document. But the copy itself must behave like the roles do and reach the
 * focused webContents whatever window owns it — a DevTools window is not a
 * `BrowserWindow`, so a focused-window lookup misses it and Cmd+C then copied
 * from the app document instead of the DevTools renderer the user is reading
 * (#6012).
 */
export const createCopyMenuAction = ({ getFocusedWebContents, dispatchAppCopy }) => () => {
  const focused = getFocusedWebContents();
  focused?.copy();
  // The app-side copy action resolves the app document's own selection, so it
  // belongs to an app page's webContents only. A DevTools renderer and a
  // guest page each carry a host webContents; their selections are already on
  // the clipboard through the copy above.
  if (focused && !focused.getHostWebContents()) dispatchAppCopy();
};
