import { describe, expect, test } from 'bun:test';
import type { Message, Part } from '@opencode-ai/sdk/v2/client';
import type { State } from '@/sync/types';

import { EMPTY_REVERTED_MESSAGE_DOCK_STATE, buildRevertedMessageDockState } from './revertedMessageDockState';
import { addPostRevertBranchReplacement } from '@/sync/message-visibility';

const message = (id: string, role: 'user' | 'assistant'): Message => ({
    id,
    role,
    sessionID: 'ses_1',
    time: { created: 1 },
} as Message);

const textPart = (id: string, text: string): Part => ({
    id,
    type: 'text',
    text,
} as Part);

const state = (partial: Partial<State>): Pick<State, 'session' | 'message' | 'part' | 'postRevertBranch'> => ({
    session: [],
    message: {},
    part: {},
    postRevertBranch: {},
    ...partial,
});

describe('buildRevertedMessageDockState', () => {
    test('returns a shared empty state when the session is not reverted', () => {
        const first = buildRevertedMessageDockState(state({}), 'ses_1');
        const second = buildRevertedMessageDockState(
            state({ part: { assistant_1: [textPart('part_1', 'streaming')] } }),
            'ses_1',
            first,
        );

        expect(first).toBe(EMPTY_REVERTED_MESSAGE_DOCK_STATE);
        expect(second).toBe(EMPTY_REVERTED_MESSAGE_DOCK_STATE);
    });

    test('reuses the previous state when unrelated assistant parts change', () => {
        const user = message('user_1', 'user');
        const userParts = [textPart('part_user', 'hello')];
        const first = buildRevertedMessageDockState(
            state({
                session: [{ id: 'ses_1', revert: { messageID: 'user_1' } } as State['session'][number]],
                message: { ses_1: [user, message('assistant_1', 'assistant')] },
                part: { user_1: userParts, assistant_1: [textPart('part_a', 'a')] },
            }),
            'ses_1',
        );

        const second = buildRevertedMessageDockState(
            state({
                session: [{ id: 'ses_1', revert: { messageID: 'user_1' } } as State['session'][number]],
                message: { ses_1: [user, message('assistant_1', 'assistant')] },
                part: { user_1: userParts, assistant_1: [textPart('part_a2', 'updated')] },
            }),
            'ses_1',
            first,
        );

        expect(second).toBe(first);
    });

    test('updates when a reverted user message part changes', () => {
        const user = message('user_1', 'user');
        const first = buildRevertedMessageDockState(
            state({
                session: [{ id: 'ses_1', revert: { messageID: 'user_1' } } as State['session'][number]],
                message: { ses_1: [user] },
                part: { user_1: [textPart('part_user', 'hello')] },
            }),
            'ses_1',
        );

        const second = buildRevertedMessageDockState(
            state({
                session: [{ id: 'ses_1', revert: { messageID: 'user_1' } } as State['session'][number]],
                message: { ses_1: [user] },
                part: { user_1: [textPart('part_user_updated', 'updated')] },
            }),
            'ses_1',
            first,
        );

        expect(second).not.toBe(first);
        expect(second.records).toHaveLength(1);
    });

    test('does not list a visible replacement branch as reverted history', () => {
        const result = buildRevertedMessageDockState(
            state({
                session: [{ id: 'ses_1', revert: { messageID: 'msg_002' } } as State['session'][number]],
                message: {
                    ses_1: [
                        message('msg_001', 'user'),
                        message('msg_002', 'user'),
                        message('msg_003', 'user'),
                        message('msg_004', 'user'),
                    ],
                },
                postRevertBranch: addPostRevertBranchReplacement({}, 'ses_1', 'msg_002', 'msg_004'),
            }),
            'ses_1',
        );

        expect(result.records.map((record) => record.message.id)).toEqual(['msg_002', 'msg_003']);
    });
});
