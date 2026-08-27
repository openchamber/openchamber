import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import simpleGit from 'simple-git';

import {
  checkoutCommit,
  cherryPick,
  createWorktree,
  getWorktreeBootstrapStatus,
  getBranches,
  getRangeDiff,
  getStatus,
  getWorktrees,
  isGitRepository,
  populateWorktreeWithLockRecovery,
  removeWorktree,
  resolvePrimaryWorktreeRoot,
  resolveWorktreeTopLevel,
  resetToCommit,
  resolveBaseRefForLog,
  revertCommit,
  setLocalIdentity,
  stageFiles,
  unstageFiles,
  applyHunk,
  getDiff,
  getFileDiff,
  validateWorktreeCreate,
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

      await expect.poll(() => fs.existsSync(setupMarker), { timeout: 5_000 }).toBe(true);
      await expect(getWorktreeBootstrapStatus(created.path)).resolves.toMatchObject({
        status: 'pending',
        phase: 'git-ready',
        error: null,
      });

      await expect.poll(
        async () => (await getWorktreeBootstrapStatus(created.path)).phase,
        { timeout: 5_000 },
      ).toBe('setup-ready');
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

      await expect.poll(() => fs.existsSync(setupStarted), { timeout: 5_000 }).toBe(true);
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
// createWorktree from a forked GitHub PR head (issue #2422)
// ---------------------------------------------------------------------------

describe('createWorktree from a forked GitHub PR', () => {
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

  const publishForkHead = (repository, forkBare, branchName) => {
    fs.writeFileSync(path.join(repository, 'FORK.md'), `# ${branchName}\n`);
    runGit(repository, ['add', 'FORK.md']);
    runGit(repository, ['commit', '-m', `fork ${branchName}`]);
    const sha = runGit(repository, ['rev-parse', 'HEAD']).trim();
    runGit(repository, ['push', forkBare, `HEAD:refs/heads/${branchName}`]);
    return sha;
  };

  const getBranchTrackingRemote = (directory, branch) => {
    try {
      return runGit(directory, ['config', '--get', `branch.${branch}.remote`]).trim();
    } catch {
      return '';
    }
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

  it('creates a worktree from a reachable fork head remote', async () => {
    if (!canRunGit()) return;

    await withDataHome(async () => {
      const { repository } = createRepositoryWithRemote();
      const fork = createTempDir();
      runGit(fork, ['init', '--bare']);
      const sha = publishForkHead(repository, fork, 'feature/login');

      const created = await createWorktree(repository, forkWorktreeInput({
        fork,
        worktreeName: 'pr-42',
      }));

      expect(created.branch).toBe('feature/login');
      expect(runGit(created.path, ['rev-parse', 'HEAD']).trim()).toBe(sha);
      await expect.poll(() => fs.existsSync(path.join(created.path, 'FORK.md')), { timeout: 5_000 }).toBe(true);
      expect(runGit(repository, ['remote', 'get-url', 'pr-alice']).trim()).toBe(fork);
      await expect.poll(
        () => getBranchTrackingRemote(created.path, 'feature/login') === 'pr-alice',
        { timeout: 5_000 }
      ).toBe(true);
    });
  }, 30_000);

  it('rejects an unreachable fork with an actionable error and no worktree', async () => {
    if (!canRunGit()) return;

    await withDataHome(async () => {
      const { repository } = createRepositoryWithRemote();
      const missingFork = path.join(createTempDir(), 'missing-fork.git');
      const before = runGit(repository, ['worktree', 'list', '--porcelain']);

      await expect(createWorktree(repository, forkWorktreeInput({
        fork: missingFork,
        worktreeName: 'pr-42-unreachable',
      }))).rejects.toThrow(/Unable to (reach|fetch)/i);

      expect(runGit(repository, ['worktree', 'list', '--porcelain'])).toBe(before);

      const validation = await validateWorktreeCreate(repository, forkWorktreeInput({
        fork: missingFork,
        worktreeName: 'pr-42-unreachable',
      }));
      expect(validation.ok).toBe(false);
      expect(validation.errors.some((error) => /Unable to (reach|fetch)/i.test(error.message))).toBe(true);
    });
  }, 30_000);

  it('does not write upstream tracking when the upstream ref cannot be fetched', async () => {
    if (!canRunGit()) return;

    await withDataHome(async () => {
      const { repository } = createRepositoryWithRemote();
      runGit(repository, ['branch', 'feature/tracking']);
      const emptyRemote = createTempDir();
      runGit(emptyRemote, ['init', '--bare']);
      runGit(repository, ['remote', 'add', 'broken-upstream', emptyRemote]);

      const created = await createWorktree(repository, {
        mode: 'existing',
        branchName: 'feature/tracking-wt',
        worktreeName: 'feature-tracking-wt',
        existingBranch: 'feature/tracking',
        setUpstream: true,
        upstreamRemote: 'broken-upstream',
        upstreamBranch: 'does-not-exist',
      });

      await expect.poll(
        () => getWorktreeBootstrapStatus(created.path).then((status) => status.status === 'ready' || status.status === 'failed'),
        { timeout: 5_000 }
      ).toBe(true);

      expect(getBranchTrackingRemote(created.path, 'feature/tracking-wt')).toBe('');
    });
  }, 30_000);
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
