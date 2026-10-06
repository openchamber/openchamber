import { describe, expect, test } from 'bun:test';
import type { Part, Session, ToolPart } from '@/lib/opencode/model';
import type { MessageRecord } from '@/lib/messageCompletion';

import {
    buildTaskSummaryEntriesFromSession,
    parseTaskMetadataBlock,
    prepareTaskToolOutput,
    readTaskSessionIdFromRecord,
    readTaskSessionIdFromOutput,
    resolveRunningTaskChildSessionId,
} from './taskToolModel';
import { TOOL_OUTPUT_MAX_CHARS } from '../toolRenderers';

const invocation = (start: number, end?: number): ToolPart => ({
    id: `task-${start}`, sessionID: 'parent', messageID: 'parent-message',
    type: 'tool', callID: `task-${start}`, tool: 'subagent',
    time: { created: start, completed: end },
    state: end === undefined
        ? { status: 'running', input: { sessionID: 'child' }, time: { start } }
        : { status: 'completed', input: { sessionID: 'child' }, output: '', time: { start, end } },
});

const activity = (id: string, created: number, completed?: number): ToolPart => ({
    id, sessionID: 'child', messageID: 'child-message', type: 'tool', callID: id, tool: 'read',
    time: { created, completed },
    state: completed === undefined
        ? { status: 'running', input: { path: id }, time: { start: created } }
        : { status: 'completed', input: { path: id }, output: '', time: { start: created, end: completed } },
});

const records = (parts: Part[]): MessageRecord[] => [{
    info: {
        id: 'child-message', sessionID: 'child', role: 'assistant', agent: 'general',
        time: { created: 1 }, modelID: 'model', providerID: 'provider', cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts,
}];

describe('taskToolModel', () => {
    test('reads the current OpenCode running-state identity contract', () => {
        expect(readTaskSessionIdFromRecord({ sessionId: 'child-live' })).toBe('child-live');
        expect(readTaskSessionIdFromRecord({})).toBe(undefined);
        expect(readTaskSessionIdFromRecord({ sessionID: '  ' })).toBe(undefined);
        expect(readTaskSessionIdFromRecord(undefined)).toBe(undefined);
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
        const read = activity('read-1', 110, 150);
        read.state.input = { path: 'a.ts' };
        const messages = records([read, invocation(110), invocation(120, 150)]);

        expect(buildTaskSummaryEntriesFromSession(messages, invocation(100, 200))).toEqual([{
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

    test('unwraps the OpenCode 2 subagent envelope and preserves the result Markdown exactly', () => {
        const result = '**MERGE**\n\n- first item\n\n```ts\nconst answer = 42;\n```';
        const output = `<subagent sessionID="ses_abc123" state="completed">\n${result}\n</subagent>`;

        expect(prepareTaskToolOutput(output)).toBe(result);
    });

    test('leaves a subagent tag that does not wrap the whole output untouched', () => {
        const unterminated = '<subagent sessionID="ses_abc123" state="completed">\nstill writing';
        expect(prepareTaskToolOutput(unterminated)).toBe(unterminated);

        const trailingProse = '<subagent sessionID="ses_abc123" state="completed">\nresult\n</subagent>\nmore text';
        expect(prepareTaskToolOutput(trailingProse)).toBe(trailingProse);
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

describe('invocation-scoped task activity', () => {
    const ids = (messages: MessageRecord[], part: ToolPart) => buildTaskSummaryEntriesFromSession(messages, part).map((entry) => entry.id);

    test('isolates sequential invocations of the same child, including input.sessionID resumes', () => {
        const messages = records([activity('old', 50, 60), activity('first', 110, 150), activity('second', 210)]);
        expect(ids(messages, invocation(100, 200))).toEqual(['first']);
        expect(ids(messages, invocation(200))).toEqual(['second']);
        expect(ids(messages, invocation(200, 300))).toEqual(['second']);
    });

    test('derives identical membership after reload without a React snapshot', () => {
        const messages = records([activity('first', 110, 150), activity('second', 210, 250)]);
        const part = invocation(100, 200);
        expect(ids(structuredClone(messages), structuredClone(part))).toEqual(ids(messages, part));
        expect(ids(structuredClone(messages), part)).toEqual(['first']);
    });

    test('accepts a late final event for old activity without accepting new activity', () => {
        const first = invocation(100, 200);
        const live = records([activity('first', 110), activity('second', 210)]);
        expect(buildTaskSummaryEntriesFromSession(live, first)[0]?.state?.status).toBe('running');
        const settled = records([activity('first', 110, 260), activity('second', 210, 250)]);
        expect(ids(settled, first)).toEqual(['first']);
        expect(buildTaskSummaryEntriesFromSession(settled, first)[0]?.state?.status).toBe('completed');
        expect(ids(settled, invocation(200, 300))).toEqual(['second']);
    });

    test('rejects missing, nonfinite, or inverted bounds and missing activity creation', () => {
        const messages = records([activity('first', 110, 150)]);
        const noCompletion = invocation(100, 200);
        noCompletion.time = { created: 100 };
        expect(ids(messages, noCompletion)).toEqual([]);
        expect(ids(messages, invocation(NaN, 200))).toEqual([]);
        expect(ids(messages, invocation(200, 100))).toEqual([]);
        expect(ids(messages, invocation(100, Infinity))).toEqual([]);
        const missingCreated = activity('unknown', 110, 150);
        delete missingCreated.time;
        expect(ids(records([missingCreated]), invocation(100, 200))).toEqual([]);
        expect(ids(messages, { ...invocation(100), state: { status: 'pending', input: {}, raw: '' } })).toEqual([]);
    });

    test('uses each tool creation rather than message creation or execution/completion time', () => {
        const tool = activity('first', 110, 260);
        tool.state = { status: 'completed', input: {}, output: '', time: { start: 230, end: 260 } };
        expect(ids(records([tool, activity('at-end', 200)]), invocation(100, 200))).toEqual(['first']);
    });

    test('scopes failed invocations and includes the authoritative start boundary', () => {
        const failed = invocation(100, 200);
        failed.state = { status: 'error', input: { sessionID: 'child' }, error: 'failed', time: { start: 100, end: 200 } };
        expect(ids(records([activity('before', 99), activity('at-start', 100), activity('after', 201)]), failed)).toEqual(['at-start']);
    });
});

describe('resolveRunningTaskChildSessionId', () => {
    const session = (id: string, created: number, agent?: string, parentID = 'parent', title = id): Session => ({
        id, parentID, projectID: 'p', directory: '/w', title, agent, cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created, updated: created },
    });
    const task = (id: string, agent: string, metadata?: { sessionID: string }): Part => ({
        id, sessionID: 'parent', messageID: 'm', type: 'tool', tool: 'subagent', callID: id,
        state: { status: 'running', input: { agent }, time: { start: 100 }, metadata },
    });
    const resolve = (sessions: Session[], siblings: Part[] = [task('t1', 'explore')], agent = 'explore', description?: string) =>
        resolveRunningTaskChildSessionId({ sessions, parentSessionID: 'parent', startedAt: 100, agent, description, siblingParts: siblings, partID: 't1' });

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

    test('tells parallel calls of one agent apart by the child title', () => {
        const siblings = [task('t1', 'explore'), task('t2', 'explore'), task('t3', 'explore')];
        const sessions = [
            session('c0', 110, 'explore', 'parent', 'Part 0'),
            session('c1', 111, 'explore', 'parent', 'Part 1'),
            session('c2', 112, 'explore', 'parent', 'Part 2'),
        ];
        expect(resolve(sessions, siblings, 'explore', 'Part 1')).toBe('c1');
        expect(resolve(sessions, siblings, 'explore', 'Part 9')).toBeUndefined();
        expect(resolve([...sessions, session('dup', 113, 'explore', 'parent', 'Part 1')], siblings, 'explore', 'Part 1')).toBeUndefined();
    });
});
