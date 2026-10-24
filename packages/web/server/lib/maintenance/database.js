/**
 * Reclaims the free pages OpenCode's SQLite database keeps after sessions are
 * deleted or archived.
 *
 * SQLite never returns deleted pages to the filesystem on its own, so the file
 * grows with use and stays large after a cleanup. `VACUUM` rewrites it and
 * needs the database to itself: OpenChamber stops its managed OpenCode, runs
 * the rewrite in a forked worker (both drivers are synchronous, and a
 * multi-gigabyte VACUUM would freeze this process), then starts OpenCode again.
 *
 * OpenChamber never reads or rewrites OpenCode's tables here. The worker runs
 * three statements: `PRAGMA wal_checkpoint(TRUNCATE)`, `VACUUM`, and
 * `PRAGMA integrity_check`.
 *
 * Rules that keep this safe:
 *
 * 1. An external OpenCode is refused. OpenChamber did not start it, cannot stop
 *    it, and must not rewrite a file another process holds.
 * 2. Only one compaction runs at a time, across every OpenChamber server that
 *    shares the data directory. The lock file carries its owner's pid, so a
 *    crashed holder's lock is reclaimed instead of blocking forever.
 * 3. Enough free disk must exist before the rewrite starts. A failed VACUUM
 *    leaves the original database untouched and the child restarted.
 * 4. A queued compaction that runs before OpenCode spawns ("next restart")
 *    never throws: a maintenance failure must not keep OpenCode down. Startup
 *    never compacts on its own.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { loadSqlite, isInMemoryOpenCodeDb, resolveOpenCodeDbPath } from '../opencode/opencode-db.js';
import { serverDiagnosticJournal } from '../diagnostics/server-journal.js';
import { writeFileAtomic } from '../opencode/atomic-write.js';
import { helperSpawnEnv } from '../git/helper-launch.js';

/** VACUUM writes a full second copy before replacing the original. */
const FREE_SPACE_MARGIN = 1.1;
const WORKER_STDERR_MAX_CHARS = 2000;

const lastResultSchema = z.object({
  at: z.string(),
  trigger: z.enum(['manual', 'next-restart']),
  beforeBytes: z.number(),
  afterBytes: z.number(),
  freedBytes: z.number(),
});

const workerMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('step'), step: z.enum(['checkpoint', 'vacuum', 'integrity']) }),
  z.object({ type: z.literal('done') }),
  z.object({ type: z.literal('error'), message: z.string().optional() }),
]);

class DatabaseMaintenanceError extends Error {
  constructor(code, message, statusCode = 409) {
    super(message);
    this.name = 'DatabaseMaintenanceError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const isPidAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return error?.code === 'EPERM';
  }
};

const firstRow = (rows) => (Array.isArray(rows) ? rows[0] : undefined);

const readPragmaNumber = (db, name, fallback = 0) => {
  const row = firstRow(db.all(`PRAGMA ${name}`));
  const value = Number(row?.[name]);
  return Number.isFinite(value) ? value : fallback;
};

const fileBytes = async (filePath) => {
  try {
    const stats = await fs.promises.stat(filePath);
    return stats.isFile() ? stats.size : 0;
  } catch {
    return 0;
  }
};

/**
 * `VACUUM` needs roughly the live database size again in free space while it
 * builds its replacement. Returns null when the runtime has no `statfs`, so
 * the caller checks what it can instead of refusing to work.
 */
const availableBytes = async (directory) => {
  try {
    const stats = await fs.promises.statfs(directory);
    const available = Number(stats.bavail) * Number(stats.bsize);
    return Number.isFinite(available) ? available : null;
  } catch {
    return null;
  }
};

export const createDatabaseMaintenance = ({
  dataDir,
  getLifecycle = () => null,
  fileSystem = fs,
  journal = serverDiagnosticJournal,
  logger = console,
  now = Date.now,
}) => {
  const maintenanceDir = path.join(dataDir, 'maintenance');
  const lockPath = path.join(maintenanceDir, 'database-compaction.lock');
  const resultPath = path.join(maintenanceDir, 'database-compaction.json');
  const nextStartFlagPath = path.join(maintenanceDir, 'database-compaction.next-start');

  /** @type {null | {id: string, phase: string, trigger: string, startedAt: number, finishedAt: number | null, error: string | null, result: object | null, beforeBytes: number | null}} */
  let activeJob = null;
  let lastJob = null;

  const snapshotJob = () => {
    const job = activeJob ?? lastJob;
    return job ? { ...job } : null;
  };

  const readLastResult = () => {
    try {
      const parsed = lastResultSchema.safeParse(JSON.parse(fileSystem.readFileSync(resultPath, 'utf8')));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  };

  const persistResult = (result) => {
    try {
      fileSystem.mkdirSync(maintenanceDir, { recursive: true });
      writeFileAtomic(resultPath, JSON.stringify(result));
    } catch (error) {
      logger.warn('[database] Could not persist the compaction result:', error?.message ?? error);
    }
  };

  const setPhase = (phase) => {
    if (!activeJob) return;
    activeJob.phase = phase;
  };

  const resolveDbPath = () => resolveOpenCodeDbPath();

  const readStats = async (dbPath = resolveDbPath()) => {
    const inMemory = isInMemoryOpenCodeDb();
    const exists = !inMemory && fileSystem.existsSync(dbPath);
    const bytes = exists ? await fileBytes(dbPath) : 0;
    const walBytes = exists ? await fileBytes(`${dbPath}-wal`) : 0;
    const stats = {
      path: inMemory ? null : dbPath,
      inMemory,
      exists,
      bytes,
      walBytes,
      pageSize: 0,
      pageCount: 0,
      freelistCount: 0,
      reclaimableBytes: 0,
      liveBytes: 0,
    };
    const open = loadSqlite();
    if (!exists || !open) return stats;

    let db;
    try {
      db = open(dbPath);
      const pageSize = readPragmaNumber(db, 'page_size');
      const pageCount = readPragmaNumber(db, 'page_count');
      const freelistCount = readPragmaNumber(db, 'freelist_count');
      return {
        ...stats,
        pageSize,
        pageCount,
        freelistCount,
        reclaimableBytes: freelistCount * pageSize,
        liveBytes: Math.max(0, bytes - freelistCount * pageSize),
      };
    } catch (error) {
      logger.warn('[database] Could not read the database statistics:', error?.message ?? error);
      return stats;
    } finally {
      try {
        db?.close();
      } catch {
        // A read-only statistics pass must never break the settings page.
      }
    }
  };

  const acquireLock = async () => {
    await fs.promises.mkdir(maintenanceDir, { recursive: true });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await fs.promises.open(lockPath, 'wx');
        try {
          await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: now() }));
        } finally {
          await handle.close();
        }
        return async () => {
          await fs.promises.rm(lockPath, { force: true }).catch(() => {});
        };
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        const ownerPid = (() => {
          try {
            return Number(JSON.parse(fileSystem.readFileSync(lockPath, 'utf8'))?.pid);
          } catch {
            return 0;
          }
        })();
        if (isPidAlive(ownerPid)) {
          throw new DatabaseMaintenanceError('busy', 'Another compaction is already running');
        }
        // The holder died before it could clean up.
        await fs.promises.rm(lockPath, { force: true }).catch(() => {});
      }
    }
    throw new DatabaseMaintenanceError('busy', 'Another compaction is already running');
  };

  const runVacuumWorker = (dbPath, { onStep } = {}) => new Promise((resolve, reject) => {
    const workerPath = fileURLToPath(new URL('./vacuum-worker.js', import.meta.url));
    const child = fork(workerPath, [dbPath], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      windowsHide: true,
      serialization: 'advanced',
      // Under Electron, the executable is the app, so the worker needs to be
      // told to behave as Node. The same helper starts Git's scripts.
      env: helperSpawnEnv(process.env),
      // Vitest and dev runners pass loaders through execArgv that the worker
      // does not need; inheriting them can keep a plain Node script from
      // starting at all.
      execArgv: [],
    });
    let stderrTail = '';
    let settled = false;

    const settle = (error) => {
      if (settled) return;
      settled = true;
      // The worker has finished; drop the IPC channel and the handle so a
      // long-lived server accumulates neither per compaction. A Bun parent
      // otherwise stays alive after the promise resolves.
      try {
        if (child.connected) child.disconnect();
      } catch {
        // Already disconnected by the exit handler.
      }
      child.unref();
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };

    child.stderr?.on('data', (chunk) => {
      stderrTail = `${stderrTail}${String(chunk)}`.slice(-WORKER_STDERR_MAX_CHARS);
    });
    child.on('message', (message) => {
      const parsed = workerMessageSchema.safeParse(message);
      if (!parsed.success) return;
      const event = parsed.data;
      if (event.type === 'step') onStep?.(event.step);
      if (event.type === 'done') settle(null);
      if (event.type === 'error') {
        const detail = event.message || 'The compaction worker failed';
        settle(new Error(stderrTail.trim() ? `${detail}: ${stderrTail.trim()}` : detail));
      }
    });
    child.on('error', (error) => settle(error));
    child.on('exit', (code, signal) => {
      // A clean worker exits after `done`, which has already settled the promise.
      if (code === 0) {
        settle(null);
        return;
      }
      settle(new Error(stderrTail.trim() || `The compaction worker exited with ${signal || `code ${code}`}`));
    });
  });

  const runCompaction = async ({ trigger, onStep, lock }) => {
    const releaseLock = lock ?? await acquireLock();
    try {
      const dbPath = resolveDbPath();
      const before = await readStats(dbPath);
      if (!before.exists) throw new DatabaseMaintenanceError('no-database', 'OpenCode has no database file yet');
      if (before.freelistCount === 0) {
        throw new DatabaseMaintenanceError('nothing-reclaimable', 'The database has no free pages to reclaim');
      }
      const available = await availableBytes(path.dirname(dbPath));
      if (available !== null && available < (before.bytes + before.walBytes) * FREE_SPACE_MARGIN) {
        throw new DatabaseMaintenanceError(
          'insufficient-space',
          'Not enough free disk space to rewrite the database',
          507,
        );
      }

      journal.record('database compact started');
      await runVacuumWorker(dbPath, { onStep });

      const after = await readStats(dbPath);
      // Count the WAL too: in WAL mode the main file can grow during the
      // rewrite while the checkpointed WAL shrinks by more.
      const beforeTotalBytes = before.bytes + before.walBytes;
      const afterTotalBytes = after.bytes + after.walBytes;
      const result = {
        at: new Date(now()).toISOString(),
        trigger,
        beforeBytes: beforeTotalBytes,
        afterBytes: afterTotalBytes,
        freedBytes: Math.max(0, beforeTotalBytes - afterTotalBytes),
      };
      persistResult(result);
      journal.record('database compact done');
      return result;
    } catch (error) {
      journal.record('database compact failed', { failureClass: 'error' });
      throw error;
    } finally {
      await releaseLock();
    }
  };

  const getOverview = async () => {
    const lifecycle = getLifecycle();
    const stats = await readStats();
    const pendingOnNextRestart = fileSystem.existsSync(nextStartFlagPath);
    const busy = activeJob !== null;
    const external = lifecycle?.isExternalServer?.() ?? false;
    const openCodeRunning = lifecycle?.isManagedOpenCodeRunning?.() ?? false;
    const activeTurns = lifecycle?.getActiveTurnCount?.() ?? 0;

    let blockedReason = null;
    if (stats.inMemory) blockedReason = 'in-memory';
    else if (!stats.exists) blockedReason = 'no-database';
    else if (external) blockedReason = 'external';
    else if (busy) blockedReason = 'busy';
    else if (!loadSqlite()) blockedReason = 'sqlite-unavailable';
    else if (stats.freelistCount === 0) blockedReason = 'nothing-reclaimable';

    return {
      ...stats,
      openCodeRunning,
      externalOpenCode: external,
      activeTurns,
      pendingOnNextRestart,
      blockedReason,
      compaction: snapshotJob(),
      lastCompaction: readLastResult(),
    };
  };

  const compactNow = async () => {
    const lifecycle = getLifecycle();
    if (!lifecycle) throw new DatabaseMaintenanceError('unavailable', 'OpenCode lifecycle is not available', 503);
    if (activeJob) throw new DatabaseMaintenanceError('busy', 'A compaction is already running');
    if (lifecycle.isExternalServer?.()) {
      throw new DatabaseMaintenanceError('external', 'OpenChamber does not manage this OpenCode server');
    }
    if (isInMemoryOpenCodeDb()) {
      throw new DatabaseMaintenanceError('in-memory', 'OpenCode keeps this session database in memory');
    }
    if (!loadSqlite()) {
      throw new DatabaseMaintenanceError('sqlite-unavailable', 'No SQLite driver is available', 503);
    }

    const before = await readStats();
    if (!before.exists) throw new DatabaseMaintenanceError('no-database', 'OpenCode has no database file yet');
    if (before.freelistCount === 0) {
      throw new DatabaseMaintenanceError('nothing-reclaimable', 'The database has no free pages to reclaim');
    }
    const available = await availableBytes(path.dirname(resolveDbPath()));
    if (available !== null && available < (before.bytes + before.walBytes) * FREE_SPACE_MARGIN) {
      throw new DatabaseMaintenanceError(
        'insufficient-space',
        'Not enough free disk space to rewrite the database',
        507,
      );
    }

    const job = {
      id: randomUUID(),
      phase: 'stopping',
      trigger: 'manual',
      startedAt: now(),
      finishedAt: null,
      error: null,
      result: null,
      beforeBytes: null,
    };
    const releaseLock = await acquireLock();
    let lockReleased = false;
    const releaseOnce = async () => {
      if (lockReleased) return;
      lockReleased = true;
      await releaseLock().catch(() => {});
    };

    activeJob = job;
    lastJob = job;

    // The HTTP response returns before the rewrite finishes; the UI polls the
    // overview route for the phase and the result.
    void (async () => {
      const lifecycleJob = async () => {
        setPhase('stopping');
        return runCompaction({
          trigger: 'manual',
          onStep: (step) => setPhase(step),
          lock: releaseOnce,
        });
      };
      try {
        job.result = await lifecycle.runWithManagedOpenCodeStopped(lifecycleJob, {
          reason: 'database-compaction',
          onRestarting: () => setPhase('restarting'),
        });
        job.beforeBytes = job.result.beforeBytes;
        job.finishedAt = now();
        job.phase = 'done';
      } catch (error) {
        job.error = error?.message ?? 'Compaction failed';
        job.finishedAt = now();
        job.phase = 'failed';
        logger.warn('[database] Compaction failed:', job.error);
      } finally {
        activeJob = null;
        // The job may have failed before `runCompaction` took the lock over.
        await releaseOnce();
      }
    })();

    return snapshotJob();
  };

  /**
   * Runs before the managed child is spawned, where the database is naturally
   * closed. Only a queued "next restart" request causes a rewrite; a plain
   * startup never compacts on its own. Never throws: startup must not depend
   * on maintenance succeeding.
   */
  const runQueuedDatabaseCompactionAtStartup = async () => {
    if (!fileSystem.existsSync(nextStartFlagPath) || activeJob) return null;

    const stats = await readStats();
    if (!stats.exists) return null;

    const lifecycle = getLifecycle();
    if (lifecycle?.isExternalServer?.() || isInMemoryOpenCodeDb()) return null;
    if (stats.freelistCount === 0) {
      // A queued request with nothing to reclaim is spent: keeping it would
      // report "scheduled" forever.
      await fs.promises.rm(nextStartFlagPath, { force: true }).catch(() => {});
      return null;
    }

    const job = {
      id: randomUUID(),
      phase: 'checkpoint',
      trigger: 'next-restart',
      startedAt: now(),
      finishedAt: null,
      error: null,
      result: null,
      beforeBytes: null,
    };
    activeJob = job;
    lastJob = job;
    try {
      const result = await runCompaction({
        trigger: 'next-restart',
        onStep: (step) => setPhase(step),
      });
      job.result = result;
      job.beforeBytes = result.beforeBytes;
      job.phase = 'done';
      await fs.promises.rm(nextStartFlagPath, { force: true }).catch(() => {});
      return result;
    } catch (error) {
      job.error = error?.message ?? 'Compaction failed';
      job.phase = 'failed';
      logger.warn('[database] Queued database compaction failed:', job.error);
      return null;
    } finally {
      job.finishedAt = now();
      activeJob = null;
    }
  };

  /** Queues a compaction for the next time the managed child starts. */
  const scheduleForNextRestart = async () => {
    await fs.promises.mkdir(maintenanceDir, { recursive: true });
    await fs.promises.writeFile(nextStartFlagPath, JSON.stringify({ requestedAt: now() }));
  };

  return {
    getOverview,
    compactNow,
    runQueuedDatabaseCompactionAtStartup,
    scheduleForNextRestart,
  };
};
