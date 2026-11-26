import { expect, test } from 'bun:test';
import type { Part } from '@/lib/opencode/model';
import { projectTurnRecords } from './projectTurnRecords';
import { buildTimelineRows } from './timelineRows';
import type { ChatMessageEntry } from './types';

const base = { sessionID: 's', agent: 'build', modelID: 'm', providerID: 'p' };
const step = (id: string, thought = 'Thinking'): ChatMessageEntry => {
    const parts: Part[] = [
        { type: 'reasoning', id: `${id}-think`, text: thought, sessionID: 's', messageID: id, time: thought ? { start: 1, end: 2 } : { start: 1 } },
        { type: 'tool', id: `${id}-call`, tool: 'shell', callID: id, sessionID: 's', messageID: id, state: { status: 'completed', input: {}, output: '', metadata: {}, time: { start: 1, end: 2 } } },
    ];
    return { info: { ...base, id, role: 'assistant', finish: 'tool-calls', time: { created: 2, completed: 3 }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }, parts };
};

const rowsOf = (steps: number, blankFirst = false) => {
    const user: ChatMessageEntry = {
        info: { ...base, id: 'u', role: 'user', time: { created: 1 } },
        parts: [{ type: 'text', id: 'u-text', text: 'Go', sessionID: 's', messageID: 'u' }],
    };
    const [turn] = projectTurnRecords([user, ...Array.from({ length: steps }, (_, index) => step(`m${index}`, blankFirst && index === steps - 1 ? '' : 'Thinking'))], { showTurnChangedFiles: false }).turns;
    return buildTimelineRows([{ kind: 'turn', key: 'turn:u', turn, isLastTurn: true }], {
        collapsedActivity: false, groupedActivity: true, working: true, showReasoningTraces: true, expandedTurns: new Map(),
    }, []);
};

test('a running group draws its latest seven rows, cutting inside a step', () => {
    const steps = rowsOf(6).flatMap((row) => (row.kind === 'turn-message' ? [{ key: row.key, from: row.slice?.from?.partId }] : []));
    expect(steps).toEqual([
        { key: 'step:m2', from: 'm2-call' },
        { key: 'step:m3', from: undefined },
        { key: 'step:m4', from: undefined },
        { key: 'step:m5', from: undefined },
    ]);
});

test('a blank thought of a finished step takes no row', () => {
    const steps = rowsOf(8, true).flatMap((row) => (row.kind === 'turn-message' ? [row.slice?.from?.partId ?? row.key] : []));
    expect(steps).toEqual(['step:m4', 'step:m5', 'step:m6', 'm7-call']);
});
