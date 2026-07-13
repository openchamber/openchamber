import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { useMultiHostStore } from '../../multi-host-store';
import { reconcileHost } from '../reconciliation';
import type { HostDescriptor, HostId, HostSnapshot } from '../../types';
import type { HostMonitorTransport } from '../types';

function makeDescriptor(hostId: HostId): HostDescriptor {
  return {
    hostId,
    label: `Host ${hostId}`,
    transport: { kind: 'direct', apiUrl: 'http://localhost:4096' },
  };
}

function makeTransport(responses: Record<string, { status: number; data: unknown }>): HostMonitorTransport {
  return {
    request: async (req) => {
      const resp = responses[req.path];
      if (!resp) return { status: 404, data: null };
      return resp;
    },
    openEventStream: async () => ({
      async *[Symbol.asyncIterator]() {},
    }),
    close: () => {},
  };
}

describe('replaceHostSnapshot unread preservation', () => {
  const hostId = 'host_test' as HostId;

  beforeEach(() => {
    useMultiHostStore.setState({ hosts: {} });
  });

  afterEach(() => {
    useMultiHostStore.setState({ hosts: {} });
  });

  test('replaceHostSnapshot preserves local unread for existing sessions', () => {
    const store = useMultiHostStore.getState();

    // Register host and add some sessions with unread
    store.registerHost(makeDescriptor(hostId));
    store.upsertSession(hostId, { id: 'sess_1', title: 'S1', directory: '/d', projectId: 'p' });
    store.upsertSession(hostId, { id: 'sess_2', title: 'S2', directory: '/d', projectId: 'p' });
    store.markSessionUnread(hostId, 'sess_1', 3);
    store.markSessionUnread(hostId, 'sess_2', 1);

    // Replace with snapshot that still has sess_1 but not sess_2
    const snapshot: HostSnapshot = {
      descriptor: makeDescriptor(hostId),
      connection: { state: 'connected' },
      projects: [],
      sessions: {
        sess_1: { id: 'sess_1', title: 'S1 Updated', directory: '/d', projectId: 'p' },
      },
      statuses: {},
      unreadBySession: {},
    };

    store.replaceHostSnapshot(hostId, snapshot);

    const state = useMultiHostStore.getState().hosts[hostId];
    // sess_1 unread should be preserved
    expect(state?.unreadBySession['sess_1']).toBe(3);
    // sess_2 should be removed (server no longer reports it)
    expect(state?.sessions['sess_2']).toBeFalsy();
    expect(state?.unreadBySession['sess_2']).toBeFalsy();
  });

  test('replaceHostSnapshot removes status for deleted sessions', () => {
    const store = useMultiHostStore.getState();

    store.registerHost(makeDescriptor(hostId));
    store.upsertSession(hostId, { id: 'sess_1', title: 'S1', directory: '/d', projectId: 'p' });
    store.upsertSession(hostId, { id: 'sess_2', title: 'S2', directory: '/d', projectId: 'p' });
    store.setSessionStatus(hostId, 'sess_1', 'busy');
    store.setSessionStatus(hostId, 'sess_2', 'busy');

    // Replace with snapshot that only has sess_1
    const snapshot: HostSnapshot = {
      descriptor: makeDescriptor(hostId),
      connection: { state: 'connected' },
      projects: [],
      sessions: {
        sess_1: { id: 'sess_1', title: 'S1', directory: '/d', projectId: 'p' },
      },
      statuses: { sess_1: { status: 'busy' } },
      unreadBySession: {},
    };

    store.replaceHostSnapshot(hostId, snapshot);

    const state = useMultiHostStore.getState().hosts[hostId];
    expect(state?.statuses['sess_1']?.status).toBe('busy');
    expect(state?.statuses['sess_2']).toBeFalsy();
  });

  test('replaceHostSnapshot does not affect other hosts', () => {
    const store = useMultiHostStore.getState();
    const hostA = 'host_a' as HostId;
    const hostB = 'host_b' as HostId;

    store.registerHost(makeDescriptor(hostA));
    store.registerHost(makeDescriptor(hostB));

    store.upsertSession(hostA, { id: 'sess_a', title: 'A', directory: '/a', projectId: 'pa' });
    store.upsertSession(hostB, { id: 'sess_b', title: 'B', directory: '/b', projectId: 'pb' });
    store.markSessionUnread(hostA, 'sess_a', 5);
    store.markSessionUnread(hostB, 'sess_b', 2);

    // Replace only host A
    const snapshot: HostSnapshot = {
      descriptor: makeDescriptor(hostA),
      connection: { state: 'connected' },
      projects: [],
      sessions: {},
      statuses: {},
      unreadBySession: {},
    };

    store.replaceHostSnapshot(hostA, snapshot);

    const stateA = useMultiHostStore.getState().hosts[hostA];
    const stateB = useMultiHostStore.getState().hosts[hostB];

    expect(stateA?.sessions['sess_a']).toBeFalsy();
    expect(stateB?.sessions['sess_b']).toBeDefined();
    expect(stateB?.unreadBySession['sess_b']).toBe(2);
  });

  test('reconciliation refresh clears server-deleted sessions and statuses', async () => {
    const hostId = 'host_test' as HostId;
    const store = useMultiHostStore.getState();

    store.registerHost(makeDescriptor(hostId));
    store.upsertSession(hostId, { id: 'sess_1', title: 'S1', directory: '/d', projectId: 'p' });
    store.upsertSession(hostId, { id: 'sess_2', title: 'S2', directory: '/d', projectId: 'p' });
    store.markSessionUnread(hostId, 'sess_1', 3);
    store.setSessionStatus(hostId, 'sess_2', 'busy');

    // Server now only reports sess_1
    const transport = makeTransport({
      '/project/list': { status: 200, data: [] },
      '/session': {
        status: 200,
        data: [{ id: 'sess_1', title: 'S1 Updated', directory: '/d', projectID: 'p', time: { created: 1, updated: 2 } }],
      },
      '/session/status': { status: 200, data: {} },
    });

    const descriptor = makeDescriptor(hostId);
    const existingSnapshot: HostSnapshot = {
      descriptor,
      connection: { state: 'connected' },
      projects: [],
      sessions: {
        sess_1: { id: 'sess_1', title: 'S1', directory: '/d', projectId: 'p' },
        sess_2: { id: 'sess_2', title: 'S2', directory: '/d', projectId: 'p' },
      },
      statuses: { sess_2: { status: 'busy' } },
      unreadBySession: { sess_1: 3 },
    };

    const result = await reconcileHost(hostId, descriptor, transport, existingSnapshot);

    expect(result.ok).toBe(true);

    // Apply the result
    store.replaceHostSnapshot(hostId, result.snapshot);

    const state = useMultiHostStore.getState().hosts[hostId];
    // sess_1 unread preserved
    expect(state?.unreadBySession['sess_1']).toBe(3);
    // sess_2 removed (server no longer reports)
    expect(state?.sessions['sess_2']).toBeFalsy();
    expect(state?.statuses['sess_2']).toBeFalsy();
    expect(state?.unreadBySession['sess_2']).toBeFalsy();
  });
});
