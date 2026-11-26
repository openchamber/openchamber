import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { useAppLinkTrustStore } from '@/stores/appLinkTrustStore';

import {
  getAppLinkConfirmationSnapshot,
  openAppLinkWithConfirmation,
  settleAppLinkConfirmation,
} from './appLinkConfirmation';

describe('app link confirmation', () => {
  beforeEach(() => {
    useAppLinkTrustStore.setState({ trustedSchemes: [] });
    const pending = getAppLinkConfirmationSnapshot();
    if (pending) {
      settleAppLinkConfirmation('cancel');
    }
  });

  test('opens trusted schemes without asking', async () => {
    useAppLinkTrustStore.getState().trustScheme('obsidian');

    await openAppLinkWithConfirmation('obsidian://open?vault=Notebook&file=notes');

    expect(getAppLinkConfirmationSnapshot()).toBeNull();
    expect(useAppLinkTrustStore.getState().isSchemeTrusted('obsidian')).toBe(true);
  });

  test('asks once and trusts the scheme when the user chooses trust', async () => {
    const pending = openAppLinkWithConfirmation('linear://issue/ABC-1');

    expect(getAppLinkConfirmationSnapshot()?.url).toBe('linear://issue/ABC-1');

    settleAppLinkConfirmation('trust');
    await pending;

    expect(getAppLinkConfirmationSnapshot()).toBeNull();
    expect(useAppLinkTrustStore.getState().isSchemeTrusted('linear')).toBe(true);
  });

  test('cancel opens nothing and keeps the scheme untrusted', async () => {
    const pending = openAppLinkWithConfirmation('notion://note/xyz');

    settleAppLinkConfirmation('cancel');
    await pending;

    expect(getAppLinkConfirmationSnapshot()).toBeNull();
    expect(useAppLinkTrustStore.getState().isSchemeTrusted('notion')).toBe(false);
  });

  test('a newer request cancels the pending one', async () => {
    const first = openAppLinkWithConfirmation('obsidian://open?vault=a');
    const firstChoice = first.then(
      () => 'settled',
      () => 'settled',
    );
    const second = openAppLinkWithConfirmation('linear://open/1');

    expect(await firstChoice).toBe('settled');
    expect(getAppLinkConfirmationSnapshot()?.url).toBe('linear://open/1');

    settleAppLinkConfirmation('open');
    await second;

    expect(getAppLinkConfirmationSnapshot()).toBeNull();
  });
});

describe('app link confirmation inside VS Code', () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  afterEach(() => {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  });

  test('hands the link to the extension host, which asks in its own modal, without a second dialog', async () => {
    useAppLinkTrustStore.setState({ trustedSchemes: [] });
    const opened: string[] = [];
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {
      __VSCODE_CONFIG__: { uriScheme: 'vscode' },
      __OPENCHAMBER_RUNTIME_APIS__: {
        runtime: { isVSCode: true },
        vscode: { openExternalUrl: async (url: string) => { opened.push(url); } },
      },
    } });

    await openAppLinkWithConfirmation('zed://file/a.ts');

    expect(getAppLinkConfirmationSnapshot()).toBeNull();
    expect(opened).toEqual(['zed://file/a.ts']);
    expect(useAppLinkTrustStore.getState().isSchemeTrusted('zed')).toBe(false);
  });
});
