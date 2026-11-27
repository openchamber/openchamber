import { describe, expect, test } from 'bun:test';

import type { GuestTrackerRequest } from '@openchamber/sdk';

import { acmeTrackerDescriptor } from '@/lib/trackers/descriptor.fixture';
import type { TrackerAPI, TrackerDescriptor } from '@/lib/trackers/types';

import { readGuestTracker } from './tracker-reads';

const item = {
  provider: 'ext-jira-tracker',
  id: '10001',
  identifier: 'PROJ-1',
  title: 'Login fails on Safari',
  url: 'https://jira.example/browse/PROJ-1',
  state: { id: '3', name: 'In Progress', category: 'in-progress' as const },
};

const provider = 'ext-jira-tracker';

const fakeTrackers = (overrides: Partial<TrackerAPI> = {}) => {
  const calls: { method: string; provider: string; value?: string }[] = [];
  const descriptors: TrackerDescriptor[] = [
    acmeTrackerDescriptor({ id: 'ext-other' }),
    acmeTrackerDescriptor({ id: provider, name: 'Jira', stateFilters: ['open', 'all'] }),
  ];
  const api = {
    providers: async () => {
      calls.push({ method: 'providers', provider: '' });
      return descriptors;
    },
    list: async (id: string, options?: { state?: string }) => {
      calls.push({ method: 'list', provider: id, value: options?.state });
      return { connected: true as const, items: [item], cursor: null, hasMore: false };
    },
    get: async (id: string, value: string) => {
      calls.push({ method: 'get', provider: id, value });
      return { connected: true as const, item };
    },
    ...overrides,
  };
  // SAFETY: the fake implements the tracker methods these reads call; the rest of the API is out of scope.
  return { api: api as TrackerAPI, calls };
};

describe('readGuestTracker', () => {
  test('refuses a frame without a tracker before asking the host', async () => {
    const { api, calls } = fakeTrackers();
    expect(await readGuestTracker(null, { op: 'list' }, api)).toMatchObject({ ok: false, code: 'NOT_GRANTED' });
    expect(calls).toEqual([]);
  });

  test('refuses a host without tracker support', async () => {
    expect(await readGuestTracker(provider, { op: 'list' }, undefined)).toMatchObject({ ok: false, code: 'UNSUPPORTED' });
  });

  test('reads only the provider derived from the frame, never one the request names', async () => {
    const { api, calls } = fakeTrackers();
    const request: GuestTrackerRequest & { provider: string } = { op: 'list', options: { state: 'open' }, provider: 'linear' };
    const result = await readGuestTracker(provider, request, api);
    expect(result).toEqual({ ok: true, result: { op: 'list', result: { connected: true, items: [item], cursor: null, hasMore: false } } });
    expect(calls).toEqual([{ method: 'list', provider, value: 'open' }]);
  });

  test('gets one item and its filter options from the same provider', async () => {
    const { api, calls } = fakeTrackers();
    expect(await readGuestTracker(provider, { op: 'get', id: 'PROJ-1' }, api)).toMatchObject({ ok: true, result: { op: 'get', result: { connected: true } } });
    expect(await readGuestTracker(provider, { op: 'filters' }, api)).toEqual({
      ok: true,
      result: { op: 'filters', result: { name: 'Jira', stateFilters: ['open', 'all'], people: false, priority: false } },
    });
    expect(calls).toEqual([
      { method: 'get', provider, value: 'PROJ-1' },
      { method: 'providers', provider: '' },
    ]);
  });

  test('answers filter options for a tracker that declares no filters', async () => {
    const { api } = fakeTrackers({ providers: async () => [acmeTrackerDescriptor({ id: provider, name: 'Bare', stateFilters: [] })] });
    expect(await readGuestTracker(provider, { op: 'filters' }, api)).toEqual({
      ok: true,
      result: { op: 'filters', result: { name: 'Bare', stateFilters: [], people: false, priority: false } },
    });
  });

  test('reports an unknown provider and an API failure as host rejections', async () => {
    const { api } = fakeTrackers({ providers: async () => [acmeTrackerDescriptor({ id: 'ext-other' })] });
    expect(await readGuestTracker(provider, { op: 'filters' }, api)).toMatchObject({ ok: false, code: 'HOST_REJECTED' });
    const failing = fakeTrackers({ list: async () => { throw new Error('Tracker is offline.'); } });
    expect(await readGuestTracker(provider, { op: 'list' }, failing.api)).toEqual({ ok: false, code: 'HOST_REJECTED', message: 'Tracker is offline.' });
  });
});
