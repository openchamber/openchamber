import { beforeEach, describe, expect, mock, test } from 'bun:test';

let runtimeKey = 'url:https://instance-a';
let responseFactory: (() => Response) | null = null;
const fetchedPaths: string[] = [];

const json = (body: unknown) => new Response(
  JSON.stringify(body),
  { status: 200, headers: { 'content-type': 'application/json' } },
);

// Spread the real modules so the overrides stay a patch: `mock.module` is
// process-global, and a partial replacement would break every other module
// that imports something else from these files.
const runtimeSwitch = await import('@/lib/runtime-switch');
mock.module('@/lib/runtime-switch', () => ({ ...runtimeSwitch, getRuntimeKey: () => runtimeKey }));

const runtimeFetchModule = await import('@/lib/runtime-fetch');
mock.module('@/lib/runtime-fetch', () => ({
  ...runtimeFetchModule,
  runtimeFetch: async (path: string) => {
    fetchedPaths.push(path);
    if (!responseFactory) throw new Error('network down');
    return responseFactory();
  },
}));

const {
  applyResolvedModelUpdatedEvent,
  resyncResolvedModels,
  useResolvedModelStore,
} = await import('./resolvedModelStore');

const entry = (sessionId: string, model: string, updatedAt: number) => ({ sessionId, model, updatedAt });
const event = (sessionId: string, model: string, updatedAt: number) => ({
  type: 'openchamber:resolved-model' as const,
  properties: entry(sessionId, model, updatedAt),
});
// Simulates the untrusted side of the stream: payloads arrive as unknown and
// the schema decides what is usable.
const apply = (payload: unknown) => applyResolvedModelUpdatedEvent(
  payload as Parameters<typeof applyResolvedModelUpdatedEvent>[0],
  runtimeKey,
);

describe('resolved model projection', () => {
  beforeEach(() => {
    runtimeKey = 'url:https://instance-a';
    responseFactory = null;
    fetchedPaths.length = 0;
    useResolvedModelStore.setState({ bySessionId: new Map() });
  });

  test('applies a valid event and ignores unrelated or malformed payloads', () => {
    apply(event('ses_1', 'deepseek', 1));

    expect(useResolvedModelStore.getState().bySessionId.get('ses_1')).toEqual(entry('ses_1', 'deepseek', 1));

    apply({ type: 'session-created' });
    apply({ type: 'openchamber:resolved-model', properties: { sessionId: 'ses_2' } });
    apply({ type: 'openchamber:resolved-model', properties: entry('ses_2', 'model', Number.NaN) });

    expect(useResolvedModelStore.getState().bySessionId.size).toBe(1);
  });

  test('ignores an event that belongs to another runtime', () => {
    applyResolvedModelUpdatedEvent(event('ses_1', 'deepseek', 1), 'url:https://instance-b');
    expect(useResolvedModelStore.getState().bySessionId.size).toBe(0);
  });

  test('replays lose to newer observations and untouched sessions keep their reference', () => {
    apply(event('ses_1', 'deepseek', 1));
    apply(event('ses_2', 'other', 1));
    const untouched = useResolvedModelStore.getState().bySessionId.get('ses_2');

    apply(event('ses_1', 'deepseek-v2', 5));
    apply(event('ses_1', 'deepseek-stale', 2));

    const state = useResolvedModelStore.getState().bySessionId;
    expect(state.get('ses_1')?.model).toBe('deepseek-v2');
    expect(state.get('ses_2')).toBe(untouched);
  });

  test('resync replaces the projection from the snapshot', async () => {
    useResolvedModelStore.setState({ bySessionId: new Map([['ses_stale', entry('ses_stale', 'old', 1)]]) });
    responseFactory = () => json({
      sessions: [entry('ses_1', 'deepseek', 1), entry('ses_2', 'other', 2)],
      serverTime: 3,
    });

    await resyncResolvedModels();

    expect(fetchedPaths).toEqual(['/api/resolved-model']);
    expect([...useResolvedModelStore.getState().bySessionId.keys()]).toEqual(['ses_1', 'ses_2']);
  });

  test('a failed resync preserves the previous projection', async () => {
    applyResolvedModelUpdatedEvent(event('ses_1', 'deepseek', 1), runtimeKey);

    await expect(resyncResolvedModels()).rejects.toThrow();
    expect(useResolvedModelStore.getState().bySessionId.get('ses_1')?.model).toBe('deepseek');

    responseFactory = () => json({ sessions: [{ sessionId: 'ses_1' }], serverTime: 2 });
    await expect(resyncResolvedModels()).rejects.toThrow('Invalid resolved model response');
    expect(useResolvedModelStore.getState().bySessionId.get('ses_1')?.model).toBe('deepseek');
  });

  test('a runtime switch during the fetch discards the response', async () => {
    responseFactory = () => {
      runtimeKey = 'url:https://instance-b';
      return json({ sessions: [entry('ses_1', 'deepseek', 1)], serverTime: 2 });
    };

    await resyncResolvedModels();

    expect(useResolvedModelStore.getState().bySessionId.size).toBe(0);
  });
});
