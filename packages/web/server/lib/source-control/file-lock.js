import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * A lock nobody holds is reclaimed rather than waited on forever.
 *
 * The lock file names the process that took it. A waiter that finds the file
 * asks whether that process still exists on this machine; a crashed or killed
 * owner leaves a file that nobody will ever remove, and every store read would
 * otherwise fail with "busy" until someone deleted it by hand. A lock from
 * another machine, or one written before locks carried an owner, is reclaimed
 * only once it is old enough that no live writer could still be inside it.
 */
const STALE_LOCK_MS = 5 * 60_000;

const lockError = (lockPath, busy, cause) => Object.assign(new Error(
  `Source control lock ${path.basename(lockPath)} ${busy ? 'is busy' : 'failed'}. Retry in a moment.`,
  { cause },
), { code: busy ? 'SOURCE_CONTROL_LOCK_BUSY' : 'SOURCE_CONTROL_LOCK_FAILED', status: busy ? 503 : 500 });

const validateWait = (waitMs) => {
  if (!Number.isSafeInteger(waitMs) || waitMs < 0) throw new TypeError('Invalid source control lock wait');
};

const ownerRecord = () => `${JSON.stringify({ pid: process.pid, host: os.hostname(), at: Date.now(), nonce: randomUUID() })}\n`;

const processAlive = (pid) => {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
};

/** Whether a lock file's content and age say its owner is gone. */
const isAbandoned = (content, mtimeMs, now = Date.now()) => {
  let owner = null;
  try { owner = JSON.parse(String(content)); } catch { owner = null; }
  if (owner && Number.isSafeInteger(owner.pid) && owner.pid > 0 && owner.host === os.hostname()) {
    return !processAlive(owner.pid);
  }
  return now - mtimeMs > STALE_LOCK_MS;
};

const releaseError = (lockPath, error) => lockError(lockPath, false, error);

const sleepSync = (milliseconds) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
};

// Like an index lock: only exclusive creation grants ownership. Age and PID
// decide only when an existing file may be removed to try again.

/**
 * Removes an abandoned lock under a short guard, and only while it is still
 * the abandoned one.
 *
 * Without the guard two waiters can judge the same dead owner's lock: the
 * faster one removes it and takes a fresh lock, then the slower one removes
 * that fresh lock on the strength of what it read before, and both enter.
 * Moving the file aside first does not help either, because the name is free
 * while it is away and a third waiter can take it. So every removal of
 * someone else's lock happens under `<lock>.guard`, and the lock is inspected
 * again inside it, content and identity through one open handle. Inside the
 * guard nobody else can remove the lock (a dead owner never releases), so the
 * file that was judged is the file that is unlinked. Taking a free lock does
 * not need the guard: exclusive creation cannot replace anything.
 *
 * Live holders keep the guard for a few file operations. A guard older than
 * GUARD_STALE_MS was left by a waiter that died inside it and is removed.
 */
const GUARD_STALE_MS = 10_000;
const guardPath = (lockPath) => `${lockPath}.guard`;
const sameFile = (left, right) => left.dev === right.dev && left.ino === right.ino;

async function withReclaimGuard(fsImpl, lockPath, deadline, operation) {
  const guard = guardPath(lockPath);
  let handle;
  while (!handle) {
    try {
      handle = await fsImpl.open(guard, 'wx', 0o600);
    } catch (error) {
      if (error?.code !== 'EEXIST') return false;
      try {
        const stats = await fsImpl.lstat(guard);
        if (Date.now() - stats.mtimeMs > GUARD_STALE_MS) {
          await fsImpl.unlink(guard).catch(() => {});
          continue;
        }
      } catch {
        continue;
      }
      if (performance.now() >= deadline) return false;
      await delay(2);
    }
  }
  try {
    return await operation();
  } finally {
    await handle.close().catch(() => {});
    await fsImpl.unlink(guard).catch(() => {});
  }
}

function withReclaimGuardSync(fsImpl, lockPath, deadline, operation) {
  const guard = guardPath(lockPath);
  let handle;
  while (handle === undefined) {
    try {
      handle = fsImpl.openSync(guard, 'wx', 0o600);
    } catch (error) {
      if (error?.code !== 'EEXIST') return false;
      try {
        const stats = fsImpl.lstatSync(guard);
        if (Date.now() - stats.mtimeMs > GUARD_STALE_MS) {
          try { fsImpl.unlinkSync(guard); } catch {}
          continue;
        }
      } catch {
        continue;
      }
      if (performance.now() >= deadline) return false;
      sleepSync(2);
    }
  }
  try {
    return operation();
  } finally {
    try { fsImpl.closeSync(handle); } catch {}
    try { fsImpl.unlinkSync(guard); } catch {}
  }
}

async function reclaimAbandoned(fsImpl, lockPath) {
  let handle;
  try { handle = await fsImpl.open(lockPath, 'r'); } catch { return false; }
  try {
    const stats = await handle.stat({ bigint: true });
    if (!stats.isFile()) return false;
    const content = await handle.readFile('utf8');
    if (!isAbandoned(content, Number(stats.mtimeMs))) return false;
    const current = await fsImpl.lstat(lockPath, { bigint: true });
    if (!sameFile(current, stats)) return false;
    await fsImpl.unlink(lockPath);
    return true;
  } catch {
    // Unreadable or already gone: leave it to the next attempt.
    return false;
  } finally {
    await handle.close().catch(() => {});
  }
}

function reclaimAbandonedSync(fsImpl, lockPath) {
  let handle;
  try { handle = fsImpl.openSync(lockPath, 'r'); } catch { return false; }
  try {
    const stats = fsImpl.fstatSync(handle, { bigint: true });
    if (!stats.isFile()) return false;
    const content = fsImpl.readFileSync(handle, 'utf8');
    if (!isAbandoned(content, Number(stats.mtimeMs))) return false;
    const current = fsImpl.lstatSync(lockPath, { bigint: true });
    if (!sameFile(current, stats)) return false;
    fsImpl.unlinkSync(lockPath);
    return true;
  } catch {
    // Unreadable or already gone: leave it to the next attempt.
    return false;
  } finally {
    try { fsImpl.closeSync(handle); } catch {}
  }
}

export async function withSourceControlFileLock(lockPath, operation, { fsImpl = fs, waitMs = 2_000 } = {}) {
  validateWait(waitMs);
  const deadline = performance.now() + waitMs;
  let handle;
  let reclaimed = false;
  try {
    await fsImpl.mkdir(path.dirname(lockPath), { recursive: true });
    while (!handle) {
      try {
        handle = await fsImpl.open(lockPath, 'wx', 0o600);
      } catch (error) {
        if (error?.code !== 'EEXIST') throw lockError(lockPath, false, error);
        if (!reclaimed) {
          reclaimed = await withReclaimGuard(fsImpl, lockPath, deadline, () => reclaimAbandoned(fsImpl, lockPath));
          if (reclaimed) continue;
        }
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw lockError(lockPath, true, error);
        await delay(Math.min(20, remaining));
      }
    }
  } catch (error) {
    if (error?.code?.startsWith('SOURCE_CONTROL_LOCK_')) throw error;
    throw lockError(lockPath, false, error);
  }

  try {
    try {
      await handle.writeFile(ownerRecord(), 'utf8');
    } catch (error) {
      throw lockError(lockPath, false, error);
    }
    return await operation();
  } finally {
    try {
      // Keep the handle open through unlink so its inode cannot be reused.
      const owned = await handle.stat({ bigint: true });
      const current = await fsImpl.lstat(lockPath, { bigint: true });
      if (owned.dev !== current.dev || owned.ino !== current.ino) throw releaseError(lockPath);
      await fsImpl.unlink(lockPath);
    } catch (error) {
      throw releaseError(lockPath, error);
    } finally {
      try { await handle.close(); }
      catch (error) { throw releaseError(lockPath, error); }
    }
  }
}


// Synchronous storage callers retain the same ownership contract.
export function withSourceControlFileLockSync(lockPath, operation, { fsImpl = fsSync, waitMs = 2_000 } = {}) {
  validateWait(waitMs);
  const deadline = performance.now() + waitMs;
  let handle;
  let reclaimed = false;
  try {
    fsImpl.mkdirSync(path.dirname(lockPath), { recursive: true });
    while (handle === undefined) {
      try {
        handle = fsImpl.openSync(lockPath, 'wx', 0o600);
      } catch (error) {
        if (error?.code !== 'EEXIST') throw lockError(lockPath, false, error);
        if (!reclaimed) {
          reclaimed = withReclaimGuardSync(fsImpl, lockPath, deadline, () => reclaimAbandonedSync(fsImpl, lockPath));
          if (reclaimed) continue;
        }
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw lockError(lockPath, true, error);
        sleepSync(Math.min(20, remaining));
      }
    }
  } catch (error) {
    if (error?.code?.startsWith('SOURCE_CONTROL_LOCK_')) throw error;
    throw lockError(lockPath, false, error);
  }

  try {
    try {
      fsImpl.writeFileSync(handle, ownerRecord(), 'utf8');
    } catch (error) {
      throw lockError(lockPath, false, error);
    }
    return operation();
  } finally {
    try {
      const owned = fsImpl.fstatSync(handle, { bigint: true });
      const current = fsImpl.lstatSync(lockPath, { bigint: true });
      if (owned.dev !== current.dev || owned.ino !== current.ino) throw releaseError(lockPath);
      fsImpl.unlinkSync(lockPath);
    } catch (error) {
      throw releaseError(lockPath, error);
    } finally {
      try { fsImpl.closeSync(handle); }
      catch (error) { throw releaseError(lockPath, error); }
    }
  }
}
