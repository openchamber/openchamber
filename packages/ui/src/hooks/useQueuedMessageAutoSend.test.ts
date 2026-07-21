import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Agent } from '@opencode-ai/sdk/v2';
import type { QueuedMessage } from '../stores/messageQueueStore';

let visibleAgents: Agent[] = [];
const sendMessageCalls: unknown[][] = [];
let sessionAbortFlagsMock = new Map<string, { timestamp: number; acknowledged: boolean }>();

const getVisibleAgentsMock = mock(() => visibleAgents);

mock.module('@/stores/useConfigStore', () => ({
  useConfigStore: {
    getState: () => ({
      getVisibleAgents: getVisibleAgentsMock,
    }),
  },
}));

mock.module('@/sync/session-ui-store', () => ({
  useSessionUIStore: {
    getState: () => ({
      sendMessage: (...args: unknown[]) => {
        sendMessageCalls.push(args);
        return Promise.resolve();
      },
      get sessionAbortFlags() {
        return sessionAbortFlagsMock;
      },
    }),
  },
}));

import {
  buildQueuedAutoSendPayload,
  getQueuedAutoSendRetryDelayMs,
  isQueuedAutoSendBackedOff,
  getAbortWindowRetryDelayMs,
  hasRecentAbort,
  sendQueuedAutoSendPayload,
  shouldDispatchQueuedAutoSend,
} from './useQueuedMessageAutoSend';

beforeEach(() => {
  sessionAbortFlagsMock = new Map();
});

describe('shouldDispatchQueuedAutoSend', () => {
  test('dispatches only after an active session becomes idle', () => {
    expect(shouldDispatchQueuedAutoSend('busy', 'idle', false)).toBe(true);
    expect(shouldDispatchQueuedAutoSend('retry', 'idle', false)).toBe(true);
  });

  test('does not dispatch when idle is only first seen or status is missing', () => {
    expect(shouldDispatchQueuedAutoSend(undefined, 'idle', false)).toBe(false);
    expect(shouldDispatchQueuedAutoSend('idle', 'idle', false)).toBe(false);
  });

  test('dispatches when idle→idle and queue has items', () => {
    expect(shouldDispatchQueuedAutoSend('idle', 'idle', true)).toBe(true);
  });
});

describe('queued auto-send retry backoff', () => {
  test('delay grows exponentially and is capped', () => {
    expect(getQueuedAutoSendRetryDelayMs(1)).toBe(2000);
    expect(getQueuedAutoSendRetryDelayMs(2)).toBe(4000);
    expect(getQueuedAutoSendRetryDelayMs(3)).toBe(8000);
    expect(getQueuedAutoSendRetryDelayMs(10)).toBe(60000);
    expect(getQueuedAutoSendRetryDelayMs(100)).toBe(60000);
  });

  test('backs off only the failed message within its window', () => {
    const failure = { messageId: 'queued-1', failures: 1, nextAttemptAt: 10_000 };

    expect(isQueuedAutoSendBackedOff(failure, 'queued-1', 9_999)).toBe(true);
    expect(isQueuedAutoSendBackedOff(failure, 'queued-1', 10_000)).toBe(false);
    expect(isQueuedAutoSendBackedOff(failure, 'queued-2', 9_999)).toBe(false);
    expect(isQueuedAutoSendBackedOff(undefined, 'queued-1', 0)).toBe(false);
  });
});

describe('buildQueuedAutoSendPayload', () => {
  beforeEach(() => {
    visibleAgents = [];
    sendMessageCalls.length = 0;
  });

  test('returns only the first queued message for auto-send', () => {
    const queue: QueuedMessage[] = [
      {
        id: 'queued-1',
        content: 'first queued message',
        createdAt: 1,
      },
      {
        id: 'queued-2',
        content: 'second queued message',
        createdAt: 2,
      },
    ];

    const payload = buildQueuedAutoSendPayload(queue);

    expect(payload).not.toBeNull();
    expect(payload?.queuedMessageId).toBe('queued-1');
    expect(payload?.primaryText).toBe('first queued message');
    expect(payload?.primaryAttachments).toEqual([]);
  });

  test('uses the configured visible agents when parsing queued mentions', () => {
    visibleAgents = [
      {
        name: 'Builder',
        mode: 'subagent',
        permission: [],
        options: {},
      } as Agent,
    ];

    const queue: QueuedMessage[] = [
      {
        id: 'queued-mention',
        content: '@Builder please take this',
        createdAt: 1,
      },
    ];

    const payload = buildQueuedAutoSendPayload(queue);

    expect(payload).not.toBeNull();
    expect(payload?.agentMentionName).toBe('Builder');
    expect(payload?.primaryText).toBe('@Builder please take this');
  });

  test('preserves attachment-only queued messages as sendable payloads', () => {
    const queue: QueuedMessage[] = [
      {
        id: 'queued-attachments',
        content: '',
        createdAt: 1,
        attachments: [
          {
            id: 'file-1',
            filename: 'notes.txt',
            mimeType: 'text/plain',
            size: 5,
            source: 'local',
            file: new File(['hello'], 'notes.txt', { type: 'text/plain' }),
            dataUrl: 'data:text/plain;base64,aGVsbG8=',
          },
        ],
      },
      {
        id: 'queued-2',
        content: 'later queued message',
        createdAt: 2,
      },
    ];

    const payload = buildQueuedAutoSendPayload(queue);

    expect(payload).not.toBeNull();
    expect(payload?.queuedMessageId).toBe('queued-attachments');
    expect(payload?.primaryText).toBe('');
    expect(payload?.primaryAttachments).toHaveLength(1);
    expect(payload?.primaryAttachments[0]?.filename).toBe('notes.txt');
  });

  test('auto-send targets the queued session explicitly', async () => {
    const payload = buildQueuedAutoSendPayload([
      {
        id: 'queued-1',
        content: 'queued message',
        createdAt: 1,
      },
    ]);

    expect(payload).not.toBeNull();
    await sendQueuedAutoSendPayload('session-original', payload!, {
      providerID: 'provider-1',
      modelID: 'model-1',
      agent: 'agent-1',
      variant: 'variant-1',
    });

    expect(sendMessageCalls.length).toBe(1);
    expect(sendMessageCalls[0]).toEqual([
      'queued message',
      'provider-1',
      'model-1',
      'agent-1',
      [],
      undefined,
      undefined,
      'variant-1',
      'normal',
      { sessionId: 'session-original', delivery: 'steer' },
    ]);
  });

  test('sendQueuedAutoSendPayload passes delivery: "steer"', async () => {
    const payload = buildQueuedAutoSendPayload([
      {
        id: 'queued-1',
        content: 'queued message',
        createdAt: 1,
      },
    ]);

    expect(payload).not.toBeNull();
    await sendQueuedAutoSendPayload('session-original', payload!, {
      providerID: 'provider-1',
      modelID: 'model-1',
    });

    expect(sendMessageCalls.length).toBe(1);
    const lastArg = sendMessageCalls[0][sendMessageCalls[0].length - 1];
    expect(lastArg).toEqual({ sessionId: 'session-original', delivery: 'steer' });
  });
});

describe('hasRecentAbort', () => {
  test('returns false when no abort record exists', () => {
    expect(hasRecentAbort('session-a')).toBe(false);
  });

  test('returns true when a recent unacknowledged abort exists', () => {
    sessionAbortFlagsMock.set('session-a', {
      timestamp: Date.now(),
      acknowledged: false,
    });

    expect(hasRecentAbort('session-a')).toBe(true);
  });

  test('returns false when abort is too old', () => {
    sessionAbortFlagsMock.set('session-a', {
      timestamp: Date.now() - 3000,
      acknowledged: false,
    });

    expect(hasRecentAbort('session-a')).toBe(false);
  });
});

describe('getAbortWindowRetryDelayMs', () => {
  test('returns the remaining delay until the abort window ends', () => {
    const now = 10_000;
    expect(getAbortWindowRetryDelayMs(8_250, now)).toBe(250);
    expect(getAbortWindowRetryDelayMs(7_500, now)).toBe(0);
  });
});

describe('hasRecentAbort guards dispatch inside the effect', () => {
  test('shouldDispatchQueuedAutoSend ignores abort flag; hasRecentAbort is checked separately in the effect', () => {
    sessionAbortFlagsMock.set('session-a', {
      timestamp: Date.now(),
      acknowledged: false,
    });

    expect(hasRecentAbort('session-a')).toBe(true);
    expect(shouldDispatchQueuedAutoSend('busy', 'idle', false)).toBe(true);
    // hasRecentAbort is checked separately inside the effect; the flag itself
    // does not change shouldDispatchQueuedAutoSend's signature.
    // This test documents that the two mechanisms work together.
  });
});

// Timer-based retry mechanism lives inside useQueuedMessageAutoSend's effect
// and requires React rendering to exercise. Unit tests for it belong in a
// component/hook integration test rather than in this pure-utility test file.
//
// Retry exhaustion behavior: after MAX_RETRY_ATTEMPTS failures, the message
// stays queued, auto-retry pauses, and the user sees a failure toast. That path
// is intentionally exercised by the hook effect rather than this utility file.
