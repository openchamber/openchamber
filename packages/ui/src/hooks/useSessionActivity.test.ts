import { describe, expect, test } from 'bun:test';

import type { Message } from '@opencode-ai/sdk/v2/client';

import { deriveSessionActivity } from './sessionActivity';

const completedAssistantMessage: Pick<Message, 'role' | 'time'> = {
  role: 'assistant',
  time: { created: 1, completed: 123 },
};

const incompleteAssistantMessage: Pick<Message, 'role' | 'time'> = {
  role: 'assistant',
  time: { created: 1 },
};

describe('deriveSessionActivity', () => {
  test('treats a completed trailing assistant message as idle even if status is still busy', () => {
    expect(deriveSessionActivity({
      sessionId: 'ses_1',
      status: { type: 'busy' },
      messages: [completedAssistantMessage],
      permissions: [],
      questions: [],
    }).phase).toBe('idle');
  });

  test('keeps busy when the trailing assistant message is still incomplete', () => {
    expect(deriveSessionActivity({
      sessionId: 'ses_1',
      status: { type: 'busy' },
      messages: [incompleteAssistantMessage],
      permissions: [],
      questions: [],
    }).isWorking).toBe(true);
  });
});
