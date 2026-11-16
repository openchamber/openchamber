
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

export const attachDevWindowTape = (app, browserWindow) => {
  if (app.isPackaged) return;
  browserWindow.webContents.on('dom-ready', () => {
    void browserWindow.webContents.insertCSS(DEV_WINDOW_TAPE_CSS).catch(() => {});
  });
};
