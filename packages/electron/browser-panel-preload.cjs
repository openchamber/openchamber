const { contextBridge } = require('electron');

contextBridge.executeInMainWorld({
  func: () => {
    const nativeOpen = window.open;
    const hasFeature = (features, name) => features
      .split(',')
      .map((entry) => entry.split('=')[0].trim().toLowerCase())
      .includes(name);
    window.open = function open(url, target, features) {
      // external: https://html.spec.whatwg.org/multipage/nav-history-apis.html#dom-open Window features undergo DOMString conversion.
      const list = features === undefined ? '' : String(features);
      const keepsOpener = !hasFeature(list, 'noopener') && !hasFeature(list, 'noreferrer');
      const asPopup = keepsOpener && !hasFeature(list, 'popup') ? (list ? `${list},popup` : 'popup') : list;
      return nativeOpen.call(this, url, target, asPopup);
    };
  },
});
