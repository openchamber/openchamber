import { describe, expect, test } from 'bun:test';

import type { Message, Part } from '@/lib/opencode/model';
import { findSubagentTask } from './subagentTask';

const assistant = (id: string, sessionID: string): Message => ({
  id, sessionID, role: 'assistant', time: { created: 1 }, agent: 'build', providerID: 'p', modelID: 'm',
});

const call = (id: string, messageID: string, childId: string, prompt: string): Part => ({
  id,
  sessionID: 'parent',
  messageID,
  type: 'tool',
  callID: id,
  tool: 'subagent',
  state: { status: 'completed', input: { agent: 'explore', description: 'look', prompt }, output: '', metadata: { status: 'running', sessionID: childId }, time: { start: 1, end: 2 } },
});

describe('findSubagentTask', () => {
  test("reads the prompt of the parent's first call for the child", () => {
    const parent = [assistant('a1', 'parent'), assistant('a2', 'parent')];
    const parts = {
      a1: [call('c0', 'a1', 'other', 'not this one'), call('c1', 'a1', 'child', 'Audit the ADRs')],
      a2: [call('c2', 'a2', 'child', 'Follow-up')],
    };
    expect(findSubagentTask(parent, undefined, parts, 'child')).toBe('Audit the ADRs');
  });

  test("falls back to the child's own first prompt", () => {
    const child: Message[] = [{ id: 'u1', sessionID: 'child', role: 'user', time: { created: 1 } }];
    const parts = { u1: [{ id: 'u1:text:0', sessionID: 'child', messageID: 'u1', type: 'text', text: 'Do the thing' } as Part] };
    expect(findSubagentTask([], child, parts, 'child')).toBe('Do the thing');
  });

  test('is null when neither is loaded', () => {
    expect(findSubagentTask(undefined, undefined, {}, 'child')).toBeNull();
  });
});
