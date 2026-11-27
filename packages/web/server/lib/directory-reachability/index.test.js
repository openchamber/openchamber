import { afterEach, describe, expect, it } from 'vitest';

import { createDirectoryReachability } from './index.js';

const failure = (code) => Object.assign(new Error(code), { code });
const disposers = [];
afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); });

const create = (options) => {
  const reachability = createDirectoryReachability({ platform: 'linux', answerDeadlineMs: 400, ...options });
  disposers.push(reachability.dispose);
  return reachability;
};

const hangingDisk = (isDead) => {
  const waiting = new Set();
  const answer = (target) => (isDead(target) ? new Promise((resolve) => { waiting.add(resolve); }) : Promise.resolve(null));
  return { waiting, answer };
};

const processOver = (disk) => {
  const state = { starts: 0, stops: 0 };
  return {
    state,
    startProcess: () => {
      state.starts += 1;
      return { touch: disk.answer, stop: () => { state.stops += 1; } };
    },
  };
};

describe('directory reachability', () => {
  it('tells an existing, a deleted and an unanswering folder apart', async () => {
    const outcomes = { '/here': null, '/locked': 'EACCES', '/gone': 'ENOENT', '/nas': 'UNKNOWN', '/stale': 'ESTALE' };
    const reachability = create({ touch: async (target) => { if (outcomes[target]) throw failure(outcomes[target]); } });
    const answers = await Promise.all(Object.keys(outcomes).map(reachability.check));
    expect(answers).toEqual(['available', 'available', 'missing', 'unreachable', 'unreachable']);
  });

  it('keeps answering for a live folder while many dead ones hang', async () => {
    const disk = hangingDisk((target) => target.startsWith('/nas'));
    const helper = processOver(disk);
    const reachability = create({ touch: disk.answer, startProcess: helper.startProcess });
    const dead = Array.from({ length: 20 }, (_, index) => reachability.check(`/nas/project-${index}`));
    expect(await reachability.check('/home/project')).toBe('available');
    expect(new Set(await Promise.all(dead))).toEqual(new Set(['unreachable']));
    expect(helper.state.starts).toBe(1);
  });

  it('answers at once for a folder already known to hang, and for everything below it', async () => {
    const disk = hangingDisk((target) => target.startsWith('/nas'));
    const reachability = create({ touch: disk.answer, startProcess: processOver(disk).startProcess });
    await reachability.check('/nas/project');
    const hangingBefore = disk.waiting.size;
    const startedAt = performance.now();
    expect(await reachability.check('/nas/project/src/file.ts')).toBe('unreachable');
    expect(performance.now() - startedAt).toBeLessThan(300);
    expect(disk.waiting.size - hangingBefore).toBeLessThanOrEqual(1);
  });

  it('recovers when the path answers again', async () => {
    let dead = true;
    const disk = hangingDisk((target) => dead && target.startsWith('/nas'));
    const reachability = create({ touch: disk.answer, startProcess: processOver(disk).startProcess });
    expect(await reachability.check('/nas/project')).toBe('unreachable');
    dead = false;
    for (const resolve of disk.waiting) resolve(null);
    await expect.poll(() => reachability.check('/nas/project')).toBe('available');
  });

  it('asks again after an error answer has aged', async () => {
    let code = 'UNKNOWN';
    let time = 0;
    const reachability = create({ touch: async () => { if (code) throw failure(code); }, now: () => time });
    expect(await reachability.check('/nas')).toBe('unreachable');
    code = null;
    expect(await reachability.check('/nas')).toBe('unreachable');
    time = 6000;
    expect(await reachability.check('/nas')).toBe('available');
  });

  it('does not call a folder deleted while its whole drive or volume is absent', async () => {
    const missing = async () => { throw failure('ENOENT'); };
    expect(await create({ platform: 'darwin', touch: missing }).check('/Volumes/NAS/project')).toBe('unreachable');
    expect(await create({ platform: 'darwin', touch: missing }).check('/Users/me/project')).toBe('missing');
  });

  it('recovers after a remount while the old call is still stuck', async () => {
    let remounted = false;
    let starts = 0;
    const startProcess = (onExit) => {
      starts += 1;
      const waiting = new Set();
      return {
        touch: () => (remounted ? Promise.resolve(null) : new Promise((resolve) => { waiting.add(resolve); })),
        stop: () => {
          for (const resolve of waiting) resolve(undefined);
          onExit(false);
        },
      };
    };
    const reachability = create({ touch: () => new Promise(() => {}), startProcess, stuckProcessMs: 600 });
    expect(await reachability.check('/nas/project')).toBe('unreachable');
    const startsBefore = starts;
    remounted = true;
    await expect.poll(() => reachability.check('/nas/project'), { timeout: 3000 }).toBe('available');
    expect(starts).toBeGreaterThan(startsBefore);
  });

  it('still answers when the helper process cannot run', async () => {
    const disk = hangingDisk((target) => target.startsWith('/nas'));
    const startProcess = (onExit) => {
      queueMicrotask(() => onExit(true));
      return { touch: async () => undefined, stop: () => {} };
    };
    const reachability = create({ touch: disk.answer, startProcess });
    const dead = ['/nas/a', '/nas/b', '/nas/c'].map(reachability.check);
    expect(await reachability.check('/home/project')).toBe('available');
    expect(await Promise.all(dead)).toEqual(['unreachable', 'unreachable', 'unreachable']);
  });

  it('reads a real folder through the real helper process', async () => {
    const hang = () => new Promise(() => {});
    const reachability = create({ touch: hang, answerDeadlineMs: 5000 });
    expect(await reachability.check('/nowhere/that-hangs')).toBe('missing');
    expect(await reachability.check(import.meta.dirname)).toBe('available');
    expect(await reachability.check(`${import.meta.dirname}/nothing-here`)).toBe('missing');
  }, 15_000);
});
