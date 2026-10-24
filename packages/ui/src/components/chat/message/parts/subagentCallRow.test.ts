import { describe, expect, test } from 'bun:test';
import type { ToolPart } from '@/lib/opencode/model';
import type { SubagentRun } from '@/lib/opencode/subagent-run';
import { resolveSubagentCallPhase, toStoppedSubagentPart, toSubagentCallPart } from './subagentCallRow';

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

const failed: ToolPart = {
    ...call,
    state: {
        status: 'error',
        input: { agent: 'explore', description: 'Review' },
        error: 'Provider error',
        metadata: { sessionID: 'ses_child' },
        time: { start: 1000, end: 10_000 },
    },
};

const run = (overrides: Partial<SubagentRun> = {}): SubagentRun => ({
    childSessionID: 'ses_child',
    state: 'completed',
    output: 'Nothing serious found.',
    reportedAt: 60_000,
    ...overrides,
});

const resolve = (overrides: Partial<Parameters<typeof resolveSubagentCallPhase>[0]> = {}) => (
    resolveSubagentCallPhase({
        run: undefined,
        childRunning: false,
        childStartedAt: undefined,
        childDurationMs: undefined,
        ...overrides,
    })
);

describe('toSubagentCallPart', () => {
    test('a running child keeps the row running and linked to the child', () => {
        expect(toSubagentCallPart(call, { kind: 'running' }).state).toEqual({
            status: 'running',
            input: { agent: 'explore', description: 'Review' },
            metadata: { status: 'running', sessionID: 'ses_child' },
            time: { start: 1000 },
        });
    });

    test('a report finishes the row with its result and end time', () => {
        expect(toSubagentCallPart(call, { kind: 'finished', run: run() }).state)
            .toMatchObject({ status: 'completed', output: 'Nothing serious found.', time: { start: 1000, end: 60_000 } });
        expect(toSubagentCallPart(call, { kind: 'finished', run: run({ state: 'error', output: 'boom' }) }).state)
            .toMatchObject({ status: 'error', error: 'boom' });
    });

    test('a run this device timed is drawn back from the report time', () => {
        expect(toSubagentCallPart(call, { kind: 'finished', run: run(), durationMs: 30_000 }).state)
            .toMatchObject({ time: { start: 30_000, end: 60_000 } });
    });

    test('a duration longer than the row is never drawn before its call', () => {
        expect(toSubagentCallPart(failed, { kind: 'finished', run: run(), durationMs: 90_000 }).state)
            .toMatchObject({ time: { start: 1000, end: 60_000 } });
    });

    test('a child running again after a report shows the running turn, not the report', () => {
        expect(resolve({ run: run({ state: 'error', output: 'boom' }), childRunning: true, childStartedAt: 90_000 }))
            .toEqual({ kind: 'running', startedAt: 90_000 });
    });

    test('a revived run is timed from the turn that started it, not from the call', () => {
        expect(toSubagentCallPart(call, { kind: 'running', startedAt: 90_000 }).state)
            .toMatchObject({ status: 'running', time: { start: 90_000 } });
    });

    test('a settled child shows its report', () => {
        expect(resolve({ run: run(), childDurationMs: 20_000 }))
            .toEqual({ kind: 'finished', run: run(), durationMs: 20_000 });
    });

    test('a settled child with no report stays unknown', () => {
        expect(resolve()).toEqual({ kind: 'unknown' });
    });

    test('a failed foreground call turns into the run reported after it', () => {
        expect(toSubagentCallPart(failed, { kind: 'finished', run: run(), durationMs: 50_000 }).state)
            .toMatchObject({ status: 'completed', output: 'Nothing serious found.', time: { start: 10_000, end: 60_000 } });
    });

    test('a call OpenCode still runs is left alone', () => {
        const running: ToolPart = { ...call, state: { status: 'running', input: { agent: 'explore' }, time: { start: 1000 } } };
        expect(toSubagentCallPart(running, { kind: 'running' })).toBe(running);
    });

    test('without a running child or a report the row stays as OpenCode left it', () => {
        expect(toSubagentCallPart(call, { kind: 'unknown' })).toBe(call);
        expect(toSubagentCallPart(failed, { kind: 'unknown' })).toBe(failed);
    });
});

describe('toStoppedSubagentPart', () => {
    test('a cancelled foreground call reads as finished with the notice, keeping its timing', () => {
        const cancelled: ToolPart = {
            ...failed,
            state: {
                status: 'error',
                input: { agent: 'explore', description: 'Review' },
                error: 'Subagent cancelled (sessionID: ses_child)',
                time: { start: 1000, end: 10_000 },
            },
        };
        expect(toStoppedSubagentPart(cancelled, 'Stopped by you.').state).toEqual({
            status: 'completed', input: call.state.input, output: 'Stopped by you.', metadata: undefined, time: { start: 1000, end: 10_000 },
        });
        expect(toStoppedSubagentPart(call, 'Stopped by you.')).toBe(call);
    });
});
