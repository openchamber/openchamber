import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { hasSourceControlErrorCode, hasSourceControlStringCode, isSourceControlInteger } from './input-guards.js';
import type { BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';

export interface SourceControlFileLockOptions {
  fsImpl?: typeof fs;
  waitMs?: number;
}

export interface SourceControlFileLockSyncOptions {
  fsImpl?: typeof fsSync;
  waitMs?: number;
}

const STALE_LOCK_MS = 5 * 60_000;

const lockError = (lockPath: string, busy: boolean, cause?: ErrorOptions['cause']) => Object.assign(new Error(
  `Source control lock ${path.basename(lockPath)} ${busy ? 'is busy' : 'failed'}. Retry in a moment.`,
  { cause },
), { code: busy ? 'SOURCE_CONTROL_LOCK_BUSY' : 'SOURCE_CONTROL_LOCK_FAILED', status: busy ? 503 : 500 });

const validateWait = (waitMs: number) => {
  if (!Number.isSafeInteger(waitMs) || waitMs < 0) throw new TypeError('Invalid source control lock wait');
};

const ownerRecord = () => `${JSON.stringify({ pid: process.pid, host: os.hostname(), at: Date.now(), nonce: randomUUID() })}\n`;

const processAlive = (pid: number) => {
  try { process.kill(pid, 0); return true; }
  catch (error) { return hasSourceControlErrorCode(error) && error.code === 'EPERM'; }
};

const isLocalLockOwner = (value: unknown): value is { pid: number; host: string } =>
  value !== null && typeof value === 'object' && 'pid' in value && 'host' in value
  && isSourceControlInteger(value.pid) && value.pid > 0 && value.host === os.hostname();

const isAbandoned = (content: string, mtimeMs: number, now = Date.now()) => {
  let owner: unknown;
  try {
    owner = JSON.parse(String(content));
  } catch {
    return now - mtimeMs > STALE_LOCK_MS;
  }
  if (isLocalLockOwner(owner)) return !processAlive(owner.pid);
  return now - mtimeMs > STALE_LOCK_MS;
};

const releaseError = (lockPath: string, error?: ErrorOptions['cause']) => lockError(lockPath, false, error);

const sleepSync = (milliseconds: number) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
};

const ignoreFailureSync = (operation: () => void) => {
  try { operation(); } catch { return; }
};

const closeLock = async (lockPath: string, handle: FileHandle) => {
  try { await handle.close(); }
  catch (error) { throw releaseError(lockPath, error); }
};

const closeLockSync = (fsImpl: typeof fsSync, lockPath: string, handle: number) => {
  try { fsImpl.closeSync(handle); }
  catch (error) { throw releaseError(lockPath, error); }
};

const releaseLock = async (fsImpl: typeof fs, lockPath: string, handle: FileHandle) => {
  try {
    const owned = await handle.stat({ bigint: true });
    const current = await fsImpl.lstat(lockPath, { bigint: true });
    if (owned.dev !== current.dev || owned.ino !== current.ino) throw releaseError(lockPath);
    await fsImpl.unlink(lockPath);
  } catch (error) {
    throw releaseError(lockPath, error);
  } finally {
    await closeLock(lockPath, handle);
  }
};

const releaseLockSync = (fsImpl: typeof fsSync, lockPath: string, handle: number) => {
  try {
    const owned = fsImpl.fstatSync(handle, { bigint: true });
    const current = fsImpl.lstatSync(lockPath, { bigint: true });
    if (owned.dev !== current.dev || owned.ino !== current.ino) throw releaseError(lockPath);
    fsImpl.unlinkSync(lockPath);
  } catch (error) {
    throw releaseError(lockPath, error);
  } finally {
    closeLockSync(fsImpl, lockPath, handle);
  }
};


const GUARD_STALE_MS = 10_000;
const guardPath = (lockPath: string) => `${lockPath}.guard`;
const sameFile = (left: Pick<BigIntStats, 'dev' | 'ino'>, right: Pick<BigIntStats, 'dev' | 'ino'>) => left.dev === right.dev && left.ino === right.ino;

async function withReclaimGuard(fsImpl: typeof fs, lockPath: string, deadline: number, operation: () => Promise<boolean>) {
  const guard = guardPath(lockPath);
  let handle;
  while (!handle) {
    try {
      handle = await fsImpl.open(guard, 'wx', 0o600);
    } catch (error) {
      if (!hasSourceControlErrorCode(error) || error.code !== 'EEXIST') return false;
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

function withReclaimGuardSync(fsImpl: typeof fsSync, lockPath: string, deadline: number, operation: () => boolean) {
  const guard = guardPath(lockPath);
  let handle: number | undefined;
  while (handle === undefined) {
    try {
      handle = fsImpl.openSync(guard, 'wx', 0o600);
    } catch (error) {
      if (!hasSourceControlErrorCode(error) || error.code !== 'EEXIST') return false;
      try {
        const stats = fsImpl.lstatSync(guard);
        if (Date.now() - stats.mtimeMs > GUARD_STALE_MS) {
          ignoreFailureSync(() => fsImpl.unlinkSync(guard));
          continue;
        }
      } catch {
        continue;
      }
      if (performance.now() >= deadline) return false;
      sleepSync(2);
    }
  }
  const acquired = handle;
  try {
    return operation();
  } finally {
    ignoreFailureSync(() => fsImpl.closeSync(acquired));
    ignoreFailureSync(() => fsImpl.unlinkSync(guard));
  }
}

async function reclaimAbandoned(fsImpl: typeof fs, lockPath: string) {
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

function reclaimAbandonedSync(fsImpl: typeof fsSync, lockPath: string) {
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
    ignoreFailureSync(() => fsImpl.closeSync(handle));
  }
}

export async function withSourceControlFileLock<Result>(lockPath: string, operation: () => Result | Promise<Result>, { fsImpl = fs, waitMs = 2_000 }: SourceControlFileLockOptions = {}) {
  validateWait(waitMs);
  const deadline = performance.now() + waitMs;
  let handle: FileHandle | undefined;
  let reclaimed = false;
  try {
    await fsImpl.mkdir(path.dirname(lockPath), { recursive: true });
    while (!handle) {
      try {
        handle = await fsImpl.open(lockPath, 'wx', 0o600);
      } catch (error) {
        if (!hasSourceControlErrorCode(error) || error.code !== 'EEXIST') throw lockError(lockPath, false, error);
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
    if (hasSourceControlStringCode(error) && error.code.startsWith('SOURCE_CONTROL_LOCK_')) throw error;
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
    await releaseLock(fsImpl, lockPath, handle);
  }
}


export function withSourceControlFileLockSync<Result>(lockPath: string, operation: () => Result, { fsImpl = fsSync, waitMs = 2_000 }: SourceControlFileLockSyncOptions = {}) {
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
        if (!hasSourceControlErrorCode(error) || error.code !== 'EEXIST') throw lockError(lockPath, false, error);
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
    if (hasSourceControlStringCode(error) && error.code.startsWith('SOURCE_CONTROL_LOCK_')) throw error;
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
    releaseLockSync(fsImpl, lockPath, handle);
  }
}
