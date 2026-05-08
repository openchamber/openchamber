import { describe, expect, test } from 'bun:test';
import type { Message } from '@opencode-ai/sdk/v2/client';

import { computeSessionIsWorking } from './computeSessionIsWorking';

function assistantMessage(id: string, completed?: number): Message {
  return {
    id,
    role: 'assistant',
    sessionID: 'ses_1',
    time: completed ? { created: 1, updated: 1, completed } : { created: 1, updated: 1 },
  } as unknown as Message;
}

describe('computeSessionIsWorking', () => {
  test('returns false without live status even if last assistant looks incomplete', () => {
    expect(
      computeSessionIsWorking({
        sessionId: 'ses_1',
        hasBlockingRequests: false,
        statusType: undefined,
        hasLiveStatus: false,
        lastMessage: assistantMessage('msg_1'),
      }),
    ).toBe(false);
  });

  test('returns true during active streaming phase without live status', () => {
    expect(
      computeSessionIsWorking({
        sessionId: 'ses_1',
        hasBlockingRequests: false,
        activeStreamingPhase: 'response',
        statusType: 'idle',
        hasLiveStatus: false,
        lastMessage: assistantMessage('msg_1'),
      }),
    ).toBe(true);
  });

  test('returns true for busy/retry live status', () => {
    expect(
      computeSessionIsWorking({
        sessionId: 'ses_1',
        hasBlockingRequests: false,
        statusType: 'busy',
        hasLiveStatus: true,
      }),
    ).toBe(true);

    expect(
      computeSessionIsWorking({
        sessionId: 'ses_1',
        hasBlockingRequests: false,
        statusType: 'retry',
        hasLiveStatus: true,
      }),
    ).toBe(true);
  });
});
