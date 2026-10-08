import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';

import { useWebviewFocusGuard } from './useWebviewFocusGuard';

type GuardAgentAction = ReturnType<typeof useWebviewFocusGuard>;

describe('webview focus guard', () => {
  let dom: Window;
  let root: Root;
  let host: HTMLDivElement;
  let composer: HTMLTextAreaElement;
  let stage: HTMLDivElement;
  let webview: WebviewElement;
  let stageShown: boolean;
  let guardAgentAction: GuardAgentAction;
  let restoreGlobals: () => void;

  beforeEach(async () => {
    dom = new Window({ url: 'http://localhost/' });
    const globals = {
      window: dom,
      document: dom.document,
      navigator: dom.navigator,
      Event: dom.Event,
      HTMLElement: dom.HTMLElement,
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
    composer = document.createElement('textarea');
    document.body.appendChild(composer);

    stageShown = false;
    stage = Object.assign(document.createElement('div'), {
      getBoundingClientRect: () => new dom.DOMRect(0, 0, stageShown ? 400 : 0, 300),
      checkVisibility: () => stageShown,
    });
    document.body.appendChild(stage);
    webview = Object.assign(document.createElement('div'), {
      tabIndex: 0,
      getURL: () => '',
      getTitle: () => '',
      isLoading: () => false,
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
    stage.appendChild(webview);

    const stageRef = { current: stage };
    const Harness = () => {
      guardAgentAction = useWebviewFocusGuard(webview, stageRef);
      return null;
    };
    composer.focus();
    root = createRoot(host);
    await act(async () => root.render(<Harness />));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    await dom.happyDOM.close();
    restoreGlobals();
  });

  test('a hidden page that grabs focus hands it back to the composer', () => {
    webview.focus();
    expect(document.activeElement).toBe(composer);
  });

  test('a page the user can see takes focus when nothing drives it', () => {
    stageShown = true;
    webview.focus();
    expect(document.activeElement).toBe(webview);
  });

  test('a visible page cannot take focus while the agent opens or captures it', async () => {
    stageShown = true;
    await guardAgentAction(false, async () => {
      webview.focus();
      expect(document.activeElement).toBe(composer);
    });
    expect(document.activeElement).toBe(composer);
  });

  test('an agent click keeps the page focused while it runs, then returns focus', async () => {
    await guardAgentAction(true, async () => {
      webview.focus();
      expect(document.activeElement).toBe(webview);
    });
    expect(document.activeElement).toBe(composer);
  });

  test('a page the user was already in keeps focus after an agent click', async () => {
    stageShown = true;
    webview.focus();
    await guardAgentAction(true, async () => {});
    expect(document.activeElement).toBe(webview);
  });
});
