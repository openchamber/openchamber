import { describe, expect, test } from 'bun:test';
import { EMPTY_GUEST_CONNECTION } from '@openchamber/sdk';

import { trackerGuestConnection } from './tracker-connection';

describe('trackerGuestConnection', () => {
  test('is the empty connection until the status answers, and after a disconnect', () => {
    expect(trackerGuestConnection(null)).toEqual(EMPTY_GUEST_CONNECTION);
    expect(trackerGuestConnection({ connected: false, accounts: [{ id: 'u-1', name: 'Mona', current: true, status: 'invalid' }] })).toEqual(EMPTY_GUEST_CONNECTION);
  });

  test('names the current account', () => {
    expect(trackerGuestConnection({ connected: true, account: { id: 'u-1', name: 'Mona', current: true } })).toEqual({ connected: true, account: 'Mona' });
    expect(trackerGuestConnection({ connected: true, account: { id: 'u-1', name: null, current: true } })).toEqual({ connected: true, account: 'u-1' });
    expect(trackerGuestConnection({ connected: true })).toEqual({ connected: true, account: '' });
  });
});
