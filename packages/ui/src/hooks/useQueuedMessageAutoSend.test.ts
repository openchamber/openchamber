import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Agent, Message } from '@opencode-ai/sdk/v2';
import type { QueuedMessage } from '../stores/messageQueueStore';
import { ChildStoreManager } from '@/sync/child-store';
import { setSyncRefs } from '@/sync/sync-refs';

let visibleAgents: Agent[] = [];
const sendMessageCalls: unknown[][] = [];

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
      sessionAbortFlags: new Map(),
    }),
  },
}));

import {
  buildQueuedAutoSendPayload,
  createQueuedAutoSendRetryScheduler,
  getQueuedAutoSendRetryDelayMs,
  isQueuedAutoSendBackedOff,
  resolveQueuedSessionStatusType,
  sendQueuedAutoSendPayload,
  shouldDispatchQueuedAutoSend,
} from './useQueuedMessageAutoSend';

describe('queued auto-send retry scheduler', () => {
  test('wakes the queue when backoff expires', () => {
    const callbacks = new Map<number, () => void>();
    let nextTimer = 0;
    let wakeups = 0;
    const scheduler = createQueuedAutoSendRetryScheduler(
      () => { wakeups += 1; },
      () => 1_000,
      (callback, delay) => {
        callbacks.set(++nextTimer, callback);
        expect(delay).toBe(500);
        return nextTimer as unknown as ReturnType<typeof setTimeout>;
      },
      (timer) => { callbacks.delete(timer as unknown as number); },
    );

    scheduler.schedule(1_500);
    expect(callbacks.size).toBe(1);
    callbacks.values().next().value?.();
    expect(wakeups).toBe(1);
  });

  test('keeps the earliest retry and cancels it on dispose', () => {
    const callbacks = new Map<number, () => void>();
    let nextTimer = 0;
    const delays: number[] = [];
    const scheduler = createQueuedAutoSendRetryScheduler(
      () => undefined,
      () => 1_000,
      (callback, delay) => {
        callbacks.set(++nextTimer, callback);
        delays.push(delay);
        return nextTimer as unknown as ReturnType<typeof setTimeout>;
      },
      (timer) => { callbacks.delete(timer as unknown as number); },
    );

    scheduler.schedule(3_000);
    scheduler.schedule(4_000);
    scheduler.schedule(2_000);

    expect(delays).toEqual([2_000, 1_000]);
    expect(callbacks.size).toBe(1);
    scheduler.dispose();
    expect(callbacks.size).toBe(0);
  });
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

describe('resolveQueuedSessionStatusType', () => {
  const DIRECTORY = '/repo';

  const assistantMessage = (id: string, completed?: number): Message => ({
    id,
    role: 'assistant',
    sessionID: 'ses_1',
    time: { created: 1, ...(completed !== undefined ? { completed } : {}) },
  } as Message);

  let childStores: ChildStoreManager;

  beforeEach(() => {
    childStores = new ChildStoreManager();
    const store = childStores.ensureChild(DIRECTORY, { bootstrap: false });
    store.setState({ status: 'complete', session_status: {}, message: {} });
    setSyncRefs({} as never, childStores, DIRECTORY);
  });

  test('treats a session with an in-flight assistant turn as busy even when the status entry is missing', () => {
    // The server status map only lists busy/retry sessions, so a missed busy
    // event leaves NO status entry while the turn is still streaming. The
    // queue gate must not read that absence as idle: queued prompts would be
    // dispatched into the running turn and merged into one model response.
    childStores.ensureChild(DIRECTORY, { bootstrap: false }).setState({
      message: { ses_1: [assistantMessage('msg_streaming')] },
    });

    expect(resolveQueuedSessionStatusType('ses_1', DIRECTORY)).toBe('busy');
  });

  test('resolves an explicit busy or retry status entry', () => {
    const store = childStores.ensureChild(DIRECTORY, { bootstrap: false });
    store.setState({ session_status: { ses_1: { type: 'busy' } } });
    expect(resolveQueuedSessionStatusType('ses_1', DIRECTORY)).toBe('busy');
    store.setState({ session_status: { ses_1: { type: 'retry', attempt: 2, message: 'boom', next: 30 } } });
    expect(resolveQueuedSessionStatusType('ses_1', DIRECTORY)).toBe('retry');
  });

  test('resolves idle when the trailing assistant message has completed', () => {
    const store = childStores.ensureChild(DIRECTORY, { bootstrap: false });
    store.setState({ message: { ses_1: [assistantMessage('msg_done', 5)] } });
    expect(resolveQueuedSessionStatusType('ses_1', DIRECTORY)).toBe('idle');
  });

  test('resolves an explicit idle entry and unknown sessions as idle', () => {
    const store = childStores.ensureChild(DIRECTORY, { bootstrap: false });
    store.setState({ session_status: { ses_1: { type: 'idle' } } });
    expect(resolveQueuedSessionStatusType('ses_1', DIRECTORY)).toBe('idle');
    expect(resolveQueuedSessionStatusType('ses_unknown', DIRECTORY)).toBe('idle');
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
        text: 'first queued message',
        createdAt: 1,
      },
      {
        id: 'queued-2',
        content: 'second queued message',
        text: 'second queued message',
        createdAt: 2,
      },
    ];

    const payload = buildQueuedAutoSendPayload(queue);

    expect(payload).not.toBeNull();
    expect(payload?.queuedMessageId).toBe('queued-1');
    expect(payload?.primaryText).toBe('first queued message');
    expect(payload?.primaryAttachments).toEqual([]);
  });

  test('delivers the captured mention and context instead of re-parsing the content', () => {
    const metadata = { openchamberContext: { kind: 'github-issue' as const, number: 3, title: 'Bug', url: 'https://x/issues/3' } };
    const queue: QueuedMessage[] = [
      {
        id: 'queued-mention',
        content: '@Builder please take this',
        text: 'please take this',
        agentMention: 'Builder',
        context: [
          { kind: 'context', text: 'issue body', metadata },
          { kind: 'instruction', text: 'use the skill' },
        ],
        createdAt: 1,
      },
    ];

    const payload = buildQueuedAutoSendPayload(queue);

    expect(payload).not.toBeNull();
    expect(payload?.agentMentionName).toBe('Builder');
    expect(payload?.primaryText).toBe('please take this');
    expect(payload?.additionalParts).toEqual([
      { text: 'issue body', synthetic: true, metadata },
      { text: 'use the skill', synthetic: true },
    ]);
  });

  test('preserves attachment-only queued messages as sendable payloads', () => {
    const queue: QueuedMessage[] = [
      {
        id: 'queued-attachments',
        content: '',
        text: '',
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
        text: 'later queued message',
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
        text: 'queued message',
        createdAt: 1,
      },
    ]);

    expect(payload).not.toBeNull();
    await sendQueuedAutoSendPayload({
      runtimeKey: 'runtime-original',
      sessionId: 'session-original',
      directory: '/repo',
    }, payload!, {
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
      {
        target: {
          runtimeKey: 'runtime-original',
          sessionId: 'session-original',
          directory: '/repo',
        },
      },
    ]);
  });
});
