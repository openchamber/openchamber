import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';

import { getRuntimeKey } from '@/lib/runtime-switch';

import { trackerDescriptorListSchema, unknownTrackerDescriptor } from './descriptor';
import { acmeTrackerDescriptor, linearLikeTrackerDescriptor } from './descriptor.fixture';
import { createTrackerUrlMatcher } from './matchTrackerUrl';
import { trackerPresentation } from './presentation';
import type { TrackerDescriptor } from './types';
import { acmeDescriptor } from '@/lib/source-control/providers/descriptor.fixture';
import { useSourceControlProviderRegistry } from '@/lib/source-control/providers/registry';

const STORAGE_KEY = 'openchamber.trackerProviders.v1';
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
  return module;
};

const ids = (list: readonly TrackerDescriptor[]) => list.map((descriptor) => descriptor.id);

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

describe('tracker registry', () => {
  test('reads an id it does not hold as the generic fallback', async () => {
    const { readTrackerDescriptor, useTrackerRegistry } = await loadRegistry();
    useTrackerRegistry.getState().resetForRuntimeSwitch(connectTo('runtime-a'));
    const fallback = readTrackerDescriptor('jira');
    expect(fallback).toEqual({
      id: 'jira',
      name: 'jira',
      authMethods: [],
      capabilities: {
        multipleAccounts: false, stateUpdate: false, children: false, labels: false, priority: false,
        filters: { people: false, priority: false }, projectMapping: false, sessionComments: false, hostAccess: false,
      },
      stateFilters: ['open', 'all'],
      urlPatterns: [],
      identifierPattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$',
    });
    // One stable object per id, so selectors do not re-render on every read.
    expect(readTrackerDescriptor('jira')).toBe(fallback);
    expect(unknownTrackerDescriptor('jira')).toBe(fallback);
    // It matches no link, and wears the generic mark.
    expect(createTrackerUrlMatcher([fallback])('https://jira.example.com/browse/OPS-1')).toBeNull();
    expect(trackerPresentation('jira').icon).toBe('record-circle');
    expect(trackerPresentation('linear').icon).toBe('linear');
  });

  test('starts from the list remembered for this runtime and replaces it with the answer', async () => {
    const { useTrackerRegistry } = await loadRegistry();
    useTrackerRegistry.getState().resetForRuntimeSwitch(connectTo('runtime-a'));
    expect(useTrackerRegistry.getState().status).toBe('idle');
    await useTrackerRegistry.getState().refresh({ providers: async () => [linearLikeTrackerDescriptor()] });
    expect(useTrackerRegistry.getState().status).toBe('ready');

    const reloaded = (await loadRegistry()).useTrackerRegistry;
    reloaded.getState().resetForRuntimeSwitch(connectTo('runtime-a'));
    expect(reloaded.getState().status).toBe('stale');
    expect(ids(reloaded.getState().ordered)).toEqual(['linear']);
    reloaded.getState().resetForRuntimeSwitch(connectTo('runtime-b'));
    expect(reloaded.getState()).toMatchObject({ status: 'idle', ordered: [] });
  });

  test('ignores a corrupt snapshot', async () => {
    store.set(STORAGE_KEY, '{not json');
    const { useTrackerRegistry } = await loadRegistry();
    useTrackerRegistry.getState().resetForRuntimeSwitch(connectTo('runtime-a'));
    expect(useTrackerRegistry.getState()).toMatchObject({ status: 'idle', ordered: [] });
  });

  test('keeps the held list when a refresh fails and never turns a failure into an empty list', async () => {
    jest.useFakeTimers();
    const { useTrackerRegistry } = await loadRegistry();
    useTrackerRegistry.getState().resetForRuntimeSwitch(connectTo('runtime-a'));
    await useTrackerRegistry.getState().refresh({ providers: async () => { throw new Error('offline'); } });
    expect(useTrackerRegistry.getState()).toMatchObject({ status: 'error', ordered: [] });

    await useTrackerRegistry.getState().refresh({ providers: async () => [linearLikeTrackerDescriptor()] });
    await useTrackerRegistry.getState().refresh({ providers: async () => { throw new Error('offline'); } });
    expect(useTrackerRegistry.getState().status).toBe('stale');
    expect(ids(useTrackerRegistry.getState().ordered)).toEqual(['linear']);
  });

  test('reads the runtime key when it refreshes and never writes under a transient one', async () => {
    const { useTrackerRegistry } = await loadRegistry();
    useTrackerRegistry.getState().resetForRuntimeSwitch('mobile-disconnected');
    await useTrackerRegistry.getState().refresh({ providers: async () => [linearLikeTrackerDescriptor()] });
    expect(store.get(STORAGE_KEY)).toBeUndefined();

    const runtimeA = connectTo('runtime-a');
    store.set(STORAGE_KEY, JSON.stringify([[runtimeA, [acmeTrackerDescriptor()]]]));
    let answer: (list: TrackerDescriptor[]) => void = () => {};
    const pending = useTrackerRegistry.getState().refresh({ providers: () => new Promise((resolve) => { answer = resolve; }) });
    expect(useTrackerRegistry.getState()).toMatchObject({ runtimeKey: runtimeA, status: 'loading', holdsList: true });
    expect(ids(useTrackerRegistry.getState().ordered)).toEqual(['acme-tickets']);
    answer([linearLikeTrackerDescriptor()]);
    await pending;
    expect(ids(useTrackerRegistry.getState().ordered)).toEqual(['linear']);
  });

  test('retries a failure with nothing to show, and keeps the held list objects on an unchanged answer', async () => {
    jest.useFakeTimers();
    const { useTrackerRegistry } = await loadRegistry();
    useTrackerRegistry.getState().resetForRuntimeSwitch(connectTo('runtime-a'));
    let calls = 0;
    let answer: TrackerDescriptor[] | null = null;
    const trackers = {
      providers: async () => {
        calls += 1;
        if (!answer) throw new Error('offline');
        return answer;
      },
    };
    await useTrackerRegistry.getState().refresh(trackers);
    expect(useTrackerRegistry.getState()).toMatchObject({ status: 'error', holdsList: false });
    answer = [linearLikeTrackerDescriptor()];
    jest.advanceTimersByTime(2_000);
    await useTrackerRegistry.getState().refresh(trackers);
    expect(calls).toBe(2);
    expect(useTrackerRegistry.getState()).toMatchObject({ status: 'ready', holdsList: true });

    const { ordered, byId } = useTrackerRegistry.getState();
    await useTrackerRegistry.getState().refresh({ providers: async () => [linearLikeTrackerDescriptor()] });
    expect(useTrackerRegistry.getState().ordered).toBe(ordered);
    expect(useTrackerRegistry.getState().byId).toBe(byId);
  });

  test('whenTrackerListHeld waits for a list, and gives up after its timeout', async () => {
    jest.useFakeTimers();
    const { useTrackerRegistry, whenTrackerListHeld } = await loadRegistry();
    useTrackerRegistry.getState().resetForRuntimeSwitch(connectTo('runtime-a'));
    const gaveUp = whenTrackerListHeld(1_000);
    jest.advanceTimersByTime(1_000);
    expect(await gaveUp).toBe(false);

    const waiting = whenTrackerListHeld(1_000);
    await useTrackerRegistry.getState().refresh({ providers: async () => [linearLikeTrackerDescriptor()] });
    expect(await waiting).toBe(true);
    expect(await whenTrackerListHeld(1_000)).toBe(true);
  });

  test('a runtime without trackers is ready and empty', async () => {
    const { useTrackerRegistry } = await loadRegistry();
    useTrackerRegistry.getState().resetForRuntimeSwitch(connectTo('runtime-a'));
    await useTrackerRegistry.getState().refresh(undefined);
    expect(useTrackerRegistry.getState()).toMatchObject({ status: 'ready', ordered: [] });
  });

  test('leaves out an id the source-control registry serves, whichever list lands first', async () => {
    const { useTrackerRegistry, readTrackerDescriptor } = await loadRegistry();
    const forge = acmeDescriptor({ id: 'forge' });
    const serveSourceControl = (list: typeof forge[]) => useSourceControlProviderRegistry.setState({
      ordered: list, byId: new Map(list.map((entry) => [entry.id, entry])), status: 'ready',
    });
    try {
      useTrackerRegistry.getState().resetForRuntimeSwitch(connectTo('runtime-a'));
      await useTrackerRegistry.getState().refresh({
        providers: async () => [linearLikeTrackerDescriptor(), { ...acmeTrackerDescriptor(), id: 'forge' }],
      });
      expect(ids(useTrackerRegistry.getState().ordered)).toEqual(['linear', 'forge']);

      serveSourceControl([forge]);
      expect(ids(useTrackerRegistry.getState().ordered)).toEqual(['linear']);
      expect(readTrackerDescriptor('forge').name).toBe('forge');

      serveSourceControl([]);
      expect(ids(useTrackerRegistry.getState().ordered)).toEqual(['linear', 'forge']);
    } finally {
      serveSourceControl([]);
    }
  });
});

describe('tracker descriptor list', () => {
  test('leaves out malformed, reserved and repeated entries and keeps the rest', () => {
    const parsed = trackerDescriptorListSchema.parse([
      linearLikeTrackerDescriptor(),
      { ...acmeTrackerDescriptor(), id: 'repository' },
      { ...acmeTrackerDescriptor(), id: 'Not An Id' },
      { id: 'half', name: 'Half' },
      { ...linearLikeTrackerDescriptor(), name: 'Second Linear' },
      acmeTrackerDescriptor(),
    ]);
    expect(parsed.map((descriptor) => [descriptor.id, descriptor.name])).toEqual([['linear', 'Linear'], ['acme-tickets', 'Acme Tickets']]);
  });

  test('reads what a newer server may send as its closest known meaning', () => {
    const [parsed] = trackerDescriptorListSchema.parse([{
      ...acmeTrackerDescriptor(),
      authMethods: ['oauth', 'passkey'],
      capabilities: { stateUpdate: true },
    }]);
    expect(parsed?.authMethods).toEqual(['oauth']);
    expect(parsed?.capabilities.stateUpdate).toBe(true);
    expect(parsed?.capabilities.children).toBe(false);
    expect(parsed?.capabilities.filters).toEqual({ people: false, priority: false });
  });
});
