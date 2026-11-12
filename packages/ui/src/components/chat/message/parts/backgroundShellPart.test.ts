import { describe, expect, test } from 'bun:test';
import type { ShellCompletion } from '@/lib/opencode/background-shell';
import type { ToolPart } from '@/lib/opencode/model';
import { toBackgroundShellPart } from './backgroundShellPart';

const NOTICE = 'Command moved to the background (shell ID: sh_1).\nOutput is streaming to: /tmp/sh_1.out';

const call: ToolPart = {
    id: 'prt_1',
    sessionID: 'ses_1',
    messageID: 'msg_1',
    type: 'tool',
    callID: 'call_1',
    tool: 'shell',
    state: {
        status: 'completed',
        input: { command: 'sleep 300', background: true },
        output: `${NOTICE}\n\nYou will be notified automatically when the command finishes. DO NOT poll.`,
        metadata: { status: 'running', shellID: 'sh_1', truncated: false },
        time: { start: 1000, end: 1100 },
    },
};

const completion = (overrides: Partial<ShellCompletion> = {}): ShellCompletion => ({
    shellID: 'sh_1',
    state: 'completed',
    exit: 0,
    output: '5 minutes elapsed',
    endedAt: 301_000,
    ...overrides,
});

describe('toBackgroundShellPart', () => {
    test('a running command runs from the call start with its live output', () => {
        expect(toBackgroundShellPart(call, { kind: 'running', output: 'tick\n' }).state).toEqual({
            status: 'running',
            input: { command: 'sleep 300', background: true },
            metadata: { output: 'tick\n' },
            time: { start: 1000 },
        });
    });

    test('a finished command ends when OpenCode reported it, with its real output', () => {
        const state = toBackgroundShellPart(call, { kind: 'finished', completion: completion() }).state;
        expect(state).toMatchObject({ status: 'completed', output: '5 minutes elapsed', time: { start: 1000, end: 301_000 } });
    });

    test('a failed command reads as a failed tool call', () => {
        const state = toBackgroundShellPart(call, {
            kind: 'finished',
            completion: completion({ exit: 2, output: 'boom\n\nExited with code 2' }),
        }).state;
        expect(state).toMatchObject({ status: 'error', error: 'exited (2)', output: 'boom\n\nExited with code 2' });
    });

    test('an unknown state shows the notice without the instruction for the model', () => {
        const state = toBackgroundShellPart(call, { kind: 'unknown' }).state;
        expect(state.status === 'completed' ? state.output : undefined).toBe(NOTICE);
    });

    test('a command the user stopped reads as stopped, not failed', () => {
        const state = toBackgroundShellPart(call, { kind: 'stopped', endedAt: 20_000, notice: 'Stopped by you.' }).state;
        expect(state).toMatchObject({ status: 'completed', output: 'Stopped by you.', time: { start: 1000, end: 20_000 } });
    });
});
