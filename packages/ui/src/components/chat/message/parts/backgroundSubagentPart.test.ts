import { describe, expect, test } from 'bun:test';
import type { ToolPart } from '@/lib/opencode/model';
import type { SubagentRun } from '@/lib/opencode/subagent-run';
import { toBackgroundSubagentPart } from './backgroundSubagentPart';

const call: ToolPart = {
    id: 'prt_1',
    sessionID: 'ses_parent',
    messageID: 'msg_1',
    type: 'tool',
    callID: 'call_1',
    tool: 'subagent',
    state: {
        status: 'completed',
        input: { agent: 'explore', description: 'Review' },
        output: 'The subagent is working in the background.',
        metadata: { status: 'running', sessionID: 'ses_child' },
        time: { start: 1000, end: 1100 },
    },
};

const run = (overrides: Partial<SubagentRun> = {}): SubagentRun => ({
    childSessionID: 'ses_child',
    state: 'completed',
    output: 'Nothing serious found.',
    reportedAt: 60_000,
    ...overrides,
});

describe('toBackgroundSubagentPart', () => {
    test('a running child keeps the row running and linked to the child', () => {
        expect(toBackgroundSubagentPart(call, { kind: 'running' }).state).toEqual({
            status: 'running',
            input: { agent: 'explore', description: 'Review' },
            metadata: { status: 'running', sessionID: 'ses_child' },
            time: { start: 1000 },
        });
    });

    test('a report finishes the row with its result and end time', () => {
        expect(toBackgroundSubagentPart(call, { kind: 'finished', run: run() }).state)
            .toMatchObject({ status: 'completed', output: 'Nothing serious found.', time: { start: 1000, end: 60_000 } });
        expect(toBackgroundSubagentPart(call, { kind: 'finished', run: run({ state: 'error', output: 'boom' }) }).state)
            .toMatchObject({ status: 'error', error: 'boom' });
    });

    test('without a running child or a report the row stays as OpenCode left it', () => {
        expect(toBackgroundSubagentPart(call, { kind: 'unknown' })).toBe(call);
    });
});
