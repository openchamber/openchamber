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

    await runtime.setEnabled({ enabled: true, policies: {}, directories: [] });

    expect(runtime.snapshot()).toEqual({ enabled: true });
    expect(broadcastGlobalUiEvent).toHaveBeenCalledWith({
      type: 'openchamber:background-auto-accept',
      properties: { enabled: true },
    });
  });

  it('replies once for a matching permission', async () => {
    const fetchImpl = vi.fn(async (_url, options = {}) => new Response(
      options.method === 'POST' ? '{}' : '[]',
      { status: 200 },
    ));
    const { runtime, emit } = createRuntime(fetchImpl);
    await runtime.setEnabled({ enabled: true, policies: { session: true }, directories: [] });

    emit({
      directory: '/project',
      payload: { type: 'permission.asked', properties: { id: 'permission', sessionID: 'session' } },
    });
    for (let index = 0; index < 10; index += 1) await Promise.resolve();

    const posts = fetchImpl.mock.calls.filter(([, options]) => options?.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0][0].toString()).toBe('http://opencode.test/permission/permission/reply?directory=%2Fproject');
  });

  it('lets an explicit child policy override its parent', async () => {
    const fetchImpl = vi.fn(async () => new Response('[]', { status: 200 }));
    const { runtime, emit } = createRuntime(fetchImpl);
    emit({ payload: { type: 'session.created', properties: { info: { id: 'child', parentID: 'parent' } } } });
    await runtime.setEnabled({ enabled: true, policies: { parent: true, child: false }, directories: [] });

    emit({ payload: { type: 'permission.asked', properties: { id: 'permission', sessionID: 'child' } } });
    for (let index = 0; index < 10; index += 1) await Promise.resolve();

    expect(fetchImpl.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(0);
  });
});
