import { beforeEach, describe, expect, test } from 'bun:test';
import type { OpenCodeEvent } from '@opencode/client';
import { translateWireEvent } from '@/lib/opencode/events';
import {
  SESSION_LIVE_WORK_MAX,
  applySessionLiveWorkEvents,
  currentLiveTool,
  resetSessionLiveWork,
  seedSessionContextFromHost,
  sessionContextRevision,
  useSessionLiveWorkStore,
} from './session-live-work';

// Events as OpenCode publishes them, through the same translation the app runs.
const base = { id: 'evt_1', created: 1000, location: { directory: '/repo' } };
const durable = { aggregateID: 'ses_1', seq: 1, version: 1 as const };
const apply = (...events: OpenCodeEvent[]) => applySessionLiveWorkEvents(events.flatMap(translateWireEvent));

const toolStarted = (sessionID: string, id: string, name: string): OpenCodeEvent => ({
  ...base, type: 'session.tool.input.started', durable, data: { sessionID, assistantMessageID: 'msg_a', id, name },
});
const toolCalled = (sessionID: string, id: string, input: Record<string, string>): OpenCodeEvent => ({
  ...base, type: 'session.tool.called', durable, data: { sessionID, assistantMessageID: 'msg_a', id, input, executed: true },
});
const toolSucceeded = (sessionID: string, id: string): OpenCodeEvent => ({
  ...base, type: 'session.tool.success', durable: { ...durable, version: 2 }, data: { sessionID, assistantMessageID: 'msg_a', id, content: [{ type: 'text', text: 'done' }], executed: true },
});
const stepEnded = (sessionID: string, tokens: { total?: number; input: number; output: number }): OpenCodeEvent => ({
  ...base, type: 'session.step.ended', durable,
  data: { sessionID, assistantMessageID: 'msg_a', finish: 'stop', cost: 0, tokens: { ...tokens, reasoning: 0, cache: { read: 0, write: 0 } } },
});
const compacted = (sessionID: string): OpenCodeEvent => ({
  ...base, type: 'session.compaction.ended', durable, data: { sessionID, reason: 'auto', text: 'summary' },
});

const tool = (sessionID: string) => currentLiveTool(useSessionLiveWorkStore.getState().tools.get(sessionID));
const context = () => useSessionLiveWorkStore.getState().context;

beforeEach(() => resetSessionLiveWork());

describe('session live work', () => {
  test('follows a tool call from its start through its input to its end, and keeps it while the agent thinks', () => {
    apply(toolStarted('ses_1', 'c1', 'edit'));
    expect(tool('ses_1')).toEqual({ partID: 'c1', name: 'edit', path: null });
    apply(toolCalled('ses_1', 'c1', { path: '/repo/src/layout.ts', oldString: 'a' }));
    expect(tool('ses_1')?.path).toBe('/repo/src/layout.ts');
    apply(toolSucceeded('ses_1', 'c1'));
    expect(tool('ses_1')).toEqual({ partID: 'c1', name: 'edit', path: '/repo/src/layout.ts' });
    applySessionLiveWorkEvents([{ type: 'session.idle', properties: { sessionID: 'ses_1' } }]);
    expect(tool('ses_1')).toBeUndefined();
  });

  test('a call that starts, takes its input and ends in one batch still names its file', () => {
    const inputEnded: OpenCodeEvent = {
      ...base, type: 'session.tool.input.ended', durable, data: { sessionID: 'ses_1', assistantMessageID: 'msg_a', id: 'c1', text: '{"filePath":"/repo/notes.txt"}' },
    };
    applySessionLiveWorkEvents([toolStarted('ses_1', 'c1', 'read'), inputEnded, toolSucceeded('ses_1', 'c1')].flatMap(translateWireEvent));
    expect(tool('ses_1')).toEqual({ partID: 'c1', name: 'read', path: '/repo/notes.txt' });
  });

  test('reads the path from the input while the agent still writes it', () => {
    const delta = (id: string, text: string): OpenCodeEvent => ({
      ...base, type: 'session.tool.input.delta', data: { sessionID: 'ses_1', assistantMessageID: 'msg_a', id, delta: text },
    });
    apply(toolStarted('ses_1', 'c1', 'edit'), delta('c1', '{"filePath": "/repo/src/la'));
    expect(tool('ses_1')?.path).toBeNull();
    apply(delta('c1', 'yout.ts", "oldString": "a'));
    expect(tool('ses_1')?.path).toBe('/repo/src/layout.ts');
    // A long input that names no path up front gives up instead of growing.
    apply(toolStarted('ses_1', 'c2', 'edit'), delta('c2', `{"content": "${'x'.repeat(5000)}`), delta('c2', '", "path": "late.ts"}'));
    expect(tool('ses_1')?.path).toBeNull();
  });

  test('keeps a shell command out: only a path the call names', () => {
    apply(toolStarted('ses_1', 'c1', 'bash'), toolCalled('ses_1', 'c1', { command: 'TOKEN=secret deploy' }));
    expect(tool('ses_1')).toEqual({ partID: 'c1', name: 'bash', path: null });
  });

  test('parallel calls: the newest shows, and a faster one ending leaves the slower one', () => {
    apply(toolStarted('ses_1', 'slow', 'read'), toolStarted('ses_1', 'fast', 'glob'));
    expect(tool('ses_1')?.name).toBe('glob');
    apply(toolSucceeded('ses_1', 'fast'));
    expect(tool('ses_1')?.name).toBe('read');
    apply(toolSucceeded('ses_1', 'slow'));
    expect(tool('ses_1')?.name).toBe('read');
  });

  test('a new turn or a reconnect forgets calls whose end never came', () => {
    apply(toolStarted('ses_1', 'c1', 'read'), toolSucceeded('ses_1', 'c1'), toolStarted('ses_2', 'c2', 'grep'));
    // ses_1's idle fell into a gap; its next turn starts with the user's message.
    applySessionLiveWorkEvents([{ type: 'message.updated', properties: { info: { id: 'msg_u', sessionID: 'ses_1', role: 'user', time: { created: 2 } } } }]);
    expect(tool('ses_1')).toBeUndefined();
    expect(tool('ses_2')?.name).toBe('grep');
    applySessionLiveWorkEvents([{ type: 'server.connected', properties: {} }]);
    expect(useSessionLiveWorkStore.getState().tools.size).toBe(0);
  });

  test('going idle or failing clears calls whose end never came', () => {
    apply(toolStarted('ses_1', 'c1', 'read'), toolStarted('ses_2', 'c2', 'read'));
    applySessionLiveWorkEvents([
      { type: 'session.idle', properties: { sessionID: 'ses_1' } },
      { type: 'session.status', properties: { sessionID: 'ses_2', status: { type: 'idle' } } },
    ]);
    expect(useSessionLiveWorkStore.getState().tools.size).toBe(0);
  });

  test('reads the window from the step total, falls back to the breakdown, and forgets it on compaction', () => {
    apply(stepEnded('ses_1', { total: 52_000, input: 400_000, output: 900 }));
    expect(context().get('ses_1')).toEqual({ state: 'measured', tokens: 52_000 });
    apply(stepEnded('ses_2', { input: 1000, output: 200 }));
    expect(context().get('ses_2')).toEqual({ state: 'measured', tokens: 1200 });
    apply(compacted('ses_1'));
    expect(context().get('ses_1')).toEqual({ state: 'compacted' });
    apply(stepEnded('ses_1', { total: 9000, input: 0, output: 0 }));
    expect(context().get('ses_1')).toEqual({ state: 'measured', tokens: 9000 });
  });

  test('a step without tokens or a repeated reading publishes nothing', () => {
    apply(stepEnded('ses_1', { total: 500, input: 0, output: 0 }));
    const before = useSessionLiveWorkStore.getState();
    apply(stepEnded('ses_1', { total: 500, input: 0, output: 0 }), stepEnded('ses_1', { input: 0, output: 0 }));
    expect(useSessionLiveWorkStore.getState()).toBe(before);
  });

  test('the host reading wins unless a live one arrived after the request began', () => {
    apply(stepEnded('ses_1', { total: 700, input: 0, output: 0 }), stepEnded('ses_2', { total: 800, input: 0, output: 0 }));
    const since = sessionContextRevision();
    // While the request is out, ses_2 reports a newer step.
    apply(stepEnded('ses_2', { total: 900, input: 0, output: 0 }));
    seedSessionContextFromHost(new Map([
      // ses_1 was compacted while this client's stream was down.
      ['ses_1', { state: 'compacted' }],
      ['ses_2', { state: 'measured', tokens: 800 }],
      ['ses_3', { state: 'measured', tokens: 300 }],
    ]), since);
    expect(context().get('ses_1')).toEqual({ state: 'compacted' });
    expect(context().get('ses_2')).toEqual({ state: 'measured', tokens: 900 });
    expect(context().get('ses_3')).toEqual({ state: 'measured', tokens: 300 });
  });

  test('a deleted session leaves both maps, and the maps stay bounded', () => {
    apply(toolStarted('ses_1', 'c1', 'read'), stepEnded('ses_1', { total: 5, input: 0, output: 0 }));
    applySessionLiveWorkEvents([{ type: 'session.deleted', properties: { sessionID: 'ses_1' } }]);
    expect(useSessionLiveWorkStore.getState().tools.size + context().size).toBe(0);
    apply(...Array.from({ length: SESSION_LIVE_WORK_MAX + 5 }, (_, i) => stepEnded(`s${i}`, { total: i + 1, input: 0, output: 0 })));
    expect(context().size).toBe(SESSION_LIVE_WORK_MAX);
    expect(context().has('s0')).toBe(false);
  });
});
