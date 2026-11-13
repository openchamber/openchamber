import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';

import { clearRuntimeUrlAuthToken, setRuntimeUrlAuthToken } from '@/lib/runtime-auth';
import { createRuntimeUrlResolver, getRuntimeUrlResolver, setRuntimeUrlResolver } from '@/lib/runtime-url';
import { useRawAssetUrl } from './useRawAssetUrl';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator,
  Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement,
  Event: browser.Event, IS_REACT_ACT_ENVIRONMENT: true,
});

type Request = Parameters<typeof useRawAssetUrl>[0];
type Hook = ReturnType<typeof useRawAssetUrl>;

const request = (patch: Partial<NonNullable<Request>> = {}): NonNullable<Request> => ({
  runtime: 'local',
  path: '/repo/book.pdf',
  directory: '/repo',
  revision: '0',
  outsideWorkspace: false,
  ...patch,
});

let reactRoot: Root | null = null;
let latest: Hook | null = null;
let errors: Array<string | null> = [];
let mints = 0;
let failMint = false;
let gate: Promise<void> | null = null;
const previousResolver = getRuntimeUrlResolver();

// Stands in for the runtime's token mint: each call puts a new token in place,
// the way a real mint after expiry does.
const refreshUrlToken = async () => {
  if (gate) await gate;
  mints += 1;
  if (failMint) throw new Error('mint refused');
  const token = `oc_url_token-${mints}`;
  setRuntimeUrlAuthToken(token, Date.now() + 60_000);
  return token;
};
const reportError = (message: string | null) => { errors.push(message); };

const Probe: React.FC<{ request: Request }> = ({ request: current }) => {
  latest = useRawAssetUrl(current, reportError, 'read failed', refreshUrlToken);
  return null;
};

const render = async (current: Request) => {
  if (!reactRoot) reactRoot = createRoot(document.createElement('div'));
  await act(async () => reactRoot?.render(<Probe request={current} />));
};

const rendered = (): Hook => {
  if (!latest) throw new Error('the hook has not rendered');
  return latest;
};

const tokenOf = (url: string) => new URL(url).searchParams.get('oc_url_token');

beforeEach(() => {
  setRuntimeUrlResolver(createRuntimeUrlResolver({ apiBaseUrl: 'http://127.0.0.1:3001' }));
  clearRuntimeUrlAuthToken();
  latest = null;
  errors = [];
  mints = 0;
  failMint = false;
  gate = null;
});

afterEach(async () => {
  await act(async () => reactRoot?.unmount());
  reactRoot = null;
  setRuntimeUrlResolver(previousResolver);
  clearRuntimeUrlAuthToken();
});

describe('useRawAssetUrl', () => {
  test('keeps the first URL when the shared token rotates', async () => {
    const current = request();
    await render(current);
    const first = latest?.src ?? '';
    expect(tokenOf(first)).toBe('oc_url_token-1');
    expect(new URL(first).pathname).toBe('/api/fs/raw');
    expect(new URL(first).searchParams.get('path')).toBe('/repo/book.pdf');

    setRuntimeUrlAuthToken('oc_url_token-rotated', Date.now() + 60_000);
    await render(current);
    await render({ ...current });
    expect(latest?.src).toBe(first);
    expect(mints).toBe(1);
  });

  test('renew shows a URL with a fresh token for the same file', async () => {
    await render(request());
    const first = latest?.src ?? '';
    clearRuntimeUrlAuthToken();

    let renewed = '';
    const { renew } = rendered();
    await act(async () => { renewed = await renew(); });
    expect(tokenOf(renewed)).toBe('oc_url_token-2');
    expect(latest?.src).toBe(renewed);
    expect(new URL(renewed).searchParams.get('path')).toBe(new URL(first).searchParams.get('path'));
  });

  test('a changed file gets a new URL and loads in between', async () => {
    await render(request());
    const first = latest?.src ?? '';
    clearRuntimeUrlAuthToken();

    let release = () => {};
    gate = new Promise<void>((resolve) => { release = resolve; });
    await render(request({ revision: '1' }));
    expect(latest).toMatchObject({ src: '', loading: true });

    await act(async () => { release(); await gate; });
    expect(latest?.loading).toBe(false);
    expect(latest?.src).not.toBe(first);
    expect(tokenOf(latest?.src ?? '')).toBe('oc_url_token-2');
  });

  test('a failed mint reports the error and still points at the file', async () => {
    failMint = true;
    await render(request());
    expect(errors).toEqual(['mint refused']);
    expect(latest?.loading).toBe(false);
    expect(new URL(latest?.src ?? '').searchParams.get('path')).toBe('/repo/book.pdf');
  });

  test('no file means no URL and no mint', async () => {
    await render(null);
    expect(latest).toMatchObject({ src: '', loading: false });
    expect(mints).toBe(0);
  });
});
