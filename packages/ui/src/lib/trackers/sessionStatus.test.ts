import { afterEach, describe, expect, test } from 'bun:test';

import { acmeTrackerDescriptor, linearLikeTrackerDescriptor } from './descriptor.fixture';
import { useTrackerRegistry } from './registry';
import { postTrackerSessionStarted, resolveTrackerSessionOrigin } from './sessionStatus';
import type { TrackerAPI } from './types';

describe('resolveTrackerSessionOrigin', () => {
  const originalWindow = globalThis.window;

  afterEach(() => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: originalWindow,
    });
  });

  test('uses the page origin on web', () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        location: { origin: 'https://app.example.com' },
      },
    });
    expect(resolveTrackerSessionOrigin()).toBe('https://app.example.com');
  });

  test('uses the desktop loopback origin instead of the packaged UI scheme', () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        location: { origin: 'openchamber-ui://app' },
        __OPENCHAMBER_ELECTRON__: { runtime: 'electron' },
        __OPENCHAMBER_LOCAL_ORIGIN__: 'http://127.0.0.1:3001',
      },
    });
    expect(resolveTrackerSessionOrigin()).toBe('http://127.0.0.1:3001');
  });

  test('reports no origin when the desktop shell has no http loopback', () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        location: { origin: 'openchamber-ui://app' },
        __OPENCHAMBER_ELECTRON__: { runtime: 'electron' },
        __OPENCHAMBER_LOCAL_ORIGIN__: 'openchamber-ui://app',
      },
    });
    // A deep link is unopenable for everyone but this machine, so the server
    // gets no origin and posts no comment.
    expect(resolveTrackerSessionOrigin()).toBe(undefined);
  });
});

describe('postTrackerSessionStarted', () => {
  const posts: string[] = [];
  const unexpected = (): never => { throw new Error('Unexpected tracker call'); };
  const trackers: TrackerAPI = {
    sessionStatusPost: async (provider, input) => {
      posts.push(`${provider}:${input.identifier}`);
      return { connected: true, posted: true, commentId: null };
    },
    providers: unexpected, authStatus: unexpected, authStart: unexpected, authDisconnect: unexpected,
    authActivate: unexpected, list: unexpected, refreshListReads: unexpected, get: unexpected, states: unexpected,
    updateState: unexpected, mappingGet: unexpected, mappingSet: unexpected, preferencesGet: unexpected,
    preferencesSet: unexpected,
  };

  afterEach(() => {
    posts.length = 0;
    useTrackerRegistry.getState().resetForRuntimeSwitch(useTrackerRegistry.getState().runtimeKey);
  });

  test('waits for the tracker list instead of skipping a session started before it arrived', async () => {
    useTrackerRegistry.getState().resetForRuntimeSwitch(useTrackerRegistry.getState().runtimeKey);
    const posting = postTrackerSessionStarted(trackers, 'linear', { sessionId: 'ses_1', identifier: 'ENG-12' });
    await Promise.resolve();
    expect(posts).toEqual([]);
    await useTrackerRegistry.getState().refresh({ providers: async () => [linearLikeTrackerDescriptor()] });
    await posting;
    expect(posts).toEqual(['linear:ENG-12']);
  });

  test('posts nothing for a tracker without session comments, or when the list never arrives', async () => {
    await useTrackerRegistry.getState().refresh({ providers: async () => [acmeTrackerDescriptor()] });
    await postTrackerSessionStarted(trackers, 'acme-tickets', { sessionId: 'ses_1', identifier: 'OPS-1' });
    expect(posts).toEqual([]);

    useTrackerRegistry.getState().resetForRuntimeSwitch(useTrackerRegistry.getState().runtimeKey);
    const originalWarn = console.warn;
    const warnings: unknown[] = [];
    console.warn = (...args: unknown[]) => { warnings.push(args[0]); };
    try {
      await postTrackerSessionStarted(trackers, 'linear', { sessionId: 'ses_2', identifier: 'ENG-1' }, 5);
    } finally {
      console.warn = originalWarn;
    }
    expect(posts).toEqual([]);
    expect(warnings).toHaveLength(1);
  });
});
