import { describe, expect, test } from 'bun:test';
import { createPiHarnessState } from './state.js';
import { createPiEventAdapter } from './event-adapter.js';

describe('Pi-Harness event adapter', () => {
  test('maps text streaming events to OpenCode-like events', () => {
    const state = createPiHarnessState({ providerID: 'p', modelID: 'm' });
    state.upsertSession({ sessionId: 's1', workspaceDir: '/repo' });
    const emitted = [];
    state.subscribe((entry) => emitted.push(entry.payload));
    const adapter = createPiEventAdapter({ state });

    adapter.apply('s1', '/repo', { type: 'turn_start', id: 'turn1' });
    adapter.apply('s1', '/repo', { type: 'message_start', id: 'turn1' });
    adapter.apply('s1', '/repo', { type: 'message_update', id: 'turn1', text: 'hel' });
    adapter.apply('s1', '/repo', { type: 'message_update', id: 'turn1', text: 'lo' });
    adapter.apply('s1', '/repo', { type: 'message_end', id: 'turn1' });
    adapter.apply('s1', '/repo', { type: 'turn_end', id: 'turn1' });

    const types = emitted.map((event) => event.type);
    expect(types).toContain('session.status');
    expect(types).toContain('message.updated');
    expect(types).toContain('message.part.updated');
    expect(types).toContain('message.part.delta');
    expect(types).toContain('session.idle');
    const msgs = state.getMessages('s1');
    const last = msgs.find((m) => m.info.role === 'assistant');
    expect(last.parts[0].text).toBe('hello');
  });

  test('maps errors to visible error text and idle status', () => {
    const state = createPiHarnessState({ providerID: 'p', modelID: 'm' });
    state.upsertSession({ sessionId: 's1', workspaceDir: '/repo' });
    const emitted = [];
    state.subscribe((entry) => emitted.push(entry.payload));
    const adapter = createPiEventAdapter({ state });

    adapter.apply('s1', '/repo', { type: 'error', id: 'err1', error: 'boom' });

    expect(emitted.map((event) => event.type)).toContain('message.part.updated');
    expect(emitted.map((event) => event.type)).toContain('message.part.delta');
    expect(emitted.at(-1).type).toBe('session.error');
    expect(state.getMessages('s1')[0].parts[0].text).toContain('boom');
  });

  test('maps tool call events to text fallback', () => {
    const state = createPiHarnessState({ providerID: 'p', modelID: 'm' });
    state.upsertSession({ sessionId: 's1', workspaceDir: '/repo' });
    const emitted = [];
    state.subscribe((entry) => emitted.push(entry.payload));
    const adapter = createPiEventAdapter({ state });

    adapter.apply('s1', '/repo', { type: 'turn_start', id: 't1' });
    adapter.apply('s1', '/repo', { type: 'tool_call_start', id: 't1', toolName: 'read', toolArgs: '{"path":"x"}' });
    adapter.apply('s1', '/repo', { type: 'tool_call_end', id: 't1', toolName: 'read', toolResult: 'content' });
    adapter.apply('s1', '/repo', { type: 'turn_end', id: 't1' });

    expect(emitted.map((event) => event.type)).toContain('message.part.delta');
    const msgs = state.getMessages('s1');
    const assistant = msgs.find((m) => m.info.role === 'assistant');
    expect(assistant.parts[0].text).toContain('read');
    expect(assistant.parts[0].text).toContain('content');
  });

  test('handles unknown event types gracefully', () => {
    const state = createPiHarnessState({ providerID: 'p', modelID: 'm' });
    const adapter = createPiEventAdapter({ state });
    expect(() => adapter.apply('s1', '/repo', { type: 'unknown', id: 'x' })).not.toThrow();
  });
});
