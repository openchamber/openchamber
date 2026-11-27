import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';

import { EMPTY_GUEST_CONNECTION, type GuestConnection, type GuestTrackerRequest } from '@openchamber/sdk';

import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { useTrackerAuthStore } from '@/stores/useTrackerAuthStore';
import type { RuntimeAPIs } from '@/lib/api/types';
import type { TrackerAPI, TrackerDescriptor } from '@/lib/trackers/types';
import { acmeTrackerDescriptor } from '@/lib/trackers/descriptor.fixture';

import type { InstalledGuest } from './types';
import { useGuestTracker, type GuestTrackerBridge } from './useGuestTracker';

const item = {
  provider: 'ext-jira-tracker',
  id: '10001',
  identifier: 'PROJ-1',
  title: 'Login fails on Safari',
  url: 'https://jira.example/browse/PROJ-1',
  state: { id: '3', name: 'In Progress', category: 'in-progress' as const },
};

const capabilities = { requested: [], granted: [] };
const jira: InstalledGuest = {
  id: 'jira-tracker',
  name: 'Jira',
  icon: '',
  capabilities,
  tracker: { label: 'Jira', instances: { kind: 'user', label: 'Site' }, authMethods: ['token'] },
};

describe('useGuestTracker', () => {
  let root: Root;
  let window: Window;
  let bridge: GuestTrackerBridge | undefined;
  const previousGlobals = new Map<string, PropertyDescriptor | undefined>();
  const calls: { method: string; provider: string }[] = [];
  const api = {
    providers: async (): Promise<TrackerDescriptor[]> => [{ ...acmeTrackerDescriptor({ id: 'ext-jira-tracker', name: 'Jira' }) }],
    list: async (provider: string) => {
      calls.push({ method: 'list', provider });
      return { connected: true as const, items: [item], cursor: null, hasMore: false };
    },
    get: async (provider: string) => {
      calls.push({ method: 'get', provider });
      return { connected: true as const, item };
    },
  };
  const partial: Partial<TrackerAPI> = api;
  // SAFETY: the fake implements the tracker methods these reads call; the rest of the API is out of scope.
  const trackers = partial as TrackerAPI;
  // SAFETY: the provider exposes only the runtime slice these reads use.
  const runtime = { trackers } as RuntimeAPIs;

  const Probe = ({ guest, oauthConnection }: { guest: InstalledGuest | null; oauthConnection?: GuestConnection }) => {
    bridge = useGuestTracker(guest, guest?.id ?? 'missing', oauthConnection);
    return null;
  };

  const render = async (guest: InstalledGuest | null, oauthConnection?: GuestConnection) => {
    await act(async () => {
      root.render(
        <RuntimeAPIContext.Provider value={runtime}>
          <Probe guest={guest} oauthConnection={oauthConnection} />
        </RuntimeAPIContext.Provider>,
      );
    });
  };

  beforeEach(() => {
    bridge = undefined;
    calls.length = 0;
    useTrackerAuthStore.setState({ entries: {} });
    window = new Window({ url: 'http://localhost/' });
    for (const [key, value] of Object.entries({ window, document: window.document, navigator: window.navigator, IS_REACT_ACT_ENVIRONMENT: true })) {
      previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, { configurable: true, value });
    }
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    await window.happyDOM.close();
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    previousGlobals.clear();
  });

  test('derives the provider from the frame and reads only that tracker', async () => {
    await render(jira);
    expect(bridge?.provider).toBe('ext-jira-tracker');
    const request: GuestTrackerRequest & { provider: string } = { op: 'list', options: { state: 'open' }, provider: 'linear' };
    const result = await bridge!.read(request);
    expect(result).toMatchObject({ ok: true, result: { op: 'list', result: { connected: true } } });
    expect(calls).toEqual([{ method: 'list', provider: 'ext-jira-tracker' }]);
  });

  test('has no provider for a plain guest or for an integration guest', async () => {
    await render({ id: 'jira-tracker', name: 'Jira', icon: '', capabilities });
    expect(bridge?.provider).toBeNull();
    expect(await bridge!.read({ op: 'list' })).toMatchObject({ ok: false, code: 'NOT_GRANTED' });
    await render({ ...jira, integration: { name: 'Jira', description: 'Host sign-in', auth: 'host' } });
    expect(bridge?.provider).toBeNull();
    expect(calls).toEqual([]);
  });

  test('keeps the OAuth connection when the guest has no tracker', async () => {
    await render({ id: 'plain', name: 'Plain', icon: '', capabilities });
    expect(bridge?.connection).toEqual(EMPTY_GUEST_CONNECTION);
    const connection: GuestConnection = { connected: true, account: 'Mona' };
    await render({ id: 'plain', name: 'Plain', icon: '', capabilities }, connection);
    expect(bridge?.connection).toEqual(connection);
  });
});
