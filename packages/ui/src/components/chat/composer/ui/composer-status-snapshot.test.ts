import { describe, expect, test } from 'bun:test';
import type { AssistantMessage, Message, UserMessage } from '@/lib/opencode/model';
import { buildComposerStatusSnapshot } from './composer-status-snapshot';

const assistantMessage = (options: {
  sessionId: string;
  created: number;
  completed?: number;
  providerID?: string;
}): Message => {
  const base = {
    id: `msg_assistant_${options.created}`,
    sessionID: options.sessionId,
    role: 'assistant' as const,
    modelID: 'model-1',
    providerID: options.providerID ?? 'provider-1',
    agent: 'agent',
    path: { cwd: '/repo', root: '/repo' },
    cost: 0,
    time: { created: options.created },
    tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
  };
  return (options.completed === undefined
    ? { ...base, finish: 'stop' as const }
    : { ...base, time: { created: options.created, completed: options.completed } }) satisfies AssistantMessage;
};

const userMessage = (sessionId: string, created: number): Message => ({
  id: `msg_user_${created}`,
  sessionID: sessionId,
  role: 'user',
  time: { created },
}) satisfies UserMessage;

describe('buildComposerStatusSnapshot', () => {
  test('reports engine, provider and completion instant of the latest completed assistant turn', () => {
    const snapshot = buildComposerStatusSnapshot({
      sessionId: 'ses-1',
      engine: 'claude',
      messages: [
        userMessage('ses-1', 100),
        assistantMessage({ sessionId: 'ses-1', created: 200, completed: 900, providerID: 'anthropic' }),
      ],
    });
    expect(snapshot).toEqual({
      sessionId: 'ses-1',
      engine: 'claude',
      providerId: 'anthropic',
      lastAssistantAt: 900,
    });
  });

  test('falls back to the creation instant when the turn never recorded a completion', () => {
    const snapshot = buildComposerStatusSnapshot({
      sessionId: 'ses-1',
      engine: 'opencode',
      messages: [assistantMessage({ sessionId: 'ses-1', created: 500 })],
    });
    expect(snapshot.providerId).toBe('provider-1');
    expect(snapshot.lastAssistantAt).toBe(500);
  });

  test('keeps a full snapshot with null fields when the session has no completed assistant turn', () => {
    expect(buildComposerStatusSnapshot({
      sessionId: 'ses-1',
      engine: 'claude',
      messages: [userMessage('ses-1', 100)],
    })).toEqual({ sessionId: 'ses-1', engine: 'claude', providerId: null, lastAssistantAt: null });
    expect(buildComposerStatusSnapshot({
      sessionId: 'ses-1',
      engine: 'claude',
      messages: [],
    })).toEqual({ sessionId: 'ses-1', engine: 'claude', providerId: null, lastAssistantAt: null });
  });

  test('reports the new session when the message bucket changes', () => {
    const first = buildComposerStatusSnapshot({
      sessionId: 'ses-1',
      engine: 'claude',
      messages: [assistantMessage({ sessionId: 'ses-1', created: 200, completed: 900, providerID: 'anthropic' })],
    });
    const second = buildComposerStatusSnapshot({
      sessionId: 'ses-2',
      engine: 'claude',
      messages: [assistantMessage({ sessionId: 'ses-2', created: 1000, completed: 1500, providerID: 'openai' })],
    });
    expect(first.lastAssistantAt).toBe(900);
    expect(second).toEqual({ sessionId: 'ses-2', engine: 'claude', providerId: 'openai', lastAssistantAt: 1500 });
  });

  test('nulls the per-turn fields without a session', () => {
    expect(buildComposerStatusSnapshot({
      sessionId: null,
      engine: 'claude',
      messages: [assistantMessage({ sessionId: 'ses-1', created: 200, completed: 900 })],
    })).toEqual({ sessionId: '', engine: 'claude', providerId: null, lastAssistantAt: null });
  });
});
