import { describe, expect, test } from 'bun:test';

import { markGuestListening, useGuestListeningStore } from './microphone';

describe('markGuestListening', () => {
  test('a guest listens while any of its captures is open, and a release counts once', () => {
    const panel = markGuestListening('voice');
    const page = markGuestListening('voice');
    expect(useGuestListeningStore.getState().captureCountByGuest).toEqual({ voice: 2 });
    panel();
    panel();
    expect(useGuestListeningStore.getState().captureCountByGuest).toEqual({ voice: 1 });
    page();
    expect(useGuestListeningStore.getState().captureCountByGuest).toEqual({});
  });
});
