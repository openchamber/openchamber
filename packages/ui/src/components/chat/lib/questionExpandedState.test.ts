import { describe, expect, test } from 'bun:test';

import type { Part, ToolPart } from '@/lib/opencode/model';
import {
    isQuestionOpen,
    openQuestionSnapshot,
    seedExpandedTools,
    writeExpandedToolsCache,
    writeQuestionOpen,
} from './questionExpandedState';

const answeredQuestion = (id: string): ToolPart => ({
    id,
    sessionID: 'ses_1',
    messageID: 'msg_assistant',
    type: 'tool',
    callID: id,
    tool: 'question',
    state: {
        status: 'completed',
        input: { questions: [{ question: 'Ship it?', options: [{ label: 'Yes' }] }] },
        output: 'User has answered your questions: "Ship it?"="Yes". You can now continue with the user\'s answers in mind.',
        metadata: {},
        time: { start: 1, end: 2 },
    },
});

const parts = (id: string): Part[] => [answeredQuestion(id)];

describe('a question row open state', () => {
    test('follows the setting until the reader decides', () => {
        expect(isQuestionOpen('call_setting_on', true)).toBe(true);
        expect(isQuestionOpen('call_setting_off', false)).toBe(false);
    });

    test('the reader closed a row that the setting would open, and it stays closed', () => {
        writeQuestionOpen('call_closed', false);
        expect(isQuestionOpen('call_closed', true)).toBe(false);
        // Shown again after a session switch the decision is still there.
        expect(isQuestionOpen('call_closed', true)).toBe(false);
    });

    test('the reader opened a row while the setting is off, and it stays open', () => {
        writeQuestionOpen('call_opened', true);
        expect(isQuestionOpen('call_opened', false)).toBe(true);
    });

    test('one snapshot names the rows this message draws open', () => {
        writeQuestionOpen('call_snap_open', true);
        writeQuestionOpen('call_snap_closed', false);
        expect(openQuestionSnapshot(['call_snap_open', 'call_snap_closed'], false)).toBe('call_snap_open');
        expect(openQuestionSnapshot(['call_snap_closed'], true)).toBe('');
    });
});

describe('seedExpandedTools', () => {
    test('leaves question rows to their own owner', () => {
        expect(seedExpandedTools('msg_questions', parts('call_left_out'))).not.toContain('call_left_out');
    });

    test('keeps the other tool rows a message opened, including after a reload', () => {
        const messageId = 'msg_other_tools';
        writeExpandedToolsCache(messageId, new Set(['shell_call']));
        expect(seedExpandedTools(messageId, parts('call_beside'))).toContain('shell_call');
    });
});
