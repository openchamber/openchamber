import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import simpleGit from 'simple-git';

import {
  checkoutCommit,
  cherryPick,
  cloneRepository,
  createWorktree,
  getIgnoredPaths,
  getStatus,
  getWorktreeBootstrapStatus,
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
  isGitRepository,
} from './service.js';
import {
  GitExecutionOverloadedError,
  GitExecutionQueueTimeoutError,
  GitExecutionReentrancyError,
} from './execution-errors.js';
import { GIT_OPERATION_KIND } from './execution-coordinator.js';

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

const waitFor = async (predicate, message, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(message);
};

const withTimeout = async (promise, message, timeoutMs = 5_000) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
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
// isGitRepository
// ---------------------------------------------------------------------------

describe('isGitRepository', () => {
  it('returns false only for confirmed non-repositories and true for repositories', async () => {
    if (!canRunGit()) return;
    const nonRepository = createTempDir();
    await expect(isGitRepository(nonRepository)).resolves.toBe(false);

    const repository = createTempDir();
    runGit(repository, ['init', '-b', 'main']);
    await expect(isGitRepository(repository)).resolves.toBe(true);
  });

  it('does not turn an infrastructure cwd failure into a non-repository result', async () => {
    if (!canRunGit()) return;
    const directory = createTempDir();
    const filePath = path.join(directory, 'not-a-directory');
    fs.writeFileSync(filePath, 'file');

    await expect(isGitRepository(filePath)).rejects.toThrow();
  });
});

describe('cloneRepository', () => {
  it('clones a local repository through a destination reservation', async () => {
    if (!canRunGit()) return;
    const source = createTempDir();
    runGit(source, ['init', '-b', 'main']);
    runGit(source, ['config', 'user.email', 'test@example.com']);
    runGit(source, ['config', 'user.name', 'Test User']);
    fs.writeFileSync(path.join(source, 'README.md'), '# source\n');
    runGit(source, ['add', 'README.md']);
    runGit(source, ['commit', '-m', 'Initial']);

    const parent = createTempDir();
    const destination = path.join(parent, 'clone');
    await expect(cloneRepository({ remoteUrl: source, destination })).resolves.toBeTypeOf('string');
    expect(fs.existsSync(path.join(destination, '.git'))).toBe(true);

    await expect(cloneRepository({ remoteUrl: source, destination })).rejects.toMatchObject({ code: 'EEXIST' });
  });
});

describe('getIgnoredPaths', () => {
  it('returns only paths ignored by the repository', async () => {
    if (!canRunGit()) return;
    const repository = createTempDir();
    runGit(repository, ['init', '-b', 'main']);
    fs.writeFileSync(path.join(repository, '.gitignore'), 'ignored.txt\n');

    await expect(getIgnoredPaths(repository, ['ignored.txt', 'visible.txt']))
      .resolves.toEqual(['ignored.txt']);
  });
});

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

  it('preserves authoritative external Git lock failures', async () => {
    if (!canRunGit()) return;
    const repository = createTempDir();
    runGit(repository, ['init', '-b', 'main']);
    fs.writeFileSync(path.join(repository, 'file.txt'), 'content\n');
    fs.writeFileSync(path.join(repository, '.git', 'index.lock'), 'external owner\n');

    await expect(stageFiles(repository, ['file.txt']))
      .rejects.toThrow(/index\.lock|another git process|file exists/i);
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

  it('preserves light and full response shapes', async () => {
    if (!canRunGit()) return;

    const repo = createTempDir();
    runGit(repo, ['init', '-b', 'main']);
    runGit(repo, ['config', 'user.email', 'test@example.com']);
    runGit(repo, ['config', 'user.name', 'Test User']);
    fs.writeFileSync(path.join(repo, 'README.md'), '# Test\n');
    runGit(repo, ['add', 'README.md']);
    runGit(repo, ['commit', '-m', 'Initial commit']);
    fs.writeFileSync(path.join(repo, 'new.md'), 'one\ntwo\n');

    const light = await getStatus(repo, { mode: 'light' });
    const full = await getStatus(repo);

    expect(light).toMatchObject({ current: 'main' });
    expect(light.diffStats).toBeUndefined();
    expect(light.upstreamComparison).toBeUndefined();
    expect(full.diffStats['new.md']).toEqual({ insertions: 2, deletions: 0 });
  });

  it('returns consistent status for concurrent getStatus calls', async () => {
    if (!canRunGit()) return;

    const repo = createTempDir();
    runGit(repo, ['init', '-b', 'main']);
    runGit(repo, ['config', 'user.email', 'test@example.com']);
    runGit(repo, ['config', 'user.name', 'Test User']);
    fs.writeFileSync(path.join(repo, 'README.md'), '# Test\n');
    runGit(repo, ['add', 'README.md']);
    runGit(repo, ['commit', '-m', 'Initial commit']);
    fs.writeFileSync(path.join(repo, 'new.md'), 'new file\n');

    const [r1, r2, r3] = await Promise.all([
      getStatus(repo),
      getStatus(repo),
      getStatus(repo),
    ]);

    expect(r1).toMatchObject({ current: 'main' });
    expect(r1.files).toEqual(r2.files);
    expect(r2.files).toEqual(r3.files);
  });

  it('queues getStatus behind a mutating stage operation', async () => {
    if (!canRunGit()) return;

    const repo = createTempDir();
    runGit(repo, ['init', '-b', 'main']);
    runGit(repo, ['config', 'user.email', 'test@example.com']);
    runGit(repo, ['config', 'user.name', 'Test User']);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    runGit(repo, ['add', 'a.txt']);
    runGit(repo, ['commit', '-m', 'Initial commit']);
    fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n');

    // getStatus should complete without error even when a stage is in-flight
    await Promise.all([
      stageFiles(repo, ['b.txt']),
      getStatus(repo),
    ]);
  });

  it('shares serialization between a primary repo and its linked worktree', async () => {
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
    fs.writeFileSync(path.join(worktree, 'wt.md'), 'worktree file\n');

    const [r1, r2] = await Promise.all([
      getStatus(repo),
      getStatus(worktree),
    ]);

    expect(r1).toMatchObject({ current: 'main' });
    expect(r2).toMatchObject({ current: 'feature/test' });
  });

  it('handles a repository subdirectory in a monorepo', async () => {
    if (!canRunGit()) return;

    const repo = createTempDir();
    const subdirectory = path.join(repo, 'packages', 'app');
    runGit(repo, ['init', '-b', 'main']);
    runGit(repo, ['config', 'user.email', 'test@example.com']);
    runGit(repo, ['config', 'user.name', 'Test User']);
    fs.mkdirSync(subdirectory, { recursive: true });
    fs.writeFileSync(path.join(repo, 'README.md'), '# Test\n');
    runGit(repo, ['add', 'README.md']);
    runGit(repo, ['commit', '-m', 'Initial commit']);
    fs.writeFileSync(path.join(subdirectory, 'app.md'), 'app file\n');

    const [rootStatus, subStatus] = await Promise.all([
      getStatus(repo),
      getStatus(subdirectory),
    ]);

    expect(rootStatus).toMatchObject({ current: 'main' });
    expect(subStatus).toMatchObject({ current: 'main' });
  });

  it('allows concurrent getStatus across unrelated repositories', async () => {
    if (!canRunGit()) return;

    const repoA = createTempDir();
    const repoB = createTempDir();

    runGit(repoA, ['init', '-b', 'main']);
    runGit(repoA, ['config', 'user.email', 'test@example.com']);
    runGit(repoA, ['config', 'user.name', 'Test User']);
    fs.writeFileSync(path.join(repoA, 'a.md'), '# A\n');
    runGit(repoA, ['add', 'a.md']);
    runGit(repoA, ['commit', '-m', 'Init A']);

    runGit(repoB, ['init', '-b', 'main']);
    runGit(repoB, ['config', 'user.email', 'test@example.com']);
    runGit(repoB, ['config', 'user.name', 'Test User']);
    fs.writeFileSync(path.join(repoB, 'b.md'), '# B\n');
    runGit(repoB, ['add', 'b.md']);
    runGit(repoB, ['commit', '-m', 'Init B']);

    const [rA, rB] = await Promise.all([
      getStatus(repoA),
      getStatus(repoB),
    ]);

    expect(rA).toMatchObject({ current: 'main' });
    expect(rB).toMatchObject({ current: 'main' });
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
// validateWorktreeCreate
// ---------------------------------------------------------------------------

describe('validateWorktreeCreate', () => {
  it('preserves structured coordinator overload, queue-timeout, and re-entry errors', async () => {
    const errors = [
      new GitExecutionOverloadedError('overloaded'),
      new GitExecutionQueueTimeoutError('timed out'),
      new GitExecutionReentrancyError('re-entry'),
    ];

    for (const error of errors) {
      const runOperation = vi.fn(async () => {
        throw error;
      });
      await expect(validateWorktreeCreate('/repo', {}, { runOperation })).rejects.toBe(error);
    }
  });

  it('keeps ordinary Git validation failures in the existing result envelope', async () => {
    const runOperation = vi.fn(async () => {
      throw new Error('ordinary validation failure');
    });

    await expect(validateWorktreeCreate('/repo', {}, { runOperation })).resolves.toEqual({
      ok: false,
      errors: [{ code: 'validation_failed', message: 'ordinary validation failure' }],
    });
  });

  it('preserves ordinary core validation details for an unresolved start ref', async () => {
    if (!canRunGit()) return;
    const repo = createTempDir();
    runGit(repo, ['init', '-b', 'main']);
    runGit(repo, ['config', 'user.email', 'test@example.com']);
    runGit(repo, ['config', 'user.name', 'Test User']);
    fs.writeFileSync(path.join(repo, 'README.md'), '# Test\n');
    runGit(repo, ['add', 'README.md']);
    runGit(repo, ['commit', '-m', 'Initial commit']);

    const result = await validateWorktreeCreate(repo, {
      mode: 'new',
      branchName: 'feature/new',
      startRef: 'missing-start-ref',
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual({
      code: 'start_ref_not_found',
      message: 'Start ref not found: missing-start-ref',
    });
  });

  it('executes the unscheduled validation core once with the already-held common lease', async () => {
    const lease = { kind: GIT_OPERATION_KIND.COMMON_WRITE, active: true };
    const validateCore = vi.fn(async (_directory, _input, receivedLease) => {
      expect(receivedLease).toBe(lease);
      return { ok: true, errors: [], resolved: { mode: 'new', localBranch: null } };
    });
    const runOperation = vi.fn(async (_name, _directory, _label, task, options) => {
      expect(options).toEqual({ network: false });
      return task({ commonId: 'common', worktreeId: 'worktree' }, lease);
    });

    await expect(validateWorktreeCreate('/repo', {}, { runOperation, validateCore })).resolves.toMatchObject({ ok: true });
    expect(runOperation).toHaveBeenCalledTimes(1);
    expect(validateCore).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// createWorktree
// ---------------------------------------------------------------------------

describe('createWorktree', () => {
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

  it('releases the outer topology lease before background attachment and reaches ready', async () => {
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

      const created = await withTimeout(createWorktree(repo, {
        mode: 'new',
        branchName: 'feature/fast-ready',
        worktreeName: 'fast-ready',
        returnAfterDirectoryCreated: true,
      }), 'Fast worktree creation deadlocked');

      expect(created).toMatchObject({
        directoryCreated: true,
        bootstrapStatus: { status: 'pending', error: null },
      });

      const ready = await waitFor(async () => {
        const status = await getWorktreeBootstrapStatus(created.path);
        return status.status === 'ready' ? status : null;
      }, 'Fast worktree bootstrap did not reach ready');
      expect(ready).toMatchObject({ status: 'ready', error: null });
      expect(runGit(repo, ['worktree', 'list', '--porcelain'])).toContain(created.path);
    } finally {
      if (previousXdgDataHome === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = previousXdgDataHome;
      }
    }
  });

  it('preserves pending then failed polling when background attachment fails', async () => {
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

      const created = await withTimeout(createWorktree(repo, {
        mode: 'new',
        branchName: 'invalid branch name',
        worktreeName: 'fast-failed',
        returnAfterDirectoryCreated: true,
      }), 'Fast failed worktree creation deadlocked');

      expect(created.bootstrapStatus).toMatchObject({ status: 'pending', error: null });

      const failed = await waitFor(async () => {
        const status = await getWorktreeBootstrapStatus(created.path);
        return status.status === 'failed' ? status : null;
      }, 'Fast worktree bootstrap did not expose failure');
      expect(failed.status).toBe('failed');
      expect(failed.error).toMatch(/valid branch name|failed to create git worktree/i);
      await waitFor(() => !fs.existsSync(created.path), 'Failed fast-create directory cleanup did not settle');
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
