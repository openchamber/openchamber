import { describe, expect, test } from 'bun:test';

import type { AssistantMessage, Message, Part, Session, SessionStatus, SyntheticMessage, ToolPart, UserMessage } from '@/lib/opencode/model';

import { selectRunningSubagentRuns, withRunningSubagentRuns } from './runningSubagentRuns';
import type { ChatMessageEntry } from './turns/types';

const PARENT = 'ses_parent';

const session = (id: string, created: number, parentID: string | undefined = PARENT): Session => ({
    id,
    parentID,
    projectID: 'proj',
    directory: '/repo',
    title: `run ${id}`,
    agent: 'general',
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created, updated: created },
});

const assistant = (id: string, created: number): AssistantMessage => ({
    id,
    sessionID: PARENT,
    role: 'assistant',
    agent: 'build',
    providerID: 'openai',
    modelID: 'gpt-5',
    time: { created },
});

const subagentCall = (messageID: string, state: ToolPart['state']): ToolPart => ({
    id: `${messageID}:call`,
    sessionID: PARENT,
    messageID,
    type: 'tool',
    callID: 'call_1',
    tool: 'subagent',
    state,
});

const report = (childID: string): SyntheticMessage => ({
    id: `msg_report_${childID}`,
    sessionID: PARENT,
    role: 'synthetic',
    time: { created: 50 },
    text: 'done',
    metadata: { source: 'subagent', childID, state: 'completed' },
});

const BUSY: SessionStatus = { type: 'busy' };

const state = (input: {
    sessions: Session[];
    busy: string[];
    messages?: Message[];
    parts?: Record<string, Part[]>;
}) => ({
    session: input.sessions,
    session_status: Object.fromEntries(input.busy.map((id) => [id, BUSY])),
    message: { [PARENT]: input.messages ?? [] },
    part: input.parts ?? {},
});

describe('selectRunningSubagentRuns', () => {
    test('shows a busy child the transcript does not account for', () => {
        const runs = selectRunningSubagentRuns(state({ sessions: [session('ses_child', 10)], busy: ['ses_child'] }), PARENT);

        expect(runs.map((run) => run.metadata?.childID)).toEqual(['ses_child']);
        expect(runs[0]?.time.created).toBe(10);
    });

    test('ignores idle children and children of other sessions', () => {
        const runs = selectRunningSubagentRuns(state({
            sessions: [session('ses_idle', 10), session('ses_other', 10, 'ses_elsewhere')],
            busy: ['ses_other'],
        }), PARENT);

        expect(runs).toHaveLength(0);
    });

    test('leaves children to the tool call or report that already shows them', () => {
        const call = assistant('msg_a', 5);
        const runs = selectRunningSubagentRuns(state({
            sessions: [session('ses_tool', 10), session('ses_reported', 10)],
            busy: ['ses_tool', 'ses_reported'],
            messages: [call, report('ses_reported')],
            parts: {
                msg_a: [subagentCall('msg_a', {
                    status: 'running',
                    input: { agent: 'general' },
                    metadata: { sessionID: 'ses_tool' },
                    time: { start: 6 },
                })],
            },
        }), PARENT);

        expect(runs).toHaveLength(0);
    });

    test('does not claim a child a running tool call may still be joined to', () => {
        const call = assistant('msg_a', 5);
        const runs = selectRunningSubagentRuns(state({
            sessions: [session('ses_before', 3), session('ses_after', 10)],
            busy: ['ses_before', 'ses_after'],
            messages: [call],
            parts: {
                msg_a: [subagentCall('msg_a', { status: 'running', input: { agent: 'general' }, time: { start: 6 } })],
            },
        }), PARENT);

        expect(runs.map((run) => run.metadata?.childID)).toEqual(['ses_before']);
    });
});

describe('withRunningSubagentRuns', () => {
    const user = (id: string, created: number): ChatMessageEntry => {
        const info: UserMessage = { id, sessionID: PARENT, role: 'user', time: { created } };
        return { info, parts: [] };
    };

    test('places a run where its child session started and keeps its entry stable', () => {
        const messages = [user('u1', 1), user('u2', 20)];
        const runs = selectRunningSubagentRuns(state({ sessions: [session('ses_child', 10)], busy: ['ses_child'] }), PARENT);

        const first = withRunningSubagentRuns(messages, runs);
        const second = withRunningSubagentRuns(messages, runs);

        expect(first.map((entry) => entry.info.id)).toEqual(['u1', 'subagent-run:ses_child', 'u2']);
        expect(second[1]).toBe(first[1]!);
    });

    test('returns the timeline untouched without runs', () => {
        const messages = [user('u1', 1)];
        expect(withRunningSubagentRuns(messages, [])).toBe(messages);
    });
});
