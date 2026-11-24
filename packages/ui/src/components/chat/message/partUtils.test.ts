import { describe, expect, test } from 'bun:test';

import { CONTEXT_METADATA_KEY } from '@/lib/messages/contextParts';
import type { Metadata, Part } from '@/lib/opencode/model';
import { contextPartsPastCollapse } from './partUtils';

const textPart = (id: string, metadata?: Metadata): Part => ({
    id,
    sessionID: 'session',
    messageID: 'message',
    type: 'text',
    text: id,
    metadata,
});

const quote = (id: string, comment = '') => textPart(id, {
    [CONTEXT_METADATA_KEY]: { kind: 'chat-quote', quote: id, text: comment },
});

const sessionMention = (id: string) => textPart(id, {
    [CONTEXT_METADATA_KEY]: { kind: 'session', sessionId: 'ses_other', title: 'Other' },
});

const hiddenIds = (parts: Part[], textLines: number) => [...contextPartsPastCollapse(parts, textLines)].map((part) => part.id);

describe('contextPartsPastCollapse', () => {
    const quotes = [quote('a'), quote('b'), quote('c')];

    test('without text, two context rows stay', () => {
        expect(hiddenIds(quotes, 0)).toEqual(['c']);
    });

    test('one line of text leaves room for one context row', () => {
        expect(hiddenIds([...quotes, textPart('prompt')], 1)).toEqual(['b', 'c']);
    });

    test('two lines of text keep one context row, so an attached quote is never invisible', () => {
        // The reported case: one quote, a prompt that fills both lines.
        expect(hiddenIds([quote('a'), textPart('prompt')], 2)).toEqual([]);
        expect(hiddenIds([...quotes, textPart('prompt')], 2)).toEqual(['b', 'c']);
    });

    test('a quote with a comment takes two lines', () => {
        expect(hiddenIds([quote('a', 'why?'), quote('b', 'and this?')], 0)).toEqual(['b']);
    });

    test('a quote with a comment is kept even though it needs two lines, and what follows waits', () => {
        // Keeping only one-line rows hid exactly the case the reader reported:
        // a quote with a comment beside a prompt that already fills a line.
        expect(hiddenIds([quote('a', 'why?'), quote('b'), textPart('prompt')], 1)).toEqual(['b']);
    });

    test('a quoted comment stays visible beside a prompt of any length', () => {
        expect(hiddenIds([quote('q', 'sent'), textPart('prompt')], 1)).toEqual([]);
        expect(hiddenIds([quote('q', 'sent'), textPart('prompt')], 2)).toEqual([]);
    });

    test('a shared page card is not kept, because it does not collapse to a line', () => {
        const page = textPart('page', {
            [CONTEXT_METADATA_KEY]: { kind: 'shared-page', receivedId: null, host: 'example.test', title: 'Page', opened: false },
        });
        expect(hiddenIds([page, textPart('prompt')], 2)).toEqual(['page']);
        // A quote after it is the row that keeps the line instead.
        expect(hiddenIds([page, quote('a'), textPart('prompt')], 2)).toEqual(['page']);
    });

    test('a session mention draws no row, so it takes no line', () => {
        expect(hiddenIds([sessionMention('m1'), sessionMention('m2'), quote('a'), quote('b')], 0)).toEqual([]);
    });
});
