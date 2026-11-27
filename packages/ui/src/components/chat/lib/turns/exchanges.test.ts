import { describe, expect, test } from 'bun:test';

import type { AssistantMessage, Message, Part } from '@/lib/opencode/model';
import { unwrapBackgroundResult } from '@/lib/opencode/background-result';
import { keepCommandSubagentReports } from '@/lib/opencode/subagent-run';
import { shellCommandOf } from '../../message/shellCommandOf';
import { planExchanges } from './exchanges';
import { projectTurnRecords } from './projectTurnRecords';
import type { TimelineEntry } from './timelineEntries';
import { buildTimelineRows, type TimelineRowsOptions } from './timelineRows';
import type { ChatMessageEntry } from './types';

let clock = 0;
const text = (id: string, value: string): Part => ({ type: 'text', id: `${id}-text`, text: value, sessionID: 's', messageID: id });
const user = (id: string, from?: string): ChatMessageEntry => {
    const info: Message = { id, sessionID: 's', role: 'user', time: { created: ++clock } };
    if (from) info.metadata = { openchamber: { promptedBy: { sessionID: from, title: 'Lead' } } };
    return { info, parts: [text(id, 'Do it')] };
};
const report = (id: string, source: 'openchamber-session' | 'subagent' = 'openchamber-session'): ChatMessageEntry => ({
    info: {
        id, sessionID: 's', role: 'synthetic', time: { created: ++clock }, text: 'done', description: 'Review',
        metadata: source === 'subagent' ? { source, childID: 'child', state: 'completed' } : { source, sessionID: 'other', state: 'completed', title: 'Other' },
    },
    parts: [],
});
const answer = (id: string, finish: AssistantMessage['finish'] = 'stop', parts: Part[] = [text(id, `Answer ${id}`)]): ChatMessageEntry => ({
    info: {
        id, sessionID: 's', role: 'assistant', time: { created: ++clock, completed: ++clock }, modelID: 'm', providerID: 'p', agent: 'build',
        cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, finish,
    },
    parts,
});
const idle = (id: string): ChatMessageEntry => {
    const info: Message = { id, sessionID: 's', role: 'idle', time: { created: ++clock }, outcome: 'succeeded' };
    return { info, parts: [] };
};
const entriesOf = (messages: ChatMessageEntry[]): TimelineEntry[] => {
    const { turns } = projectTurnRecords(messages);
    return turns.map((turn, index) => ({ kind: 'turn', key: `turn:${turn.turnId}`, turn, isLastTurn: index === turns.length - 1 }));
};
const supersededIds = (messages: ChatMessageEntry[]) => [...planExchanges(entriesOf(messages), false).superseded.keys()];

describe('which replies a newer one replaces', () => {
    test('only the newest finished answer of an exchange stays, the direct answer included', () => {
        expect(supersededIds([user('u'), answer('a1'), report('r1'), answer('a2'), report('r2'), answer('a3')])).toEqual(['u', 'r1']);
    });

    test('a reply still being written, stopped or failed replaces nothing', () => {
        expect(supersededIds([user('u'), answer('a1'), report('r1'), answer('a2', 'tool-calls')])).toEqual([]);
        expect(supersededIds([user('u'), answer('a1'), report('r1'), answer('a2', 'error', [])])).toEqual([]);
    });

    test('what the user writes next starts its own exchange', () => {
        expect(supersededIds([user('u1'), answer('a1'), user('u2'), answer('a2')])).toEqual([]);
    });

    test('a prompt of another session stays in the exchange it interrupts', () => {
        const messages = [user('u'), answer('a1'), user('sync', 'ses_lead'), answer('a2')];
        const plan = planExchanges(entriesOf(messages), false);
        expect([...plan.superseded.keys()]).toEqual(['u']);
        expect([...plan.sessionPrompts]).toEqual(['sync']);
        expect(planExchanges(entriesOf(messages), true).superseded.size).toBe(0);
    });

    test('a reply that asks with a UI block stays in view', () => {
        const ask = answer('a1', 'stop', [text('a1', '```openui-lang\nroot = Stack([])\n```')]);
        expect(supersededIds([user('u'), ask, report('r1'), answer('a2')])).toEqual([]);
    });
});

describe('rows of replaced replies', () => {
    const options = (messages: ChatMessageEntry[], expanded: string[] = [], unreadSince?: number): [TimelineEntry[], TimelineRowsOptions] => {
        const entries = entriesOf(messages);
        const plan = planExchanges(entries, false);
        return [entries, {
            collapsedActivity: false, showReasoningTraces: true, expandedTurns: new Map(expanded.map((key) => [key, true])),
            superseded: { plan, folded: new Set(plan.superseded.keys()), unreadSince },
        }];
    };
    const keys = (messages: ChatMessageEntry[], expanded: string[] = []) => buildTimelineRows(...options(messages, expanded), []).map((row) => row.key);

    test('a line stands for the reply, below the prompt it answers', () => {
        const messages = [user('u'), answer('a1'), report('r1'), answer('a2'), report('r2'), answer('a3')];
        expect(keys(messages)).toEqual(['turn:u', 'line:u', 'line:r1', 'turn:r2', 'step:a3']);
        expect(keys(messages, ['line:r1'])).toEqual(['turn:u', 'line:u', 'line:r1', 'turn:r1', 'step:a2', 'turn:r2', 'step:a3']);
    });

    test('what the user replied in the digest stays above the lines it opened', () => {
        const reply: ChatMessageEntry = { info: {
            id: 'reply', sessionID: 's', role: 'synthetic', time: { created: ++clock }, text: 'The user replied',
            metadata: { openchamberLeadAnswer: { answers: [{ question: 'Remove?', answer: 'Yes' }], suggestions: [] } },
        }, parts: [] };
        expect(keys([user('u'), answer('a1'), reply, answer('a2'), report('r'), answer('a3')]))
            .toEqual(['turn:u', 'step:a1', 'turn:reply', 'line:reply', 'turn:r', 'step:a3']);
    });

    test('of failures in a row only the last stays whole, below the answer they did not replace', () => {
        const failure = (id: string) => {
            const entry = answer(id, 'error', []);
            if (entry.info.role === 'assistant') entry.info.error = { type: 'unknown', message: 'Not logged in' };
            return entry;
        };
        expect(keys([user('u'), answer('a1'), report('r1'), failure('e1'), report('r2'), failure('e2')]))
            .toEqual(['turn:u', 'step:a1', 'line:r1', 'turn:r2', 'step:e2']);
        expect(keys([user('u'), failure('e1'), report('r'), failure('e2')])).toEqual(['turn:u', 'line:u', 'turn:r', 'step:e2']);
        const rows = buildTimelineRows(...options([user('u'), failure('e1'), report('r'), failure('e2')], [], 0), []);
        expect(rows.some((row) => row.kind === 'turn-line' && row.unread)).toBe(true);
    });

    test('lines older than the newest seven go under one line', () => {
        const messages = [user('u'), answer('a0')];
        for (let index = 1; index <= 10; index += 1) messages.push(report(`r${index}`), answer(`a${index}`));
        expect(keys(messages).slice(0, 4)).toEqual(['turn:u', 'earlier:u', 'line:r3', 'line:r4']);
        expect(keys(messages, ['earlier:u']).slice(0, 4)).toEqual(['turn:u', 'earlier:u', 'line:u', 'line:r1']);
    });

    test('a line is unread when its answer came after the last visit', () => {
        const messages = [user('u'), answer('a1'), report('r1'), answer('a2'), report('r2'), answer('a3')];
        const seen = messages[2].info.time.created;
        const rows = buildTimelineRows(...options(messages, [], seen), []);
        expect(rows.flatMap((row) => (row.kind === 'turn-line' ? [[row.key, row.unread]] : []))).toEqual([['line:u', false], ['line:r1', true]]);
    });
});

test('a closed group leaves no gap in its message and hides its calls, also when the turn failed on them', () => {
    const read = (id: string, messageID: string): Part => ({
        type: 'tool', tool: 'read', id, callID: id, sessionID: 's', messageID,
        state: { status: 'completed', input: {}, output: '', metadata: {}, time: { start: 1, end: 2 } },
    });
    const build = (messages: ChatMessageEntry[]) => buildTimelineRows(entriesOf(messages), {
        collapsedActivity: false, groupedActivity: true, showReasoningTraces: true, expandedTurns: new Map(),
    }, []);
    const mixed = build([user('u'), answer('a', 'stop', [text('first', 'Before'), read('r1', 'a'), read('r2', 'a'), text('last', 'After')])]);
    expect(mixed.map((row) => row.key)).toEqual(['turn:u', 'step:a', 'group:r1', 'step:a:last-text:0']);
    expect(mixed.flatMap((row) => (row.kind === 'turn-message' && row.slice ? [`${row.slice.index}/${row.slice.count}`] : []))).toEqual(['0/2', '1/2']);

    const failed = answer('a', 'error', [read('r1', 'a'), read('r2', 'a')]);
    if (failed.info.role === 'assistant') failed.info.error = { type: 'unknown', message: 'Stopped' };
    const end = build([user('u'), failed]).at(-1);
    expect(end?.kind === 'turn-message' && end.slice?.from?.partId).toBe('after-last-part');
});

test('a command with a redirect stays out of the output of its report', () => {
    expect(unwrapBackgroundResult('<background-result kind="shell" state="completed" command="ls > out.txt; echo hi">\nhi\n</background-result>', 'shell')).toBe('hi');
});

test('names the whole command of a background shell, quotes included', () => {
    const info: Message = {
        id: 'r', sessionID: 's', role: 'synthetic', time: { created: 1 },
        text: '<background-result kind="shell" id="sh" state="completed" command="printf "%s\\n" hi > out.txt">\nhi\n</background-result>',
    };
    expect(shellCommandOf(info)).toBe('printf "%s\\n" hi > out.txt');
});

test('a subagent report that wakes the agent opens its turn, so waiting is not part of it; one it picks up on the way stays with its call', () => {
    const call: Part = {
        type: 'tool', tool: 'subagent', id: 'call', callID: 'call', sessionID: 's', messageID: 'a1',
        state: { status: 'completed', input: {}, output: '', metadata: { sessionID: 'child', status: 'running' }, time: { start: 1, end: 2 } },
    };
    const started = answer('a1', 'stop', [call, text('a1', 'Reviewing')]);
    const wake = report('r', 'subagent');
    const kept = keepCommandSubagentReports([user('u'), started, idle('i'), wake, answer('a2')], () => undefined);
    const { turns } = projectTurnRecords(kept);
    expect(turns.map((turn) => turn.turnId)).toEqual(['u', 'r']);
    expect(turns[1].startedAt).toBe(wake.info.time.created);

    const onTheWay = [user('u'), answer('a1', 'tool-calls', [call]), report('r', 'subagent'), answer('a2')];
    expect(projectTurnRecords(keepCommandSubagentReports(onTheWay, () => undefined)).turns).toHaveLength(1);
});
