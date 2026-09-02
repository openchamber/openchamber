import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import simpleGit from 'simple-git';

import {
  checkoutBranch,
  checkoutCommit,
  cherryPick,
  clearBranchTracking,
  createWorktree,
  getWorktreeBootstrapStatus,
  getBranches,
  getUnpushedBranchCounts,
  getRangeDiff,
  getStatus,
  getWorktrees,
  isGitRepository,
  populateWorktreeWithLockRecovery,
  renameBranch,
  removeWorktree,
  resolvePrimaryWorktreeRoot,
  resolveWorktreeTopLevel,
  resetToCommit,
  resolveBaseRefForLog,
  revertCommit,
  setLocalIdentity,
  stageFiles,
  unstageFiles,
  validateWorktreeCreate,
  applyHunk,
  getDiff,
  getFileDiff,
  parseBranchCreationSource,
  getRangeFiles,
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

/**
 * A repository on `next` whose only remote publishes `defaultBranch` and has it
 * recorded as that remote's HEAD — the shape of every repository whose default
 * branch is not one of the conventional names.
 */
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

describe.runIf(canRunGit())('setLocalIdentity', () => {
  it('configures the local SSH command with the targeted simple-git opt-in', async () => {
    const { tmpDir } = await createTempRepo();

    await setLocalIdentity(tmpDir, {
      userName: 'SSH User',
      userEmail: 'ssh@example.com',
      authType: 'ssh',
      sshKey: '/tmp/test key',
    });

    expect(runGit(tmpDir, ['config', '--local', '--get', 'core.sshCommand']).trim()).toBe(
      "ssh -i '/tmp/test key' -o IdentitiesOnly=yes"
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

describe('symlink diffs', () => {
  it('treats an untracked directory symlink as a link in patch and split diffs', async () => {
    if (!canRunGit() || process.platform === 'win32') return;
    const { tmpDir } = await createTempRepo();
    fs.mkdirSync(path.join(tmpDir, 'source'));
    fs.symlinkSync('source', path.join(tmpDir, 'linked-source'));

    const patch = await getDiff(tmpDir, { path: 'linked-source' });
    const split = await getFileDiff(tmpDir, { path: 'linked-source' });

    expect(patch).toContain('new file mode 120000');
    expect(patch).toContain('+source');
    expect(split).toMatchObject({
      original: '',
      modified: 'source',
      isBinary: false,
    });
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

  it('rejects a non-git folder without using process.cwd()', async () => {
    if (!canRunGit()) return;

    const nonGit = createTempDir();
    const previousCwd = process.cwd();
    process.chdir(nonGit);
    try {
      await expect(getStatus(nonGit)).rejects.toThrow(/not a git repository/i);
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('reads status for a git repo when process.cwd() is elsewhere', async () => {
    if (!canRunGit()) return;

    const repo = createTempDir();
    const neutralCwd = createTempDir();
    runGit(repo, ['init', '-b', 'main']);
    runGit(repo, ['config', 'user.email', 'test@example.com']);
    runGit(repo, ['config', 'user.name', 'Test User']);
    fs.writeFileSync(path.join(repo, 'README.md'), '# Test\n');
    runGit(repo, ['add', 'README.md']);
    runGit(repo, ['commit', '-m', 'Initial commit']);

    const previousCwd = process.cwd();
    process.chdir(neutralCwd);
    try {
      await expect(getStatus(repo)).resolves.toMatchObject({ current: 'main', isClean: true });
      await expect(isGitRepository(repo)).resolves.toBe(true);
      await expect(isGitRepository(neutralCwd)).resolves.toBe(false);
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('supports a folder with nested git repositories from a foreign cwd', async () => {
    if (!canRunGit()) return;

    const parent = createTempDir();
    const nested = path.join(parent, 'nested');
    const neutralCwd = createTempDir();
    fs.mkdirSync(nested, { recursive: true });

    runGit(parent, ['init', '-b', 'main']);
    runGit(parent, ['config', 'user.email', 'test@example.com']);
    runGit(parent, ['config', 'user.name', 'Test User']);
    fs.writeFileSync(path.join(parent, 'README.md'), '# Parent\n');
    runGit(parent, ['add', 'README.md']);
    runGit(parent, ['commit', '-m', 'Parent commit']);

    runGit(nested, ['init', '-b', 'feature']);
    runGit(nested, ['config', 'user.email', 'test@example.com']);
    runGit(nested, ['config', 'user.name', 'Test User']);
    fs.writeFileSync(path.join(nested, 'nested.txt'), 'nested\n');
    runGit(nested, ['add', 'nested.txt']);
    runGit(nested, ['commit', '-m', 'Nested commit']);

    const previousCwd = process.cwd();
    process.chdir(neutralCwd);
    try {
      await expect(getStatus(parent)).resolves.toMatchObject({ current: 'main' });
      await expect(getStatus(nested)).resolves.toMatchObject({ current: 'feature' });
      // Enumeration must continue when one path is not a repo.
      const results = await Promise.allSettled([
        getStatus(parent),
        getStatus(neutralCwd),
        getStatus(nested),
      ]);
      expect(results[0].status).toBe('fulfilled');
      expect(results[1].status).toBe('rejected');
      expect(results[1].reason?.message || String(results[1].reason)).toMatch(/not a git repository/i);
      expect(results[2].status).toBe('fulfilled');
    } finally {
      process.chdir(previousCwd);
    }
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
// getWorktrees
// ---------------------------------------------------------------------------

describe('getWorktrees', () => {
  if (!canRunGit()) {
    it.skip('git binary not available', () => {});
    return;
  }

  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

  afterEach(() => {
    warnSpy.mockClear();
  });

  afterAll(() => {
    warnSpy.mockRestore();
  });

  it('returns an empty list for a non-git directory without warning', async () => {
    const nonGit = createTempDir();

    const result = await getWorktrees(nonGit);

    expect(result).toEqual([]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('returns the worktrees for a real git repository', async () => {
    const repo = createTempDir();
    runGit(repo, ['init', '-b', 'main']);
    runGit(repo, ['config', 'user.email', 'test@example.com']);
    runGit(repo, ['config', 'user.name', 'Test User']);
    fs.writeFileSync(path.join(repo, 'README.md'), '# Test\n');
    runGit(repo, ['add', 'README.md']);
    runGit(repo, ['commit', '-m', 'init']);

    const result = await getWorktrees(repo);

    expect(Array.isArray(result)).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
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

  const installPostCheckoutHook = (repo, script, executable = true) => {
    const hookPath = path.join(repo, '.git', 'hooks', 'post-checkout');
    fs.writeFileSync(hookPath, script);
    if (executable) {
      fs.chmodSync(hookPath, 0o755);
    }
    return hookPath;
  };

  it('runs the post-checkout hook after populating a created worktree', async () => {
    if (!canRunGit()) return;

    const previousXdgDataHome = process.env.XDG_DATA_HOME;
    const dataHome = createTempDir();
    process.env.XDG_DATA_HOME = dataHome;

    try {
      const repo = createTempDir();
      runGit(repo, ['init', '-b', 'main']);
      runGit(repo, ['config', 'user.email', 'test@example.com']);
      runGit(repo, ['config', 'user.name', 'Test User']);
      fs.writeFileSync(path.join(repo, 'README.md'), '# Test\n');
      runGit(repo, ['add', 'README.md']);
      runGit(repo, ['commit', '-m', 'Initial commit']);
      const head = runGit(repo, ['rev-parse', 'HEAD']).trim();

      const hookLog = path.join(dataHome, 'post-checkout.log');
      installPostCheckoutHook(
        repo,
        `#!/bin/sh\nprintf '%s|%s|%s|%s' "$1" "$2" "$3" "$(pwd -P)" > ${JSON.stringify(hookLog)}\n`,
      );

      const created = await createWorktree(repo, {
        mode: 'new',
        worktreeName: 'hook-test',
        branchName: 'openchamber/hook-test',
        returnAfterDirectoryCreated: true,
      });

      await expect.poll(() => {
        try {
          return fs.readFileSync(hookLog, 'utf8');
        } catch {
          return '';
        }
      }, { timeout: 5_000 }).not.toBe('');

      const [previousHead, newHead, flag, cwd] = fs.readFileSync(hookLog, 'utf8').split('|');
      expect(previousHead).toBe('0000000000000000000000000000000000000000');
      expect(newHead).toBe(head);
      expect(flag).toBe('1');
      expect(cwd).toBe(fs.realpathSync(created.path));
    } finally {
      if (previousXdgDataHome === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = previousXdgDataHome;
      }
    }
  });

  it('skips a non-executable post-checkout hook', async () => {
    if (!canRunGit()) return;

    const previousXdgDataHome = process.env.XDG_DATA_HOME;
    const dataHome = createTempDir();
    process.env.XDG_DATA_HOME = dataHome;

    try {
      const repo = createTempDir();
      runGit(repo, ['init', '-b', 'main']);
      runGit(repo, ['config', 'user.email', 'test@example.com']);
      runGit(repo, ['config', 'user.name', 'Test User']);
      fs.writeFileSync(path.join(repo, 'README.md'), '# Test\n');
      runGit(repo, ['add', 'README.md']);
      runGit(repo, ['commit', '-m', 'Initial commit']);

      const hookLog = path.join(dataHome, 'post-checkout-skipped.log');
      installPostCheckoutHook(
        repo,
        `#!/bin/sh\nprintf 'ran' > ${JSON.stringify(hookLog)}\n`,
        false,
      );

      const created = await createWorktree(repo, {
        mode: 'new',
        worktreeName: 'hook-skip-test',
        branchName: 'openchamber/hook-skip-test',
        returnAfterDirectoryCreated: true,
      });

      await expect.poll(
        async () => (await getWorktreeBootstrapStatus(created.path)).status,
        { timeout: 5_000 },
      ).toBe('ready');
      expect(fs.existsSync(hookLog)).toBe(false);
    } finally {
      if (previousXdgDataHome === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = previousXdgDataHome;
      }
    }
  });

  it('does not fail worktree bootstrap when the post-checkout hook fails', async () => {
    if (!canRunGit()) return;

    const previousXdgDataHome = process.env.XDG_DATA_HOME;
    const dataHome = createTempDir();
    process.env.XDG_DATA_HOME = dataHome;

    try {
      const repo = createTempDir();
      runGit(repo, ['init', '-b', 'main']);
      runGit(repo, ['config', 'user.email', 'test@example.com']);
      runGit(repo, ['config', 'user.name', 'Test User']);
      fs.writeFileSync(path.join(repo, 'README.md'), '# Test\n');
      runGit(repo, ['add', 'README.md']);
      runGit(repo, ['commit', '-m', 'Initial commit']);

      const hookLog = path.join(dataHome, 'post-checkout-failed.log');
      installPostCheckoutHook(
        repo,
        `#!/bin/sh\nprintf 'ran' > ${JSON.stringify(hookLog)}\nexit 1\n`,
      );

      const created = await createWorktree(repo, {
        mode: 'new',
        worktreeName: 'hook-fail-test',
        branchName: 'openchamber/hook-fail-test',
        returnAfterDirectoryCreated: true,
      });

      await expect.poll(
        async () => (await getWorktreeBootstrapStatus(created.path)).status,
        { timeout: 5_000 },
      ).toBe('ready');
      expect(fs.readFileSync(hookLog, 'utf8')).toBe('ran');
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

  it('configures tracking after a deferred upstream fetch succeeds', async () => {
    if (!canRunGit()) return;

    await withTestDataHome(async () => {
      const fixture = createPullRequestFixture();
      const created = await createWorktree(fixture.repository, {
        mode: 'new',
        worktreeName: 'deferred-upstream',
        branchName: 'feature/deferred-upstream',
        setUpstream: true,
        upstreamRemote: 'base',
        upstreamBranch: 'main',
        returnAfterDirectoryCreated: true,
      });

      await waitForWorktreeBootstrap(created.path);

      expect(getGitConfig(created.path, 'branch.feature/deferred-upstream.remote')).toBe('base');
      expect(getGitConfig(created.path, 'branch.feature/deferred-upstream.merge')).toBe('refs/heads/main');
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
// checkoutBranch
// ---------------------------------------------------------------------------

describe('checkoutBranch', () => {
  it('checks out a local branch by name', async () => {
    const { repository } = createRepositoryWithRemote();
    runGit(repository, ['branch', 'feature']);

    const result = await checkoutBranch(repository, 'feature');

    expect(result).toEqual({ success: true, branch: 'feature' });
    expect(runGit(repository, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('feature');
  });

  it('creates a tracking local branch instead of detaching HEAD on a remote branch', async () => {
    const { repository } = createRepositoryWithRemote({ defaultBranch: 'react' });

    const result = await checkoutBranch(repository, 'origin/react');

    expect(result).toEqual({ success: true, branch: 'react' });
    expect(runGit(repository, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('react');
    expect(runGit(repository, ['rev-parse', '--abbrev-ref', 'react@{upstream}']).trim()).toBe('origin/react');
  });

  it('checks out the existing local branch when a remote branch is picked', async () => {
    const { repository } = createRepositoryWithRemote({ defaultBranch: 'react' });
    runGit(repository, ['branch', 'react', 'origin/react']);

    const result = await checkoutBranch(repository, 'origin/react');

    expect(result).toEqual({ success: true, branch: 'react' });
    expect(runGit(repository, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('react');
  });

  it('accepts the remotes/ prefixed form of a remote branch', async () => {
    const { repository } = createRepositoryWithRemote({ defaultBranch: 'react' });

    const result = await checkoutBranch(repository, 'remotes/origin/react');

    expect(result).toEqual({ success: true, branch: 'react' });
    expect(runGit(repository, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('react');
  });

  it('prefers a local branch whose name looks like a remote ref', async () => {
    const { repository } = createRepositoryWithRemote({ defaultBranch: 'react' });
    runGit(repository, ['branch', 'origin/react']);

    const result = await checkoutBranch(repository, 'origin/react');

    expect(result).toEqual({ success: true, branch: 'origin/react' });
    expect(runGit(repository, ['symbolic-ref', 'HEAD']).trim()).toBe('refs/heads/origin/react');
  });

  it('rejects an unknown branch', async () => {
    const { repository } = createRepositoryWithRemote();
    await expect(checkoutBranch(repository, 'does-not-exist')).rejects.toThrow();
  });

  it('fetches a remote-only branch that was never fetched locally (#2735)', async () => {
    const { repository, remote } = createRepositoryWithRemote({ defaultBranch: 'react' });
    // A collaborator pushes straight to the remote; this repository never
    // fetches, so `remotes/origin/collab` is listed (#2098) with no local ref.
    const collaborator = createTempDir();
    runGit(collaborator, ['clone', remote, '.']);
    runGit(collaborator, ['config', 'user.email', 'test@example.com']);
    runGit(collaborator, ['config', 'user.name', 'Test']);
    runGit(collaborator, ['checkout', '-b', 'collab']);
    runGit(collaborator, ['push', 'origin', 'collab']);

    const result = await checkoutBranch(repository, 'remotes/origin/collab');

    expect(result).toEqual({ success: true, branch: 'collab' });
    expect(runGit(repository, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('collab');
    expect(runGit(repository, ['rev-parse', '--abbrev-ref', 'collab@{upstream}']).trim()).toBe('origin/collab');
  });

  it('reports a clear failure when the remote branch no longer exists', async () => {
    const { repository } = createRepositoryWithRemote({ defaultBranch: 'react' });

    await expect(checkoutBranch(repository, 'remotes/origin/never-pushed')).rejects.toThrow(
      /Failed to fetch never-pushed from origin/
    );
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

describe.runIf(canRunGit())('getBranches', () => {
  it('returns a remote default branch whose name is not a conventional fallback', async () => {
    const { repository } = createRepositoryWithRemote({ remoteName: 'origin', defaultBranch: 'react' });

    await expect(getBranches(repository)).resolves.toMatchObject({
      defaultBranches: { origin: 'react' },
    });
  });

  it('asks the remote when no local remote/HEAD exists', async () => {
    const { repository } = createRepositoryWithRemote({ remoteName: 'origin', defaultBranch: 'react' });
    // A hand-added remote can end up without this ref; the branch it points at
    // is still knowable, and guessing instead is the bug this data replaces.
    runGit(repository, ['remote', 'set-head', 'origin', '--delete']);

    await expect(getBranches(repository)).resolves.toMatchObject({
      defaultBranches: { origin: 'react' },
    });
  });

  it('keeps the branches of a remote that cannot be reached', async () => {
    const { repository, remote } = createRepositoryWithRemote({ remoteName: 'origin', defaultBranch: 'react' });
    fs.rmSync(remote, { recursive: true, force: true });

    const branches = await getBranches(repository);

    // "We could not ask" is not "the branch is gone": callers read this list to
    // decide whether a base branch exists at all.
    expect(branches.all).toContain('remotes/origin/react');
  });

  it('includes remote branches with no local tracking ref and prunes refs deleted on the remote (#2098)', async () => {
    const remote = createTempDir();
    runGit(remote, ['init', '--bare', '--initial-branch=main']);

    const repository = createTempDir();
    runGit(repository, ['init', '-b', 'main']);
    runGit(repository, ['config', 'user.email', 'test@example.com']);
    runGit(repository, ['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(repository, 'README.md'), '# Test\n');
    runGit(repository, ['add', 'README.md']);
    runGit(repository, ['commit', '-m', 'init']);
    runGit(repository, ['remote', 'add', 'origin', remote]);
    runGit(repository, ['push', '-u', 'origin', 'main']);
    runGit(repository, ['checkout', '-b', 'feature-known']);
    runGit(repository, ['push', '-u', 'origin', 'feature-known']);
    // This tracking ref will go stale: the collaborator deletes the branch on
    // the remote below, and the list must prune it.
    runGit(repository, ['checkout', '-b', 'feature-stale']);
    runGit(repository, ['push', '-u', 'origin', 'feature-stale']);
    runGit(repository, ['checkout', 'main']);
    runGit(repository, ['branch', '-D', 'feature-stale']);

    // A collaborator pushes a branch straight to the remote and deletes
    // another; this repository never fetches, so it has no local
    // remote-tracking ref for feature-remote-only.
    const collaborator = createTempDir();
    runGit(collaborator, ['clone', remote, '.']);
    runGit(collaborator, ['config', 'user.email', 'test@example.com']);
    runGit(collaborator, ['config', 'user.name', 'Test']);
    runGit(collaborator, ['checkout', '-b', 'feature-remote-only']);
    runGit(collaborator, ['push', 'origin', 'feature-remote-only']);
    runGit(collaborator, ['push', 'origin', ':feature-stale']);

    const branches = await getBranches(repository);

    expect(branches.all).toContain('remotes/origin/feature-remote-only');
    expect(branches.all).toContain('remotes/origin/feature-known');
    expect(branches.all).toContain('feature-known');
    expect(branches.all).not.toContain('remotes/origin/feature-stale');
  });
});

describe.runIf(canRunGit())('getUnpushedBranchCounts', () => {
  it('counts only commits ahead of a locally known upstream', async () => {
    const { repository } = createRepositoryWithRemote();
    runGit(repository, ['branch', '--set-upstream-to=origin/react', 'next']);
    fs.writeFileSync(path.join(repository, 'ahead.txt'), 'ahead\n');
    runGit(repository, ['add', 'ahead.txt']);
    runGit(repository, ['commit', '-m', 'ahead']);
    runGit(repository, ['checkout', '-b', 'no-upstream']);

    await expect(getUnpushedBranchCounts(repository, ['next', 'no-upstream', 'remotes/origin/react'])).resolves.toEqual({
      counts: { next: 1 },
    });
  });
});

describe.runIf(canRunGit())('getRangeDiff', () => {
  it('resolves a base that exists only on a remote other than origin', async () => {
    const { repository } = createRepositoryWithRemote({ remoteName: 'upstream', defaultBranch: 'react' });
    // Only refs/remotes/upstream/react carries the base — git cannot resolve the
    // bare name, so an unqualified `react...next` fails with "ambiguous argument".
    fs.writeFileSync(path.join(repository, 'feature.txt'), 'work\n');
    runGit(repository, ['add', 'feature.txt']);
    runGit(repository, ['commit', '-m', 'feature']);

    const diff = await getRangeDiff(repository, { base: 'react', head: 'next' });

    expect(diff).toContain('feature.txt');
  });

  it('names an unfetched remote-only ref instead of failing with git\'s ambiguous argument (#2735)', async () => {
    const { repository } = createRepositoryWithRemote({ defaultBranch: 'react' });

    await expect(
      getRangeDiff(repository, { base: 'remotes/origin/never-fetched', head: 'next' })
    ).rejects.toThrow(/is not available locally/);
  });
});

describe('parseBranchCreationSource', () => {
  it('returns the source ref from the oldest creation entry', () => {
    // Reflog lists newest entries first; creation is the last line.
    const reflog = [
      'commit: abc123',
      'branch: Created from origin/main',
    ].join('\n');
    expect(parseBranchCreationSource(reflog)).toBe('origin/main');
  });

  it('returns null when the branch was created from a detached HEAD pointer', () => {
    const reflog = 'branch: Created from HEAD@{0}';
    expect(parseBranchCreationSource(reflog)).toBeNull();
  });

  it('returns null when the branch was created from the current HEAD without a named source', () => {
    // `git switch -c <branch>` / `git checkout -b <branch>` from the current
    // branch record `branch: Created from HEAD` in the reflog (git 2.x). The
    // source branch name is not recorded, so no base can be derived from it.
    const reflog = 'branch: Created from HEAD';
    expect(parseBranchCreationSource(reflog)).toBeNull();
  });

  it('returns null when the branch was created from a raw commit', () => {
    const reflog = 'branch: Created from 9a3b2c1d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b';
    expect(parseBranchCreationSource(reflog)).toBeNull();
  });

  it('returns null when there is no creation entry', () => {
    const reflog = ['commit: abc123', 'reset: moving to HEAD'].join('\n');
    expect(parseBranchCreationSource(reflog)).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(parseBranchCreationSource('')).toBeNull();
    expect(parseBranchCreationSource(undefined)).toBeNull();
  });
});

describe.runIf(canRunGit())('getRangeFiles', () => {
  it('returns added and modified paths with their status letters', async () => {
    const { repository } = createRepositoryWithRemote();
    fs.writeFileSync(path.join(repository, 'added.txt'), 'new\n');
    fs.writeFileSync(path.join(repository, 'README.md'), '# Test\nchanged\n');
    runGit(repository, ['add', 'added.txt', 'README.md']);
    runGit(repository, ['commit', '-m', 'changes']);

    const files = await getRangeFiles(repository, { base: 'react', head: 'next' });

    expect(files).toEqual(expect.arrayContaining([
      { path: 'added.txt', status: 'A' },
      { path: 'README.md', status: 'M' },
    ]));
  });

  it('reports the destination path for renamed files, including spaces', async () => {
    const { repository } = createRepositoryWithRemote();
    // The original file must exist in the base: rename detection pairs a
    // deletion against an addition relative to base, not within the branch.
    fs.writeFileSync(path.join(repository, 'old name with spaces.md'), '# Test\n');
    runGit(repository, ['add', 'old name with spaces.md']);
    runGit(repository, ['commit', '-m', 'add file to rename']);
    runGit(repository, ['push', 'origin', 'HEAD:react']);
    // Spaces in filenames exercise the -z token split: a newline split would
    // mangle these paths long before status letters matter.
    fs.renameSync(path.join(repository, 'old name with spaces.md'), path.join(repository, 'new name with spaces.md'));
    runGit(repository, ['add', '-A']);
    runGit(repository, ['commit', '-m', 'rename']);

    const files = await getRangeFiles(repository, { base: 'react', head: 'next' });

    const renameEntry = files.find((file) => file.status === 'R');
    expect(renameEntry).toBeDefined();
    expect(renameEntry.path).toBe('new name with spaces.md');
    expect(files.some((file) => file.path === 'old name with spaces.md')).toBe(false);
  });

  it('reports the destination path for copied files', async () => {
    const { repository } = createRepositoryWithRemote();
    // The source must exist in the base. Copy detection needs the repository's
    // own `diff.renames=copies` setting on top of the service's -C flag; the
    // parser must survive whatever C entries git emits.
    runGit(repository, ['config', 'diff.renames', 'copies']);
    fs.writeFileSync(path.join(repository, 'copied source.md'), '# Copy me\n');
    runGit(repository, ['add', 'copied source.md']);
    runGit(repository, ['commit', '-m', 'add source']);
    runGit(repository, ['push', 'origin', 'HEAD:react']);
    fs.copyFileSync(path.join(repository, 'copied source.md'), path.join(repository, 'copied destination.md'));
    runGit(repository, ['add', '-A']);
    runGit(repository, ['commit', '-m', 'copy']);

    const files = await getRangeFiles(repository, { base: 'react', head: 'next' });

    const copyEntry = files.find((file) => file.status === 'C');
    expect(copyEntry).toBeDefined();
    expect(copyEntry.path).toBe('copied destination.md');
  });
});
