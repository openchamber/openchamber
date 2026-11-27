import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { withSourceControlFileLock } from '../source-control/file-lock.js';
import { hasSourceControlErrorCode } from '../source-control/input-guards.js';
import { belongsToRepository, listRecordedWorktrees } from './integrate-checkouts.js';
import { isInside, listIntegrateProjects, moveSessionsOut, onIntegrateSessionsReady, type IntegrateSessionsMove } from './integrate-sessions.js';
import type { createIntegrateCheckouts, IntegrateCheckout, IntegrateConflictFields } from './integrate-checkouts.js';
import { DIRECTORY_UNREACHABLE, directoryReachability, directoryUnreachableError } from '../directory-reachability/index.js';
import { assertRepositoryReachable, realpathOf } from './reachable-disk.js';
import { findUnpickedCommits } from './integrate-progress.js';
import type { createIntegratePublisher } from './integrate-publish.js';
import type { GitCommandResult, IntegratePlanInput, IntegrateStateInput } from './service-contracts.js';

export interface IntegrateConflictDetails {
  statusPorcelain: string;
  unmergedFiles: string[];
  diff: string;
  currentPatchMeta: string;
  currentPatch: string;
}

type ConflictReason = 'changed' | 'alreadyOpen' | 'sessionsHeld';

const RESUME_DELAY_MS = 5_000;
const RESUME_DELAY_MAX_MS = 60_000;

interface IntegrationDependencies {
  runGit(cwd: string, args: string[]): Promise<GitCommandResult>;
  runGitOrThrow(cwd: string, args: string[], failure: string): Promise<GitCommandResult>;
  publisher: ReturnType<typeof createIntegratePublisher>;
  checkouts: ReturnType<typeof createIntegrateCheckouts>;
  readDetails(checkout: string): Promise<IntegrateConflictDetails>;
  normalizePath<Value>(value: Value, fieldName: string): string;
}

const NO_DETAILS: IntegrateConflictDetails = { statusPorcelain: '', unmergedFiles: [], diff: '', currentPatchMeta: '', currentPatch: '' };

const LOCK_FILE = 'openchamber-integrate.lock';

const stdoutText = (result: GitCommandResult) => String(result.stdout || '').trim();
const stderrText = (result: GitCommandResult) => String(result.stderr || result.message || '').trim();

export const normalizeIntegrateBranch = <Value>(value: Value, fieldName: string) => {
  const branch = String(value || '').trim();
  if (!branch) {
    throw new Error(`${fieldName} is required`);
  }
  if (branch.startsWith('-') || branch.includes('\0')) {
    throw new Error(`Invalid ${fieldName}`);
  }
  return branch;
};

const normalizeIntegrateSha = <Value>(value: Value) => {
  const sha = String(value || '').trim();
  if (!/^[0-9a-fA-F]{4,64}$/.test(sha)) {
    throw new Error('Invalid commit SHA');
  }
  return sha;
};

const toState = ({ path: tempWorktreePath, record }: IntegrateCheckout) => ({
  repoRoot: record.repoRoot,
  tempWorktreePath,
  revision: record.revision,
  sourceBranch: record.sourceBranch,
  targetBranch: record.targetBranch,
  targetSha: record.targetSha,
  pickBase: record.pickBase,
  commits: record.commits,
  skippedCommits: record.skippedCommits,
  remainingCommits: record.remainingCommits,
  currentCommit: record.currentCommit,
  finish: record.finish,
});

export const createIntegration = ({ runGit, runGitOrThrow, publisher, checkouts, readDetails, normalizePath }: IntegrationDependencies) => {
  const missedReads = new Map<string, Set<string> | null>();

  const rememberOffline = (key: string, entries: IntegrateCheckout[]) => {
    const offline = new Set(entries.flatMap((entry) => (entry.unreachable ? [entry.path] : [])));
    if (offline.size > 0) missedReads.set(key, offline);
    else missedReads.delete(key);
    return offline;
  };

  const normalizePlan = (plan: IntegratePlanInput) => ({
    repoRoot: normalizePath(plan.repoRoot, 'repoRoot'),
    sourceBranch: normalizeIntegrateBranch(plan.sourceBranch, 'sourceBranch'),
    targetBranch: normalizeIntegrateBranch(plan.targetBranch, 'targetBranch'),
    commits: Array.isArray(plan.commits) ? plan.commits.map(normalizeIntegrateSha) : [],
  });

  const readUnmerged = async (directory: string) =>
    stdoutText(await runGit(directory, ['diff', '--name-only', '--diff-filter=U'])).split('\n').filter(Boolean);

  const toConflict = async (entry: IntegrateCheckout, reason?: ConflictReason) => ({
    kind: 'conflict' as const,
    state: toState(entry),
    details: entry.unreachable ? NO_DETAILS : await readDetails(entry.path),
    message: entry.unreachable ?? entry.record.message,
    reason,
  });

  const exclusively = async <Result>(repoRoot: string, operation: () => Promise<Result>) => {
    const lock = path.join(await checkouts.readCommonDirectory(repoRoot), LOCK_FILE);
    try {
      return await withSourceControlFileLock(lock, operation);
    } catch (error) {
      if (hasSourceControlErrorCode(error) && error.code === 'SOURCE_CONTROL_LOCK_BUSY') return { kind: 'busy' as const };
      throw error;
    }
  };

  const onCurrentConflict = async <Result>(
    input: IntegrateStateInput,
    operation: (entry: IntegrateCheckout) => Promise<Result>,
  ) => {
    const repoRoot = normalizePath(input.repoRoot, 'repoRoot');
    const checkout = normalizePath(input.tempWorktreePath, 'tempWorktreePath');
    return exclusively(repoRoot, async () => {
      const entry = await checkouts.findConflict(repoRoot, checkout);
      if (!entry) return { kind: 'gone' as const };
      if (entry.unreachable) throw directoryUnreachableError(entry.path);
      if (input.revision !== entry.record.revision) return toConflict(entry, 'changed');
      return operation(entry);
    });
  };

  const run = async (plan: ReturnType<typeof normalizePlan>) => {
    const open = (await checkouts.listConflicts(plan.repoRoot))
      .find(({ record }) => record.sourceBranch === plan.sourceBranch && record.targetBranch === plan.targetBranch);
    if (open) return toConflict(open, 'alreadyOpen');

    await publisher.findBranchCheckout(plan.repoRoot, plan.targetBranch);
    const targetSha = await publisher.readBranchTip(plan.repoRoot, plan.targetBranch);
    const tmpDir = await checkouts.create(plan.repoRoot, targetSha);
    try {
      await publisher.fastForwardToUpstream(tmpDir, plan.targetBranch);
      const pickBase = await publisher.readHead(tmpDir);
      if (stdoutText(await runGit(tmpDir, ['status', '--porcelain']))) {
        throw new Error('Target branch has local changes; abort integration and retry');
      }

      const remaining = [...plan.commits];
      while (remaining.length > 0) {
        const sha = remaining[0] ?? '';
        const pick = await runGit(tmpDir, ['cherry-pick', sha]);
        if (pick.success) {
          remaining.shift();
          continue;
        }
        if ((await readUnmerged(tmpDir)).length === 0) {
          throw new Error(stderrText(pick) || 'Cherry-pick failed');
        }
        await checkouts.saveConflict(tmpDir, {
          ...plan, targetSha, pickBase, skippedCommits: [], remainingCommits: remaining, currentCommit: sha,
        }, 1);
        const entry = await checkouts.findConflict(plan.repoRoot, tmpDir);
        if (!entry) throw new Error('Failed to record the conflict');
        return toConflict(entry);
      }

      await publisher.publish({ repoRoot: plan.repoRoot, targetBranch: plan.targetBranch, targetSha, tmpDir, result: await publisher.readHead(tmpDir) });
      await checkouts.remove(plan.repoRoot, tmpDir);
      return { kind: 'success' as const, moved: plan.commits.length };
    } catch (error) {
      await checkouts.remove(plan.repoRoot, tmpDir);
      throw error;
    }
  };

  const resolveDestination = async (repoRoot: string, relativeDirectory: string) => {
    await assertRepositoryReachable(repoRoot);
    const registered = await listIntegrateProjects();
    const exact = registered.find((project) => path.resolve(project) === path.resolve(repoRoot));
    if (exact) return exact;
    const commonDirectory = await checkouts.readCommonDirectory(repoRoot);
    const root = await realpathOf(repoRoot);
    const recorded = [root, path.resolve(repoRoot), ...await listRecordedWorktrees(commonDirectory)];
    const projects: Array<{ project: string; real: string; offline: boolean }> = [];
    for (const project of registered) {
      const reachability = await directoryReachability.check(project);
      const folder = path.resolve(project);
      if (reachability === 'unreachable' && recorded.some((checkout) => isInside(checkout, folder))) {
        projects.push({ project, real: folder, offline: true });
      }
      if (reachability === 'available' && await belongsToRepository(project, commonDirectory)) {
        projects.push({ project, real: await realpathOf(project), offline: false });
      }
    }
    const folders = [path.join(root, relativeDirectory), path.resolve(repoRoot, relativeDirectory)];
    const found = projects.find(({ real }) => real === root)
      ?? projects.filter(({ real }) => folders.some((folder) => isInside(real, folder))).sort((left, right) => right.real.length - left.real.length)[0]
      ?? projects[0];
    if (found?.offline) throw directoryUnreachableError(found.project);
    return found?.project ?? repoRoot;
  };

  const unanswered = async (directory: string, result: GitCommandResult) => {
    await assertRepositoryReachable(directory);
    throw new Error(stderrText(result) || 'Git did not answer');
  };

  const isInTarget = async (directory: string, commit: string, targetBranch: string) => {
    const result = await runGit(directory, ['merge-base', '--is-ancestor', commit, `refs/heads/${targetBranch}`]);
    if (result.success || result.exitCode === 1) return result.success;
    const branch = await runGit(directory, ['show-ref', '--verify', '--quiet', `refs/heads/${targetBranch}`]);
    if (branch.exitCode !== 1) return unanswered(directory, result);
    await assertRepositoryReachable(directory);
    return false;
  };

  const isPublished = async (tmpDir: string, targetBranch: string) => {
    const status = await runGit(tmpDir, ['status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none']);
    if (!status.success) return unanswered(tmpDir, status);
    return !stdoutText(status) && await isInTarget(tmpDir, 'HEAD', targetBranch);
  };

  const sweepLater = (repoRoot: string, moveOut: () => Promise<IntegrateSessionsMove>) => {
    void (async () => {
      for (let attempt = 1; ; attempt += 1) {
        await delay(Math.min(RESUME_DELAY_MS * attempt, RESUME_DELAY_MAX_MS), undefined, { ref: false });
        const left = await moveOut().catch(() => null);
        if (left?.remaining === 0 || await directoryReachability.check(repoRoot) === 'missing') return;
      }
    })();
  };

  const leave = async (entry: IntegrateCheckout, outcome: 'aborted' | 'published', moved: number) => {
    const { path: tmpDir, record } = entry;
    const roots = [...new Set([tmpDir, await realpathOf(tmpDir).catch(() => tmpDir)])];
    const moveOut = (present: readonly string[]) => moveSessionsOut(
      roots,
      (relative) => resolveDestination(record.repoRoot, relative),
      async () => {
        for (const directory of present) await assertRepositoryReachable(directory);
      },
    );
    const held = (error?: Error): IntegrateSessionsMove => {
      if (hasSourceControlErrorCode(error) && error.code === DIRECTORY_UNREACHABLE) throw error;
      console.warn(`Sessions are still in the temporary checkout ${tmpDir}:`, error?.message ?? 'they did not stop or move in time');
      return { moved: 0, remaining: 1, destination: null };
    };
    const left = await moveOut([tmpDir, record.repoRoot]).catch(held);
    if (left.remaining > 0) return toConflict(entry, 'sessionsHeld');
    if (outcome === 'aborted') await runGit(tmpDir, ['cherry-pick', '--abort']);
    const removed = outcome === 'published' && !await isPublished(tmpDir, record.targetBranch)
      ? await checkouts.release(record.repoRoot, tmpDir)
      : await checkouts.remove(record.repoRoot, tmpDir);
    if (!removed && await checkouts.findConflict(record.repoRoot, tmpDir)) throw directoryUnreachableError(record.repoRoot);
    const sweep = () => moveOut([record.repoRoot]);
    const late = removed ? await sweep().catch((): IntegrateSessionsMove => ({ moved: 0, remaining: 1, destination: null })) : left;
    if (late.remaining > 0) sweepLater(record.repoRoot, sweep);
    return {
      success: true,
      kind: outcome === 'published' ? 'success' as const : removed ? 'aborted' as const : 'kept' as const,
      moved,
      kept: !removed,
      sessionsMoved: removed ? left.moved + late.moved : left.moved,
      sessionsDirectory: left.destination ?? late.destination,
    };
  };

  const finish = async ({ path: tmpDir, record }: IntegrateCheckout, outcome: 'aborted' | 'publishing' | 'published', moved: number, result?: string) => {
    const { version, phase, revision, ...fields } = record;
    const finishing = { ...fields, message: undefined, finish: { outcome, moved, result } };
    await checkouts.saveConflict(tmpDir, finishing, revision + 1);
    return { path: tmpDir, record: { version, phase, revision: revision + 1, ...finishing } };
  };

  const leaveOrRetry = async (entry: IntegrateCheckout, outcome: 'aborted' | 'published', moved: number) => {
    let left = false;
    try {
      const result = await leave(entry, outcome, moved);
      left = result.kind !== 'conflict';
      return result;
    } finally {
      if (!left) resumeFinishing(entry.record.repoRoot);
    }
  };

  const settle = async (entry: IntegrateCheckout, { outcome, moved, result }: NonNullable<IntegrateCheckout['record']['finish']>) => {
    if (outcome !== 'publishing') return leaveOrRetry(entry, outcome, moved);
    const { repoRoot, targetBranch } = entry.record;
    if (result && await isInTarget(repoRoot, result, targetBranch)) {
      return leaveOrRetry(await finish(entry, 'published', moved), 'published', moved);
    }
    const { version, phase, revision, finish: _finish, ...fields } = entry.record;
    await checkouts.saveConflict(entry.path, fields, revision + 1);
    return toConflict({ path: entry.path, record: { version, phase, revision: revision + 1, ...fields } }, 'changed');
  };

  const mayHoldRepository = async (directory: string) => {
    try {
      await assertRepositoryReachable(directory);
      return (await runGit(directory, ['rev-parse', '--git-dir'])).success;
    } catch {
      return true;
    }
  };

  const resuming = new Set<string>();
  const resumeFinishing = (directory: string) => {
    void (async () => {
      const key = path.resolve(directory);
      if (resuming.has(key)) return;
      resuming.add(key);
      try {
        for (let attempt = 0; ; attempt += 1) {
          if (attempt > 0) await delay(Math.min(RESUME_DELAY_MS * attempt, RESUME_DELAY_MAX_MS), undefined, { ref: false });
          const listed = await checkouts.listConflicts(directory).catch(() => null);
          if (!listed) {
            if (await directoryReachability.check(directory) === 'missing' || !await mayHoldRepository(directory)) return;
            continue;
          }
          const pending = listed.filter(({ record }) => record.finish);
          if (pending.length === 0) return;
          for (const { path: checkout, unreachable } of pending) {
            if (unreachable) continue;
            await exclusively(directory, async () => {
              const entry = await checkouts.findConflict(directory, checkout);
              const finishing = entry?.record.finish;
              if (entry && !entry.unreachable && finishing) await settle(entry, finishing);
            }).catch((error) => {
              console.warn(`Failed to finish the integration in ${checkout}:`, error instanceof Error ? error.message : error);
            });
          }
        }
      } finally {
        resuming.delete(key);
      }
    })().catch((error) => {
      console.warn('Failed to finish an integration:', error instanceof Error ? error.message : error);
    });
  };

  const abort = async (entry: IntegrateCheckout) => {
    const { record } = entry;
    if (record.finish) return settle(entry, record.finish);
    return leaveOrRetry(await finish(entry, 'aborted', 0), 'aborted', 0);
  };

  const resume = async (entry: IntegrateCheckout) => {
    const { path: tmpDir, record } = entry;
    if (record.finish) return settle(entry, record.finish);
    let current = entry;
    const { repoRoot, sourceBranch, targetBranch, targetSha, pickBase, commits } = record;
    const skippedCommits = [...record.skippedCommits];
    const readCherryPickHead = async () =>
      stdoutText(await runGit(tmpDir, ['rev-parse', '--verify', '--quiet', 'CHERRY_PICK_HEAD']));
    const stop = async (remainingCommits: string[], message?: string) => {
      const fields: IntegrateConflictFields = {
        repoRoot, sourceBranch, targetBranch, targetSha, pickBase, commits, skippedCommits, remainingCommits, message,
        currentCommit: await readCherryPickHead() || record.currentCommit,
      };
      const revision = current.record.revision + 1;
      await checkouts.saveConflict(tmpDir, fields, revision);
      return toConflict({ path: tmpDir, record: { version: 1, phase: 'conflict', revision, ...fields } });
    };
    const stopOnFailedPick = async (remainingCommits: string[], failed: GitCommandResult, message?: string) => {
      return stop(remainingCommits, (await readUnmerged(tmpDir)).length > 0 ? message : stderrText(failed) || 'Cherry-pick failed');
    };
    const pickOrSkipEmpty = async (args: string[]) => {
      const pick = await runGit(tmpDir, ['cherry-pick', ...args]);
      const picking = pick.success ? '' : await readCherryPickHead();
      if (!picking) {
        return pick;
      }
      const status = await runGit(tmpDir, ['status', '--porcelain']);
      if (!status.success || stdoutText(status)) {
        return pick;
      }
      const skip = await runGit(tmpDir, ['cherry-pick', '--skip']);
      if (skip.success) {
        skippedCommits.push(picking);
      }
      return skip;
    };

    if (await readCherryPickHead()) {
      const cont = await pickOrSkipEmpty(['--continue']);
      if (!cont.success) {
        return stopOnFailedPick(record.remainingCommits, cont);
      }
    }

    let remaining: string[] = [];
    try {
      remaining = await findUnpickedCommits(runGit, {
        directory: tmpDir,
        base: pickBase,
        commits: commits.filter((sha) => !skippedCommits.includes(sha)),
      });
      while (remaining.length > 0) {
        const sha = remaining[0] ?? '';
        const pick = await pickOrSkipEmpty([sha]);
        if (!pick.success) {
          return stopOnFailedPick(remaining, pick, commits.indexOf(sha) <= commits.indexOf(record.currentCommit)
            ? `Commit ${sha.slice(0, 7)} was aborted or skipped outside OpenChamber and is missing from the result, so it was picked again. Resolve it and continue. To leave it out, resolve to the version ${targetBranch} already has.`
            : undefined);
        }
        remaining.shift();
      }

      const status = await runGitOrThrow(tmpDir, ['status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none'], 'Failed to read the temporary checkout');
      if (stdoutText(status)) {
        throw new Error(`The temporary checkout at ${tmpDir} has uncommitted changes. Commit or remove them, then continue.`);
      }
      const result = await publisher.readHead(tmpDir);
      if (await publisher.readBranchTip(repoRoot, targetBranch) !== result) {
        current = await finish(entry, 'publishing', commits.length - skippedCommits.length, result);
        await publisher.publish({ repoRoot, targetBranch, targetSha, tmpDir, result });
      }
    } catch (error) {
      const result = current.record.finish?.result;
      const published = result !== undefined && await isInTarget(repoRoot, result, targetBranch).catch((failure) => {
        resumeFinishing(repoRoot);
        throw failure;
      });
      if (!published) return stop(remaining, error instanceof Error ? error.message : String(error));
    }

    const moved = commits.length - skippedCommits.length;
    return leaveOrRetry(await finish(current, 'published', moved), 'published', moved);
  };

  onIntegrateSessionsReady(resumeFinishing);

  return {
    integrateWorktreeCommits: async (input: IntegratePlanInput = {}) => {
      const plan = normalizePlan(input);
      if (plan.commits.length === 0) return { kind: 'noop' as const, reason: 'No commits to move' };
      return exclusively(plan.repoRoot, () => run(plan));
    },
    abortIntegrate: (input: IntegrateStateInput = {}) => onCurrentConflict(input, abort),
    continueIntegrate: (input: IntegrateStateInput = {}) => onCurrentConflict(input, resume),
    resumeFinishing,
    listIntegrateConflicts: async <Value>(directory: Value) => {
      const target = normalizePath(directory, 'directory');
      const key = path.resolve(target);
      const entries = await checkouts.listConflicts(target).catch((error) => {
        missedReads.set(key, null);
        throw error;
      });
      rememberOffline(key, entries);
      if (entries.some(({ record }) => record.finish)) resumeFinishing(target);
      return Promise.all(entries.map((entry) => toConflict(entry)));
    },
    takeMissedRead: async (directory: string) => {
      const key = path.resolve(directory);
      if (!missedReads.has(key)) return false;
      const entries = await checkouts.listConflicts(directory).catch(() => null);
      const before = missedReads.get(key);
      if (!entries || before === undefined) return false;
      const offline = rememberOffline(key, entries);
      return before === null || [...before].some((checkout) => !offline.has(checkout));
    },
  };
};
