/**
 * ONNX Runtime thread count for the sherpa engines in the dictation worker.
 *
 * Bounded by the CPUs the process may run on (affinity), by a Linux cgroup CPU
 * quota (a container on a many-core host), and by MAX_ENGINE_THREADS. When a
 * Linux host's quota cannot be read, the count stays at the old fixed value.
 */
import { readFileSync } from 'fs';
import { availableParallelism } from 'os';
import path from 'path';

const MAX_ENGINE_THREADS = 8;
const UNKNOWN_QUOTA_THREADS = 2;
const CGROUP_ROOT = '/sys/fs/cgroup';
// Where a v1 cpu controller is mounted: its own name, or the combined mount
// some hosts and containers use without the `cpu` symlink.
const CGROUP_V1_CPU_ROOTS = ['/sys/fs/cgroup/cpu', '/sys/fs/cgroup/cpu,cpuacct', '/sys/fs/cgroup/cpuacct,cpu'];

function readOptional(readText, file) {
  try {
    return readText(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

// Walks from the process's cgroup up to the hierarchy root and returns the
// tightest limit any level sets. A level without a limit file (readLevel gives
// undefined) is skipped: the cgroup path may not be visible inside a container,
// whose own limit then sits at the root of the mount. Null when no level had one.
function tightestLimit(root, cgroupPath, readLevel) {
  let limit = null;
  let dir = path.posix.resolve(root, `.${cgroupPath}`);
  for (;;) {
    const level = readLevel(dir);
    if (level !== undefined) limit = Math.min(limit ?? Infinity, level);
    if (dir === root || !dir.startsWith(`${root}/`)) return limit;
    dir = path.posix.dirname(dir);
  }
}

function cpusFromQuota(quota, period) {
  if (!Number.isFinite(quota) || !Number.isFinite(period) || quota <= 0 || period <= 0) return Infinity;
  return Math.max(1, Math.ceil(quota / period));
}

function readV2Limit(readText, cgroupPath) {
  // The root cgroup has no cpu.max, so only a mounted hierarchy may read as unlimited.
  if (readOptional(readText, `${CGROUP_ROOT}/cgroup.controllers`) === undefined) return null;
  const limit = tightestLimit(CGROUP_ROOT, cgroupPath, (dir) => {
    const max = readOptional(readText, `${dir}/cpu.max`);
    if (max === undefined) return undefined;
    const [quota, period] = max.trim().split(/\s+/);
    if (quota === 'max') return Infinity;
    return cpusFromQuota(Number(quota), Number(period));
  });
  return limit ?? Infinity;
}

// Every v1 cpu hierarchy has the quota files at its root, so a root where no
// level has them is not the mount.
function readV1Limit(readText, cgroupPath) {
  for (const root of CGROUP_V1_CPU_ROOTS) {
    const limit = tightestLimit(root, cgroupPath, (dir) => {
      const quota = readOptional(readText, `${dir}/cpu.cfs_quota_us`);
      const period = readOptional(readText, `${dir}/cpu.cfs_period_us`);
      if (quota === undefined || period === undefined) return undefined;
      return cpusFromQuota(Number(quota.trim()), Number(period.trim()));
    });
    if (limit !== null) return limit;
  }
  return null;
}

/**
 * CPUs the cgroup quota allows: a number, Infinity when no quota applies, or
 * null when it cannot be determined.
 */
function readCgroupCpuLimit(readText) {
  try {
    const entries = readText('/proc/self/cgroup')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [, controllers = '', ...rest] = line.split(':');
        return { controllers: controllers.split(','), cgroupPath: rest.join(':') || '/' };
      });
    // A hybrid host lists both; the cpu controller then lives in v1.
    const v1 = entries.find((entry) => entry.controllers.includes('cpu'));
    if (v1) return readV1Limit(readText, v1.cgroupPath);
    const v2 = entries.find((entry) => entry.controllers.length === 1 && entry.controllers[0] === '');
    if (v2) return readV2Limit(readText, v2.cgroupPath);
    return null;
  } catch {
    return null;
  }
}

export function resolveEngineThreads({
  platform = process.platform,
  parallelism = availableParallelism(),
  readText = (file) => readFileSync(file, 'utf8'),
} = {}) {
  const affinity = Math.min(MAX_ENGINE_THREADS, parallelism);
  if (platform !== 'linux') return Math.max(1, affinity);
  const quota = readCgroupCpuLimit(readText);
  const limit = quota === null ? UNKNOWN_QUOTA_THREADS : quota;
  return Math.max(1, Math.min(affinity, limit));
}
