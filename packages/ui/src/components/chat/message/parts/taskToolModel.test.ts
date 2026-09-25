import { describe, expect, test } from 'bun:test';
import type { Message, Part, Session } from '@/lib/opencode/model';

import {
    buildTaskSummaryEntriesFromSession,
    parseTaskMetadataBlock,
    prepareTaskToolOutput,
    readTaskSessionIdFromRecord,
    readTaskSessionIdFromOutput,
    resolveRunningTaskChildSessionId,
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

    test('projects tool calls while excluding nested subagent calls', () => {
        const message = {
            info: { id: 'message-1', role: 'assistant' } as Message,
            parts: [
                { id: 'read-1', type: 'tool', tool: 'read', state: { status: 'completed', input: { path: 'a.ts' } } },
                { id: 'subagent-1', type: 'tool', tool: 'subagent', state: { status: 'running' } },
                { id: 'subagent-1', type: 'tool', tool: 'subagent', state: { status: 'completed' } },
            ] as unknown as Part[],
        };

        expect(buildTaskSummaryEntriesFromSession([message])).toEqual([{
            id: 'read-1',
            tool: 'read',
            state: { status: 'completed', input: { path: 'a.ts' } },
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

    test('unwraps the task result envelope and preserves the result Markdown exactly', () => {
        const result = [
            '## Verdict',
            '',
            '- first item',
            '- second item',
            '',
            '```ts',
            'const answer = 42;',
            '```',
        ].join('\n');
        const output = [
            '<task id="ses_abc123" state="completed">',
            '<task_result>',
            result,
            '</task_result>',
            '</task>',
        ].join('\n');

        expect(prepareTaskToolOutput(output)).toBe(result);
    });

    test('unwraps a same-line task result envelope', () => {
        const output = '<task id="ses_abc123" state="completed"><task_result>result</task_result></task>';

        expect(prepareTaskToolOutput(output)).toBe('result');
    });

    test('leaves output without a complete task envelope untouched', () => {
        const plainMarkdown = '## Verdict\n- first item';
        expect(prepareTaskToolOutput(plainMarkdown)).toBe(plainMarkdown);

        const taskTagWithoutResult = '<task id="ses_abc123" state="running">\nstill running';
        expect(prepareTaskToolOutput(taskTagWithoutResult)).toBe(taskTagWithoutResult);

        const unterminatedResult = '<task id="ses_abc123" state="running">\n<task_result>\nstill running';
        expect(prepareTaskToolOutput(unterminatedResult)).toBe(unterminatedResult);

        const resultWithoutEnvelope = 'literal <task_result>text</task_result> in prose';
        expect(prepareTaskToolOutput(resultWithoutEnvelope)).toBe(resultWithoutEnvelope);
    });

    test('keeps parsing task metadata from the raw envelope output', () => {
        const output = [
            '<task id="ses_abc123" state="completed">',
            '<task_result>',
            '## Verdict',
            '</task_result>',
            '</task>',
            '<task_metadata>{"sessionID":"child-1"}</task_metadata>',
        ].join('\n');

        expect(prepareTaskToolOutput(output)).toBe('## Verdict');
        expect(readTaskSessionIdFromOutput(output)).toBe('child-1');
        expect(parseTaskMetadataBlock(output).sessionId).toBe('child-1');
    });
});

describe('resolveRunningTaskChildSessionId', () => {
    const session = (id: string, created: number, agent?: string, parentID = 'parent'): Session => ({
        id, parentID, projectID: 'p', directory: '/w', title: id, agent, cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created, updated: created },
    });
    const task = (id: string, agent: string, metadata?: { sessionID: string }): Part => ({
        id, sessionID: 'parent', messageID: 'm', type: 'tool', tool: 'subagent', callID: id,
        state: { status: 'running', input: { agent }, time: { start: 100 }, metadata },
    });
    const resolve = (sessions: Session[], siblings: Part[] = [task('t1', 'explore')], agent = 'explore') =>
        resolveRunningTaskChildSessionId({ sessions, parentSessionID: 'parent', startedAt: 100, agent, siblingParts: siblings, partID: 't1' });

    test('finds the single child created after the call started', () => {
        expect(resolve([session('old', 50, 'explore'), session('other', 150, 'explore', 'elsewhere'), session('child', 120, 'explore')])).toBe('child');
    });

    test('filters by the requested agent', () => {
        expect(resolve([session('a', 120, 'general'), session('b', 130, 'explore')])).toBe('b');
    });

    test('skips children already joined to another Task call', () => {
        const siblings = [task('t1', 'explore'), task('t2', 'explore', { sessionID: 'claimed' })];
        expect(resolve([session('claimed', 110, 'explore'), session('mine', 120, 'explore')], siblings)).toBe('mine');
    });

    test('gives up when more than one candidate remains', () => {
        expect(resolve([session('a', 110, 'explore'), session('b', 120, 'explore')])).toBeUndefined();
        expect(resolve([])).toBeUndefined();
    });
});
