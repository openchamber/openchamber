import { setTimeout as delay } from 'node:timers/promises';
import type fs from 'node:fs/promises';
import type path from 'node:path';
import type { Stats } from 'node:fs';

type ProbeFs = Pick<typeof fs, 'stat' | 'mkdtemp' | 'rmdir'>;

const PROBE_ATTEMPTS = 4;
const PROBE_RETRY_MS = 10;

async function touchDirectory(fsImpl: ProbeFs, pathImpl: Pick<typeof path, 'join'>, directory: string) {
  let probe;
  try {
    probe = await fsImpl.mkdtemp(pathImpl.join(directory, '.openchamber-birthtime-'));
    await fsImpl.rmdir(probe);
    probe = undefined;
    return await fsImpl.stat(directory);
  } finally {
    if (probe) await fsImpl.rmdir(probe).catch(() => {});
  }
}

export async function birthtimeHoldsStill(
  fsImpl: ProbeFs,
  pathImpl: Pick<typeof path, 'join'>,
  directory: string,
  snapshot?: Stats,
) {
  try {
    const before = snapshot ?? await fsImpl.stat(directory);
    if (!Number.isFinite(before.birthtimeMs) || before.birthtimeMs <= 0) return false;
    if (!Number.isFinite(before.ctimeMs)) return false;
    for (let attempt = 1; attempt <= PROBE_ATTEMPTS; attempt += 1) {
      if (attempt > 1) await delay(PROBE_RETRY_MS);
      const after = await touchDirectory(fsImpl, pathImpl, directory);
      if (after.dev !== before.dev || after.ino !== before.ino || after.birthtimeMs !== before.birthtimeMs) return false;
      if (!Number.isFinite(after.ctimeMs)) return false;
      if (after.ctimeMs !== before.ctimeMs) return true;
    }
    return false;
  } catch {
    return false;
  }
}
