import { describe, expect, test } from 'bun:test';

import type { AssistantMessage, Part } from '@/lib/opencode/model';
import { earlierAssistantText } from './earlierAssistantText';
import type { ChatMessageEntry } from './types';

const text = (id: string, content: string): Part => ({ type: 'text', id, text: content, sessionID: 'session', messageID: 'message' });
const glob: Part = {
    type: 'tool', tool: 'glob', id: 'glob', callID: 'glob', sessionID: 'session', messageID: 'message',
    state: { status: 'completed', input: { pattern: '*.md' }, output: 'README.md', metadata: {}, time: { start: 1, end: 2 } },
};
const assistant = (id: string, parts: Part[]): ChatMessageEntry => {
    const info: AssistantMessage = {
        id, sessionID: 'session', role: 'assistant', time: { created: 1 }, modelID: 'model', providerID: 'provider', agent: 'build',
        cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    };
    return { info, parts };
};

describe('earlierAssistantText', () => {
    test('collects the text of every step before the last one, in order, without tools or blank parts', () => {
        const turn = [
            assistant('step-1', [text('a', 'Looking at the files.'), glob]),
            assistant('step-2', [text('b', '  '), glob]),
            assistant('step-3', [text('c', 'Found the scripts.'), glob, text('d', 'Checking one more.')]),
            assistant('answer', [text('e', 'The answer.')]),
        ];
        expect(earlierAssistantText(turn)).toEqual(['Looking at the files.', 'Found the scripts.', 'Checking one more.']);
    });

    test('a turn of one message has no earlier text', () => {
        expect(earlierAssistantText([assistant('answer', [text('e', 'The answer.')])])).toEqual([]);
        expect(earlierAssistantText([])).toEqual([]);
    });

    test('a step that changes is read again', () => {
        const answer = assistant('answer', [text('e', 'The answer.')]);
        const step = assistant('step', [text('a', 'First draft.')]);
        expect(earlierAssistantText([step, answer])).toEqual(['First draft.']);
        const updated = { ...step, parts: [text('a', 'Second draft.')] };
        expect(earlierAssistantText([updated, answer])).toEqual(['Second draft.']);
    });
});
