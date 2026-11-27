import { describe, expect, test } from 'bun:test';
import type { Message, Part } from '@/lib/opencode/model';
import { selectUnansweredPrompt } from './unanswered-prompt';

const user = (id: string, pending?: true): Message => ({ id, sessionID: 'ses_1', role: 'user', time: { created: 1 }, ...(pending ? { pending } : {}) });
const assistant = (id: string): Message => ({ id, sessionID: 'ses_1', role: 'assistant', time: { created: 2 }, agent: 'build', providerID: 'p', modelID: 'm' });
const shell = (id: string): Message => ({ id, sessionID: 'ses_1', role: 'shell', time: { created: 3 }, shellID: 'sh_1', command: 'ls', status: 'exited' });
const text = (messageID: string, value: string): Part => ({ id: `${messageID}_t`, sessionID: 'ses_1', messageID, type: 'text', text: value });
const reasoning = (messageID: string): Part => ({ id: `${messageID}_r`, sessionID: 'ses_1', messageID, type: 'reasoning', text: 'thinking', time: { start: 1 } });

const select = (messages: Message[], parts: Record<string, Part[]> = {}) =>
  selectUnansweredPrompt(messages, (messageID) => parts[messageID] ?? [])?.id ?? null;

describe('selectUnansweredPrompt', () => {
  test('the latest prompt is unanswered while the model only thinks or writes nothing', () => {
    expect(select([user('u1')])).toBe('u1');
    expect(select([user('u1'), assistant('a1')], { a1: [reasoning('a1'), text('a1', '  ')] })).toBe('u1');
  });

  test('any answer text, a tool call, or other work since the prompt means it was answered', () => {
    expect(select([user('u1'), assistant('a1')], { a1: [text('a1', 'Hello')] })).toBeNull();
    expect(select([user('u1'), assistant('a1')], { a1: [{ id: 't', sessionID: 'ses_1', messageID: 'a1', type: 'tool', callID: 'c', tool: 'read', state: { status: 'pending', input: {}, raw: '' } }] })).toBeNull();
    expect(select([user('u1'), shell('s1')])).toBeNull();
  });

  test('an earlier answered turn does not matter, and a queued prompt waiting to be sent stops the take-back', () => {
    expect(select([user('u1'), assistant('a1'), user('u2')], { a1: [text('a1', 'Done')] })).toBe('u2');
    expect(select([user('u1'), user('u2', true)])).toBeNull();
  });
});
