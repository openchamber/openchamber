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

describe('parseRoute panel', () => {
  test('reads the guest id a browser-help deep link names', () => {
    const route = parseRoute(new URLSearchParams('session=ses_1&panel=server-chrome'));
    expect(route.guestPanelId).toBe('server-chrome');
  });

  test('ignores a missing or blank panel param', () => {
    expect(parseRoute(new URLSearchParams('session=ses_1')).guestPanelId).toBeNull();
    expect(parseRoute(new URLSearchParams('panel=')).guestPanelId).toBeNull();
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

describe('parseRoute bots', () => {
  test('reads an item target when no session is supplied', () => {
    // Given a session-independent notification URL.
    const params = new URLSearchParams('botsProject=project-1&botItem=item_2');

    // When the route is parsed.
    const route = parseRoute(params);

    // Then it names both the owning project and exact item.
    expect(route.botsTarget).toEqual({ projectId: 'project-1', itemId: 'item_2' });
    expect(route.sessionId).toBeNull();
  });

  for (const query of [
    'botItem=item-1', 'botsProject=project-1', 'botsProject=&botItem=item-1',
    'botsProject=project-1&botItem=..%2Fitem', 'botsProject=project%2F1&botItem=item-1',
    'botsProject=project-1&botItem=%22%5D',
  ]) test(`ignores an incomplete or malformed item target ${query}`, () => {
    // Given a target without two valid identifiers.
    const params = new URLSearchParams(query);

    // When the route is parsed.
    const route = parseRoute(params);

    // Then no partial destination can open a different project or item.
    expect(route.botsTarget).toBeNull();
  });
});
