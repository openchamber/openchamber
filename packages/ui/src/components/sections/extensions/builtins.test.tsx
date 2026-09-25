import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';

import { I18nProvider } from '@/lib/i18n';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useGuestsStore } from '@/lib/guests/store';
import type { InstalledGuest } from '@/lib/guests/types';
import { getRuntimeApiBaseUrl, getRuntimeKey, switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { clearRuntimeAuthCredentialProvider, clearRuntimeUrlAuthToken } from '@/lib/runtime-auth';
import { getSettingsSaveState, reportSettingsSaveState } from '@/lib/persistence';
import { useGuestOauthStore } from '@/lib/guests/oauth-store';
import { ExtensionsPage } from './ExtensionsPage';
import { IntegrationsPage } from '../integrations/IntegrationsPage';

const builtIn: InstalledGuest = {
  id: 'openchamber-builtin-sdk-demo', name: 'SDK Demo', icon: 'apps', entry: 'panel/index.html', source: 'bundled', enabled: true, version: '1.23.2',
  capabilities: { requested: ['files', 'sessions', 'network'], granted: ['files', 'sessions', 'network'] },
  integration: { name: 'SDK Demo', description: 'GitHub', auth: 'token' },
};
const installed: InstalledGuest = { ...builtIn, id: 'third-party', name: 'Third-party', source: 'git', origin: { url: 'git@github.com:acme/third-party.git' }, integration: { name: 'Third-party', description: 'GitHub', auth: 'token' } };
const originalRuntimeKey = getRuntimeKey();
const originalBase = getRuntimeApiBaseUrl();

describe('built-in extension settings', () => {
  let dom: Window;
  let root: Root;
  let container: HTMLElement;
  let catalog: InstalledGuest[];
  let requests: string[];
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
      IS_REACT_ACT_ENVIRONMENT: true,
    };
    for (const [key, value] of Object.entries(values)) {
      globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, { configurable: true, value });
    }
    catalog = [builtIn, installed];
    requests = [];
    useGuestsStore.getState().resetForRuntimeSwitch(getRuntimeKey());
    const fetch = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const path = new URL(String(input), 'http://localhost').pathname;
      requests.push(`${init?.method ?? 'GET'} ${path}`);
      if (path === '/api/guests') return Response.json({ guests: catalog });
      if (path === '/api/guests/updates/check') return Response.json({ updates: {} });
      if (path.endsWith('/enabled')) {
        const payload = JSON.parse(String(init?.body));
        catalog = catalog.map((guest) => guest.id === builtIn.id ? { ...guest, enabled: payload.enabled } : guest);
        return Response.json({});
      }
      if (path.endsWith('/oauth/status')) return Response.json({ connected: false, account: '', hasClient: false, settings: {}, redirectUri: '' });
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
    switchRuntimeEndpoint({ apiBaseUrl: originalBase, runtimeKey: originalRuntimeKey });
    await new Promise(resolve => setTimeout(resolve, 0));
    clearRuntimeAuthCredentialProvider();
    clearRuntimeUrlAuthToken();
    useGuestOauthStore.getState().resetForRuntimeSwitch();
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
  const button = (text: string, parent: ParentNode = container) => {
    const result = [...parent.querySelectorAll('button')].find((entry) => entry.textContent?.trim() === text);
    if (!result) throw new Error(`Missing button: ${text}`);
    return result;
  };

  test('shows the built-in badge and enable/disable without removal or approval', async () => {
    await render(<ExtensionsPage />);
    const trigger = [...container.querySelectorAll('button')].find((entry) => entry.textContent?.includes('SDK Demo'));
    if (!trigger?.parentElement) throw new Error('Missing built-in card');
    const card = trigger.parentElement;
    expect(card.textContent).toContain('Built-in');
    await act(async () => { trigger.click(); });
    expect([...card.querySelectorAll('button')].some((entry) => entry.textContent?.trim() === 'Remove')).toBe(false);
    expect(card.textContent).not.toContain('Review permissions');
    expect(card.textContent).not.toContain('Open source');
    await act(async () => { button('Disable', card).click(); });
    expect(button('Enable', card)).toBeTruthy();
    await act(async () => { button('Enable', card).click(); });
    expect(button('Disable', card)).toBeTruthy();
    expect(requests.some((entry) => entry.includes('/capabilities'))).toBe(false);
    expect(requests.some((entry) => entry.startsWith('DELETE'))).toBe(false);
  });

  test('opens the Git source in the external browser', async () => {
    await render(<ExtensionsPage />);
    const trigger = [...container.querySelectorAll('button')].find((entry) => entry.textContent?.includes('Third-party'));
    if (!trigger) throw new Error('Missing Git extension card');
    await act(async () => { trigger.click(); });
    const open = spyOn(window, 'open').mockImplementation(() => null);
    try {
      await act(async () => { button('Open source').click(); });
      expect(open.mock.calls).toEqual([['https://github.com/acme/third-party', '_blank', 'noopener,noreferrer']]);
    } finally {
      open.mockRestore();
    }
  });

  test('places its token card in Built-in integrations, not Extension accounts', async () => {
    await render(<IntegrationsPage />);
    const builtInSection = container.querySelector('[data-settings-item="integrations.first-party"]');
    const installedSection = container.querySelector('[data-settings-item="integrations.guests"]');
    expect(builtInSection?.textContent).toContain('SDK Demo');
    expect(installedSection?.textContent).toContain('Third-party');
    expect(installedSection?.textContent).not.toContain('SDK Demo');
    const trigger = [...(builtInSection?.querySelectorAll('button') ?? [])].find((entry) => entry.textContent?.includes('SDK Demo'));
    if (!trigger) throw new Error('Missing token integration card');
    await act(async () => { trigger.click(); });
    expect(builtInSection?.querySelector('input[type="password"]')).toBeTruthy();
    expect(builtInSection?.textContent).toContain('API token');
  });

  test('remounts the account form and clears the save indicator when switching instances', async () => {
    await render(<IntegrationsPage />);
    const trigger = [...container.querySelectorAll('button')].find((entry) => entry.textContent?.includes('SDK Demo'));
    if (!trigger) throw new Error('Missing built-in account');
    await act(async () => { trigger.click(); });
    const previousInput = container.querySelector('input[type="password"]');
    expect(previousInput).toBeTruthy();
    await act(async () => {
      reportSettingsSaveState('saving');
      switchRuntimeEndpoint({ apiBaseUrl: 'https://next.example', runtimeKey: 'next' });
      useGuestOauthStore.getState().resetForRuntimeSwitch();
      useGuestsStore.getState().resetForRuntimeSwitch('next');
      useGuestsStore.getState().replaceCatalog(catalog, 'next');
    });
    expect(previousInput?.isConnected).toBe(false);
    expect(getSettingsSaveState()).toBe('idle');
    expect(container.querySelector('input[type="password"]')).toBeNull();
  });
});
