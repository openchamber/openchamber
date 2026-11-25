import { describe, expect, test } from 'bun:test';

import { formatMessage, type I18nKey, type I18nParams } from '@/lib/i18n';
import { dict } from '@/lib/i18n/messages/en';
import type { ToolPart, ToolState } from '@/lib/opencode/model';

import { getToolDescription } from './toolDescriptions';

const t = (key: I18nKey, params?: I18nParams) => formatMessage(dict, key, params);

const input = { questions: [{ question: 'We have two targets. Which database should the migration target?' }, { question: 'Keep the old endpoints?' }] };

const question = (state: ToolState): ToolPart => ({
    type: 'tool', id: 'asked', callID: 'asked', tool: 'question', sessionID: 'session', messageID: 'message', state,
});

const rowText = (state: ToolState) => getToolDescription(question(state), state, '/repo', t);

describe('a question row', () => {
    test('shows each question it asked with the answer it got', () => {
        const state: ToolState = { status: 'completed', input, output: '', metadata: { answers: [['Postgres'], []] }, time: { start: 1, end: 2 } };
        expect(rowText(state)).toBe('Which database should the migration target? → Postgres · Keep the old endpoints? → Not answered');
    });

    test('counts the questions while it waits', () => {
        expect(rowText({ status: 'running', input, time: { start: 1 } })).toBe('Questions asked: 2');
    });
});
