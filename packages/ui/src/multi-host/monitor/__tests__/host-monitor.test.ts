import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { HostMonitor } from '../host-monitor';
import { useMultiHostStore } from '../../multi-host-store';
import type { HostDescriptor, HostId } from '../../types';
import type { HostMonitorTransport, MonitorEventFrame, MonitorScheduler, ReconnectPolicy } from '../types';

// ---------------------------------------------------------------------------
// Fake implementations
// ---------------------------------------------------------------------------

function makeFakeScheduler(): MonitorScheduler & { tick(): void; pending: Map<number, { fn: () => void; id: number }> } {
  let idCounter = 0;
  const pending = new Map<number, { fn: () => void; id: number }>();
  return {
    pending,
    setTimeout: (fn) => {
      const id = ++idCounter;
      pending.set(id, { fn, id });
      return { cancel: () => pending.delete(id) };
    },
    setInterval: (fn) => {
      const id = ++idCounter;
      pending.set(id, { fn, id });
      return { cancel: () => pending.delete(id) };
    },
    now: () => Date.now(),
    tick() {
      for (const [, entry] of [...pending]) {
        entry.fn();
        pending.delete(entry.id);
      }
    },
  };
}

function makeFakeReconnectPolicy(): ReconnectPolicy {
  return {
    nextDelay: () => ({ delayMs: 0, reason: 'fake' }),
    reset: () => {},
  };
}

function makeFakeTransport(options?: {
  eventFrames?: MonitorEventFrame[];
  fetchResponses?: Record<string, { status: number; data: unknown }>;
}): HostMonitorTransport {
  const frames = options?.eventFrames ?? [];
  const fetchResponses = options?.fetchResponses ?? {};

  return {
    request: async (req) => {
      const resp = fetchResponses[req.path];
      if (!resp) return { status: 404, data: null };
      return resp;
    },
    openEventStream: async ({ signal }) => {
      return {
        async *[Symbol.asyncIterator]() {
          for (const frame of frames) {
            if (signal.aborted) break;
            yield frame;
          }
          await new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => resolve(), { once: true });
          });
        },
      };
    },
    close: () => {},
  };
}

function makeDescriptor(hostId: HostId): HostDescriptor {
  return {
    hostId,
    label: `Host ${hostId}`,
    transport: { kind: 'direct', apiUrl: `http://${hostId}.test:4096` },
  };
}

function makeSessionFrame(sessionId: string, title: string): MonitorEventFrame {
  return {
    directory: '/test',
    payload: {
      id: `evt_${sessionId}`,
      type: 'session.created',
      properties: {
        sessionID: sessionId,
        info: {
          id: sessionId,
          title,
          directory: '/test',
          projectID: 'proj_1',
          time: { created: 1000, updated: 2000 },
        },
      },
    },
  };
}

function makeStatusFrame(sessionId: string, status: string): MonitorEventFrame {
  return {
    directory: '/test',
    payload: {
      id: `evt_status_${sessionId}`,
      type: 'session.status',
      properties: {
        sessionID: sessionId,
        status: { type: status },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HostMonitor', () => {
  const hostId = 'host_test' as HostId;

  beforeEach(() => {
    useMultiHostStore.setState({ hosts: {} });
  });

  afterEach(() => {
    useMultiHostStore.setState({ hosts: {} });
  });

  test('start() sets connection to connecting then connected', async () => {
    const scheduler = makeFakeScheduler();
    const transport = makeFakeTransport({
      eventFrames: [],
      fetchResponses: {
        '/project/list': { status: 200, data: [] },
        '/session': { status: 200, data: [] },
        '/session/status': { status: 200, data: {} },
      },
    });

    const monitor = new HostMonitor({
      hostId,
      descriptor: makeDescriptor(hostId),
      transport,
      scheduler,
      reconnectPolicy: makeFakeReconnectPolicy(),
      reconciliationIntervalMs: 60_000,
    });

    useMultiHostStore.getState().registerHost(makeDescriptor(hostId));
    monitor.start();

    await new Promise((r) => setTimeout(r, 10));

    const state = useMultiHostStore.getState().hosts[hostId];
    expect(state?.connection.state).toBe('connected');

    monitor.dispose();
  });

  test('two hosts can run simultaneously without interfering', async () => {
    const scheduler = makeFakeScheduler();
    const hostA = 'host_a' as HostId;
    const hostB = 'host_b' as HostId;

    const transportA = makeFakeTransport({
      eventFrames: [makeSessionFrame('sess_a1', 'Session A1')],
      fetchResponses: {
        '/project/list': { status: 200, data: [{ id: 'proj_a', name: 'Project A', worktree: '/a' }] },
        '/session': { status: 200, data: [{ id: 'sess_a1', title: 'Session A1', directory: '/a', projectID: 'proj_a', time: { created: 1, updated: 2 } }] },
        '/session/status': { status: 200, data: { sess_a1: { type: 'busy' } } },
      },
    });

    const transportB = makeFakeTransport({
      eventFrames: [makeSessionFrame('sess_b1', 'Session B1')],
      fetchResponses: {
        '/project/list': { status: 200, data: [{ id: 'proj_b', name: 'Project B', worktree: '/b' }] },
        '/session': { status: 200, data: [{ id: 'sess_b1', title: 'Session B1', directory: '/b', projectID: 'proj_b', time: { created: 3, updated: 4 } }] },
        '/session/status': { status: 200, data: {} },
      },
    });

    const monitorA = new HostMonitor({
      hostId: hostA,
      descriptor: makeDescriptor(hostA),
      transport: transportA,
      scheduler,
      reconnectPolicy: makeFakeReconnectPolicy(),
      reconciliationIntervalMs: 60_000,
    });

    const monitorB = new HostMonitor({
      hostId: hostB,
      descriptor: makeDescriptor(hostB),
      transport: transportB,
      scheduler,
      reconnectPolicy: makeFakeReconnectPolicy(),
      reconciliationIntervalMs: 60_000,
    });

    useMultiHostStore.getState().registerHost(makeDescriptor(hostA));
    useMultiHostStore.getState().registerHost(makeDescriptor(hostB));

    monitorA.start();
    monitorB.start();

    await new Promise((r) => setTimeout(r, 20));

    const stateA = useMultiHostStore.getState().hosts[hostA];
    const stateB = useMultiHostStore.getState().hosts[hostB];

    expect(stateA?.connection.state).toBe('connected');
    expect(stateB?.connection.state).toBe('connected');

    expect(stateA?.projects[0]?.id).toBe('proj_a');
    expect(stateB?.projects[0]?.id).toBe('proj_b');
    expect(stateA?.sessions['sess_a1']).toBeDefined();
    expect(stateB?.sessions['sess_b1']).toBeDefined();
    expect(stateA?.sessions['sess_b1']).toBeFalsy();
    expect(stateB?.sessions['sess_a1']).toBeFalsy();

    monitorA.dispose();
    monitorB.dispose();
  });

  test('same sessionId on different hosts does not leak data', async () => {
    const scheduler = makeFakeScheduler();
    const hostA = 'host_a' as HostId;
    const hostB = 'host_b' as HostId;
    const sharedSessionId = 'shared_sess';

    const transportA = makeFakeTransport({
      eventFrames: [makeSessionFrame(sharedSessionId, 'A Session')],
      fetchResponses: {
        '/project/list': { status: 200, data: [] },
        '/session': { status: 200, data: [{ id: sharedSessionId, title: 'A Session', directory: '/a', projectID: 'p', time: { created: 1, updated: 2 } }] },
        '/session/status': { status: 200, data: {} },
      },
    });

    const transportB = makeFakeTransport({
      eventFrames: [makeSessionFrame(sharedSessionId, 'B Session')],
      fetchResponses: {
        '/project/list': { status: 200, data: [] },
        '/session': { status: 200, data: [{ id: sharedSessionId, title: 'B Session', directory: '/b', projectID: 'p', time: { created: 3, updated: 4 } }] },
        '/session/status': { status: 200, data: {} },
      },
    });

    const monitorA = new HostMonitor({
      hostId: hostA,
      descriptor: makeDescriptor(hostA),
      transport: transportA,
      scheduler,
      reconnectPolicy: makeFakeReconnectPolicy(),
      reconciliationIntervalMs: 60_000,
    });

    const monitorB = new HostMonitor({
      hostId: hostB,
      descriptor: makeDescriptor(hostB),
      transport: transportB,
      scheduler,
      reconnectPolicy: makeFakeReconnectPolicy(),
      reconciliationIntervalMs: 60_000,
    });

    useMultiHostStore.getState().registerHost(makeDescriptor(hostA));
    useMultiHostStore.getState().registerHost(makeDescriptor(hostB));

    monitorA.start();
    monitorB.start();

    await new Promise((r) => setTimeout(r, 20));

    const stateA = useMultiHostStore.getState().hosts[hostA];
    const stateB = useMultiHostStore.getState().hosts[hostB];

    expect(stateA?.sessions[sharedSessionId]?.title).toBe('A Session');
    expect(stateB?.sessions[sharedSessionId]?.title).toBe('B Session');

    monitorA.dispose();
    monitorB.dispose();
  });

  test('host A failure does not affect host B', async () => {
    const scheduler = makeFakeScheduler();
    const hostA = 'host_a' as HostId;
    const hostB = 'host_b' as HostId;

    const failingTransport: HostMonitorTransport = {
      request: async () => { throw new Error('network error'); },
      openEventStream: async () => {
        throw new Error('connection failed');
      },
      close: () => {},
    };

    const transportB = makeFakeTransport({
      eventFrames: [makeSessionFrame('sess_b1', 'B Session')],
      fetchResponses: {
        '/project/list': { status: 200, data: [] },
        '/session': { status: 200, data: [] },
        '/session/status': { status: 200, data: {} },
      },
    });

    const monitorA = new HostMonitor({
      hostId: hostA,
      descriptor: makeDescriptor(hostA),
      transport: failingTransport,
      scheduler,
      reconnectPolicy: makeFakeReconnectPolicy(),
      reconciliationIntervalMs: 60_000,
    });

    const monitorB = new HostMonitor({
      hostId: hostB,
      descriptor: makeDescriptor(hostB),
      transport: transportB,
      scheduler,
      reconnectPolicy: makeFakeReconnectPolicy(),
      reconciliationIntervalMs: 60_000,
    });

    useMultiHostStore.getState().registerHost(makeDescriptor(hostA));
    useMultiHostStore.getState().registerHost(makeDescriptor(hostB));

    monitorA.start();
    monitorB.start();

    await new Promise((r) => setTimeout(r, 20));

    const stateA = useMultiHostStore.getState().hosts[hostA];
    const stateB = useMultiHostStore.getState().hosts[hostB];

    expect(stateA?.connection.state).toBe('error');
    expect(stateB?.connection.state).toBe('connected');

    monitorA.dispose();
    monitorB.dispose();
  });

  test('start() is idempotent', async () => {
    const scheduler = makeFakeScheduler();
    const transport = makeFakeTransport({
      fetchResponses: {
        '/project/list': { status: 200, data: [] },
        '/session': { status: 200, data: [] },
        '/session/status': { status: 200, data: {} },
      },
    });

    const monitor = new HostMonitor({
      hostId,
      descriptor: makeDescriptor(hostId),
      transport,
      scheduler,
      reconnectPolicy: makeFakeReconnectPolicy(),
      reconciliationIntervalMs: 60_000,
    });

    useMultiHostStore.getState().registerHost(makeDescriptor(hostId));

    monitor.start();
    monitor.start();

    await new Promise((r) => setTimeout(r, 20));

    const state = useMultiHostStore.getState().hosts[hostId];
    expect(state?.connection.state).toBe('connected');

    monitor.dispose();
  });

  test('stop() cleans up event connection and timers', async () => {
    const scheduler = makeFakeScheduler();
    const transport = makeFakeTransport({
      fetchResponses: {
        '/project/list': { status: 200, data: [] },
        '/session': { status: 200, data: [] },
        '/session/status': { status: 200, data: {} },
      },
    });

    const monitor = new HostMonitor({
      hostId,
      descriptor: makeDescriptor(hostId),
      transport,
      scheduler,
      reconnectPolicy: makeFakeReconnectPolicy(),
      reconciliationIntervalMs: 60_000,
    });

    useMultiHostStore.getState().registerHost(makeDescriptor(hostId));
    monitor.start();
    await new Promise((r) => setTimeout(r, 10));

    monitor.stop();

    const state = useMultiHostStore.getState().hosts[hostId];
    expect(state?.connection.state).toBe('disconnected');

    monitor.dispose();
  });

  test('descriptor change restarts connection', async () => {
    const scheduler = makeFakeScheduler();
    const transport = makeFakeTransport({
      fetchResponses: {
        '/project/list': { status: 200, data: [{ id: 'proj_1', name: 'V1' }] },
        '/session': { status: 200, data: [] },
        '/session/status': { status: 200, data: {} },
      },
    });

    const monitor = new HostMonitor({
      hostId,
      descriptor: makeDescriptor(hostId),
      transport,
      scheduler,
      reconnectPolicy: makeFakeReconnectPolicy(),
      reconciliationIntervalMs: 60_000,
    });

    useMultiHostStore.getState().registerHost(makeDescriptor(hostId));
    monitor.start();
    await new Promise((r) => setTimeout(r, 10));

    const newDescriptor = makeDescriptor(hostId);
    newDescriptor.transport = { kind: 'ssh', sshEndpoint: 'localhost:2222' };
    monitor.updateDescriptor(newDescriptor);
    await new Promise((r) => setTimeout(r, 10));

    const state = useMultiHostStore.getState().hosts[hostId];
    expect(state).toBeDefined();

    monitor.dispose();
  });

  test('dispose() prevents further store writes', async () => {
    const scheduler = makeFakeScheduler();
    const transport = makeFakeTransport({
      eventFrames: [makeSessionFrame('sess_1', 'Session')],
      fetchResponses: {
        '/project/list': { status: 200, data: [] },
        '/session': { status: 200, data: [] },
        '/session/status': { status: 200, data: {} },
      },
    });

    const monitor = new HostMonitor({
      hostId,
      descriptor: makeDescriptor(hostId),
      transport,
      scheduler,
      reconnectPolicy: makeFakeReconnectPolicy(),
      reconciliationIntervalMs: 60_000,
    });

    useMultiHostStore.getState().registerHost(makeDescriptor(hostId));
    monitor.start();
    await new Promise((r) => setTimeout(r, 10));

    monitor.dispose();

    const stateBefore = useMultiHostStore.getState().hosts[hostId];
    monitor.refresh();
    await new Promise((r) => setTimeout(r, 10));
    const stateAfter = useMultiHostStore.getState().hosts[hostId];

    expect(stateAfter).toEqual(stateBefore);
  });

  test('events update store correctly', async () => {
    const scheduler = makeFakeScheduler();
    const eventFrames: MonitorEventFrame[] = [
      makeSessionFrame('sess_1', 'First Session'),
      makeStatusFrame('sess_1', 'busy'),
    ];

    const transport = makeFakeTransport({
      eventFrames,
      fetchResponses: {
        '/project/list': { status: 200, data: [] },
        '/session': {
          status: 200,
          data: [
            { id: 'sess_1', title: 'First Session', directory: '/test', projectID: 'proj_1', time: { created: 1000, updated: 2000 } },
          ],
        },
        '/session/status': {
          status: 200,
          data: { sess_1: { type: 'busy' } },
        },
      },
    });

    const monitor = new HostMonitor({
      hostId,
      descriptor: makeDescriptor(hostId),
      transport,
      scheduler,
      reconnectPolicy: makeFakeReconnectPolicy(),
      reconciliationIntervalMs: 60_000,
    });

    useMultiHostStore.getState().registerHost(makeDescriptor(hostId));
    monitor.start();

    await new Promise((r) => setTimeout(r, 50));

    const state = useMultiHostStore.getState().hosts[hostId];
    expect(state?.sessions['sess_1']?.title).toBe('First Session');
    expect(state?.statuses['sess_1']?.status).toBe('busy');

    monitor.dispose();
  });

  test('session delete event removes session from store', async () => {
    const scheduler = makeFakeScheduler();
    const eventFrames: MonitorEventFrame[] = [
      makeSessionFrame('sess_1', 'To Delete'),
      {
        directory: '/test',
        payload: {
          id: 'evt_del',
          type: 'session.deleted',
          properties: {
            sessionID: 'sess_1',
            info: { id: 'sess_1' },
          },
        },
      },
    ];

    const transport = makeFakeTransport({
      eventFrames,
      fetchResponses: {
        '/project/list': { status: 200, data: [] },
        '/session': { status: 200, data: [] },
        '/session/status': { status: 200, data: {} },
      },
    });

    const monitor = new HostMonitor({
      hostId,
      descriptor: makeDescriptor(hostId),
      transport,
      scheduler,
      reconnectPolicy: makeFakeReconnectPolicy(),
      reconciliationIntervalMs: 60_000,
    });

    useMultiHostStore.getState().registerHost(makeDescriptor(hostId));
    monitor.start();

    await new Promise((r) => setTimeout(r, 50));

    const state = useMultiHostStore.getState().hosts[hostId];
    expect(state?.sessions['sess_1']).toBeFalsy();
    expect(state?.statuses['sess_1']).toBeFalsy();

    monitor.dispose();
  });
});
