import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';

import { useGuestFrameUrl } from './useGuestFrameUrl';

describe('guest frame URL lifecycle', () => {
  let root: Root;
  let container: HTMLElement;
  let window: Window;
  let clock = 1_000_000;
  let mintCount = 0;
  let mintFails = false;
  let expiredMint = false;
  let holdNextMint = false;
  let legacyServer = false;
  let finishHeldMint: ((response: Response) => void) | undefined;
  let state: ReturnType<typeof useGuestFrameUrl> | undefined;
  const previousGlobals = new Map<string, PropertyDescriptor | undefined>();
  let restoreFetch = () => {};
  let restoreClock = () => {};
  const initial: { guestId: string; entry: string; instanceKey: string; enabled: boolean; origins: readonly string[] } = { guestId: 'dev-tools', entry: 'panel/index.html', instanceKey: 'v1', enabled: true, origins: [] };

  const Probe = (props: typeof initial) => {
    state = useGuestFrameUrl(props);
    return <div data-src={state.src} />;
  };
  const current = () => {
    if (!state) throw new Error('Probe has not mounted');
    return state;
  };
  const render = async (props = initial) => {
    await act(async () => { root.render(<Probe {...props} />); });
  };

  beforeEach(() => {
    clock = 1_000_000;
    mintCount = 0;
    mintFails = false;
    expiredMint = false;
    holdNextMint = false;
    legacyServer = false;
    finishHeldMint = undefined;
    state = undefined;
    window = new Window({ url: 'http://localhost/' });
    for (const [key, value] of Object.entries({ window, document: window.document, navigator: window.navigator, IS_REACT_ACT_ENVIRONMENT: true })) {
      previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, { configurable: true, value });
    }
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    const now = spyOn(Date, 'now').mockImplementation(() => clock);
    restoreClock = () => now.mockRestore();
    // A server with grants answers `frame-grant`; an older one answers 404
    // there and mints the guest-scoped query token instead. The lifecycle is
    // the same for both, so one credential name serves either.
    const fetch = spyOn(globalThis, 'fetch').mockImplementation(async (input, options) => {
      expect(options?.method).toBe('POST');
      if (String(input).includes('/api/guests/dev-tools/frame-grant')) {
        if (legacyServer) return new Response('', { status: 404 });
      } else {
        expect(legacyServer).toBe(true);
        expect(String(input)).toContain('scope=guest%3Adev-tools');
      }
      mintCount++;
      if (holdNextMint) {
        holdNextMint = false;
        return new Promise<Response>((resolve) => { finishHeldMint = resolve; });
      }
      const credential = `test-cred-${mintCount}`;
      return mintFails
        ? new Response('', { status: 401 })
        : Response.json({ grant: credential, token: credential, expiresAt: clock + (expiredMint ? -1 : 60_000) });
    });
    restoreFetch = () => fetch.mockRestore();
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    restoreFetch();
    restoreClock();
    await window.happyDOM.close();
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    previousGlobals.clear();
  });

  test('expiry alone never reloads a healthy panel; a later navigation gets fresh scoped auth', async () => {
    await render();
    const first = current().src;
    expect(first).toContain('test-cred-1');
    expect(current().recoverExpiredNavigation()).toBe(false);
    clock += 61_000;
    await render();
    expect(current().src).toBe(first);
    expect(mintCount).toBe(1);

    await act(async () => { expect(current().recoverExpiredNavigation()).toBe(true); });
    expect(current().src).toContain('test-cred-2');
    expect(mintCount).toBe(2);
    current().acknowledgeHandshake();
    expect(current().recoverExpiredNavigation()).toBe(false);
  });

  test('resuming and updating a panel do not reuse its previous frame URL', async () => {
    await render();
    await render({ ...initial, enabled: false });
    expect(current().src).toBe('');
    expect(mintCount).toBe(1);
    clock += 61_000;
    await render();
    expect(current().src).toContain('test-cred-2');
    await render({ ...initial, instanceKey: 'v2' });
    expect(current().src).toContain('test-cred-3');
  });

  test('failed recovery leaves no unauthenticated iframe URL', async () => {
    await render();
    clock += 61_000;
    mintFails = true;
    await act(async () => { current().recoverExpiredNavigation(); });
    expect(current().src).toBe('');
    expect(mintCount).toBe(2);
  });

  test('a late mint for an old entry cannot replace the current frame', async () => {
    holdNextMint = true;
    await render();
    expect(current().src).toBe('');
    await render({ ...initial, entry: 'panel/page.html', instanceKey: 'v2' });
    const next = current().src;
    expect(next).toContain('page.html');
    expect(next).toContain('test-cred-2');
    await act(async () => {
      if (!finishHeldMint) throw new Error('Expected a pending mint');
      finishHeldMint(Response.json({ grant: 'old-cred', token: 'old-cred', expiresAt: clock + 60_000 }));
    });
    expect(current().src).toBe(next);
  });

  test('does not loop if replacement credentials are already expired', async () => {
    expiredMint = true;
    await render();
    await act(async () => { current().recoverExpiredNavigation(); });
    expect(mintCount).toBe(2);
    await act(async () => { current().recoverExpiredNavigation(); });
    expect(mintCount).toBe(2);
    expect(current().src).toBe('');
  });

  test('a frame loads its package by grant, with nothing appended for relative URLs to lose', async () => {
    await render();
    expect(current().src).toContain('/api/guest-files/test-cred-1/panel/index.html');
    expect(current().src).not.toContain('oc_url_token');
  });

  test('a server that predates grants still gets the guest-scoped query token', async () => {
    legacyServer = true;
    await render();
    expect(current().src).toContain('/api/guests/dev-tools/panel/index.html');
    expect(current().src).toContain('oc_url_token=test-cred-1');
  });
});
