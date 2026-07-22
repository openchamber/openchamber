import { describe, expect, test } from 'bun:test';

import {
  getDisposableSideChatParentID,
  isDisposableSideChat,
} from './sideChatMetadata';

describe('side chat metadata', () => {
  test('reads a disposable side-chat marker', () => {
    const metadata = { openchamber: { sideChat: { disposable: true, parentSessionID: 'ses_parent' } } };
    expect(isDisposableSideChat({ metadata } as never)).toBe(true);
    expect(getDisposableSideChatParentID({ metadata } as never)).toBe('ses_parent');
  });

  test('rejects malformed disposable identity', () => {
    const session = {
      metadata: {
        openchamber: {
          sideChat: { disposable: true, parentSessionID: ' ' },
        },
      },
    };

    expect(isDisposableSideChat(session as never)).toBe(false);
    expect(getDisposableSideChatParentID(session as never)).toBeNull();
  });
});
