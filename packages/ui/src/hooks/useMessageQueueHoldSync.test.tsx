import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import type { MessageQueueUpdatedEvent } from '@/stores/messageQueueStore';

type HoldCall = {
  directory: string;
  generation: number;
  held: boolean;
  sequence: number;
};

const calls: HoldCall[] = [];
let activeRuntimeKey = 'runtime-a';

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: async (_path: string, init?: { body?: BodyInit | null }) => {
    // SAFETY: The hook's hold request always sends these four primitive fields;
    // the mock records only those fields and ignores the client token.
    const body = JSON.parse(String(init?.body)) as HoldCall;
    const call = {
      directory: body.directory,
      generation: body.generation,
      held: body.held,
      sequence: body.sequence,
    };
    calls.push(call);
    return new Response(JSON.stringify({
      held: call.held,
      expiresAt: call.held ? 100 : null,
      sequence: call.sequence,
    }));
  },
}));
mock.module('@/lib/desktop', () => ({ isVSCodeRuntime: () => false }));
mock.module('@/lib/runtime-switch', () => ({
  getRuntimeKey: () => activeRuntimeKey,
  getRuntimeApiBaseUrl: () => 'http://runtime-a.test',
}));
mock.module('@/lib/runtime-auth', () => ({
  getRuntimeBearerTokenSync: () => undefined,
  getRuntimeExtraHeadersSync: () => ({}),
  getRuntimeUrlAuthTokenSync: () => undefined,
}));
mock.module('@/lib/persistence', () => ({
  loadDesktopSettings: async () => ({}),
  updateDesktopSettings: async () => undefined,
}));

const {
  applyMessageQueueUpdatedEvent,
  useMessageQueueStore,
} = await import('@/stores/messageQueueStore');
const { useAutoReviewStore } = await import('@/stores/useAutoReviewStore');
const { useMessageQueueHoldSync } = await import('./useMessageQueueHoldSync');

const sessionUpdate = (
  sessionId: string,
  directory: string,
  generation: number,
  deleted = false,
): MessageQueueUpdatedEvent => ({
  type: 'openchamber:message-queue.updated',
  properties: {
    revision: generation,
    session: (() => {
      const session: MessageQueueUpdatedEvent['properties']['session'] = {
        sessionId,
        directory,
        items: [],
        sendingId: null,
        generation,
      };
      if (deleted) session.deleted = true;
      return session;
    })(),
  },
});

const HookHarness = () => {
  useMessageQueueHoldSync();
  return null;
};

describe('useMessageQueueHoldSync identity reconciliation', () => {
  let windowInstance: Window;
  let root: Root;
  let host: HTMLDivElement;

  const mount = async () => {
    await act(async () => {
      root.render(React.createElement(HookHarness));
    });
  };

  const updateSession = async (sessionId: string, directory: string, generation: number, deleted = false) => {
    await act(async () => {
      applyMessageQueueUpdatedEvent(sessionUpdate(sessionId, directory, generation, deleted), activeRuntimeKey);
      await Promise.resolve();
    });
  };

  beforeEach(() => {
    activeRuntimeKey = 'runtime-a';
    calls.length = 0;
    windowInstance = new Window({ url: 'http://localhost/' });
    Object.assign(globalThis, {
      window: windowInstance,
      document: windowInstance.document,
      HTMLElement: windowInstance.HTMLElement,
      Element: windowInstance.Element,
      Node: windowInstance.Node,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    useAutoReviewStore.setState({ runsByOriginalSessionID: {} });
    useMessageQueueStore.setState({ serverSessionIdentityVersion: 0 });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    windowInstance.close();
  });

  test('releases the deleted incarnation and holds the recreated same-ID session', async () => {
    const sessionId = 'same-id-recreated';
    await updateSession(sessionId, '/repo', 1);
    useAutoReviewStore.getState().upsertRun({
      originalSessionID: sessionId,
      reviewSessionID: 'review-session',
      directory: '/repo',
      runtimeKey: activeRuntimeKey,
      status: 'running',
      phase: 'waiting_for_reviewer',
      iteration: 1,
      maxIterations: 3,
    });
    await mount();

    await updateSession(sessionId, '/repo', 2, true);
    await updateSession(sessionId, '/repo', 3);

    expect(calls).toEqual([
      { directory: '/repo', generation: 1, held: true, sequence: 1 },
      { directory: '/repo', generation: 1, held: false, sequence: 2 },
      { directory: '/repo', generation: 3, held: true, sequence: 3 },
    ]);
  });

  test('releases the old directory target and holds the moved session', async () => {
    const sessionId = 'directory-moved';
    await updateSession(sessionId, '/repo/old', 1);
    useAutoReviewStore.getState().upsertRun({
      originalSessionID: sessionId,
      reviewSessionID: 'review-session',
      directory: '/repo/old',
      runtimeKey: activeRuntimeKey,
      status: 'running',
      phase: 'waiting_for_reviewer',
      iteration: 1,
      maxIterations: 3,
    });
    await mount();

    await updateSession(sessionId, '/repo/new', 1);

    expect(calls).toEqual([
      { directory: '/repo/old', generation: 1, held: true, sequence: 1 },
      { directory: '/repo/old', generation: 1, held: false, sequence: 2 },
      { directory: '/repo/new', generation: 1, held: true, sequence: 3 },
    ]);
  });

  test('releases the active hold when the hook unmounts', async () => {
    const sessionId = 'unmounted';
    await updateSession(sessionId, '/repo', 1);
    useAutoReviewStore.getState().upsertRun({
      originalSessionID: sessionId,
      reviewSessionID: 'review-session',
      directory: '/repo',
      runtimeKey: activeRuntimeKey,
      status: 'running',
      phase: 'waiting_for_reviewer',
      iteration: 1,
      maxIterations: 3,
    });
    await mount();

    await act(async () => root.unmount());

    expect(calls).toEqual([
      { directory: '/repo', generation: 1, held: true, sequence: 1 },
      { directory: '/repo', generation: 1, held: false, sequence: 2 },
    ]);
  });
});
