import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

const lockError = (lockPath, busy, cause) => Object.assign(new Error(
  `Source control lock ${path.basename(lockPath)} ${busy ? 'is busy' : 'failed'}. `
  + 'Retry later. Locks are never automatically removed. For stale-lock recovery, stop all writers sharing the data root before operator cleanup of this lock file.',
  { cause },
), { code: busy ? 'SOURCE_CONTROL_LOCK_BUSY' : 'SOURCE_CONTROL_LOCK_FAILED', status: busy ? 503 : 500 });

const validateWait = (waitMs) => {
  if (!Number.isSafeInteger(waitMs) || waitMs < 0) throw new TypeError('Invalid source control lock wait');
};

// Like an index lock: only exclusive creation grants ownership. Age and PID never do.
export async function withSourceControlFileLock(lockPath, operation, { fsImpl = fs, waitMs = 2_000 } = {}) {
  validateWait(waitMs);
  const deadline = performance.now() + waitMs;
  let handle;
  try {
    await fsImpl.mkdir(path.dirname(lockPath), { recursive: true });
    while (!handle) {
      try {
        handle = await fsImpl.open(lockPath, 'wx', 0o600);
      } catch (error) {
        if (error?.code !== 'EEXIST') throw lockError(lockPath, false, error);
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
      await handle.writeFile(`${randomUUID()}\n`, 'utf8');
    } catch (error) {
      throw lockError(lockPath, false, error);
    }
    return await operation();
  } finally {
    try {
      // Keep the handle open through unlink so its inode cannot be reused.
      // Operator removal while writers are active is outside this contract.
      const owned = await handle.stat({ bigint: true });
      const current = await fsImpl.lstat(lockPath, { bigint: true });
      if (owned.dev !== current.dev || owned.ino !== current.ino) throw lockError(lockPath, false);
      await fsImpl.unlink(lockPath);
    } catch (error) {
      throw lockError(lockPath, false, error);
    } finally {
      try { await handle.close(); }
      catch (error) { throw lockError(lockPath, false, error); }
    }
  }
}

const sleepSync = (milliseconds) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
};

// Synchronous storage callers retain the same index-lock ownership contract.
export function withSourceControlFileLockSync(lockPath, operation, { fsImpl = fsSync, waitMs = 2_000 } = {}) {
  validateWait(waitMs);
  const deadline = performance.now() + waitMs;
  let handle;
  try {
    fsImpl.mkdirSync(path.dirname(lockPath), { recursive: true });
    while (handle === undefined) {
      try {
        handle = fsImpl.openSync(lockPath, 'wx', 0o600);
      } catch (error) {
        if (error?.code !== 'EEXIST') throw lockError(lockPath, false, error);
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
      fsImpl.writeFileSync(handle, `${randomUUID()}\n`, 'utf8');
    } catch (error) {
      throw lockError(lockPath, false, error);
    }
    return operation();
  } finally {
    try {
      const owned = fsImpl.fstatSync(handle, { bigint: true });
      const current = fsImpl.lstatSync(lockPath, { bigint: true });
      if (owned.dev !== current.dev || owned.ino !== current.ino) throw lockError(lockPath, false);
      fsImpl.unlinkSync(lockPath);
    } catch (error) {
      throw lockError(lockPath, false, error);
    } finally {
      try { fsImpl.closeSync(handle); }
      catch (error) { throw lockError(lockPath, false, error); }
    }
  }
}
