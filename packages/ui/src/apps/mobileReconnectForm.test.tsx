import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { serveTestHttp } from '@/lib/test-http-server';

test('manual reconnect preserves secure headers through success and password cancellation; Instances can clear them', async () => {
  const dom = new Window({ url: 'http://localhost' });
  const secrets = new Map<string, string>();
  let authenticated = true;
  const received: string[] = [];
  const server = await serveTestHttp((request, response) => {
    received.push(String(request.headers['x-proxy'] || ''));
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(request.url === '/health' ? { status: 'ok' } : { authenticated, disabled: authenticated }));
  });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({
    window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage,
    getComputedStyle: dom.getComputedStyle.bind(dom),
    HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node, Event: dom.Event, CustomEvent: dom.CustomEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
    Capacitor: {
      PluginHeaders: [
        { name: 'SecureStorage', methods: ['internalGetItem', 'internalSetItem', 'internalRemoveItem'].map((name) => ({ name, rtype: 'promise' })) },
        { name: 'CapacitorHttp', methods: [{ name: 'request', rtype: 'promise' }] },
      ],
      nativePromise: async (plugin: string, method: string, options: { prefixedKey: string; data?: string; url: string; headers: Record<string, string> }) => {
        if (plugin === 'CapacitorHttp') {
          const response = await fetch(options.url, { headers: options.headers, redirect: 'manual' });
          return { status: response.status, data: await response.text(), headers: {}, url: response.url };
        }
        if (method === 'internalGetItem') return { data: secrets.get(options.prefixedKey) ?? null };
        if (method === 'internalSetItem') { secrets.set(options.prefixedKey, options.data || ''); return; }
        secrets.delete(options.prefixedKey);
        return { success: true };
      },
    },
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  Object.assign(dom, { Capacitor: { isNativePlatform: () => true } });
  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('@/lib/i18n');
  const { MobileConnectionWelcome } = await import('./MobileConnectionWelcome');
  const { MobileInstancesSurface } = await import('./MobileInstancesSurface');
  const { upsertMobileConnection, loadMobileConnectionHeaders, loadMobileConnections } = await import('./mobileConnections');
  const { switchRuntimeEndpoint } = await import('@/lib/runtime-switch');
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const url = server.url.toString().replace(/\/$/, '');
  let connected = 0;
  const onConnected = () => { connected += 1; };
  const input = async (selector: string, value: string) => {
    const element = container.querySelector<HTMLInputElement>(selector);
    if (!element) throw new Error(`Missing input ${selector}`);
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, 'value')!.set!.call(element, value);
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    });
  };
  const click = async (selector: string) => {
    const element = container.querySelector<HTMLButtonElement>(selector);
    if (!element) throw new Error(`Missing button ${selector}`);
    await act(async () => element.click());
  };
  const settle = async (done: () => boolean) => {
    for (let attempt = 0; attempt < 100 && !done(); attempt += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    }
    expect(done()).toBe(true);
  };
  try {
    const config = { url, values: { 'x-proxy': 'synthetic-secret' } };
    const saved = (await upsertMobileConnection({ label: 'Protected', candidates: [{ kind: 'direct', url }], requestHeaders: config }))[0];
    const secretSnapshot = [...secrets.entries()];
    await act(async () => root.render(<I18nProvider><MobileConnectionWelcome onConnected={onConnected} /></I18nProvider>));
    await input('input[type="url"]', url);
    await act(async () => container.querySelector('input[type="url"]')!.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    await settle(() => connected === 1);
    expect(received.length).toBeGreaterThan(0);
    expect(received.every((header) => header === 'synthetic-secret')).toBe(true);
    expect(await loadMobileConnectionHeaders(saved.id)).toEqual(config);
    expect([...secrets.entries()]).toEqual(secretSnapshot);

    authenticated = false;
    received.length = 0;
    await act(async () => container.querySelector('input[type="url"]')!.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    await settle(() => Boolean(container.querySelector('input[type="password"]')));
    await click('button[type="button"]');
    expect(await loadMobileConnectionHeaders(saved.id)).toEqual(config);
    expect([...secrets.entries()]).toEqual(secretSnapshot);
    expect(received.every((header) => header === 'synthetic-secret')).toBe(true);

    await act(async () => root.render(<I18nProvider><MobileInstancesSurface onConnect={onConnected} onActiveConnectionDeleted={() => {}} /></I18nProvider>));
    await settle(() => Boolean(container.querySelector('[aria-label="Edit"]')));
    await click('[aria-label="Edit"]');
    await settle(() => Boolean(container.querySelector('input[value="synthetic-secret"]')));
    await click('[aria-label="Remove header"]');
    expect(container.querySelector('form')!.checkValidity()).toBe(true);
    await click('form button[type="submit"]');
    await settle(() => !container.querySelector('form'));
    expect(await loadMobileConnectionHeaders(saved.id)).toBeUndefined();
    expect((await loadMobileConnections())[0].requestHeadersKey).toBeUndefined();
    expect(secrets.size).toBe(0);

    const relay = { relayUrl: 'wss://relay.example/tunnel', serverId: 'relay-only', hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'eHhY', y: 'eVlZ' } };
    const relaySaved = (await upsertMobileConnection({ label: 'Relay only', candidates: [{ kind: 'relay', relay }] }))[0];
    await act(async () => root.render(<I18nProvider><MobileInstancesSurface key="relay" onConnect={onConnected} onActiveConnectionDeleted={() => {}} /></I18nProvider>));
    await settle(() => Boolean(container.querySelector('[aria-label="Edit"]')));
    await click('[aria-label="Edit"]');
    await settle(() => Boolean(container.querySelector('form')));
    expect(container.querySelector('form input[type="url"]')).toBeNull();
    expect(container.querySelector('form fieldset')).toBeNull();
    await input('form input', '');
    await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    await settle(() => !container.querySelector('form'));
    const retainedRelay = (await loadMobileConnections()).find((connection) => connection.id === relaySaved.id);
    expect(retainedRelay?.label).toBe('Relay only');
    expect(retainedRelay?.candidates).toEqual([{ kind: 'relay', relay }]);
  } finally {
    await act(async () => root.unmount());
    switchRuntimeEndpoint({ apiBaseUrl: '', clientToken: null });
    server.close();
    await dom.happyDOM.close();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
