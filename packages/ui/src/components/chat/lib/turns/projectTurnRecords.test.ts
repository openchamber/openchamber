import { describe, expect, test } from 'bun:test';
import type { Message, Part } from '@opencode-ai/sdk/v2';
import { projectTurnRecords } from './projectTurnRecords';
import type { ChatMessageEntry } from './types';

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
        } as Message,
        parts: [] as Part[],
    };
}

describe('projectTurnRecords', () => {
    test('groups assistant replies under their parent user turn', () => {
        const user = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
        const assistant = createMessageEntry({ id: 'a1', role: 'assistant', parentID: 'u1', createdAt: 2 });

        const projection = projectTurnRecords([user, assistant]);

        expect(projection.turns).toHaveLength(1);
        expect(projection.turns[0]?.turnId).toBe('u1');
        expect(projection.turns[0]?.assistantMessageIds).toEqual(['a1']);
        expect(projection.ungroupedMessageIds.size).toBe(0);
    });

    test('keeps out-of-order assistant replies attached to their parent user turn', () => {
        const user1 = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
        const assistant1 = createMessageEntry({ id: 'a1', role: 'assistant', parentID: 'u1', createdAt: 2 });
        const assistant2 = createMessageEntry({ id: 'a2', role: 'assistant', parentID: 'u2', createdAt: 4 });
        const user2 = createMessageEntry({ id: 'u2', role: 'user', createdAt: 3 });

        const projection = projectTurnRecords([user1, assistant1, assistant2, user2]);

        expect(projection.turns).toHaveLength(2);
        expect(projection.turns[0]?.turnId).toBe('u1');
        expect(projection.turns[0]?.assistantMessageIds).toEqual(['a1']);
        expect(projection.turns[1]?.turnId).toBe('u2');
        expect(projection.turns[1]?.assistantMessageIds).toEqual(['a2']);
        expect(projection.ungroupedMessageIds.size).toBe(0);
    });

    test('does not render assistant replies while their parent user turn is missing', () => {
        const user1 = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
        const assistant1 = createMessageEntry({ id: 'a1', role: 'assistant', parentID: 'u1', createdAt: 2 });
        const assistant2 = createMessageEntry({ id: 'a2', role: 'assistant', parentID: 'u2', createdAt: 4 });

        const projection = projectTurnRecords([user1, assistant1, assistant2]);

        expect(projection.turns).toHaveLength(1);
        expect(projection.turns[0]?.turnId).toBe('u1');
        expect(projection.turns[0]?.assistantMessageIds).toEqual(['a1']);
        expect(projection.ungroupedMessageIds.has('a2')).toBe(false);
        expect(projection.indexes.messageToTurnId.has('a2')).toBe(false);
    });

    test('does not render orphan assistant messages as standalone ungrouped entries', () => {
        const assistant = createMessageEntry({ id: 'a1', role: 'assistant', parentID: 'missing-user', createdAt: 1 });

        const projection = projectTurnRecords([assistant]);

        expect(projection.turns).toHaveLength(0);
        expect(projection.ungroupedMessageIds.has('a1')).toBe(false);
        expect(projection.indexes.messageToTurnId.has('a1')).toBe(false);
    });

    test('keeps non-assistant orphan messages available as ungrouped entries', () => {
        const system = createMessageEntry({ id: 's1', role: 'system', createdAt: 1 });

        const projection = projectTurnRecords([system]);

        expect(projection.turns).toHaveLength(0);
        expect(projection.ungroupedMessageIds.has('s1')).toBe(true);
    });

    test('reuses unchanged turn records from the previous projection', () => {
        const user1 = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
        const assistant1 = createMessageEntry({ id: 'a1', role: 'assistant', parentID: 'u1', createdAt: 2 });
        const user2 = createMessageEntry({ id: 'u2', role: 'user', createdAt: 3 });
        const assistant2 = createMessageEntry({ id: 'a2', role: 'assistant', parentID: 'u2', createdAt: 4 });
        const initial = projectTurnRecords([user1, assistant1, user2, assistant2]);
        const updatedAssistant2 = {
            ...assistant2,
            parts: [{ type: 'text', text: 'stream update' } as Part],
        };

        const next = projectTurnRecords([user1, assistant1, user2, updatedAssistant2], {
            previousProjection: initial,
        });

        expect(next.turns[0]).toBe(initial.turns[0]);
        expect(next.turns[1]).not.toBe(initial.turns[1]);
    });

    test('hydrates updated turns when a previous projection exists but no turn is reusable', () => {
        const user = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
        const assistant = createMessageEntry({ id: 'a1', role: 'assistant', parentID: 'u1', createdAt: 2 });
        const initial = projectTurnRecords([user, assistant]);
        const updatedAssistant = {
            ...assistant,
            parts: [{ id: 'tool_1', type: 'tool', tool: 'bash', state: { status: 'completed' } } as Part],
        };

        const next = projectTurnRecords([user, updatedAssistant], {
            previousProjection: initial,
        });

        expect(next.turns).toHaveLength(1);
        expect(next.turns[0]).not.toBe(initial.turns[0]);
        expect(next.turns[0]?.hasTools).toBe(true);
        expect(next.turns[0]?.activityParts).toHaveLength(1);
        expect(next.turns[0]?.stream.isStreaming).toBe(true);
        expect(next.turns[0]?.stream.isRetrying).toBe(false);
    });

    test('reuses the whole turns array when every turn is unchanged', () => {
        const user = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
        const assistant = createMessageEntry({ id: 'a1', role: 'assistant', parentID: 'u1', createdAt: 2 });
        const initial = projectTurnRecords([user, assistant]);

        const next = projectTurnRecords([user, assistant], {
            previousProjection: initial,
        });

        expect(next.turns).toBe(initial.turns);
        expect(next.turns[0]).toBe(initial.turns[0]);
    });

    test('merges turns started by hidden user messages when merging is enabled', () => {
        const user1 = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
        user1.parts = [{ id: 'p1', type: 'text', text: 'visible prompt' } as Part];
        const assistant1 = createMessageEntry({ id: 'a1', role: 'assistant', parentID: 'u1', createdAt: 2 });
        const hiddenUser = createMessageEntry({ id: 'u2', role: 'user', createdAt: 3 });
        const assistant2 = createMessageEntry({ id: 'a2', role: 'assistant', parentID: 'u2', createdAt: 4 });

        const projection = projectTurnRecords([user1, assistant1, hiddenUser, assistant2], {
            mergeHiddenUserTurns: { planModeEnabled: false },
        });

        expect(projection.turns).toHaveLength(1);
        expect(projection.turns[0]?.turnId).toBe('u1');
        expect(projection.turns[0]?.assistantMessageIds).toEqual(['a1', 'a2']);
        expect(projection.ungroupedMessageIds.has('u2')).toBe(false);
    });

    test('keeps hidden user messages as separate turns when merging is disabled', () => {
        const user1 = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
        const assistant1 = createMessageEntry({ id: 'a1', role: 'assistant', parentID: 'u1', createdAt: 2 });
        const hiddenUser = createMessageEntry({ id: 'u2', role: 'user', createdAt: 3 });
        const assistant2 = createMessageEntry({ id: 'a2', role: 'assistant', parentID: 'u2', createdAt: 4 });

        const projection = projectTurnRecords([user1, assistant1, hiddenUser, assistant2]);

        expect(projection.turns).toHaveLength(2);
        expect(projection.turns[1]?.turnId).toBe('u2');
    });

    test('does not merge a hidden user message when there is no previous turn', () => {
        const hiddenUser = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
        const assistant = createMessageEntry({ id: 'a1', role: 'assistant', parentID: 'u1', createdAt: 2 });

        const projection = projectTurnRecords([hiddenUser, assistant], {
            mergeHiddenUserTurns: { planModeEnabled: false },
        });

        expect(projection.turns).toHaveLength(1);
        expect(projection.turns[0]?.turnId).toBe('u1');
        expect(projection.turns[0]?.assistantMessageIds).toEqual(['a1']);
    });

    test('chains merges across consecutive hidden user messages', () => {
        const user1 = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
        user1.parts = [{ id: 'p1', type: 'text', text: 'visible prompt' } as Part];
        const assistant1 = createMessageEntry({ id: 'a1', role: 'assistant', parentID: 'u1', createdAt: 2 });
        const hidden1 = createMessageEntry({ id: 'u2', role: 'user', createdAt: 3 });
        const assistant2 = createMessageEntry({ id: 'a2', role: 'assistant', parentID: 'u2', createdAt: 4 });
        const hidden2 = createMessageEntry({ id: 'u3', role: 'user', createdAt: 5 });
        const assistant3 = createMessageEntry({ id: 'a3', role: 'assistant', parentID: 'u3', createdAt: 6 });

        const projection = projectTurnRecords([user1, assistant1, hidden1, assistant2, hidden2, assistant3], {
            mergeHiddenUserTurns: { planModeEnabled: false },
        });

        expect(projection.turns).toHaveLength(1);
        expect(projection.turns[0]?.assistantMessageIds).toEqual(['a1', 'a2', 'a3']);
    });

    test('treats compaction summary text as justification activity in sorted mode', () => {
        const user = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
        user.parts = [{ id: 'p1', type: 'text', text: 'prompt' } as Part];
        const compaction = createMessageEntry({ id: 'a1', role: 'assistant', parentID: 'u1', createdAt: 2 });
        (compaction.info as { summary?: boolean; finish?: string }).summary = true;
        (compaction.info as { summary?: boolean; finish?: string }).finish = 'stop';
        compaction.parts = [{ id: 'cp1', type: 'text', text: 'compacted context summary' } as Part];
        const assistant = createMessageEntry({ id: 'a2', role: 'assistant', parentID: 'u1', createdAt: 3 });
        (assistant.info as { finish?: string }).finish = 'stop';
        assistant.parts = [{ id: 'ap1', type: 'text', text: 'final answer' } as Part];

        const projection = projectTurnRecords([user, compaction, assistant], {
            showTextJustificationActivity: true,
        });

        const turn = projection.turns[0];
        expect(turn?.summaryText).toBe('final answer');
        const compactionActivity = turn?.activityParts.find((activity) => activity.messageId === 'a1');
        expect(compactionActivity?.kind).toBe('justification');
        const finalActivity = turn?.activityParts.find((activity) => activity.messageId === 'a2');
        expect(finalActivity).toBe(undefined);
    });
});
