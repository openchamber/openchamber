
export const browserPanelKeyAction = (input, platform) => {
  if (input.type !== 'keyDown' || input.isAutoRepeat || input.alt) return null;
  const mod = platform === 'darwin' ? input.meta && !input.control : input.control && !input.meta;
  if (!mod || String(input.key).toLowerCase() !== 'r') return null;
  return input.shift ? 'hard-reload' : 'reload';
};

export const browserPanelMouseAction = (mouse) => (
  mouse.button === 'back' || mouse.button === 'forward' ? mouse.button : null
);

export const runBrowserPanelAction = (contents, action) => {
  if (action === 'reload') contents.reload();
  else if (action === 'hard-reload') contents.reloadIgnoringCache();
  else if (action === 'back' && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
  else if (action === 'forward' && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
};
