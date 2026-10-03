import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';

import { clearRuntimeAuthCredentialProvider, clearRuntimeUrlAuthToken, setRuntimeBearerToken } from '@/lib/runtime-auth';
import { getRuntimeApiBaseUrl, getRuntimeKey, switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { configureRuntimeUrlResolver } from '@/lib/runtime-url';
import { useGuestsStore } from './store';
import { useGuestIconSource } from './useGuestIconSource';

const svg = () => new Response('<svg xmlns="http://www.w3.org/2000/svg"/>', { headers: { 'content-type': 'image/svg+xml' } });
const guest = { id: 'demo', name: 'Demo', icon: 'icon.svg', version: '1.0.0', capabilities: { requested: [], granted: [] } };

describe('guest icon loading', () => {
  let root: Root;
  let window: Window;
  let icon: string | undefined;
  let created: number;
  let requests: string[];
  let revoked: string[];
  let reply: (url: string) => Promise<Response>;
  const globals = new Map<string, PropertyDescriptor | undefined>();
  const cleanup: Array<() => void> = [];
  const originalRuntimeKey = getRuntimeKey();
  const originalBase = getRuntimeApiBaseUrl();

  const Probe = ({ src }: { src: string }) => {
    icon = useGuestIconSource(src);
    return <span data-icon={icon} />;
  };
  const render = async (src = '/api/guests/demo/icon.svg') => {
    await act(async () => { root.render(<Probe src={src} />); });
  };

  beforeEach(() => {
    icon = undefined;
    created = 0;
    requests = [];
    revoked = [];
    reply = async () => svg();
    window = new Window({ url: 'http://localhost/' });
    for (const [key, value] of Object.entries({ window, document: window.document, navigator: window.navigator, IS_REACT_ACT_ENVIRONMENT: true })) {
      globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, { configurable: true, value });
    }
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    const fetch = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (String(input).includes('/auth/url-token')) return Response.json({ token: 'fixture-url-token', expiresAt: Date.now() + 60_000 });
      requests.push(String(input));
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer fixture-client');
      expect(String(input)).not.toContain('oc_url_token');
      return reply(String(input));
    });
    const create = spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:fixture-${++created}`);
    const revoke = spyOn(URL, 'revokeObjectURL').mockImplementation((url) => { revoked.push(url); });
    cleanup.push(() => fetch.mockRestore(), () => create.mockRestore(), () => revoke.mockRestore());
    configureRuntimeUrlResolver({ apiBaseUrl: 'https://first.example' });
    clearRuntimeUrlAuthToken();
    setRuntimeBearerToken('fixture-client');
    useGuestsStore.getState().resetForRuntimeSwitch(getRuntimeKey());
    useGuestsStore.getState().replaceCatalog([guest], getRuntimeKey());
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    switchRuntimeEndpoint({ apiBaseUrl: originalBase, runtimeKey: originalRuntimeKey, clientToken: 'fixture-client' });
    await new Promise(resolve => setTimeout(resolve, 0));
    clearRuntimeAuthCredentialProvider();
    clearRuntimeUrlAuthToken();
    useGuestsStore.getState().resetForRuntimeSwitch(originalRuntimeKey);
    for (const restore of cleanup.splice(0)) restore();
    await window.happyDOM.close();
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    globals.clear();
  });

  test('loads on first mount without a URL token and ignores expired URL tokens', async () => {
    await render('/api/guests/demo/icon.svg?oc_url_token=expired');
    expect(icon).toBe('blob:fixture-1');
    expect(requests).toEqual(['https://first.example/api/guests/demo/icon.svg']);
    await render('/api/guests/demo/icon.svg?oc_url_token=replaced');
    expect(icon).toBe('blob:fixture-1');
    expect(requests).toHaveLength(1);
    expect(revoked).toHaveLength(0);
  });

  test('refreshes a changed extension version and releases the old SVG', async () => {
    await render();
    await act(async () => {
      useGuestsStore.getState().replaceCatalog([{ ...guest, version: '1.1.0' }], getRuntimeKey());
    });
    expect(icon).toBe('blob:fixture-2');
    expect(revoked).toEqual(['blob:fixture-1']);
  });

  test('discards an old instance response after a runtime switch', async () => {
    let finishOld: ((response: Response) => void) | undefined;
    reply = async (url) => url.includes('first.example') ? new Promise(resolve => { finishOld = resolve; }) : svg();
    await render();
    expect(icon).toBeUndefined();
    await act(async () => {
      switchRuntimeEndpoint({ apiBaseUrl: 'https://second.example', runtimeKey: 'second', clientToken: 'fixture-client' });
    });
    expect(icon).toBe('blob:fixture-1');
    await act(async () => {
      if (!finishOld) throw new Error('Expected a pending first-instance request');
      finishOld(svg());
    });
    expect(created).toBe(1);
    expect(icon).toBe('blob:fixture-1');
  });

  test('keeps a fallback instead of materializing an HTML error response', async () => {
    reply = async () => new Response('<html>Not an icon</html>', { headers: { 'content-type': 'text/html' } });
    await render();
    expect(icon).toBeUndefined();
    expect(created).toBe(0);
  });
});
