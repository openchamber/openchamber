import { describe, expect, test } from 'bun:test';
import { reconcileHost } from '../reconciliation';
import type { HostDescriptor, HostId } from '../../types';
import type { HostMonitorTransport } from '../types';

function makeDescriptor(hostId: HostId, apiUrl = 'http://localhost:4096'): HostDescriptor {
  return {
    hostId,
    label: `Test ${hostId}`,
    transport: { kind: 'direct', apiUrl },
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

describe('reconcileHost', () => {
  const hostId = 'host_test' as HostId;

  test('returns a complete snapshot on successful fetch', async () => {
    const transport = makeTransport({
      '/project/list': {
        status: 200,
        data: [{ id: 'proj_1', name: 'My Project', worktree: '/work/dir' }],
      },
      '/session': {
        status: 200,
        data: [
          { id: 'sess_1', title: 'Session 1', directory: '/work/dir', projectID: 'proj_1', time: { created: 1000, updated: 2000 } },
          { id: 'sess_2', title: 'Session 2', directory: '/work/dir', projectID: 'proj_1', time: { created: 1500, updated: 2500 } },
        ],
      },
      '/session/status': {
        status: 200,
        data: { sess_1: { type: 'busy' } },
      },
    });

    const descriptor = makeDescriptor(hostId);
    const result = await reconcileHost(hostId, descriptor, transport);

    expect(result.ok).toBe(true);
    expect(result.snapshot.projects).toHaveLength(1);
    expect(result.snapshot.projects[0]!.id).toBe('proj_1');
    expect(result.snapshot.projects[0]!.directory).toBe('/work/dir');
    expect(Object.keys(result.snapshot.sessions)).toHaveLength(2);
    expect(result.snapshot.sessions['sess_1']!.title).toBe('Session 1');
    expect(result.snapshot.sessions['sess_2']!.title).toBe('Session 2');
    expect(result.snapshot.statuses['sess_1']!.status).toBe('busy');
    expect(result.snapshot.statuses['sess_2']).toBeFalsy();
    expect(result.snapshot.connection.state).toBe('connected');
  });

  test('returns ok:false on fetch failure', async () => {
    const transport = makeTransport({
      '/project/list': { status: 500, data: null },
      '/session': { status: 500, data: null },
      '/session/status': { status: 500, data: null },
    });

    const descriptor = makeDescriptor(hostId);
    const result = await reconcileHost(hostId, descriptor, transport);

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.snapshot.connection.state).toBe('error');
  });

  test('handles empty session list gracefully', async () => {
    const transport = makeTransport({
      '/project/list': { status: 200, data: [] },
      '/session': { status: 200, data: [] },
      '/session/status': { status: 200, data: {} },
    });

    const descriptor = makeDescriptor(hostId);
    const result = await reconcileHost(hostId, descriptor, transport);

    expect(result.ok).toBe(true);
    expect(Object.keys(result.snapshot.sessions)).toHaveLength(0);
  });

  test('omits idle sessions from status map', async () => {
    const transport = makeTransport({
      '/project/list': { status: 200, data: [] },
      '/session': {
        status: 200,
        data: [
          { id: 'sess_1', title: 'Idle Session', directory: '/d', projectID: 'p', time: { created: 1, updated: 2 } },
        ],
      },
      '/session/status': { status: 200, data: {} },
    });

    const descriptor = makeDescriptor(hostId);
    const result = await reconcileHost(hostId, descriptor, transport);

    expect(result.ok).toBe(true);
    expect(result.snapshot.statuses['sess_1']).toBeFalsy();
  });

  test('preserves connection.connectedAt from existing snapshot', async () => {
    const transport = makeTransport({
      '/project/list': { status: 200, data: [] },
      '/session': { status: 200, data: [] },
      '/session/status': { status: 200, data: {} },
    });

    const descriptor = makeDescriptor(hostId);
    const existing = {
      descriptor,
      connection: { state: 'connected' as const, connectedAt: '2025-01-01T00:00:00.000Z' },
      projects: [],
      sessions: {},
      statuses: {},
      unreadBySession: {},
    };

    const result = await reconcileHost(hostId, descriptor, transport, existing);

    expect(result.ok).toBe(true);
    expect(result.snapshot.connection.connectedAt).toBe('2025-01-01T00:00:00.000Z');
  });

  test('filters out projects without valid id', async () => {
    const transport = makeTransport({
      '/project/list': {
        status: 200,
        data: [
          { id: 'proj_1', name: 'Valid' },
          { id: '', name: 'No ID' },
          { name: 'Missing ID' },
        ],
      },
      '/session': { status: 200, data: [] },
      '/session/status': { status: 200, data: {} },
    });

    const descriptor = makeDescriptor(hostId);
    const result = await reconcileHost(hostId, descriptor, transport);

    expect(result.ok).toBe(true);
    expect(result.snapshot.projects).toHaveLength(1);
    expect(result.snapshot.projects[0]!.id).toBe('proj_1');
  });
});
