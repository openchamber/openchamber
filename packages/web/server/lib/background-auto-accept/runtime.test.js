import { describe, expect, it, vi } from 'vitest';
import { createBackgroundAutoAcceptRuntime } from './runtime.js';

const createRuntime = (fetchImpl = vi.fn(async () => new Response('[]', { status: 200 }))) => {
  let eventHandler;
  const broadcastGlobalUiEvent = vi.fn();
  const runtime = createBackgroundAutoAcceptRuntime({
    globalEventHub: {
      start: vi.fn(),
      subscribeEvent(handler) { eventHandler = handler; return () => {}; },
    },
    buildOpenCodeUrl: (path) => `http://opencode.test${path}`,
    getOpenCodeAuthHeaders: () => ({}),
    broadcastGlobalUiEvent,
    fetchImpl,
  });
  runtime.start();
  return { runtime, broadcastGlobalUiEvent, emit: (event) => eventHandler(event) };
};

describe('background auto-accept runtime', () => {
  it('defaults off and broadcasts mode changes', async () => {
    const { runtime, broadcastGlobalUiEvent } = createRuntime();
    expect(runtime.snapshot()).toEqual({ enabled: false });

    await runtime.setEnabled({ enabled: true, policies: {} });

    expect(runtime.snapshot()).toEqual({ enabled: true });
    expect(broadcastGlobalUiEvent).toHaveBeenCalledWith({
      type: 'openchamber:background-auto-accept',
      properties: { enabled: true },
    });
  });

  it.each([
    { backgroundEnabled: false, sessionAutoAccepting: false, expectedReplies: 0, scenario: 'background off, auto-accept off' },
    { backgroundEnabled: false, sessionAutoAccepting: true, expectedReplies: 0, scenario: 'background off, auto-accept on' },
    { backgroundEnabled: true, sessionAutoAccepting: false, expectedReplies: 0, scenario: 'background on, auto-accept off' },
    { backgroundEnabled: true, sessionAutoAccepting: true, expectedReplies: 1, scenario: 'background on, auto-accept on' },
  ])('uses the server executor for $scenario', async ({
    backgroundEnabled,
    sessionAutoAccepting,
    expectedReplies,
  }) => {
    const fetchImpl = vi.fn(async (_url, options = {}) => new Response(
      options.method === 'POST' ? '{}' : '[]',
      { status: 200 },
    ));
    const { runtime, emit } = createRuntime(fetchImpl);
    if (backgroundEnabled) {
      await runtime.setEnabled({
        enabled: true,
        policies: { session: sessionAutoAccepting },
      });
    }

    emit({
      directory: '/project',
      payload: { type: 'permission.asked', properties: { id: 'matrix-permission', sessionID: 'session' } },
    });
    for (let index = 0; index < 10; index += 1) await Promise.resolve();

    const posts = fetchImpl.mock.calls.filter(([, options]) => options?.method === 'POST');
    expect(posts).toHaveLength(expectedReplies);
    if (expectedReplies === 1) {
      expect(posts[0][0].toString()).toBe(
        'http://opencode.test/permission/matrix-permission/reply?directory=%2Fproject',
      );
    }
  });
});
