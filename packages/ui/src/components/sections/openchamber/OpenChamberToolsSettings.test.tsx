import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { I18nProvider } from '@/lib/i18n';
import { settingsDict } from '@/lib/i18n/messages/en.settings';
import { useUIStore } from '@/stores/useUIStore';

import { OpenChamberToolsSettings } from './OpenChamberToolsSettings';

// Turning a direct tool on or off changes the request's tool list, which providers cache
// as the start of the prompt. In code mode only the render tool and the code mode switch
// itself still change that list, so the note names those instead.
describe('OpenChamberToolsSettings prompt cache note', () => {
  let windowInstance: Window;
  let host: HTMLDivElement;
  let root: Root;
  let initialCodeMode: boolean;
  let initialApplyLive: boolean;
  let fetchSpy: ReturnType<typeof spyOn>;
  let globalDescriptors: Map<string, PropertyDescriptor | undefined>;

  const globalNames = ['window', 'document', 'HTMLElement', 'Element', 'Node', 'localStorage', 'sessionStorage', 'requestAnimationFrame', 'cancelAnimationFrame', 'MutationObserver', 'IS_REACT_ACT_ENVIRONMENT'];
  const direct = settingsDict['settings.openchamber.tools.cacheNote.direct'];
  const codeMode = settingsDict['settings.openchamber.tools.cacheNote.codeMode'];

  beforeEach(() => {
    windowInstance = new Window();
    initialCodeMode = useUIStore.getState().agentToolsCodeMode;
    initialApplyLive = useUIStore.getState().managedToolsApplyLive;
    globalDescriptors = new Map(globalNames.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    Object.assign(globalThis, {
      window: windowInstance,
      document: windowInstance.document,
      HTMLElement: windowInstance.HTMLElement,
      Element: windowInstance.Element,
      Node: windowInstance.Node,
      localStorage: windowInstance.localStorage,
      sessionStorage: windowInstance.sessionStorage,
      // happy-dom 21 no longer leaks a global requestAnimationFrame into
      // the test realm, and Base UI's animation-completion hook calls the
      // bare global. Run frames synchronously, as in TerminalViewport.
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      },
      cancelAnimationFrame: () => undefined,
      MutationObserver: windowInstance.MutationObserver,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    // The page loads the extension catalog on mount; no server answers here.
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 404 }));
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    try {
      await act(async () => root.unmount());
    } finally {
      fetchSpy.mockRestore();
      useUIStore.setState({ agentToolsCodeMode: initialCodeMode, managedToolsApplyLive: initialApplyLive });
      windowInstance.close();
      for (const [name, descriptor] of globalDescriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    }
  });

  test('names the switches that change the tool list for the current code mode', async () => {
    expect(direct).not.toBe(codeMode);
    useUIStore.setState({ agentToolsCodeMode: false, managedToolsApplyLive: true });
    await act(async () => root.render(
      <I18nProvider>
        <OpenChamberToolsSettings />
      </I18nProvider>,
    ));

    expect(host.textContent).toContain(direct);
    expect(host.textContent).not.toContain(codeMode);

    await act(async () => useUIStore.setState({ agentToolsCodeMode: true }));

    expect(host.textContent).toContain(codeMode);
    expect(host.textContent).not.toContain(direct);
  });

  // With an external OpenCode or a user-owned OPENCODE_CONFIG a switch waits for a
  // restart, so the running session's cache is untouched and the note would be wrong.
  test('shows no cache note when the switches do not reach the running OpenCode live', async () => {
    useUIStore.setState({ agentToolsCodeMode: false, managedToolsApplyLive: false });
    await act(async () => root.render(
      <I18nProvider>
        <OpenChamberToolsSettings />
      </I18nProvider>,
    ));

    expect(host.textContent).not.toContain(direct);
    expect(host.textContent).not.toContain(codeMode);

    await act(async () => useUIStore.setState({ managedToolsApplyLive: true }));

    expect(host.textContent).toContain(direct);
  });
});
