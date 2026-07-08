/**
 * Reproduction for issue #2098:
 * New Worktree dialog does not show newly fetched remote branches.
 *
 * Root cause: `getBranches` in service.js calls `git.branch()` which only
 * returns local refs (including `remotes/<remote>/<branch>` tracking refs),
 * then `filterActiveRemoteBranches` performs `ls-remote` on each remote but
 * returns only the **intersection** with local remote-tracking refs.
 *
 * A branch that exists on the remote but has never been `git fetch`ed (so
 * there is no local `remotes/origin/<branch>` ref) is silently dropped by
 * the intersection filter.
 *
 * This test demonstrates the bug and verifies the fix.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { getBranches } from './service.js';

// ---------------------------------------------------------------------------
// Test infrastructure (same pattern as service.test.js)
// ---------------------------------------------------------------------------

const tempDirs = [];

const createTempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-repro-2098-'));
  tempDirs.push(dir);
  return dir;
};

const runGit = (cwd, args) => {
  const result = execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return result.trim();
};

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

// ---------------------------------------------------------------------------
// Actual reproduction
// ---------------------------------------------------------------------------

describe('Issue #2098 – getBranches drops remote-only branches', () => {
  it('should include remote-only branches that have no local tracking ref (BUG DEMO)', async () => {
    // Only run if git is available
    if (!canRunGit()) {
      console.warn('Skipping: git not available');
      return;
    }

    // ── Setup ──────────────────────────────────────────────────────
    // 1. Create a bare repo (simulates GitHub/remote)
    const bareDir = createTempDir();
    runGit(bareDir, ['init', '--bare']);

    // 2. Create a local repo with remote pointing to bareDir
    const localDir = createTempDir();
    runGit(localDir, ['init', '--initial-branch=main']);
    runGit(localDir, ['config', 'user.email', 'test@example.com']);
    runGit(localDir, ['config', 'user.name', 'Test User']);

    // Add remote
    runGit(localDir, ['remote', 'add', 'origin', bareDir]);

    console.log('Initial branch:', runGit(localDir, ['branch', '--show-current']));

    // Create initial commit on main
    fs.writeFileSync(path.join(localDir, 'README.md'), '# test\n');
    runGit(localDir, ['add', '.']);
    runGit(localDir, ['commit', '-m', 'initial commit']);

    // Verify branch exists
    console.log('Branch after commit:', runGit(localDir, ['branch', '--show-current']));

    // Push main to origin (set upstream so tracking ref is created)
    runGit(localDir, ['push', '-u', 'origin', 'main']);

    // 3. Create and push a branch that WILL have a local tracking ref
    runGit(localDir, ['checkout', '-b', 'feature-known']);
    fs.writeFileSync(path.join(localDir, 'feature-known.txt'), 'known\n');
    runGit(localDir, ['add', '.']);
    runGit(localDir, ['commit', '-m', 'feature known']);
    runGit(localDir, ['push', '-u', 'origin', 'feature-known']);

    // 4. Now simulate a NEW branch pushed by another user directly to the bare repo.
    //    Use a helper clone so we don't touch the local repo.
    const helperDir = createTempDir();
    runGit(helperDir, ['clone', bareDir, '.']);
    runGit(helperDir, ['config', 'user.email', 'helper@example.com']);
    runGit(helperDir, ['config', 'user.name', 'Helper']);
    runGit(helperDir, ['checkout', '-b', 'feature-remote-only']);
    fs.writeFileSync(path.join(helperDir, 'remote-only.txt'), 'remote only\n');
    runGit(helperDir, ['add', '.']);
    runGit(helperDir, ['commit', '-m', 'remote only branch']);
    runGit(helperDir, ['push', 'origin', 'feature-remote-only']);

    // Verify: the local repo does NOT have a tracking ref for feature-remote-only
    // (since we never fetched the new branch locally)
    const localRemoteRefs = runGit(localDir, ['branch', '-r']).split('\n').map(s => s.trim());
    console.log('Local remote-tracking refs:', localRemoteRefs);
    expect(localRemoteRefs).toContain('origin/feature-known');
    expect(localRemoteRefs).not.toContain('origin/feature-remote-only');

    // Verify the branch IS on the remote via ls-remote
    const lsRemote = runGit(localDir, ['ls-remote', '--heads', 'origin']);
    console.log('Remote heads (ls-remote):', lsRemote);
    expect(lsRemote).toContain('feature-remote-only');

    // ── The Bug ────────────────────────────────────────────────────
    // 5. Call getBranches – this is what the "Fetch branches" button triggers
    const branches = await getBranches(localDir);
    console.log('Branches returned by getBranches():', branches.all);

    // The known branch (which has a local tracking ref) IS included
    expect(branches.all).toContain('remotes/origin/feature-known');

    // THIS IS THE BUG: feature-remote-only exists on the remote (confirmed
    // by ls-remote above) but is NOT in the result because there is no local
    // `remotes/origin/feature-remote-only` tracking ref.
    // The following assertion FAILS with the current code in service.js.
    expect(branches.all).toContain('remotes/origin/feature-remote-only');
  });
});
