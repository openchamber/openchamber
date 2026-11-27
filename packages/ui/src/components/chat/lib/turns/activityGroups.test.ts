import { expect, test } from 'bun:test';

import type { Part, ToolPart } from '@/lib/opencode/model';
import { countActivityGroup, segmentActivity } from './activityGroups';
import type { ChatMessageEntry } from './types';

let next = 0;
const tool = (name: string, metadata: ToolPart['state'] extends infer S ? S extends { metadata?: infer M } ? M : never : never = {}): Part => {
    const id = `${name}-${next++}`;
    return {
        type: 'tool', tool: name, id, callID: id, sessionID: 's', messageID: 'm',
        state: { status: 'completed', input: {}, output: '', metadata, time: { start: 1, end: 2 } },
    };
};
const text = (value: string): Part => ({ type: 'text', id: `text-${next++}`, text: value, sessionID: 's', messageID: 'm' });
const reads = (count: number) => Array.from({ length: count }, () => tool('read'));
const step = (parts: Part[]): ChatMessageEntry => ({
    info: {
        id: `m-${next++}`, sessionID: 's', role: 'assistant', time: { created: 1 }, modelID: 'm', providerID: 'p', agent: 'build',
        cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts,
});
const lines = (parts: Part[], live = false) => segmentActivity(parts.map((part) => step([part])), false, live)
    .map((segment) => `${segment.phase ?? 'alone'}:${segment.parts.length}`);

test('a long turn reads as its phases, across steps', () => {
    expect(lines([...reads(12), tool('shell'), tool('edit'), tool('edit'), tool('shell'), tool('shell')]))
        .toEqual(['explore:12', 'run:1', 'edit:2', 'run:2']);
});

test('a few look-ups between edits belong to the edits, many are a phase of their own', () => {
    expect(lines([tool('edit'), ...reads(4), tool('edit')])).toEqual(['edit:6']);
    expect(lines([tool('edit'), ...reads(6), tool('edit')])).toEqual(['edit:1', 'explore:6', 'edit:1']);
});

test('look-ups after the last work join it once the turn ends', () => {
    const parts = [tool('edit'), tool('shell'), ...reads(2)];
    expect(lines(parts, true)).toEqual(['edit:1', 'run:1', 'explore:2']);
    expect(lines(parts)).toEqual(['edit:1', 'run:3']);
});

test('notes, subagents, questions and background commands stand alone and split the work around them', () => {
    expect(lines([...reads(2), text('Found it'), ...reads(2), tool('subagent'), tool('shell', { status: 'running', shellID: 'sh_1' }), ...reads(2)]))
        .toEqual(['explore:2', 'alone:1', 'explore:2', 'alone:1', 'alone:1', 'explore:2']);
});

test('a call of no phase goes with the work around it', () => {
    expect(lines([tool('execute'), ...reads(3), tool('todowrite'), ...reads(3)])).toEqual(['explore:8']);
});

test('sums calls up by kind: anything that acts is a command, notes and questions are not counted', () => {
    const failedCall = tool('shell');
    if (failedCall.type === 'tool') failedCall.state = { status: 'error', input: {}, error: 'Timed out', time: { start: 1, end: 2 } };
    expect(countActivityGroup([...reads(2), tool('grep'), tool('skill'), tool('shell', { exit: 1 }), failedCall, tool('linear_save_issue'), tool('execute'),
        tool('subagent'), tool('webfetch'), tool('todowrite'), tool('question'), tool('openchamber_memory')]))
        .toEqual({ commands: 4, subagents: 1, explored: true, searchedWeb: true });
    expect(countActivityGroup([tool('todowrite'), tool('question')])).toEqual({ commands: 0, subagents: 0, explored: false, searchedWeb: false });
    const script = (calls: string[]) => tool('execute', { toolCalls: calls.map((name) => ({ tool: name, status: 'completed' })) });
    expect(countActivityGroup([tool('opencode_session_rename'), script(['opencode.session.rename', 'openchamber_memory'])]).commands).toBe(0);
    expect(countActivityGroup([script(['opencode.session.rename', 'linear.save_issue'])]).commands).toBe(1);
});

test('a thought joins the work before it as soon as it appears, and stays there', () => {
    const thought = (): Part => ({ type: 'reasoning', id: `thought-${next++}`, text: 'Thinking', sessionID: 's', messageID: 'm', time: { start: 1, end: 2 } });
    const parts = [thought(), tool('shell'), tool('shell'), thought()];
    const phases = (all: Part[]) => segmentActivity(all.map((part) => step([part])), true, true).map((segment) => `${segment.phase ?? 'alone'}:${segment.parts.length}`);
    expect(phases(parts)).toEqual(['run:4']);
    expect(phases([...parts, tool('shell')])).toEqual(['run:5']);
    expect(phases([...parts, text('Done')])).toEqual(['run:4', 'alone:1']);
});

test('the group at the end of a running turn has its header from the first call', () => {
    const grouped = (parts: Part[], live: boolean) => segmentActivity(parts.map((part) => step([part])), false, live).map((segment) => segment.grouped);
    expect(grouped([tool('shell')], true)).toEqual([true]);
    expect(grouped([tool('shell')], false)).toEqual([false]);
    expect(grouped([tool('shell'), text('Done')], true)).toEqual([false, false]);
    expect(grouped([tool('subagent')], true)).toEqual([false]);
});
