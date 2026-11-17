import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  GIT_REMOTE_CACHE_MAX_ENTRIES,
  getGitRemoteCacheSizes,
  hasRemoteForTests,
  pruneExpiredGitRemoteCaches,
  readRemoteHeadsForTests,
} from './service.js';

// The two git remote caches are module-private; their eviction is
// pinned here through the exported readers and cache sizes (#979).
// Each test runs on its own mocked clock, far past the previous
// test's, and starts by pruning at a time that expires every entry an
// earlier test left behind, so the size assertions are absolute.
const CLOCK_STEP = 10_000_000;
let clockBase = 1_800_000_000_000;
let now = clockBase;

const startClock = () => {
  clockBase += CLOCK_STEP;
  now = clockBase;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  pruneExpiredGitRemoteCaches(now + 60_000);
  expect(getGitRemoteCacheSizes()).toEqual({ remoteExistence: 0, remoteHeads: 0 });
};

afterEach(() => {
  vi.restoreAllMocks();
});

const existenceGit = () => {
  const calls = new Map();
  return {
    calls,
    raw: vi.fn(async (args) => {
      const remote = args[3];
      calls.set(remote, (calls.get(remote) ?? 0) + 1);
      return 'git@github.com:acme/app.git\n';
    }),
  };
};

const headsGit = (output = 'aaa\trefs/heads/main\nbbb\trefs/heads/dev\n') => ({
  raw: vi.fn(async () => output),
});

describe('remoteExistenceCache eviction (#979)', () => {
  it('serves a fresh hit without re-asking git, and re-asks after the TTL', async () => {
    startClock();
    const git = existenceGit();

    await expect(hasRemoteForTests(git, '/repo/a', 'upstream')).resolves.toBe(true);
    await expect(hasRemoteForTests(git, '/repo/a', 'upstream')).resolves.toBe(true);
    expect(git.calls.get('upstream')).toBe(1);

    now += 31_000;
    await expect(hasRemoteForTests(git, '/repo/a', 'upstream')).resolves.toBe(true);
    expect(git.calls.get('upstream')).toBe(2);
  });

  it('sweeps an expired entry for a key that is never re-read when another key is inserted', async () => {
    startClock();
    const git = existenceGit();

    await hasRemoteForTests(git, '/repo/a', 'stale');
    now += 31_000;
    await hasRemoteForTests(git, '/repo/a', 'fresh');

    expect(getGitRemoteCacheSizes().remoteExistence).toBe(1);
    // The stale key is gone, not just stale: asking for it re-asks git.
    await hasRemoteForTests(git, '/repo/a', 'stale');
    expect(git.calls.get('stale')).toBe(2);
  });

  it('caps the cache at the bound, evicting the oldest entries first', async () => {
    startClock();
    const git = existenceGit();

    for (let index = 0; index <= GIT_REMOTE_CACHE_MAX_ENTRIES; index += 1) {
      await hasRemoteForTests(git, '/repo/a', `remote_${index}`);
    }
    expect(getGitRemoteCacheSizes().remoteExistence).toBe(GIT_REMOTE_CACHE_MAX_ENTRIES);

    await hasRemoteForTests(git, '/repo/a', `remote_${GIT_REMOTE_CACHE_MAX_ENTRIES}`);
    expect(git.calls.get(`remote_${GIT_REMOTE_CACHE_MAX_ENTRIES}`)).toBe(1);
    await hasRemoteForTests(git, '/repo/a', 'remote_0');
    expect(git.calls.get('remote_0')).toBe(2);
  });
});

describe('remoteHeadsCache eviction (#979)', () => {
  it('serves a fresh hit, shares the in-flight listing, and re-asks when local refs change', async () => {
    startClock();
    const git = headsGit();
    const remote = { name: 'origin', refs: { fetch: '+refs/heads/*:refs/remotes/origin/*' } };

    const first = readRemoteHeadsForTests(git, '/repo/a', remote, ['refs/remotes/origin/main']);
    const second = readRemoteHeadsForTests(git, '/repo/a', remote, ['refs/remotes/origin/main']);
    await expect(first).resolves.toEqual(new Set(['main', 'dev']));
    await expect(second).resolves.toEqual(new Set(['main', 'dev']));
    expect(git.raw).toHaveBeenCalledTimes(1);

    await readRemoteHeadsForTests(git, '/repo/a', remote, ['refs/remotes/origin/main', 'refs/remotes/origin/dev']);
    expect(git.raw).toHaveBeenCalledTimes(2);
  });

  it('does not cache a rejected ls-remote', async () => {
    startClock();
    const git = { raw: vi.fn(async () => { throw new Error('unreachable'); }) };
    const remote = { name: 'origin', refs: { fetch: '' } };

    await expect(readRemoteHeadsForTests(git, '/repo/a', remote, [])).rejects.toThrowError('unreachable');
    await Promise.resolve();
    expect(getGitRemoteCacheSizes().remoteHeads).toBe(0);
  });

  it('sweeps an expired entry for a key that is never re-read when another key is inserted', async () => {
    startClock();
    const git = headsGit();

    await readRemoteHeadsForTests(git, '/repo/stale', { name: 'origin', refs: { fetch: '' } }, []);
    now += 31_000;
    await readRemoteHeadsForTests(git, '/repo/fresh', { name: 'origin', refs: { fetch: '' } }, []);

    expect(getGitRemoteCacheSizes().remoteHeads).toBe(1);
    await readRemoteHeadsForTests(git, '/repo/stale', { name: 'origin', refs: { fetch: '' } }, []);
    expect(git.raw).toHaveBeenCalledTimes(3);
  });

  it('caps the cache at the bound, evicting the oldest entries first', async () => {
    startClock();
    const git = headsGit();

    for (let index = 0; index <= GIT_REMOTE_CACHE_MAX_ENTRIES; index += 1) {
      await readRemoteHeadsForTests(git, '/repo/a', { name: `remote_${index}`, refs: { fetch: '' } }, []);
    }
    expect(getGitRemoteCacheSizes().remoteHeads).toBe(GIT_REMOTE_CACHE_MAX_ENTRIES);

    const callsBefore = git.raw.mock.calls.length;
    await readRemoteHeadsForTests(git, '/repo/a', { name: `remote_${GIT_REMOTE_CACHE_MAX_ENTRIES}`, refs: { fetch: '' } }, []);
    expect(git.raw.mock.calls.length).toBe(callsBefore);
    await readRemoteHeadsForTests(git, '/repo/a', { name: 'remote_0', refs: { fetch: '' } }, []);
    expect(git.raw.mock.calls.length).toBe(callsBefore + 1);
  });
});
