import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  appendGeneration,
  createEmptyManagedOpenCodeStore,
  MANAGED_OPENCODE_STORE_VERSION,
  migrateV1StoreToV2,
  readManagedOpenCodeStore,
  reapManagedOpenCodeStore,
  recordHandoffStep,
  replayHandoffStep,
  resolveManagedOpenCodeStorePaths,
  transitionGenerationState,
  writeDrainingOpenCodeRecords,
  writeManagedOpenCodeState,
  writeManagedOpenCodeStore,
} from './managed-opencode-state.js';

let root;
let storePath;
let statePath;
let drainingPath;

const generation = (overrides = {}) => ({
  pid: 4242,
  port: 45678,
  binary: '/usr/bin/opencode',
  args: ['serve', '--hostname', '127.0.0.1'],
  fingerprint: 'abc123',
  state: 'active',
  started_at: '2026-01-01T00:00:00.000Z',
  ended_at: null,
  ...overrides,
});

const handoff = (overrides = {}) => ({
  handoff_id: 'handoff-1',
  predecessor: 1,
  successor: 2,
  busy_set: ['session-a'],
  step: 'prepared',
  outcome: null,
  at: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-opencode-store-'));
  ({ storePath } = resolveManagedOpenCodeStorePaths(root));
  ({ statePath, drainingPath } = resolveManagedOpenCodeStorePaths(root));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('v2 store file', () => {
  it('round-trips the store document with owner-only permissions', () => {
    let store = createEmptyManagedOpenCodeStore();
    store = appendGeneration(store, generation());
    store = recordHandoffStep(store, handoff());
    writeManagedOpenCodeStore(storePath, store);

    expect(readManagedOpenCodeStore(storePath)).toEqual({ ...store, schema_version: 2 });
    expect(fs.statSync(storePath).mode & 0o777).toBe(0o600);
  });

  it('returns null for a missing, corrupt, or non-v2 document', () => {
    expect(readManagedOpenCodeStore(path.join(root, 'missing.json'))).toBeNull();

    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(storePath, '{not json');
    expect(readManagedOpenCodeStore(storePath)).toBeNull();

    fs.writeFileSync(storePath, JSON.stringify({ schema_version: 1, generations: [], handoffs: [] }));
    expect(readManagedOpenCodeStore(storePath)).toBeNull();

    fs.writeFileSync(storePath, JSON.stringify({ schema_version: 2, generations: [{ bogus: true }], handoffs: [] }));
    expect(readManagedOpenCodeStore(storePath)).toBeNull();

    fs.writeFileSync(storePath, JSON.stringify({ schema_version: 2, generations: [], handoffs: [{ bogus: true }] }));
    expect(readManagedOpenCodeStore(storePath)).toBeNull();
  });
});

describe('generations', () => {
  it('assigns monotonic ids and never rewrites history', () => {
    const empty = createEmptyManagedOpenCodeStore();
    const first = appendGeneration(empty, generation());
    const second = appendGeneration(first, generation({ pid: 4243 }));

    expect(empty.generations).toEqual([]);
    expect(first.generations.map((entry) => entry.generation_id)).toEqual([1]);
    expect(second.generations.map((entry) => entry.generation_id)).toEqual([1, 2]);
  });

  it('rejects invalid generation records', () => {
    expect(() => appendGeneration(createEmptyManagedOpenCodeStore(), generation({ pid: -1 }))).toThrow();
  });

  it('advances starting -> active -> draining -> closed', () => {
    let store = appendGeneration(createEmptyManagedOpenCodeStore(), generation({ state: 'starting' }));
    store = transitionGenerationState(store, 1, 'active');
    store = transitionGenerationState(store, 1, 'draining');
    const closedAt = '2026-02-01T00:00:00.000Z';
    store = transitionGenerationState(store, 1, 'closed', closedAt);

    expect(store.generations[0].state).toBe('closed');
    expect(store.generations[0].ended_at).toBe(closedAt);
  });

  it('rejects skipped and post-close transitions', () => {
    let store = appendGeneration(createEmptyManagedOpenCodeStore(), generation({ state: 'starting' }));
    expect(() => transitionGenerationState(store, 1, 'draining')).toThrow();
    store = transitionGenerationState(store, 1, 'closed');
    expect(() => transitionGenerationState(store, 1, 'active')).toThrow();
    expect(() => transitionGenerationState(store, 999, 'closed')).toThrow();
  });
});

describe('write-ahead handoff record', () => {
  it('upserts the record for one handoff id as steps advance', () => {
    let store = createEmptyManagedOpenCodeStore();
    store = recordHandoffStep(store, handoff({ step: 'prepared' }));
    store = recordHandoffStep(store, handoff({ step: 'switched' }));

    expect(store.handoffs).toHaveLength(1);
    expect(store.handoffs[0].step).toBe('switched');
  });

  it('rejects invalid handoff records', () => {
    expect(() => recordHandoffStep(createEmptyManagedOpenCodeStore(), handoff({ step: 'launched' }))).toThrow();
  });
});

// A crash between two handoff steps is simulated by persisting the store
// after the earlier step and re-reading it from disk — the re-read is the
// whole post-crash state, and replay decides the resume path from it.
const crashBetween = (persistedStep) => {
  let store = appendGeneration(createEmptyManagedOpenCodeStore(), generation());
  store = appendGeneration(store, generation({ pid: 4243, state: 'starting' }));
  store = recordHandoffStep(store, handoff({ step: persistedStep }));
  writeManagedOpenCodeStore(storePath, store);
  const recovered = readManagedOpenCodeStore(storePath);
  return replayHandoffStep(recovered.handoffs.find((entry) => entry.handoff_id === 'handoff-1'));
};

describe('crash replay per handoff step', () => {
  it('resumes the successor start after a crash past prepared', () => {
    expect(crashBetween('prepared')).toEqual({ action: 'resume', reason: 'successor-never-started' });
  });

  it('resumes the readiness confirmation after a crash past switched', () => {
    expect(crashBetween('switched')).toEqual({ action: 'resume', reason: 'successor-readiness-unconfirmed' });
  });

  it('resumes the predecessor drain after a crash past confirmed', () => {
    expect(crashBetween('confirmed')).toEqual({ action: 'resume', reason: 'predecessor-drain-unconfirmed' });
  });

  it('settles an aborted handoff instead of resuming it', () => {
    expect(crashBetween('aborted')).toEqual({ action: 'settle', reason: 'already-aborted' });
  });

  it('aborts recovery for an unknown persisted step', () => {
    expect(replayHandoffStep({ step: 'launched' })).toEqual({ action: 'abort', reason: 'unknown-step' });
    expect(replayHandoffStep(null)).toEqual({ action: 'abort', reason: 'unknown-step' });
  });
});

describe('v1 migration', () => {
  const v1State = {
    pid: 4242,
    port: 45678,
    binary: '/usr/bin/opencode',
    fingerprint: 'abc123',
    password: 'secret-password',
    agentToolToken: null,
    args: ['serve', '--hostname', '127.0.0.1'],
  };

  it('imports every v1 generation with states preserved and loses none', () => {
    writeManagedOpenCodeState(statePath, v1State);
    writeDrainingOpenCodeRecords(drainingPath, [
      { pid: 7001, port: 45001, binary: '/usr/bin/opencode', drainStartedAt: 1700000000000 },
      { pid: 7002, port: 45002, binary: '/usr/bin/opencode', drainStartedAt: 1700000000001 },
    ]);

    const migrated = migrateV1StoreToV2({ statePath, drainingPath });

    // No lost generations: count and pids before/after match exactly.
    expect(migrated.generations.map((entry) => entry.pid)).toEqual([4242, 7001, 7002]);
    expect(migrated.generations.map((entry) => entry.state)).toEqual(['active', 'draining', 'draining']);
    expect(migrated.schema_version).toBe(MANAGED_OPENCODE_STORE_VERSION);
  });

  it('migrates a v1 install with no draining processes to one active generation', () => {
    writeManagedOpenCodeState(statePath, v1State);

    const migrated = migrateV1StoreToV2({ statePath, drainingPath });

    expect(migrated.generations).toHaveLength(1);
    expect(migrated.generations[0]).toMatchObject({ pid: 4242, state: 'active' });
  });

  it('migrates an empty v1 install to an empty store and leaves v1 files untouched', () => {
    const migrated = migrateV1StoreToV2({ statePath, drainingPath });

    expect(migrated.generations).toEqual([]);
    expect(fs.existsSync(statePath)).toBe(false);
    expect(fs.existsSync(drainingPath)).toBe(false);
  });

  it('leaves the v1 files in place for the one-release fallback', () => {
    writeManagedOpenCodeState(statePath, v1State);

    migrateV1StoreToV2({ statePath, drainingPath });

    expect(fs.existsSync(statePath)).toBe(true);
    expect(fs.existsSync(drainingPath)).toBe(false);
  });
});

describe('store-only reaper', () => {
  const deadPid = 2147483647;

  it('closes generations whose pid is gone and records the outcome, without ps', () => {
    let store = appendGeneration(createEmptyManagedOpenCodeStore(), generation({ pid: process.pid }));
    store = appendGeneration(store, generation({ pid: deadPid, state: 'starting' }));

    const { store: reaped, reaped: outcomes } = reapManagedOpenCodeStore(store);

    expect(outcomes).toEqual([{ generation_id: 2, pid: deadPid, outcome: 'pid-gone' }]);
    expect(reaped.generations[0].state).toBe('active');
    expect(reaped.generations[1].state).toBe('closed');
    expect(reaped.generations[1].ended_at).not.toBeNull();
  });

  it('leaves closed generations alone', () => {
    let store = appendGeneration(createEmptyManagedOpenCodeStore(), generation({ pid: deadPid }));
    store = transitionGenerationState(store, 1, 'closed', '2026-02-01T00:00:00.000Z');

    const { store: reaped, reaped: outcomes } = reapManagedOpenCodeStore(store);

    expect(outcomes).toEqual([]);
    expect(reaped.generations[0].ended_at).toBe('2026-02-01T00:00:00.000Z');
  });
});
