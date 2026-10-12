import { describe, expect, test } from 'bun:test';
import type { FilePart, Part, TextPart } from '@/lib/opencode/model';
import type { ChatMessageEntry } from '../lib/turns/types';
import { collectSelectedConversationMessages, hasConversationExportContent } from './selectedMessages';

const sessionID = 'session';
const text = (messageID: string, value: string): TextPart => ({
    id: `${messageID}:text`, sessionID, messageID, type: 'text', text: value,
});
const file = (messageID: string, filename?: string): FilePart => ({
    id: `${messageID}:file`, sessionID, messageID, type: 'file',
    mime: 'image/png', filename, url: 'https://example.com/attachment.png',
});
const user = (id: string, parts: Part[] = [text(id, id)]): ChatMessageEntry => ({
    info: { id, sessionID, role: 'user', time: { created: 1 } }, parts,
});
const assistant = (id: string, parts: Part[]): ChatMessageEntry => ({
    info: {
        id, sessionID, role: 'assistant', time: { created: 2, completed: 3 },
        agent: 'build', providerID: 'provider', modelID: 'model', finish: 'stop',
    },
    parts,
});
const activity = (messageID: string): Part[] => [
    { id: `${messageID}:reasoning`, sessionID, messageID, type: 'reasoning', text: 'Private reasoning', time: { start: 1, end: 2 } },
    {
        id: `${messageID}:tool`, sessionID, messageID, type: 'tool', callID: 'call', tool: 'shell',
        state: { status: 'completed', input: { command: 'pwd' }, output: 'Tool output', time: { start: 1, end: 2 } },
    },
];

describe('selected conversation content', () => {
    test('collects in transcript order regardless of selection insertion order', () => {
        const messages = [user('u1'), assistant('a1', [text('a1', 'First answer')]), user('u2'), assistant('a2', [text('a2', 'Second answer')])];
        const expected = [
            { key: 'user:u1', role: 'user', segments: ['u1'], attachments: [] },
            { key: 'assistant:u1', role: 'assistant', segments: ['First answer'], attachments: [] },
            { key: 'user:u2', role: 'user', segments: ['u2'], attachments: [] },
            { key: 'assistant:u2', role: 'assistant', segments: ['Second answer'], attachments: [] },
        ];
        expect(collectSelectedConversationMessages(messages, new Set(['assistant:u2', 'user:u2', 'assistant:u1', 'user:u1']))).toEqual(expected);
        expect(collectSelectedConversationMessages(messages, new Set(['user:u1', 'assistant:u1', 'user:u2', 'assistant:u2']))).toEqual(expected);
    });

    test('exports every assistant step and text part while excluding reasoning and tools', () => {
        const messages = [
            user('u1'),
            assistant('a1', [text('a1', 'Earlier folded text'), ...activity('a1'), text('a1', 'Second paragraph')]),
            assistant('a2', [text('a2', 'Final answer')]),
        ];
        expect(collectSelectedConversationMessages(messages, new Set(['assistant:u1']))).toEqual([
            { key: 'assistant:u1', role: 'assistant', segments: ['Earlier folded text', 'Second paragraph', 'Final answer'], attachments: [] },
        ]);
    });

    test('merges hidden user continuations into the preceding visible assistant turn', () => {
        const messages = [
            user('u1'), assistant('a1', [text('a1', 'Before continuation')]),
            user('hidden', []), assistant('a2', [text('a2', 'After continuation')]),
            user('u2'), assistant('a3', [text('a3', 'Next turn')]),
        ];
        expect(collectSelectedConversationMessages(messages, new Set(['assistant:u1', 'user:hidden', 'assistant:hidden']))).toEqual([
            { key: 'assistant:u1', role: 'assistant', segments: ['Before continuation', 'After continuation'], attachments: [] },
        ]);
    });

    test('keeps user indentation and attachments for both roles', () => {
        const source = '    const value = 1;\n\n\tsecond line\n';
        const messages = [user('u1', [text('u1', source), file('u1', 'input.png')]), assistant('a1', [file('a1'), text('a1', 'Answer')])];
        expect(collectSelectedConversationMessages(messages, new Set(['assistant:u1', 'user:u1']))).toEqual([
            { key: 'user:u1', role: 'user', segments: [source], attachments: [{ name: 'input.png', url: 'https://example.com/attachment.png' }] },
            { key: 'assistant:u1', role: 'assistant', segments: ['Answer'], attachments: [{ name: 'image/png', url: 'https://example.com/attachment.png' }] },
        ]);
    });

    test('activity-only answers have no export content and file-only answers do', () => {
        expect(hasConversationExportContent(activity('a1'))).toBe(false);
        expect(hasConversationExportContent([text('a1', ' \n\t')])).toBe(false);
        expect(hasConversationExportContent([file('a1')])).toBe(true);
        expect(collectSelectedConversationMessages([user('u1'), assistant('a1', activity('a1'))], new Set(['assistant:u1']))).toEqual([]);
        expect(collectSelectedConversationMessages([user('u1'), assistant('a1', [file('a1')])], new Set(['assistant:u1']))).toEqual([
            { key: 'assistant:u1', role: 'assistant', segments: [], attachments: [{ name: 'image/png', url: 'https://example.com/attachment.png' }] },
        ]);
    });

    test('missing keys and stale assistant message ids do not invent content', () => {
        const messages = [user('u1'), assistant('a1', [text('a1', 'Answer')])];
        expect(collectSelectedConversationMessages(messages, new Set(['user:missing', 'assistant:missing', 'assistant:a1']))).toEqual([]);
        expect(collectSelectedConversationMessages([], new Set(['user:u1', 'assistant:u1']))).toEqual([]);
        expect(collectSelectedConversationMessages(messages, new Set())).toEqual([]);
        expect(collectSelectedConversationMessages(messages, new Set(['user:missing', 'assistant:u1']))).toEqual([
            { key: 'assistant:u1', role: 'assistant', segments: ['Answer'], attachments: [] },
        ]);
    });
});
