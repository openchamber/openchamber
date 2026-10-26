export const createCopyLinkMenuHook = ({ clipboard, ClipboardItem, onError }) => (defaultActions, properties) => {
  // electron-context-menu 4.1.2 returns the item already in its template.
  // Replace only its handler so ordering, visibility and live labels stay intact.
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
      // Clipboard payloads and native error messages can contain private URLs.
      onError();
    }
  };
  return [];
};
