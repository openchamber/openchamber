import { describe, expect, test } from 'bun:test';

import { buildMessageLink, isSessionDeepLink, parseSessionLink } from './sessionLinks';

describe('buildMessageLink', () => {
    test('builds the native deep link', () => {
        expect(buildMessageLink('ses_a', 'msg_1', { kind: 'deep-link' })).toBe('openchamber://session/ses_a?message=msg_1');
    });

    test('builds the web link on this page, keeping its path', () => {
        expect(buildMessageLink('ses_a', 'msg_1', { kind: 'web', origin: 'https://chamber.example', pathname: '/oc/' }))
            .toBe('https://chamber.example/oc/?session=ses_a&message=msg_1');
    });

    test('refuses identifiers outside the link alphabet', () => {
        expect(buildMessageLink('ses a', 'msg_1', { kind: 'deep-link' })).toBeNull();
        expect(buildMessageLink('ses_a', 'msg"]', { kind: 'deep-link' })).toBeNull();
    });
});

describe('parseSessionLink', () => {
    test('reads native session and message links', () => {
        expect(parseSessionLink('openchamber://session/ses_a?message=msg_1', [])).toEqual({ sessionId: 'ses_a', messageId: 'msg_1' });
        expect(parseSessionLink('openchamber://session/ses_a', [])).toEqual({ sessionId: 'ses_a', messageId: null });
    });

    test('reads web links only on an address of this instance', () => {
        const href = 'https://chamber.example/?session=ses_a&message=msg_1';
        expect(parseSessionLink(href, ['https://chamber.example'])).toEqual({ sessionId: 'ses_a', messageId: 'msg_1' });
        // The desktop page lives on its own scheme; the connected instance's address counts too.
        expect(parseSessionLink(href, ['openchamber-ui://app', 'https://chamber.example'])).toEqual({ sessionId: 'ses_a', messageId: 'msg_1' });
        expect(parseSessionLink(href, ['https://other.example'])).toBeNull();
        expect(parseSessionLink(href, [])).toBeNull();
    });

    test('ignores other routes and malformed IDs', () => {
        expect(parseSessionLink('openchamber://connect?v=2&p=x', [])).toBeNull();
        expect(parseSessionLink('openchamber://session/ses_a/extra', [])).toBeNull();
        expect(parseSessionLink('openchamber://session/ses_a?message=bad%22', [])).toBeNull();
        expect(parseSessionLink('not a url', [])).toBeNull();
    });

    test('recognises only session deep links as keepable chat links', () => {
        expect(isSessionDeepLink('openchamber://session/ses_a?message=msg_1')).toBe(true);
        expect(isSessionDeepLink('openchamber://connect?v=2')).toBe(false);
        expect(isSessionDeepLink('https://chamber.example/?session=ses_a')).toBe(false);
    });
});
