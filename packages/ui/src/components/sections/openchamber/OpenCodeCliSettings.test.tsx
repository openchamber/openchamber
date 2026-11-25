import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';

import { I18nProvider } from '@/lib/i18n';
import { invalidateSettingsCache, loadDesktopSettings } from '@/lib/persistence';
import { opencodeClient } from '@/lib/opencode/client';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { ChildStoreManager } from '@/sync/child-store';
import { createEventRoutingIndex, handleEvent } from '@/sync/sync-context';
import { OpenCodeCliSettings } from './OpenCodeCliSettings';

const RESTART_LABEL = 'Restart OpenCode';
const SHARED_SERVICE_COMMAND = 'opencode service restart';

const requestUrl = (input: Parameters<typeof fetch>[0]) =>
  new URL(input instanceof URL ? input.href : input instanceof Request ? input.url : String(input), 'http://localhost').pathname;

describe('OpenCodeCliSettings', () => {
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
    invalidateSettingsCache();
    dom.close();
    for (const [key, desc] of globals) {
      if (desc) Object.defineProperty(globalThis, key, desc);
      else Reflect.deleteProperty(globalThis, key);
    }
    globals.clear();
  });

  const mockServer = (opencodeBinarySource: string) => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (requestUrl(input) === '/api/config/settings') {
        return Response.json({ opencodeBinary: '', useGlobalOpenCodeService: true });
      }
      if (requestUrl(input) === '/health') return Response.json({ opencodeBinarySource });
      return new Response(null, { status: 404 });
    });
    return () => fetchSpy.mockRestore();
  };

  const render = async (opencodeBinarySource: string) => {
    restoreFetch = mockServer(opencodeBinarySource);
    await loadDesktopSettings();
    await act(async () => {
      root.render(
        <I18nProvider>
          <OpenCodeCliSettings />
        </I18nProvider>,
      );
    });
    await settle();
  };

  const settle = async () => {
    for (let i = 0; i < 6; i += 1) {
      await act(async () => {
        await Promise.resolve();
      });
    }
  };

  const findRestartButton = () =>
    Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes(RESTART_LABEL));

  test('disables Restart and names the command on a shared service connection', async () => {
    await render('shared-service');

    const restartButton = findRestartButton();
    expect(restartButton).toBeTruthy();
    expect(restartButton?.hasAttribute('disabled')).toBe(true);
    expect(container.textContent).toContain(SHARED_SERVICE_COMMAND);
  });

  test('enables Restart when another client moves the server to managed mode', async () => {
    await render('shared-service');
    restoreFetch();
    restoreFetch = mockServer('bundled');

    const activeStatuses = spyOn(opencodeClient, 'getActiveSessionStatuses').mockResolvedValue(null);
    const childStores = new ChildStoreManager();
    await act(async () => handleEvent('global', { type: 'server.connected', properties: {} }, childStores, createEventRoutingIndex(), getRuntimeKey()));
    await settle();
    childStores.disposeAll();
    activeStatuses.mockRestore();

    expect(findRestartButton()?.hasAttribute('disabled')).toBe(false);
    expect(container.textContent).not.toContain(SHARED_SERVICE_COMMAND);
  });

  for (const [mode, source] of [['managed mode', 'bundled'], ['an OPENCODE_HOST connection', 'external']]) {
    test(`keeps Restart enabled in ${mode} while the shared-service setting is saved on`, async () => {
      await render(source);

      expect(container.querySelector('[role="checkbox"][aria-checked="true"]')).toBeTruthy();
      const restartButton = findRestartButton();
      expect(restartButton).toBeTruthy();
      expect(restartButton?.hasAttribute('disabled')).toBe(false);
      expect(container.textContent).not.toContain(SHARED_SERVICE_COMMAND);
    });
  }
});
