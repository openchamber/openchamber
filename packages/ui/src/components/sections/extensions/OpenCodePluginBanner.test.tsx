import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';

import { I18nProvider } from '@/lib/i18n';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useGuestsStore } from '@/lib/guests/store';
import type { InstalledGuest, OpenCodePlugins } from '@/lib/guests/types';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { ExtensionsPage } from './ExtensionsPage';

// The toast is what the user reads when the button fails; the page has no Toaster mounted here.
const toasts: string[] = [];
mock.module('@/components/ui', () => ({ toast: { error: (message: string) => { toasts.push(message); }, success: () => {} } }));

const teapot: InstalledGuest = {
  id: 'teapot-tools', name: 'Teapot Tools', icon: 'cup', source: 'path', path: '/pkg/teapot', enabled: true, version: '1.0.0', opencodePlugin: true,
  capabilities: { requested: ['opencodePlugin'], granted: ['opencodePlugin'] },
};
const GLOBAL = '/home/me/.config/opencode/opencode.json';

describe('an extension that ships an OpenCode plugin', () => {
  let dom: Window;
  let root: Root;
  let container: HTMLElement;
  let catalog: InstalledGuest[];
  let plugins: OpenCodePlugins;
  let requests: string[];
  let buttonAnswer: () => Response;
  let restoreFetch = () => {};
  const globals = new Map<string, PropertyDescriptor | undefined>();

  beforeEach(() => {
    dom = new Window({ url: 'http://localhost/' });
    const values = {
      window: dom, document: dom.document, navigator: dom.navigator,
      HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node,
      DocumentFragment: dom.DocumentFragment, MutationObserver: dom.MutationObserver,
      ResizeObserver: dom.ResizeObserver, MouseEvent: dom.MouseEvent, Event: dom.Event,
      CustomEvent: dom.CustomEvent, getComputedStyle: dom.getComputedStyle.bind(dom),
      requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
      localStorage: dom.localStorage,
      IS_REACT_ACT_ENVIRONMENT: true,
    };
    for (const [key, value] of Object.entries(values)) {
      globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, { configurable: true, value });
    }
    catalog = [teapot];
    plugins = { delivery: 'file', globalConfigPath: GLOBAL, inGlobalConfig: [] };
    requests = [];
    toasts.length = 0;
    buttonAnswer = () => Response.json({ path: GLOBAL });
    useGuestsStore.getState().resetForRuntimeSwitch(getRuntimeKey());
    const fetch = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const path = new URL(String(input), 'http://localhost').pathname;
      requests.push(`${init?.method ?? 'GET'} ${path}`);
      if (path === '/api/guests') return Response.json({ guests: catalog, opencodePlugins: plugins });
      if (path === '/api/guests/teapot-tools/opencode-plugin/global-config') return buttonAnswer();
      if (path === '/api/guests/updates/check') return Response.json({ updates: {} });
      if (path === '/api/git/identities') return Response.json([]);
      return Response.json({ connected: false, userName: '', userEmail: '', sshCommand: null });
    });
    restoreFetch = () => fetch.mockRestore();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    await new Promise((resolve) => setTimeout(resolve, 0));
    restoreFetch();
    useGuestsStore.getState().resetForRuntimeSwitch(getRuntimeKey());
    await dom.happyDOM.close();
    for (const [key, value] of globals) {
      if (value) Object.defineProperty(globalThis, key, value);
      else Reflect.deleteProperty(globalThis, key);
    }
    globals.clear();
  });

  const render = async (page: React.ReactNode) => {
    await act(async () => { root.render(<I18nProvider><TooltipProvider>{page}</TooltipProvider></I18nProvider>); });
  };
  const openDetail = async () => {
    await render(<ExtensionsPage />);
    const card = [...container.querySelectorAll('button')].find((entry) => entry.textContent?.includes('Teapot Tools'));
    if (!card) throw new Error('Missing card');
    await act(async () => { card.click(); });
  };
  const addButton = () => [...container.querySelectorAll('button')].find((entry) => entry.textContent?.trim() === 'Add to global config') ?? null;

  test('a managed OpenCode reading our file: the screen says nothing about the plugin', async () => {
    await openDetail();
    expect(container.textContent).not.toContain('global OpenCode config');
    expect(addButton()).toBeNull();
  });

  test('an external OpenCode on this machine: the maintainer\'s line and the button, which writes and reports the file', async () => {
    plugins = { ...plugins, delivery: 'none' };
    await openDetail();
    expect(container.textContent).toContain('OpenChamber did not start this OpenCode, so the plugin is not loaded there.');
    expect(container.textContent).toContain('If you remove the extension, the entry stops working until you delete it on the Plugins page.');
    const button = addButton();
    if (!button) throw new Error('Missing button');
    plugins = { ...plugins, inGlobalConfig: ['teapot-tools'] };
    await act(async () => { button.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(requests).toContain('POST /api/guests/teapot-tools/opencode-plugin/global-config');
    expect(container.textContent).toContain(`Added to ${GLOBAL}.`);
    expect(addButton()).toBeNull();
  });

  test('a user-owned OPENCODE_CONFIG: the other line, and the server\'s reason when the write fails', async () => {
    plugins = { ...plugins, delivery: 'restart' };
    buttonAnswer = () => Response.json({ error: 'config-invalid', message: 'opencode.json contains invalid JSONC' }, { status: 409 });
    await openDetail();
    expect(container.textContent).toContain('Your environment sets OPENCODE_CONFIG, so the plugin loads the next time OpenCode starts.');
    const button = addButton();
    if (!button) throw new Error('Missing button');
    await act(async () => { button.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(toasts).toEqual(['Could not add the plugin to your global OpenCode config: opencode.json contains invalid JSONC']);
    expect(addButton()).not.toBeNull();
  });

  test('once the global config lists the folder: the state line and no button, also while the extension is off', async () => {
    plugins = { ...plugins, delivery: 'none', inGlobalConfig: ['teapot-tools'] };
    catalog = [{ ...teapot, enabled: false }];
    await openDetail();
    expect(container.textContent).toContain(`In your global OpenCode config: ${GLOBAL}. Manage it on the Plugins page.`);
    expect(addButton()).toBeNull();
  });

  test('an OpenCode on another machine: the line and no button; an extension that is off offers nothing', async () => {
    plugins = { ...plugins, delivery: 'remote' };
    await openDetail();
    expect(container.textContent).toContain('This OpenCode runs on another machine, so the plugin cannot be loaded there.');
    expect(addButton()).toBeNull();
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    plugins = { ...plugins, delivery: 'none' };
    catalog = [{ ...teapot, enabled: false }];
    await openDetail();
    expect(container.textContent).not.toContain('OpenChamber did not start this OpenCode');
    expect(addButton()).toBeNull();
  });
});
