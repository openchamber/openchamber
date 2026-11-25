import path from 'node:path';
import { withSourceControlFileLock } from '../source-control/file-lock.js';
import { hasSourceControlErrorCode } from '../source-control/input-guards.js';
import type { createIntegrateCheckouts, IntegrateCheckout, IntegrateConflictFields } from './integrate-checkouts.js';
import { directoryUnreachableError } from '../directory-reachability/index.js';
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

type ConflictReason = 'changed' | 'alreadyOpen';

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

      await publisher.publish({ repoRoot: plan.repoRoot, targetBranch: plan.targetBranch, targetSha, tmpDir });
      await checkouts.remove(plan.repoRoot, tmpDir);
      return { kind: 'success' as const, moved: plan.commits.length };
    } catch (error) {
      await checkouts.remove(plan.repoRoot, tmpDir);
      throw error;
    }
  };

  const abort = async ({ path: tmpDir, record }: IntegrateCheckout) => {
    await runGit(tmpDir, ['cherry-pick', '--abort']);
    const removed = await checkouts.remove(record.repoRoot, tmpDir);
    if (!removed && await checkouts.findConflict(record.repoRoot, tmpDir)) throw directoryUnreachableError(record.repoRoot);
    return { success: true, kind: removed ? 'aborted' as const : 'kept' as const };
  };

  const resume = async ({ path: tmpDir, record }: IntegrateCheckout) => {
    const { repoRoot, sourceBranch, targetBranch, targetSha, pickBase, commits } = record;
    const skippedCommits = [...record.skippedCommits];
    const readCherryPickHead = async () =>
      stdoutText(await runGit(tmpDir, ['rev-parse', '--verify', '--quiet', 'CHERRY_PICK_HEAD']));
    const stop = async (remainingCommits: string[], message?: string) => {
      const fields: IntegrateConflictFields = {
        repoRoot, sourceBranch, targetBranch, targetSha, pickBase, commits, skippedCommits, remainingCommits, message,
        currentCommit: await readCherryPickHead() || record.currentCommit,
      };
      await checkouts.saveConflict(tmpDir, fields, record.revision + 1);
      return toConflict({ path: tmpDir, record: { version: 1, phase: 'conflict', revision: record.revision + 1, ...fields } });
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
      await publisher.publish({ repoRoot, targetBranch, targetSha, tmpDir });
    } catch (error) {
      return stop(remaining, error instanceof Error ? error.message : String(error));
    }

    const removed = await checkouts.remove(repoRoot, tmpDir);
    return { kind: 'success' as const, moved: commits.length - skippedCommits.length, kept: !removed };
  };

  return {
    integrateWorktreeCommits: async (input: IntegratePlanInput = {}) => {
      const plan = normalizePlan(input);
      if (plan.commits.length === 0) return { kind: 'noop' as const, reason: 'No commits to move' };
      return exclusively(plan.repoRoot, () => run(plan));
    },
    abortIntegrate: (input: IntegrateStateInput = {}) => onCurrentConflict(input, abort),
    continueIntegrate: (input: IntegrateStateInput = {}) => onCurrentConflict(input, resume),
    listIntegrateConflicts: async <Value>(directory: Value) => {
      const target = normalizePath(directory, 'directory');
      const key = path.resolve(target);
      const entries = await checkouts.listConflicts(target).catch((error) => {
        missedReads.set(key, null);
        throw error;
      });
      rememberOffline(key, entries);
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
