import { describe, expect, it } from 'bun:test';

import { createRelayHostLock } from './host-lock.js';

// In-memory fs standing in for the shared data dir.
const makeFakeFs = () => {
  const files = new Map();
  return {
    readFileSync: (p) => {
      if (!files.has(p)) {
        const error = new Error('ENOENT');
        error.code = 'ENOENT';
        throw error;
      }
      return files.get(p);
    },
    writeFileSync: (p, data) => {
      files.set(p, data);
    },
    unlinkSync: (p) => {
      files.delete(p);
    },
    peek: (p) => files.get(p),
  };
};

// Fake process: `alive` is the set of pids that respond to kill(pid, 0).
const makeFakeProcess = (pid, alive = new Set([pid])) => ({
  pid,
  kill: (target) => {
    if (!alive.has(target)) {
      const error = new Error('ESRCH');
      error.code = 'ESRCH';
      throw error;
    }
    return true;
  },
});

const LOCK = '/data/relay-host.lock';
const silentLogger = { warn: () => {} };

const makeLock = (fs, proc, extra = {}) =>
  createRelayHostLock({ lockFilePath: LOCK, fs, process: proc, hostname: 'mac', logger: silentLogger, ...extra });

describe('relay host lock', () => {
  it('claims a free lock and keeps it on the next check', () => {
    const fs = makeFakeFs();
    const lock = makeLock(fs, makeFakeProcess(100));

    expect(lock.tryClaim()).toBe(true);
    expect(lock.otherLiveClaimant()).toBe(null);
    expect(lock.tryClaim()).toBe(true);
    expect(JSON.parse(fs.peek(LOCK)).pid).toBe(100);
  });

  it('refuses to claim while another LIVE process holds it', () => {
    const fs = makeFakeFs();
    const alive = new Set([100, 200]);
    const first = makeLock(fs, makeFakeProcess(100, alive));
    const second = makeLock(fs, makeFakeProcess(200, alive));

    expect(first.tryClaim()).toBe(true);
    expect(second.tryClaim()).toBe(false);
    expect(second.otherLiveClaimant()).toEqual({ pid: 100, host: 'mac' });
  });

  it('treats a dead claimant as free (stale claim takeover)', () => {
    const fs = makeFakeFs();
    const alive = new Set([200]); // pid 100 is gone
    fs.writeFileSync(LOCK, JSON.stringify({ pid: 100 }));
    const lock = makeLock(fs, makeFakeProcess(200, alive));

    expect(lock.otherLiveClaimant()).toBe(null);
    expect(lock.tryClaim()).toBe(true);
  });

  it('forceClaim overrides a live holder; the loser sees the takeover', () => {
    const fs = makeFakeFs();
    const alive = new Set([100, 200]);
    const first = makeLock(fs, makeFakeProcess(100, alive));
    const second = makeLock(fs, makeFakeProcess(200, alive));

    expect(first.tryClaim()).toBe(true);
    expect(second.forceClaim()).toBe(true);
    expect(second.tryClaim()).toBe(true);
    expect(first.tryClaim()).toBe(false);
    expect(first.otherLiveClaimant()).toEqual({ pid: 200, host: 'mac' });
  });

  it('release removes only its own claim', () => {
    const fs = makeFakeFs();
    const alive = new Set([100, 200]);
    const first = makeLock(fs, makeFakeProcess(100, alive));
    const second = makeLock(fs, makeFakeProcess(200, alive));

    expect(first.tryClaim()).toBe(true);
    second.release(); // not the holder — must be a no-op
    expect(second.otherLiveClaimant()).toEqual({ pid: 100, host: 'mac' });

    first.release();
    expect(fs.peek(LOCK)).toBeUndefined();
  });

  it('treats an unparsable claim file as free', () => {
    const fs = makeFakeFs();
    fs.writeFileSync(LOCK, 'not-json');
    const lock = makeLock(fs, makeFakeProcess(100));

    expect(lock.otherLiveClaimant()).toBe(null);
    expect(lock.tryClaim()).toBe(true);
  });

  it('an EPERM kill probe still counts as a live holder', () => {
    const fs = makeFakeFs();
    fs.writeFileSync(LOCK, JSON.stringify({ pid: 100, instance: 'other', host: 'mac', refreshedAt: Date.now() }));
    const proc = {
      pid: 200,
      kill: () => {
        const error = new Error('EPERM');
        error.code = 'EPERM';
        throw error;
      },
    };
    const lock = makeLock(fs, proc);

    expect(lock.otherLiveClaimant()).toEqual({ pid: 100, host: 'mac' });
    expect(lock.tryClaim()).toBe(false);
  });

  it('keeps a refreshing holder on this host live', () => {
    const fs = makeFakeFs();
    let clock = 0;
    const now = () => clock;
    const alive = new Set([100, 200]);
    const holder = makeLock(fs, makeFakeProcess(100, alive), { now });
    const standby = makeLock(fs, makeFakeProcess(200, alive), { now });

    expect(holder.tryClaim()).toBe(true);
    for (clock = 30_000; clock <= 600_000; clock += 30_000) {
      expect(holder.tryClaim()).toBe(true);
      expect(standby.tryClaim()).toBe(false);
    }
  });

  it('frees a claim whose pid now belongs to an unrelated process', () => {
    const fs = makeFakeFs();
    let clock = 0;
    const now = () => clock;
    // Pid 100 was the host; it died without releasing and the OS gave 100 to another program.
    const alive = new Set([100, 200]);
    fs.writeFileSync(LOCK, JSON.stringify({ pid: 100, instance: 'gone', host: 'mac', refreshedAt: 0 }));
    const lock = makeLock(fs, makeFakeProcess(200, alive), { now });

    clock = 60_000;
    expect(lock.tryClaim()).toBe(false);
    clock = 90_000;
    expect(lock.otherLiveClaimant()).toBe(null);
    expect(lock.tryClaim()).toBe(true);
    expect(JSON.parse(fs.peek(LOCK)).pid).toBe(200);
  });

  it('treats a claim from an older build as free even when its pid answers', () => {
    const fs = makeFakeFs();
    fs.writeFileSync(LOCK, JSON.stringify({ pid: 100, claimedAt: '2026-10-01T00:00:00Z' }));
    const lock = makeLock(fs, makeFakeProcess(200, new Set([100, 200])));

    expect(lock.otherLiveClaimant()).toBe(null);
    expect(lock.tryClaim()).toBe(true);
  });

  it('keeps two containers that both run as pid 1 apart', () => {
    const fs = makeFakeFs();
    const first = makeLock(fs, makeFakeProcess(1), { hostname: 'container-a' });
    const second = makeLock(fs, makeFakeProcess(1), { hostname: 'container-b' });

    expect(first.tryClaim()).toBe(true);
    expect(second.tryClaim()).toBe(false);
    expect(second.otherLiveClaimant()).toEqual({ pid: 1, host: 'container-a' });
  });

  it('keeps a claim from another host live only while it is refreshed', () => {
    const fs = makeFakeFs();
    let clock = 0;
    const now = () => clock;
    const remote = makeLock(fs, makeFakeProcess(100), { hostname: 'laptop', now });
    const local = makeLock(fs, makeFakeProcess(200), { now });

    expect(remote.tryClaim()).toBe(true);
    clock = 60_000;
    expect(local.tryClaim()).toBe(false);
    expect(remote.tryClaim()).toBe(true);
    clock = 140_000;
    expect(local.tryClaim()).toBe(false);
    clock = 240_000;
    expect(local.tryClaim()).toBe(true);
    expect(remote.tryClaim()).toBe(false);
  });

  it('reclaims its own pid from an older build after a container restart', () => {
    const fs = makeFakeFs();
    fs.writeFileSync(LOCK, JSON.stringify({ pid: 1, claimedAt: '2026-10-01T00:00:00Z' }));
    const lock = makeLock(fs, makeFakeProcess(1));

    expect(lock.tryClaim()).toBe(true);
  });
});
