// Marks the windows of an unpackaged run with a strip of construction tape
// along their top edge, the same tape as on the dev Dock icon, so a dev window
// can be told apart from the installed app's on screen.
//
// The strip is decoration only: it ignores the pointer, so clicks and window
// dragging go to whatever is under it.

// Colours match the tape on resources/icons/dev-icon.png and stay the same in
// every theme, like the icon.
export const DEV_WINDOW_TAPE_CSS = `html::after {
  content: '';
  position: fixed;
  inset-inline: 0;
  top: 0;
  height: 5px;
  z-index: 2147483647;
  pointer-events: none;
  background: repeating-linear-gradient(-45deg, #d6a23c 0 6px, #1b1b1b 6px 12px);
}`;

// Inserted CSS lasts until the page reloads, so it goes in on every dom-ready.
export const attachDevWindowTape = (app, browserWindow) => {
  if (app.isPackaged) return;
  browserWindow.webContents.on('dom-ready', () => {
    void browserWindow.webContents.insertCSS(DEV_WINDOW_TAPE_CSS).catch(() => {});
  });
};
