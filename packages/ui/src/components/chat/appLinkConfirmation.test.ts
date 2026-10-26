import { beforeEach, describe, expect, test } from 'bun:test';

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
