import { beforeEach, afterEach, describe, expect, mock, test } from 'bun:test';
import type { Agent, Message, SessionStatus } from '@opencode-ai/sdk/v2';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createJSONStorage } from 'zustand/middleware';
import { ChildStoreManager } from '@/sync/child-store';
import type { State } from '@/sync/types';
import { getDirectoryState, setSyncRefs } from '@/sync/sync-refs';
import { useInputStore } from '@/sync/input-store';
import { useInlineCommentDraftStore, type InlineCommentDraft } from '@/stores/useInlineCommentDraftStore';
import { CONTEXT_METADATA_KEY } from '@/lib/messages/contextParts';
import { captureComposerContextForQueue } from '@/components/chat/composer/submit/contextHandoff';
import { cleanupPersistedSessionState } from '@/sync/session-deletion-cleanup';
import {
  createMessageQueueTarget,
  getMessageQueueKey,
  useMessageQueueStore,
  type FollowUpBehavior,
  type QueuedMessage,
} from '../stores/messageQueueStore';
import { getRuntimeKey } from '@/lib/runtime-switch';

let visibleAgents: Agent[] = [];
const sendMessageCalls: unknown[][] = [];
let sendMessageOutcome: Promise<void> = Promise.resolve();
let sendMessageOutcomes: Promise<void>[] = [];

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
        return sendMessageOutcomes.shift() ?? sendMessageOutcome;
      },
      sessionAbortFlags: new Map(),
    }),
  },
}));

type AutoReviewRunStub = {
  originalSessionID: string;
  directory: string;
  status: 'running' | 'completed' | 'stopped' | 'error';
  runtimeKey: string;
};

type AutoReviewStateStub = {
  runsByOriginalSessionID: Record<string, AutoReviewRunStub>;
  isRunningForSession: (sessionId: string) => boolean;
};

const autoReviewMockState: AutoReviewStateStub = {
  runsByOriginalSessionID: {},
  isRunningForSession: (sessionId) => autoReviewMockState.runsByOriginalSessionID[sessionId]?.status === 'running',
};

const useAutoReviewStoreMock = Object.assign(
  <T,>(selector: (state: AutoReviewStateStub) => T): T => selector(autoReviewMockState),
  { getState: (): AutoReviewStateStub => autoReviewMockState },
);

mock.module('@/stores/useAutoReviewStore', () => ({
  useAutoReviewStore: useAutoReviewStoreMock,
}));

// The hook reads live status from the current-directory selector and from the
// target child stores. Back both paths with the same real child store so a
// status flip drives the effect like a live snapshot would.
const DIRECTORY = '/repo-auto';

const assistantMessage = (id: string, completed?: number, sessionID = 'ses_1'): Message => {
  const time = completed === undefined ? { created: 1 } : { created: 1, completed };

  // SAFETY: This fixture supplies the fields the hook reads from an assistant Message.
  return { id, role: 'assistant', sessionID, time } as Message;
};

const EMPTY_DIRECTORY_STATE: DirectorySyncState = { session_status: {}, message: {} };

// The hook only reads session_status and message from the directory state;
// these are the exact slices resolveQueuedSessionStatusType and the effect
// loop consume from the real child-store State.
type DirectorySyncState = Pick<State, 'session_status' | 'message'> & {
  session_status: Record<string, { type: 'idle' | 'busy' | 'retry' } | undefined>;
};

let directoryChildStores: ChildStoreManager | null = null;

const setDirectorySessionStatus = (
  sessionId: string,
  type: 'idle' | 'busy' | 'retry',
  messages: Message[] = [],
  directory = DIRECTORY,
) => {
  const manager = directoryChildStores;
  const store = manager?.ensureChild(directory, { bootstrap: false });
  if (!store) throw new Error('directory child store not bootstrapped');
  const status: SessionStatus = type === 'busy' ? { type: 'busy' } : type === 'retry' ? { type: 'retry', attempt: 1, message: 'test', next: 0 } : { type: 'idle' };
  store.setState({
    status: 'complete',
    sessionListSource: 'authoritative',
    session_status: { [sessionId]: status },
    message: messages.length > 0 ? { [sessionId]: messages } : {},
  });
};

const readDirectorySyncState = (): DirectorySyncState => {
  // SAFETY: getDirectoryState returns the real child-store State; the test
  // only writes idle/busy/retry entries and Message objects through
  // setDirectorySessionStatus/store.setState, so the state it reads back is
  // exactly the DirectorySyncState slice shape this mock hands to selectors.
  const state = getDirectoryState(DIRECTORY) as DirectorySyncState | undefined;
  return state ?? EMPTY_DIRECTORY_STATE;
};

type PersistedQueueSnapshot = {
  queuedMessages: Record<string, QueuedMessage[]>;
  quarantinedLegacyMessages: Record<string, QueuedMessage[]>;
  followUpBehavior: FollowUpBehavior;
};

const createControllableQueueStorage = () => {
  const values = new Map<string, string>();
  const storage = createJSONStorage<unknown>(() => ({
    getItem: (name) => values.get(name) ?? null,
    setItem: (name, value) => values.set(name, value),
    removeItem: (name) => {
      values.delete(name);
    },
  }));
  if (!storage) throw new Error('queue test storage unavailable');

  return {
    storage,
    seed(snapshot: PersistedQueueSnapshot) {
      values.set('message-queue-store', JSON.stringify({ state: snapshot, version: 5 }));
    },
  };
};

// The real useDirectorySync passes the selector's own generic through, so the
// mock mirrors that contract instead of forcing selectors to unknown.
mock.module('@/sync/sync-context', () => ({
  useDirectorySync: <T,>(selector: (state: DirectorySyncState) => T): T => selector(readDirectorySyncState()),
  useChildStoreManager: () => {
    if (!directoryChildStores) throw new Error('directory child stores not initialized');
    return directoryChildStores;
  },
}));

import {
  buildQueuedAutoSendPayload,
  createQueuedAutoSendRetryScheduler,
  getQueuedAutoSendRetryDelayMs,
  isQueuedAutoSendBackedOff,
  isQueuedSendBlockedForTarget,
  resolveQueuedSessionStatusType,
  sendQueuedAutoSendPayload,
  shouldDispatchQueuedAutoSend,
  useQueuedMessageAutoSend,
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

  test('explicit idle takes precedence over an unfinished trailing assistant message', () => {
    const store = childStores.ensureChild(DIRECTORY, { bootstrap: false });
    store.setState({
      session_status: { ses_1: { type: 'idle' } },
      message: { ses_1: [assistantMessage('msg_unfinished')] },
    });

    expect(resolveQueuedSessionStatusType('ses_1', DIRECTORY)).toBe('idle');
  });
});

describe('buildQueuedAutoSendPayload', () => {
  beforeEach(() => {
    visibleAgents = [];
    sendMessageCalls.length = 0;
    sendMessageOutcome = Promise.resolve();
    sendMessageOutcomes = [];
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

  test('passes normalized synthetic parts through auto-send', async () => {
    const payload = buildQueuedAutoSendPayload([
      {
        id: 'queued-magic',
        content: 'rendered prompt',
        createdAt: 1,
        additionalParts: [{ text: 'rendered instructions', synthetic: true }],
      },
    ]);

    expect(payload).not.toBeNull();
    await sendQueuedAutoSendPayload({
      runtimeKey: 'runtime-magic',
      sessionId: 'session-magic',
      directory: '/repo',
    }, payload!, {
      providerID: 'provider-magic',
      modelID: 'model-magic',
    });

    expect(sendMessageCalls).toHaveLength(1);
    expect(sendMessageCalls[0]?.[0]).toBe('rendered prompt');
    expect(sendMessageCalls[0]?.[6]).toEqual([{ text: 'rendered instructions', synthetic: true }]);
  });
});

describe('useQueuedMessageAutoSend integration', () => {
  let windowInstance: Window;
  let host: HTMLDivElement;
  let root: Root;

  const HookHost = () => {
    useQueuedMessageAutoSend(true);
    return null;
  };

  const mountHook = async (instances = 1) => {
    await act(async () => {
      root.render(React.createElement(
        React.Fragment,
        null,
        ...Array.from({ length: instances }, (_, index) => React.createElement(HookHost, { key: index })),
      ));
    });
  };

  const rerenderHook = async () => {
    await act(async () => {
      root.render(React.createElement(
        React.Fragment,
        null,
        React.createElement(HookHost, { key: 0 }),
      ));
    });
  };

  const primeQueue = (sessionId: string, directory = DIRECTORY, runtimeKey = getRuntimeKey()) => {
    const target = createMessageQueueTarget(sessionId, directory, runtimeKey);
    if (!target) throw new Error('queue target derivation failed');
    // Send config captured at queue time — the hook must send with this exact
    // configuration instead of re-resolving from current config stores.
    useMessageQueueStore.getState().addToQueue(target, {
      content: 'queued prompt',
      sendConfig: { providerID: 'provider-1', modelID: 'model-1' },
    });
    return target;
  };

  const queueOf = (sessionId: string, directory = DIRECTORY, runtimeKey = getRuntimeKey()): QueuedMessage[] => {
    const target = createMessageQueueTarget(sessionId, directory, runtimeKey);
    if (!target) throw new Error('queue target derivation failed');
    return useMessageQueueStore.getState().getQueueForTarget(target);
  };

  const primeContext = (sessionId: string) => {
    const target = createMessageQueueTarget(sessionId, DIRECTORY, getRuntimeKey());
    if (!target) throw new Error('queue target derivation failed');
    useInputStore.getState().setPendingSyntheticParts([{ text: 'pending synthetic context', synthetic: true }], target);
    const draft: Omit<InlineCommentDraft, 'id' | 'createdAt' | 'sessionKey'> = {
      source: 'diff',
      fileLabel: 'src/example.ts',
      startLine: 2,
      endLine: 2,
      side: 'modified',
      code: 'const answer = 41;',
      language: 'ts',
      text: 'please update this',
    };
    useInlineCommentDraftStore.getState().addDraft({ directory: DIRECTORY, sessionKey: sessionId }, draft);
  };

  beforeEach(() => {
    windowInstance = new Window();

    Object.assign(globalThis, {
      window: windowInstance,
      document: windowInstance.document,
      HTMLElement: windowInstance.HTMLElement,
      Element: windowInstance.Element,
      Node: windowInstance.Node,
      PointerEvent: windowInstance.PointerEvent,
      IS_REACT_ACT_ENVIRONMENT: true,
    });

    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);

    visibleAgents = [];
    sendMessageCalls.length = 0;
    sendMessageOutcome = Promise.resolve();
    sendMessageOutcomes = [];
    autoReviewMockState.runsByOriginalSessionID = {};
    directoryChildStores = new ChildStoreManager();
    // SAFETY: setSyncRefs only stores the sdk reference, never calls it; the
    // hook under test reads child-store state exclusively, so an empty stub
    // client is never dereferenced.
    setSyncRefs({} as never, directoryChildStores, DIRECTORY);
    setDirectorySessionStatus('ses_auto', 'busy');
    useInputStore.setState({
      pendingSyntheticParts: null,
      pendingSyntheticPartsByTarget: new Map(),
    });
    useInlineCommentDraftStore.setState({ drafts: {}, touchedAt: {} });
    useMessageQueueStore.setState({
      queuedMessages: {},
      sendingIds: {},
      quarantinedLegacyMessages: {},
      queueDeletionGenerations: {},
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    windowInstance.close();
  });

  test('dispatches the first queued item when a busy session turns idle and removes it from the queue', async () => {
    primeQueue('ses_auto');
    await mountHook();
    expect(sendMessageCalls.length).toBe(0);

    act(() => {
      setDirectorySessionStatus('ses_auto', 'idle');
    });
    await rerenderHook();

    expect(sendMessageCalls.length).toBe(1);
    expect(sendMessageCalls[0]?.[0]).toBe('queued prompt');
    expect(queueOf('ses_auto')).toHaveLength(0);
  });

  test('hydrates a queued item without dispatching until its busy session becomes idle', async () => {
    const target = createMessageQueueTarget('ses_auto', DIRECTORY, getRuntimeKey());
    if (!target) throw new Error('queue target derivation failed');
    const originalStorage = useMessageQueueStore.persist.getOptions().storage;
    const controlledStorage = createControllableQueueStorage();
    let resolveSend: (() => void) | undefined;
    sendMessageOutcome = new Promise<void>((resolve) => {
      resolveSend = resolve;
    });
    const hydratedMessage: QueuedMessage = {
      id: 'queued-hydrated',
      content: 'hydrated prompt',
      createdAt: 1,
      sendConfig: { providerID: 'provider-hydrated', modelID: 'model-hydrated' },
    };

    useMessageQueueStore.persist.setOptions({ storage: controlledStorage.storage });
    try {
      await mountHook();
      controlledStorage.seed({
        queuedMessages: { [getMessageQueueKey(target)]: [hydratedMessage] },
        quarantinedLegacyMessages: {},
        followUpBehavior: 'queue',
      });

      await act(async () => {
        await useMessageQueueStore.persist.rehydrate();
      });

      expect(useMessageQueueStore.getState().getQueueForTarget(target)).toEqual([hydratedMessage]);
      expect(useMessageQueueStore.getState().getQueueDispatchState(target).sendingIds).toEqual([]);
      expect(sendMessageCalls).toHaveLength(0);

      act(() => {
        setDirectorySessionStatus('ses_auto', 'idle');
      });
      await rerenderHook();

      expect(sendMessageCalls).toHaveLength(1);
      expect(sendMessageCalls[0]?.[0]).toBe('hydrated prompt');

      act(() => {
        setDirectorySessionStatus('ses_auto', 'idle');
      });
      await rerenderHook();
      await rerenderHook();
      expect(sendMessageCalls).toHaveLength(1);
      expect(queueOf('ses_auto')).toEqual([hydratedMessage]);
      expect(useMessageQueueStore.getState().getQueueDispatchState(target).sendingIds).toEqual([
        hydratedMessage.id,
      ]);

      await act(async () => {
        resolveSend?.();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(queueOf('ses_auto')).toHaveLength(0);
      expect(useMessageQueueStore.getState().getQueueDispatchState(target).sendingIds).toEqual([]);
    } finally {
      useMessageQueueStore.persist.setOptions({ storage: originalStorage });
    }
  });

  test('dispatches a ready worktree target even when the global directory is the project root', async () => {
    const worktreeDirectory = '/Repo-Auto-Worktree';
    const target = primeQueue('ses_worktree', worktreeDirectory);
    act(() => {
      setDirectorySessionStatus(target.sessionId, 'idle', [], worktreeDirectory);
    });

    await mountHook();
    await rerenderHook();

    expect(sendMessageCalls).toHaveLength(1);
    expect(sendMessageCalls[0]?.[0]).toBe('queued prompt');
    expect(sendMessageCalls[0]?.[9]).toEqual({ target });
    expect(queueOf(target.sessionId, worktreeDirectory)).toHaveLength(0);
  });

  test('does not dispatch a roots-only fallback after child-session discovery fails', async () => {
    const worktreeDirectory = '/repo-auto-partial-worktree';
    const target = primeQueue('ses_partial_worktree', worktreeDirectory);
    const manager = directoryChildStores;
    if (!manager) throw new Error('directory child stores not initialized');
    let bootstrapAttempts = 0;
    const cleanupBootstrap = manager.configure({
      onBootstrap: ({ directory }) => {
        bootstrapAttempts += 1;
        if (bootstrapAttempts > 1) {
          setDirectorySessionStatus(target.sessionId, 'idle', [], directory);
        }
      },
    });
    manager.ensureChild(worktreeDirectory, { bootstrap: false }).setState({
      status: 'complete',
      sessionListSource: 'partial',
    });

    await mountHook();
    await rerenderHook();

    expect(sendMessageCalls).toHaveLength(0);
    expect(queueOf(target.sessionId, worktreeDirectory)).toHaveLength(1);
    expect(bootstrapAttempts).toBe(1);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2_100));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(bootstrapAttempts).toBe(2);
    expect(sendMessageCalls).toHaveLength(1);
    expect(queueOf(target.sessionId, worktreeDirectory)).toHaveLength(0);
    cleanupBootstrap();
  });

  test('retries a failed bootstrap and dispatches the FIFO head exactly once after success', async () => {
    const worktreeDirectory = '/repo-auto-failed-worktree';
    const target = primeQueue('ses_failed_worktree', worktreeDirectory);
    const manager = directoryChildStores;
    if (!manager) throw new Error('directory child stores not initialized');
    let bootstrapAttempts = 0;
    const cleanupBootstrap = manager.configure({
      onBootstrap: ({ directory }) => {
        bootstrapAttempts += 1;
        if (bootstrapAttempts === 1) throw new Error('bootstrap failed');
        setDirectorySessionStatus(target.sessionId, 'idle', [], directory);
      },
    });

    await mountHook();
    expect(bootstrapAttempts).toBe(1);
    expect(sendMessageCalls).toHaveLength(0);
    expect(queueOf(target.sessionId, worktreeDirectory)).toHaveLength(1);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2_100));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(bootstrapAttempts).toBe(2);
    expect(sendMessageCalls).toHaveLength(1);
    expect(queueOf(target.sessionId, worktreeDirectory)).toHaveLength(0);
    await rerenderHook();
    expect(sendMessageCalls).toHaveLength(1);
    cleanupBootstrap();
  });

  test('coalesces failed bootstrap retry demand for queued sessions sharing a directory', async () => {
    const sharedDirectory = '/repo-auto-shared-retry';
    const firstTarget = primeQueue('ses_shared_first', sharedDirectory);
    const manager = directoryChildStores;
    if (!manager) throw new Error('directory child stores not initialized');
    let bootstrapAttempts = 0;
    const cleanupBootstrap = manager.configure({
      onBootstrap: ({ directory }) => {
        bootstrapAttempts += 1;
        if (bootstrapAttempts === 1) throw new Error('bootstrap failed');
        const store = manager.ensureChild(directory, { bootstrap: false });
        store.setState({
          status: 'complete',
          sessionListSource: 'authoritative',
          session_status: {
            [firstTarget.sessionId]: { type: 'idle' },
            ses_shared_second: { type: 'idle' },
          },
          message: {},
        });
      },
    });

    await mountHook();
    expect(bootstrapAttempts).toBe(1);

    let secondTarget: ReturnType<typeof primeQueue> | undefined;
    await act(async () => {
      secondTarget = primeQueue('ses_shared_second', sharedDirectory);
      await Promise.resolve();
    });
    await rerenderHook();
    if (!secondTarget) throw new Error('second queue target was not created');

    // The second queue joins the directory's existing backoff window instead
    // of forcing a second bootstrap before the first retry is due.
    expect(bootstrapAttempts).toBe(1);
    expect(queueOf(firstTarget.sessionId, sharedDirectory)).toHaveLength(1);
    expect(queueOf(secondTarget.sessionId, sharedDirectory)).toHaveLength(1);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2_100));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(bootstrapAttempts).toBe(2);
    expect(sendMessageCalls).toHaveLength(2);
    expect(sendMessageCalls.map((call) => call[9])).toEqual([
      { target: firstTarget },
      { target: secondTarget },
    ]);
    expect(queueOf(firstTarget.sessionId, sharedDirectory)).toHaveLength(0);
    expect(queueOf(secondTarget.sessionId, sharedDirectory)).toHaveLength(0);
    cleanupBootstrap();
  });

  test('keeps a worktree target queued until its directory session snapshot is authoritative', async () => {
    const worktreeDirectory = '/repo-auto-pending-worktree';
    const target = primeQueue('ses_pending_worktree', worktreeDirectory);
    const manager = directoryChildStores;
    if (!manager) throw new Error('directory child stores not initialized');
    manager.ensureChild(worktreeDirectory, { bootstrap: false }).setState({ status: 'complete' });

    await mountHook();
    expect(sendMessageCalls).toHaveLength(0);
    expect(queueOf(target.sessionId, worktreeDirectory)).toHaveLength(1);

    await act(async () => {
      setDirectorySessionStatus(target.sessionId, 'idle', [], worktreeDirectory);
      await Promise.resolve();
    });

    expect(sendMessageCalls).toHaveLength(1);
    expect(queueOf(target.sessionId, worktreeDirectory)).toHaveLength(0);
  });

  test('demands bootstrap for a queued target that has no child store', async () => {
    const worktreeDirectory = '/repo-auto-demanded-worktree';
    const target = primeQueue('ses_demanded_worktree', worktreeDirectory);
    const manager = directoryChildStores;
    if (!manager) throw new Error('directory child stores not initialized');

    let resolveBootstrap: (() => void) | undefined;
    const bootstrapReady = new Promise<void>((resolve) => {
      resolveBootstrap = resolve;
    });
    const cleanupBootstrap = manager.configure({
      onBootstrap: async ({ directory }) => {
        await bootstrapReady;
        setDirectorySessionStatus(target.sessionId, 'idle', [], directory);
      },
    });

    expect(manager.getChild(worktreeDirectory)).toBe(undefined);
    await mountHook();
    expect(manager.getChild(worktreeDirectory)).toBeDefined();
    expect(sendMessageCalls).toHaveLength(0);
    expect(queueOf(target.sessionId, worktreeDirectory)).toHaveLength(1);

    await act(async () => {
      resolveBootstrap?.();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(sendMessageCalls).toHaveLength(1);
    expect(sendMessageCalls[0]?.[9]).toEqual({ target });
    expect(queueOf(target.sessionId, worktreeDirectory)).toHaveLength(0);
    cleanupBootstrap();
  });

  test('dispatches only the matching directory when session IDs collide', async () => {
    const firstDirectory = '/repo-auto-collision-a';
    const secondDirectory = '/repo-auto-collision-b';
    const firstTarget = primeQueue('ses_collision', firstDirectory);
    const secondTarget = primeQueue('ses_collision', secondDirectory);
    act(() => {
      setDirectorySessionStatus(firstTarget.sessionId, 'idle', [], firstDirectory);
      setDirectorySessionStatus(secondTarget.sessionId, 'busy', [], secondDirectory);
    });

    await mountHook();
    await rerenderHook();

    expect(sendMessageCalls).toHaveLength(1);
    expect(sendMessageCalls[0]?.[9]).toEqual({ target: firstTarget });
    expect(queueOf(secondTarget.sessionId, secondDirectory)).toHaveLength(1);
  });

  test('does not dispatch a queued target from a different runtime', async () => {
    const worktreeDirectory = '/repo-auto-other-runtime';
    const target = primeQueue('ses_other_runtime', worktreeDirectory, 'other-runtime');
    act(() => {
      setDirectorySessionStatus(target.sessionId, 'idle', [], worktreeDirectory);
    });

    await mountHook();
    await rerenderHook();

    expect(sendMessageCalls).toHaveLength(0);
    expect(queueOf(target.sessionId, worktreeDirectory, target.runtimeKey)).toHaveLength(1);
  });

  test('dispatches when the server says idle despite an unfinished assistant fallback', async () => {
    primeQueue('ses_auto');
    await mountHook();

    act(() => {
      setDirectorySessionStatus('ses_auto', 'idle', [assistantMessage('msg_unfinished', undefined, 'ses_auto')]);
    });
    await rerenderHook();

    expect(sendMessageCalls).toHaveLength(1);
    expect(queueOf('ses_auto')).toHaveLength(0);
  });

  test('sends queued store context once and clears it after success', async () => {
    primeQueue('ses_auto');
    primeContext('ses_auto');
    await mountHook();

    act(() => {
      setDirectorySessionStatus('ses_auto', 'idle');
    });
    await rerenderHook();

    expect(sendMessageCalls).toHaveLength(1);
    const sentAdditionalParts = sendMessageCalls[0]?.[6];
    if (!Array.isArray(sentAdditionalParts)) throw new Error('additional parts were not sent');
    expect(sentAdditionalParts[0]?.text).toContain('please update this');
    expect(sentAdditionalParts[1]).toEqual({ text: 'pending synthetic context', synthetic: true });
    expect(sentAdditionalParts[0]?.metadata?.[CONTEXT_METADATA_KEY]).toEqual({
      kind: 'code-comment',
      source: 'diff',
      fileLabel: 'src/example.ts',
      startLine: 2,
      endLine: 2,
      side: 'modified',
      language: 'ts',
      code: 'const answer = 41;',
      text: 'please update this',
    });
    expect(useInlineCommentDraftStore.getState().getDrafts({ directory: DIRECTORY, sessionKey: 'ses_auto' })).toEqual([]);
    expect(useInputStore.getState().pendingSyntheticParts).toBeNull();
    expect(queueOf('ses_auto')).toHaveLength(0);
  });

  test('keeps the queue intact while the session stays busy across renders', async () => {
    primeQueue('ses_auto');
    await mountHook();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await rerenderHook();
      expect(sendMessageCalls.length).toBe(0);
    }

    expect(queueOf('ses_auto')).toHaveLength(1);
  });

  test('defers queued-chip dispatch when the target becomes busy after the async guard', async () => {
    const target = primeQueue('ses_auto');
    act(() => {
      setDirectorySessionStatus('ses_auto', 'idle');
    });

    expect(isQueuedSendBlockedForTarget(target)).toBe(false);
    await Promise.resolve();
    act(() => {
      setDirectorySessionStatus('ses_auto', 'busy');
    });

    if (!isQueuedSendBlockedForTarget(target)) {
      const payload = buildQueuedAutoSendPayload(useMessageQueueStore.getState().getSendableQueue(target));
      if (payload && useMessageQueueStore.getState().markSending(target, payload.queuedMessageId)) {
        await sendQueuedAutoSendPayload(target, payload, {
          providerID: 'provider-1',
          modelID: 'model-1',
        });
      }
    }

    expect(sendMessageCalls).toHaveLength(0);
    expect(queueOf('ses_auto')).toHaveLength(1);
    expect(useMessageQueueStore.getState().getQueueDispatchState(target).sendingIds).toEqual([]);
  });

  test('defers queued-chip dispatch when a matching auto-review starts after the async guard', async () => {
    const target = primeQueue('ses_auto');
    act(() => {
      setDirectorySessionStatus('ses_auto', 'idle');
    });

    expect(isQueuedSendBlockedForTarget(target)).toBe(false);
    await Promise.resolve();
    autoReviewMockState.runsByOriginalSessionID = {
      ses_auto: {
        originalSessionID: 'ses_auto',
        directory: DIRECTORY,
        runtimeKey: getRuntimeKey(),
        status: 'running',
      },
    };

    if (!isQueuedSendBlockedForTarget(target)) {
      const payload = buildQueuedAutoSendPayload(useMessageQueueStore.getState().getSendableQueue(target));
      if (payload && useMessageQueueStore.getState().markSending(target, payload.queuedMessageId)) {
        await sendQueuedAutoSendPayload(target, payload, {
          providerID: 'provider-1',
          modelID: 'model-1',
        });
      }
    }

    expect(sendMessageCalls).toHaveLength(0);
    expect(queueOf('ses_auto')).toHaveLength(1);
    expect(useMessageQueueStore.getState().getQueueDispatchState(target).sendingIds).toEqual([]);
  });

  test('keeps a queue blocked by an auto-review run in the same runtime', async () => {
    autoReviewMockState.runsByOriginalSessionID = {
      ses_auto: {
        originalSessionID: 'ses_auto',
        directory: DIRECTORY,
        runtimeKey: getRuntimeKey(),
        status: 'running',
      },
    };
    primeQueue('ses_auto');
    await mountHook();

    act(() => {
      setDirectorySessionStatus('ses_auto', 'idle');
    });
    await rerenderHook();

    expect(sendMessageCalls).toHaveLength(0);
    expect(queueOf('ses_auto')).toHaveLength(1);
  });

  test('blocks a queue when auto-review uses a Windows directory casing alias', async () => {
    const windowsDirectory = 'C:/Repo';
    const target = primeQueue('ses_windows', windowsDirectory);
    autoReviewMockState.runsByOriginalSessionID = {
      [target.sessionId]: {
        originalSessionID: target.sessionId,
        directory: 'c:/repo',
        runtimeKey: getRuntimeKey(),
        status: 'running',
      },
    };
    act(() => {
      setDirectorySessionStatus(target.sessionId, 'idle', [], windowsDirectory);
    });

    await mountHook();
    await rerenderHook();

    expect(sendMessageCalls).toHaveLength(0);
    expect(queueOf(target.sessionId, windowsDirectory)).toHaveLength(1);
  });

  test('does not let a stale auto-review run in another runtime block a colliding session queue', async () => {
    autoReviewMockState.runsByOriginalSessionID = {
      ses_auto: {
        originalSessionID: 'ses_auto',
        directory: DIRECTORY,
        runtimeKey: 'stale-runtime',
        status: 'running',
      },
    };
    primeQueue('ses_auto');
    await mountHook();

    act(() => {
      setDirectorySessionStatus('ses_auto', 'idle');
    });
    await rerenderHook();

    expect(sendMessageCalls).toHaveLength(1);
    expect(queueOf('ses_auto')).toHaveLength(0);
  });

  test('does not let an auto-review run in another directory block a colliding session queue', async () => {
    autoReviewMockState.runsByOriginalSessionID = {
      ses_auto: {
        originalSessionID: 'ses_auto',
        directory: '/other-directory',
        runtimeKey: getRuntimeKey(),
        status: 'running',
      },
    };
    primeQueue('ses_auto');
    await mountHook();

    act(() => {
      setDirectorySessionStatus('ses_auto', 'idle');
    });
    await rerenderHook();

    expect(sendMessageCalls).toHaveLength(1);
    expect(queueOf('ses_auto')).toHaveLength(0);
  });

  test('claims a queued item once while its send is in flight', async () => {
    let resolveSend: (() => void) | undefined;
    sendMessageOutcome = new Promise<void>((resolve) => {
      resolveSend = resolve;
    });
    primeQueue('ses_auto');
    await mountHook();

    act(() => {
      setDirectorySessionStatus('ses_auto', 'idle');
    });
    await rerenderHook();
    await rerenderHook();

    expect(sendMessageCalls).toHaveLength(1);
    expect(queueOf('ses_auto')).toHaveLength(1);

    await act(async () => {
      resolveSend?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(queueOf('ses_auto')).toHaveLength(0);
  });

  test('does not dispatch a later item while the queue head is unresolved', async () => {
    let resolveFirst: (() => void) | undefined;
    const firstAttempt = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    sendMessageOutcomes = [firstAttempt, Promise.resolve()];

    const target = primeQueue('ses_auto');
    useMessageQueueStore.getState().addToQueue(target, {
      content: 'later queued prompt',
      sendConfig: { providerID: 'provider-2', modelID: 'model-2' },
    });

    await mountHook();
    act(() => {
      setDirectorySessionStatus('ses_auto', 'idle');
    });
    await rerenderHook();

    expect(sendMessageCalls).toHaveLength(1);
    expect(sendMessageCalls[0]?.[0]).toBe('queued prompt');
    expect(queueOf('ses_auto')).toHaveLength(2);
    expect(useMessageQueueStore.getState().getQueueDispatchState(target).sendingIds).toEqual([
      queueOf('ses_auto')[0]?.id,
    ]);

    await rerenderHook();
    expect(sendMessageCalls).toHaveLength(1);

    await act(async () => {
      resolveFirst?.();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    await rerenderHook();

    expect(sendMessageCalls).toHaveLength(2);
    expect(sendMessageCalls[1]?.[0]).toBe('later queued prompt');
    expect(queueOf('ses_auto')).toHaveLength(0);
  });

  test('does not consume context twice when idle notifications race', async () => {
    let resolveSend: (() => void) | undefined;
    sendMessageOutcome = new Promise<void>((resolve) => {
      resolveSend = resolve;
    });
    primeQueue('ses_auto');
    primeContext('ses_auto');
    await mountHook(2);

    act(() => {
      setDirectorySessionStatus('ses_auto', 'idle');
    });
    await rerenderHook();

    expect(sendMessageCalls).toHaveLength(1);
    expect(useInlineCommentDraftStore.getState().getDrafts({ directory: DIRECTORY, sessionKey: 'ses_auto' })).toEqual([]);
    expect(useInputStore.getState().pendingSyntheticParts).toBeNull();

    await act(async () => {
      resolveSend?.();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(queueOf('ses_auto')).toHaveLength(0);
  });

  test('keeps a failed queued item visible and clears its sending claim', async () => {
    let rejectSend: ((error: Error) => void) | undefined;
    sendMessageOutcome = new Promise<void>((_resolve, reject) => {
      rejectSend = reject;
    });
    primeQueue('ses_auto');
    await mountHook();

    act(() => {
      setDirectorySessionStatus('ses_auto', 'idle');
    });
    await rerenderHook();
    await act(async () => {
      rejectSend?.(new Error('test send failure'));
      await Promise.resolve();
      await Promise.resolve();
    });

    const target = createMessageQueueTarget('ses_auto', DIRECTORY, getRuntimeKey());
    if (!target) throw new Error('queue target derivation failed');
    expect(sendMessageCalls).toHaveLength(1);
    expect(queueOf('ses_auto')).toHaveLength(1);
    expect(useMessageQueueStore.getState().sendingIds[getMessageQueueKey(target)]).toBe(undefined);
  });

  test('discards a deleted queued item when deletion races its claim', async () => {
    const target = primeQueue('ses_auto');
    primeContext('ses_auto');

    const originalMarkSending = useMessageQueueStore.getState().markSending;
    useMessageQueueStore.setState({
      markSending: (claimedTarget, messageId) => {
        const claimed = originalMarkSending(claimedTarget, messageId);
        if (claimed) {
          useMessageQueueStore.getState().clearQueueForSessionDeletion(claimedTarget);
          // Restore the real action before the hook's effect can run again.
          useMessageQueueStore.setState({ markSending: originalMarkSending });
        }
        return claimed;
      },
    });

    await mountHook();
    act(() => {
      setDirectorySessionStatus('ses_auto', 'idle');
    });
    await rerenderHook();

    expect(sendMessageCalls).toHaveLength(0);
    expect(queueOf('ses_auto')).toEqual([]);
    expect(useMessageQueueStore.getState().getQueueDispatchState(target).sendingIds).toEqual([]);
    expect(useInputStore.getState().consumePendingSyntheticParts(target)).toEqual([
      { text: 'pending synthetic context', synthetic: true },
    ]);
    expect(useInlineCommentDraftStore.getState().getDrafts({ directory: DIRECTORY, sessionKey: 'ses_auto' })).toHaveLength(1);
  });

  test('discards a deleted in-flight item without retrying or restoring its context', async () => {
    let rejectSend: ((error: Error) => void) | undefined;
    sendMessageOutcome = new Promise<void>((_resolve, reject) => {
      rejectSend = reject;
    });
    const target = primeQueue('ses_auto');
    primeContext('ses_auto');
    await mountHook();

    act(() => {
      setDirectorySessionStatus('ses_auto', 'idle');
    });
    await rerenderHook();

    expect(sendMessageCalls).toHaveLength(1);
    expect(queueOf('ses_auto')).toHaveLength(1);
    expect(useInlineCommentDraftStore.getState().getDrafts({ directory: DIRECTORY, sessionKey: 'ses_auto' })).toEqual([]);
    expect(useInputStore.getState().consumePendingSyntheticParts(target)).toBeNull();

    cleanupPersistedSessionState({
      runtimeKey: getRuntimeKey(),
      directory: target.directory,
      sessionId: target.sessionId,
    });
    expect(queueOf('ses_auto')).toHaveLength(1);

    await act(async () => {
      rejectSend?.(new Error('deleted session send failed'));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(sendMessageCalls).toHaveLength(1);
    expect(queueOf('ses_auto')).toEqual([]);
    expect(useMessageQueueStore.getState().getQueueDispatchState(target).sendingIds).toEqual([]);
    expect(useInlineCommentDraftStore.getState().getDrafts({ directory: DIRECTORY, sessionKey: 'ses_auto' })).toEqual([]);
    expect(useInputStore.getState().consumePendingSyntheticParts(target)).toBeNull();

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2_100));
      await Promise.resolve();
    });
    expect(sendMessageCalls).toHaveLength(1);
  });

  test('restores context on failure and sends it once on retry', async () => {
    let rejectSend: ((error: Error) => void) | undefined;
    sendMessageOutcome = new Promise<void>((_resolve, reject) => {
      rejectSend = reject;
    });
    primeQueue('ses_auto');
    primeContext('ses_auto');
    await mountHook();

    act(() => {
      setDirectorySessionStatus('ses_auto', 'idle');
    });
    await rerenderHook();
    await act(async () => {
      rejectSend?.(new Error('test send failure'));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(queueOf('ses_auto')).toHaveLength(1);
    expect(useInlineCommentDraftStore.getState().getDrafts({ directory: DIRECTORY, sessionKey: 'ses_auto' })).toHaveLength(1);
    sendMessageOutcome = Promise.resolve();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2_100));
      await Promise.resolve();
    });

    expect(sendMessageCalls).toHaveLength(2);
    const retriedAdditionalParts = sendMessageCalls[1]?.[6];
    if (!Array.isArray(retriedAdditionalParts)) throw new Error('retry additional parts were not sent');
    expect(retriedAdditionalParts[0]?.text).toContain('please update this');
    expect(retriedAdditionalParts[1]).toEqual({ text: 'pending synthetic context', synthetic: true });
    expect(useInlineCommentDraftStore.getState().getDrafts({ directory: DIRECTORY, sessionKey: 'ses_auto' })).toEqual([]);
    expect(useInputStore.getState().pendingSyntheticParts).toBeNull();
    expect(queueOf('ses_auto')).toHaveLength(0);
  });

  test('keeps same-target context on its queued item across an earlier failure', async () => {
    let rejectFirst: ((error: Error) => void) | undefined;
    const firstAttempt = new Promise<void>((_resolve, reject) => {
      rejectFirst = reject;
    });
    sendMessageOutcomes = [firstAttempt, Promise.resolve(), Promise.resolve()];

    const target = createMessageQueueTarget('ses_auto', DIRECTORY, getRuntimeKey());
    if (!target) throw new Error('queue target derivation failed');
    const draftTarget = { directory: DIRECTORY, sessionKey: target.sessionId };
    const captureQueueContext = (label: string) => {
      useInputStore.getState().setPendingSyntheticParts([{ text: `synthetic ${label}`, synthetic: true }]);
      useInlineCommentDraftStore.getState().addDraft(draftTarget, {
        source: 'diff',
        fileLabel: `src/${label}.ts`,
        startLine: 1,
        endLine: 1,
        code: `const ${label} = true;`,
        language: 'ts',
        text: `inline ${label}`,
      });
      return captureComposerContextForQueue(target, draftTarget);
    };
    const contextA = captureQueueContext('A');
    useMessageQueueStore.getState().addToQueue(target, {
      content: 'queued A',
      additionalParts: contextA,
      contextClaimed: true,
      sendConfig: { providerID: 'provider-a', modelID: 'model-a' },
    });
    const contextB = captureQueueContext('B');
    useMessageQueueStore.getState().addToQueue(target, {
      content: 'queued B',
      additionalParts: contextB,
      contextClaimed: true,
      sendConfig: { providerID: 'provider-b', modelID: 'model-b' },
    });
    expect(useInlineCommentDraftStore.getState().getDrafts(draftTarget)).toEqual([]);

    await mountHook();
    act(() => {
      setDirectorySessionStatus('ses_auto', 'idle');
    });
    await rerenderHook();

    expect(sendMessageCalls).toHaveLength(1);
    expect(sendMessageCalls[0]?.[0]).toBe('queued A');
    const firstAdditionalParts = sendMessageCalls[0]?.[6];
    if (!Array.isArray(firstAdditionalParts)) throw new Error('first context was not sent');
    expect(firstAdditionalParts[0]?.text).toContain('inline A');
    expect(firstAdditionalParts[1]).toEqual({ text: 'synthetic A', synthetic: true });

    await act(async () => {
      rejectFirst?.(new Error('test send failure'));
      await Promise.resolve();
      await Promise.resolve();
    });

    // Model the failed send's context being restored to the target-scoped
    // handoff bucket. The next queue item must not consume it.
    useInputStore.getState().setPendingSyntheticParts([{ text: 'restored A', synthetic: true }], target);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2_100));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(sendMessageCalls).toHaveLength(3);
    expect(sendMessageCalls[1]?.[0]).toBe('queued A');
    const retriedAdditionalParts = sendMessageCalls[1]?.[6];
    if (!Array.isArray(retriedAdditionalParts)) throw new Error('retried context was not sent');
    expect(retriedAdditionalParts[0]?.text).toContain('inline A');
    expect(retriedAdditionalParts[1]).toEqual({ text: 'synthetic A', synthetic: true });
    expect(sendMessageCalls[2]?.[0]).toBe('queued B');
    const secondAdditionalParts = sendMessageCalls[2]?.[6];
    if (!Array.isArray(secondAdditionalParts)) throw new Error('second context was not sent');
    expect(secondAdditionalParts[0]?.text).toContain('inline B');
    expect(secondAdditionalParts[1]).toEqual({ text: 'synthetic B', synthetic: true });
    expect(useInputStore.getState().consumePendingSyntheticParts(target)).toEqual([
      { text: 'restored A', synthetic: true },
    ]);
    expect(queueOf('ses_auto')).toHaveLength(0);
  });
});
