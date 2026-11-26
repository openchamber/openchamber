import { afterEach, describe, expect, test } from 'bun:test';

import { getUrlScheme, isAppLinkUrl, isLoopbackHttpUrl, isMailtoUrl, extractLoopbackUrls, openConfirmedAppLinkUrl, openExternalUrl, openMailtoUrl } from '@/lib/url';

describe('confirmed desktop app links', () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  afterEach(() => {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  });

  test('passes the complete editor URL to the native bridge', async () => {
    const opened: string[] = [];
    const browserOpened: string[] = [];
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {
      __OPENCHAMBER_DESKTOP__: { openExternal: async (url: string) => { opened.push(url); } },
      open: (url: string) => { browserOpened.push(url); },
    } });
    const url = 'vscode://file/C:/Project/src/PlayerData.luau:42:3';
    expect(await openConfirmedAppLinkUrl(url)).toBe(true);
    expect(opened).toEqual([url]);
    expect(browserOpened).toEqual([]);
    expect(await openConfirmedAppLinkUrl('javascript:alert(1)')).toBe(false);
    expect(opened).toEqual([url]);
  });

  test('does not open a browser window when the native app handler fails', async () => {
    const browserOpened: string[] = [];
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {
      __OPENCHAMBER_DESKTOP__: { openExternal: async () => { throw new Error('No protocol handler'); } },
      open: (url: string) => { browserOpened.push(url); },
    } });
    expect(await openConfirmedAppLinkUrl('cursor://file/Project/a.ts:12')).toBe(false);
    expect(browserOpened).toEqual([]);
    expect(await openExternalUrl('https://example.test/')).toBe(true);
    expect(browserOpened).toEqual(['https://example.test/']);
  });

  test('opens valid mail links only through the desktop bridge', async () => {
    const opened: string[] = [];
    const browserOpened: string[] = [];
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {
      __OPENCHAMBER_DESKTOP__: { openExternal: async (url: string) => { opened.push(url); } },
      open: (url: string) => { browserOpened.push(url); },
    } });
    expect(await openMailtoUrl('mailto:user@example.test?attach=/etc/passwd')).toBe(false);
    expect(await openMailtoUrl('mailto:user@example.test?subject=Hi')).toBe(true);
    expect(await openExternalUrl('mailto:user@example.test')).toBe(false);
    expect(opened).toEqual(['mailto:user@example.test?subject=Hi']);

    Object.defineProperty(globalThis, 'window', { configurable: true, value: {
      __OPENCHAMBER_DESKTOP__: { openExternal: async () => { throw new Error('No mail client'); } },
      open: (url: string) => { browserOpened.push(url); },
    } });
    expect(await openMailtoUrl('mailto:user@example.test')).toBe(false);

    Object.defineProperty(globalThis, 'window', { configurable: true, value: {
      __OPENCHAMBER_DESKTOP__: {},
      open: (url: string) => { browserOpened.push(url); },
    } });
    expect(await openMailtoUrl('mailto:user@example.test')).toBe(false);
    expect(browserOpened).toEqual([]);
  });

  test('keeps browser app-link handling when there is no desktop bridge', async () => {
    const browserOpened: string[] = [];
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {
      open: (url: string) => { browserOpened.push(url); },
    } });
    expect(await openConfirmedAppLinkUrl('vscode://file/Project/a.ts:12')).toBe(true);
    expect(browserOpened).toEqual(['vscode://file/Project/a.ts:12']);
  });
});

describe('getUrlScheme', () => {
  test('extracts the lowercased scheme', () => {
    expect(getUrlScheme('Obsidian://open?vault=X')).toBe('obsidian');
    expect(getUrlScheme('https://example.test')).toBe('https');
  });

  test('returns null for unparseable values', () => {
    expect(getUrlScheme('')).toBeNull();
    expect(getUrlScheme('not a url')).toBeNull();
  });
});

describe('isAppLinkUrl', () => {
  test('accepts custom application schemes', () => {
    expect(isAppLinkUrl('obsidian://open?vault=Notebook&file=a%20b')).toBe(true);
    expect(isAppLinkUrl('vscode://file/path/to/file.ts')).toBe(true);
    expect(isAppLinkUrl('linear://issue/ABC-1')).toBe(true);
    expect(isAppLinkUrl('notion://note/xyz')).toBe(true);
    expect(isAppLinkUrl('slack://channel?id=C123')).toBe(true);
  });

  test('rejects browser and communication schemes', () => {
    expect(isAppLinkUrl('https://example.test')).toBe(false);
    expect(isAppLinkUrl('http://example.test')).toBe(false);
    expect(isAppLinkUrl('mailto:user@example.test')).toBe(false);
    expect(isAppLinkUrl('tel:+1234567890')).toBe(false);
    expect(isAppLinkUrl('sms:+1234567890')).toBe(false);
    expect(isAppLinkUrl('webcal://example.test/cal.ics')).toBe(false);
  });

  test('rejects dangerous and internal schemes', () => {
    expect(isAppLinkUrl('javascript:alert(1)')).toBe(false);
    expect(isAppLinkUrl('data:text/html;base64,PHNjcmlwdD4=')).toBe(false);
    expect(isAppLinkUrl('vbscript:msgbox(1)')).toBe(false);
    expect(isAppLinkUrl('blob:https://example.test/uuid')).toBe(false);
    expect(isAppLinkUrl('about:blank')).toBe(false);
    expect(isAppLinkUrl('file:///etc/passwd')).toBe(false);
    expect(isAppLinkUrl('ws://localhost:8080')).toBe(false);
    expect(isAppLinkUrl('ftp://files.example.test')).toBe(false);
    expect(isAppLinkUrl('intent://scan/#Intent;scheme=zxing;end')).toBe(false);
    expect(isAppLinkUrl('chrome://settings')).toBe(false);
    expect(isAppLinkUrl('devtools://devtools/bundled/inspector.html')).toBe(false);
    expect(isAppLinkUrl('ms-msdt:/id%20PCWDiagnostic')).toBe(false);
    expect(isAppLinkUrl('search-ms:query=report')).toBe(false);
    expect(isAppLinkUrl('shell:AppsFolder')).toBe(false);
  });

  test('rejects OpenChamber and Capacitor self-deep-links', () => {
    expect(isAppLinkUrl('openchamber://connect?host=x')).toBe(false);
    expect(isAppLinkUrl('openchamber-ui://app/index.html')).toBe(false);
    expect(isAppLinkUrl('capacitor://localhost/index.html')).toBe(false);
  });

  test('rejects malformed input', () => {
    expect(isAppLinkUrl('')).toBe(false);
    expect(isAppLinkUrl('random text')).toBe(false);
  });
});


describe('app links inside VS Code', () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  afterEach(() => {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  });

  test('does not offer the links the extension host refuses', () => {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { __VSCODE_CONFIG__: { uriScheme: 'cursor' } } });
    expect(isAppLinkUrl('zed://file/a.ts')).toBe(true);
    expect(isAppLinkUrl('figma://file/abc')).toBe(true);
    expect(isAppLinkUrl('vscode://file/a.ts')).toBe(false);
    expect(isAppLinkUrl('vscode-insiders://file/a.ts')).toBe(false);
    expect(isAppLinkUrl('Cursor://anysphere.cursor-retrieval/x')).toBe(false);
    expect(isAppLinkUrl('command:workbench.action.terminal.new')).toBe(false);
    expect(isAppLinkUrl('vscode-remote://ssh-remote+x/tmp')).toBe(false);
  });

  test('keeps the editor schemes as app links outside VS Code', () => {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
    expect(isAppLinkUrl('vscode://file/a.ts')).toBe(true);
    expect(isAppLinkUrl('cursor://file/a.ts')).toBe(true);
  });
});

describe('isLoopbackHttpUrl', () => {
  test('recognizes IPv4 and localhost loopback hosts', () => {
    expect(isLoopbackHttpUrl('http://localhost:5173/')).toBe(true);
    expect(isLoopbackHttpUrl('http://127.0.0.1:5173/')).toBe(true);
    expect(isLoopbackHttpUrl('https://0.0.0.0:3000')).toBe(true);
    expect(isLoopbackHttpUrl('https://example.test')).toBe(false);
  });

  test('recognizes bracketed IPv6 loopback from WHATWG URL.hostname', () => {
    // new URL('http://[::1]:5173/').hostname === '[::1]'
    expect(isLoopbackHttpUrl('http://[::1]:5173/')).toBe(true);
    expect(isLoopbackHttpUrl('https://[::1]:4123/preview')).toBe(true);
  });
});

describe('extractLoopbackUrls', () => {
  test('keeps bracketed IPv6 loopback URLs after membership filtering', () => {
    expect(extractLoopbackUrls('open http://[::1]:5173/ and http://localhost:5173/')).toEqual([
      'http://[::1]:5173/',
      'http://localhost:5173/',
    ]);
  });
});

describe('isMailtoUrl', () => {
  test('accepts plain addresses with compose headers', () => {
    expect(isMailtoUrl('mailto:user@example.test')).toBe(true);
    expect(isMailtoUrl('MAILTO:user@example.test')).toBe(true);
    expect(isMailtoUrl('mailto:user@example.test?subject=Hi&body=Line%201%0ALine%202')).toBe(true);
  });

  test('rejects attachments, unknown headers, header injection and raw arguments', () => {
    for (const url of [
      'https://example.test',
      'mailto:',
      'mailto://user@example.test',
      'mailto:user@example.test?attach=/etc/passwd',
      'mailto:user@example.test?Attachment=C:/secret.txt',
      'mailto:user@example.test?%61ttach=/etc/passwd',
      'mailto:user@example.test?x-custom=1',
      'mailto:user@example.test?subject=Hi%0d%0aBcc:evil@example.test',
      'mailto:user@example.test?body=ok%00bad',
      'mailto:user@example.test" --arg=evil',
    ]) {
      expect(isMailtoUrl(url)).toBe(false);
    }
  });
});
