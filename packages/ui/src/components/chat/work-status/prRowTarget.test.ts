import { afterEach, describe, expect, test } from 'bun:test';
import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import type { RuntimeAPIs } from '@/lib/api/types';
import { openExternalUrl } from '@/lib/url';
import { resolvePrRowTarget } from './prRowTarget';

const PR_URL = 'https://github.com/acme/app/pull/7';

describe('branch pull request row', () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  afterEach(() => {
    registerRuntimeAPIs(null);
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  });

  test('in VS Code a summary with a URL opens it through the extension host', async () => {
    expect(resolvePrRowTarget({ directory: '/repo', prUrl: PR_URL, mobile: false, vscode: true })).toBe('browser');

    const hostOpened: string[] = [];
    const browserOpened: string[] = [];
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {
      open: (url: string) => { browserOpened.push(url); },
    } });
    const unavailable = (): never => { throw new Error('not used'); };
    const apis: RuntimeAPIs = {
      runtime: { platform: 'vscode', isDesktop: false, isVSCode: true },
      get terminal() { return unavailable(); }, get git() { return unavailable(); },
      get files() { return unavailable(); }, get settings() { return unavailable(); },
      get permissions() { return unavailable(); }, get notifications() { return unavailable(); },
      get sourceControl() { return unavailable(); },
      vscode: {
        executeCommand: unavailable,
        openExternalUrl: async (url: string) => { hostOpened.push(url); },
      },
    };
    registerRuntimeAPIs(apis);

    expect(await openExternalUrl(PR_URL)).toBe(true);
    expect(hostOpened).toEqual([PR_URL]);
    expect(browserOpened).toEqual([]);
  });

  test('in VS Code a summary without a URL stays a readout', () => {
    expect(resolvePrRowTarget({ directory: '/repo', prUrl: null, mobile: false, vscode: true })).toBeNull();
  });

  test('the phone needs the URL for its board; desktop opens the Tracker tab either way', () => {
    expect(resolvePrRowTarget({ directory: '/repo', prUrl: PR_URL, mobile: true, vscode: false })).toBe('board');
    expect(resolvePrRowTarget({ directory: '/repo', prUrl: null, mobile: true, vscode: false })).toBeNull();
    expect(resolvePrRowTarget({ directory: '/repo', prUrl: null, mobile: false, vscode: false })).toBe('context-panel');
    expect(resolvePrRowTarget({ directory: null, prUrl: PR_URL, mobile: false, vscode: false })).toBeNull();
  });
});
