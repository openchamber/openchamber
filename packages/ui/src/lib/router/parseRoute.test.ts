import { describe, expect, test } from 'bun:test';

import { parseRoute } from './parseRoute';

describe('parseRoute session', () => {
  test('reads a session id including OpenCode underscores', () => {
    const route = parseRoute(new URLSearchParams('session=ses_abc123'));
    expect(route.sessionId).toBe('ses_abc123');
  });

  test('decodes a percent-encoded session id', () => {
    const route = parseRoute(new URLSearchParams('session=ses%5Fabc123'));
    expect(route.sessionId).toBe('ses_abc123');
  });

  test('ignores a blank session param', () => {
    const route = parseRoute(new URLSearchParams('session='));
    expect(route.sessionId).toBeNull();
  });
});

describe('parseRoute message', () => {
  test('reads a linked message next to its session', () => {
    const route = parseRoute(new URLSearchParams('session=ses_abc&message=msg_123'));
    expect(route.messageId).toBe('msg_123');
  });

  test('ignores a message without a session', () => {
    expect(parseRoute(new URLSearchParams('message=msg_123')).messageId).toBeNull();
  });

  test('rejects a message id outside the identifier alphabet', () => {
    expect(parseRoute(new URLSearchParams('session=ses_abc&message=msg"]')).messageId).toBeNull();
  });
});

describe('parseRoute tracker item', () => {
  test('reads the pull request and its project folder a notification click carries', () => {
    const route = parseRoute(new URLSearchParams('item=https%3A%2F%2Fgithub.com%2Facme%2Fapp%2Fpull%2F7&itemDir=%2Fwork%2Fapp'));
    expect(route.trackerItem).toEqual({ url: 'https://github.com/acme/app/pull/7', directory: '/work/app', newTab: false });
    expect(route.sessionId).toBeNull();
  });

  test('reads an item without a folder and ignores a folder without an item', () => {
    expect(parseRoute(new URLSearchParams('item=https%3A%2F%2Fgithub.com%2Facme%2Fapp%2Fpull%2F7')).trackerItem)
      .toEqual({ url: 'https://github.com/acme/app/pull/7', directory: null, newTab: false });
    expect(parseRoute(new URLSearchParams('item=https%3A%2F%2Fgithub.com%2Facme%2Fapp%2Fpull%2F7&itemTab=1')).trackerItem?.newTab).toBe(true);
    expect(parseRoute(new URLSearchParams('itemDir=%2Fwork%2Fapp')).trackerItem).toBeNull();
  });
});
