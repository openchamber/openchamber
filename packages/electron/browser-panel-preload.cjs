// Runs in every page of the user's browser panel (registered on its session in
// main.mjs). CommonJS on purpose: panel pages are sandboxed, and a sandboxed
// preload cannot be an ES module. It exposes nothing to the page.
//
// A page's `window.open` keeps `window.opener` unless it asks for noopener, and
// a sign-in posts its result back through that opener. Chromium reports a
// `window.open(url)` without window features as a new tab, the same as a
// target=_blank link, and the panel turns a new tab into a tab of its own,
// which has no opener. Marking such a call as a popup makes it open as a window
// that keeps the opener. Links with target=_blank are noopener by default, so
// they still become panel tabs.
const { contextBridge } = require('electron');

contextBridge.executeInMainWorld({
  func: () => {
    const nativeOpen = window.open;
    const hasFeature = (features, name) => features
      .split(',')
      .map((entry) => entry.split('=')[0].trim().toLowerCase())
      .includes(name);
    window.open = function open(url, target, features) {
      // The features argument is a DOMString: the browser converts whatever it gets.
      const list = features === undefined ? '' : String(features);
      const keepsOpener = !hasFeature(list, 'noopener') && !hasFeature(list, 'noreferrer');
      const asPopup = keepsOpener && !hasFeature(list, 'popup') ? (list ? `${list},popup` : 'popup') : list;
      return nativeOpen.call(this, url, target, asPopup);
    };
  },
});
