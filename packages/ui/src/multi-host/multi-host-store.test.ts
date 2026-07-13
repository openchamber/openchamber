import { beforeEach, describe, expect, test } from 'bun:test';

import { useMultiHostStore } from './multi-host-store';
import {
  selectHost,
  selectHostProjects,
  selectHostSessions,
  selectHostsWithActivity,
  selectSessionByRef,
  selectSessionStatusByRef,
  selectTotalUnreadCount,
  selectUnreadCountByHost,
} from './selectors';
import type { HostDescriptor, HostId, HostSessionRef, HostSnapshot } from './types';

const hostA: HostDescriptor = {
  hostId: 'host-a' as HostId,
  label: 'Host A',
  transport: { kind: 'direct', apiUrl: 'http://localhost:3000' },
};

const hostB: HostDescriptor = {
  hostId: 'host-b' as HostId,
  label: 'Host B',
  transport: { kind: 'ssh', sshEndpoint: 'remote:22' },
};

beforeEach(() => {
  useMultiHostStore.setState({ hosts: {} });
});

// ---------------------------------------------------------------------------
// 1. Two hosts can have the same sessionId; data doesn't mix
// ---------------------------------------------------------------------------
describe('session isolation across hosts', () => {
  test('two hosts can store the same sessionId without conflict', () => {
    const { registerHost, upsertSession } = useMultiHostStore.getState();
    registerHost(hostA);
    registerHost(hostB);

    upsertSession('host-a' as HostId, { id: 'ses_1', title: 'From A' });
    upsertSession('host-b' as HostId, { id: 'ses_1', title: 'From B' });

    const state = useMultiHostStore.getState();
    expect(state.hosts['host-a']!.sessions['ses_1']!.title).toBe('From A');
    expect(state.hosts['host-b']!.sessions['ses_1']!.title).toBe('From B');
  });

  test('session status is isolated per host', () => {
    const { registerHost, setSessionStatus } = useMultiHostStore.getState();
    registerHost(hostA);
    registerHost(hostB);

    setSessionStatus('host-a' as HostId, 'ses_1', 'busy');
    setSessionStatus('host-b' as HostId, 'ses_1', 'retry');

    const state = useMultiHostStore.getState();
    expect(state.hosts['host-a']!.statuses['ses_1']!.status).toBe('busy');
    expect(state.hosts['host-b']!.statuses['ses_1']!.status).toBe('retry');
  });
});

// ---------------------------------------------------------------------------
// 2. Updating host A doesn't change host B's references or state
// ---------------------------------------------------------------------------
describe('update isolation', () => {
  test('updating host A descriptor does not affect host B', () => {
    const { registerHost, updateHostDescriptor } = useMultiHostStore.getState();
    registerHost(hostA);
    registerHost(hostB);

    const bBefore = useMultiHostStore.getState().hosts['host-b']!;
    updateHostDescriptor('host-a' as HostId, { label: 'Renamed A' });

    const state = useMultiHostStore.getState();
    expect(state.hosts['host-a']!.descriptor.label).toBe('Renamed A');
    expect(state.hosts['host-b']!.descriptor.label).toBe('Host B');
    // B's runtime state reference should be unchanged.
    expect(state.hosts['host-b']).toBe(bBefore);
  });

  test('upserting session in host A does not touch host B', () => {
    const { registerHost, upsertSession } = useMultiHostStore.getState();
    registerHost(hostA);
    registerHost(hostB);

    const bBefore = useMultiHostStore.getState().hosts['host-b']!;
    upsertSession('host-a' as HostId, { id: 'ses_new', title: 'New' });

    expect(useMultiHostStore.getState().hosts['host-b']).toBe(bBefore);
  });

  test('setting status in host A does not affect host B', () => {
    const { registerHost, setSessionStatus } = useMultiHostStore.getState();
    registerHost(hostA);
    registerHost(hostB);

    const bBefore = useMultiHostStore.getState().hosts['host-b']!;
    setSessionStatus('host-a' as HostId, 'ses_1', 'busy');

    expect(useMultiHostStore.getState().hosts['host-b']).toBe(bBefore);
  });
});

// ---------------------------------------------------------------------------
// 3. Deleting a host fully cleans it up
// ---------------------------------------------------------------------------
describe('removeHost cleanup', () => {
  test('removing a host removes all its sessions, statuses, and unread', () => {
    const store = useMultiHostStore.getState();
    store.registerHost(hostA);
    store.registerHost(hostB);
    store.upsertSession('host-a' as HostId, { id: 'ses_1', title: 'S1' });
    store.upsertSession('host-a' as HostId, { id: 'ses_2', title: 'S2' });
    store.setSessionStatus('host-a' as HostId, 'ses_1', 'busy');
    store.markSessionUnread('host-a' as HostId, 'ses_1', 3);
    store.markSessionUnread('host-a' as HostId, 'ses_2', 1);

    useMultiHostStore.getState().removeHost('host-a' as HostId);

    const state = useMultiHostStore.getState();
    expect(state.hosts['host-a']).toBe(undefined);
    // host B is untouched.
    expect(state.hosts['host-b']).toBeDefined();
  });

  test('removeHost is a no-op for unknown hostId', () => {
    const before = useMultiHostStore.getState();
    useMultiHostStore.getState().removeHost('nonexistent' as HostId);
    expect(useMultiHostStore.getState()).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// 4. Unread is isolated by hostId + sessionId
// ---------------------------------------------------------------------------
describe('unread isolation', () => {
  test('unread counts are independent per host', () => {
    const store = useMultiHostStore.getState();
    store.registerHost(hostA);
    store.registerHost(hostB);

    store.markSessionUnread('host-a' as HostId, 'ses_1', 5);
    store.markSessionUnread('host-b' as HostId, 'ses_1', 3);

    expect(selectUnreadCountByHost('host-a' as HostId)).toBe(5);
    expect(selectUnreadCountByHost('host-b' as HostId)).toBe(3);
    expect(selectTotalUnreadCount()).toBe(8);
  });

  test('clearing unread on one host does not affect the other', () => {
    const store = useMultiHostStore.getState();
    store.registerHost(hostA);
    store.registerHost(hostB);
    store.markSessionUnread('host-a' as HostId, 'ses_1', 5);
    store.markSessionUnread('host-b' as HostId, 'ses_1', 3);

    useMultiHostStore.getState().clearSessionUnread('host-a' as HostId, 'ses_1');

    expect(selectUnreadCountByHost('host-a' as HostId)).toBe(0);
    expect(selectUnreadCountByHost('host-b' as HostId)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 5. Selectors return correct results
// ---------------------------------------------------------------------------
describe('selectors', () => {
  test('selectHost returns the correct host', () => {
    useMultiHostStore.getState().registerHost(hostA);
    useMultiHostStore.getState().registerHost(hostB);

    const a = selectHost('host-a' as HostId);
    const b = selectHost('host-b' as HostId);
    expect(a?.descriptor.hostId).toBe('host-a');
    expect(b?.descriptor.hostId).toBe('host-b');
  });

  test('selectHostSessions returns sessions for the correct host', () => {
    const store = useMultiHostStore.getState();
    store.registerHost(hostA);
    store.registerHost(hostB);
    store.upsertSession('host-a' as HostId, { id: 'ses_a', title: 'A' });
    store.upsertSession('host-b' as HostId, { id: 'ses_b', title: 'B' });

    const sessionsA = selectHostSessions('host-a' as HostId);
    const sessionsB = selectHostSessions('host-b' as HostId);
    expect(Object.keys(sessionsA)).toEqual(['ses_a']);
    expect(Object.keys(sessionsB)).toEqual(['ses_b']);
  });

  test('selectHostProjects returns projects for the correct host', () => {
    const store = useMultiHostStore.getState();
    store.registerHost(hostA);
    store.registerHost(hostB);
    store.replaceProjects('host-a' as HostId, [{ id: 'p1', name: 'Proj A' }]);
    store.replaceProjects('host-b' as HostId, [{ id: 'p2', name: 'Proj B' }]);

    expect(selectHostProjects('host-a' as HostId)).toEqual([{ id: 'p1', name: 'Proj A' }]);
    expect(selectHostProjects('host-b' as HostId)).toEqual([{ id: 'p2', name: 'Proj B' }]);
  });

  test('selectSessionByRef returns the correct session', () => {
    const store = useMultiHostStore.getState();
    store.registerHost(hostA);
    store.registerHost(hostB);
    store.upsertSession('host-a' as HostId, { id: 'ses_1', title: 'From A' });
    store.upsertSession('host-b' as HostId, { id: 'ses_1', title: 'From B' });

    const refA: HostSessionRef = { hostId: 'host-a' as HostId, sessionId: 'ses_1', directory: '/a', projectId: 'p1' };
    const refB: HostSessionRef = { hostId: 'host-b' as HostId, sessionId: 'ses_1', directory: '/b', projectId: 'p2' };
    expect(selectSessionByRef(refA)?.title).toBe('From A');
    expect(selectSessionByRef(refB)?.title).toBe('From B');
  });

  test('selectSessionStatusByRef returns correct status', () => {
    const store = useMultiHostStore.getState();
    store.registerHost(hostA);
    store.setSessionStatus('host-a' as HostId, 'ses_1', 'busy');

    const ref: HostSessionRef = { hostId: 'host-a' as HostId, sessionId: 'ses_1', directory: '/a', projectId: 'p1' };
    expect(selectSessionStatusByRef(ref)?.status).toBe('busy');
  });

  test('selectHostsWithActivity returns only hosts with non-idle sessions', () => {
    const store = useMultiHostStore.getState();
    store.registerHost(hostA);
    store.registerHost(hostB);
    store.setSessionStatus('host-a' as HostId, 'ses_1', 'busy');

    const active = selectHostsWithActivity();
    expect(active).toEqual(['host-a']);
  });

  test('selectTotalUnreadCount sums all hosts', () => {
    const store = useMultiHostStore.getState();
    store.registerHost(hostA);
    store.registerHost(hostB);
    store.markSessionUnread('host-a' as HostId, 'ses_1', 2);
    store.markSessionUnread('host-a' as HostId, 'ses_2', 3);
    store.markSessionUnread('host-b' as HostId, 'ses_1', 4);

    expect(selectTotalUnreadCount()).toBe(9);
  });
});

// ---------------------------------------------------------------------------
// 6. Duplicate register, update, and delete are safe
// ---------------------------------------------------------------------------
describe('idempotency', () => {
  test('registering the same host twice merges descriptor', () => {
    const store = useMultiHostStore.getState();
    store.registerHost(hostA);
    store.upsertSession('host-a' as HostId, { id: 'ses_1', title: 'S1' });

    useMultiHostStore.getState().registerHost({
      ...hostA,
      label: 'Updated A',
    });

    const state = useMultiHostStore.getState();
    expect(state.hosts['host-a']!.descriptor.label).toBe('Updated A');
    // Sessions are preserved.
    expect(state.hosts['host-a']!.sessions['ses_1']!.title).toBe('S1');
  });

  test('removeHost twice does not throw', () => {
    useMultiHostStore.getState().registerHost(hostA);
    useMultiHostStore.getState().removeHost('host-a' as HostId);
    // Should not throw.
    useMultiHostStore.getState().removeHost('host-a' as HostId);
    expect(useMultiHostStore.getState().hosts['host-a']).toBe(undefined);
  });

  test('upserting the same session reference is a no-op', () => {
    const store = useMultiHostStore.getState();
    store.registerHost(hostA);
    const session = { id: 'ses_1', title: 'S1' };
    store.upsertSession('host-a' as HostId, session);

    const before = useMultiHostStore.getState();
    useMultiHostStore.getState().upsertSession('host-a' as HostId, session);
    // Same reference → state should be unchanged.
    expect(useMultiHostStore.getState().hosts['host-a']).toBe(before.hosts['host-a']);
  });

  test('markSessionUnread with same count is a no-op', () => {
    const store = useMultiHostStore.getState();
    store.registerHost(hostA);
    store.markSessionUnread('host-a' as HostId, 'ses_1', 5);

    const before = useMultiHostStore.getState();
    useMultiHostStore.getState().markSessionUnread('host-a' as HostId, 'ses_1', 5);
    expect(useMultiHostStore.getState().hosts['host-a']).toBe(before.hosts['host-a']);
  });
});

// ---------------------------------------------------------------------------
// 7. replaceHostSnapshot does not affect other hosts
// ---------------------------------------------------------------------------
describe('replaceHostSnapshot isolation', () => {
  test('replacing snapshot for host A does not change host B', () => {
    const store = useMultiHostStore.getState();
    store.registerHost(hostA);
    store.registerHost(hostB);
    store.upsertSession('host-b' as HostId, { id: 'ses_b', title: 'B' });
    store.markSessionUnread('host-b' as HostId, 'ses_b', 2);

    const bBefore = useMultiHostStore.getState().hosts['host-b']!;

    const snapshot: HostSnapshot = {
      descriptor: hostA,
      connection: { state: 'connected', connectedAt: '2025-01-01T00:00:00Z' },
      projects: [{ id: 'p1', name: 'Project' }],
      sessions: { ses_a: { id: 'ses_a', title: 'New A' } },
      statuses: { ses_a: { status: 'busy' } },
      unreadBySession: { ses_a: 5 },
    };

    useMultiHostStore.getState().replaceHostSnapshot('host-a' as HostId, snapshot);

    const state = useMultiHostStore.getState();
    expect(state.hosts['host-b']).toBe(bBefore);
    expect(state.hosts['host-a']!.sessions['ses_a']!.title).toBe('New A');
    expect(state.hosts['host-a']!.connection.state).toBe('connected');
  });

  test('replaceHostSnapshot on unknown host creates the host entry', () => {
    const snapshot: HostSnapshot = {
      descriptor: hostA,
      connection: { state: 'disconnected' },
      projects: [],
      sessions: {},
      statuses: {},
      unreadBySession: {},
    };

    useMultiHostStore.getState().replaceHostSnapshot('host-a' as HostId, snapshot);

    const state = useMultiHostStore.getState();
    expect(state.hosts['host-a']).toBeDefined();
    expect(state.hosts['host-a']!.descriptor.hostId).toBe('host-a');
  });

  test('replaceHostSnapshot preserves local unread counts', () => {
    const store = useMultiHostStore.getState();
    store.registerHost(hostA);
    store.upsertSession('host-a' as HostId, { id: 'ses_1', title: 'S1' });
    store.markSessionUnread('host-a' as HostId, 'ses_1', 5);

    // Server refresh with same session but no unread data
    const snapshot: HostSnapshot = {
      descriptor: hostA,
      connection: { state: 'connected' },
      projects: [],
      sessions: { ses_1: { id: 'ses_1', title: 'S1 Updated' } },
      statuses: {},
      unreadBySession: {},
    };

    useMultiHostStore.getState().replaceHostSnapshot('host-a' as HostId, snapshot);

    const state = useMultiHostStore.getState();
    // Unread should be preserved
    expect(state.hosts['host-a']!.unreadBySession['ses_1']).toBe(5);
    // Session should be updated
    expect(state.hosts['host-a']!.sessions['ses_1']!.title).toBe('S1 Updated');
  });

  test('replaceHostSnapshot removes sessions not in snapshot', () => {
    const store = useMultiHostStore.getState();
    store.registerHost(hostA);
    store.upsertSession('host-a' as HostId, { id: 'ses_1', title: 'S1' });
    store.upsertSession('host-a' as HostId, { id: 'ses_2', title: 'S2' });
    store.markSessionUnread('host-a' as HostId, 'ses_1', 3);
    store.markSessionUnread('host-a' as HostId, 'ses_2', 2);

    // Server refresh without ses_2
    const snapshot: HostSnapshot = {
      descriptor: hostA,
      connection: { state: 'connected' },
      projects: [],
      sessions: { ses_1: { id: 'ses_1', title: 'S1' } },
      statuses: {},
      unreadBySession: {},
    };

    useMultiHostStore.getState().replaceHostSnapshot('host-a' as HostId, snapshot);

    const state = useMultiHostStore.getState();
    // ses_2 should be removed
    expect(state.hosts['host-a']!.sessions['ses_2']).toBe(undefined);
    // ses_2 unread should be removed
    expect(state.hosts['host-a']!.unreadBySession['ses_2']).toBe(undefined);
    // ses_1 unread should be preserved
    expect(state.hosts['host-a']!.unreadBySession['ses_1']).toBe(3);
  });

  test('replaceHostSnapshot preserves existing unread when snapshot has new sessions', () => {
    const store = useMultiHostStore.getState();
    store.registerHost(hostA);
    store.upsertSession('host-a' as HostId, { id: 'ses_1', title: 'S1' });
    store.markSessionUnread('host-a' as HostId, 'ses_1', 5);

    // Server refresh with new session ses_2
    const snapshot: HostSnapshot = {
      descriptor: hostA,
      connection: { state: 'connected' },
      projects: [],
      sessions: { 
        ses_1: { id: 'ses_1', title: 'S1' },
        ses_2: { id: 'ses_2', title: 'S2' }
      },
      statuses: {},
      unreadBySession: { ses_2: 3 },
    };

    useMultiHostStore.getState().replaceHostSnapshot('host-a' as HostId, snapshot);

    const state = useMultiHostStore.getState();
    // ses_1 unread should be preserved
    expect(state.hosts['host-a']!.unreadBySession['ses_1']).toBe(5);
    // ses_2 unread should be added from snapshot
    expect(state.hosts['host-a']!.unreadBySession['ses_2']).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Connection state
// ---------------------------------------------------------------------------
describe('connection state', () => {
  test('setConnectionState transitions correctly', () => {
    const store = useMultiHostStore.getState();
    store.registerHost(hostA);

    useMultiHostStore.getState().setConnectionState('host-a' as HostId, 'connecting');
    expect(useMultiHostStore.getState().hosts['host-a']!.connection.state).toBe('connecting');

    useMultiHostStore.getState().setConnectionState('host-a' as HostId, 'connected');
    expect(useMultiHostStore.getState().hosts['host-a']!.connection.state).toBe('connected');
    expect(useMultiHostStore.getState().hosts['host-a']!.connection.connectedAt).toBeTruthy();

    useMultiHostStore.getState().setConnectionState('host-a' as HostId, 'error', 'timeout');
    expect(useMultiHostStore.getState().hosts['host-a']!.connection.state).toBe('error');
    expect(useMultiHostStore.getState().hosts['host-a']!.connection.error).toBe('timeout');
  });
});

// ---------------------------------------------------------------------------
// clearHostRuntimeState
// ---------------------------------------------------------------------------
describe('clearHostRuntimeState', () => {
  test('clears sessions, statuses, unread, and connection but keeps descriptor', () => {
    const store = useMultiHostStore.getState();
    store.registerHost(hostA);
    store.upsertSession('host-a' as HostId, { id: 'ses_1', title: 'S1' });
    store.setSessionStatus('host-a' as HostId, 'ses_1', 'busy');
    store.markSessionUnread('host-a' as HostId, 'ses_1', 5);
    store.setConnectionState('host-a' as HostId, 'connected');

    useMultiHostStore.getState().clearHostRuntimeState('host-a' as HostId);

    const state = useMultiHostStore.getState();
    const host = state.hosts['host-a']!;
    expect(host.descriptor).toEqual(hostA);
    expect(host.connection.state).toBe('disconnected');
    expect(Object.keys(host.sessions)).toHaveLength(0);
    expect(Object.keys(host.statuses)).toHaveLength(0);
    expect(Object.keys(host.unreadBySession)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// removeSession
// ---------------------------------------------------------------------------
describe('removeSession', () => {
  test('removes session, its status, and its unread', () => {
    const store = useMultiHostStore.getState();
    store.registerHost(hostA);
    store.upsertSession('host-a' as HostId, { id: 'ses_1', title: 'S1' });
    store.setSessionStatus('host-a' as HostId, 'ses_1', 'busy');
    store.markSessionUnread('host-a' as HostId, 'ses_1', 3);

    useMultiHostStore.getState().removeSession('host-a' as HostId, 'ses_1');

    const state = useMultiHostStore.getState();
    const host = state.hosts['host-a']!;
    expect(host.sessions['ses_1']).toBe(undefined);
    expect(host.statuses['ses_1']).toBe(undefined);
    expect(host.unreadBySession['ses_1']).toBe(undefined);
  });

  test('removeSession is a no-op for unknown session', () => {
    useMultiHostStore.getState().registerHost(hostA);
    const before = useMultiHostStore.getState();
    useMultiHostStore.getState().removeSession('host-a' as HostId, 'nonexistent');
    expect(useMultiHostStore.getState().hosts['host-a']).toBe(before.hosts['host-a']);
  });
});

// ---------------------------------------------------------------------------
// replaceSessions
// ---------------------------------------------------------------------------
describe('replaceSessions', () => {
  test('replaces full session list', () => {
    const store = useMultiHostStore.getState();
    store.registerHost(hostA);
    store.upsertSession('host-a' as HostId, { id: 'old', title: 'Old' });

    useMultiHostStore.getState().replaceSessions('host-a' as HostId, [
      { id: 'new_1', title: 'N1' },
      { id: 'new_2', title: 'N2' },
    ]);

    const sessions = useMultiHostStore.getState().hosts['host-a']!.sessions;
    expect(Object.keys(sessions)).toEqual(['new_1', 'new_2']);
  });

  test('replaceSessions is a no-op for unknown hostId', () => {
    const before = useMultiHostStore.getState();
    useMultiHostStore.getState().replaceSessions('nonexistent' as HostId, []);
    expect(useMultiHostStore.getState()).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// setSessionStatus idle removes entry
// ---------------------------------------------------------------------------
describe('setSessionStatus idle', () => {
  test('setting status to idle removes the entry', () => {
    const store = useMultiHostStore.getState();
    store.registerHost(hostA);
    store.setSessionStatus('host-a' as HostId, 'ses_1', 'busy');
    expect(useMultiHostStore.getState().hosts['host-a']!.statuses['ses_1']).toBeDefined();

    useMultiHostStore.getState().setSessionStatus('host-a' as HostId, 'ses_1', 'idle');
    expect(useMultiHostStore.getState().hosts['host-a']!.statuses['ses_1']).toBe(undefined);
  });
});
