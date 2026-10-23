import { describe, expect, test } from 'bun:test';
import { parseDeepLink } from './deepLinks';

describe('Bots mobile deep links', () => {
  for (const url of [
    'openchamber://bots?botsProject=project-1&botItem=item-7',
    'https://server.example/?botsProject=project-1&botItem=item-7',
    'http://localhost/?botsProject=project-1&botItem=item-7',
    '/?botsProject=project-1&botItem=item-7',
  ]) test(`parses a session-independent item from ${url}`, () => {
    // Given a native scheme or push payload using the shared query contract.
    // When the native entry point parses it.
    const intent = parseDeepLink(url);

    // Then the owning project and exact item survive without a session.
    expect(intent).toEqual({ type: 'bots', projectId: 'project-1', itemId: 'item-7' });
  });

  for (const url of [
    'openchamber://bots?botItem=item-7',
    'https://server.example/?botsProject=project-1',
    '/?botsProject=project-1&botItem=..%2Fitem',
    'javascript:alert(1)?botsProject=project-1&botItem=item-7',
  ]) test(`rejects an incomplete or unsafe link ${url}`, () => {
    // Given a link outside the complete, supported route contract.
    // When it is parsed.
    const intent = parseDeepLink(url);

    // Then it cannot select a bot item.
    expect(intent).toBeNull();
  });

  test('preserves native session message links when no Bots target is supplied', () => {
    // Given an existing message deep link.
    // When it is parsed with the extended vocabulary.
    const intent = parseDeepLink('openchamber://session/ses_1?message=msg_2');

    // Then it retains its session/message navigation behavior.
    expect(intent).toMatchObject({ type: 'session', sessionId: 'ses_1', messageId: 'msg_2' });
  });
});
