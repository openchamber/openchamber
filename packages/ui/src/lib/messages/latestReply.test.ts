import { describe, expect, test } from 'bun:test';
import type { AssistantMessage } from '@/lib/opencode/model';

import { findLatestCompletedReply, type LatestReplyRecord } from './latestReply';

const userMessage = (id: string): LatestReplyRecord => ({
    info: {
        id,
        role: 'user',
        sessionID: 'ses_1',
        time: { created: 1 },
    },
    parts: [],
});

const assistantMessage = (
    id: string,
    text: string,
    options: { finish?: AssistantMessage['finish']; completed?: number } = {},
): LatestReplyRecord => {
    const info: AssistantMessage = {
        id,
        role: 'assistant',
        sessionID: 'ses_1',
        time: { created: 2 },
        agent: 'build',
        providerID: 'anthropic',
        modelID: 'claude-opus-4-1',
    };
    if (options.completed !== undefined) info.time.completed = options.completed;
    if (options.finish !== undefined) info.finish = options.finish;

    return {
        info,
        parts: text
            ? [{ id: `${id}-part`, sessionID: 'ses_1', messageID: id, type: 'text', text }]
            : [],
    };
};

describe('findLatestCompletedReply', () => {
    test('returns the last answer of the latest prompt', () => {
        const reply = findLatestCompletedReply([
            userMessage('user_1'),
            assistantMessage('assistant_1', 'First answer', { finish: 'stop', completed: 10 }),
            userMessage('user_2'),
            assistantMessage('assistant_2', 'Progress note', { finish: 'tool-calls', completed: 20 }),
            assistantMessage('assistant_3', 'Second answer', { finish: 'stop', completed: 30 }),
        ]);

        expect(reply).toEqual({ messageId: 'assistant_3', text: 'Second answer' });
    });

    test('ignores a step that ended in tool calls', () => {
        const reply = findLatestCompletedReply([
            userMessage('user_1'),
            assistantMessage('assistant_1', 'Only a tool step', { finish: 'tool-calls', completed: 10 }),
        ]);

        expect(reply).toBeNull();
    });

    test('ignores messages that have not completed', () => {
        const reply = findLatestCompletedReply([
            userMessage('user_1'),
            assistantMessage('assistant_1', 'Still streaming', { finish: 'stop' }),
        ]);

        expect(reply).toBeNull();
    });

    test('ignores an aborted turn with no completed answer', () => {
        const reply = findLatestCompletedReply([
            userMessage('user_1'),
            assistantMessage('assistant_1', 'Partial text', { finish: 'error', completed: 10 }),
        ]);

        expect(reply).toBeNull();
    });

    test('does not read an earlier turn when the latest one has no answer', () => {
        const reply = findLatestCompletedReply([
            userMessage('user_1'),
            assistantMessage('assistant_1', 'Old answer', { finish: 'stop', completed: 10 }),
            userMessage('user_2'),
            assistantMessage('assistant_2', 'Only a tool step', { finish: 'tool-calls', completed: 20 }),
        ]);

        expect(reply).toBeNull();
    });

    test('skips an empty final message and reads the answered step before it', () => {
        const reply = findLatestCompletedReply([
            userMessage('user_1'),
            assistantMessage('assistant_1', 'The answer', { finish: 'stop', completed: 10 }),
            assistantMessage('assistant_2', '', { finish: 'stop', completed: 20 }),
        ]);

        expect(reply).toEqual({ messageId: 'assistant_1', text: 'The answer' });
    });
});
