import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { scanSkillsRepository } from './scan.js';
import { getGitExecutionEnv } from '../git/execution-scope.js';
import { createGitExecutionCoordinator } from '../git/execution-coordinator.js';

const temporaryRoots = [];

const createGitRunner = ({
  preferredClone = 'success',
  cloneFailure = null,
  sparse = true,
  listFailure = null,
  skillDirs = ['example'],
  missingSkillDirs = [],
  showResultFor = null,
  events = [],
  isReservationActive = () => false,
} = {}) => {
  let tempBase = null;
  const calls = [];

  const runGit = async (args, options) => {
    calls.push({ args, options, env: getGitExecutionEnv() });
    if (args[0] === '--version') {
      if (cloneFailure?.at === 'availability') return { ok: false, stderr: cloneFailure.message, message: cloneFailure.message, code: cloneFailure.code };
      return { ok: true, stdout: 'git version 2.0', stderr: '' };
    }

    if (args[0] === 'clone') {
      tempBase = args.at(-1);
      await Promise.all(skillDirs.map((skillDir) => fs.mkdir(path.join(tempBase, skillDir), { recursive: true })));
      if (args.includes('--filter=blob:none') && preferredClone === 'fallback') {
        return { ok: false, stdout: '', stderr: 'filter unsupported', message: 'filter unsupported', code: 128 };
      }
      if (cloneFailure?.at === 'clone') {
        return { ok: false, stdout: '', stderr: cloneFailure.message, message: cloneFailure.message, code: cloneFailure.code };
      }
      await Promise.all(skillDirs
        .filter((skillDir) => !missingSkillDirs.includes(skillDir))
        .map((skillDir) => fs.writeFile(
          path.join(tempBase, skillDir, 'SKILL.md'),
          '---\nname: Example\ndescription: Example skill\n---\nBody\n',
        )));
      return { ok: true, stdout: '', stderr: '' };
    }

    if (args.includes('sparse-checkout')) {
      if (args.includes('set')) {
        events.push({ event: 'sparse-set', networkReleased: events.some((entry) => entry.event === 'network-released'), reservationActive: isReservationActive() });
      }
      return sparse
        ? { ok: true, stdout: '', stderr: '' }
        : { ok: false, stdout: '', stderr: 'sparse checkout unavailable', message: 'sparse checkout unavailable', code: 128 };
    }

    if (args.includes('checkout')) {
      events.push({ event: 'checkout', networkReleased: events.some((entry) => entry.event === 'network-released'), reservationActive: isReservationActive() });
      return { ok: true, stdout: '', stderr: '' };
    }

    if (args.includes('ls-files')) {
      return { ok: true, stdout: skillDirs.map((skillDir) => `${skillDir}/SKILL.md`).join('\n') + '\n', stderr: '' };
    }

    if (args.includes('ls-tree')) {
      events.push({ event: 'ls-tree', networkReleased: events.some((entry) => entry.event === 'network-released'), reservationActive: isReservationActive() });
      if (listFailure) {
        return { ok: false, stdout: '', stderr: listFailure.message, message: listFailure.message, code: listFailure.code };
      }
      return { ok: true, stdout: skillDirs.map((skillDir) => `${skillDir}/SKILL.md`).join('\n') + '\n', stderr: '' };
    }

    if (args.includes('show')) {
      const configured = showResultFor?.(args.at(-1));
      if (configured) return configured;
      return { ok: true, stdout: '---\ndescription: Example skill\n---\n', stderr: '' };
    }

    return { ok: true, stdout: '', stderr: '' };
  };

  return {
    calls,
    runGit,
    getTempBase: () => tempBase,
  };
};

const createReservation = (events) => {
  let active = false;
  let networkActive = false;
  return {
    coordinator: {
      runClone: async (_options, task) => {
        active = true;
        networkActive = true;
        const releaseNetwork = () => {
          if (!networkActive) return;
          networkActive = false;
          events.push({ event: 'network-released', reservationActive: active });
        };
        try {
          return await task({
            releaseNetwork,
          });
        } finally {
          releaseNetwork();
          events.push({ event: 'task-finished', reservationActive: active });
          active = false;
        }
      },
    },
    isActive: () => active,
  };
};

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('skills catalog repository scanning', () => {
  it('holds network through partial-clone materialization and releases it before the lease ends', async () => {
    const events = [];
    const reservation = createReservation(events);
    const runner = createGitRunner({
      preferredClone: 'fallback',
      events,
      isReservationActive: reservation.isActive,
    });

    const result = await scanSkillsRepository({
      source: 'owner/repository',
      defaultSubpath: 'skills',
      identity: { sshKey: '/home/user/.ssh/id_ed25519' },
      gitExecutionService: reservation,
      runGit: runner.runGit,
    });

    expect(result).toMatchObject({
      ok: true,
      normalizedRepo: 'owner/repository',
      effectiveSubpath: 'skills',
      items: [{ skillName: 'example', description: 'Example skill' }],
    });
    expect(runner.calls[1].args).toContain('--filter=blob:none');
    expect(runner.calls[2].args).toEqual(expect.arrayContaining(['clone', '--depth', '1', '--no-checkout']));
    expect(runner.calls.some(({ args }) => args.includes('show'))).toBe(false);
    expect(runner.calls.find(({ args }) => args.includes('ls-files')).env).toEqual({ GIT_OPTIONAL_LOCKS: '0' });
    expect(events).toEqual([
      { event: 'sparse-set', networkReleased: false, reservationActive: true },
      { event: 'checkout', networkReleased: false, reservationActive: true },
      { event: 'network-released', reservationActive: true },
      { event: 'task-finished', reservationActive: true },
    ]);
    await expect(fs.stat(runner.getTempBase())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('returns an authentication error after both clone strategies fail', async () => {
    const runner = createGitRunner({
      cloneFailure: { at: 'clone', message: 'fatal: Authentication failed for origin', code: 128 },
    });

    await expect(scanSkillsRepository({
      source: 'owner/private',
      runGit: runner.runGit,
    })).resolves.toMatchObject({
      ok: false,
      error: { kind: 'authRequired', sshOnly: true },
    });
    expect(runner.calls.filter(({ args }) => args[0] === 'clone')).toHaveLength(2);
    await expect(fs.stat(runner.getTempBase())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports Git unavailable without attempting a clone', async () => {
    const runner = createGitRunner({
      cloneFailure: { at: 'availability', message: 'spawn git ENOENT', code: 'ENOENT' },
    });

    await expect(scanSkillsRepository({ source: 'owner/repository', runGit: runner.runGit })).resolves.toEqual({
      ok: false,
      error: { kind: 'gitUnavailable', message: 'Git is not available in PATH' },
    });
    expect(runner.calls.filter(({ args }) => args[0] === 'clone')).toHaveLength(0);
  });

  it('keeps spawn failures distinct from authentication failures', async () => {
    const runner = createGitRunner({
      cloneFailure: { at: 'clone', message: 'spawn git ENOENT', code: 'ENOENT' },
    });

    await expect(scanSkillsRepository({ source: 'owner/repository', runGit: runner.runGit })).resolves.toMatchObject({
      ok: false,
      error: { kind: 'networkError', message: expect.stringContaining('spawn git ENOENT') },
    });
  });

  it('does not turn a failed repository listing into an authoritative empty scan', async () => {
    const events = [];
    const reservation = createReservation(events);
    const runner = createGitRunner({
      sparse: false,
      listFailure: { message: 'fatal: repository read failed', code: 128 },
      events,
      isReservationActive: reservation.isActive,
    });

    await expect(scanSkillsRepository({ source: 'owner/repository', gitExecutionService: reservation, runGit: runner.runGit })).resolves.toMatchObject({
      ok: false,
      error: { kind: 'networkError', message: expect.stringContaining('repository read failed') },
    });
    expect(events).toEqual([
      { event: 'ls-tree', networkReleased: false, reservationActive: true },
      { event: 'network-released', reservationActive: true },
      { event: 'task-finished', reservationActive: true },
    ]);
    await expect(fs.stat(runner.getTempBase())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retains the temporary clone and skips fallback when cleanup is unconfirmed', async () => {
    const runner = createGitRunner();
    const runGit = async (args, options) => {
      const result = await runner.runGit(args, options);
      if (args[0] === 'clone' && args.includes('--filter=blob:none')) {
        return {
          ...result,
          ok: false,
          cleanupBlocked: true,
          descendantsTerminated: false,
        };
      }
      return result;
    };

    try {
      await expect(scanSkillsRepository({
        source: 'owner/repository',
        runGit,
      })).resolves.toMatchObject({
        ok: false,
        cleanupBlocked: true,
        error: {
          kind: 'networkError',
          cleanupBlocked: true,
          descendantsTerminated: false,
        },
      });
      expect(runner.calls.filter(({ args }) => args[0] === 'clone')).toHaveLength(1);
      await expect(fs.stat(runner.getTempBase())).resolves.toBeTruthy();
    } finally {
      await fs.rm(runner.getTempBase(), { recursive: true, force: true });
    }
  });

  it('reaps a retained temporary clone after late process cleanup', async () => {
    const runner = createGitRunner();
    let close;
    const cleanupReconciliation = {
      promise: new Promise((resolve) => { close = resolve; }),
      retire: () => close?.(),
    };
    const runGit = async (args, options) => {
      const result = await runner.runGit(args, options);
      if (args[0] === 'clone' && args.includes('--filter=blob:none')) {
        return {
          ...result,
          ok: false,
          cleanupBlocked: true,
          descendantsTerminated: false,
          cleanupReconciliation,
        };
      }
      return result;
    };

    await expect(scanSkillsRepository({ source: 'owner/repository', runGit })).resolves.toMatchObject({
      ok: false,
      cleanupBlocked: true,
    });
    await expect(fs.stat(runner.getTempBase())).resolves.toBeTruthy();
    close();
    await expect.poll(() => fs.stat(runner.getTempBase()).then(() => true, () => false)).toBe(false);
  });

  it('keeps the clone lease until delayed filesystem cleanup completes', async () => {
    const runner = createGitRunner();
    let close;
    const cleanupReconciliation = {
      promise: new Promise((resolve) => { close = resolve; }),
      retire: () => close?.(),
    };
    const runGit = async (args, options) => {
      const result = await runner.runGit(args, options);
      if (args[0] === 'clone' && args.includes('--filter=blob:none')) {
        return {
          ...result,
          ok: false,
          cleanupBlocked: true,
          descendantsTerminated: false,
          cleanupReconciliation,
        };
      }
      return result;
    };
    let releaseCleanup;
    let cleanupStarted;
    let cleanupCalls = 0;
    const cleanupWasStarted = new Promise((resolve) => { cleanupStarted = resolve; });
    const originalRm = fs.rm;
    const rmSpy = vi.spyOn(fs, 'rm').mockImplementation(async (target, options) => {
      if (target === runner.getTempBase()) {
        cleanupCalls += 1;
        cleanupStarted();
        await new Promise((resolve) => { releaseCleanup = resolve; });
      }
      return originalRm(target, options);
    });
    const coordinator = createGitExecutionCoordinator({
      canonicalizeCloneDestination: async (destination) => path.resolve(destination),
    });

    try {
      const result = await scanSkillsRepository({
        source: 'owner/repository',
        gitExecutionService: { coordinator },
        runGit,
      });
      expect(result).toMatchObject({ ok: false, cleanupBlocked: true });
      expect(coordinator.getStats()).toMatchObject({ active: 1, cloneDestinations: 1 });
      await expect(fs.stat(runner.getTempBase())).resolves.toBeTruthy();

      close();
      await cleanupWasStarted;
      expect(coordinator.getStats()).toMatchObject({ active: 1, cloneDestinations: 1 });
      await expect(fs.stat(runner.getTempBase())).resolves.toBeTruthy();

      releaseCleanup();
      await expect.poll(() => coordinator.getStats().active).toBe(0);
      await expect.poll(() => fs.stat(runner.getTempBase()).then(() => true, () => false)).toBe(false);
      expect(cleanupCalls).toBe(1);
      expect(coordinator.getStats()).toMatchObject({ active: 0, cloneDestinations: 0 });
    } finally {
      rmSpy.mockRestore();
      await fs.rm(runner.getTempBase(), { recursive: true, force: true });
    }
  });

  it('does not start the clone fallback after the preferred clone is cancelled', async () => {
    const controller = new AbortController();
    const runner = createGitRunner();
    const runGit = async (args, options) => {
      const result = await runner.runGit(args, options);
      if (args[0] === 'clone' && args.includes('--filter=blob:none')) {
        controller.abort();
        return { ...result, ok: false, stderr: 'cancelled', message: 'cancelled', code: 'ABORT_ERR' };
      }
      return result;
    };

    await expect(scanSkillsRepository({
      source: 'owner/repository',
      runGit,
      signal: controller.signal,
    })).resolves.toMatchObject({ ok: false, error: { kind: 'networkError' } });
    expect(runner.calls.filter(({ args }) => args[0] === 'clone')).toHaveLength(1);
    await expect(fs.stat(runner.getTempBase())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('waits for a late sibling read before releasing a cleanup-blocked scan lease', async () => {
    let releaseSibling;
    let siblingStarted;
    const siblingStartedPromise = new Promise((resolve) => { siblingStarted = resolve; });
    const cleanupReconciliation = { promise: Promise.resolve(), retire: () => undefined };
    const runner = createGitRunner({
      sparse: false,
      skillDirs: ['skills/blocked', 'skills/slow'],
      missingSkillDirs: ['skills/blocked', 'skills/slow'],
      showResultFor: (ref) => {
        if (ref.endsWith('blocked/SKILL.md')) {
          return { ok: false, cleanupBlocked: true, descendantsTerminated: false, cleanupReconciliation };
        }
        siblingStarted();
        return new Promise((resolve) => { releaseSibling = () => resolve({ ok: true, stdout: '---\ndescription: Slow\n---\n', stderr: '' }); });
      },
    });
    const events = [];
    const reservation = createReservation(events);

    const pending = scanSkillsRepository({
      source: 'owner/repository',
      gitExecutionService: reservation,
      runGit: runner.runGit,
    });
    await siblingStartedPromise;
    await Promise.resolve();
    expect(events).not.toContainEqual({ event: 'task-finished', reservationActive: true });

    releaseSibling();
    await expect(pending).resolves.toMatchObject({ ok: false, cleanupBlocked: true });
    expect(events).toContainEqual({ event: 'task-finished', reservationActive: true });
  });
});
