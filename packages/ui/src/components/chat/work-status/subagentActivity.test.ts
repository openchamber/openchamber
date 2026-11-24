import { describe, expect, test } from 'bun:test';

import type { AssistantMessage, Message, Part, ToolPart } from '@/lib/opencode/model';
import {
  decodeSubagentActivity,
  encodeSubagentActivity,
  readSubagentActivity,
  reportFirstLine,
  subagentAlertInputs,
} from './subagentActivity';

const step = (id: string, extra: Partial<AssistantMessage> = {}): AssistantMessage => ({
  id,
  sessionID: 'child',
  role: 'assistant',
  time: { created: 1_000 },
  agent: 'explore',
  providerID: 'p',
  modelID: 'm',
  ...extra,
});

const tool = (id: string, messageID: string, name: string, input: Record<string, string>, state: 'pending' | 'running' | 'completed'): ToolPart => ({
  id,
  sessionID: 'child',
  messageID,
  type: 'tool',
  callID: id,
  tool: name,
  state: state === 'pending'
    ? { status: 'pending', input, raw: '' }
    : state === 'running'
      ? { status: 'running', input, time: { start: 2_000 } }
      : { status: 'completed', input, output: '', time: { start: 2_000, end: 3_000 } },
});

describe('readSubagentActivity', () => {
  test('a tool in flight is the activity, from when it started', () => {
    const messages: Message[] = [step('s1')];
    const parts = { s1: [tool('t1', 's1', 'shell', { command: 'bun test relay\nmore' }, 'running')] } satisfies Record<string, Part[]>;
    expect(readSubagentActivity(messages, parts, { type: 'busy' })).toEqual({ kind: 'tool', tool: null, detail: 'bun test relay', since: 2_000 });
  });

  test('a long command or script keeps a short preview so the timer and agent still fit', () => {
    const messages: Message[] = [step('s1')];
    const shell = { s1: [tool('t1', 's1', 'shell', { command: 'b'.repeat(500) }, 'running')] } satisfies Record<string, Part[]>;
    expect(readSubagentActivity(messages, shell, { type: 'busy' })).toEqual({ kind: 'tool', tool: null, detail: 'b'.repeat(100), since: 2_000 });
    const script = { s1: [tool('t1', 's1', 'execute', { code: `${'y'.repeat(99)}😀 tail` }, 'running')] } satisfies Record<string, Part[]>;
    expect(readSubagentActivity(messages, script, { type: 'busy' })).toMatchObject({ kind: 'tool', detail: 'y'.repeat(99) });
  });

  test('a long running command is a tool, never a wait', () => {
    const messages: Message[] = [step('s1')];
    const parts = {
      s1: [
        tool('t0', 's1', 'read', { path: 'a.ts' }, 'completed'),
        tool('t1', 's1', 'shell', { command: 'sleep 600' }, 'running'),
      ],
    } satisfies Record<string, Part[]>;
    expect(readSubagentActivity(messages, parts, { type: 'busy' })?.kind).toBe('tool');
  });

  test('a report arriving while a tool runs leaves the tool as the activity', () => {
    const report: Message = { id: 'r1', sessionID: 'child', role: 'synthetic', time: { created: 5_000 }, text: '<subagent>done</subagent>' };
    const parts = { s1: [tool('t1', 's1', 'shell', { command: 'sleep 600' }, 'running')] } satisfies Record<string, Part[]>;
    expect(readSubagentActivity([step('s1'), report], parts, { type: 'busy' })?.kind).toBe('tool');
  });

  test('streaming reasoning or text is progress', () => {
    const messages: Message[] = [step('s1')];
    expect(readSubagentActivity(messages, {
      s1: [{ id: 'r', sessionID: 'child', messageID: 's1', type: 'reasoning', text: '…', time: { start: 1_500 } }],
    }, { type: 'busy' })).toEqual({ kind: 'thinking' });
    expect(readSubagentActivity(messages, {
      s1: [{ id: 'x', sessionID: 'child', messageID: 's1', type: 'text', text: '…', time: { start: 1_500 } }],
    }, { type: 'busy' })).toEqual({ kind: 'writing' });
  });

  test('between steps it waits since the last progress, and remembers the last call', () => {
    const messages: Message[] = [
      step('s1', { time: { created: 1_000, completed: 3_500 } }),
      step('s2', { time: { created: 4_000 } }),
    ];
    const parts = { s1: [tool('t1', 's1', 'read', { path: 'src/deep/SessionList.tsx' }, 'completed')], s2: [] } satisfies Record<string, Part[]>;
    expect(readSubagentActivity(messages, parts, { type: 'busy' })).toEqual({
      kind: 'waiting',
      since: 4_000,
      last: { tool: 'Read File', detail: 'SessionList.tsx' },
    });
  });

  test('a finished part moves the wait to its end', () => {
    const messages: Message[] = [step('s1', { time: { created: 1_000 } })];
    const parts = { s1: [tool('t1', 's1', 'grep', { pattern: 'evaluate' }, 'completed')] } satisfies Record<string, Part[]>;
    expect(readSubagentActivity(messages, parts, { type: 'busy' })).toEqual({
      kind: 'waiting',
      since: 3_000,
      last: { tool: 'Search Files', detail: 'evaluate' },
    });
  });

  test('a retry wins, from the session status or from the step it retries', () => {
    expect(readSubagentActivity([step('s1')], {}, { type: 'retry', attempt: 2, message: 'Rate limited', next: 9_000 }))
      .toEqual({ kind: 'retry', attempt: 2, at: 9_000, error: 'Rate limited' });
    const retried = step('s1', { retry: { attempt: 3, at: 8_000, error: { type: 'api', message: 'Overloaded' } } });
    expect(readSubagentActivity([retried], {}, { type: 'busy' }))
      .toEqual({ kind: 'retry', attempt: 3, at: 8_000, error: 'Overloaded' });
  });

  test('says nothing before any record arrived', () => {
    expect(readSubagentActivity(undefined, {}, { type: 'busy' })).toBeNull();
  });

  test('round-trips through its string form, which stays equal while nothing shown changes', () => {
    const messages: Message[] = [step('s1')];
    const before = { s1: [{ id: 'x', sessionID: 'child', messageID: 's1', type: 'text', text: 'a', time: { start: 1_500 } }] satisfies Part[] };
    const after = { s1: [{ id: 'x', sessionID: 'child', messageID: 's1', type: 'text', text: 'a longer text', time: { start: 1_500 } }] satisfies Part[] };
    const encoded = encodeSubagentActivity(readSubagentActivity(messages, before, { type: 'busy' }));
    expect(encodeSubagentActivity(readSubagentActivity(messages, after, { type: 'busy' }))).toBe(encoded);
    expect(decodeSubagentActivity(encoded)).toEqual({ kind: 'writing' });
  });
});

describe('subagentAlertInputs', () => {
  test('keeps only what can raise an alert, so a new tool call changes nothing', () => {
    const first = subagentAlertInputs({ kind: 'tool', tool: 'Read File', detail: 'a.ts', since: 1 });
    const second = subagentAlertInputs({ kind: 'tool', tool: 'Search Files', detail: 'x', since: 2 });
    expect(encodeSubagentActivity(first)).toBe(encodeSubagentActivity(second));
    expect(subagentAlertInputs({ kind: 'waiting', since: 5, last: { tool: 'Read File', detail: 'a.ts' } }))
      .toEqual({ kind: 'waiting', since: 5, last: null });
    expect(subagentAlertInputs({ kind: 'retry', attempt: 2, at: 9, error: null })?.kind).toBe('retry');
  });
});

describe('reportFirstLine', () => {
  test('takes the first line with text, without its markdown marks', () => {
    expect(reportFirstLine('\n## **Two ADRs** are stale\n\nmore')).toBe('Two ADRs are stale');
    expect(reportFirstLine('```ts\ncode\n```')).toBe('code');
    expect(reportFirstLine('- `0018` is stale')).toBe('0018 is stale');
    expect(reportFirstLine('   \n---\n')).toBeNull();
    expect(reportFirstLine('The command completed with output:\n\n```\ndone\n```')).toBe('The command completed with output: done');
  });
});
