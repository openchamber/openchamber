import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import simpleGit from 'simple-git';

import { resolveBaseRefForLog, stageFiles, unstageFiles, checkoutCommit, cherryPick, revertCommit, resetToCommit } from './service.js';

async function createTempRepo() {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'git-test-'));
  const git = simpleGit(tmpDir);
  await git.init();
  await git.addConfig('user.name', 'Test User', false, 'local');
  await git.addConfig('user.email', 'test@example.com', false, 'local');
  // Force HEAD to refs/heads/main so every test starts on a deterministic branch
  await git.raw(['symbolic-ref', 'HEAD', 'refs/heads/main']);
  return { tmpDir, git };
}

async function cleanupTempRepo(tmpDir) {
  await fs.promises.rm(tmpDir, { recursive: true, force: true });
}

describe('resolveBaseRefForLog', () => {
  it('returns the local ref unchanged when it exists, even if origin also exists', async () => {
    // Both local 'main' and 'refs/remotes/origin/main' are present.
    // The local ref takes precedence — callers that ask for 'main' get 'main'.
    const checkRef = async (ref) => ref === 'main' || ref === 'refs/remotes/origin/main';
    expect(await resolveBaseRefForLog('main', checkRef)).toBe('main');
  });

  it('falls back to origin/<from> when local ref cannot be resolved but origin can', async () => {
    // Local 'main' is absent (e.g. user never checked it out), but origin/main exists.
    const checkRef = async (ref) => ref === 'refs/remotes/origin/main';
    expect(await resolveBaseRefForLog('main', checkRef)).toBe('origin/main');
  });

  it('returns the original ref when neither local nor origin ref can be resolved', async () => {
    // Neither ref exists; return as-is so git surfaces a meaningful error.
    const checkRef = async () => false;
    expect(await resolveBaseRefForLog('nonexistent-branch', checkRef)).toBe('nonexistent-branch');
  });

  it('returns undefined when from is undefined', async () => {
    const checkRef = async () => true;
    expect(await resolveBaseRefForLog(undefined, checkRef)).toBeUndefined();
  });

  it('returns undefined when from is an empty string', async () => {
    const checkRef = async () => true;
    expect(await resolveBaseRefForLog('', checkRef)).toBeUndefined();
  });

  it('returns undefined when from is a whitespace-only string', async () => {
    const checkRef = async () => true;
    expect(await resolveBaseRefForLog('   ', checkRef)).toBeUndefined();
  });
});

describe('git index path validation', () => {
  it('rejects stage paths outside the repository before invoking git', async () => {
    await expect(stageFiles('/repo', ['../secret.txt'])).rejects.toThrow('Path is outside repository: ../secret.txt');
  });

  it('rejects unstage paths outside the repository before invoking git', async () => {
    await expect(unstageFiles('/repo', ['../secret.txt'])).rejects.toThrow('Path is outside repository: ../secret.txt');
  });
});

describe('checkoutCommit', () => {
  it('checks out a valid commit and puts the repo in detached HEAD state', async () => {
    const { tmpDir, git } = await createTempRepo();
    try {
      const filePath = path.join(tmpDir, 'file.txt');
      await fs.promises.writeFile(filePath, 'first', 'utf8');
      await git.add('file.txt');
      const firstCommit = await git.commit('First commit');

      await fs.promises.writeFile(filePath, 'second', 'utf8');
      await git.add('file.txt');
      await git.commit('Second commit');

      const result = await checkoutCommit(tmpDir, firstCommit.commit);
      expect(result).toEqual({ success: true });

      const status = await git.status();
      expect(status.detached).toBe(true);
    } finally {
      await cleanupTempRepo(tmpDir);
    }
  });

  it('throws an error for an invalid/nonexistent hash', async () => {
    const { tmpDir } = await createTempRepo();
    try {
      await expect(checkoutCommit(tmpDir, 'invalidhash123')).rejects.toThrow();
    } finally {
      await cleanupTempRepo(tmpDir);
    }
  });
});

describe('cherryPick', () => {
  it('cherry-picks a commit that applies cleanly', async () => {
    const { tmpDir, git } = await createTempRepo();
    try {
      const filePath = path.join(tmpDir, 'file.txt');
      await fs.promises.writeFile(filePath, 'line1\nline2\n', 'utf8');
      await git.add('file.txt');
      await git.commit('Initial commit');

      // Create a branch and make a change
      await git.checkoutBranch('feature', 'HEAD');
      await fs.promises.writeFile(filePath, 'line1\nline2\nline3\n', 'utf8');
      await git.add('file.txt');
      const featureCommit = await git.commit('Add line3');

      // Go back to main and cherry-pick the feature commit
      await git.checkout('main');
      const result = await cherryPick(tmpDir, featureCommit.commit);
      expect(result).toEqual({ success: true, conflict: false });

      const content = await fs.promises.readFile(filePath, 'utf8');
      expect(content).toBe('line1\nline2\nline3\n');
    } finally {
      await cleanupTempRepo(tmpDir);
    }
  });

  it('returns conflict info when cherry-picking a conflicting commit', async () => {
    const { tmpDir, git } = await createTempRepo();
    try {
      const filePath = path.join(tmpDir, 'file.txt');
      await fs.promises.writeFile(filePath, 'line1\nline2\n', 'utf8');
      await git.add('file.txt');
      await git.commit('Initial commit');

      // Create a branch and change line2
      await git.checkoutBranch('feature', 'HEAD');
      await fs.promises.writeFile(filePath, 'line1\nfeature-line2\n', 'utf8');
      await git.add('file.txt');
      const featureCommit = await git.commit('Change line2 in feature');

      // Go back to main and change line2 differently
      await git.checkout('main');
      await fs.promises.writeFile(filePath, 'line1\nmain-line2\n', 'utf8');
      await git.add('file.txt');
      await git.commit('Change line2 in main');

      const result = await cherryPick(tmpDir, featureCommit.commit);
      expect(result.success).toBe(false);
      expect(result.conflict).toBe(true);
      expect(Array.isArray(result.conflictFiles)).toBe(true);
      expect(result.conflictFiles.length).toBeGreaterThan(0);
    } finally {
      await cleanupTempRepo(tmpDir);
    }
  });

  it('throws for an invalid/nonexistent hash', async () => {
    const { tmpDir } = await createTempRepo();
    try {
      await expect(cherryPick(tmpDir, 'deadbeef00000000')).rejects.toThrow();
    } finally {
      await cleanupTempRepo(tmpDir);
    }
  });
});

describe('revertCommit', () => {
  it('reverts a commit and stages the revert changes', async () => {
    const { tmpDir, git } = await createTempRepo();
    try {
      const filePath = path.join(tmpDir, 'file.txt');
      await fs.promises.writeFile(filePath, 'line1\nline2\n', 'utf8');
      await git.add('file.txt');
      await git.commit('Initial commit');

      // Make a change and commit
      await fs.promises.writeFile(filePath, 'line1\nline2\nline3\n', 'utf8');
      await git.add('file.txt');
      const changeCommit = await git.commit('Add line3');

      // Revert the commit
      const result = await revertCommit(tmpDir, changeCommit.commit);
      expect(result).toEqual({ success: true, conflict: false });

      // The revert should be staged (file back to original content)
      const status = await git.status();
      expect(status.staged.length).toBeGreaterThan(0);
      const content = await fs.promises.readFile(filePath, 'utf8');
      expect(content).toBe('line1\nline2\n');
    } finally {
      await cleanupTempRepo(tmpDir);
    }
  });

  it('returns conflict info when reverting causes a conflict', async () => {
    const { tmpDir, git } = await createTempRepo();
    try {
      const filePath = path.join(tmpDir, 'file.txt');
      await fs.promises.writeFile(filePath, 'line1\nline2\nline3\n', 'utf8');
      await git.add('file.txt');
      await git.commit('Initial commit');

      // Commit A: change line2
      await fs.promises.writeFile(filePath, 'line1\nchanged-a\nline3\n', 'utf8');
      await git.add('file.txt');
      const commitA = await git.commit('Change line2 to changed-a');

      // Commit B: change line2 to something else
      await fs.promises.writeFile(filePath, 'line1\nchanged-b\nline3\n', 'utf8');
      await git.add('file.txt');
      await git.commit('Change line2 to changed-b');

      // Reverting commit A wants to restore 'line2', but HEAD has 'changed-b'
      const result = await revertCommit(tmpDir, commitA.commit);
      expect(result.success).toBe(false);
      expect(result.conflict).toBe(true);
      expect(Array.isArray(result.conflictFiles)).toBe(true);
      expect(result.conflictFiles.length).toBeGreaterThan(0);
    } finally {
      await cleanupTempRepo(tmpDir);
    }
  });

  it('throws for an invalid/nonexistent hash', async () => {
    const { tmpDir } = await createTempRepo();
    try {
      await expect(revertCommit(tmpDir, 'deadbeef00000000')).rejects.toThrow();
    } finally {
      await cleanupTempRepo(tmpDir);
    }
  });
});

describe('resetToCommit', () => {
  it('soft reset moves HEAD without touching the working tree', async () => {
    const { tmpDir, git } = await createTempRepo();
    try {
      const filePath = path.join(tmpDir, 'file.txt');
      await fs.promises.writeFile(filePath, 'first\n', 'utf8');
      await git.add('file.txt');
      const firstCommit = await git.commit('First commit');

      await fs.promises.writeFile(filePath, 'second\n', 'utf8');
      await git.add('file.txt');
      await git.commit('Second commit');

      // Soft reset to first commit
      const result = await resetToCommit(tmpDir, firstCommit.commit, 'soft');
      expect(result).toEqual({ success: true });

      // HEAD should be at first commit, but working tree should still have 'second'
      const log = await git.log();
      expect(log.latest.hash).toBe(firstCommit.commit);
      const content = await fs.promises.readFile(filePath, 'utf8');
      expect(content).toBe('second\n');

      // Changes should be staged
      const status = await git.status();
      expect(status.staged.length).toBeGreaterThan(0);
    } finally {
      await cleanupTempRepo(tmpDir);
    }
  });

  it('mixed reset moves HEAD and unstages changes', async () => {
    const { tmpDir, git } = await createTempRepo();
    try {
      const filePath = path.join(tmpDir, 'file.txt');
      await fs.promises.writeFile(filePath, 'first\n', 'utf8');
      await git.add('file.txt');
      const firstCommit = await git.commit('First commit');

      await fs.promises.writeFile(filePath, 'second\n', 'utf8');
      await git.add('file.txt');
      await git.commit('Second commit');

      // Mixed reset to first commit
      const result = await resetToCommit(tmpDir, firstCommit.commit, 'mixed');
      expect(result).toEqual({ success: true });

      // HEAD should be at first commit, working tree should still have 'second'
      const log = await git.log();
      expect(log.latest.hash).toBe(firstCommit.commit);
      const content = await fs.promises.readFile(filePath, 'utf8');
      expect(content).toBe('second\n');

      // Changes should NOT be staged
      const status = await git.status();
      expect(status.staged.length).toBe(0);
      expect(status.modified.length).toBeGreaterThan(0);
    } finally {
      await cleanupTempRepo(tmpDir);
    }
  });

  it('hard reset with clean working tree succeeds', async () => {
    const { tmpDir, git } = await createTempRepo();
    try {
      const filePath = path.join(tmpDir, 'file.txt');
      await fs.promises.writeFile(filePath, 'first\n', 'utf8');
      await git.add('file.txt');
      const firstCommit = await git.commit('First commit');

      await fs.promises.writeFile(filePath, 'second\n', 'utf8');
      await git.add('file.txt');
      await git.commit('Second commit');

      // Hard reset to first commit
      const result = await resetToCommit(tmpDir, firstCommit.commit, 'hard');
      expect(result).toEqual({ success: true });

      // HEAD should be at first commit, working tree should be 'first'
      const log = await git.log();
      expect(log.latest.hash).toBe(firstCommit.commit);
      const content = await fs.promises.readFile(filePath, 'utf8');
      expect(content).toBe('first\n');

      // Working tree should be clean
      const status = await git.status();
      expect(status.isClean()).toBe(true);
    } finally {
      await cleanupTempRepo(tmpDir);
    }
  });

  it('hard reset with dirty working tree without force throws', async () => {
    const { tmpDir, git } = await createTempRepo();
    try {
      const filePath = path.join(tmpDir, 'file.txt');
      await fs.promises.writeFile(filePath, 'first\n', 'utf8');
      await git.add('file.txt');
      const firstCommit = await git.commit('First commit');

      await fs.promises.writeFile(filePath, 'second\n', 'utf8');
      await git.add('file.txt');
      await git.commit('Second commit');

      // Make working tree dirty (uncommitted change)
      await fs.promises.writeFile(filePath, 'dirty\n', 'utf8');

      await expect(resetToCommit(tmpDir, firstCommit.commit, 'hard')).rejects.toThrow(
        'Cannot hard reset: uncommitted changes in working tree'
      );
    } finally {
      await cleanupTempRepo(tmpDir);
    }
  });

  it('hard reset with dirty working tree with force succeeds', async () => {
    const { tmpDir, git } = await createTempRepo();
    try {
      const filePath = path.join(tmpDir, 'file.txt');
      await fs.promises.writeFile(filePath, 'first\n', 'utf8');
      await git.add('file.txt');
      const firstCommit = await git.commit('First commit');

      await fs.promises.writeFile(filePath, 'second\n', 'utf8');
      await git.add('file.txt');
      await git.commit('Second commit');

      // Make working tree dirty (uncommitted change)
      await fs.promises.writeFile(filePath, 'dirty\n', 'utf8');

      const result = await resetToCommit(tmpDir, firstCommit.commit, 'hard', true);
      expect(result).toEqual({ success: true });

      // HEAD should be at first commit, working tree should be 'first'
      const log = await git.log();
      expect(log.latest.hash).toBe(firstCommit.commit);
      const content = await fs.promises.readFile(filePath, 'utf8');
      expect(content).toBe('first\n');
    } finally {
      await cleanupTempRepo(tmpDir);
    }
  });
});
