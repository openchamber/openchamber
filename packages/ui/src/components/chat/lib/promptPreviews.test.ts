import { describe, expect, test } from 'bun:test';
import type { FilePart, Message, Part, SyntheticMessage, TextPart, UserMessage } from '@/lib/opencode/model';
import { CONTEXT_METADATA_KEY } from '@/lib/messages/contextParts';

import { getFullText, getMessagePreview, getPromptPreviewText } from './messagePreview';
import { buildPromptPreviewsByTurnId, foldPromptEntries } from './promptPreviews';
import type { ChatMessageEntry } from './turns/types';

const SESSION = 'ses_1';

const t = (key: string): string =>
    key === 'chat.message.context.chatQuote' ? 'Quoted from an earlier message' : key;

const entry = (info: Message, parts: Part[] = []): ChatMessageEntry => ({ info, parts });

const textPart = (messageID: string, text: string): TextPart => ({
    id: `${messageID}-p`,
    sessionID: SESSION,
    messageID,
    type: 'text',
    text,
});

const userMessage = (id: string, text: string): ChatMessageEntry => {
    const info: UserMessage = { id, sessionID: SESSION, role: 'user', time: { created: 1 } };
    return entry(info, [textPart(id, text)]);
};

const chatQuoteMessage = (id: string, quote: string, comment = ''): ChatMessageEntry => {
    const info: SyntheticMessage = {
        id,
        sessionID: SESSION,
        role: 'synthetic',
        time: { created: 1 },
        text: `Comment on a fragment of an earlier message:\n> ${quote}`,
        metadata: { [CONTEXT_METADATA_KEY]: { kind: 'chat-quote', quote, text: comment } },
    };
    return entry(info);
};

const pluginMessage = (id: string): ChatMessageEntry => {
    const info: SyntheticMessage = {
        id,
        sessionID: SESSION,
        role: 'synthetic',
        time: { created: 1 },
        text: 'Continue from where you left off.',
    };
    return entry(info);
};

describe('promptPreviews', () => {
    test('labels a quote-only prompt from its folded context', () => {
        const previews = buildPromptPreviewsByTurnId([
            chatQuoteMessage('msg_0', 'the anchored scroll bit'),
            userMessage('msg_1', ''),
        ]);

        expect(previews.has('msg_1')).toBe(true);
        expect(getMessagePreview(previews.get('msg_1')!, 160, t))
            .toBe('Quoted from an earlier message: the anchored scroll bit');
    });

    test('prefers the typed text when a prompt has both text and a quote', () => {
        const previews = buildPromptPreviewsByTurnId([
            chatQuoteMessage('msg_0', 'quoted bit'),
            userMessage('msg_1', 'please explain'),
        ]);

        expect(getMessagePreview(previews.get('msg_1')!, 160, t)).toBe('please explain');
    });

    test('joins several quotes in send order', () => {
        const previews = buildPromptPreviewsByTurnId([
            chatQuoteMessage('msg_0', 'first quote'),
            chatQuoteMessage('msg_1', 'second quote'),
            userMessage('msg_2', ''),
        ]);

        expect(getPromptPreviewText(previews.get('msg_2')!, t))
            .toBe('Quoted from an earlier message: first quote · Quoted from an earlier message: second quote');
    });

    test('leaves a machine-only injection out of the previews', () => {
        const previews = buildPromptPreviewsByTurnId([
            pluginMessage('msg_0'),
            userMessage('msg_1', ''),
        ]);

        expect(previews.size).toBe(0);
    });

    test('keeps a prompt that is only an attachment', () => {
        const attachment: FilePart = {
            id: 'msg_1-f',
            sessionID: SESSION,
            messageID: 'msg_1',
            type: 'file',
            mime: 'text/plain',
            filename: 'notes.txt',
            url: 'file:///notes.txt',
        };
        const info: UserMessage = { id: 'msg_1', sessionID: SESSION, role: 'user', time: { created: 1 } };

        expect(buildPromptPreviewsByTurnId([entry(info, [attachment])]).has('msg_1')).toBe(true);
    });

    test('folds the quote onto the entry the timeline reads', () => {
        const entries = foldPromptEntries([
            chatQuoteMessage('msg_0', 'the anchored scroll bit'),
            userMessage('msg_1', ''),
        ]);

        expect(entries.map((message) => message.info.id)).toEqual(['msg_1']);
        expect(getFullText(entries[0]!.parts)).toContain('the anchored scroll bit');
    });
});
