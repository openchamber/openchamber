import { readFileSync } from 'fs';
import { availableParallelism } from 'os';
import path from 'path';

const MAX_ENGINE_THREADS = 8;
const UNKNOWN_QUOTA_THREADS = 2;
const CGROUP_ROOT = '/sys/fs/cgroup';
const CGROUP_V1_CPU_ROOTS = ['/sys/fs/cgroup/cpu', '/sys/fs/cgroup/cpu,cpuacct', '/sys/fs/cgroup/cpuacct,cpu'];

function readOptional(readText, file) {
  try {
    return readText(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

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
  // external: https://docs.kernel.org/admin-guide/cgroup-v2.html#cpu The root cgroup has no cpu.max; verify the hierarchy mount before treating it as unlimited.
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

// external: https://docs.kernel.org/scheduler/sched-bwc.html A v1 CPU hierarchy has quota files at its root; their absence means this is not the mount.
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

function readCgroupCpuLimit(readText) {
  try {
    const entries = readText('/proc/self/cgroup')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [, controllers = '', ...rest] = line.split(':');
        return { controllers: controllers.split(','), cgroupPath: rest.join(':') || '/' };
      });
    // external: https://docs.kernel.org/admin-guide/cgroup-v2.html#mounting A controller belongs to one hierarchy; hybrid hosts can expose CPU through v1.
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
