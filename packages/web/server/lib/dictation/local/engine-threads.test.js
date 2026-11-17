import { describe, expect, it } from 'vitest';

import { resolveEngineThreads } from './engine-threads.js';

function filesystem(files) {
  return (file) => {
    if (Object.hasOwn(files, file)) return files[file];
    const error = new Error(`ENOENT: ${file}`);
    error.code = 'ENOENT';
    throw error;
  };
}

const linux = (parallelism, files) => resolveEngineThreads({ platform: 'linux', parallelism, readText: filesystem(files) });

describe('resolveEngineThreads', () => {
  it('uses the cores of an unrestricted host, capped at 8', () => {
    expect(linux(32, { '/proc/self/cgroup': '0::/user.slice/session.scope\n', '/sys/fs/cgroup/cgroup.controllers': 'cpu\n', '/sys/fs/cgroup/user.slice/cpu.max': 'max 100000\n' })).toBe(8);
    expect(linux(4, { '/proc/self/cgroup': '0::/\n', '/sys/fs/cgroup/cgroup.controllers': 'cpu\n' })).toBe(4);
    expect(resolveEngineThreads({ platform: 'darwin', parallelism: 12 })).toBe(8);
    expect(resolveEngineThreads({ platform: 'win32', parallelism: 1 })).toBe(1);
  });

  it('holds a many-core container to its 2-CPU quota (cgroup v2)', () => {
    expect(linux(32, { '/proc/self/cgroup': '0::/\n', '/sys/fs/cgroup/cgroup.controllers': 'cpu\n', '/sys/fs/cgroup/cpu.max': '200000 100000\n' })).toBe(2);
  });

  it('takes the tightest quota on the way to the root, past levels it cannot see', () => {
    expect(linux(32, {
      '/proc/self/cgroup': '0::/system.slice/docker-abc.scope\n',
      '/sys/fs/cgroup/cgroup.controllers': 'cpu\n',
      '/sys/fs/cgroup/system.slice/docker-abc.scope/cpu.max': 'max 100000\n',
      '/sys/fs/cgroup/system.slice/cpu.max': '300000 100000\n',
    })).toBe(3);
    // Without a cgroup namespace the listed path is absent inside the container.
    expect(linux(32, { '/proc/self/cgroup': '0::/docker/abc\n', '/sys/fs/cgroup/cgroup.controllers': 'cpu\n', '/sys/fs/cgroup/cpu.max': '150000 100000\n' })).toBe(2);
  });

  it('holds a many-core container to its 2-CPU quota (cgroup v1)', () => {
    expect(linux(32, {
      '/proc/self/cgroup': '5:cpu,cpuacct:/\n1:name=systemd:/\n0::/\n',
      '/sys/fs/cgroup/cpu/cpu.cfs_quota_us': '200000\n',
      '/sys/fs/cgroup/cpu/cpu.cfs_period_us': '100000\n',
    })).toBe(2);
    expect(linux(32, {
      '/proc/self/cgroup': '5:cpu,cpuacct:/\n',
      '/sys/fs/cgroup/cpu/cpu.cfs_quota_us': '-1\n',
      '/sys/fs/cgroup/cpu/cpu.cfs_period_us': '100000\n',
    })).toBe(8);
    // Combined controller mount without the `cpu` symlink.
    expect(linux(32, {
      '/proc/self/cgroup': '5:cpu,cpuacct:/\n',
      '/sys/fs/cgroup/cpu,cpuacct/cpu.cfs_quota_us': '200000\n',
      '/sys/fs/cgroup/cpu,cpuacct/cpu.cfs_period_us': '100000\n',
    })).toBe(2);
  });

  it('keeps the old 2 threads on Linux when the quota cannot be read', () => {
    expect(linux(32, {})).toBe(2);
    const denied = () => {
      const error = new Error('EACCES');
      error.code = 'EACCES';
      throw error;
    };
    expect(resolveEngineThreads({ platform: 'linux', parallelism: 32, readText: denied })).toBe(2);
    expect(linux(1, {})).toBe(1);
    // /proc/self/cgroup is readable but the hierarchy is not mounted.
    expect(linux(32, { '/proc/self/cgroup': '5:cpu,cpuacct:/docker/abc\n' })).toBe(2);
    expect(linux(32, { '/proc/self/cgroup': '0::/\n' })).toBe(2);
  });
});
