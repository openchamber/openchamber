import { describe, expect, test } from 'bun:test';
import type { Message, Part } from '@opencode-ai/sdk/v2';

import {
    buildTaskSummaryEntriesFromSession,
    parseTaskMetadataBlock,
    prepareTaskToolOutput,
    readTaskSessionIdFromRecord,
    readTaskSessionIdFromOutput,
} from './taskToolModel';
import { TOOL_OUTPUT_MAX_CHARS } from '../toolRenderers';

describe('taskToolModel', () => {
    test('reads the current OpenCode running-state identity contract', () => {
        expect(readTaskSessionIdFromRecord({ sessionId: 'child-live' })).toBe('child-live');
        expect(readTaskSessionIdFromRecord({})).toBe(undefined);
    });

    test('reads authoritative session and summary metadata', () => {
        const output = 'result\n<task_metadata>{"sessionID":"child-1","calls":[{"id":"tool-1","tool":"read","title":"a.ts"}]}</task_metadata>';
        expect(parseTaskMetadataBlock(output)).toEqual({
            sessionId: 'child-1',
            summaryEntries: [{ id: 'tool-1', tool: 'read', state: { status: undefined, title: 'a.ts', input: undefined } }],
        });
        expect(readTaskSessionIdFromOutput(output)).toBe('child-1');
    });

    test('projects tool calls while excluding nested task and todo bookkeeping', () => {
        const message = {
            info: { id: 'message-1', role: 'assistant' } as Message,
            parts: [
                { id: 'read-1', type: 'tool', tool: 'read', state: { status: 'completed', input: { filePath: 'a.ts' } } },
                { id: 'task-1', type: 'tool', tool: 'task', state: { status: 'running' } },
                { id: 'todo-1', type: 'tool', tool: 'todowrite', state: { status: 'completed' } },
            ] as unknown as Part[],
        };

        expect(buildTaskSummaryEntriesFromSession([message])).toEqual([{
            id: 'read-1',
            tool: 'read',
            state: { status: 'completed', title: undefined, input: { filePath: 'a.ts' } },
        }]);
    });

    test('strips task metadata and caps oversized task output before markdown rendering', () => {
        const oversized = 'x'.repeat(TOOL_OUTPUT_MAX_CHARS + 5_000);
        const output = `${oversized}\n<task_metadata>{"sessionID":"child-1"}</task_metadata>`;
        const prepared = prepareTaskToolOutput(output);

        expect(prepared.length).toBeLessThan(oversized.length);
        expect(prepared).toContain('output truncated');
        expect(prepared).not.toContain('task_metadata');
    });

    test('leaves normal task output untouched', () => {
        expect(prepareTaskToolOutput('done\n<task_metadata>{"sessionID":"child-1"}</task_metadata>')).toBe('done');
        expect(prepareTaskToolOutput(undefined)).toBe('');
    });
});
