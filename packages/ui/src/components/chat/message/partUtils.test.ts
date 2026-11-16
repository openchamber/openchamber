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

const quote = (id: string) => textPart(id, {
    [CONTEXT_METADATA_KEY]: { kind: 'chat-quote', quote: id, text: '' },
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

    test('two lines of text leave no context rows and never hide the text', () => {
        expect(hiddenIds([...quotes, textPart('prompt')], 2)).toEqual(['a', 'b', 'c']);
    });

    test('a session mention draws no row, so it takes no line', () => {
        expect(hiddenIds([sessionMention('m1'), sessionMention('m2'), quote('a'), quote('b')], 0)).toEqual([]);
    });
});
