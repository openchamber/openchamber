import { describe, expect, test } from 'bun:test';
import { createPiHarnessState } from './state.js';

describe('Pi-Harness projection state', () => {
  test('creates and lists OpenCode-like sessions', () => {
    const state = createPiHarnessState({ providerID: 'p', modelID: 'm' });
    const session = state.upsertSession({
      sessionId: 's1',
      createdAt: '2026-06-14T00:00:00.000Z',
      workspaceDir: '/repo',
    });

    expect(session.id).toBe('s1');
    expect(session.directory).toBe('/repo');
    expect(session.metadata.backend).toBe('pi-harness');
    expect(state.listSessions()).toEqual([session]);
    expect(state.getStatusMap()).toEqual({ s1: { type: 'idle' } });
  });

  test('upsertSession is idempotent', () => {
    const state = createPiHarnessState({ providerID: 'p', modelID: 'm' });
    state.upsertSession({ sessionId: 's1', workspaceDir: '/a' });
    state.upsertSession({ sessionId: 's1', workspaceDir: '/b' });
    expect(state.listSessions()).toHaveLength(1);
    expect(state.getSession('s1').directory).toBe('/b');
  });

  test('stores user and assistant message records', () => {
    const state = createPiHarnessState({ providerID: 'p', modelID: 'm' });
    state.upsertSession({ sessionId: 's1', workspaceDir: '/repo' });
    const user = state.addUserMessage({ sessionID: 's1', messageID: 'u1', text: 'hello' });
    const assistant = state.ensureAssistantTextPart({ sessionID: 's1', turnID: 't1' });
    state.appendTextDelta({ messageID: assistant.message.id, partID: assistant.part.id, delta: 'hi' });
    state.finishAssistantMessage({ messageID: assistant.message.id });

    expect(user.info.role).toBe('user');
    expect(state.getMessages('s1')).toHaveLength(2);
    const msgs = state.getMessages('s1');
    expect(msgs).toHaveLength(2);
    const last = msgs.find((m) => m.info.role === 'assistant');
    expect(last.parts[0].text).toBe('hi');
    expect(last.info.finish).toBe('stop');
  });

  test('deletes session and cleans up state', () => {
    const state = createPiHarnessState({ providerID: 'p', modelID: 'm' });
    state.upsertSession({ sessionId: 's1', workspaceDir: '/repo' });
    state.addUserMessage({ sessionID: 's1', messageID: 'u1', text: 'hi' });
    state.deleteSession('s1');
    expect(state.listSessions()).toHaveLength(0);
    expect(state.getMessages('s1')).toHaveLength(0);
  });

  test('publishes and replays events', () => {
    const state = createPiHarnessState({ providerID: 'p', modelID: 'm' });
    const seen = [];
    const unsubscribe = state.subscribe((entry) => seen.push(entry));
    state.publish('global', { type: 'session.idle', properties: { sessionID: 's1' } });
    unsubscribe();
    state.publish('global', { type: 'session.idle', properties: { sessionID: 's2' } });

    expect(seen).toHaveLength(1);
    expect(seen[0].eventId).toBe('pi_evt_1');
    expect(state.replayAfter('pi_evt_1')).toHaveLength(1);
    expect(state.replayAfter('nonexistent')).toHaveLength(0);
  });

  test('tracks and aborts active streams', () => {
    const state = createPiHarnessState({ providerID: 'p', modelID: 'm' });
    const controller = new AbortController();
    state.setActiveStream('s1', controller);
    expect(state.abortActiveStream('s1')).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    expect(state.abortActiveStream('s1')).toBe(false);
  });

  test('clears active stream only for matching controller', () => {
    const state = createPiHarnessState({ providerID: 'p', modelID: 'm' });
    const c1 = new AbortController();
    const c2 = new AbortController();
    state.setActiveStream('s1', c1);
    state.clearActiveStream('s1', c2); // wrong controller
    expect(state.abortActiveStream('s1')).toBe(true);
  });
});
