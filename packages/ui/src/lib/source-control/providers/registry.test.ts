import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';

import { getRuntimeKey } from '@/lib/runtime-switch';

import type { SourceControlProviderDescriptor } from './descriptor';
import { acmeDescriptor, githubLikeDescriptor, gitlabLikeDescriptor } from './descriptor.fixture';

const STORAGE_KEY = 'openchamber.sourceControlProviders.v1';
const store = new Map<string, string>();
const fakeStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => { store.set(key, value); },
};
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const fakeWindow: { localStorage: typeof fakeStorage; __OPENCHAMBER_API_BASE_URL__?: string } = { localStorage: fakeStorage };

/** Connects to a runtime the way the app does before any switch: through the injected API base URL. */
const connectTo = (name: string): string => {
  fakeWindow.__OPENCHAMBER_API_BASE_URL__ = `https://${name}.example`;
  return getRuntimeKey();
};

let loads = 0;
const loadRegistry = async () => {
  loads += 1;
  const module = await import(`./registry?load=${loads}-${Date.now()}`);
  return module.useSourceControlProviderRegistry;
};

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};

/** Lets a read the registry started itself (a scheduled retry) settle; a refresh would add a follow-up read. */
const settle = async () => {
  for (let tick = 0; tick < 10; tick += 1) await Promise.resolve();
};

const ids = (list: readonly SourceControlProviderDescriptor[]) => list.map((descriptor) => descriptor.id);

beforeEach(() => {
  store.clear();
  delete fakeWindow.__OPENCHAMBER_API_BASE_URL__;
  Object.defineProperty(globalThis, 'window', { value: fakeWindow, configurable: true });
});
afterEach(() => {
  jest.useRealTimers();
  if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

describe('source-control provider registry', () => {
  test('starts from the list remembered for this runtime and replaces it with the answer', async () => {
    const registry = await loadRegistry();
    registry.getState().resetForRuntimeSwitch(connectTo('runtime-a'));
    expect(registry.getState().status).toBe('idle');
    await registry.getState().refresh({ providers: async () => [githubLikeDescriptor(), gitlabLikeDescriptor()] });
    expect(registry.getState().status).toBe('ready');

    const reloaded = await loadRegistry();
    reloaded.getState().resetForRuntimeSwitch(connectTo('runtime-a'));
    expect(reloaded.getState().status).toBe('stale');
    expect(ids(reloaded.getState().ordered)).toEqual(['github', 'gitlab']);
    expect(reloaded.getState().byId.get('github')?.label).toBe('GitHub');
    // Another runtime has its own list.
    reloaded.getState().resetForRuntimeSwitch(connectTo('runtime-b'));
    expect(reloaded.getState().status).toBe('idle');
    expect(reloaded.getState().ordered).toEqual([]);
  });

  test('ignores a corrupt snapshot', async () => {
    store.set(STORAGE_KEY, '{not json');
    const registry = await loadRegistry();
    registry.getState().resetForRuntimeSwitch(connectTo('runtime-a'));
    expect(registry.getState()).toMatchObject({ status: 'idle', ordered: [] });
    store.set(STORAGE_KEY, JSON.stringify({ [connectTo('runtime-a')]: [] }));
    registry.getState().resetForRuntimeSwitch(connectTo('runtime-a'));
    expect(registry.getState()).toMatchObject({ status: 'idle', ordered: [] });
  });

  test('keeps the held list when a refresh fails and never turns a failure into an empty list', async () => {
    jest.useFakeTimers();
    const registry = await loadRegistry();
    registry.getState().resetForRuntimeSwitch(connectTo('runtime-a'));
    await registry.getState().refresh({ providers: async () => { throw new Error('offline'); } });
    expect(registry.getState()).toMatchObject({ status: 'error', ordered: [] });

    await registry.getState().refresh({ providers: async () => [acmeDescriptor()] });
    await registry.getState().refresh({ providers: async () => { throw new Error('offline'); } });
    expect(registry.getState().status).toBe('stale');
    expect(ids(registry.getState().ordered)).toEqual(['acme']);

    // An answered empty list is authoritative and survives a later failure too.
    await registry.getState().refresh({ providers: async () => [] });
    await registry.getState().refresh({ providers: async () => { throw new Error('offline'); } });
    expect(registry.getState()).toMatchObject({ status: 'stale', ordered: [] });
  });

  test('answers refreshes made during a read with one more read after it', async () => {
    const registry = await loadRegistry();
    registry.getState().resetForRuntimeSwitch(connectTo('runtime-a'));
    const answers = [deferred<SourceControlProviderDescriptor[]>(), deferred<SourceControlProviderDescriptor[]>()];
    let calls = 0;
    const sourceControl = { providers: () => { calls += 1; return answers[calls - 1]?.promise ?? Promise.resolve([]); } };
    const first = registry.getState().refresh(sourceControl);
    // The server announced a change after the first read went out: its answer may predate it.
    const second = registry.getState().refresh(sourceControl);
    const third = registry.getState().refresh(sourceControl);
    expect(registry.getState().status).toBe('loading');
    expect(calls).toBe(1);
    answers[0].resolve([githubLikeDescriptor()]);
    await first;
    await Promise.resolve();
    expect(calls).toBe(2);
    answers[1].resolve([githubLikeDescriptor(), acmeDescriptor()]);
    await Promise.all([second, third]);
    expect(calls).toBe(2);
    expect(registry.getState().status).toBe('ready');
    expect(ids(registry.getState().ordered)).toEqual(['github', 'acme']);
  });

  test('a runtime switch cancels the follow-up read of the previous runtime', async () => {
    const registry = await loadRegistry();
    registry.getState().resetForRuntimeSwitch(connectTo('runtime-a'));
    const late = deferred<SourceControlProviderDescriptor[]>();
    let calls = 0;
    const sourceControl = { providers: () => { calls += 1; return late.promise; } };
    void registry.getState().refresh(sourceControl);
    const followUp = registry.getState().refresh(sourceControl);
    registry.getState().resetForRuntimeSwitch(connectTo('runtime-b'));
    late.resolve([acmeDescriptor()]);
    await followUp;
    expect(calls).toBe(1);
    expect(registry.getState()).toMatchObject({ status: 'idle', ordered: [] });
  });

  test('a runtime switch drops a late answer from the previous runtime', async () => {
    const registry = await loadRegistry();
    registry.getState().resetForRuntimeSwitch(connectTo('runtime-a'));
    const late = deferred<SourceControlProviderDescriptor[]>();
    const pending = registry.getState().refresh({ providers: () => late.promise });
    registry.getState().resetForRuntimeSwitch(connectTo('runtime-b'));
    late.resolve([acmeDescriptor()]);
    await pending;
    expect(registry.getState()).toMatchObject({ runtimeKey: 'url:https://runtime-b.example', status: 'idle', ordered: [] });
    expect(store.get(STORAGE_KEY) ?? '').not.toContain('acme');

    const lateFailure = deferred<SourceControlProviderDescriptor[]>();
    await registry.getState().refresh({ providers: async () => [githubLikeDescriptor()] });
    const failing = registry.getState().refresh({ providers: () => lateFailure.promise });
    registry.getState().resetForRuntimeSwitch(connectTo('runtime-b'));
    lateFailure.reject(new Error('offline'));
    await failing;
    expect(registry.getState().status).toBe('stale');
    expect(ids(registry.getState().ordered)).toEqual(['github']);
  });

  test('reads the runtime key when it refreshes, not when the store was created', async () => {
    // The store is created during import, before the endpoint is initialized.
    const registry = await loadRegistry();
    expect(registry.getState().runtimeKey).toBe('url:default');
    await registry.getState().refresh({ providers: async () => [acmeDescriptor()] });
    // A transient key names no server: nothing is remembered under it.
    expect(store.get(STORAGE_KEY) ?? '[]').toBe('[]');

    const runtimeA = connectTo('runtime-a');
    store.set(STORAGE_KEY, JSON.stringify([[runtimeA, [githubLikeDescriptor()]]]));
    const answer = deferred<SourceControlProviderDescriptor[]>();
    const pending = registry.getState().refresh({ providers: () => answer.promise });
    // The runtime's own remembered list stands in while its server is asked.
    expect(registry.getState()).toMatchObject({ runtimeKey: runtimeA, status: 'loading', holdsList: true });
    expect(ids(registry.getState().ordered)).toEqual(['github']);
    answer.resolve([gitlabLikeDescriptor()]);
    await pending;
    expect(ids(registry.getState().ordered)).toEqual(['gitlab']);
    expect(JSON.parse(store.get(STORAGE_KEY) ?? '[]').map(([key]: [string]) => key)).toEqual([runtimeA]);
  });

  test('never makes a transient runtime key a snapshot slot', async () => {
    const registry = await loadRegistry();
    registry.getState().resetForRuntimeSwitch('mobile-disconnected');
    expect(registry.getState()).toMatchObject({ status: 'idle', holdsList: false });
    await registry.getState().refresh({ providers: async () => [acmeDescriptor()] });
    expect(store.get(STORAGE_KEY)).toBeUndefined();
  });

  test('reads which providers are served as unknown until a list is held, and retries a failure with a growing wait', async () => {
    jest.useFakeTimers();
    const registry = await loadRegistry();
    registry.getState().resetForRuntimeSwitch(connectTo('runtime-a'));
    let calls = 0;
    let answer: SourceControlProviderDescriptor[] | null = null;
    const sourceControl = {
      providers: async () => {
        calls += 1;
        if (!answer) throw new Error('offline');
        return answer;
      },
    };
    await registry.getState().refresh(sourceControl);
    expect(registry.getState()).toMatchObject({ status: 'error', holdsList: false });

    jest.advanceTimersByTime(1_999);
    expect(calls).toBe(1);
    jest.advanceTimersByTime(1);
    await settle();
    expect(calls).toBe(2);
    expect(registry.getState().status).toBe('error');

    // The wait doubles after each failure in a row.
    answer = [acmeDescriptor()];
    jest.advanceTimersByTime(3_999);
    expect(calls).toBe(2);
    jest.advanceTimersByTime(1);
    await settle();
    expect(calls).toBe(3);
    expect(registry.getState()).toMatchObject({ status: 'ready', holdsList: true });
    expect(ids(registry.getState().ordered)).toEqual(['acme']);

    // Nothing more is scheduled once it answered.
    jest.advanceTimersByTime(120_000);
    expect(calls).toBe(3);
  });

  test('a runtime switch cancels a scheduled retry', async () => {
    jest.useFakeTimers();
    const registry = await loadRegistry();
    registry.getState().resetForRuntimeSwitch(connectTo('runtime-a'));
    let calls = 0;
    await registry.getState().refresh({ providers: async () => { calls += 1; throw new Error('offline'); } });
    registry.getState().resetForRuntimeSwitch(connectTo('runtime-b'));
    jest.advanceTimersByTime(60_000);
    expect(calls).toBe(1);
  });

  test('keeps the held list objects when a refresh answers the same list', async () => {
    const registry = await loadRegistry();
    registry.getState().resetForRuntimeSwitch(connectTo('runtime-a'));
    await registry.getState().refresh({ providers: async () => [githubLikeDescriptor(), gitlabLikeDescriptor()] });
    const { ordered, byId } = registry.getState();
    let notified = 0;
    const unsubscribe = registry.subscribe((next: { ordered: unknown; byId: unknown }) => {
      if (next.ordered !== ordered || next.byId !== byId) notified += 1;
    });
    await registry.getState().refresh({ providers: async () => [githubLikeDescriptor(), gitlabLikeDescriptor()] });
    unsubscribe();
    expect(registry.getState().ordered).toBe(ordered);
    expect(registry.getState().byId).toBe(byId);
    expect(notified).toBe(0);

    // A remembered list the server confirms is kept too.
    const reloaded = await loadRegistry();
    reloaded.getState().resetForRuntimeSwitch(connectTo('runtime-a'));
    const remembered = reloaded.getState().ordered;
    await reloaded.getState().refresh({ providers: async () => [githubLikeDescriptor(), gitlabLikeDescriptor()] });
    expect(reloaded.getState()).toMatchObject({ status: 'ready' });
    expect(reloaded.getState().ordered).toBe(remembered);
  });
});
