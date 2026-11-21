import React, { act } from 'react';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { browserTabFirstLoadReferrer, forgetBrowserTabOpenedWithAddress, subscribeBrowserTabLoadRequests } from '@/lib/browser/devServerWait';
import { useUIStore } from '@/stores/useUIStore';
import { openBrowserTabFromLink, useBrowserTabReferrer } from './useBrowserTabReferrer';

const directory = '/repo';
const url = 'https://target.test/report';
const referrer = { url: 'https://source.test/page', policy: 'strict-origin-when-cross-origin' };
const tabID = `browser:${url}`;
const openFromLink = (options?: { reveal?: boolean }) => openBrowserTabFromLink(
  directory,
  referrer,
  () => useUIStore.getState().openContextBrowser(directory, url, options),
);

let dom: Window;
let restoreGlobals: () => void;

beforeEach(() => {
  dom = new Window({ url: 'http://tab-referrer.test' });
  const globals = {
    window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage,
    Element: dom.Element, HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true,
  };
  const descriptors = Object.getOwnPropertyDescriptors(globalThis);
  Object.assign(globalThis, globals);
  restoreGlobals = () => {
    for (const key of Object.keys(globals)) {
      const descriptor = descriptors[key];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
  useUIStore.setState({ contextPanelByDirectory: {} });
});

afterEach(async () => {
  forgetBrowserTabOpenedWithAddress(directory, tabID);
  useUIStore.setState({ contextPanelByDirectory: {} });
  await dom.happyDOM.close();
  restoreGlobals();
});

test('only the tab a link creates gets the page referrer, until it mounts', () => {
  openFromLink();
  expect(useUIStore.getState().contextPanelByDirectory[directory]?.tabs.map((tab) => tab.id)).toEqual([tabID]);
  expect(browserTabFirstLoadReferrer(directory, tabID)).toEqual(referrer);

  forgetBrowserTabOpenedWithAddress(directory, tabID);
  openFromLink();
  expect(browserTabFirstLoadReferrer(directory, tabID)).toBeUndefined();
});

test('a link tab closed before it mounts leaves no referrer for the next tab at that address', () => {
  openFromLink({ reveal: false });
  useUIStore.getState().closeContextPanelTab(directory, tabID);
  expect(browserTabFirstLoadReferrer(directory, tabID)).toBeUndefined();
  useUIStore.getState().openContextBrowser(directory, url);
  expect(browserTabFirstLoadReferrer(directory, tabID)).toBeUndefined();
});

test('a link to an address that already has a tab asks that tab to load with the link referrer', () => {
  openFromLink();
  forgetBrowserTabOpenedWithAddress(directory, tabID);
  const requests: unknown[][] = [];
  const unsubscribe = subscribeBrowserTabLoadRequests(directory, tabID, (...args) => { requests.push(args); });

  openFromLink();
  useUIStore.getState().openContextBrowser(directory, url);
  unsubscribe();

  expect(requests).toEqual([[url, referrer], [url, undefined]]);
});

const mountLinkTab = async (src = url) => {
  const { createRoot } = await import('react-dom/client');
  const loads: unknown[][] = [];
  const events: string[] = [];
  let crashed = false;
  const webview = Object.assign(document.createElement('div'), {
    getURL: () => '',
    getTitle: () => '',
    isLoading: () => false,
    isCrashed: () => crashed,
    canGoBack: () => false,
    canGoForward: () => false,
    loadURL: async (...args: unknown[]) => { loads.push(args); },
    clearHistory: () => { events.push('clearHistory'); },
    goBack: () => {},
    goForward: () => {},
    reload: () => {},
    reloadIgnoringCache: () => {},
    getZoomLevel: () => 0,
    setZoomLevel: () => {},
    stop: () => {},
    getWebContentsId: () => 1,
    openDevTools: () => {},
    closeDevTools: () => {},
    isDevToolsOpened: () => false,
    executeJavaScript: async () => undefined,
  });
  webview.addEventListener('did-fail-load', () => events.push('navigation sees the failure'));
  const onFirstPage = () => { events.push('dev-server wait rearmed'); };
  openFromLink();
  const shown: unknown[] = [];
  function Probe() {
    shown.push(useBrowserTabReferrer(webview, directory, tabID, src, url, onFirstPage));
    return null;
  }
  const root = createRoot(document.createElement('div'));
  await act(async () => { root.render(<Probe />); });
  const fire = (type: string) => webview.dispatchEvent(new Event(type));
  const failLoad = (errorCode: number) => webview.dispatchEvent(Object.assign(new Event('did-fail-load'), { errorCode, isMainFrame: true }));
  const navigate = (committedUrl: string) => webview.dispatchEvent(Object.assign(new Event('did-navigate'), { url: committedUrl }));
  // The order Electron reports when the guest dies: the cut load stops first, then the process is gone.
  const crash = () => {
    crashed = true;
    fire('did-stop-loading');
    fire('render-process-gone');
  };
  // Crash recovery reloads the last committed entry, the blank page.
  const recover = () => {
    crashed = false;
    fire('did-start-navigation');
    navigate('about:blank');
    fire('dom-ready');
    fire('did-stop-loading');
  };
  return { loads, events, shown, fire, failLoad, navigate, crash, recover, unmount: () => act(async () => { root.unmount(); }) };
};

test('the first load carries the referrer and leaves one history entry, also when it fails', async () => {
  const { loads, events, fire, failLoad, unmount } = await mountLinkTab();

  fire('dom-ready');
  expect(loads).toEqual([[url, { httpReferrer: referrer }]]);

  fire('did-stop-loading');
  fire('did-start-navigation');
  failLoad(-3);
  expect(events).toEqual(['navigation sees the failure']);

  failLoad(-105);
  fire('did-navigate');
  expect(events).toEqual(['navigation sees the failure', 'clearHistory', 'dev-server wait rearmed', 'navigation sees the failure']);
  fire('dom-ready');
  expect(loads).toHaveLength(1);

  await unmount();
});

test('a first load that ends without a page, such as a download, leaves the tab like an empty one', async () => {
  const { loads, events, fire, failLoad, crash, recover, unmount } = await mountLinkTab();

  fire('dom-ready');
  fire('did-stop-loading');
  fire('did-start-navigation');
  failLoad(-3);
  fire('did-stop-loading');
  fire('dom-ready');
  expect(loads).toHaveLength(1);

  // A crash of the idle blank page afterwards does not fetch the download again.
  crash();
  recover();
  expect(loads).toHaveLength(1);

  fire('did-start-navigation');
  fire('did-navigate');
  expect(events).toEqual(['navigation sees the failure']);

  await unmount();
});

test('a guest that crashes before the first page loads the address again with the referrer', async () => {
  const { loads, events, fire, navigate, crash, recover, unmount } = await mountLinkTab();

  fire('dom-ready');
  fire('did-stop-loading');
  fire('did-start-navigation');
  crash();
  recover();
  expect(loads).toEqual([[url, { httpReferrer: referrer }], [url, { httpReferrer: referrer }]]);
  expect(events).toEqual([]);

  fire('did-start-navigation');
  navigate(url);
  expect(events).toEqual(['clearHistory', 'dev-server wait rearmed']);

  await unmount();
});

test('an address typed before the link address resolves loads without the link referrer', async () => {
  const { loads, shown, fire, unmount } = await mountLinkTab('https://typed.test/');

  expect(shown.at(-1)).toBeUndefined();
  fire('dom-ready');
  expect(loads).toEqual([]);

  await unmount();
});
