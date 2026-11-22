// External observability contract v1 — paired-client conformance fixture
// (design #612 phase 3, issue #614).
//
// The two builders exercised here are the exact functions behind
// GET /api/session-activity (session-runtime's getSessionActivitySnapshot)
// and GET /api/managed-servers (buildManagedServersResponse, wired in
// lifecycle.js). A paired client running against a live server applies
// the same assertions to the HTTP JSON: pinned envelope and entry key
// sets, version + serverTime presence, explicit unknowns, secret-field
// absence by key set, empty-but-ready semantics, recorded-pid identity
// gating (#638), and a stopped server leaving the registry read on the
// next poll. The contract itself is
// documented in DOCUMENTATION.md, section "External observability
// contract v1".

import { describe, expect, it } from 'vitest';

import { buildManagedServersResponse } from './managed-servers.js';
import { createSessionRuntime } from './session-runtime.js';

const ACTIVITY_ENVELOPE_KEYS = ['serverTime', 'sessions', 'version', 'watcherReady'];
const SESSION_ENTRY_KEYS = ['lastActivityAt', 'model', 'queue', 'status', 'toolInFlight', 'type'];
const QUEUE_BINDING_KEYS = ['issueNumber', 'lane', 'queue', 'taskId'];
const MODEL_KEYS = ['modelID', 'providerID'];
const SERVERS_ENVELOPE_KEYS = ['serverTime', 'servers', 'version'];
const SERVER_ENTRY_KEYS = ['directory', 'pid', 'port', 'sessionCount', 'startedAt', 'status', 'version'];

// Auth material and launch internals that exist in the source records
// (managed state file, registry entries) and must never reach either
// response, under any nesting. Matched by key set, not by today's field
// list alone: any key naming a password, token, secret, fingerprint, or
// credential fails the fixture wherever it appears.
const FORBIDDEN_KEY_PARTS = ['password', 'token', 'secret', 'fingerprint', 'credential'];
const FORBIDDEN_KEYS = new Set(['args', 'binary', 'ownerpid']);

const collectKeys = (value, keys = new Set()) => {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, keys);
  } else if (value && Object.prototype.toString.call(value) === '[object Object]') {
    for (const [key, nested] of Object.entries(value)) {
      keys.add(key);
      collectKeys(nested, keys);
    }
  }
  return keys;
};

const expectNoSecretKeys = (payload) => {
  for (const key of collectKeys(payload)) {
    const lowered = key.toLowerCase();
    expect(FORBIDDEN_KEYS.has(lowered), `forbidden key leaked: ${key}`).toBe(false);
    for (const part of FORBIDDEN_KEY_PARTS) {
      expect(lowered.includes(part), `secret-shaped key leaked: ${key}`).toBe(false);
    }
  }
};

const createRuntime = (overrides = {}) => createSessionRuntime({
  writeSseEvent() {},
  getNotificationClients: () => new Set(),
  broadcastEvent() {},
  ...overrides,
});

describe('observability contract v1 conformance (design #612, #614)', () => {
  it('session-activity: a not-ready read is marked, distinct from empty-but-ready', () => {
    const runtime = createRuntime();
    try {
      const notReady = runtime.getSessionActivitySnapshot();
      expect(Object.keys(notReady).sort()).toEqual(ACTIVITY_ENVELOPE_KEYS);
      expect(notReady.version).toBe(1);
      expect(notReady.serverTime).toEqual(expect.any(Number));
      expect(notReady.watcherReady).toBe(false);
      expect(notReady.sessions).toEqual({});

      // Readiness is owned by BOTH signals (#1441): a watcher payload
      // alone does not mark it, and neither does a connection that has
      // delivered nothing. Together they mark it; a disconnect drops it.
      runtime.processOpenCodeSsePayload({ type: 'server.connected', properties: {} });
      expect(runtime.getSessionActivitySnapshot().watcherReady).toBe(false);
      runtime.setWatcherConnected(true);
      const emptyReady = runtime.getSessionActivitySnapshot();
      expect(emptyReady.watcherReady).toBe(true);
      expect(emptyReady.sessions).toEqual({});
      expectNoSecretKeys(emptyReady);
      runtime.setWatcherConnected(false);
      expect(runtime.getSessionActivitySnapshot().watcherReady).toBe(false);
    } finally {
      runtime.dispose();
    }
  });

  it('session-activity: session entries pin the six-key set and the observed model pair', () => {
    const runtime = createRuntime({
      getSessionModelProvider: (sessionId) => (sessionId === 'session-1'
        ? { modelID: 'model-1', providerID: 'provider-1' }
        : null),
      // The extra sessionSecret key proves the binding is projected
      // through the allowlist: it must never reach the response.
      getSessionQueueBinding: (sessionId) => (sessionId === 'session-1'
        ? {
          taskId: 8495, issueNumber: 1473, queue: 'repo-health-openchamber-pilot', lane: 'openchamber-a', sessionSecret: 'must-not-project',
        }
        : null),
    });
    try {
      runtime.processOpenCodeSsePayload({
        type: 'session.status',
        properties: { sessionID: 'session-1', status: { type: 'busy' } },
      });
      runtime.processOpenCodeSsePayload({
        type: 'session.status',
        properties: { sessionID: 'session-2', status: { type: 'idle' } },
      });

      const snapshot = runtime.getSessionActivitySnapshot();
      expect(Object.keys(snapshot).sort()).toEqual(ACTIVITY_ENVELOPE_KEYS);
      expect(snapshot.version).toBe(1);
      expect(snapshot.serverTime).toEqual(expect.any(Number));

      const withModel = snapshot.sessions['session-1'];
      expect(Object.keys(withModel).sort()).toEqual(SESSION_ENTRY_KEYS);
      expect(withModel.type).toBe('busy');
      expect(withModel.status).toBe('busy');
      expect(withModel.lastActivityAt).toEqual(expect.any(Number));
      expect(Object.keys(withModel.model).sort()).toEqual(MODEL_KEYS);
      expect(withModel.model).toEqual({ modelID: 'model-1', providerID: 'provider-1' });
      // Pinned null today: no in-process source tracks a per-session
      // in-flight tool, and the contract forbids fabricating one.
      expect(withModel.toolInFlight).toBeNull();
      // The bound session's queue binding projects exactly the four
      // allowlisted components (#1473).
      expect(Object.keys(withModel.queue).sort()).toEqual(QUEUE_BINDING_KEYS);
      expect(withModel.queue).toEqual({
        taskId: 8495, issueNumber: 1473, queue: 'repo-health-openchamber-pilot', lane: 'openchamber-a',
      });

      // No observed assistant message yet: the whole model field is an
      // explicit null, never a configured or guessed pair.
      const withoutModel = snapshot.sessions['session-2'];
      expect(Object.keys(withoutModel).sort()).toEqual(SESSION_ENTRY_KEYS);
      expect(withoutModel.model).toBeNull();
      // No binding source knows this session: queue is an explicit null.
      expect(withoutModel.queue).toBeNull();

      expectNoSecretKeys(snapshot);
    } finally {
      runtime.dispose();
    }
  });

  it('managed-servers: the empty registry is a valid read, not an error', () => {
    const response = buildManagedServersResponse({
      registryEntries: [],
      own: null,
      isPidAlive: () => true,
      now: 1_700_000_000_000,
    });

    expect(Object.keys(response).sort()).toEqual(SERVERS_ENVELOPE_KEYS);
    expect(response.version).toBe(1);
    expect(response.serverTime).toBe(1_700_000_000_000);
    expect(response.servers).toEqual([]);
    expectNoSecretKeys(response);
  });

  it('managed-servers: entries pin the seven-key set; source-record secrets never project', () => {
    const response = buildManagedServersResponse({
      registryEntries: [
        {
          pid: 4242, ownerPid: 100, port: 4096, binary: '/bin/opencode', runtime: 'web',
          startedAt: '2026-10-28T01:00:00.000Z', password: 'managed-secret', agentToolToken: 'tool-token',
          fingerprint: 'launch-fingerprint', args: ['serve', '--port', '4096'],
        },
        {
          pid: 777, ownerPid: 555, port: 5001, binary: '/bin/opencode', runtime: 'desktop',
          startedAt: '2026-10-28T00:30:00.000Z', password: 'other-secret', fingerprint: 'other-fingerprint',
        },
      ],
      own: {
        pid: 4242, port: 4096, directory: '/projects/alpha', version: '2.0.19',
        ready: true, startedAt: '2026-10-28T01:00:00.000Z', sessionCount: 3,
      },
      isPidAlive: () => true,
      isRecordedPidVerified: () => true,
      now: 1_700_000_000_000,
    });

    expect(response.version).toBe(1);
    expect(response.servers).toHaveLength(2);
    for (const entry of response.servers) {
      expect(Object.keys(entry).sort()).toEqual(SERVER_ENTRY_KEYS);
    }

    const ownEntry = response.servers.find((entry) => entry.pid === 4242);
    expect(ownEntry.status).toBe('ready');
    expect(ownEntry.directory).toBe('/projects/alpha');
    // The entry version is that server's reported OpenCode version —
    // a different meaning from the envelope's contract version: 1.
    expect(ownEntry.version).toBe('2.0.19');
    expect(ownEntry.sessionCount).toBe(3);

    // Another instance's server: only registry facts are reported, and
    // every unverifiable field is an explicit null under status unknown.
    const otherEntry = response.servers.find((entry) => entry.pid === 777);
    expect(otherEntry).toEqual({
      pid: 777,
      port: 5001,
      directory: null,
      version: null,
      status: 'unknown',
      startedAt: '2026-10-28T00:30:00.000Z',
      sessionCount: null,
    });

    expectNoSecretKeys(response);
  });

  it('managed-servers: a stopped server is absent on the next poll', () => {
    const registryEntries = [
      { pid: 4242, port: 4096, startedAt: '2026-10-28T01:00:00.000Z' },
      { pid: 777, port: 5001, startedAt: '2026-10-28T00:30:00.000Z' },
    ];

    const firstPoll = buildManagedServersResponse({
      registryEntries,
      isPidAlive: () => true,
      isRecordedPidVerified: () => true,
      now: 1_700_000_000_000,
    });
    expect(firstPoll.servers.map((entry) => entry.pid)).toEqual([777, 4242]);

    // The server at pid 4242 stops; the very next read drops it instead
    // of lingering as a zombie entry, while the live entry stays.
    const nextPoll = buildManagedServersResponse({
      registryEntries,
      isPidAlive: (pid) => pid !== 4242,
      isRecordedPidVerified: () => true,
      now: 1_700_000_060_000,
    });
    expect(nextPoll.servers.map((entry) => entry.pid)).toEqual([777]);
    expectNoSecretKeys(nextPoll);
  });

  it('managed-servers: a recorded pid whose identity is not verified is never listed (#638)', () => {
    const registryEntries = [
      { pid: 777, port: 5001, startedAt: '2026-10-28T00:30:00.000Z' },
    ];

    // No verifier wired in: identity cannot be established, so the
    // recorded entry is rejected by default — signal-0 liveness
    // alone never presents a recorded pid as a live server.
    const noVerifier = buildManagedServersResponse({
      registryEntries,
      isPidAlive: () => true,
      now: 1_700_000_000_000,
    });
    expect(noVerifier.servers).toEqual([]);

    // The pid is alive but the live process is not the recorded
    // `opencode serve` for the recorded port (recycled pid): not listed.
    const recycled = buildManagedServersResponse({
      registryEntries,
      isPidAlive: () => true,
      isRecordedPidVerified: () => false,
      now: 1_700_000_000_000,
    });
    expect(recycled.servers).toEqual([]);

    // The hosting instance's own entry is exempt: it comes from live
    // lifecycle state, not from a record, so no verifier is consulted.
    const ownOnly = buildManagedServersResponse({
      registryEntries,
      own: {
        pid: 777, port: 5001, directory: '/projects/alpha', version: '2.0.19',
        ready: true, startedAt: '2026-10-28T00:30:00.000Z', sessionCount: 0,
      },
      isPidAlive: () => true,
      now: 1_700_000_000_000,
    });
    expect(ownOnly.servers.map((entry) => entry.pid)).toEqual([777]);
    expect(ownOnly.servers[0].status).toBe('ready');
    expectNoSecretKeys(ownOnly);
  });

  it('both reads share the version + serverTime envelope a poller keys on', () => {
    const runtime = createRuntime();
    try {
      const activity = runtime.getSessionActivitySnapshot();
      const servers = buildManagedServersResponse({ registryEntries: [], now: activity.serverTime });

      expect(activity.version).toBe(1);
      expect(servers.version).toBe(1);
      expect(activity.serverTime).toEqual(expect.any(Number));
      expect(servers.serverTime).toEqual(expect.any(Number));
    } finally {
      runtime.dispose();
    }
  });
});
