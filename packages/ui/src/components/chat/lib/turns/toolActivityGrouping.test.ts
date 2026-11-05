import { describe, expect, test } from 'bun:test';
import type { Part, ToolPart } from '@/lib/opencode/model';
import type { ChatMessageEntry } from './types';
import {
    advanceLiveToolTail,
    isGroupableTool,
    planToolActivity,
    runningBackgroundToolIds,
    toolActivityParts,
    toolActivityPluralCategory,
} from './toolActivityGrouping';

const tool = (id: string, name = 'read'): ToolPart => ({
    id, callID: id, type: 'tool', tool: name, sessionID: 's', messageID: id,
    state: { status: 'completed', input: {}, output: '', time: { start: 1, end: 2 } },
});
const text: Part = { id: 'text', type: 'text', text: 'Checking', sessionID: 's', messageID: 'm' };

const message = (id: string, parts: Part[]): ChatMessageEntry => ({
    info: {
        id, sessionID: 's', role: 'assistant', time: { created: 1, completed: 2 },
        modelID: 'model', providerID: 'provider', agent: 'build',
        cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts,
});

describe('tool activity grouping', () => {
    test('groups calls across messages and leaves the running call outside', () => {
        const a = tool('a');
        const b = tool('b', 'grep');
        const running: ToolPart = { ...tool('running'), state: { status: 'running', input: {}, time: { start: 1 } } };
        const plan = planToolActivity([text, a, b, running], false);
        expect(plan.get('a')?.parts.map((part) => part.id)).toEqual(['a', 'b']);
        expect(plan.get('a')?.first).toBe(true);
        expect(plan.get('b')?.first).toBe(false);
        expect(plan.has('running')).toBe(false);
    });

    test('text and interactive calls separate groups', () => {
        const plan = planToolActivity([tool('a'), tool('b'), text, tool('q', 'question'), tool('c'), tool('d')], false);
        expect(plan.get('a')?.parts.map((part) => part.id)).toEqual(['a', 'b']);
        expect(plan.has('q')).toBe(false);
        expect(plan.get('c')?.parts.map((part) => part.id)).toEqual(['c', 'd']);
    });

    test('keeps running background shells and subagents out of groups', () => {
        const backgroundShell: ToolPart = {
            ...tool('bg-shell', 'shell'),
            state: { status: 'completed', input: {}, output: '', metadata: { status: 'running', shellID: 'sh1' }, time: { start: 1, end: 2 } },
        };
        const backgroundAgent: ToolPart = {
            ...tool('bg-agent', 'subagent'),
            state: { status: 'completed', input: {}, output: '', metadata: { status: 'running', sessionID: 'child' }, time: { start: 1, end: 2 } },
        };
        expect(isGroupableTool(backgroundShell)).toBe(false);
        expect(isGroupableTool(backgroundAgent)).toBe(false);
        const runningBackground = runningBackgroundToolIds(
            [backgroundShell, backgroundAgent],
            new Map([['sh1', {}]]),
            new Set(['child']),
        );
        const plan = planToolActivity([tool('a'), tool('c'), backgroundShell, backgroundAgent, tool('b'), tool('d')], false, false, undefined, runningBackground);
        expect(plan.get('a')?.parts.map((part) => part.id)).toEqual(['a', 'c']);
        expect(plan.get('b')?.parts.map((part) => part.id)).toEqual(['b', 'd']);
        expect(plan.has('bg-shell')).toBe(false);
        expect(plan.has('bg-agent')).toBe(false);
        // Once both jobs end, the calls join the run around them.
        const finished = planToolActivity([tool('a'), tool('c'), backgroundShell, backgroundAgent, tool('b'), tool('d')], false, false, undefined, new Set());
        expect(finished.get('a')?.parts.map((part) => part.id)).toEqual(['a', 'c', 'bg-shell', 'bg-agent', 'b', 'd']);
    });

    test('picks the plural form a locale uses', () => {
        expect(toolActivityPluralCategory('en', 4)).toBe('other');
        expect(toolActivityPluralCategory('pl', 2)).toBe('few');
        expect(toolActivityPluralCategory('pl', 5)).toBe('many');
        expect(toolActivityPluralCategory('pl', 12)).toBe('many');
        expect(toolActivityPluralCategory('uk', 3)).toBe('few');
        expect(toolActivityPluralCategory('uk', 11)).toBe('many');
    });

    test('leaves a single finished call as a direct row, also before a running call', () => {
        const done = tool('done');
        const running: ToolPart = { ...tool('running'), state: { status: 'running', input: {}, time: { start: 1 } } };
        expect(planToolActivity([done, running], false).size).toBe(0);
        expect(planToolActivity([text, done, running], false).size).toBe(0);
        expect(planToolActivity([done, tool('second')], false).get('done')?.parts).toHaveLength(2);
    });

    test('keeps different completed and failed tools in one group', () => {
        const failed: ToolPart = { ...tool('patch', 'patch'), state: { status: 'error', input: {}, error: 'failed', time: { start: 1, end: 2 } } };
        const parts = [tool('fetch', 'webfetch'), failed, tool('edit', 'edit'), tool('shell', 'shell'), tool('other', 'openchamber')];
        const plan = planToolActivity(parts, false);
        expect(plan.get('fetch')?.parts.map((part) => part.tool)).toEqual(['webfetch', 'patch', 'edit', 'shell', 'openchamber']);
        expect(plan.get('patch')?.first).toBe(false);
        expect(plan.get('other')?.parts).toHaveLength(5);
    });

    test('groups completed subagents while keeping a running subagent visible', () => {
        const done1 = tool('agent1', 'subagent');
        const done2 = tool('agent2', 'subagent');
        const running: ToolPart = { ...tool('agent3', 'subagent'), state: { status: 'running', input: {}, time: { start: 1 } } };
        const plan = planToolActivity([done1, done2, running], false);
        expect(plan.get('agent1')?.parts.map((part) => part.id)).toEqual(['agent1', 'agent2']);
        expect(plan.has('agent3')).toBe(false);
    });

    test('marks groups at a window boundary as partial', () => {
        expect(planToolActivity([tool('a'), tool('b')], true).get('a')?.partial).toBe(true);
        expect(planToolActivity([tool('a'), tool('b')], false, true).get('a')?.partial).toBe(true);
        expect(planToolActivity([text, tool('a'), tool('b')], true).get('a')?.partial).toBe(false);
    });

    test('flattens a turn in order and drops parts that draw no row', () => {
        const invisible: Part = { id: 'hidden', type: 'reasoning', text: '', sessionID: 's', messageID: 'b', time: { start: 1, end: 2 } };
        const emptyText: Part = { id: 'empty', type: 'text', text: '   ', sessionID: 's', messageID: 'b' };
        const parts = toolActivityParts([
            message('a', [text, tool('a')]),
            message('b', [invisible, emptyText, tool('b')]),
        ], true);
        expect(parts.map((part) => part.id)).toEqual(['text', 'a', 'b']);
        // With reasoning hidden, a visible reasoning block stops breaking a run.
        const reasoning: Part = { id: 'r', type: 'reasoning', text: 'Thinking', sessionID: 's', messageID: 'c', time: { start: 1, end: 2 } };
        const hidden = toolActivityParts([message('c', [tool('a'), reasoning, tool('b')])], false);
        expect(planToolActivity(hidden, false).get('a')?.parts.map((part) => part.id)).toEqual(['a', 'b']);
    });
});

describe('live tool tail', () => {
    test('keeps a completed call visible until a new call arrives or the turn ends', () => {
        const first = tool('first');
        const running: ToolPart = { ...tool('current'), state: { status: 'running', input: {}, time: { start: 3 } } };
        let tail: Parameters<typeof advanceLiveToolTail>[0] = { turnId: 'turn', ids: [], visible: new Set() };
        tail = advanceLiveToolTail(tail, 'turn', [first, running], true);
        expect([...tail.visible]).toEqual(['current']);
        const completed = tool('current');
        tail = advanceLiveToolTail(tail, 'turn', [first, completed], true);
        expect([...tail.visible]).toEqual(['current']);
        // The lone finished call stays direct: no group header for one row.
        expect(planToolActivity([first, completed], false, false, tail.visible).size).toBe(0);
        const next: ToolPart = { ...tool('next'), state: { status: 'running', input: {}, time: { start: 4 } } };
        tail = advanceLiveToolTail(tail, 'turn', [first, completed, next], true);
        expect([...tail.visible]).toEqual(['next']);
        expect(planToolActivity([first, completed, next], false, false, tail.visible).get('first')?.parts.map((part) => part.id)).toEqual(['first', 'current']);
        tail = advanceLiveToolTail(tail, 'turn', [first, completed, next], false);
        expect(tail.visible.size).toBe(0);
    });

    test('keeps parallel calls in place as each finishes and folds at most one per new call', () => {
        const running = (id: string): ToolPart => ({ ...tool(id), state: { status: 'running', input: {}, time: { start: 1 } } });
        let tail: Parameters<typeof advanceLiveToolTail>[0] = { turnId: 'turn', ids: [], visible: new Set() };
        tail = advanceLiveToolTail(tail, 'turn', [running('a'), running('b')], true);
        tail = advanceLiveToolTail(tail, 'turn', [tool('a'), running('b')], true);
        expect([...tail.visible]).toEqual(['a', 'b']);
        tail = advanceLiveToolTail(tail, 'turn', [tool('a'), tool('b')], true);
        expect([...tail.visible]).toEqual(['a', 'b']);
        tail = advanceLiveToolTail(tail, 'turn', [tool('a'), tool('b'), running('c')], true);
        expect([...tail.visible]).toEqual(['b', 'c']);
    });

    test('does not fold past an earlier running call and resets at text and turn boundaries', () => {
        const running: ToolPart = { ...tool('a'), state: { status: 'running', input: {}, time: { start: 1 } } };
        let tail: Parameters<typeof advanceLiveToolTail>[0] = { turnId: 'turn', ids: [], visible: new Set() };
        tail = advanceLiveToolTail(tail, 'turn', [running, tool('b')], true);
        tail = advanceLiveToolTail(tail, 'turn', [running, tool('b'), tool('c')], true);
        expect([...tail.visible]).toEqual(['a', 'b', 'c']);
        tail = advanceLiveToolTail(tail, 'turn', [running, tool('b'), tool('c'), text], true);
        expect(tail.visible.size).toBe(0);
        tail = advanceLiveToolTail(tail, 'other', [tool('x')], true);
        expect([...tail.visible]).toEqual(['x']);
    });
});
