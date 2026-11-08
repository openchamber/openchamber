import React, { act } from 'react';
import { expect, spyOn, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';

import { I18nProvider } from '@/lib/i18n';
import { getRuntimeExtraHeadersSync } from '@/lib/runtime-auth';
import { switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { loadMobileConnectionHeaders, useMobileConnection } from './mobileConnections';

test('password sign-in keeps proxy headers, editing clears them, and deletion removes the connection', async () => {
  const dom = new Window({ url: 'http://localhost' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({
    window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage,
    HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event, CustomEvent: dom.CustomEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const requests: { url: string; method: string; headers: Headers; redirect?: RequestRedirect }[] = [];
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const method = init?.method || 'GET';
    requests.push({ url, method, headers, redirect: init?.redirect });
    if (url.endsWith('/health')) return Response.json({ status: 'ok' });
    if (url.endsWith('/auth/session')) {
      if (headers.get('X-Proxy') !== 'secret') return new Response(null, { status: 403 });
      return Response.json(method === 'POST' ? { clientToken: 'issued-client-token' } : { authenticated: false });
    }
    return Response.json({});
  });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let controller: ReturnType<typeof useMobileConnection> | undefined;
  let connected = 0;
  const Harness = () => {
    controller = useMobileConnection(() => { connected += 1; });
    return null;
  };
  const connection = () => {
    if (!controller) throw new Error('Connection controller not mounted');
    return controller;
  };
  try {
    await act(async () => root.render(<I18nProvider><Harness /></I18nProvider>));
    await act(async () => connection().connect({ url: 'https://protected.example', requestHeaders: { 'X-Proxy': 'secret', Authorization: 'wrong-token' } }));
    expect(connection().pendingConnection).not.toBeNull();
    expect(connection().connections).toHaveLength(1);
    const id = connection().connections[0].id;
    expect(connection().pendingConnection?.id).toBe(id);
    await act(async () => connection().submitPassword('password'));
    expect(connection().error).toBeNull();
    expect(connected).toBe(1);
    expect(connection().pendingConnection).toBeNull();
    expect(connection().connections).toHaveLength(1);
    expect(getRuntimeExtraHeadersSync()).toEqual({ 'x-proxy': 'secret' });
    const login = requests.find((request) => request.method === 'POST' && request.url.endsWith('/auth/session'));
    expect(login?.headers.get('X-Proxy')).toBe('secret');
    expect(login?.headers.get('Content-Type')).toBe('application/json');
    expect(login?.headers.has('Authorization')).toBe(false);
    expect(login?.redirect).toBe('error');
    expect(requests.filter((request) => request.url.endsWith('/health')).every((request) => request.headers.get('X-Proxy') === 'secret')).toBe(true);

    await act(async () => { await connection().saveConnection({ id, url: 'https://protected.example', label: 'Renamed', requestHeaders: {} }); });
    expect(await loadMobileConnectionHeaders(id)).toBeUndefined();
    expect(getRuntimeExtraHeadersSync()).toEqual({});
    await act(async () => { await connection().removeConnection(id); });
    expect(connection().connections).toHaveLength(0);
  } finally {
    await act(async () => root.unmount());
    switchRuntimeEndpoint({ apiBaseUrl: '', clientToken: null });
    fetchSpy.mockRestore();
    await dom.happyDOM.close();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
