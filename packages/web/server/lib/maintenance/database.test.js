import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadSqlite } from '../opencode/opencode-db.js';
import { createDatabaseMaintenance } from './database.js';

const sqlite = loadSqlite();
const describeSqlite = sqlite ? describe : describe.skip;

const previousDb = process.env.OPENCODE_DB;
let dir;
let dbPath;

const silentLogger = { warn: () => {}, log: () => {} };

/**
 * A database with a table large enough that deleting its rows leaves a
 * freelist worth reclaiming, which is what VACUUM is for.
 */
const createDatabaseWithFreelist = () => {
  const db = sqlite(dbPath);
  try {
    // OpenCode runs its database in WAL mode.
    db.exec('PRAGMA journal_mode=WAL');
    db.exec('CREATE TABLE payload (id INTEGER PRIMARY KEY, body TEXT)');
    const body = 'x'.repeat(2000);
    for (let id = 0; id < 3000; id += 1) {
      db.run('INSERT INTO payload (body) VALUES (?)', [body]);
    }
    db.run('DELETE FROM payload');
  } finally {
    db.close();
  }
};

const lifecycle = (overrides = {}) => ({
  isExternalServer: () => false,
  isManagedOpenCodeRunning: () => true,
  getActiveTurnCount: () => 0,
  // Deliberately a stub: compaction must work from the SQLite file alone,
  // with no installed OpenCode binary and no OpenCode process in the loop.
  runWithManagedOpenCodeStopped: async (job) => job(),
  ...overrides,
});

const createMaintenance = (lifecycleOverrides = {}) => createDatabaseMaintenance({
  dataDir: dir,
  getLifecycle: () => lifecycle(lifecycleOverrides),
  logger: silentLogger,
  now: () => 1_700_000_000_000,
});

const waitForCompaction = async (maintenance) => {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const overview = await maintenance.getOverview();
    if (overview.compaction && (overview.compaction.phase === 'done' || overview.compaction.phase === 'failed')) {
      return overview;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('The compaction did not finish in time');
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-db-maintenance-'));
  dbPath = path.join(dir, 'opencode.db');
  process.env.OPENCODE_DB = dbPath;
});

afterEach(() => {
  if (previousDb === undefined) delete process.env.OPENCODE_DB;
  else process.env.OPENCODE_DB = previousDb;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('getOverview', () => {
  it('reports a missing database instead of creating one', async () => {
    const maintenance = createMaintenance();
    const overview = await maintenance.getOverview();
    expect(overview.exists).toBe(false);
    expect(overview.blockedReason).toBe('no-database');
    expect(fs.existsSync(dbPath)).toBe(false);
  });

  describeSqlite('actions', () => {
    it('reports page counters and the reclaimable size', async () => {
      createDatabaseWithFreelist();
      const maintenance = createMaintenance();
      const overview = await maintenance.getOverview();
      expect(overview.exists).toBe(true);
      expect(overview.pageSize).toBeGreaterThan(0);
      expect(overview.pageCount).toBeGreaterThan(0);
      expect(overview.freelistCount).toBeGreaterThan(0);
      expect(overview.reclaimableBytes).toBe(overview.freelistCount * overview.pageSize);
      expect(overview.blockedReason).toBeNull();
    });

    it('refuses to compact a database an external OpenCode holds', async () => {
      createDatabaseWithFreelist();
      const maintenance = createMaintenance({ isExternalServer: () => true });
      await expect(maintenance.compactNow()).rejects.toMatchObject({ code: 'external' });
      const overview = await maintenance.getOverview();
      expect(overview.externalOpenCode).toBe(true);
      expect(overview.blockedReason).toBe('external');
    });

    it('refuses while another process holds the compaction lock', async () => {
      createDatabaseWithFreelist();
      const maintenance = createMaintenance();
      const maintenanceDir = path.join(dir, 'maintenance');
      fs.mkdirSync(maintenanceDir, { recursive: true });
      fs.writeFileSync(path.join(maintenanceDir, 'database-compaction.lock'), JSON.stringify({ pid: process.pid }));
      await expect(maintenance.compactNow()).rejects.toMatchObject({ code: 'busy' });
    });

    it('rewrites the database and records the result', async () => {
      createDatabaseWithFreelist();
      const maintenance = createMaintenance();
      const before = await maintenance.getOverview();

      const started = await maintenance.compactNow();
      expect(started.phase).toBe('stopping');

      const overview = await waitForCompaction(maintenance);
      expect(overview.compaction?.phase).toBe('done');
      expect(overview.bytes).toBeLessThan(before.bytes);
      expect(overview.freelistCount).toBe(0);
      expect(overview.lastCompaction).toMatchObject({ trigger: 'manual', beforeBytes: before.bytes + before.walBytes });
      expect(overview.lastCompaction.freedBytes).toBeGreaterThan(0);

      // The lock is gone, so a second compaction can start.
      expect(fs.existsSync(path.join(dir, 'maintenance', 'database-compaction.lock'))).toBe(false);
    });

    it('preserves rows, user_version and integrity', async () => {
      const db = sqlite(dbPath);
      try {
        db.exec('PRAGMA journal_mode=WAL');
        db.exec('PRAGMA user_version=7');
        db.exec('CREATE TABLE payload (id INTEGER PRIMARY KEY, body TEXT)');
        const body = 'x'.repeat(2000);
        for (let id = 0; id < 3000; id += 1) {
          db.run('INSERT INTO payload (body) VALUES (?)', [body]);
        }
        db.run('DELETE FROM payload WHERE id <= 1500');
      } finally {
        db.close();
      }

      const maintenance = createMaintenance();
      await maintenance.compactNow();
      const overview = await waitForCompaction(maintenance);
      expect(overview.compaction?.phase).toBe('done');

      const reopened = sqlite(dbPath);
      try {
        expect(reopened.all('PRAGMA integrity_check')).toEqual([{ integrity_check: 'ok' }]);
        expect(reopened.all('PRAGMA user_version')).toEqual([{ user_version: 7 }]);
        expect(reopened.all('SELECT COUNT(*) AS count FROM payload')).toEqual([{ count: 1500 }]);
      } finally {
        reopened.close();
      }
    });

    it('writes nothing beside the database and its own maintenance files', async () => {
      createDatabaseWithFreelist();
      const maintenance = createMaintenance();
      await maintenance.compactNow();
      await waitForCompaction(maintenance);

      const besideDatabase = fs.readdirSync(dir).filter((name) => name !== 'maintenance').sort();
      // WAL sidecars may survive the checkpoint; nothing else may appear.
      expect(besideDatabase.every((name) => name.startsWith('opencode.db'))).toBe(true);
      expect(besideDatabase).toContain('opencode.db');
      expect(fs.readdirSync(path.join(dir, 'maintenance'))).toEqual(['database-compaction.json']);
    });

    it('runs a queued compaction before the managed child starts and clears the request', async () => {
      createDatabaseWithFreelist();
      const maintenance = createMaintenance();
      await maintenance.scheduleForNextRestart();

      const result = await maintenance.runQueuedDatabaseCompactionAtStartup();
      expect(result).toMatchObject({ trigger: 'next-restart' });
      expect(fs.existsSync(path.join(dir, 'maintenance', 'database-compaction.next-start'))).toBe(false);

      const overview = await maintenance.getOverview();
      expect(overview.pendingOnNextRestart).toBe(false);
      expect(overview.lastCompaction?.trigger).toBe('next-restart');
    });

    it('does not compact at startup without a queued request', async () => {
      createDatabaseWithFreelist();
      const maintenance = createMaintenance();
      expect(await maintenance.runQueuedDatabaseCompactionAtStartup()).toBeNull();
      // Startup stays out of the way even when a rewrite would reclaim pages.
      const overview = await maintenance.getOverview();
      expect(overview.compaction).toBeNull();
      expect(overview.lastCompaction).toBeNull();
      expect(overview.freelistCount).toBeGreaterThan(0);
    });

    it('spends a queued request when there is nothing to reclaim', async () => {
      const db = sqlite(dbPath);
      try {
        db.exec('CREATE TABLE small (id INTEGER PRIMARY KEY)');
        db.run('INSERT INTO small (id) VALUES (1)');
      } finally {
        db.close();
      }
      const maintenance = createMaintenance();
      await maintenance.scheduleForNextRestart();
      expect(await maintenance.runQueuedDatabaseCompactionAtStartup()).toBeNull();
      const overview = await maintenance.getOverview();
      expect(overview.pendingOnNextRestart).toBe(false);
    });
  });
});
