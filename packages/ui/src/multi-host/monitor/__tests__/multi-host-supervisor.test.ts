import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { createMultiHostSupervisor } from '../multi-host-supervisor';
import { useMultiHostStore } from '../../multi-host-store';
import type { HostDescriptor, HostId } from '../../types';
import type { HostMonitorTransport, MonitorScheduler, ReconnectPolicy, TransportFactory } from '../types';

// ---------------------------------------------------------------------------
// Fake implementations
// ---------------------------------------------------------------------------

function makeFakeScheduler(): MonitorScheduler & { tick(): void } {
  let idCounter = 0;
  const pending = new Map<number, { fn: () => void; id: number }>();
  const scheduler: MonitorScheduler & { tick(): void; pending: Map<number, { fn: () => void; id: number }> } = {
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
  return scheduler;
}

function makeFakeReconnectPolicy(): ReconnectPolicy {
  return { nextDelay: () => ({ delayMs: 0, reason: 'fake' }), reset: () => {} };
}

function makeFakeTransportFactory(): TransportFactory & { transports: Map<HostId, HostMonitorTransport> } {
  const transports = new Map<HostId, HostMonitorTransport>();
  const factory: TransportFactory & { transports: Map<HostId, HostMonitorTransport> } = (descriptor) => {
    const transport: HostMonitorTransport = {
      request: async (req) => {
        if (req.path === '/project/list') return { status: 200, data: [] };
        if (req.path === '/session') return { status: 200, data: [] };
        if (req.path === '/session/status') return { status: 200, data: {} };
        return { status: 404, data: null };
      },
      openEventStream: async ({ signal }) => {
        const abortPromise = new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return {
          async *[Symbol.asyncIterator](): AsyncGenerator<import('../types').MonitorEventFrame> {
            yield { directory: '', payload: { type: '__noop', properties: {} } };
            await abortPromise;
          },
        };
      },
      close: () => {},
    };
    transports.set(descriptor.hostId, transport);
    return transport;
  };
  factory.transports = transports;
  return factory;
}

function makeDescriptor(hostId: HostId): HostDescriptor {
  return {
    hostId,
    label: `Host ${hostId}`,
    transport: { kind: 'direct', apiUrl: `http://${hostId}.test:4096` },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createMultiHostSupervisor', () => {
  beforeEach(() => {
    useMultiHostStore.setState({ hosts: {} });
  });

  afterEach(() => {
    useMultiHostStore.setState({ hosts: {} });
  });

  test('startHost registers host in store and starts monitoring', async () => {
    const scheduler = makeFakeScheduler();
    const transportFactory = makeFakeTransportFactory();

    const supervisor = createMultiHostSupervisor({
      scheduler,
      transportFactory,
      reconciliationIntervalMs: 60_000,
    });

    const hostId = 'host_1' as HostId;
    supervisor.startHost(hostId, makeDescriptor(hostId));

    await new Promise((r) => setTimeout(r, 20));

    expect(supervisor.hasHost(hostId)).toBe(true);
    const state = useMultiHostStore.getState().hosts[hostId];
    expect(state).toBeDefined();
    expect(state?.connection.state).toBe('connected');

    supervisor.dispose();
  });

  test('two hosts can run simultaneously', async () => {
    const scheduler = makeFakeScheduler();
    const transportFactory = makeFakeTransportFactory();

    const supervisor = createMultiHostSupervisor({
      scheduler,
      transportFactory,
      reconciliationIntervalMs: 60_000,
    });

    const hostA = 'host_a' as HostId;
    const hostB = 'host_b' as HostId;

    supervisor.startHost(hostA, makeDescriptor(hostA));
    supervisor.startHost(hostB, makeDescriptor(hostB));

    await new Promise((r) => setTimeout(r, 20));

    expect(supervisor.hasHost(hostA)).toBe(true);
    expect(supervisor.hasHost(hostB)).toBe(true);

    const stateA = useMultiHostStore.getState().hosts[hostA];
    const stateB = useMultiHostStore.getState().hosts[hostB];
    expect(stateA?.connection.state).toBe('connected');
    expect(stateB?.connection.state).toBe('connected');

    supervisor.dispose();
  });

  test('stopHost cleans up the host', async () => {
    const scheduler = makeFakeScheduler();
    const transportFactory = makeFakeTransportFactory();

    const supervisor = createMultiHostSupervisor({
      scheduler,
      transportFactory,
      reconciliationIntervalMs: 60_000,
    });

    const hostId = 'host_1' as HostId;
    supervisor.startHost(hostId, makeDescriptor(hostId));
    await new Promise((r) => setTimeout(r, 10));

    supervisor.stopHost(hostId);

    const state = useMultiHostStore.getState().hosts[hostId];
    expect(state?.connection.state).toBe('disconnected');

    supervisor.dispose();
  });

  test('stopAll cleans up all hosts', async () => {
    const scheduler = makeFakeScheduler();
    const transportFactory = makeFakeTransportFactory();

    const supervisor = createMultiHostSupervisor({
      scheduler,
      transportFactory,
      reconciliationIntervalMs: 60_000,
    });

    const hostA = 'host_a' as HostId;
    const hostB = 'host_b' as HostId;

    supervisor.startHost(hostA, makeDescriptor(hostA));
    supervisor.startHost(hostB, makeDescriptor(hostB));
    await new Promise((r) => setTimeout(r, 10));

    supervisor.stopAll();

    expect(supervisor.hasHost(hostA)).toBe(false);
    expect(supervisor.hasHost(hostB)).toBe(false);

    supervisor.dispose();
  });

  test('startHost is idempotent', async () => {
    const scheduler = makeFakeScheduler();
    const transportFactory = makeFakeTransportFactory();

    const supervisor = createMultiHostSupervisor({
      scheduler,
      transportFactory,
      reconciliationIntervalMs: 60_000,
    });

    const hostId = 'host_1' as HostId;
    supervisor.startHost(hostId, makeDescriptor(hostId));
    supervisor.startHost(hostId, makeDescriptor(hostId));

    await new Promise((r) => setTimeout(r, 10));

    expect(transportFactory.transports.size).toBe(1);

    supervisor.dispose();
  });

  test('dispose prevents further operations', async () => {
    const scheduler = makeFakeScheduler();
    const transportFactory = makeFakeTransportFactory();

    const supervisor = createMultiHostSupervisor({
      scheduler,
      transportFactory,
      reconciliationIntervalMs: 60_000,
    });

    supervisor.dispose();

    const hostId = 'host_1' as HostId;
    supervisor.startHost(hostId, makeDescriptor(hostId));

    expect(supervisor.hasHost(hostId)).toBe(false);
  });

  test('descriptor change restarts connection', async () => {
    const scheduler = makeFakeScheduler();
    const transportFactory = makeFakeTransportFactory();

    const supervisor = createMultiHostSupervisor({
      scheduler,
      transportFactory,
      reconciliationIntervalMs: 60_000,
    });

    const hostId = 'host_1' as HostId;
    supervisor.startHost(hostId, makeDescriptor(hostId));
    await new Promise((r) => setTimeout(r, 10));

    const desc2 = makeDescriptor(hostId);
    desc2.transport = { kind: 'ssh', sshEndpoint: 'localhost:2222' };
    supervisor.restartHost(hostId, desc2);

    await new Promise((r) => setTimeout(r, 10));

    const state = useMultiHostStore.getState().hosts[hostId];
    expect(state).toBeDefined();

    supervisor.dispose();
  });

  test('descriptor without transport change does not restart connection', async () => {
    const scheduler = makeFakeScheduler();
    const transportFactory = makeFakeTransportFactory();

    const supervisor = createMultiHostSupervisor({
      scheduler,
      transportFactory,
      reconciliationIntervalMs: 60_000,
    });

    const hostId = 'host_1' as HostId;
    supervisor.startHost(hostId, makeDescriptor(hostId));
    await new Promise((r) => setTimeout(r, 10));

    const desc2 = makeDescriptor(hostId);
    desc2.label = 'Updated Label';
    supervisor.restartHost(hostId, desc2);

    expect(transportFactory.transports.size).toBe(1);

    supervisor.dispose();
  });

  test('reconnect policy is per-host', async () => {
    const scheduler = makeFakeScheduler();
    const transportFactory = makeFakeTransportFactory();
    const policiesCreated: string[] = [];

    const supervisor = createMultiHostSupervisor({
      scheduler,
      transportFactory,
      reconnectPolicyFactory: () => {
        policiesCreated.push('policy');
        return makeFakeReconnectPolicy();
      },
      reconciliationIntervalMs: 60_000,
    });

    const hostA = 'host_a' as HostId;
    const hostB = 'host_b' as HostId;

    supervisor.startHost(hostA, makeDescriptor(hostA));
    supervisor.startHost(hostB, makeDescriptor(hostB));

    expect(policiesCreated.length).toBe(2);

    supervisor.dispose();
  });
});
