import { execFileSync } from 'node:child_process';
import nodeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'bun:test';

import { createRelayHostLock, RELAY_HOST_CLAIM_MAX_BYTES } from './host-lock.js';
import { readBoundedFileSync } from '../shared/bounded-file-read.js';

// In-memory fs standing in for the shared data dir.
const makeFakeFs = () => {
  const files = new Map();
  const fifoPaths = new Set();
  return {
    constants: { O_WRONLY: 1, O_CREAT: 64, O_TRUNC: 512, O_NONBLOCK: 2048 },
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
    // Handle surface for writeClaim (#1823): fstatSync judges the path's
    // CURRENT kind, so markFifo models a FIFO swapped in after the probe.
    openSync: (p) => ({ path: p }),
    fstatSync: (fd) => ({
      isFile: () => !fifoPaths.has(fd.path),
      isFIFO: () => fifoPaths.has(fd.path),
    }),
    writeSync: (fd, data) => {
      files.set(fd.path, data);
      return Buffer.byteLength(String(data));
    },
    closeSync: () => {},
    unlinkSync: (p) => {
      files.delete(p);
    },
    peek: (p) => files.get(p),
    markFifo: (p) => {
      fifoPaths.add(p);
    },
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

// The bounded reader is the deliberate adaptation of the injected-fs seam
// (#1739, following #1736): production uses the real readBoundedFileSync,
// which judges the opened handle; the fake fs has no handles, so tests
// adapt it to the bounded reader's result shape over the in-memory map
// (contents here are always small regular files unless a test says
// otherwise, so the adapter only needs missing / too-large / ok).
const boundedReadSyncFor = (fakeFs) => (filePath, maxBytes) => {
  let raw;
  try {
    raw = fakeFs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: false, reason: 'missing', code: 'BOUNDED_FILE_MISSING', path: filePath };
    throw error;
  }
  const buffer = Buffer.from(String(raw), 'utf8');
  if (buffer.length > maxBytes) {
    return { ok: false, reason: 'too-large', code: 'BOUNDED_FILE_TOO_LARGE', path: filePath, size: buffer.length, limit: maxBytes };
  }
  return { ok: true, buffer, size: buffer.length };
};

const makeLock = (fs, proc, extra = {}) =>
  createRelayHostLock({
    lockFilePath: LOCK,
    fs,
    process: proc,
    hostname: 'mac',
    logger: silentLogger,
    boundedReadSync: boundedReadSyncFor(fs),
    ...extra,
  });

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

describe('bounded claim reads (#1739)', () => {
  it('treats an over-cap claim file as no valid claim (fake fs, cap enforced by the adapter)', () => {
    const fs = makeFakeFs();
    const alive = new Set([100, 200]);
    const padded = JSON.stringify({ pid: 200, instance: 'other', host: 'mac', refreshedAt: Date.now(), pad: 'x'.repeat(RELAY_HOST_CLAIM_MAX_BYTES) });
    expect(Buffer.byteLength(padded)).toBeGreaterThan(RELAY_HOST_CLAIM_MAX_BYTES);
    fs.writeFileSync(LOCK, padded);
    const lock = makeLock(fs, makeFakeProcess(100, alive));

    expect(lock.otherLiveClaimant()).toBe(null);
    expect(lock.tryClaim()).toBe(true);
    expect(JSON.parse(fs.peek(LOCK)).pid).toBe(100);
  });

  it('a FIFO at the claim path answers no claimant promptly against the real reader', () => {
    const dir = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'oc-hostlock-fifo-'));
    try {
      const lockPath = path.join(dir, 'relay-host.lock');
      execFileSync('mkfifo', [lockPath]);
      const lock = createRelayHostLock({ lockFilePath: lockPath, fs: nodeFs, process: makeFakeProcess(100), hostname: 'mac', logger: silentLogger });

      expect(lock.otherLiveClaimant()).toBe(null);
      // tryClaim and release must also return promptly: neither may open
      // the FIFO (for read or for write) and block.
      expect(lock.tryClaim()).toBe(true);
      expect(() => lock.release()).not.toThrow();
      expect(nodeFs.existsSync(lockPath)).toBe(true);
    } finally {
      nodeFs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a FIFO swapped in after the probe is never written (fake fs, handle judged)', () => {
    const fs = makeFakeFs();
    const stale = JSON.stringify({ pid: 999, instance: 'gone', host: 'mac', refreshedAt: 0 });
    fs.writeFileSync(LOCK, stale);
    // The bounded-read adapter reads the map and reports a regular file;
    // the handle open inside writeClaim sees the swapped-in FIFO instead.
    fs.markFifo(LOCK);
    const lock = makeLock(fs, makeFakeProcess(100));

    expect(lock.tryClaim()).toBe(true);
    expect(fs.peek(LOCK)).toBe(stale);
  });

  it('a FIFO swapped in after the probe answers promptly against the real fs', () => {
    const dir = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'oc-hostlock-swap-'));
    try {
      const lockPath = path.join(dir, 'relay-host.lock');
      nodeFs.writeFileSync(lockPath, JSON.stringify({ pid: 999, instance: 'gone', host: 'mac', refreshedAt: 0 }));
      let swapped = false;
      // The real bounded reader judges the regular file ok; its caller then
      // finds a FIFO where the file was — the swap the probe cannot see.
      const swappingReader = (filePath, maxBytes) => {
        const result = readBoundedFileSync(filePath, maxBytes);
        if (!swapped && result.ok) {
          swapped = true;
          nodeFs.unlinkSync(filePath);
          execFileSync('mkfifo', [filePath]);
        }
        return result;
      };
      const lock = createRelayHostLock({
        lockFilePath: lockPath,
        fs: nodeFs,
        process: makeFakeProcess(100),
        hostname: 'mac',
        logger: silentLogger,
        boundedReadSync: swappingReader,
      });

      // A by-path write open on the FIFO would block until a reader appears;
      // returning at all is the assertion, and the FIFO must be untouched.
      expect(lock.tryClaim()).toBe(true);
      expect(nodeFs.lstatSync(lockPath).isFIFO()).toBe(true);
    } finally {
      nodeFs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an over-cap claim file answers no claimant against the real reader and is replaced by tryClaim', () => {
    const dir = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'oc-hostlock-cap-'));
    try {
      const lockPath = path.join(dir, 'relay-host.lock');
      const padded = JSON.stringify({ pid: 200, instance: 'other', host: 'mac', refreshedAt: Date.now(), pad: 'x'.repeat(RELAY_HOST_CLAIM_MAX_BYTES) });
      nodeFs.writeFileSync(lockPath, padded);
      const lock = createRelayHostLock({
        lockFilePath: lockPath,
        fs: nodeFs,
        process: makeFakeProcess(100, new Set([100, 200])),
        hostname: 'mac',
        logger: silentLogger,
      });

      expect(lock.otherLiveClaimant()).toBe(null);
      expect(lock.tryClaim()).toBe(true);
      expect(JSON.parse(nodeFs.readFileSync(lockPath, 'utf8')).pid).toBe(100);
    } finally {
      nodeFs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a valid claim under the cap is still honoured against the real reader', () => {
    const dir = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'oc-hostlock-ok-'));
    try {
      const lockPath = path.join(dir, 'relay-host.lock');
      nodeFs.writeFileSync(lockPath, JSON.stringify({ pid: 200, instance: 'other', host: 'mac', refreshedAt: Date.now() }));
      const lock = createRelayHostLock({
        lockFilePath: lockPath,
        fs: nodeFs,
        process: makeFakeProcess(100, new Set([100, 200])),
        hostname: 'mac',
        logger: silentLogger,
      });

      expect(lock.otherLiveClaimant()).toEqual({ pid: 200, host: 'mac' });
      expect(lock.tryClaim()).toBe(false);
    } finally {
      nodeFs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
