import { afterEach, describe, expect, test } from 'bun:test';

import type { DesktopHost } from './desktopHosts';
import { getLocalDesktopOrigin, resolveCurrentDesktopHost, withLocalDesktopHost } from './desktopCurrentHost';

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

type PageWindow = {
  location: { origin: string; href: string };
  __OPENCHAMBER_LOCAL_ORIGIN__?: string;
  __OPENCHAMBER_API_BASE_URL__?: string;
};

const showPage = (page: { origin: string; injectedLocalOrigin?: string; injectedApiBaseUrl?: string }): void => {
  const value: PageWindow = { location: { origin: page.origin, href: `${page.origin}/` } };
  if (page.injectedLocalOrigin !== undefined) value.__OPENCHAMBER_LOCAL_ORIGIN__ = page.injectedLocalOrigin;
  if (page.injectedApiBaseUrl !== undefined) value.__OPENCHAMBER_API_BASE_URL__ = page.injectedApiBaseUrl;
  Object.defineProperty(globalThis, 'window', { configurable: true, value });
};

afterEach(() => {
  if (originalWindow) {
    Object.defineProperty(globalThis, 'window', originalWindow);
  } else {
    Reflect.deleteProperty(globalThis, 'window');
  }
});

const remote: DesktopHost = { id: 'remote', label: 'Remote', url: 'http://192.168.1.20:3000' };

describe('Local in the desktop instance list', () => {
  // #4410 and #4632: Local used to take the page's own origin, which named the
  // packaged UI scheme, or the instance whose page the window was showing.
  test('is left out when the shell reported no local origin', () => {
    for (const page of [
      // OPENCHAMBER_SKIP_LOCAL_SERVER=1: the shell injects an empty origin.
      { origin: 'openchamber-ui://app', injectedLocalOrigin: '' },
      // A page another instance served, before the shell's init script ran.
      { origin: 'http://192.168.1.20:3000' },
    ]) {
      showPage(page);
      expect(withLocalDesktopHost([remote], getLocalDesktopOrigin())).toEqual([remote]);
    }
    // The hosts config answers null for a shell without a local server.
    expect(withLocalDesktopHost([remote], null)).toEqual([remote]);
  });

  test('comes first with the origin the shell reported', () => {
    showPage({ origin: 'http://192.168.1.20:3000', injectedLocalOrigin: 'http://127.0.0.1:57123' });
    expect(withLocalDesktopHost([remote], getLocalDesktopOrigin())).toEqual([
      { id: 'local', label: 'Local', url: 'http://127.0.0.1:57123' },
      remote,
    ]);
  });
});

describe('The instance the desktop window is on', () => {
  // #5241: OPENCHAMBER_SKIP_LOCAL_SERVER=1 with OPENCHAMBER_SERVER_URL pointing
  // at an unsaved server. The packaged page was named Local, an entry the list
  // left out, so the switcher offered no way to the instance it claimed.
  test('names an unsaved address on the packaged page by that address', () => {
    showPage({ origin: 'openchamber-ui://app', injectedLocalOrigin: '', injectedApiBaseUrl: 'http://127.0.0.1:3000/' });
    expect(resolveCurrentDesktopHost(withLocalDesktopHost([remote], null))).toEqual({
      id: 'custom',
      label: 'http://127.0.0.1:3000/',
      url: 'http://127.0.0.1:3000/',
    });
  });

  test('names that address too while the local server runs', () => {
    showPage({ origin: 'openchamber-ui://app', injectedLocalOrigin: 'http://127.0.0.1:57123', injectedApiBaseUrl: 'http://127.0.0.1:3000' });
    expect(resolveCurrentDesktopHost(withLocalDesktopHost([remote], 'http://127.0.0.1:57123')).label).toBe('http://127.0.0.1:3000/');
  });

  test('is Local on the packaged page talking to the local server', () => {
    showPage({ origin: 'openchamber-ui://app', injectedLocalOrigin: 'http://127.0.0.1:57123', injectedApiBaseUrl: 'http://127.0.0.1:57123' });
    expect(resolveCurrentDesktopHost(withLocalDesktopHost([remote], 'http://127.0.0.1:57123')).id).toBe('local');
  });

  test('is a saved instance when the runtime is that instance', () => {
    showPage({ origin: 'openchamber-ui://app', injectedLocalOrigin: '', injectedApiBaseUrl: 'http://192.168.1.20:3000' });
    expect(resolveCurrentDesktopHost(withLocalDesktopHost([remote], null)).id).toBe('remote');
  });
});
