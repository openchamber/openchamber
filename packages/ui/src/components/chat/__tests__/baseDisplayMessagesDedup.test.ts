import { describe, expect, test } from 'bun:test';
import type { ChatMessageEntry } from '../lib/turns/types';

/**
 * Dedup logic extracted from MessageList.tsx baseDisplayMessages.
 * Tests verify that deduplication preserves chronological order
 * while keeping the latest value for each message ID.
 */
function deduplicateMessages(messages: ChatMessageEntry[]): ChatMessageEntry[] {
    const seenIds = new Set<string>();
    const latestById = new Map<string, ChatMessageEntry>();
    const dedupedMessages: ChatMessageEntry[] = [];

    for (const message of messages) {
        const messageId = message.info?.id;
        if (typeof messageId === 'string') latestById.set(messageId, message);
    }

    for (let index = 0; index < messages.length; index += 1) {
        const message = messages[index];
        const messageId = message.info?.id;
        if (typeof messageId === 'string') {
            if (seenIds.has(messageId)) {
                continue;
            }
            seenIds.add(messageId);
        }
        dedupedMessages.push(
            typeof messageId === 'string' ? latestById.get(messageId) ?? message : message,
        );
    }

    return dedupedMessages;
}

function createMessageEntry({
    id,
    role,
    parentID,
    createdAt,
}: {
    id: string;
    role: 'user' | 'assistant' | 'system';
    parentID?: string;
    createdAt: number;
}): ChatMessageEntry {
    return {
        info: {
            id,
            role,
            ...(parentID ? { parentID } : {}),
            time: { created: createdAt },
        } as ChatMessageEntry['info'],
        parts: [],
    };
}

describe('baseDisplayMessages dedup', () => {
    test('removes duplicate message IDs, keeping the latest value', () => {
        const msg1 = createMessageEntry({ id: 'msg-1', role: 'user', createdAt: 1 });
        const msg2 = createMessageEntry({ id: 'msg-2', role: 'assistant', createdAt: 2 });
        const msg1Duplicate = createMessageEntry({ id: 'msg-1', role: 'user', createdAt: 3 });

        const result = deduplicateMessages([msg1, msg2, msg1Duplicate]);

        expect(result).toHaveLength(2);
        expect(result[0]?.info.id).toBe('msg-1');
        expect(result[0]?.info.time.created).toBe(3);
        expect(result[1]?.info.id).toBe('msg-2');
    });

    test('preserves input order when there are no duplicates', () => {
        const msg1 = createMessageEntry({ id: 'msg-1', role: 'user', createdAt: 1 });
        const msg2 = createMessageEntry({ id: 'msg-2', role: 'assistant', createdAt: 2 });
        const msg3 = createMessageEntry({ id: 'msg-3', role: 'user', createdAt: 3 });

        const result = deduplicateMessages([msg1, msg2, msg3]);

        expect(result).toHaveLength(3);
        expect(result[0]?.info.id).toBe('msg-1');
        expect(result[1]?.info.id).toBe('msg-2');
        expect(result[2]?.info.id).toBe('msg-3');
    });

    test('handles empty input', () => {
        const result = deduplicateMessages([]);
        expect(result).toHaveLength(0);
    });

    test('handles messages without IDs (keeps all)', () => {
        const msg1 = { info: { role: 'user' } as ChatMessageEntry['info'], parts: [] };
        const msg2 = { info: { role: 'assistant' } as ChatMessageEntry['info'], parts: [] };

        const result = deduplicateMessages([msg1, msg2]);

        expect(result).toHaveLength(2);
    });

    test('handles empty string ID (treated as no ID, keeps all)', () => {
        const msg1 = createMessageEntry({ id: '', role: 'user', createdAt: 1 });
        const msg2 = createMessageEntry({ id: '', role: 'assistant', createdAt: 2 });

        const result = deduplicateMessages([msg1, msg2]);

        // Empty string passes typeof === 'string' check, so it IS deduplicated
        expect(result).toHaveLength(1);
    });

    test('handles single-element input', () => {
        const msg1 = createMessageEntry({ id: 'msg-1', role: 'user', createdAt: 1 });

        const result = deduplicateMessages([msg1]);

        expect(result).toHaveLength(1);
        expect(result[0]?.info.id).toBe('msg-1');
    });

    test('all messages sharing same ID keeps only the latest value', () => {
        const msg1 = createMessageEntry({ id: 'same-id', role: 'user', createdAt: 1 });
        const msg2 = createMessageEntry({ id: 'same-id', role: 'assistant', createdAt: 2 });
        const msg3 = createMessageEntry({ id: 'same-id', role: 'user', createdAt: 3 });

        const result = deduplicateMessages([msg1, msg2, msg3]);

        expect(result).toHaveLength(1);
        expect(result[0]?.info.id).toBe('same-id');
        expect(result[0]?.info.role).toBe('user');
        expect(result[0]?.info.time.created).toBe(3);
    });

    test('deduplication scenario: prepend history with overlapping IDs', () => {
        // Simulates history pagination where older messages are prepended
        // and may overlap with existing messages in the view
        const existingMsg1 = createMessageEntry({ id: 'msg-1', role: 'user', createdAt: 1 });
        const existingMsg2 = createMessageEntry({ id: 'msg-2', role: 'assistant', createdAt: 2 });

        // Prepended history (older) that overlaps with existing view
        const prependedMsg1 = createMessageEntry({ id: 'msg-1', role: 'user', createdAt: 1 });
        const prependedMsg2 = createMessageEntry({ id: 'msg-0', role: 'assistant', createdAt: 0 });

        // After prepend, array is: [prepended older msgs, existing msgs]
        const messages = [prependedMsg2, prependedMsg1, existingMsg1, existingMsg2];

        const result = deduplicateMessages(messages);

        // Keep the prepended ordering position while retaining the existing value.
        expect(result).toHaveLength(3);
        expect(result[0]?.info.id).toBe('msg-0'); // prepended (oldest)
        expect(result[1]).toBe(existingMsg1);
        expect(result[2]?.info.id).toBe('msg-2'); // existing
    });

    test('handles multiple duplicates of the same ID', () => {
        const msg1 = createMessageEntry({ id: 'msg-1', role: 'user', createdAt: 1 });
        const msg1Dup1 = createMessageEntry({ id: 'msg-1', role: 'user', createdAt: 2 });
        const msg1Dup2 = createMessageEntry({ id: 'msg-1', role: 'user', createdAt: 3 });

        const result = deduplicateMessages([msg1, msg1Dup1, msg1Dup2]);

        expect(result).toHaveLength(1);
        expect(result[0]?.info.id).toBe('msg-1');
        expect(result[0]?.info.time.created).toBe(3);
    });

    test('preserves first position while using a later duplicate value', () => {
        const msg1First = createMessageEntry({ id: 'msg-1', role: 'user', createdAt: 1 });
        const msg1Later = createMessageEntry({ id: 'msg-1', role: 'assistant', createdAt: 5 });

        const result = deduplicateMessages([msg1First, msg1Later]);

        expect(result).toHaveLength(1);
        expect(result[0]?.info.role).toBe('assistant');
    });
});
