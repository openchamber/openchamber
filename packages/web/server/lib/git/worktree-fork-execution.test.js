import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createGitExecutionService } from './execution-service.js';
import {
  createGitExecutionCoordinator,
  GIT_OPERATION_KIND,
} from './execution-coordinator.js';
import { GIT_EXECUTION_ERROR_CODES } from './execution-errors.js';
import * as rawGitService from './service.js';

// ---------------------------------------------------------------------------
// Real-Git temp repository helpers (same shapes as service.test.js)
// ---------------------------------------------------------------------------

const tempDirs = [];

const createTempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-git-fork-execution-'));
  tempDirs.push(dir);
  return dir;
};

const runGit = (cwd, args) => execFileSync('git', args, {
  cwd,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});

const canRunGit = () => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const withDataHome = async (test) => {
  const previousXdgDataHome = process.env.XDG_DATA_HOME;
  const dataHome = createTempDir();
  process.env.XDG_DATA_HOME = dataHome;
  try {
    await test(dataHome);
  } finally {
    if (previousXdgDataHome === undefined) {
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = previousXdgDataHome;
    }
  }
};

/** A repository on `next` whose remote publishes `defaultBranch`. */
const createRepositoryWithRemote = ({ remoteName = 'origin', defaultBranch = 'react' } = {}) => {
  const remote = createTempDir();
  const repository = createTempDir();
  runGit(remote, ['init', '--bare', `--initial-branch=${defaultBranch}`]);
  runGit(repository, ['init', '-b', 'next']);
  runGit(repository, ['config', 'user.email', 'test@example.com']);
  runGit(repository, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(repository, 'README.md'), '# Test\n');
  runGit(repository, ['add', 'README.md']);
  runGit(repository, ['commit', '-m', 'init']);
  runGit(repository, ['remote', 'add', remoteName, remote]);
  runGit(repository, ['push', remoteName, `HEAD:${defaultBranch}`]);
  runGit(repository, ['fetch', remoteName]);
  runGit(repository, ['remote', 'set-head', remoteName, '--auto']);
  return { remote, repository };
};

const publishForkHead = (repository, forkBare, branchName) => {
  fs.writeFileSync(path.join(repository, 'FORK.md'), `# ${branchName}\n`);
  runGit(repository, ['add', 'FORK.md']);
  runGit(repository, ['commit', '-m', `fork ${branchName}`]);
  const sha = runGit(repository, ['rev-parse', 'HEAD']).trim();
  runGit(repository, ['push', forkBare, `HEAD:refs/heads/${branchName}`]);
  return sha;
};

const forkWorktreeInput = ({ fork, worktreeName }) => ({
  mode: 'existing',
  branchName: 'feature/login',
  worktreeName,
  existingBranch: 'remotes/pr-alice/feature/login',
  setUpstream: true,
  upstreamRemote: 'pr-alice',
  upstreamBranch: 'feature/login',
  ensureRemoteName: 'pr-alice',
  ensureRemoteUrl: fork,
});

const readBranchConfig = (cwd, branch, key) => {
  try {
    return runGit(cwd, ['config', '--get', `branch.${branch}.${key}`]).trim();
  } catch {
    return '';
  }
};

// ---------------------------------------------------------------------------
// Bounded-execution recording helpers
// ---------------------------------------------------------------------------

const contextFor = (directory) => ({
  isRepository: true,
  commonId: '/repo/.git',
  worktreeId: directory,
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const waitFor = async (predicate, attempts = 100) => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) {
      return;
    }
    await tick();
  }
};

/**
 * A real coordinator wrapped in a recording proxy. Every `run`/`runStatus`
 * admission is recorded while queueing, leases, cancellation, and stats stay
 * owned by the real coordinator.
 */
const createRecordingCoordinator = (coordinator) => {
  const admissions = [];

  const baseRecord = (options, kind) => ({
    label: options.label,
    kind,
    network: options.network === true,
    started: false,
    finished: false,
    outcome: null,
    admissionError: null,
    taskError: null,
  });

  const recordAdmission = (record, promise) => {
    promise.then(
      () => { record.outcome = 'resolved'; },
      (error) => {
        record.outcome = 'rejected';
        record.admissionError = error;
      },
    );
  };

  const wrapTask = (record, task) => (...args) => {
    record.started = true;
    return Promise.resolve()
      .then(() => task(...args))
      .catch((error) => {
        record.taskError = error;
        throw error;
      })
      .finally(() => { record.finished = true; });
  };

  const proxy = new Proxy(coordinator, {
    get(target, property) {
      if (property === 'run') {
        return (options, task) => {
          const record = baseRecord(options, options.kind);
          admissions.push(record);
          const promise = target.run(options, wrapTask(record, task));
          recordAdmission(record, promise);
          return promise;
        };
      }
      if (property === 'runStatus') {
        return (options, task) => {
          const record = baseRecord(options, 'status');
          admissions.push(record);
          const promise = target.runStatus(options, wrapTask(record, task));
          recordAdmission(record, promise);
          return promise;
        };
      }
      return target[property];
    },
  });

  return {
    coordinator: proxy,
    admissions,
    activeLabels: () => admissions
      .filter((entry) => entry.started && !entry.finished)
      .map((entry) => entry.label),
  };
};

describe('forked PR worktrees through the bounded execution facade', () => {
  it('creates a reachable fork worktree with network-admitted validate and create', async () => {
    if (!canRunGit()) return;

    await withDataHome(async () => {
      const { repository } = createRepositoryWithRemote();
      const fork = createTempDir();
      runGit(fork, ['init', '--bare']);
      const sha = publishForkHead(repository, fork, 'feature/login');

      const { coordinator, admissions } = createRecordingCoordinator(createGitExecutionCoordinator());
      const service = createGitExecutionService({ coordinator });
      const input = forkWorktreeInput({ fork, worktreeName: 'pr-42' });

      await expect(service.validateWorktreeCreate(repository, input)).resolves.toMatchObject({ ok: true });
      const created = await service.createWorktree(repository, input);

      expect(created.branch).toBe('feature/login');
      expect(runGit(created.path, ['rev-parse', 'HEAD']).trim()).toBe(sha);
      expect(runGit(repository, ['remote', 'get-url', 'pr-alice']).trim()).toBe(fork);
      await expect.poll(() => fs.existsSync(path.join(created.path, 'FORK.md')), { timeout: 20_000 }).toBe(true);
      await expect.poll(() => readBranchConfig(created.path, 'feature/login', 'remote'), { timeout: 20_000 }).toBe('pr-alice');

      const validateAdmission = admissions.find((entry) => entry.label === 'validateWorktreeCreate');
      const createAdmission = admissions.find((entry) => entry.label === 'createWorktree');
      expect(validateAdmission).toMatchObject({
        kind: GIT_OPERATION_KIND.COMMON_WRITE,
        network: true,
        started: true,
      });
      expect(createAdmission).toMatchObject({
        kind: GIT_OPERATION_KIND.TOPOLOGY_WRITE,
        network: true,
        started: true,
      });
      expect(admissions.filter((entry) => entry.label === 'validateWorktreeCreate')).toHaveLength(1);
      expect(admissions.filter((entry) => entry.label === 'createWorktree')).toHaveLength(1);

      const backgroundAdmissions = admissions.filter((entry) => entry.label === 'worktreeBootstrap');
      expect(backgroundAdmissions.length).toBeGreaterThan(0);
      expect(backgroundAdmissions.every((entry) => entry.network === true)).toBe(true);

      await expect.poll(() => {
        const stats = service.coordinator.getStats();
        return stats.active === 0 && stats.pending === 0;
      }, { timeout: 20_000 }).toBe(true);
      expect(service.coordinator.getStats()).toMatchObject({ active: 0, pending: 0, activeNetwork: 0 });
    });
  }, 60_000);

  it('rejects a partial ensure pair without leaving a worktree or held reservations', async () => {
    if (!canRunGit()) return;

    await withDataHome(async (dataHome) => {
      const { repository } = createRepositoryWithRemote();
      const { coordinator, admissions } = createRecordingCoordinator(createGitExecutionCoordinator());
      const service = createGitExecutionService({ coordinator });
      const worktreeName = 'pr-42-missing-url';
      const input = {
        mode: 'existing',
        branchName: 'feature/login',
        worktreeName,
        existingBranch: 'remotes/pr-alice/feature/login',
        setUpstream: true,
        upstreamRemote: 'pr-alice',
        upstreamBranch: 'feature/login',
        ensureRemoteName: 'pr-alice',
      };
      const worktreesBefore = runGit(repository, ['worktree', 'list', '--porcelain']);

      const validation = await service.validateWorktreeCreate(repository, input);
      expect(validation.ok).toBe(false);
      expect(validation.errors.map((error) => error.code)).toContain('invalid_remote_config');

      await expect(service.createWorktree(repository, input)).rejects.toThrow(/Remote branch not found/i);

      expect(runGit(repository, ['worktree', 'list', '--porcelain'])).toBe(worktreesBefore);
      const projectID = runGit(repository, ['rev-list', '--max-parents=0', '--all']).trim();
      const candidateDirectory = path.join(dataHome, 'opencode', 'worktree', projectID, worktreeName);
      expect(fs.existsSync(candidateDirectory)).toBe(false);

      await expect.poll(() => {
        const stats = service.coordinator.getStats();
        return stats.active === 0 && stats.pending === 0;
      }, { timeout: 10_000 }).toBe(true);
      expect(service.coordinator.getStats()).toMatchObject({
        active: 0,
        pending: 0,
        activeNetwork: 0,
        statusInFlight: 0,
        clonePending: 0,
        cloneDestinations: 0,
      });

      const admitted = admissions.filter((entry) => entry.label === 'validateWorktreeCreate'
        || entry.label === 'createWorktree');
      expect(admitted.length).toBeGreaterThanOrEqual(2);
      expect(admitted.every((entry) => entry.network === true)).toBe(true);
    });
  }, 30_000);

  it('rejects an unreachable fork even when a stale remote-tracking ref exists', async () => {
    if (!canRunGit()) return;

    await withDataHome(async () => {
      const { repository } = createRepositoryWithRemote();
      const fork = createTempDir();
      runGit(fork, ['init', '--bare']);
      const sha = publishForkHead(repository, fork, 'feature/login');
      // Make the fork reachable once so a remote-tracking ref is cached locally.
      runGit(repository, ['fetch', fork, '+refs/heads/feature/login:refs/remotes/pr-alice/feature/login']);
      expect(runGit(repository, ['rev-parse', 'refs/remotes/pr-alice/feature/login']).trim()).toBe(sha);

      const { coordinator, admissions, activeLabels } = createRecordingCoordinator(createGitExecutionCoordinator());
      const rawCreateEntries = [];
      const raw = new Proxy(rawGitService, {
        get(target, property) {
          if (property === 'createWorktree') {
            return async (...args) => {
              rawCreateEntries.push(activeLabels());
              return target.createWorktree(...args);
            };
          }
          return target[property];
        },
      });
      const service = createGitExecutionService({ raw, coordinator });

      const missingFork = path.join(createTempDir(), 'missing-fork.git');
      const worktreesBefore = runGit(repository, ['worktree', 'list', '--porcelain']);
      const marker = admissions.length;

      await expect(service.createWorktree(repository, forkWorktreeInput({
        fork: missingFork,
        worktreeName: 'pr-42-stale',
      }))).rejects.toThrow(/Unable to (reach|fetch)/i);

      // The cached ref is still present, but it was never accepted as the source.
      expect(runGit(repository, ['rev-parse', 'refs/remotes/pr-alice/feature/login']).trim()).toBe(sha);
      expect(runGit(repository, ['worktree', 'list', '--porcelain'])).toBe(worktreesBefore);

      const createAdmissions = admissions.slice(marker)
        .filter((entry) => entry.label === 'createWorktree');
      expect(createAdmissions).toHaveLength(1);
      expect(createAdmissions[0]).toMatchObject({ network: true, started: true });

      // The raw fork fetch/ensure work ran inside its own admitted task: no
      // other admission was active at raw entry, and it ran exactly once.
      expect(rawCreateEntries).toHaveLength(1);
      expect(rawCreateEntries[0]).toEqual(['createWorktree']);
      expect(admissions.slice(marker).filter((entry) => entry.label !== 'createWorktree')).toHaveLength(0);

      await expect.poll(() => {
        const stats = service.coordinator.getStats();
        return stats.active === 0 && stats.pending === 0;
      }, { timeout: 10_000 }).toBe(true);
      expect(service.coordinator.getStats()).toMatchObject({ active: 0, pending: 0, activeNetwork: 0 });
    });
  }, 30_000);

  it('keeps the same facade usable after a failed fork create', async () => {
    if (!canRunGit()) return;

    await withDataHome(async () => {
      const { repository } = createRepositoryWithRemote();
      const { coordinator } = createRecordingCoordinator(createGitExecutionCoordinator());
      const service = createGitExecutionService({ coordinator });
      const missingFork = path.join(createTempDir(), 'missing-fork.git');

      await expect(service.createWorktree(repository, forkWorktreeInput({
        fork: missingFork,
        worktreeName: 'pr-42-lease',
      }))).rejects.toThrow(/Unable to (reach|fetch)/i);

      await expect.poll(() => {
        const stats = service.coordinator.getStats();
        return stats.active === 0 && stats.pending === 0;
      }, { timeout: 10_000 }).toBe(true);

      const worktrees = await service.getWorktrees(repository);
      expect(worktrees).toHaveLength(1);
      await expect(service.getStatus(repository)).resolves.toMatchObject({ current: 'next' });

      await expect.poll(
        () => service.coordinator.getStats().statusInFlight === 0,
        { timeout: 10_000 },
      ).toBe(true);
      expect(service.coordinator.getStats()).toMatchObject({
        active: 0,
        pending: 0,
        activeNetwork: 0,
        statusInFlight: 0,
        clonePending: 0,
        cloneDestinations: 0,
      });
    });
  }, 30_000);

  it('cancels a queued worktree create before the raw task runs', async () => {
    const { coordinator, admissions } = createRecordingCoordinator(createGitExecutionCoordinator({
      globalConcurrency: 4,
      globalNetworkConcurrency: 1,
      networkPerCommonContext: 1,
    }));
    let rawCreateRuns = 0;
    const service = createGitExecutionService({
      raw: {
        createWorktree: async () => {
          rawCreateRuns += 1;
          return { created: true };
        },
      },
      coordinator,
      resolver: { resolve: async (directory) => contextFor(directory) },
    });

    let releaseHold;
    const hold = coordinator.run({
      context: contextFor('/repo'),
      kind: GIT_OPERATION_KIND.COMMON_WRITE,
      targetWorktree: true,
      network: true,
      label: 'test-hold',
    }, () => new Promise((resolve) => { releaseHold = resolve; }));
    await waitFor(() => service.coordinator.getStats().active === 1);

    const controller = new AbortController();
    const pending = service.createWorktree('/repo', forkWorktreeInput({
      fork: '/nonexistent/fork.git',
      worktreeName: 'pr-cancel-queued',
    }), { signal: controller.signal });
    await waitFor(() => service.coordinator.getStats().pending === 1);

    controller.abort('caller left');
    await expect(pending).rejects.toMatchObject({ code: GIT_EXECUTION_ERROR_CODES.CANCELLED });
    expect(rawCreateRuns).toBe(0);

    const createAdmission = admissions.find((entry) => entry.label === 'createWorktree');
    expect(createAdmission).toMatchObject({ network: true, started: false });
    expect(createAdmission.admissionError).toMatchObject({ code: GIT_EXECUTION_ERROR_CODES.CANCELLED });

    releaseHold('held');
    await expect(hold).resolves.toBe('held');
    await waitFor(() => service.coordinator.getStats().active === 0
      && service.coordinator.getStats().pending === 0);
    expect(service.coordinator.getStats()).toMatchObject({ active: 0, pending: 0, activeNetwork: 0 });
    expect(admissions.filter((entry) => entry.label !== 'test-hold')).toHaveLength(1);
  });

  it('cancels a running worktree create and releases its lease exactly once', async () => {
    const real = createGitExecutionCoordinator({ globalConcurrency: 4 });
    const settledLabels = [];
    const releasedLabels = [];
    const nativeSettle = real.settleEntry.bind(real);
    real.settleEntry = (entry, method, value) => {
      if (!entry.settled) {
        settledLabels.push(entry.label);
      }
      return nativeSettle(entry, method, value);
    };
    const nativeRelease = real.releaseMutationGeneration.bind(real);
    real.releaseMutationGeneration = (entry) => {
      releasedLabels.push(entry.label);
      return nativeRelease(entry);
    };
    const { coordinator, admissions } = createRecordingCoordinator(real);

    let releaseGate;
    let rawStarted = false;
    const service = createGitExecutionService({
      raw: {
        createWorktree: async () => {
          rawStarted = true;
          await new Promise((resolve) => { releaseGate = resolve; });
          return { created: true };
        },
      },
      coordinator,
      resolver: { resolve: async (directory) => contextFor(directory) },
    });

    const controller = new AbortController();
    const pending = service.createWorktree('/repo', forkWorktreeInput({
      fork: '/nonexistent/fork.git',
      worktreeName: 'pr-cancel-running',
    }), { signal: controller.signal });
    await waitFor(() => rawStarted);
    expect(service.coordinator.getStats()).toMatchObject({ active: 1, activeNetwork: 1 });

    controller.abort('caller left');
    await expect(pending).rejects.toMatchObject({ code: GIT_EXECUTION_ERROR_CODES.CANCELLED });

    // The admitted mutation keeps running until its own task finishes.
    expect(service.coordinator.getStats()).toMatchObject({ active: 1 });
    expect(settledLabels.filter((label) => label === 'createWorktree')).toHaveLength(1);

    releaseGate();
    await waitFor(() => service.coordinator.getStats().active === 0
      && service.coordinator.getStats().pending === 0);
    await tick();

    expect(settledLabels.filter((label) => label === 'createWorktree')).toHaveLength(1);
    expect(releasedLabels.filter((label) => label === 'createWorktree')).toHaveLength(1);
    expect(service.coordinator.getStats()).toMatchObject({ active: 0, pending: 0, activeNetwork: 0 });
    expect(admissions.filter((entry) => entry.label !== 'createWorktree')).toHaveLength(0);
  });

  it('creates a reachable fork worktree fast and runs bootstrap as a later network admission', async () => {
    if (!canRunGit()) return;

    await withDataHome(async () => {
      const { repository } = createRepositoryWithRemote();
      const fork = createTempDir();
      runGit(fork, ['init', '--bare']);
      const sha = publishForkHead(repository, fork, 'feature/login');

      const { coordinator, admissions } = createRecordingCoordinator(createGitExecutionCoordinator());
      const service = createGitExecutionService({ coordinator });
      const created = await service.createWorktree(repository, {
        ...forkWorktreeInput({ fork, worktreeName: 'pr-fast' }),
        returnAfterDirectoryCreated: true,
      });

      expect(created.directoryCreated).toBe(true);
      expect(created.bootstrapStatus).toMatchObject({
        status: 'pending',
        phase: 'directory-created',
      });

      await expect.poll(() => fs.existsSync(path.join(created.path, 'FORK.md')), { timeout: 20_000 }).toBe(true);
      await expect.poll(() => readBranchConfig(created.path, 'feature/login', 'remote'), { timeout: 20_000 }).toBe('pr-alice');
      await expect.poll(
        () => service.getWorktreeBootstrapStatus(created.path).then((status) => status.status),
        { timeout: 20_000 },
      ).toBe('ready');
      expect(runGit(created.path, ['rev-parse', 'HEAD']).trim()).toBe(sha);

      const labels = admissions.map((entry) => entry.label);
      expect(labels.indexOf('createWorktree')).toBeGreaterThanOrEqual(0);
      expect(labels.indexOf('worktreeAttachment')).toBeGreaterThan(labels.indexOf('createWorktree'));
      expect(labels.indexOf('worktreeBootstrap')).toBeGreaterThan(labels.indexOf('worktreeAttachment'));

      const attachment = admissions.find((entry) => entry.label === 'worktreeAttachment');
      const bootstrap = admissions.find((entry) => entry.label === 'worktreeBootstrap');
      expect(attachment).toMatchObject({
        kind: GIT_OPERATION_KIND.TOPOLOGY_WRITE,
        network: true,
        started: true,
      });
      expect(bootstrap).toMatchObject({
        kind: GIT_OPERATION_KIND.TOPOLOGY_WRITE,
        network: true,
        started: true,
      });

      // No reentrancy/deadlock surfaced while the create returned early.
      expect(admissions.filter((entry) => entry.admissionError !== null
        || entry.taskError !== null)).toHaveLength(0);

      await expect.poll(() => {
        const stats = service.coordinator.getStats();
        return stats.active === 0 && stats.pending === 0;
      }, { timeout: 20_000 }).toBe(true);
      expect(service.coordinator.getStats()).toMatchObject({ active: 0, pending: 0, activeNetwork: 0 });
    });
  }, 60_000);
});
