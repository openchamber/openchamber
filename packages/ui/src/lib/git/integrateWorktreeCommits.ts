import type { CommandExecResult } from '@/lib/api/types';
import { execCommand } from '@/lib/execCommands';

export type IntegratePlan = {
  repoRoot: string;
  sourceBranch: string;
  targetBranch: string;
  commits: string[];
};

export type IntegrateConflictDetails = {
  statusPorcelain: string;
  unmergedFiles: string[];
  diff: string;
  currentPatchMeta: string;
  currentPatch: string;
};

export type IntegrateInProgress = {
  repoRoot: string;
  tempWorktreePath: string;
  sourceBranch: string;
  targetBranch: string;
  /** Worktrees on target branch that were clean pre-integration; safe to fast-sync after ref update. */
  cleanTargetWorktrees: string[];
  remainingCommits: string[];
  currentCommit: string;
};

export type IntegrateResult =
  | { kind: 'noop'; reason: string }
  | { kind: 'success'; moved: number }
  | { kind: 'conflict'; state: IntegrateInProgress; details: IntegrateConflictDetails };

const shellQuote = (value: string): string => {
  const v = value.trim();
  if (!v) return "''";
  return `'${v.replace(/'/g, `'\\''`)}'`;
};

const trimLines = (value: string | undefined): string[] =>
  (value || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

const isOk = (result: CommandExecResult): boolean => Boolean(result.success);

const stdoutText = (result: CommandExecResult): string => (result.stdout || '').trim();
const stderrText = (result: CommandExecResult): string => (result.stderr || '').trim();

type GitWorktreeEntry = { path: string; branchRef: string | null };

async function listGitWorktrees(repoRoot: string): Promise<GitWorktreeEntry[]> {
  const out = await execCommand('git worktree list --porcelain', repoRoot);
  const lines = (out.stdout || '').split(/\r?\n/);

  const entries: GitWorktreeEntry[] = [];
  let current: GitWorktreeEntry | null = null;

  for (const line of lines) {
    if (line.startsWith('worktree ')) {
      if (current) entries.push(current);
      current = { path: line.slice('worktree '.length).trim(), branchRef: null };
      continue;
    }
    if (!current) continue;
    if (line.startsWith('branch ')) {
      current.branchRef = line.slice('branch '.length).trim();
    }
  }
  if (current) entries.push(current);

  return entries.filter((e) => Boolean(e.path));
}

async function computeCleanWorktreesToSync(args: {
  repoRoot: string;
  targetBranch: string;
  excludePaths: string[];
}): Promise<string[]> {
  const targetRef = `refs/heads/${args.targetBranch}`;
  const exclude = new Set(args.excludePaths);
  const entries = await listGitWorktrees(args.repoRoot);
  const candidates = entries
    .filter((e) => e.branchRef === targetRef)
    .map((e) => e.path)
    .filter((p) => p && !exclude.has(p));

  const clean: string[] = [];
  for (const path of candidates) {
    const status = await execCommand('git status --porcelain', path);
    if (!stdoutText(status)) {
      clean.push(path);
    }
  }
  return clean;
}

async function syncCleanTargetWorktrees(repoRoot: string, paths: string[]): Promise<void> {
  for (const path of paths) {
    await execCommand('git reset --hard', path).catch(() => undefined);
  }
}

async function ensureLocalBranch(repoRoot: string, candidate: string): Promise<string> {
  const raw = candidate.trim();
  if (!raw || raw === 'HEAD') {
    return 'HEAD';
  }

  const hasLocal = await execCommand(
    `git show-ref --verify --quiet ${shellQuote(`refs/heads/${raw}`)}`,
    repoRoot
  );
  if (isOk(hasLocal)) {
    return raw;
  }

  // remotes/origin/main -> main (track origin/main)
  if (raw.startsWith('remotes/')) {
    const remoteRef = raw.slice('remotes/'.length);
    const parts = remoteRef.split('/');
    const remote = parts[0] || 'origin';
    const name = parts.slice(1).join('/');
    if (name) {
      await execCommand(`git branch --track ${shellQuote(name)} ${shellQuote(`${remote}/${name}`)}`, repoRoot);
      return name;
    }
  }

  // Try origin/<raw>
  const remoteCheck = await execCommand(
    `git show-ref --verify --quiet ${shellQuote(`refs/remotes/origin/${raw}`)}`,
    repoRoot
  );
  if (isOk(remoteCheck)) {
    await execCommand(`git branch --track ${shellQuote(raw)} ${shellQuote(`origin/${raw}`)}`, repoRoot);
    return raw;
  }

  return raw;
}

export async function computeIntegratePlan(args: {
  repoRoot: string;
  sourceBranch: string;
  targetBranch: string;
}): Promise<IntegratePlan> {
  const repoRoot = args.repoRoot;
  const sourceBranch = args.sourceBranch.trim();
  const targetBranchRaw = args.targetBranch.trim();
  if (!sourceBranch || !targetBranchRaw) {
    return { repoRoot, sourceBranch, targetBranch: targetBranchRaw, commits: [] };
  }

  const targetBranch = await ensureLocalBranch(repoRoot, targetBranchRaw);

  const cherry = await execCommand(`git cherry ${shellQuote(targetBranch)} ${shellQuote(sourceBranch)}`, repoRoot);
  const cherryLines = trimLines(cherry.stdout);
  const plus = new Set<string>();
  for (const line of cherryLines) {
    const match = line.match(/^\+\s+([0-9a-f]{7,40})\b/i);
    if (match) {
      plus.add(match[1]);
    }
  }

  const revList = await execCommand(
    `git rev-list --reverse ${shellQuote(`${targetBranch}..${sourceBranch}`)}`,
    repoRoot
  );
  const ordered = trimLines(revList.stdout);
  const commits = ordered.filter((sha) => plus.has(sha));

  return { repoRoot, sourceBranch, targetBranch, commits };
}

async function createTempWorktree(repoRoot: string, targetBranch: string): Promise<string> {
  // Use two separate execCommand calls instead of shell-specific && operator
  // to support non-POSIX shells like Nushell (see #870)
  const mkdirResult = await execCommand('mkdir -p "$HOME/.config/openchamber/tmp"', repoRoot);
  if (!isOk(mkdirResult)) {
    throw new Error(stderrText(mkdirResult) || 'Failed to create temp directory parent');
  }
  const tmp = await execCommand(
    'mktemp -d "$HOME/.config/openchamber/tmp/oc-integrate-XXXXXX"',
    repoRoot
  );
  const tmpDir = stdoutText(tmp);
  if (!tmpDir) {
    throw new Error(stderrText(tmp) || 'Failed to create temp directory');
  }
  const add = await execCommand(
    `git worktree add --force ${shellQuote(tmpDir)} ${shellQuote(targetBranch)}`,
    repoRoot
  );
  if (!isOk(add)) {
    throw new Error(stderrText(add) || 'Failed to create temp worktree');
  }
  return tmpDir;
}

async function removeTempWorktree(repoRoot: string, tmpDir: string): Promise<void> {
  await execCommand(`git worktree remove --force ${shellQuote(tmpDir)}`, repoRoot).catch(() => undefined);
  await execCommand('git worktree prune', repoRoot).catch(() => undefined);
}

async function maybeFastForwardUpstream(tmpDir: string): Promise<void> {
  const upstream = await execCommand('git rev-parse --abbrev-ref --symbolic-full-name @{u}', tmpDir);
  const upstreamRef = stdoutText(upstream);
  if (!upstreamRef) {
    return;
  }
  await execCommand('git fetch', tmpDir);
  const ff = await execCommand(`git merge --ff-only ${shellQuote(upstreamRef)}`, tmpDir);
  if (!isOk(ff)) {
    throw new Error(stderrText(ff) || 'Fast-forward failed');
  }
}

async function collectConflictDetails(tmpDir: string): Promise<IntegrateConflictDetails> {
  const status = await execCommand('git status --porcelain', tmpDir);
  const unmerged = await execCommand('git diff --name-only --diff-filter=U', tmpDir);
  const diff = await execCommand('git diff', tmpDir);
  const meta = await execCommand('git show --no-patch --pretty=fuller CHERRY_PICK_HEAD', tmpDir);
  const patch = await execCommand('git show CHERRY_PICK_HEAD', tmpDir);

  return {
    statusPorcelain: status.stdout || '',
    unmergedFiles: trimLines(unmerged.stdout),
    diff: diff.stdout || diff.stderr || '',
    currentPatchMeta: meta.stdout || meta.stderr || '',
    currentPatch: patch.stdout || patch.stderr || '',
  };
}

export async function getIntegrateConflictDetails(tmpDir: string): Promise<IntegrateConflictDetails> {
  return collectConflictDetails(tmpDir);
}

export async function isCherryPickInProgress(tmpDir: string): Promise<boolean> {
  const head = await execCommand('git rev-parse --verify --quiet CHERRY_PICK_HEAD', tmpDir);
  return isOk(head);
}

export async function integrateWorktreeCommits(plan: IntegratePlan): Promise<IntegrateResult> {
  if (plan.commits.length === 0) {
    return { kind: 'noop', reason: 'No commits to move' };
  }

  const tmpDir = await createTempWorktree(plan.repoRoot, plan.targetBranch);

  let remaining: string[] = [];
  try {
    await maybeFastForwardUpstream(tmpDir);

    const clean = await execCommand('git status --porcelain', tmpDir);
    if (stdoutText(clean)) {
      throw new Error('Target branch has local changes; abort integration and retry');
    }

    const cleanTargetWorktrees = await computeCleanWorktreesToSync({
      repoRoot: plan.repoRoot,
      targetBranch: plan.targetBranch,
      excludePaths: [tmpDir],
    }).catch(() => []);

    remaining = [...plan.commits];
    while (remaining.length > 0) {
      const sha = remaining[0];
      const pick = await execCommand(`git cherry-pick ${shellQuote(sha)}`, tmpDir);
      if (isOk(pick)) {
        remaining.shift();
        continue;
      }

      const unmerged = await execCommand('git diff --name-only --diff-filter=U', tmpDir);
      const unmergedFiles = trimLines(unmerged.stdout);
      if (unmergedFiles.length > 0) {
        const details = await collectConflictDetails(tmpDir);
        return {
          kind: 'conflict',
          state: {
            repoRoot: plan.repoRoot,
            tempWorktreePath: tmpDir,
            sourceBranch: plan.sourceBranch,
            targetBranch: plan.targetBranch,
            cleanTargetWorktrees,
            remainingCommits: remaining,
            currentCommit: sha,
          },
          details,
        };
      }

      throw new Error(stderrText(pick) || 'Cherry-pick failed');
    }

    await removeTempWorktree(plan.repoRoot, tmpDir);
    await syncCleanTargetWorktrees(plan.repoRoot, cleanTargetWorktrees).catch(() => undefined);
    return { kind: 'success', moved: plan.commits.length };
  } catch (e) {
    // Cleanup on any non-conflict error.
    await removeTempWorktree(plan.repoRoot, tmpDir).catch(() => undefined);
    throw e;
  }
}

export async function abortIntegrate(state: IntegrateInProgress): Promise<void> {
  await execCommand('git cherry-pick --abort', state.tempWorktreePath).catch(() => undefined);
  await removeTempWorktree(state.repoRoot, state.tempWorktreePath);
}

export async function continueIntegrate(state: IntegrateInProgress): Promise<IntegrateResult> {
  const cont = await execCommand('git cherry-pick --continue', state.tempWorktreePath);
  if (!isOk(cont)) {
    const unmerged = await execCommand('git diff --name-only --diff-filter=U', state.tempWorktreePath);
    const unmergedFiles = trimLines(unmerged.stdout);
    if (unmergedFiles.length > 0) {
      const details = await collectConflictDetails(state.tempWorktreePath);
      return { kind: 'conflict', state, details };
    }
    throw new Error(stderrText(cont) || 'Cherry-pick continue failed');
  }

  const tmpDir = state.tempWorktreePath;
  const remaining = [...state.remainingCommits];
  if (remaining.length > 0 && remaining[0] === state.currentCommit) {
    remaining.shift();
  }

  const still = [...remaining];
  while (still.length > 0) {
    const sha = still[0];
    const pick = await execCommand(`git cherry-pick ${shellQuote(sha)}`, tmpDir);
    if (isOk(pick)) {
      still.shift();
      continue;
    }
    const unmerged = await execCommand('git diff --name-only --diff-filter=U', tmpDir);
    const unmergedFiles = trimLines(unmerged.stdout);
    if (unmergedFiles.length > 0) {
      const details = await collectConflictDetails(tmpDir);
      return {
        kind: 'conflict',
        state: {
          repoRoot: state.repoRoot,
          tempWorktreePath: tmpDir,
          sourceBranch: state.sourceBranch,
          targetBranch: state.targetBranch,
          cleanTargetWorktrees: state.cleanTargetWorktrees,
          remainingCommits: still,
          currentCommit: sha,
        },
        details,
      };
    }
    throw new Error(stderrText(pick) || 'Cherry-pick failed');
  }

  await removeTempWorktree(state.repoRoot, state.tempWorktreePath);
  await syncCleanTargetWorktrees(state.repoRoot, state.cleanTargetWorktrees).catch(() => undefined);
  return { kind: 'success', moved: state.remainingCommits.length };
}
