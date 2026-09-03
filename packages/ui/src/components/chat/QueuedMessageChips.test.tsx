import { beforeEach, afterEach, describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// ---- Module mocks (declared before importing modules-under-test) ----

// Controlled session activity phase. Mocking the hook keeps the deep
// sync-context import chain out of this render test.
type ActivityPhase = 'idle' | 'busy' | 'retry';

type ActivityState = { phase: ActivityPhase };

const activityMockState: ActivityState = { phase: 'idle' };

mock.module('@/hooks/useSessionActivity', () => ({
  useSessionActivity: () => ({
    phase: activityMockState.phase,
    isWorking: activityMockState.phase !== 'idle',
    isBusy: activityMockState.phase !== 'idle',
    isCooldown: false,
  }),
}));

// The component only reads currentSessionId and getDirectoryForSession;
// QueuedMessageChips selects these exact fields on the real store.
type SessionUIStateStub = {
  currentSessionId: string | null;
  getDirectoryForSession: (sessionId: string) => string | null;
};

const sessionUIState: SessionUIStateStub = {
  currentSessionId: 'ses_test',
  getDirectoryForSession: (sessionId: string): string | null => {
    void sessionId;
    return '/repo';
  },
};

mock.module('@/sync/session-ui-store', () => ({
  useSessionUIStore: <T,>(selector: (state: SessionUIStateStub) => T): T => selector(sessionUIState),
}));

mock.module('@/lib/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

mock.module('@/lib/runtime-switch', () => ({
  getRuntimeKey: () => 'test-runtime',
}));

  // The component reads only runsByOriginalSessionID for the current session.
  type AutoReviewStateStub = {
  runsByOriginalSessionID: Record<string, { originalSessionID: string; directory: string; status: string; runtimeKey: string }>;
};

const autoReviewMockState: AutoReviewStateStub = { runsByOriginalSessionID: {} };

mock.module('@/stores/useAutoReviewStore', () => ({
  useAutoReviewStore: <T,>(selector: (state: AutoReviewStateStub) => T): T => selector(autoReviewMockState),
}));

// Real stores: message queue and input.
import {
    createMessageQueueTarget,
    useMessageQueueStore,
    type MessageQueueTarget,
    type QueuedMessage,
} from '@/stores/messageQueueStore';
import { QueuedMessageChips } from './QueuedMessageChips';

const DIRECTORY = '/repo';

const buildTarget = (): MessageQueueTarget => {
  const target = createMessageQueueTarget('ses_test', DIRECTORY, 'test-runtime');
  if (!target) throw new Error('test target derivation failed');
  return target;
};

const resetMockStates = () => {
  activityMockState.phase = 'idle';
  sessionUIState.currentSessionId = 'ses_test';
  autoReviewMockState.runsByOriginalSessionID = {};
};

describe('QueuedMessageChips', () => {
  let windowInstance: Window;
  let host: HTMLDivElement;
  let root: Root;

  const renderChips = async (
    onEditMessage: (
      content: string,
      attachments?: QueuedMessage['attachments'],
      additionalParts?: QueuedMessage['additionalParts'],
    ) => void = () => {},
    onSendMessage: (messageId: string) => void = () => {},
  ) => {
    await act(async () => {
      root.render(<QueuedMessageChips onEditMessage={onEditMessage} onSendMessage={onSendMessage} />);
    });
  };

  const findSendButton = (): HTMLButtonElement | null =>
    Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'chat.queuedMessage.send') ?? null;

  beforeEach(() => {
    resetMockStates();
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

    useMessageQueueStore.setState({ queuedMessages: {}, sendingIds: {} });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    windowInstance.close();
  });

  test('busy session renders waiting status and disables chip send', async () => {
    activityMockState.phase = 'busy';
    const target = buildTarget();
    act(() => {
      useMessageQueueStore.getState().addToQueue(target, { content: 'queued prompt' });
    });

    await renderChips();

    expect(host.textContent).toContain('chat.queuedMessage.title');
    expect(host.textContent).toContain('chat.queuedMessage.waiting');
    expect(host.querySelector<SVGElement>('use[href="#oc-loader-4"]')).not.toBeNull();
    expect(host.querySelector<SVGElement>('use[href="#oc-time"]')).toBeNull();

    const sendButton = findSendButton();
    expect(sendButton).not.toBeNull();
    expect(sendButton?.disabled).toBe(true);

    const editText = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent === 'chat.queuedMessage.edit',
    );
    expect(editText?.disabled).toBe(false);
    const removeButton = host.querySelector<HTMLElement>('[aria-label="chat.queuedMessage.removeAria"]');
    expect(removeButton).not.toBeNull();
    expect(removeButton?.hasAttribute('disabled')).toBe(false);
  });

  test('idle session enables send and shows the time icon', async () => {
    activityMockState.phase = 'idle';
    const target = buildTarget();
    act(() => {
      useMessageQueueStore.getState().addToQueue(target, { content: 'queued prompt' });
    });

    await renderChips();

    expect(host.textContent).not.toContain('chat.queuedMessage.waiting');
    expect(host.querySelector<SVGElement>('use[href="#oc-loader-4"]')).toBeNull();
    expect(host.querySelector<SVGElement>('use[href="#oc-time"]')).not.toBeNull();

    const sendButton = findSendButton();
    expect(sendButton).not.toBeNull();
    expect(sendButton?.disabled).toBe(false);
  });

  test('only enables the queue head and disables all chips while it is in flight', async () => {
    const target = buildTarget();
    act(() => {
      useMessageQueueStore.getState().addToQueue(target, { content: 'head prompt' });
      useMessageQueueStore.getState().addToQueue(target, { content: 'later prompt' });
    });

    await renderChips();

    const sendButtons = () => Array.from(host.querySelectorAll('button')).filter(
      (button) => button.textContent === 'chat.queuedMessage.send',
    );
    expect(sendButtons()).toHaveLength(2);
    expect(sendButtons()[0]?.disabled).toBe(false);
    expect(sendButtons()[1]?.disabled).toBe(true);

    const [head] = useMessageQueueStore.getState().getQueueForTarget(target);
    if (!head) throw new Error('queue head was not created');
    act(() => {
      useMessageQueueStore.getState().markSending(target, head.id);
    });
    await renderChips();

    expect(sendButtons()[0]?.disabled).toBe(true);
    expect(sendButtons()[1]?.disabled).toBe(true);
    expect(useMessageQueueStore.getState().getQueueForTarget(target)).toHaveLength(2);

    const editButtons = () => Array.from(host.querySelectorAll('button')).filter(
      (button) => button.textContent === 'chat.queuedMessage.edit',
    );
    const removeButtons = () => Array.from(host.querySelectorAll('button')).filter(
      (button) => button.getAttribute('aria-label') === 'chat.queuedMessage.removeAria',
    );
    expect(editButtons()[0]?.disabled).toBe(true);
    expect(editButtons()[1]?.disabled).toBe(false);
    expect(removeButtons()[0]?.disabled).toBe(true);
    expect(removeButtons()[1]?.disabled).toBe(false);
  });

  test('preserves queued additional parts when editing a message', async () => {
    const target = buildTarget();
    const additionalParts = [{ text: 'rendered magic instructions', synthetic: true }];
    act(() => {
      useMessageQueueStore.getState().addToQueue(target, {
        content: 'rendered magic prompt',
        additionalParts,
      });
    });

    let edited: {
      content: string;
      additionalParts?: QueuedMessage['additionalParts'];
    } | null = null;
    await renderChips((content, _attachments, parts) => {
      edited = { content, additionalParts: parts };
    });

    const editButton = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent === 'chat.queuedMessage.edit',
    );
    if (!editButton) throw new Error('queued edit button was not rendered');
    await act(async () => editButton.click());

    expect(edited).toEqual({ content: 'rendered magic prompt', additionalParts });
    expect(useMessageQueueStore.getState().getQueueForTarget(target)).toEqual([]);
  });

  test('busy→idle transition clears waiting and enables send', async () => {
    activityMockState.phase = 'busy';
    const target = buildTarget();
    act(() => {
      useMessageQueueStore.getState().addToQueue(target, { content: 'queued prompt' });
    });

    await renderChips();

    expect(findSendButton()?.disabled).toBe(true);
    expect(host.querySelector<SVGElement>('use[href="#oc-loader-4"]')).not.toBeNull();

    act(() => {
      activityMockState.phase = 'idle';
    });
    await renderChips();

    expect(host.textContent).not.toContain('chat.queuedMessage.waiting');
    expect(host.querySelector<SVGElement>('use[href="#oc-loader-4"]')).toBeNull();

    const sendButton = findSendButton();
    expect(sendButton).not.toBeNull();
    expect(sendButton?.disabled).toBe(false);
  });

  test('auto-review run keeps the send disabled while the session phase is idle', async () => {
    activityMockState.phase = 'idle';
    autoReviewMockState.runsByOriginalSessionID = {
      ses_test: { originalSessionID: 'ses_test', directory: DIRECTORY, status: 'running', runtimeKey: 'test-runtime' },
    };
    const target = buildTarget();
    act(() => {
      useMessageQueueStore.getState().addToQueue(target, { content: 'queued prompt' });
    });

    await renderChips();

    expect(host.textContent).toContain('chat.queuedMessage.waiting');
    const sendButton = findSendButton();
    expect(sendButton).not.toBeNull();
    expect(sendButton?.disabled).toBe(true);
  });
});
