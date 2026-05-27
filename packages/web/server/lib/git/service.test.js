import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import simpleGit from 'simple-git';

import {
  checkoutCommit,
  cherryPick,
  getStatus,
  resetToCommit,
  resolveBaseRefForLog,
  revertCommit,
  stageFiles,
  unstageFiles,
} from './service.js';

// ---------------------------------------------------------------------------
// Shared test infrastructure
// ---------------------------------------------------------------------------

const tempDirs = [];

/** Create a temp dir and register it for afterEach cleanup. */
const createTempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-git-service-'));
  tempDirs.push(dir);
  return dir;
};

const runGit = (cwd, args) =>
  execFileSync('git', args, {
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

/**
 * Create a temp repo using simple-git (for tests that need its assertion API).
 * The dir is registered in tempDirs so afterEach handles cleanup automatically.
 */
async function createTempRepo() {
  const tmpDir = createTempDir();
  const git = simpleGit(tmpDir);
  await git.init();
  await git.addConfig('user.name', 'Test User', false, 'local');
  await git.addConfig('user.email', 'test@example.com', false, 'local');
  await git.raw(['symbolic-ref', 'HEAD', 'refs/heads/main']);
  return { tmpDir, git };
}

// ---------------------------------------------------------------------------
// resolveBaseRefForLog
// ---------------------------------------------------------------------------

describe('resolveBaseRefForLog', () => {
  it('returns the local ref unchanged when it exists, even if origin also exists', async () => {
    const checkRef = async (ref) => ref === 'main' || ref === 'refs/remotes/origin/main';
    expect(await resolveBaseRefForLog('main', checkRef)).toBe('main');
  });

  it('falls back to origin/<from> when local ref cannot be resolved but origin can', async () => {
    const checkRef = async (ref) => ref === 'refs/remotes/origin/main';
    expect(await resolveBaseRefForLog('main', checkRef)).toBe('origin/main');
  });

  it('returns the original ref when neither local nor origin ref can be resolved', async () => {
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

// ---------------------------------------------------------------------------
// git index path validation
// ---------------------------------------------------------------------------

describe('git index path validation', () => {
  it('rejects stage paths outside the repository before invoking git', async () => {
    await expect(stageFiles('/repo', ['../secret.txt'])).rejects.toThrow(
      'Path is outside repository: ../secret.txt'
    );
  });

  it('rejects unstage paths outside the repository before invoking git', async () => {
    await expect(unstageFiles('/repo', ['../secret.txt'])).rejects.toThrow(
      'Path is outside repository: ../secret.txt'
    );
  });
});

// ---------------------------------------------------------------------------
// getStatus
// ---------------------------------------------------------------------------

describe('getStatus', () => {
  it('handles repositories without upstream tracking', async () => {
    if (!canRunGit()) return;

    const repo = createTempDir();
    runGit(repo, ['init', '-b', 'main']);
    runGit(repo, ['config', 'user.email', 'test@example.com']);
    runGit(repo, ['config', 'user.name', 'Test User']);
    fs.writeFileSync(path.join(repo, 'README.md'), '# Test\n');
    runGit(repo, ['add', 'README.md']);
    runGit(repo, ['commit', '-m', 'Initial commit']);

    await expect(getStatus(repo)).resolves.toMatchObject({ current: 'main' });
  });
});

// ---------------------------------------------------------------------------
// checkoutCommit
// ---------------------------------------------------------------------------

describe('checkoutCommit', () => {
  it('checks out a valid commit and puts the repo in detached HEAD state', async () => {
    const { tmpDir, git } = await createTempRepo();
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
  });

  it('throws an error for an invalid/nonexistent hash', async () => {
    const { tmpDir } = await createTempRepo();
    await expect(checkoutCommit(tmpDir, 'invalidhash123')).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// cherryPick
// ---------------------------------------------------------------------------

describe('cherryPick', () => {
  it('cherry-picks a commit that applies cleanly', async () => {
    const { tmpDir, git } = await createTempRepo();
    const filePath = path.join(tmpDir, 'file.txt');
    await fs.promises.writeFile(filePath, 'line1\nline2\n', 'utf8');
    await git.add('file.txt');
    await git.commit('Initial commit');

    await git.checkoutBranch('feature', 'HEAD');
    await fs.promises.writeFile(filePath, 'line1\nline2\nline3\n', 'utf8');
    await git.add('file.txt');
    const featureCommit = await git.commit('Add line3');

    await git.checkout('main');
    const result = await cherryPick(tmpDir, featureCommit.commit);
    expect(result).toEqual({ success: true, conflict: false });

    const content = await fs.promises.readFile(filePath, 'utf8');
    expect(content).toBe('line1\nline2\nline3\n');
  });

  it('returns conflict info when cherry-picking a conflicting commit', async () => {
    const { tmpDir, git } = await createTempRepo();
    const filePath = path.join(tmpDir, 'file.txt');
    await fs.promises.writeFile(filePath, 'line1\nline2\n', 'utf8');
    await git.add('file.txt');
    await git.commit('Initial commit');

    await git.checkoutBranch('feature', 'HEAD');
    await fs.promises.writeFile(filePath, 'line1\nfeature-line2\n', 'utf8');
    await git.add('file.txt');
    const featureCommit = await git.commit('Change line2 in feature');

    await git.checkout('main');
    await fs.promises.writeFile(filePath, 'line1\nmain-line2\n', 'utf8');
    await git.add('file.txt');
    await git.commit('Change line2 in main');

    const result = await cherryPick(tmpDir, featureCommit.commit);
    expect(result.success).toBe(false);
    expect(result.conflict).toBe(true);
    expect(Array.isArray(result.conflictFiles)).toBe(true);
    expect(result.conflictFiles.length).toBeGreaterThan(0);
  });

  it('throws for an invalid/nonexistent hash', async () => {
    const { tmpDir } = await createTempRepo();
    await expect(cherryPick(tmpDir, 'deadbeef00000000')).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// revertCommit
// ---------------------------------------------------------------------------

describe('revertCommit', () => {
  it('reverts a commit and stages the revert changes', async () => {
    const { tmpDir, git } = await createTempRepo();
    const filePath = path.join(tmpDir, 'file.txt');
    await fs.promises.writeFile(filePath, 'line1\nline2\n', 'utf8');
    await git.add('file.txt');
    await git.commit('Initial commit');

    await fs.promises.writeFile(filePath, 'line1\nline2\nline3\n', 'utf8');
    await git.add('file.txt');
    const changeCommit = await git.commit('Add line3');

    const result = await revertCommit(tmpDir, changeCommit.commit);
    expect(result).toEqual({ success: true, conflict: false });

    const status = await git.status();
    expect(status.staged.length).toBeGreaterThan(0);
    const content = await fs.promises.readFile(filePath, 'utf8');
    expect(content).toBe('line1\nline2\n');
  });

  it('returns conflict info when reverting causes a conflict', async () => {
    const { tmpDir, git } = await createTempRepo();
    const filePath = path.join(tmpDir, 'file.txt');
    await fs.promises.writeFile(filePath, 'line1\nline2\nline3\n', 'utf8');
    await git.add('file.txt');
    await git.commit('Initial commit');

    await fs.promises.writeFile(filePath, 'line1\nchanged-a\nline3\n', 'utf8');
    await git.add('file.txt');
    const commitA = await git.commit('Change line2 to changed-a');

    await fs.promises.writeFile(filePath, 'line1\nchanged-b\nline3\n', 'utf8');
    await git.add('file.txt');
    await git.commit('Change line2 to changed-b');

    const result = await revertCommit(tmpDir, commitA.commit);
    expect(result.success).toBe(false);
    expect(result.conflict).toBe(true);
    expect(Array.isArray(result.conflictFiles)).toBe(true);
    expect(result.conflictFiles.length).toBeGreaterThan(0);
  });

  it('throws for an invalid/nonexistent hash', async () => {
    const { tmpDir } = await createTempRepo();
    await expect(revertCommit(tmpDir, 'deadbeef00000000')).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// resetToCommit
// ---------------------------------------------------------------------------

describe('resetToCommit', () => {
  it('soft reset moves HEAD without touching the working tree', async () => {
    const { tmpDir, git } = await createTempRepo();
    const filePath = path.join(tmpDir, 'file.txt');
    await fs.promises.writeFile(filePath, 'first\n', 'utf8');
    await git.add('file.txt');
    const firstCommit = await git.commit('First commit');

    await fs.promises.writeFile(filePath, 'second\n', 'utf8');
    await git.add('file.txt');
    await git.commit('Second commit');

    const result = await resetToCommit(tmpDir, firstCommit.commit, 'soft');
    expect(result).toEqual({ success: true });

    const log = await git.log();
    expect(log.latest.hash).toBe(firstCommit.commit);
    const content = await fs.promises.readFile(filePath, 'utf8');
    expect(content).toBe('second\n');

    const status = await git.status();
    expect(status.staged.length).toBeGreaterThan(0);
  });

  it('mixed reset moves HEAD and unstages changes', async () => {
    const { tmpDir, git } = await createTempRepo();
    const filePath = path.join(tmpDir, 'file.txt');
    await fs.promises.writeFile(filePath, 'first\n', 'utf8');
    await git.add('file.txt');
    const firstCommit = await git.commit('First commit');

    await fs.promises.writeFile(filePath, 'second\n', 'utf8');
    await git.add('file.txt');
    await git.commit('Second commit');

    const result = await resetToCommit(tmpDir, firstCommit.commit, 'mixed');
    expect(result).toEqual({ success: true });

    const log = await git.log();
    expect(log.latest.hash).toBe(firstCommit.commit);
    const content = await fs.promises.readFile(filePath, 'utf8');
    expect(content).toBe('second\n');

    const status = await git.status();
    expect(status.staged.length).toBe(0);
    expect(status.modified.length).toBeGreaterThan(0);
  });

  it('hard reset with clean working tree succeeds', async () => {
    const { tmpDir, git } = await createTempRepo();
    const filePath = path.join(tmpDir, 'file.txt');
    await fs.promises.writeFile(filePath, 'first\n', 'utf8');
    await git.add('file.txt');
    const firstCommit = await git.commit('First commit');

    await fs.promises.writeFile(filePath, 'second\n', 'utf8');
    await git.add('file.txt');
    await git.commit('Second commit');

    const result = await resetToCommit(tmpDir, firstCommit.commit, 'hard');
    expect(result).toEqual({ success: true });

    const log = await git.log();
    expect(log.latest.hash).toBe(firstCommit.commit);
    const content = await fs.promises.readFile(filePath, 'utf8');
    expect(content).toBe('first\n');

    const status = await git.status();
    expect(status.isClean()).toBe(true);
  });

  it('hard reset with dirty working tree without force throws', async () => {
    const { tmpDir, git } = await createTempRepo();
    const filePath = path.join(tmpDir, 'file.txt');
    await fs.promises.writeFile(filePath, 'first\n', 'utf8');
    await git.add('file.txt');
    const firstCommit = await git.commit('First commit');

    await fs.promises.writeFile(filePath, 'second\n', 'utf8');
    await git.add('file.txt');
    await git.commit('Second commit');

    await fs.promises.writeFile(filePath, 'dirty\n', 'utf8');

    await expect(resetToCommit(tmpDir, firstCommit.commit, 'hard')).rejects.toThrow(
      'Cannot hard reset: uncommitted changes in working tree'
    );
  });

  it('hard reset with dirty working tree with force succeeds', async () => {
    const { tmpDir, git } = await createTempRepo();
    const filePath = path.join(tmpDir, 'file.txt');
    await fs.promises.writeFile(filePath, 'first\n', 'utf8');
    await git.add('file.txt');
    const firstCommit = await git.commit('First commit');

    await fs.promises.writeFile(filePath, 'second\n', 'utf8');
    await git.add('file.txt');
    await git.commit('Second commit');

    await fs.promises.writeFile(filePath, 'dirty\n', 'utf8');

    const result = await resetToCommit(tmpDir, firstCommit.commit, 'hard', true);
    expect(result).toEqual({ success: true });

    const log = await git.log();
    expect(log.latest.hash).toBe(firstCommit.commit);
    const content = await fs.promises.readFile(filePath, 'utf8');
    expect(content).toBe('first\n');
  });
});

// ---------------------------------------------------------------------------
// hash validation
// ---------------------------------------------------------------------------

describe('hash validation', () => {
  it('checkoutCommit rejects non-hex hash', async () => {
    await expect(checkoutCommit('/tmp', '--hard')).rejects.toThrow('Invalid commit hash');
  });

  it('checkoutCommit rejects ref name', async () => {
    await expect(checkoutCommit('/tmp', 'HEAD')).rejects.toThrow('Invalid commit hash');
  });

  it('checkoutCommit accepts valid 40-char hex format', async () => {
    await expect(
      checkoutCommit('/tmp', '1234567890abcdef1234567890abcdef12345678')
    ).rejects.not.toThrow('Invalid commit hash');
  });

  it('cherryPick rejects non-hex hash', async () => {
    await expect(cherryPick('/tmp', '--hard')).rejects.toThrow('Invalid commit hash');
  });

  it('cherryPick rejects ref name', async () => {
    await expect(cherryPick('/tmp', 'HEAD')).rejects.toThrow('Invalid commit hash');
  });

  it('cherryPick accepts valid 40-char hex format', async () => {
    await expect(
      cherryPick('/tmp', '1234567890abcdef1234567890abcdef12345678')
    ).rejects.not.toThrow('Invalid commit hash');
  });

  it('revertCommit rejects non-hex hash', async () => {
    await expect(revertCommit('/tmp', '--hard')).rejects.toThrow('Invalid commit hash');
  });

  it('revertCommit rejects ref name', async () => {
    await expect(revertCommit('/tmp', 'HEAD')).rejects.toThrow('Invalid commit hash');
  });

  it('revertCommit accepts valid 40-char hex format', async () => {
    await expect(
      revertCommit('/tmp', '1234567890abcdef1234567890abcdef12345678')
    ).rejects.not.toThrow('Invalid commit hash');
  });

  it('resetToCommit rejects non-hex hash', async () => {
    await expect(resetToCommit('/tmp', '--hard', 'soft')).rejects.toThrow('Invalid commit hash');
  });

  it('resetToCommit rejects ref name', async () => {
    await expect(resetToCommit('/tmp', 'HEAD', 'soft')).rejects.toThrow('Invalid commit hash');
  });

  it('resetToCommit accepts valid 40-char hex format', async () => {
    await expect(
      resetToCommit('/tmp', '1234567890abcdef1234567890abcdef12345678', 'soft')
    ).rejects.not.toThrow('Invalid commit hash');
  });
});
