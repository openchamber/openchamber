import { describe, expect, test } from 'bun:test';
import type { Part } from '@/lib/opencode/model';
import { buildSameRows } from './liveRowParts';

const text = (value: string, end?: number): Part => ({ id: 't', sessionID: 's', messageID: 'm', type: 'text', text: value, time: { start: 1, end } });
const shell = (status: 'pending' | 'running'): Part => ({
    id: 'c', sessionID: 's', messageID: 'm', type: 'tool', tool: 'bash', callID: 'c',
    state: status === 'pending' ? { status, input: {}, raw: '' } : { status, input: {}, time: { start: 1 } },
});

describe('buildSameRows', () => {
    test('ignores streamed text', () => {
        expect(buildSameRows({ m: [text('Look')] }, { m: [text('Looking')] })).toBe(true);
    });

    test('sees text appear and end', () => {
        expect(buildSameRows({ m: [text('')] }, { m: [text('L')] })).toBe(false);
        expect(buildSameRows({ m: [text('L')] }, { m: [text('L', 2)] })).toBe(false);
    });

    test('sees a call arrive, start and a step join', () => {
        expect(buildSameRows({ m: [text('L')] }, { m: [text('L'), shell('pending')] })).toBe(false);
        expect(buildSameRows({ m: [shell('pending')] }, { m: [shell('running')] })).toBe(false);
        expect(buildSameRows({ m: [shell('running')] }, { m: [shell('running')], n: [] })).toBe(false);
    });
});
