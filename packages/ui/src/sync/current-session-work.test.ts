import { describe, expect, test } from 'bun:test';
import type { Message, Part, ToolPart } from '@/lib/opencode/model';
import { currentSubagentWaits } from './current-session-work';

const assistant: Message = {
  id: 'step', sessionID: 'root', role: 'assistant', agent: 'build', providerID: 'p', modelID: 'm',
  time: { created: 1, streamed: 2 },
};
const subagent = (id: string): ToolPart => ({
  id, callID: id, messageID: 'step', sessionID: 'root', type: 'tool', tool: 'subagent',
  state: { status: 'running', input: {}, metadata: { sessionID: id }, time: { start: 2 } },
});
const waits = (parts: Part[], messages: Message[] = [assistant]) => currentSubagentWaits({
  message: { root: messages }, part: { step: parts },
}, 'root');

describe('current foreground subagent dependencies', () => {
  test('names dependencies only when every unfinished call is a known foreground subagent', () => {
    expect(waits([subagent('a'), subagent('b')])).toEqual(['a', 'b']);
    expect(waits([subagent('a'), { ...subagent('read'), tool: 'read' }])).toEqual([]);
    expect(waits([subagent('a'), { ...subagent('unknown'), state: { status: 'running', input: {}, time: { start: 2 } } }])).toEqual([]);
    expect(waits([{ ...subagent('a'), state: { status: 'running', input: { background: true }, metadata: { sessionID: 'a' }, time: { start: 2 } } }])).toEqual([]);
  });

  test('background completions, other tools and continuing model output are independent work', () => {
    expect(waits([{ ...subagent('a'), state: { status: 'completed', input: {}, output: '', metadata: { sessionID: 'a', status: 'running' }, time: { start: 2, end: 3 } } }])).toEqual([]);
    expect(waits([{ ...subagent('a'), state: { status: 'pending', input: {}, raw: '' } }])).toEqual([]);
    expect(waits([subagent('a')], [{ ...assistant, time: { created: 1 } }])).toEqual([]);
    expect(waits([subagent('a'), { id: 'text', sessionID: 'root', messageID: 'step', type: 'text', text: '', time: { start: 1 } }])).toEqual([]);
    expect(waits([{ ...subagent('a'), tool: 'execute' }])).toEqual([]);
  });

  test('old, settled, failed, incomplete or absent snapshots never establish a wait', () => {
    expect(currentSubagentWaits(undefined, 'root')).toEqual([]);
    expect(waits([], [])).toEqual([]);
    expect(waits([subagent('a')], [{ ...assistant, time: { created: 1, streamed: 2, completed: 3 } }])).toEqual([]);
    expect(waits([subagent('a')], [{ ...assistant, error: { type: 'aborted', message: 'Stopped' } }])).toEqual([]);
    expect(waits([subagent('a')], [assistant, { id: 'new', sessionID: 'root', role: 'user', time: { created: 4 } }])).toEqual([]);
    expect(waits([subagent('a')], [assistant, { id: 'end', sessionID: 'root', role: 'idle', time: { created: 4 }, outcome: 'succeeded' }])).toEqual([]);
    expect(waits([subagent('a')], [assistant, { ...assistant, id: 'next', time: { created: 4 } }])).toEqual([]);
  });
});
