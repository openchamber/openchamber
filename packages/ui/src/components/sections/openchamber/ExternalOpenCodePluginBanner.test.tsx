import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';

import { I18nProvider } from '@/lib/i18n';
import { ExternalOpenCodePluginBanner } from './ExternalOpenCodePluginBanner';

const PLUGIN_PATH = '/home/me/.config/openchamber/plugins/openchamber';
const GLOBAL_PATH = '/home/me/.config/opencode/opencode.json';

const requestUrl = (input: Parameters<typeof fetch>[0]) => (
  input instanceof URL ? input.href : input instanceof Request ? input.url : input
);

describe('ExternalOpenCodePluginBanner', () => {
  let dom: Window;
  let root: Root;
  let container: HTMLElement;
  let restoreFetch = () => {};
  const globals = new Map<string, PropertyDescriptor | undefined>();

  beforeEach(() => {
    dom = new Window({ url: 'http://localhost/' });
    const values = {
      window: dom,
      document: dom.document,
      navigator: dom.navigator,
      HTMLElement: dom.HTMLElement,
      Element: dom.Element,
      Node: dom.Node,
      DocumentFragment: dom.DocumentFragment,
      MutationObserver: dom.MutationObserver,
      IS_REACT_ACT_ENVIRONMENT: true,
    };
    for (const [key, value] of Object.entries(values)) {
      globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    }
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    restoreFetch();
    restoreFetch = () => {};
    dom.close();
    for (const [key, desc] of globals) {
      if (desc) Object.defineProperty(globalThis, key, desc);
      else Reflect.deleteProperty(globalThis, key);
    }
    globals.clear();
  });

  const flush = async () => {
    for (let i = 0; i < 6; i += 1) {
      await act(async () => {
        await Promise.resolve();
      });
    }
  };

  test('stays hidden when OpenChamber manages OpenCode directly', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (requestUrl(input).endsWith('/api/config/external-opencode-plugin')) {
        return Response.json({
          delivery: 'file',
          pluginPath: PLUGIN_PATH,
          globalConfigPath: GLOBAL_PATH,
          inGlobalConfig: false,
          bridgeActive: false,
        });
      }
      return new Response(null, { status: 404 });
    });
    restoreFetch = () => fetchSpy.mockRestore();

    await act(async () => {
      root.render(
        <I18nProvider>
          <ExternalOpenCodePluginBanner />
        </I18nProvider>,
      );
    });
    await flush();

    expect(container.textContent).toBe('');
  });

  test('offers adding and removing the plugin in global config for external local OpenCode', async () => {
    let inGlobalConfig = false;
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = requestUrl(input);
      if (url.endsWith('/api/config/external-opencode-plugin')) {
        return Response.json({
          delivery: 'none',
          pluginPath: PLUGIN_PATH,
          globalConfigPath: GLOBAL_PATH,
          inGlobalConfig,
          bridgeActive: true,
        });
      }
      if (url.endsWith('/api/config/external-opencode-plugin/global-config') && init?.method === 'POST') {
        inGlobalConfig = true;
        return Response.json({ path: GLOBAL_PATH, added: true, pluginPath: PLUGIN_PATH });
      }
      if (url.endsWith('/api/config/external-opencode-plugin/global-config') && init?.method === 'DELETE') {
        inGlobalConfig = false;
        return Response.json({ path: GLOBAL_PATH, removed: true });
      }
      return new Response(null, { status: 404 });
    });
    restoreFetch = () => fetchSpy.mockRestore();

    await act(async () => {
      root.render(
        <I18nProvider>
          <ExternalOpenCodePluginBanner />
        </I18nProvider>,
      );
    });
    await flush();

    expect(container.textContent).toContain(PLUGIN_PATH);
    const addButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('Add to OpenCode config'));
    expect(addButton).toBeTruthy();

    await act(async () => {
      addButton?.click();
    });
    await flush();

    expect(container.textContent).toContain(`Added OpenChamber plugin to ${GLOBAL_PATH}`);
    const removeButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('Remove'));
    expect(removeButton).toBeTruthy();

    await act(async () => {
      removeButton?.click();
    });
    await flush();

    const addAgain = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('Add to OpenCode config'));
    expect(addAgain).toBeTruthy();
  });
});
