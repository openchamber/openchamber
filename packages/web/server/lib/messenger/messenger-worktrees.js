/**
 * Git worktree support for the Discord ↔ OpenCode bridge.
 *
 * Implements the `/new-worktree` + `/merge-worktree` commands:
 *   - `/new-worktree [name]` creates an isolated git worktree (re-using
 *     OpenChamber's worktree service, so worktrees show up in the web UI
 *     too) and binds the conversation to a session running inside it.
 *   - `/merge-worktree` squashes the worktree's commits into a single
 *     commit and lands it on the default branch (worktrunk-style:
 *     squash → rebase onto origin/<default> → push). Without a remote it
 *     falls back to a local squash-merge through the primary worktree.
 */

import { spawn } from 'node:child_process';
import { createWorktree } from '../git/service.js';

const GIT_TIMEOUT_MS = 60_000;

function runGit(cwd, args, { timeoutMs = GIT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on('data', (d) => { stdout += String(d); });
    child.stderr.on('data', (d) => { stderr += String(d); });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, code: -1, stdout, stderr: stderr || (err?.message ?? 'spawn failed') });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

/** Worktree name sanitization: lowercase, hyphens, no specials. */
export function sanitizeWorktreeName(raw) {
  const cleaned = String(raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]+/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return cleaned;
}

/**
 * Create a worktree for a project via OpenChamber's git service.
 * Returns { ok, path, branch, name } or { ok: false, error }.
 */
export async function createBridgeWorktree({ projectPath, name }) {
  const sanitized = sanitizeWorktreeName(name);
  if (!sanitized) {
    return { ok: false, error: 'Invalid worktree name. Please use letters, numbers, and spaces.' };
  }
  try {
    const result = await createWorktree(projectPath, {
      mode: 'new',
      worktreeName: sanitized,
      branchName: sanitized,
    });
    if (!result?.path) {
      return { ok: false, error: 'Worktree creation returned no path' };
    }
    return { ok: true, path: result.path, branch: result.branch ?? sanitized, name: result.name ?? sanitized };
  } catch (err) {
    return { ok: false, error: err?.message ?? 'worktree creation failed' };
  }
}

export async function listBridgeWorktrees({ projectPath }) {
  if (!projectPath) return { ok: false, error: 'no project bound to this conversation.' };
  const result = await runGit(projectPath, ['worktree', 'list', '--porcelain']);
  if (!result.ok) {
    return { ok: false, error: `git worktree list failed: ${result.stderr || result.stdout}` };
  }
  const entries = [];
  let current = null;
  for (const line of result.stdout.split('\n')) {
    if (!line.trim()) {
      if (current) entries.push(current);
      current = null;
      continue;
    }
    const space = line.indexOf(' ');
    const key = space >= 0 ? line.slice(0, space) : line;
    const value = space >= 0 ? line.slice(space + 1) : '';
    if (key === 'worktree') {
      if (current) entries.push(current);
      current = { path: value, branch: null, commit: null, detached: false, bare: false };
    } else if (current && key === 'branch') {
      current.branch = value.replace(/^refs\/heads\//, '');
    } else if (current && key === 'HEAD') {
      current.commit = value;
    } else if (current && key === 'detached') {
      current.detached = true;
    } else if (current && key === 'bare') {
      current.bare = true;
    }
  }
  if (current) entries.push(current);
  return { ok: true, worktrees: entries };
}

async function resolveDefaultBranch(worktreeDir) {
  // Preferred: the remote's HEAD pointer (origin/main etc.).
  const remoteHead = await runGit(worktreeDir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (remoteHead.ok && remoteHead.stdout.includes('/')) {
    const [remote, ...rest] = remoteHead.stdout.split('/');
    return { remote, branch: rest.join('/') };
  }
  // Fall back to common local default branches.
  for (const candidate of ['main', 'master']) {
    const exists = await runGit(worktreeDir, ['show-ref', '--verify', `refs/heads/${candidate}`]);
    if (exists.ok) {
      const hasOrigin = await runGit(worktreeDir, ['remote', 'get-url', 'origin']);
      return { remote: hasOrigin.ok ? 'origin' : null, branch: candidate };
    }
  }
  return null;
}

/**
 * Squash-merge the worktree's branch into the default branch.
 *
 * Returns:
 *   { ok: true, summary }                       — merged + pushed/landed
 *   { ok: false, conflict: true, error }        — rebase conflict; the caller
 *                                                 should hand resolution to the AI
 *   { ok: false, error }                        — hard failure
 */
export async function mergeBridgeWorktree({ worktreeDir }) {
  // 1. Refuse to merge with uncommitted changes.
  const status = await runGit(worktreeDir, ['status', '--porcelain']);
  if (!status.ok) {
    return { ok: false, error: `git status failed: ${status.stderr || status.stdout}` };
  }
  if (status.stdout.length > 0) {
    return {
      ok: false,
      error: 'uncommitted changes in the worktree. Commit changes first, then run `/merge-worktree` again.',
    };
  }

  // Detect an in-progress rebase from a previous conflicted merge attempt.
  const rebaseInProgress = await runGit(worktreeDir, ['rev-parse', '--git-path', 'rebase-merge']);
  if (rebaseInProgress.ok) {
    const checkDir = await runGit(worktreeDir, ['rev-parse', '--verify', 'REBASE_HEAD']);
    if (checkDir.ok) {
      return {
        ok: false,
        conflict: true,
        error: 'a rebase is still in progress in this worktree — finish it with `git rebase --continue` first.',
      };
    }
  }

  const branchRes = await runGit(worktreeDir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!branchRes.ok || !branchRes.stdout || branchRes.stdout === 'HEAD') {
    return { ok: false, error: 'worktree is at a detached HEAD — nothing to merge.' };
  }
  const branch = branchRes.stdout;

  const def = await resolveDefaultBranch(worktreeDir);
  if (!def) {
    return { ok: false, error: 'could not determine the default branch (no origin/HEAD, main or master).' };
  }

  if (def.remote) {
    // worktrunk-style: fetch → squash onto remote default → rebase → push.
    const fetch = await runGit(worktreeDir, ['fetch', def.remote, def.branch]);
    if (!fetch.ok) {
      return { ok: false, error: `git fetch failed: ${fetch.stderr || fetch.stdout}` };
    }
    const baseRef = `${def.remote}/${def.branch}`;

    const count = await runGit(worktreeDir, ['rev-list', '--count', `${baseRef}..HEAD`]);
    const commitCount = Number(count.stdout) || 0;
    if (count.ok && commitCount === 0) {
      return { ok: false, error: `no commits to merge — \`${branch}\` has nothing on top of \`${baseRef}\`.` };
    }

    const reset = await runGit(worktreeDir, ['reset', '--soft', baseRef]);
    if (!reset.ok) {
      return { ok: false, error: `git reset --soft failed: ${reset.stderr || reset.stdout}` };
    }
    const staged = await runGit(worktreeDir, ['diff', '--cached', '--quiet']);
    if (staged.ok) {
      // Nothing staged after the soft reset — branch content matches base.
      return { ok: false, error: `nothing to merge — \`${branch}\` matches \`${baseRef}\` content.` };
    }
    const commit = await runGit(worktreeDir, ['commit', '-m', `[${branch}] squashed ${commitCount} commit${commitCount === 1 ? '' : 's'}`]);
    if (!commit.ok) {
      return { ok: false, error: `git commit failed: ${commit.stderr || commit.stdout}` };
    }
    const rebase = await runGit(worktreeDir, ['rebase', baseRef]);
    if (!rebase.ok) {
      return {
        ok: false,
        conflict: true,
        error: `rebase onto ${baseRef} hit conflicts:\n${(rebase.stderr || rebase.stdout).slice(0, 500)}`,
      };
    }
    const push = await runGit(worktreeDir, ['push', def.remote, `HEAD:${def.branch}`]);
    if (!push.ok) {
      return { ok: false, error: `git push failed: ${(push.stderr || push.stdout).slice(0, 500)}` };
    }
    const sha = await runGit(worktreeDir, ['rev-parse', '--short', 'HEAD']);
    return {
      ok: true,
      summary: `Merged \`${branch}\` into \`${def.branch}\` @ ${sha.stdout || 'HEAD'} (${commitCount} commit${commitCount === 1 ? '' : 's'} squashed, pushed to ${def.remote}).`,
    };
  }

  // No remote — local squash-merge through the primary worktree.
  const commonDir = await runGit(worktreeDir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!commonDir.ok) {
    return { ok: false, error: 'could not locate the primary repository for a local merge.' };
  }
  const primaryDir = commonDir.stdout.replace(/[\\/]\.git$/, '');

  const primaryStatus = await runGit(primaryDir, ['status', '--porcelain']);
  if (!primaryStatus.ok || primaryStatus.stdout.length > 0) {
    return {
      ok: false,
      error: 'the primary worktree has uncommitted changes — commit or stash them before a local merge.',
    };
  }
  const primaryBranch = await runGit(primaryDir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!primaryBranch.ok || primaryBranch.stdout !== def.branch) {
    return {
      ok: false,
      error: `the primary worktree is on \`${primaryBranch.stdout}\`, not \`${def.branch}\` — check out the default branch there first.`,
    };
  }
  const count = await runGit(worktreeDir, ['rev-list', '--count', `${def.branch}..HEAD`]);
  const commitCount = Number(count.stdout) || 0;
  if (commitCount === 0) {
    return { ok: false, error: `no commits to merge — \`${branch}\` has nothing on top of \`${def.branch}\`.` };
  }
  const merge = await runGit(primaryDir, ['merge', '--squash', branch]);
  if (!merge.ok) {
    await runGit(primaryDir, ['merge', '--abort']);
    await runGit(primaryDir, ['reset', '--merge']);
    return {
      ok: false,
      conflict: true,
      error: `local squash-merge hit conflicts:\n${(merge.stderr || merge.stdout).slice(0, 500)}`,
    };
  }
  const staged = await runGit(primaryDir, ['diff', '--cached', '--quiet']);
  if (staged.ok) {
    return { ok: false, error: `nothing to merge — \`${branch}\`'s content is already on \`${def.branch}\`.` };
  }
  const commit = await runGit(primaryDir, ['commit', '-m', `[${branch}] squashed ${commitCount} commit${commitCount === 1 ? '' : 's'}`]);
  if (!commit.ok) {
    return { ok: false, error: `git commit failed in the primary worktree: ${commit.stderr || commit.stdout}` };
  }
  const sha = await runGit(primaryDir, ['rev-parse', '--short', 'HEAD']);
  return {
    ok: true,
    summary: `Merged \`${branch}\` into \`${def.branch}\` @ ${sha.stdout || 'HEAD'} (${commitCount} commit${commitCount === 1 ? '' : 's'} squashed, local merge).`,
  };
}

/** Conflict-resolution prompt, sent to the session when a merge conflicts. */
export const MERGE_CONFLICT_PROMPT = [
  'A rebase conflict occurred while merging this worktree into the default branch.',
  'Please resolve the rebase conflicts:',
  '1. Check `git status` to see which files have conflicts',
  '2. Edit the conflicted files to resolve the merge markers',
  '3. Stage resolved files with `git add`',
  '4. Continue the rebase with `git rebase --continue`',
  '5. After the rebase completes successfully, tell me so I can run `/merge-worktree` again',
].join('\n');
