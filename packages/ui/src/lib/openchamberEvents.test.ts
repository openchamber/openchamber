import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

mock.module('./runtime-url', () => ({
  getRuntimeUrlResolver: () => ({ sse: (path: string) => `http://runtime.test${path}` }),
}));

mock.module('./runtime-switch', () => ({
  subscribeRuntimeEndpointChanged: () => () => undefined,
}));

import { __resetOpenChamberEventBusForTesting, publishOpenChamberBusEvent, setWsEventPipelineActive } from './openchamberEventBus';

class MockEventSource {
  static CLOSED = 2;
  static instances: MockEventSource[] = [];

  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public readonly url: string) {
    MockEventSource.instances.push(this);
  }

  close() {
    this.readyState = MockEventSource.CLOSED;
  }
}

describe('openchamber events', () => {
  beforeEach(() => {
    MockEventSource.instances = [];
    globalThis.window = {} as Window & typeof globalThis;
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    __resetOpenChamberEventBusForTesting();
  });

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { EventSource?: unknown }).EventSource;
  });

  test('dispatches externally created session events', async () => {
    const { subscribeOpenchamberEvents } = await import('./openchamberEvents');
    const events: unknown[] = [];
    const listener = (event: unknown) => events.push(event);
    const unsubscribe = subscribeOpenchamberEvents(listener);
    const source = MockEventSource.instances[0];

    source.onmessage?.({
      data: JSON.stringify({
        type: 'openchamber:session-created',
        properties: {
          sessionId: 'ses_123',
          directory: '/repo/worktrees/research',
          projectId: 'project_1',
          createdAt: 123,
          promptDispatched: true,
          dispatchedAsCommand: false,
        },
      }),
    });

    expect(events).toEqual([
      {
        type: 'session-created',
        sessionId: 'ses_123',
        directory: '/repo/worktrees/research',
        projectId: 'project_1',
        createdAt: 123,
        promptDispatched: true,
        dispatchedAsCommand: false,
      },
    ]);
    unsubscribe();
  });

  test('delivers bus events via dispatchFromEnvelope when WS is active', async () => {
    setWsEventPipelineActive(true);

    const { subscribeOpenchamberEvents } = await import('./openchamberEvents');
    const events: unknown[] = [];
    const unsubscribe = subscribeOpenchamberEvents((event) => events.push(event));

    publishOpenChamberBusEvent({
      type: 'openchamber:session-created',
      properties: {
        sessionId: 'ses_bus',
        directory: '/repo/worktrees/bus',
        createdAt: 999,
        promptDispatched: true,
        dispatchedAsCommand: false,
      },
    });

    expect(events).toEqual([
      {
        type: 'session-created',
        sessionId: 'ses_bus',
        directory: '/repo/worktrees/bus',
        createdAt: 999,
        promptDispatched: true,
        dispatchedAsCommand: false,
      },
    ]);

    expect(MockEventSource.instances).toHaveLength(0);
    unsubscribe();
  });

  test('does not open EventSource when WS pipeline is active', async () => {
    setWsEventPipelineActive(true);

    const { subscribeOpenchamberEvents } = await import('./openchamberEvents');
    const unsubscribe = subscribeOpenchamberEvents(() => {});

    expect(MockEventSource.instances).toHaveLength(0);
    unsubscribe();
  });

  test('opens EventSource fallback when WS pipeline is inactive', async () => {
    const { subscribeOpenchamberEvents } = await import('./openchamberEvents');
    const unsubscribe = subscribeOpenchamberEvents(() => {});

    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0].url).toBe('http://runtime.test/api/openchamber/events');
    unsubscribe();
  });

  test('closes EventSource fallback when WS becomes active', async () => {
    const { subscribeOpenchamberEvents } = await import('./openchamberEvents');
    const unsubscribe = subscribeOpenchamberEvents(() => {});

    const source = MockEventSource.instances[0];
    expect(source.readyState).toBe(1);

    setWsEventPipelineActive(true);

    expect(source.readyState).toBe(MockEventSource.CLOSED);
    unsubscribe();
  });

  test('opens EventSource fallback when WS becomes inactive', async () => {
    setWsEventPipelineActive(true);

    const { subscribeOpenchamberEvents } = await import('./openchamberEvents');
    const unsubscribe = subscribeOpenchamberEvents(() => {});

    expect(MockEventSource.instances).toHaveLength(0);

    setWsEventPipelineActive(false);

    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0].url).toBe('http://runtime.test/api/openchamber/events');
    unsubscribe();
  });
});
