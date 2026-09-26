import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';

import { useWebviewNavigation, type WebviewNavigation } from './useWebviewNavigation';

describe('webview navigation failures', () => {
  let dom: Window;
  let root: Root;
  let host: HTMLDivElement;
  let navigation: WebviewNavigation;
  let currentUrl: string;
  let webview: WebviewElement;
  let restoreGlobals: () => void;

  beforeEach(async () => {
    dom = new Window({ url: 'http://localhost/' });
    const globals = {
      window: dom,
      document: dom.document,
      navigator: dom.navigator,
      Event: dom.Event,
      IS_REACT_ACT_ENVIRONMENT: true,
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
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    currentUrl = '';
    webview = Object.assign(document.createElement('div'), {
      getURL: () => currentUrl,
      getTitle: () => '',
      isLoading: () => true,
      canGoBack: () => false,
      canGoForward: () => false,
      loadURL: () => {},
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

    const Harness = () => {
      navigation = useWebviewNavigation(webview, {
        initialUrl: 'http://localhost:5199/',
        onUrlChange: () => {},
      });
      return null;
    };
    await act(async () => root.render(<Harness />));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    await dom.happyDOM.close();
    restoreGlobals();
  });

  test('keeps a failed navigation failed when stop-loading reports about:blank', async () => {
    await act(async () => {
      webview.dispatchEvent(Object.assign(new Event('did-fail-load'), {
        errorCode: -102,
        validatedURL: 'http://localhost:5199/',
        isMainFrame: true,
      }));
      webview.dispatchEvent(new Event('did-stop-loading'));
    });

    expect(navigation.status).toMatchObject({ kind: 'failed', url: 'http://localhost:5199/', code: -102 });
  });

  test('keeps the failed URL when getURL still points at the previous page', async () => {
    currentUrl = 'http://localhost:5198/';
    await act(async () => {
      webview.dispatchEvent(Object.assign(new Event('did-fail-load'), {
        errorCode: -102,
        validatedURL: 'http://localhost:5199/',
        isMainFrame: true,
      }));
      webview.dispatchEvent(new Event('did-stop-loading'));
    });

    expect(navigation.status).toMatchObject({ kind: 'failed', url: 'http://localhost:5199/', code: -102 });
  });

  test('a later successful navigation still becomes ready', async () => {
    await act(async () => {
      webview.dispatchEvent(Object.assign(new Event('did-fail-load'), {
        errorCode: -102,
        validatedURL: 'http://localhost:5199/',
        isMainFrame: true,
      }));
      webview.dispatchEvent(new Event('did-stop-loading'));
      webview.dispatchEvent(new Event('did-start-loading'));
      currentUrl = 'http://localhost:5199/';
      webview.dispatchEvent(new Event('did-stop-loading'));
    });

    expect(navigation.status).toMatchObject({ kind: 'ready', url: 'http://localhost:5199/' });
  });
});
