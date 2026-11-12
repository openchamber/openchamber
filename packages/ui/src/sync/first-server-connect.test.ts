import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { opencodeClient } from '@/lib/opencode/client';
import { getRuntimeApiBaseUrl, getRuntimeKey, switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { ChildStoreManager } from './child-store';
import { subscribeFirstServerConnect } from './first-server-connect';
import { createEventRoutingIndex, handleEvent } from './sync-context';

const originalActiveStatuses = opencodeClient.getActiveSessionStatuses;
const originalRuntime = getRuntimeKey();
const originalBase = getRuntimeApiBaseUrl();
let childStores: ChildStoreManager;
let retries = 0;
let notified: string[] = [];
let unsubscribe: () => void = () => undefined;

const serverConnected = (runtimeKey = getRuntimeKey()) => handleEvent(
  'global',
  { type: 'server.connected', properties: {} },
  childStores,
  createEventRoutingIndex(),
  runtimeKey,
);

beforeEach(() => {
  switchRuntimeEndpoint({ apiBaseUrl: 'https://first-connect-a.test', runtimeKey: 'first-connect-a' });
  childStores = new ChildStoreManager();
  retries = 0;
  notified = [];
  const retry = childStores.retryFailedBootstraps.bind(childStores);
  childStores.retryFailedBootstraps = () => {
    retries += 1;
    return retry();
  };
  unsubscribe = subscribeFirstServerConnect((runtimeKey) => notified.push(runtimeKey));
  opencodeClient.getActiveSessionStatuses = async () => null;
});

afterEach(() => {
  unsubscribe();
  opencodeClient.getActiveSessionStatuses = originalActiveStatuses;
  switchRuntimeEndpoint({ apiBaseUrl: originalBase, runtimeKey: originalRuntime });
  childStores.disposeAll();
});

describe('first server.connected', () => {
  test('retries failed bootstraps and announces OpenCode once per runtime', () => {
    serverConnected();
    serverConnected();
    expect(retries).toBe(1);
    expect(notified).toEqual(['first-connect-a']);

    switchRuntimeEndpoint({ apiBaseUrl: 'https://first-connect-b.test', runtimeKey: 'first-connect-b' });
    serverConnected();
    expect(retries).toBe(2);
    expect(notified).toEqual(['first-connect-a', 'first-connect-b']);
  });

  test('an event from a runtime that is no longer active does nothing', () => {
    serverConnected('first-connect-old');
    expect(retries).toBe(0);
    expect(notified).toEqual([]);
  });
});
