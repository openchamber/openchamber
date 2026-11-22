export const createCopyLinkMenuHook = ({ clipboard, ClipboardItem, onError }) => (defaultActions, properties) => {
  // external: https://github.com/sindresorhus/electron-context-menu/tree/v4.1.2 defaultActions.copyLink returns the existing item, so replace only its handler.
  defaultActions.copyLink().click = async () => {
    try {
      await clipboard.write([
        new ClipboardItem({
          'text/plain': properties.linkURL,
          'electron application/bookmark': {
            title: properties.linkText,
            url: properties.linkURL,
          },
        }),
      ]);
    } catch {
      onError();
    }
  };
  return [];
};
