import { beforeEach, describe, expect, test } from 'bun:test';
import type { Agent } from '@opencode-ai/sdk/v2';
import type { QueuedMessage } from '../stores/messageQueueStore';
import type { SessionUIState } from '@/sync/session-ui-store';

let visibleAgents: Agent[] = [];
const sendMessageCalls: unknown[][] = [];
const captureSendMessage: SessionUIState['sendMessage'] = (...args) => {
  sendMessageCalls.push(args);
  return Promise.resolve();
};

import {
  buildQueuedAutoSendPayload,
  getQueuedAutoSendRetryDelayMs,
  isQueuedAutoSendBackedOff,
  sendQueuedAutoSendPayload,
  shouldDispatchQueuedAutoSend,
} from './useQueuedMessageAutoSend';

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

    const payload = buildQueuedAutoSendPayload(queue, visibleAgents);

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

    const payload = buildQueuedAutoSendPayload(queue, visibleAgents);

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

    const payload = buildQueuedAutoSendPayload(queue, visibleAgents);

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
    ], visibleAgents);

    expect(payload).not.toBeNull();
    await sendQueuedAutoSendPayload('session-original', payload!, {
      providerID: 'provider-1',
      modelID: 'model-1',
      agent: 'agent-1',
      variant: 'variant-1',
    }, captureSendMessage);

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
      {
        sessionId: 'session-original',
        goalArm: { armed: false, objectiveOverride: null },
      },
    ]);
  });

  test('forwards the queued goal and synthetic context to its captured session', async () => {
    const syntheticParts = [{ text: 'A-only context', synthetic: true as const }];
    const goalArm = { armed: true, objectiveOverride: 'A objective' };
    const payload = buildQueuedAutoSendPayload([
      {
        id: 'queued-a',
        content: 'queued A message',
        createdAt: 1,
        syntheticParts,
        goalArm,
      },
    ], visibleAgents);

    expect(payload).not.toBeNull();
    await sendQueuedAutoSendPayload('session-a', payload!, {
      providerID: 'provider-a',
      modelID: 'model-a',
    }, captureSendMessage);

    expect(sendMessageCalls).toEqual([[
      'queued A message',
      'provider-a',
      'model-a',
      undefined,
      [],
      undefined,
      syntheticParts,
      undefined,
      'normal',
      { sessionId: 'session-a', goalArm },
    ]]);
  });

  test('forwards captured routing context, including an explicit null agent', async () => {
    const payload = buildQueuedAutoSendPayload([
      {
        id: 'queued-a',
        content: 'queued A message',
        createdAt: 1,
        sessionDirectory: '/projects/alpha',
        sessionAgent: null,
      },
    ], visibleAgents);

    expect(payload).not.toBeNull();
    await sendQueuedAutoSendPayload('session-a', payload!, {
      providerID: 'provider-a',
      modelID: 'model-a',
      agent: 'live-agent-b',
    }, captureSendMessage);

    expect(sendMessageCalls).toEqual([[
      'queued A message',
      'provider-a',
      'model-a',
      undefined,
      [],
      undefined,
      undefined,
      undefined,
      'normal',
      {
        sessionId: 'session-a',
        sessionDirectory: '/projects/alpha',
        sessionAgent: null,
        goalArm: { armed: false, objectiveOverride: null },
      },
    ]]);
  });
});
