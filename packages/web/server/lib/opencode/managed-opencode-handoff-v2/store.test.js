import { createHash, randomBytes } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as windowsAcl from '../../guardian/windows-acl.js';
import { ManagedOpenCodeHandoffV2State } from './record.js';
import {
  MANAGED_OPENCODE_HANDOFF_V2_STORE_FILENAME,
  createManagedOpenCodeHandoffV2Store,
} from './store.js';

const roots = [];

const createRoot = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-handoff-v2-store-'));
  fs.chmodSync(root, 0o700);
  roots.push(root);
  return root;
};

const createRecord = ({
  incarnation = randomBytes(32).toString('base64url'),
  state = ManagedOpenCodeHandoffV2State.Reserved,
  createdAt = Date.now() - 1_000,
  leaseExpiresAt = Date.now() + 60_000,
  revision = 0,
  mac = randomBytes(32).toString('base64url'),
  credentialFingerprint = randomBytes(32).toString('base64url'),
} = {}) => ({
  v: 2,
  state,
  incarnation,
  ownerInstanceId: null,
  runtimeIdentity: null,
  launchFingerprint: null,
  launchSpec: null,
  credentialFingerprint,
  pid: null,
  port: null,
  processStartTicks: null,
  createdAt,
  leaseExpiresAt,
  revision,
  mac,
});

const expectedFor = (record) => ({
  revision: record.revision,
  mac: record.mac,
  leaseExpiresAt: record.leaseExpiresAt,
});

const windowsAclOptions = {
  username: 'alice',
  aclInspector: () => ({ entries: [{ principal: 'alice', rights: ['F'] }] }),
};

afterEach(() => {
  vi.restoreAllMocks();
  while (roots.length > 0) {
    fs.rmSync(roots.pop(), { recursive: true, force: true });
  }
});

const startStoreWorker = (rootDir) => {
  const worker = new Worker(new URL('./store-init-worker.js', import.meta.url), { workerData: { rootDir } });
  const ready = new Promise((resolve, reject) => {
    const onMessage = (message) => {
      if (message?.type !== 'ready') return;
      worker.off('message', onMessage);
      resolve();
    };
    worker.once('error', reject);
    worker.on('message', onMessage);
  });
  const result = new Promise((resolve, reject) => {
    const onMessage = (message) => {
      if (message?.type !== 'result') return;
      worker.off('message', onMessage);
      resolve(message);
    };
    worker.once('error', reject);
    worker.on('message', onMessage);
  });
  return { ready, result, worker };
};

const startStoreChild = () => {
  const child = fork(
    fileURLToPath(new URL('./store-init-child.js', import.meta.url)),
    [],
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
  );
  const ready = new Promise((resolve, reject) => {
    const onMessage = (message) => {
      if (message?.type !== 'ready') return;
      child.off('message', onMessage);
      resolve();
    };
    child.once('error', reject);
    child.on('message', onMessage);
  });
  const result = new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      child.off('message', onMessage);
      child.off('error', onError);
      child.off('exit', onExit);
      callback(value);
    };
    const onMessage = (message) => {
      if (message?.type === 'result') finish(resolve, message);
    };
    const onError = (error) => finish(reject, error);
    const onExit = (code, signal) => finish(
      reject,
      new Error(`Store child exited before reporting a result (${code ?? signal ?? 'unknown'})`),
    );
    child.on('message', onMessage);
    child.on('error', onError);
    child.on('exit', onExit);
  });
  return { child, ready, result };
};

const stopStoreChild = async (child) => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill();
  await exited;
};

describe('managed OpenCode handoff v2 SQLite store', () => {
  it('uses Windows ACL/durability handling without an unconditional POSIX mode check', async () => {
    const root = createRoot();
    vi.spyOn(windowsAcl, 'applyDirectoryAcl').mockReturnValue({ ok: true, username: 'alice' });
    const chmodSpy = vi.spyOn(fs, 'chmodSync');
    const store = createManagedOpenCodeHandoffV2Store({ rootDir: root, platform: 'win32', ...windowsAclOptions });
    await store.close();

    const databasePath = path.join(root, MANAGED_OPENCODE_HANDOFF_V2_STORE_FILENAME);
    expect(chmodSpy).not.toHaveBeenCalled();

    // A Windows ACL, rather than a POSIX mode bit, is the permission check
    // for an existing database when the platform seam is exercised on Linux.
    fs.chmodSync(databasePath, 0o644);
    const reopened = createManagedOpenCodeHandoffV2Store({ rootDir: root, platform: 'win32', ...windowsAclOptions });
    await reopened.close();
  });

  it('rejects an existing SQLite file with an unsafe Windows ACL', async () => {
    const root = createRoot();
    vi.spyOn(windowsAcl, 'applyDirectoryAcl').mockReturnValue({ ok: true, username: 'alice' });
    const store = createManagedOpenCodeHandoffV2Store({
      rootDir: root,
      platform: 'win32',
      ...windowsAclOptions,
    });
    await store.close();

    expect(() => createManagedOpenCodeHandoffV2Store({
      rootDir: root,
      platform: 'win32',
      username: 'alice',
      aclInspector: () => ({
        entries: [
          { principal: 'alice', rights: ['F'] },
          { principal: 'Everyone', rights: ['F'] },
        ],
      }),
    })).toThrow(/unapproved principal/);
  });

  it.skipIf(process.platform === 'win32')('persists a public record in a separate WAL database', async () => {
    const root = createRoot();
    const record = createRecord();
    const store = createManagedOpenCodeHandoffV2Store({ rootDir: root });

    await expect(store.compareAndSwap({
      incarnation: record.incarnation,
      expected: null,
      next: record,
    })).resolves.toEqual({ status: 'applied' });
    await store.close();

    const reopened = createManagedOpenCodeHandoffV2Store({ rootDir: root });
    await expect(reopened.read({ incarnation: record.incarnation })).resolves.toEqual(record);
    expect(await reopened.hasV2Records()).toBe(true);
    const interrupted = {
      ...record,
      state: ManagedOpenCodeHandoffV2State.Interrupted,
      revision: 1,
      mac: randomBytes(32).toString('base64url'),
    };
    await expect(reopened.compareAndSwap({
      incarnation: record.incarnation,
      expected: expectedFor(record),
      next: interrupted,
    })).resolves.toEqual({ status: 'applied' });
    await expect(reopened.cleanup()).resolves.toEqual({ removed: 0 });
    expect(await reopened.hasV2Records()).toBe(true);
    await reopened.close();

    const expiredCreatedAt = Date.now() - 10_000;
    const database = new Database(path.join(root, MANAGED_OPENCODE_HANDOFF_V2_STORE_FILENAME));
    database.prepare(`
      UPDATE managed_opencode_handoff_v2_records
      SET created_at = ?, lease_expires_at = ?
      WHERE incarnation = ?
    `).run(expiredCreatedAt, expiredCreatedAt + 1_000, record.incarnation);
    database.close();

    const cleanupStore = createManagedOpenCodeHandoffV2Store({ rootDir: root });
    await expect(cleanupStore.cleanup()).resolves.toEqual({ removed: 1 });
    expect(await cleanupStore.hasV2Records()).toBe(false);
    await cleanupStore.close();

    const databasePath = path.join(root, MANAGED_OPENCODE_HANDOFF_V2_STORE_FILENAME);
    const journalDatabase = new Database(databasePath, { readonly: true });
    expect(String(journalDatabase.pragma('journal_mode', { simple: true })).toLowerCase()).toBe('wal');
    journalDatabase.close();
    expect(fs.statSync(root).mode & 0o777).toBe(0o700);
    expect(fs.statSync(databasePath).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === 'win32')('retains an expired stopping record as a recovery handle', async () => {
    const root = createRoot();
    const record = createRecord({
      state: ManagedOpenCodeHandoffV2State.Stopping,
      createdAt: Date.now() - 10_000,
      leaseExpiresAt: Date.now() + 60_000,
    });
    const store = createManagedOpenCodeHandoffV2Store({ rootDir: root });
    await expect(store.compareAndSwap({
      incarnation: record.incarnation,
      expected: null,
      next: record,
    })).resolves.toEqual({ status: 'applied' });
    await store.close();

    const database = new Database(path.join(root, MANAGED_OPENCODE_HANDOFF_V2_STORE_FILENAME));
    const expiredAt = Date.now() - 10_000;
    database.prepare(`
      UPDATE managed_opencode_handoff_v2_records
      SET created_at = ?, lease_expires_at = ?
      WHERE incarnation = ?
    `).run(expiredAt - 1_000, expiredAt, record.incarnation);
    database.close();

    const reopened = createManagedOpenCodeHandoffV2Store({ rootDir: root });
    await expect(reopened.cleanup()).resolves.toEqual({ removed: 0 });
    await expect(reopened.read({ incarnation: record.incarnation })).resolves.toMatchObject({
      incarnation: record.incarnation,
      state: ManagedOpenCodeHandoffV2State.Stopping,
    });
    await reopened.close();
  });

  it.skipIf(process.platform === 'win32')('atomically fences concurrent, stale, and expired compare-and-swap requests', async () => {
    const root = createRoot();
    const store = createManagedOpenCodeHandoffV2Store({ rootDir: root });
    const incarnation = randomBytes(32).toString('base64url');
    const first = createRecord({ incarnation });
    const second = createRecord({ incarnation, mac: randomBytes(32).toString('base64url') });

    const results = await Promise.all([
      store.compareAndSwap({ incarnation, expected: null, next: first }),
      store.compareAndSwap({ incarnation, expected: null, next: second }),
    ]);
    expect(results.filter((result) => result.status === 'applied')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'conflict')).toHaveLength(1);

    const stored = await store.read({ incarnation });
    const next = {
      ...stored,
      state: ManagedOpenCodeHandoffV2State.Launching,
      revision: stored.revision + 1,
      mac: randomBytes(32).toString('base64url'),
    };
    await expect(store.compareAndSwap({
      incarnation,
      expected: expectedFor(stored),
      next,
    })).resolves.toEqual({ status: 'applied' });
    await expect(store.compareAndSwap({
      incarnation,
      expected: expectedFor(stored),
      next: { ...next, revision: next.revision + 1, mac: randomBytes(32).toString('base64url') },
    })).resolves.toEqual({ status: 'conflict' });

    const expired = createRecord({
      incarnation: randomBytes(32).toString('base64url'),
      createdAt: Date.now() - 10_000,
      leaseExpiresAt: Date.now() - 1_000,
    });
    await expect(store.compareAndSwap({
      incarnation: expired.incarnation,
      expected: null,
      next: expired,
    })).resolves.toEqual({ status: 'expired' });
    await store.close();
  });

  it.skipIf(process.platform === 'win32')('fails closed when an existing database contains a malformed row', async () => {
    const root = createRoot();
    const store = createManagedOpenCodeHandoffV2Store({ rootDir: root });
    await store.close();

    const databasePath = path.join(root, MANAGED_OPENCODE_HANDOFF_V2_STORE_FILENAME);
    const database = new Database(databasePath);
    database.pragma('ignore_check_constraints = ON');
    database.prepare(`
      INSERT INTO managed_opencode_handoff_v2_records (
        incarnation, version, state, credential_fingerprint, pid, port,
        process_start_ticks, created_at, lease_expires_at, revision, mac
      ) VALUES (?, 2, 'invalid-state', ?, NULL, NULL, NULL, ?, ?, 0, ?)
    `).run(
      randomBytes(32).toString('base64url'),
      randomBytes(32).toString('base64url'),
      Date.now() - 1_000,
      Date.now() + 60_000,
      randomBytes(32).toString('base64url'),
    );
    database.close();

    expect(() => createManagedOpenCodeHandoffV2Store({ rootDir: root })).toThrow(/corrupt|malformed/);
  });

  it.skipIf(process.platform === 'win32')('stores only public credential fingerprints and no raw credential column or value', async () => {
    const root = createRoot();
    const store = createManagedOpenCodeHandoffV2Store({ rootDir: root });
    const rawCredential = randomBytes(32);
    const record = createRecord({
      credentialFingerprint: createHash('sha256').update(rawCredential).digest('base64url'),
    });

    await expect(store.compareAndSwap({
      incarnation: record.incarnation,
      expected: null,
      next: record,
    })).resolves.toEqual({ status: 'applied' });
    await store.close();

    const database = new Database(path.join(root, MANAGED_OPENCODE_HANDOFF_V2_STORE_FILENAME), { readonly: true });
    const row = database.prepare('SELECT * FROM managed_opencode_handoff_v2_records').get();
    const rawText = rawCredential.toString('base64url');
    expect(Object.keys(row)).not.toContain('credential');
    expect(Object.keys(row)).toContain('credential_fingerprint');
    expect(JSON.stringify(row)).not.toContain(rawText);
    database.close();
    rawCredential.fill(0);
  });

  it.skipIf(process.platform === 'win32')('converges real simultaneous independent store initialization', async () => {
    const root = createRoot();
    const first = startStoreWorker(root);
    const second = startStoreWorker(root);
    try {
      await Promise.all([first.ready, second.ready]);
      first.worker.postMessage({ type: 'open' });
      second.worker.postMessage({ type: 'open' });
      await expect(Promise.all([first.result, second.result])).resolves.toEqual([
        { type: 'result', ok: true },
        { type: 'result', ok: true },
      ]);

      const store = createManagedOpenCodeHandoffV2Store({ rootDir: root });
      await store.close();
    } finally {
      await Promise.all([first.worker.terminate(), second.worker.terminate()]);
    }
  });

  it.skipIf(process.platform === 'win32')('converges real simultaneous OS-process store initialization', async () => {
    const root = createRoot();
    const first = startStoreChild();
    const second = startStoreChild();
    try {
      await Promise.all([first.ready, second.ready]);
      first.child.send({ type: 'open', rootDir: root });
      second.child.send({ type: 'open', rootDir: root });
      await expect(Promise.all([first.result, second.result])).resolves.toEqual([
        { type: 'result', ok: true },
        { type: 'result', ok: true },
      ]);

      const store = createManagedOpenCodeHandoffV2Store({ rootDir: root });
      await store.close();
    } finally {
      await Promise.all([stopStoreChild(first.child), stopStoreChild(second.child)]);
    }
  });

  it.skipIf(process.platform === 'win32')('rejects under-constrained, sqlite-lookalike, or unexpected schema objects even when metadata matches', async () => {
    const underConstrainedRoot = createRoot();
    const underConstrainedPath = path.join(underConstrainedRoot, MANAGED_OPENCODE_HANDOFF_V2_STORE_FILENAME);
    const underConstrained = new Database(underConstrainedPath);
    underConstrained.exec(`
      CREATE TABLE managed_opencode_handoff_v2_records (
        incarnation TEXT PRIMARY KEY NOT NULL,
        version INTEGER NOT NULL,
        state TEXT NOT NULL,
        credential_fingerprint TEXT NOT NULL,
        pid INTEGER,
        port INTEGER,
        process_start_ticks INTEGER,
        created_at INTEGER NOT NULL,
        lease_expires_at INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        mac TEXT NOT NULL
      ) STRICT;
    `);
    underConstrained.pragma('user_version = 2421004');
    underConstrained.pragma('application_id = 0x4f434832');
    underConstrained.close();
    fs.chmodSync(underConstrainedPath, 0o600);
    expect(() => createManagedOpenCodeHandoffV2Store({ rootDir: underConstrainedRoot })).toThrow(/schema is invalid/);

    const triggerRoot = createRoot();
    const validStore = createManagedOpenCodeHandoffV2Store({ rootDir: triggerRoot });
    await validStore.close();
    const triggerDatabase = new Database(path.join(triggerRoot, MANAGED_OPENCODE_HANDOFF_V2_STORE_FILENAME));
    triggerDatabase.exec(`
      CREATE TRIGGER managed_opencode_handoff_v2_unexpected_trigger
      AFTER INSERT ON managed_opencode_handoff_v2_records
      BEGIN SELECT 1; END;
    `);
    triggerDatabase.close();
    expect(() => createManagedOpenCodeHandoffV2Store({ rootDir: triggerRoot })).toThrow(/schema is invalid/);

    const lookalikes = [
      `CREATE TRIGGER sqliteEvil_trigger
       AFTER INSERT ON managed_opencode_handoff_v2_records
       BEGIN SELECT 1; END;`,
      `CREATE VIEW sqliteEvil_view AS
       SELECT incarnation FROM managed_opencode_handoff_v2_records;`,
      `CREATE INDEX sqliteEvil_index
       ON managed_opencode_handoff_v2_records (revision);`,
    ];
    for (const definition of lookalikes) {
      const root = createRoot();
      const store = createManagedOpenCodeHandoffV2Store({ rootDir: root });
      await store.close();
      const database = new Database(path.join(root, MANAGED_OPENCODE_HANDOFF_V2_STORE_FILENAME));
      database.exec(definition);
      database.close();
      expect(() => createManagedOpenCodeHandoffV2Store({ rootDir: root })).toThrow(/schema is invalid/);
    }

    for (const pragma of [
      'user_version = 2421005',
      'application_id = 0x4f434833',
    ]) {
      const root = createRoot();
      const store = createManagedOpenCodeHandoffV2Store({ rootDir: root });
      await store.close();
      const database = new Database(path.join(root, MANAGED_OPENCODE_HANDOFF_V2_STORE_FILENAME));
      database.pragma(pragma);
      database.close();
      expect(() => createManagedOpenCodeHandoffV2Store({ rootDir: root })).toThrow(/schema is invalid/);
    }
  });

  it.skipIf(process.platform === 'win32')('fails store initialization when POSIX directory fsync fails', () => {
    const root = createRoot();
    const failure = Object.assign(new Error('directory fsync failed'), { code: 'EIO' });
    vi.spyOn(fs, 'fsyncSync').mockImplementation(() => { throw failure; });
    expect(() => createManagedOpenCodeHandoffV2Store({ rootDir: root })).toThrow(/directory fsync failed/);
  });

  it.skipIf(process.platform === 'win32')('builds lease candidates from transaction-authoritative time and rejects an unbounded horizon', async () => {
    const root = createRoot();
    const store = createManagedOpenCodeHandoffV2Store({ rootDir: root });
    const incarnation = randomBytes(32).toString('base64url');
    let reservedAt;
    await expect(store.compareAndSwap({
      incarnation,
      expected: null,
      nextForAuthoritativeTime: (now) => {
        reservedAt = now;
        return createRecord({
          incarnation,
          createdAt: now,
          leaseExpiresAt: now + 10_000,
        });
      },
    })).resolves.toEqual({ status: 'applied' });
    const reserved = await store.read({ incarnation });
    expect(reserved.leaseExpiresAt).toBe(reservedAt + 10_000);

    let renewedAt;
    await expect(store.compareAndSwap({
      incarnation,
      expected: expectedFor(reserved),
      nextForAuthoritativeTime: (now) => {
        renewedAt = now;
        return {
          ...reserved,
          state: ManagedOpenCodeHandoffV2State.Launching,
          revision: reserved.revision + 1,
          leaseExpiresAt: now + 10_000,
          mac: randomBytes(32).toString('base64url'),
        };
      },
    })).resolves.toEqual({ status: 'applied' });
    const renewed = await store.read({ incarnation });
    expect(renewed.leaseExpiresAt).toBe(renewedAt + 10_000);

    await expect(store.compareAndSwap({
      incarnation,
      expected: expectedFor(renewed),
      nextForAuthoritativeTime: (now) => ({
        ...renewed,
        revision: renewed.revision + 1,
        leaseExpiresAt: now + (24 * 60 * 60 * 1000) + 1,
        mac: randomBytes(32).toString('base64url'),
      }),
    })).rejects.toThrow(/maximum horizon/);
    await store.close();
  });
});
