import { describe, expect, it, vi } from 'vitest';

import { buildManagedServersResponse } from './managed-servers.js';
import { registerNotificationRoutes } from '../notifications/routes.js';

const SERVER_KEYS = ['pid', 'port', 'directory', 'version', 'status', 'startedAt', 'sessionCount'];

const aliveExcept = (deadPids) => (pid) => !deadPids.includes(pid);
const verified = () => true;

describe('buildManagedServersResponse', () => {
  it('returns the own server as the complete entry', () => {
    const response = buildManagedServersResponse({
      registryEntries: [
        { pid: 4242, ownerPid: 100, port: 4096, binary: '/bin/opencode', runtime: 'web', startedAt: '2026-10-28T01:00:00.000Z' },
      ],
      own: { pid: 4242, port: 4096, directory: '/projects/alpha', version: '2.0.19', ready: true, startedAt: '2026-10-28T01:00:00.000Z', sessionCount: 3 },
      isPidAlive: aliveExcept([]),
      isRecordedPidVerified: verified,
      now: 1_700_000_000_000,
    });

    expect(response.version).toBe(1);
    expect(response.serverTime).toBe(1_700_000_000_000);
    expect(response.servers).toEqual([
      {
        pid: 4242,
        port: 4096,
        directory: '/projects/alpha',
        version: '2.0.19',
        status: 'ready',
        startedAt: '2026-10-28T01:00:00.000Z',
        sessionCount: 3,
      },
    ]);
    expect(Object.keys(response.servers[0])).toEqual(SERVER_KEYS);
  });

  it('marks the own server as starting until it is ready', () => {
    const response = buildManagedServersResponse({
      own: { pid: 4242, port: 4096, directory: null, version: null, ready: false, startedAt: null, sessionCount: 0 },
      isPidAlive: aliveExcept([]),
      isRecordedPidVerified: verified,
      now: 5,
    });

    expect(response.servers).toEqual([
      { pid: 4242, port: 4096, directory: null, version: null, status: 'starting', startedAt: null, sessionCount: 0 },
    ]);
  });

  it('serves cross-instance entries sparse, with explicit nulls and status unknown', () => {
    const response = buildManagedServersResponse({
      registryEntries: [
        { pid: 777, ownerPid: 555, port: 5001, binary: '/bin/opencode', runtime: 'desktop', startedAt: '2026-10-28T00:30:00.000Z' },
      ],
      isPidAlive: aliveExcept([]),
      isRecordedPidVerified: verified,
      now: 5,
    });

    expect(response.servers).toEqual([
      { pid: 777, port: 5001, directory: null, version: null, status: 'unknown', startedAt: '2026-10-28T00:30:00.000Z', sessionCount: null },
    ]);
    expect(Object.keys(response.servers[0])).toEqual(SERVER_KEYS);
  });

  it('never projects secret or launch fields, whatever the records carry', () => {
    const response = buildManagedServersResponse({
      registryEntries: [
        {
          pid: 777,
          ownerPid: 555,
          port: 5001,
          binary: '/bin/opencode',
          runtime: 'web',
          startedAt: '2026-10-28T00:30:00.000Z',
          password: 'secret-password',
          agentToolToken: 'secret-token',
          fingerprint: 'secret-fingerprint',
          args: ['serve', '--password', 'secret-password'],
        },
      ],
      own: { pid: 888, port: 5002, directory: '/projects/beta', version: '2.0.19', ready: true, startedAt: null, sessionCount: 1 },
      isPidAlive: aliveExcept([]),
      isRecordedPidVerified: verified,
      now: 5,
    });

    const serialized = JSON.stringify(response);
    for (const forbidden of ['secret-password', 'secret-token', 'secret-fingerprint', 'password', 'agentToolToken', 'fingerprint', 'args', 'binary', 'ownerPid', 'runtime']) {
      expect(serialized).not.toContain(forbidden);
    }
    for (const server of response.servers) {
      expect(Object.keys(server)).toEqual(SERVER_KEYS);
    }
  });

  it('drops entries whose pid is gone, so stopped servers leave the list', () => {
    const response = buildManagedServersResponse({
      registryEntries: [
        { pid: 111, port: 5001, startedAt: '2026-10-28T00:30:00.000Z' },
        { pid: 222, port: 5002, startedAt: '2026-10-28T00:31:00.000Z' },
      ],
      isPidAlive: aliveExcept([111]),
      isRecordedPidVerified: verified,
      now: 5,
    });

    expect(response.servers.map((server) => server.pid)).toEqual([222]);
  });

  it('marks draining servers, including one only the draining registry knows', () => {
    const response = buildManagedServersResponse({
      registryEntries: [{ pid: 111, port: 5001, startedAt: '2026-10-28T00:30:00.000Z' }],
      drainingRecords: [
        { pid: 111, port: 5001, binary: '/bin/opencode', drainStartedAt: 1_700_000_000_000 },
        { pid: 333, port: 5003, binary: '/bin/opencode', drainStartedAt: 1_700_000_000_000 },
      ],
      isPidAlive: aliveExcept([]),
      isRecordedPidVerified: verified,
      now: 5,
    });

    expect(response.servers).toEqual([
      { pid: 111, port: 5001, directory: null, version: null, status: 'draining', startedAt: '2026-10-28T00:30:00.000Z', sessionCount: null },
      { pid: 333, port: 5003, directory: null, version: null, status: 'draining', startedAt: null, sessionCount: null },
    ]);
  });

  it('lists the own server even when its registry write never landed', () => {
    const response = buildManagedServersResponse({
      registryEntries: [],
      own: { pid: 4242, port: 4096, directory: '/projects/alpha', version: null, ready: true, startedAt: null, sessionCount: 2 },
      isPidAlive: aliveExcept([]),
      isRecordedPidVerified: verified,
      now: 5,
    });

    expect(response.servers).toEqual([
      { pid: 4242, port: 4096, directory: '/projects/alpha', version: null, status: 'ready', startedAt: null, sessionCount: 2 },
    ]);
  });

  it('ties a starting own entry to its own registry record, never a predecessor port', () => {
    const response = buildManagedServersResponse({
      registryEntries: [
        { pid: 111, port: 4001, startedAt: '2026-10-28T00:30:00.000Z' },
        { pid: 999, port: 4002, startedAt: '2026-10-28T00:35:00.000Z' },
      ],
      own: { pid: 999, port: null, directory: '/projects/alpha', version: null, ready: false, startedAt: null, sessionCount: null },
      isPidAlive: aliveExcept([]),
      isRecordedPidVerified: verified,
      now: 5,
    });

    expect(response.servers).toEqual([
      { pid: 111, port: 4001, directory: null, version: null, status: 'unknown', startedAt: '2026-10-28T00:30:00.000Z', sessionCount: null },
      { pid: 999, port: 4002, directory: '/projects/alpha', version: null, status: 'starting', startedAt: '2026-10-28T00:35:00.000Z', sessionCount: null },
    ]);
  });

  it('excludes a recorded pid whose identity no longer matches (recycled pid)', () => {
    // The recorded pid is alive (signal-0 passes) but the live process is
    // an unrelated `sleep`, so the verifier rejects it — exactly the
    // phantom-server case from #638.
    const response = buildManagedServersResponse({
      registryEntries: [
        { pid: 777, port: 5001, startedAt: '2026-10-28T00:30:00.000Z' },
        { pid: 888, port: 5002, startedAt: '2026-10-28T00:31:00.000Z' },
      ],
      isPidAlive: aliveExcept([]),
      isRecordedPidVerified: (server) => server.pid === 888,
      now: 5,
    });

    expect(response.servers.map((server) => server.pid)).toEqual([888]);
  });

  it('excludes a draining record whose pid was recycled', () => {
    const response = buildManagedServersResponse({
      drainingRecords: [{ pid: 333, port: 5003, binary: '/bin/opencode' }],
      isPidAlive: aliveExcept([]),
      isRecordedPidVerified: () => false,
      now: 5,
    });

    expect(response.servers).toEqual([]);
  });

  it('excludes recorded entries when no verifier is supplied (identity cannot be verified)', () => {
    const response = buildManagedServersResponse({
      registryEntries: [{ pid: 777, port: 5001, startedAt: '2026-10-28T00:30:00.000Z' }],
      isPidAlive: aliveExcept([]),
      now: 5,
    });

    expect(response.servers).toEqual([]);
  });

  it('still lists the own server without a recorded-pid verification', () => {
    const response = buildManagedServersResponse({
      registryEntries: [{ pid: 4242, port: 4096, startedAt: '2026-10-28T01:00:00.000Z' }],
      own: { pid: 4242, port: 4096, directory: '/projects/alpha', version: '2.0.19', ready: true, startedAt: '2026-10-28T01:00:00.000Z', sessionCount: 3 },
      isPidAlive: aliveExcept([]),
      isRecordedPidVerified: () => false,
      now: 5,
    });

    expect(response.servers.map((server) => server.pid)).toEqual([4242]);
    expect(response.servers[0].status).toBe('ready');
  });

  it('answers an empty list when nothing is recorded', () => {
    expect(buildManagedServersResponse({ now: 5 })).toEqual({ version: 1, serverTime: 5, servers: [] });
  });
});

describe('GET /api/managed-servers route', () => {
  const createApp = () => {
    const handlers = new Map();
    return {
      handlers,
      get: (routePath, handler) => handlers.set(`GET ${routePath}`, handler),
      post: () => {},
      delete: () => {},
    };
  };

  it('answers with the snapshot the server provides', async () => {
    const app = createApp();
    const snapshot = { version: 1, serverTime: 42, servers: [{ pid: 1 }] };
    registerNotificationRoutes(app, {
      getManagedServersSnapshot: async () => snapshot,
      getSessionActivitySnapshot: () => ({}),
    });

    const handler = app.handlers.get('GET /api/managed-servers');
    expect(handler).toBeDefined();
    const res = { json: vi.fn() };
    await handler({}, res);
    expect(res.json).toHaveBeenCalledWith(snapshot);
  });

  it('answers an empty versioned list when no snapshot is wired', async () => {
    const app = createApp();
    registerNotificationRoutes(app, { getSessionActivitySnapshot: () => ({}) });

    const handler = app.handlers.get('GET /api/managed-servers');
    const res = { json: vi.fn() };
    await handler({}, res);
    const payload = res.json.mock.calls[0][0];
    expect(payload.version).toBe(1);
    expect(payload.servers).toEqual([]);
    expect(payload.serverTime).toEqual(expect.any(Number));
  });
});
