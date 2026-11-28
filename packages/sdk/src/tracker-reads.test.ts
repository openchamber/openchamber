import { describe, expect, test } from 'bun:test';

import { OPENCHAMBER_SDK_API_VERSION, OPENCHAMBER_SDK_CHANNEL } from './api-version.ts';
import { HostRequestError } from './errors.ts';
import { GUEST_TRACKER_ID_MAX, GUEST_TRACKER_QUERY_MAX } from './contract.ts';
import {
  createGuestTrackerReadClient,
  isGuestTrackerResult,
  type GuestTrackerMessage,
  type GuestTrackerRequest,
  type GuestTrackerResult,
} from './tracker-reads.ts';
import { guestTrackerRequestSchema, guestTrackerResultSchema } from './tracker-reads-schemas.ts';
import { guestMessageSchema, hostMessageSchema } from './protocol.ts';

const item = {
  provider: 'ext-jira-tracker',
  id: '10001',
  identifier: 'PROJ-1',
  title: 'Login fails on Safari',
  url: 'https://jira.example/browse/PROJ-1',
  state: { id: '3', name: 'In Progress', category: 'in-progress' as const },
  priority: 'high' as const,
  container: { id: 'PROJ', key: 'PROJ', name: 'Project X' },
  updatedAt: '2026-11-27T09:00:00.000+0000',
};

const listResult = { op: 'list', result: { connected: true, items: [item], cursor: null, hasMore: false } } satisfies GuestTrackerResult;
const filters = { name: 'Jira', stateFilters: ['open', 'all'], people: true, priority: true };

describe('guest tracker reads', () => {
  test('accepts list, get and filters requests and refuses anything else', () => {
    expect(guestTrackerRequestSchema.safeParse({ op: 'list', options: { state: 'open', people: 'me', priority: 'all' } }).success).toBe(true);
    expect(guestTrackerRequestSchema.safeParse({ op: 'list', options: { state: 'open', provider: 'linear' } }).success).toBe(false);
    expect(guestTrackerRequestSchema.safeParse({ op: 'list', options: { people: 'everyone' } }).success).toBe(false);
    expect(guestTrackerRequestSchema.safeParse({ op: 'get', id: 'PROJ-1' }).success).toBe(true);
    expect(guestTrackerRequestSchema.safeParse({ op: 'get', id: 'x'.repeat(GUEST_TRACKER_ID_MAX + 1) }).success).toBe(false);
    expect(guestTrackerRequestSchema.safeParse({ op: 'filters' }).success).toBe(true);
    expect(guestTrackerRequestSchema.safeParse({ op: 'search', query: 'login' }).success).toBe(false);
  });

  test('accepts results that carry the provider and refuses a summary without it', () => {
    expect(guestTrackerResultSchema.safeParse(listResult).success).toBe(true);
    expect(guestTrackerResultSchema.safeParse({ op: 'get', result: { connected: true, item } }).success).toBe(true);
    expect(guestTrackerResultSchema.safeParse({ op: 'filters', result: filters }).success).toBe(true);
    expect(guestTrackerResultSchema.safeParse({ op: 'get', result: { connected: true, item: { ...item, provider: undefined } } }).success).toBe(false);
    expect(guestTrackerResultSchema.safeParse({ op: 'list', result: { connected: true, items: [{ ...item, url: 'javascript:alert(1)' }], cursor: null, hasMore: false } }).success).toBe(false);
  });

  test('rides the tracker message type through both protocol directions', () => {
    const request = { channel: OPENCHAMBER_SDK_CHANNEL, v: OPENCHAMBER_SDK_API_VERSION, type: 'tracker', id: 't1', payload: { op: 'list', options: { state: 'open' } } };
    expect(guestMessageSchema.safeParse(request).success).toBe(true);
    const result = { channel: OPENCHAMBER_SDK_CHANNEL, v: OPENCHAMBER_SDK_API_VERSION, type: 'result', id: 't1', ok: true, payload: listResult };
    expect(hostMessageSchema.safeParse(result).success).toBe(true);
  });

  test('client sends one tracker message per call and returns the matching result', async () => {
    const sent: GuestTrackerMessage[] = [];
    const client = createGuestTrackerReadClient({
      envelope: { channel: OPENCHAMBER_SDK_CHANNEL, v: OPENCHAMBER_SDK_API_VERSION },
      nextId: () => `t${sent.length + 1}`,
      send: async (message) => {
        sent.push(message);
        if (message.payload.op === 'list') return listResult;
        if (message.payload.op === 'get') return { op: 'get', result: { connected: true, item } };
        return { op: 'filters', result: filters };
      },
    });

    expect(await client.list({ state: 'open', query: ' safari ' })).toEqual(listResult.result);
    expect(sent[0].payload).toEqual({ op: 'list', options: { state: 'open', query: 'safari' } });
    expect((await client.get(' PROJ-1 ')).item?.identifier).toBe('PROJ-1');
    expect(sent[1].payload).toEqual({ op: 'get', id: 'PROJ-1' });
    expect(await client.filters()).toEqual(filters);
  });

  test('client refuses a bad id or query before asking the host, and a result for another operation', async () => {
    let sends = 0;
    const client = createGuestTrackerReadClient({
      envelope: { channel: OPENCHAMBER_SDK_CHANNEL, v: OPENCHAMBER_SDK_API_VERSION },
      nextId: () => 't1',
      send: async () => {
        sends += 1;
        return { op: 'get', result: { connected: true, item } };
      },
    });
    await expect(client.list({ query: 'x'.repeat(GUEST_TRACKER_QUERY_MAX + 1) })).rejects.toMatchObject({ code: 'HOST_REJECTED' });
    await expect(client.get('   ')).rejects.toMatchObject({ code: 'HOST_REJECTED' });
    await expect(client.get('PROJ-1')).resolves.toMatchObject({ connected: true });
    expect(sends).toBe(1);
    await expect(client.list()).rejects.toMatchObject({ code: 'HOST_REJECTED' });
  });

  test('guard answers on the operation and the result shape', () => {
    expect(isGuestTrackerResult(listResult)).toBe(true);
    expect(isGuestTrackerResult({ op: 'list', result: { connected: false } })).toBe(true);
    expect(isGuestTrackerResult({ op: 'list', result: { connected: true } })).toBe(false);
    expect(isGuestTrackerResult({ op: 'get', result: { connected: true, item } }, 'list')).toBe(false);
  });

  test('the request and result types line up with the schemas', () => {
    const request: GuestTrackerRequest = { op: 'list', options: { people: 'created' } };
    expect(guestTrackerRequestSchema.parse(request)).toEqual(request);
    void HostRequestError;
  });
});
