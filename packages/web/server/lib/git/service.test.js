import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import simpleGit from 'simple-git';

import {
  checkoutCommit,
  cherryPick,
  clearBranchTracking,
  createWorktree,
  getWorktreeBootstrapStatus,
  getStatus,
  populateWorktreeWithLockRecovery,
  renameBranch,
  removeWorktree,
  resolvePrimaryWorktreeRoot,
  resolveWorktreeTopLevel,
  resetToCommit,
  resolveBaseRefForLog,
  revertCommit,
  stageFiles,
  unstageFiles,
  validateWorktreeCreate,
  applyHunk,
  getDiff,
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

const waitForCondition = async (condition, timeout = 5_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for condition');
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
// applyHunk (per-hunk stage / unstage / discard)
// ---------------------------------------------------------------------------

/** Minimal unified-diff splitter: returns standalone per-hunk patches. */
const splitHunks = (patch) => {
  const lines = patch.split(/\r?\n/);
  const headerEnd = lines.findIndex((line) => /^@@\s/.test(line));
  if (headerEnd === -1) return [];
  const header = lines.slice(0, headerEnd);
  const hunks = [];
  for (let i = headerEnd; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^@@\s/.test(line)) hunks.push([...header, line]);
    else if (hunks.length > 0) hunks[hunks.length - 1].push(line);
  }
  return hunks.map((hunk) => hunk.join('\n'))
    .filter((hunk) => hunk.trim().length > 0)
    .map((hunk) => (hunk.endsWith('\n') ? hunk : `${hunk}\n`));
};

const writeFile = (repo, name, contents) =>
  fs.promises.writeFile(path.join(repo, name), contents, 'utf8');

// Build a 20-line file so changes on line 1 and line 20 stay in separate hunks
// (default 3-line diff context would merge closer edits into one hunk).
const makeFile = (first, last) =>
  [first, ...Array.from({ length: 18 }, (_, i) => `line${i + 2}`), last].join('\n') + '\n';
const ORIGINAL_FILE = makeFile('line1', 'line20');
const EDITED_FILE = makeFile('TOP', 'BOTTOM');

const readWorking = (repo) => fs.promises.readFile(path.join(repo, 'file.txt'), 'utf8').then((c) => c.replace(/\r\n/g, '\n'));
const readStaged = async (git) => (await git.raw(['show', ':file.txt'])).replace(/\r\n/g, '\n');

describe('applyHunk', () => {
  it('rejects an invalid action or a patch without a hunk header', async () => {
    const { tmpDir } = await createTempRepo();
    await expect(applyHunk(tmpDir, 'file.txt', { patch: '@@ -1 +1 @@\n a\n', action: 'bogus' })).rejects.toThrow(
      'Invalid hunk action'
    );
    await expect(applyHunk(tmpDir, 'file.txt', { patch: 'no hunk here', action: 'stage' })).rejects.toThrow(
      'hunk header'
    );
  });

  it('stages a single hunk while leaving the rest unstaged', async () => {
    if (!canRunGit()) return;
    const { tmpDir, git } = await createTempRepo();
    await writeFile(tmpDir, 'file.txt', ORIGINAL_FILE);
    await git.add('file.txt');
    await git.commit('Initial');

    await writeFile(tmpDir, 'file.txt', EDITED_FILE);
    const diff = await getDiff(tmpDir, { path: 'file.txt' });
    const hunks = splitHunks(diff);
    expect(hunks.length).toBe(2);

    await applyHunk(tmpDir, 'file.txt', { patch: hunks[0], action: 'stage' });

    expect(await readStaged(git)).toBe(makeFile('TOP', 'line20'));
    expect(await readWorking(tmpDir)).toBe(EDITED_FILE);
  });

  it('discards a single hunk from the working tree', async () => {
    if (!canRunGit()) return;
    const { tmpDir, git } = await createTempRepo();
    await writeFile(tmpDir, 'file.txt', ORIGINAL_FILE);
    await git.add('file.txt');
    await git.commit('Initial');

    await writeFile(tmpDir, 'file.txt', EDITED_FILE);
    const diff = await getDiff(tmpDir, { path: 'file.txt' });
    const hunks = splitHunks(diff);
    expect(hunks.length).toBe(2);

    await applyHunk(tmpDir, 'file.txt', { patch: hunks[1], action: 'discard' });

    expect(await readWorking(tmpDir)).toBe(makeFile('TOP', 'line20'));
  });

  it('unstages a single hunk from the index', async () => {
    if (!canRunGit()) return;
    const { tmpDir, git } = await createTempRepo();
    await writeFile(tmpDir, 'file.txt', ORIGINAL_FILE);
    await git.add('file.txt');
    await git.commit('Initial');

    await writeFile(tmpDir, 'file.txt', EDITED_FILE);
    await git.add('file.txt');

    const stagedDiff = await getDiff(tmpDir, { path: 'file.txt', staged: true });
    const hunks = splitHunks(stagedDiff);
    expect(hunks.length).toBe(2);

    await applyHunk(tmpDir, 'file.txt', { patch: hunks[0], action: 'unstage' });

    // Only the first hunk (line1 -> TOP) was reverted in the index;
    // the second hunk (BOTTOM) stays staged.
    expect(await readStaged(git)).toBe(makeFile('line1', 'BOTTOM'));
  });

  it('rejects a patch whose target path does not match the requested file', async () => {
    if (!canRunGit()) return;
    const { tmpDir, git } = await createTempRepo();
    await writeFile(tmpDir, 'file.txt', ORIGINAL_FILE);
    await git.add('file.txt');
    await git.commit('Initial');
    await writeFile(tmpDir, 'file.txt', makeFile('CHANGED', 'line20'));

    const diff = await getDiff(tmpDir, { path: 'file.txt' });
    const [hunk] = splitHunks(diff);
    const retargeted = hunk.replace(/file\.txt/g, 'other.txt');
    await expect(applyHunk(tmpDir, 'file.txt', { patch: retargeted, action: 'stage' })).rejects.toThrow(
      'patch target path does not match'
    );
  });

  it('accepts hunk patches for files with spaces in their path', async () => {
    if (!canRunGit()) return;
    const { tmpDir, git } = await createTempRepo();
    const filePath = 'file name.txt';
    await writeFile(tmpDir, filePath, ORIGINAL_FILE);
    await git.add(filePath);
    await git.commit('Initial');

    await writeFile(tmpDir, filePath, EDITED_FILE);
    const diff = await getDiff(tmpDir, { path: filePath });
    const hunks = splitHunks(diff);
    expect(hunks.length).toBe(2);

    await applyHunk(tmpDir, filePath, { patch: hunks[0], action: 'stage' });

    const staged = (await git.raw(['show', `:${filePath}`])).replace(/\r\n/g, '\n');
    expect(staged).toBe(makeFile('TOP', 'line20'));
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
// worktree root resolution
// ---------------------------------------------------------------------------

describe('worktree root resolution', () => {
  it('resolves the git toplevel for a repository subdirectory', async () => {
    if (!canRunGit()) return;

    const repo = createTempDir();
    const subdirectory = path.join(repo, 'packages', 'app');
    runGit(repo, ['init', '-b', 'main']);
    fs.mkdirSync(subdirectory, { recursive: true });

    await expect(resolveWorktreeTopLevel(subdirectory)).resolves.toEqual({ root: fs.realpathSync(repo) });
  });

  it('resolves the primary worktree root from a linked worktree', async () => {
    if (!canRunGit()) return;

    const repo = createTempDir();
    const worktree = createTempDir();
    runGit(repo, ['init', '-b', 'main']);
    runGit(repo, ['config', 'user.email', 'test@example.com']);
    runGit(repo, ['config', 'user.name', 'Test User']);
    fs.writeFileSync(path.join(repo, 'README.md'), '# Test\n');
    runGit(repo, ['add', 'README.md']);
    runGit(repo, ['commit', '-m', 'Initial commit']);
    fs.rmSync(worktree, { recursive: true, force: true });
    runGit(repo, ['worktree', 'add', '-b', 'feature/test', worktree, 'HEAD']);

    await expect(resolvePrimaryWorktreeRoot(worktree)).resolves.toEqual({ root: fs.realpathSync(repo) });
  });
});

// ---------------------------------------------------------------------------
// createWorktree
// ---------------------------------------------------------------------------

describe('createWorktree', () => {
  it('returns ready/setup-ready when no bootstrap state is recorded', async () => {
    const directory = path.join(createTempDir(), 'missing-worktree');

    await expect(getWorktreeBootstrapStatus(directory)).resolves.toMatchObject({
      status: 'ready',
      phase: 'setup-ready',
      error: null,
    });
  });

  it('reports directory, Git, and setup bootstrap phases while preserving legacy status', async () => {
    if (!canRunGit()) return;

    const previousXdgDataHome = process.env.XDG_DATA_HOME;
    const dataHome = createTempDir();
    const setupMarker = path.join(dataHome, 'setup-started');
    const setupScript = path.join(dataHome, 'setup-phase.cjs');
    process.env.XDG_DATA_HOME = dataHome;

    fs.writeFileSync(
      setupScript,
      `require('node:fs').writeFileSync(${JSON.stringify(setupMarker)}, 'started'); setTimeout(() => {}, 1000);\n`,
    );

    try {
      const repo = createTempDir();
      runGit(repo, ['init', '-b', 'main']);
      runGit(repo, ['config', 'user.email', 'test@example.com']);
      runGit(repo, ['config', 'user.name', 'Test User']);
      fs.writeFileSync(path.join(repo, 'README.md'), '# Test\n');
      runGit(repo, ['add', 'README.md']);
      runGit(repo, ['commit', '-m', 'Initial commit']);

      const created = await createWorktree(repo, {
        mode: 'new',
        branchName: 'feature/bootstrap-phases',
        worktreeName: 'bootstrap-phases',
        returnAfterDirectoryCreated: true,
        startCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(setupScript)}`,
      });

      expect(created.bootstrapStatus).toMatchObject({
        status: 'pending',
        phase: 'directory-created',
        error: null,
      });

      await waitForCondition(() => fs.existsSync(setupMarker));
      await expect(getWorktreeBootstrapStatus(created.path)).resolves.toMatchObject({
        status: 'pending',
        phase: 'git-ready',
        error: null,
      });

      await waitForCondition(async () => (await getWorktreeBootstrapStatus(created.path)).phase === 'setup-ready');
      await expect(getWorktreeBootstrapStatus(created.path)).resolves.toMatchObject({
        status: 'ready',
        phase: 'setup-ready',
        error: null,
      });
    } finally {
      if (previousXdgDataHome === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = previousXdgDataHome;
      }
    }
  });

  it('waits for active bootstrap work before removing a worktree', async () => {
    if (!canRunGit()) return;

    const previousXdgDataHome = process.env.XDG_DATA_HOME;
    const dataHome = createTempDir();
    const setupStarted = path.join(dataHome, 'remove-race-started');
    const setupCompleted = path.join(dataHome, 'remove-race-completed');
    const setupScript = path.join(dataHome, 'remove-race.cjs');
    process.env.XDG_DATA_HOME = dataHome;

    fs.writeFileSync(
      setupScript,
      `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(setupStarted)}, 'started'); setTimeout(() => fs.writeFileSync(${JSON.stringify(setupCompleted)}, 'completed'), 300);\n`,
    );

    try {
      const repo = createTempDir();
      runGit(repo, ['init', '-b', 'main']);
      runGit(repo, ['config', 'user.email', 'test@example.com']);
      runGit(repo, ['config', 'user.name', 'Test User']);
      fs.writeFileSync(path.join(repo, 'README.md'), '# Test\n');
      runGit(repo, ['add', 'README.md']);
      runGit(repo, ['commit', '-m', 'Initial commit']);

      const created = await createWorktree(repo, {
        mode: 'new',
        branchName: 'feature/remove-bootstrap-race',
        worktreeName: 'remove-bootstrap-race',
        returnAfterDirectoryCreated: true,
        startCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(setupScript)}`,
      });

      await waitForCondition(() => fs.existsSync(setupStarted));
      let removalCompleted = false;
      const removal = removeWorktree(repo, { directory: created.path }).then(() => {
        removalCompleted = true;
      });

      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(removalCompleted).toBe(false);
      await removal;

      expect(fs.existsSync(setupCompleted)).toBe(true);
      expect(fs.existsSync(created.path)).toBe(false);
      await expect(getWorktreeBootstrapStatus(created.path)).resolves.toMatchObject({
        status: 'ready',
        phase: 'setup-ready',
      });
    } finally {
      if (previousXdgDataHome === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = previousXdgDataHome;
      }
    }
  });

  it('recovers from an unchanged stale index lock while populating a worktree', async () => {
    if (!canRunGit()) return;

    const repo = createTempDir();
    const worktree = createTempDir();
    runGit(repo, ['init', '-b', 'main']);
    runGit(repo, ['config', 'user.email', 'test@example.com']);
    runGit(repo, ['config', 'user.name', 'Test User']);
    fs.writeFileSync(path.join(repo, 'README.md'), '# Test\n');
    runGit(repo, ['add', 'README.md']);
    runGit(repo, ['commit', '-m', 'Initial commit']);
    fs.rmSync(worktree, { recursive: true, force: true });
    runGit(repo, ['worktree', 'add', '--no-checkout', '-b', 'feature/stale-lock', worktree, 'HEAD']);

    const lockPath = runGit(worktree, ['rev-parse', '--git-path', 'index.lock']).trim();
    fs.writeFileSync(lockPath, 'stale');

    await expect(populateWorktreeWithLockRecovery(worktree)).resolves.toBeUndefined();
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.readFileSync(path.join(worktree, 'README.md'), 'utf8')).toBe('# Test\n');
  });

  it('preflights fast create branch-in-use failures before creating the candidate directory', async () => {
    if (!canRunGit()) return;

    const previousXdgDataHome = process.env.XDG_DATA_HOME;
    const dataHome = createTempDir();
    process.env.XDG_DATA_HOME = dataHome;

    try {
      const repo = createTempDir();
      const worktree = createTempDir();
      runGit(repo, ['init', '-b', 'main']);
      runGit(repo, ['config', 'user.email', 'test@example.com']);
      runGit(repo, ['config', 'user.name', 'Test User']);
      fs.writeFileSync(path.join(repo, 'README.md'), '# Test\n');
      runGit(repo, ['add', 'README.md']);
      runGit(repo, ['commit', '-m', 'Initial commit']);
      const projectID = runGit(repo, ['rev-list', '--max-parents=0', '--all']).trim();

      fs.rmSync(worktree, { recursive: true, force: true });
      runGit(repo, ['worktree', 'add', '-b', 'feature/in-use', worktree, 'HEAD']);
      const canonicalWorktree = fs.realpathSync(worktree);

      await expect(createWorktree(repo, {
        mode: 'existing',
        existingBranch: 'feature/in-use',
        branchName: 'feature/in-use',
        worktreeName: 'feature-in-use',
        returnAfterDirectoryCreated: true,
      })).rejects.toThrow(`Branch is already checked out in ${canonicalWorktree}`);

      const candidateDirectory = path.join(dataHome, 'opencode', 'worktree', projectID, 'feature-in-use');
      expect(fs.existsSync(candidateDirectory)).toBe(false);
    } finally {
      if (previousXdgDataHome === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = previousXdgDataHome;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// linked pull request worktrees
// ---------------------------------------------------------------------------

const configureRepository = (directory) => {
  runGit(directory, ['init', '-b', 'main']);
  runGit(directory, ['config', 'user.email', 'test@example.com']);
  runGit(directory, ['config', 'user.name', 'Test User']);
  fs.writeFileSync(path.join(directory, 'README.md'), '# Test\n');
  runGit(directory, ['add', 'README.md']);
  runGit(directory, ['commit', '-m', 'Initial commit']);
};

const getGitConfig = (directory, key) => {
  try {
    return runGit(directory, ['config', '--get', key]).trim() || null;
  } catch {
    return null;
  }
};

const withTestDataHome = async (callback) => {
  const previousXdgDataHome = process.env.XDG_DATA_HOME;
  const dataHome = createTempDir();
  process.env.XDG_DATA_HOME = dataHome;

  try {
    return await callback(dataHome);
  } finally {
    if (previousXdgDataHome === undefined) {
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = previousXdgDataHome;
    }
  }
};

const createPullRequestFixture = ({ baseRemoteName = 'base' } = {}) => {
  const repository = createTempDir();
  const baseRemote = createTempDir();
  const forkRemote = createTempDir();
  const forkClone = createTempDir();
  const prNumber = 42;

  configureRepository(repository);
  runGit(baseRemote, ['init', '--bare']);
  runGit(forkRemote, ['init', '--bare']);
  runGit(repository, ['remote', 'add', baseRemoteName, baseRemote]);
  runGit(repository, ['push', baseRemoteName, 'main']);
  runGit(baseRemote, ['symbolic-ref', 'HEAD', 'refs/heads/main']);

  fs.rmSync(forkClone, { recursive: true, force: true });
  runGit(repository, ['clone', baseRemote, forkClone]);
  runGit(forkClone, ['config', 'user.email', 'test@example.com']);
  runGit(forkClone, ['config', 'user.name', 'Test User']);
  runGit(forkClone, ['checkout', '-b', 'feature/fork']);
  fs.writeFileSync(path.join(forkClone, 'fork.txt'), 'fork source\n');
  runGit(forkClone, ['add', 'fork.txt']);
  runGit(forkClone, ['commit', '-m', 'Fork pull request head']);
  const forkHead = runGit(forkClone, ['rev-parse', 'HEAD']).trim();
  runGit(forkClone, ['remote', 'add', 'fork', forkRemote]);
  runGit(forkClone, ['push', 'fork', 'feature/fork']);

  runGit(repository, ['checkout', '-b', 'feature/base-pr']);
  fs.writeFileSync(path.join(repository, 'base-pr.txt'), 'base pull request source\n');
  runGit(repository, ['add', 'base-pr.txt']);
  runGit(repository, ['commit', '-m', 'Base pull request head']);
  const baseHead = runGit(repository, ['rev-parse', 'HEAD']).trim();
  runGit(repository, ['push', baseRemoteName, `feature/base-pr:refs/pull/${prNumber}/head`]);
  runGit(repository, ['checkout', 'main']);

  return { repository, baseRemote, baseRemoteName, forkRemote, forkHead, baseHead, prNumber };
};

const waitForWorktreeBootstrap = async (directory) => {
  await waitForCondition(async () => {
    const status = await getWorktreeBootstrapStatus(directory);
    if (status.status === 'failed') {
      throw new Error(status.error || 'Worktree bootstrap failed');
    }
    return status.status === 'ready';
  });
};

describe('linked pull request worktrees', () => {
  it('provisions and checks out a reachable fork before considering the base pull request ref', async () => {
    if (!canRunGit()) return;

    await withTestDataHome(async () => {
      const fixture = createPullRequestFixture();
      const input = {
        mode: 'existing',
        worktreeName: 'fork-wins',
        branchName: 'pr/fork-wins',
        existingBranch: 'remotes/pr-fork/feature/fork',
        prNumber: fixture.prNumber,
        baseRemote: 'base',
        setUpstream: true,
        upstreamRemote: 'pr-fork',
        upstreamBranch: 'feature/fork',
        ensureRemoteName: 'pr-fork',
        ensureRemoteUrl: fixture.forkRemote,
        returnAfterDirectoryCreated: true,
      };

      await expect(validateWorktreeCreate(fixture.repository, input)).resolves.toMatchObject({ ok: true });
      expect(() => runGit(fixture.repository, ['remote', 'get-url', 'pr-fork'])).toThrow();

      const created = await createWorktree(fixture.repository, input);

      await waitForWorktreeBootstrap(created.path);

      expect(runGit(created.path, ['rev-parse', 'HEAD']).trim()).toBe(fixture.forkHead);
      expect(runGit(fixture.repository, ['remote', 'get-url', 'pr-fork']).trim()).toBe(fixture.forkRemote);
      expect(getGitConfig(created.path, 'branch.pr/fork-wins.remote')).toBe('pr-fork');
      expect(getGitConfig(created.path, 'branch.pr/fork-wins.merge')).toBe('refs/heads/feature/fork');
    });
  });

  it('uses a collision-safe fork remote without changing the base remote, then falls back through that base remote', async () => {
    if (!canRunGit()) return;

    await withTestDataHome(async () => {
      const fixture = createPullRequestFixture({ baseRemoteName: 'pr-fork' });
      const input = {
        mode: 'existing',
        worktreeName: 'fork-remote-collision',
        branchName: 'pr/fork-remote-collision',
        existingBranch: 'remotes/pr-fork/feature/fork',
        prNumber: fixture.prNumber,
        baseRemote: fixture.baseRemoteName,
        setUpstream: true,
        upstreamRemote: 'pr-fork',
        upstreamBranch: 'feature/fork',
        ensureRemoteName: 'pr-fork',
        ensureRemoteUrl: fixture.forkRemote,
        returnAfterDirectoryCreated: true,
      };

      await expect(validateWorktreeCreate(fixture.repository, input)).resolves.toMatchObject({ ok: true });
      expect(runGit(fixture.repository, ['remote', 'get-url', fixture.baseRemoteName]).trim()).toBe(fixture.baseRemote);
      expect(() => runGit(fixture.repository, ['remote', 'get-url', 'pr-fork-pr-42'])).toThrow();

      const forkCreated = await createWorktree(fixture.repository, input);
      await waitForWorktreeBootstrap(forkCreated.path);

      expect(runGit(forkCreated.path, ['rev-parse', 'HEAD']).trim()).toBe(fixture.forkHead);
      expect(runGit(fixture.repository, ['remote', 'get-url', fixture.baseRemoteName]).trim()).toBe(fixture.baseRemote);
      expect(runGit(fixture.repository, ['remote', 'get-url', 'pr-fork-pr-42']).trim()).toBe(fixture.forkRemote);
      expect(getGitConfig(forkCreated.path, 'branch.pr/fork-remote-collision.remote')).toBe('pr-fork-pr-42');

      const unavailableFork = path.join(createTempDir(), 'missing-fork.git');
      const fallbackCreated = await createWorktree(fixture.repository, {
        ...input,
        worktreeName: 'fork-remote-collision-fallback',
        branchName: 'pr/fork-remote-collision-fallback',
        ensureRemoteUrl: unavailableFork,
      });
      await waitForWorktreeBootstrap(fallbackCreated.path);

      expect(runGit(fallbackCreated.path, ['rev-parse', 'HEAD']).trim()).toBe(fixture.baseHead);
      expect(runGit(fixture.repository, ['remote', 'get-url', fixture.baseRemoteName]).trim()).toBe(fixture.baseRemote);
      expect(getGitConfig(fallbackCreated.path, 'branch.pr/fork-remote-collision-fallback.remote')).toBeNull();
      expect(getGitConfig(fallbackCreated.path, 'branch.pr/fork-remote-collision-fallback.merge')).toBeNull();
    });
  }, 15_000);

  it('uses the base pull request head when the fork URL is missing', async () => {
    if (!canRunGit()) return;

    await withTestDataHome(async () => {
      const fixture = createPullRequestFixture();
      const created = await createWorktree(fixture.repository, {
        mode: 'existing',
        worktreeName: 'base-pr-ref',
        branchName: 'pr/base-ref',
        existingBranch: 'feature/base-pr',
        prNumber: fixture.prNumber,
        baseRemote: 'base',
        setUpstream: false,
        returnAfterDirectoryCreated: true,
      });

      await waitForWorktreeBootstrap(created.path);

      expect(runGit(created.path, ['rev-parse', 'HEAD']).trim()).toBe(fixture.baseHead);
      expect(getGitConfig(created.path, 'branch.pr/base-ref.remote')).toBeNull();
      expect(getGitConfig(created.path, 'branch.pr/base-ref.merge')).toBeNull();
    });
  });

  it('falls back to the base pull request head during real attachment when the fork fetch fails', async () => {
    if (!canRunGit()) return;

    await withTestDataHome(async () => {
      const fixture = createPullRequestFixture();
      const unavailableFork = path.join(createTempDir(), 'missing-fork.git');
      const created = await createWorktree(fixture.repository, {
        mode: 'existing',
        worktreeName: 'fork-fetch-fallback',
        branchName: 'pr/fork-fetch-fallback',
        existingBranch: 'remotes/pr-fork/feature/fork',
        prNumber: fixture.prNumber,
        baseRemote: 'base',
        setUpstream: true,
        upstreamRemote: 'pr-fork',
        upstreamBranch: 'feature/fork',
        ensureRemoteName: 'pr-fork',
        ensureRemoteUrl: unavailableFork,
      });

      await waitForWorktreeBootstrap(created.path);

      expect(runGit(created.path, ['rev-parse', 'HEAD']).trim()).toBe(fixture.baseHead);
      expect(getGitConfig(created.path, 'branch.pr/fork-fetch-fallback.remote')).toBeNull();
      expect(getGitConfig(created.path, 'branch.pr/fork-fetch-fallback.merge')).toBeNull();
    });
  });

  it('does not leave candidates for synchronous or fast creation when neither pull request source is accessible', async () => {
    if (!canRunGit()) return;

    await withTestDataHome(async (dataHome) => {
      const fixture = createPullRequestFixture();
      const unavailableFork = path.join(createTempDir(), 'missing-fork.git');
      const projectID = runGit(fixture.repository, ['rev-list', '--max-parents=0', '--all']).trim();
      const synchronousCandidate = path.join(dataHome, 'opencode', 'worktree', projectID, 'double-source-failure-sync');
      const fastCandidate = path.join(dataHome, 'opencode', 'worktree', projectID, 'double-source-failure');

      await expect(createWorktree(fixture.repository, {
        mode: 'existing',
        worktreeName: 'double-source-failure-sync',
        branchName: 'pr/double-source-failure-sync',
        existingBranch: 'remotes/pr-fork/feature/fork',
        prNumber: fixture.prNumber + 1,
        baseRemote: 'base',
        setUpstream: true,
        upstreamRemote: 'pr-fork',
        upstreamBranch: 'feature/fork',
        ensureRemoteName: 'pr-fork',
        ensureRemoteUrl: unavailableFork,
      })).rejects.toMatchObject({ code: 'pull_request_unavailable' });

      expect(fs.existsSync(synchronousCandidate)).toBe(false);

      await expect(createWorktree(fixture.repository, {
        mode: 'existing',
        worktreeName: 'double-source-failure',
        branchName: 'pr/double-source-failure',
        existingBranch: 'remotes/pr-fork/feature/fork',
        prNumber: fixture.prNumber + 1,
        baseRemote: 'base',
        setUpstream: true,
        upstreamRemote: 'pr-fork',
        upstreamBranch: 'feature/fork',
        ensureRemoteName: 'pr-fork',
        ensureRemoteUrl: unavailableFork,
        returnAfterDirectoryCreated: true,
      })).rejects.toThrow('pull_request_unavailable');

      expect(fs.existsSync(fastCandidate)).toBe(false);
    });
  });

  it('does not configure tracking when a deferred upstream fetch fails', async () => {
    if (!canRunGit()) return;

    await withTestDataHome(async () => {
      const repository = createTempDir();
      configureRepository(repository);
      const unavailableRemote = path.join(createTempDir(), 'missing-upstream.git');
      runGit(repository, ['remote', 'add', 'broken', unavailableRemote]);

      const created = await createWorktree(repository, {
        mode: 'new',
        worktreeName: 'broken-upstream',
        branchName: 'feature/broken-upstream',
        setUpstream: true,
        upstreamRemote: 'broken',
        upstreamBranch: 'main',
        returnAfterDirectoryCreated: true,
      });

      await waitForWorktreeBootstrap(created.path);

      expect(getGitConfig(created.path, 'branch.feature/broken-upstream.remote')).toBeNull();
      expect(getGitConfig(created.path, 'branch.feature/broken-upstream.merge')).toBeNull();
    });
  });

  it('does not check out a stale fork ref after a fresh fork fetch fails', async () => {
    if (!canRunGit()) return;

    await withTestDataHome(async () => {
      const fixture = createPullRequestFixture();
      runGit(fixture.repository, ['remote', 'add', 'pr-fork', fixture.forkRemote]);
      runGit(fixture.repository, [
        'fetch',
        'pr-fork',
        '+refs/heads/feature/fork:refs/remotes/pr-fork/feature/fork',
      ]);
      expect(runGit(fixture.repository, ['rev-parse', 'refs/remotes/pr-fork/feature/fork']).trim()).toBe(fixture.forkHead);

      const unavailableFork = path.join(createTempDir(), 'missing-fork.git');
      const created = await createWorktree(fixture.repository, {
        mode: 'existing',
        worktreeName: 'stale-fork-ref',
        branchName: 'pr/stale-fork-ref',
        existingBranch: 'remotes/pr-fork/feature/fork',
        prNumber: fixture.prNumber,
        baseRemote: 'base',
        setUpstream: true,
        upstreamRemote: 'pr-fork',
        upstreamBranch: 'feature/fork',
        ensureRemoteName: 'pr-fork',
        ensureRemoteUrl: unavailableFork,
      });

      await waitForWorktreeBootstrap(created.path);

      expect(runGit(created.path, ['rev-parse', 'HEAD']).trim()).toBe(fixture.baseHead);
      expect(getGitConfig(created.path, 'branch.pr/stale-fork-ref.remote')).toBeNull();
      expect(getGitConfig(created.path, 'branch.pr/stale-fork-ref.merge')).toBeNull();
    });
  });
});

describe('renameBranch', () => {
  it('clears inherited tracking when the renamed branch cannot refresh its upstream', async () => {
    if (!canRunGit()) return;

    const repository = createTempDir();
    configureRepository(repository);
    const unavailableRemote = path.join(createTempDir(), 'missing-upstream.git');
    runGit(repository, ['checkout', '-b', 'feature/tracked-old']);
    runGit(repository, ['remote', 'add', 'broken', unavailableRemote]);
    runGit(repository, ['config', 'branch.feature/tracked-old.remote', 'broken']);
    runGit(repository, ['config', 'branch.feature/tracked-old.merge', 'refs/heads/main']);

    await expect(renameBranch(repository, 'feature/tracked-old', 'feature/tracked-new')).resolves.toMatchObject({
      success: true,
      branch: 'feature/tracked-new',
    });

    expect(getGitConfig(repository, 'branch.feature/tracked-new.remote')).toBeNull();
    expect(getGitConfig(repository, 'branch.feature/tracked-new.merge')).toBeNull();
  });

});

describe('branch tracking cleanup', () => {
  it('ignores only an absent config key while clearing inherited tracking', async () => {
    const calls = [];
    await clearBranchTracking('/repo', 'feature/new', async (_directory, args) => {
      calls.push(args);
      if (args.at(-1) === 'branch.feature/new.remote') {
        return { success: false, exitCode: 5, stdout: '', stderr: '', message: 'Command failed' };
      }
      return { success: true, exitCode: 0, stdout: '', stderr: '' };
    });

    expect(calls).toEqual([
      ['config', '--unset-all', 'branch.feature/new.remote'],
      ['config', '--unset-all', 'branch.feature/new.merge'],
    ]);
  });

  it('propagates unexpected tracking config failures', async () => {
    const configLockFailure = {
      success: false,
      exitCode: 128,
      stdout: '',
      stderr: 'fatal: could not lock config file .git/config: File exists',
      message: 'fatal: could not lock config file .git/config: File exists',
    };

    await expect(clearBranchTracking('/repo', 'feature/new', async () => configLockFailure))
      .rejects.toThrow('could not lock config file');
  });
});

// ---------------------------------------------------------------------------
// removeWorktree
// ---------------------------------------------------------------------------

describe('removeWorktree', () => {
  it('forgets unmanaged orphan worktree entries without deleting files', async () => {
    if (!canRunGit()) return;

    const previousXdgDataHome = process.env.XDG_DATA_HOME;
    const dataHome = createTempDir();
    process.env.XDG_DATA_HOME = dataHome;

    try {
      const repo = createTempDir();
      const sentinel = createTempDir();
      const canary = path.join(sentinel, 'canary.txt');

      runGit(repo, ['init', '-b', 'main']);
      runGit(repo, ['config', 'user.email', 'test@example.com']);
      runGit(repo, ['config', 'user.name', 'Test User']);
      fs.writeFileSync(path.join(repo, 'README.md'), '# Test\n');
      runGit(repo, ['add', 'README.md']);
      runGit(repo, ['commit', '-m', 'Initial commit']);
      fs.writeFileSync(canary, 'sentinel');

      await expect(removeWorktree(repo, {
        directory: sentinel,
        deleteLocalBranch: false,
      })).resolves.toBe(true);
      expect(fs.existsSync(canary)).toBe(true);
    } finally {
      if (previousXdgDataHome === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = previousXdgDataHome;
      }
    }
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
