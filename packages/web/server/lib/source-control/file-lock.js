import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

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
