import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { installSkillsFromRepository } from './install.js';
import { createGitExecutionCoordinator } from '../git/execution-coordinator.js';

const temporaryRoots = [];

const createInstallRunner = ({
  preferredClone = 'success',
  cloneFailure = null,
  sparseSetFailure = null,
  symlink = false,
  events = [],
  isReservationActive = () => false,
} = {}) => {
  let tempBase = null;
  const calls = [];
  const runGit = async (args, options) => {
    calls.push({ args, options });

    if (args[0] === '--version') {
      return { ok: true, stdout: 'git version 2.0', stderr: '' };
    }

    if (args[0] === 'clone') {
      tempBase = args.at(-1);
      await fs.mkdir(path.join(tempBase, 'skills', 'example', 'nested'), { recursive: true });
      if (args.includes('--filter=blob:none') && preferredClone === 'fallback') {
        return { ok: false, stdout: '', stderr: 'filter unsupported', message: 'filter unsupported', code: 128 };
      }
      if (cloneFailure) {
        return { ok: false, stdout: '', stderr: cloneFailure.message, message: cloneFailure.message, code: cloneFailure.code };
      }
      await fs.writeFile(path.join(tempBase, 'skills', 'example', 'SKILL.md'), '---\ndescription: Example\n---\n');
      await fs.writeFile(path.join(tempBase, 'skills', 'example', 'nested', 'notes.md'), 'notes');
      if (symlink) {
        await fs.symlink('/outside', path.join(tempBase, 'skills', 'example', 'escape'));
      }
      return { ok: true, stdout: '', stderr: '' };
    }

    if (args.includes('sparse-checkout') && args.includes('set') && sparseSetFailure) {
      events.push({ event: 'sparse-set', networkReleased: events.some((entry) => entry.event === 'network-released'), reservationActive: isReservationActive() });
      return { ok: false, stdout: '', stderr: sparseSetFailure, message: sparseSetFailure, code: 128 };
    }

    if (args.includes('sparse-checkout') && args.includes('set')) {
      events.push({ event: 'sparse-set', networkReleased: events.some((entry) => entry.event === 'network-released'), reservationActive: isReservationActive() });
    }

    if (args.includes('checkout')) {
      events.push({ event: 'checkout', networkReleased: events.some((entry) => entry.event === 'network-released'), reservationActive: isReservationActive() });
    }

    return { ok: true, stdout: '', stderr: '' };
  };

  return { calls, runGit, getTempBase: () => tempBase };
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

const createWorkingDirectory = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-skills-install-test-'));
  temporaryRoots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('skills catalog repository installation', () => {
  it('holds network through partial-clone materialization and local installation', async () => {
    const workingDirectory = await createWorkingDirectory();
    const events = [];
    const reservation = createReservation(events);
    const runner = createInstallRunner({
      preferredClone: 'fallback',
      events,
      isReservationActive: reservation.isActive,
    });

    const result = await installSkillsFromRepository({
      source: 'owner/repository',
      scope: 'project',
      targetSource: 'opencode',
      workingDirectory,
      userSkillDir: path.join(workingDirectory, 'user-skills'),
      selections: [{ skillDir: 'skills/example' }],
      gitExecutionService: reservation,
      runGit: runner.runGit,
    });

    expect(result).toEqual({
      ok: true,
      installed: [{ skillName: 'example', scope: 'project', source: 'opencode' }],
      skipped: [],
    });
    await expect(fs.readFile(path.join(workingDirectory, '.opencode', 'skills', 'example', 'nested', 'notes.md'), 'utf8')).resolves.toBe('notes');
    expect(runner.calls[1].args).toContain('--filter=blob:none');
    expect(runner.calls[2].args).toEqual(expect.arrayContaining(['clone', '--depth', '1', '--no-checkout']));
    expect(events).toEqual([
      { event: 'sparse-set', networkReleased: false, reservationActive: true },
      { event: 'checkout', networkReleased: false, reservationActive: true },
      { event: 'network-released', reservationActive: true },
      { event: 'task-finished', reservationActive: true },
    ]);
    await expect(fs.stat(runner.getTempBase())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('returns an authentication error after both clone attempts fail', async () => {
    const runner = createInstallRunner({
      cloneFailure: { message: 'fatal: could not read from remote repository', code: 128 },
    });

    await expect(installSkillsFromRepository({
      source: 'owner/private',
      scope: 'project',
      workingDirectory: await createWorkingDirectory(),
      userSkillDir: '/tmp/user-skills',
      selections: [{ skillDir: 'skills/example' }],
      runGit: runner.runGit,
    })).resolves.toMatchObject({
      ok: false,
      error: { kind: 'authRequired', sshOnly: true },
    });
    await expect(fs.stat(runner.getTempBase())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('cleans a partially copied destination when a skill contains a symlink', async () => {
    const workingDirectory = await createWorkingDirectory();
    const runner = createInstallRunner({ symlink: true });

    await expect(installSkillsFromRepository({
      source: 'owner/repository',
      scope: 'project',
      workingDirectory,
      userSkillDir: path.join(workingDirectory, 'user-skills'),
      selections: [{ skillDir: 'skills/example' }],
      runGit: runner.runGit,
    })).resolves.toEqual({
      ok: true,
      installed: [],
      skipped: [{ skillName: 'example', reason: 'Symlinks are not supported in skills' }],
    });
    await expect(fs.stat(path.join(workingDirectory, '.opencode', 'skills', 'example'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(runner.getTempBase())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports sparse checkout failures and does not leave the temporary clone', async () => {
    const runner = createInstallRunner({ sparseSetFailure: 'sparse checkout unavailable' });

    await expect(installSkillsFromRepository({
      source: 'owner/repository',
      scope: 'project',
      workingDirectory: await createWorkingDirectory(),
      userSkillDir: '/tmp/user-skills',
      selections: [{ skillDir: 'skills/example' }],
      runGit: runner.runGit,
    })).resolves.toMatchObject({
      ok: false,
      error: { kind: 'unknown', message: 'sparse checkout unavailable' },
    });
    await expect(fs.stat(runner.getTempBase())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retains the temporary clone and skips fallback when cleanup is unconfirmed', async () => {
    const workingDirectory = await createWorkingDirectory();
    const runner = createInstallRunner();
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

    try {
      await expect(installSkillsFromRepository({
        source: 'owner/repository',
        scope: 'project',
        targetSource: 'opencode',
        workingDirectory,
        userSkillDir: path.join(workingDirectory, 'user-skills'),
        selections: [{ skillDir: 'skills/example' }],
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
      close();
      await expect.poll(() => fs.stat(runner.getTempBase()).then(() => true, () => false)).toBe(false);
    } finally {
      await fs.rm(runner.getTempBase(), { recursive: true, force: true });
    }
  });

  it('keeps the install clone lease until delayed filesystem cleanup completes', async () => {
    const workingDirectory = await createWorkingDirectory();
    const runner = createInstallRunner();
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
      const result = await installSkillsFromRepository({
        source: 'owner/repository',
        scope: 'project',
        workingDirectory,
        userSkillDir: path.join(workingDirectory, 'user-skills'),
        selections: [{ skillDir: 'skills/example' }],
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
    const workingDirectory = await createWorkingDirectory();
    const runner = createInstallRunner();
    const runGit = async (args, options) => {
      const result = await runner.runGit(args, options);
      if (args[0] === 'clone' && args.includes('--filter=blob:none')) {
        controller.abort();
        return { ...result, ok: false, stderr: 'cancelled', message: 'cancelled', code: 'ABORT_ERR' };
      }
      return result;
    };

    await expect(installSkillsFromRepository({
      source: 'owner/repository',
      scope: 'project',
      targetSource: 'opencode',
      workingDirectory,
      userSkillDir: path.join(workingDirectory, 'user-skills'),
      selections: [{ skillDir: 'skills/example' }],
      runGit,
      signal: controller.signal,
    })).resolves.toMatchObject({ ok: false, error: { kind: 'networkError' } });
    expect(runner.calls.filter(({ args }) => args[0] === 'clone')).toHaveLength(1);
    await expect(fs.stat(runner.getTempBase())).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
