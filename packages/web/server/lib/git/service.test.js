import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import simpleGit from 'simple-git';
import { createWorktreeBootstrapStore } from './worktree-bootstrap-storage.js';
import { loadSourceSections, parseSource, sourceKey } from '../walkthrough/sources.js';
import { registerGitRoutes } from './routes.js';
import { normalizeGitOutputPath } from './output-path.js';

import {
  getCurrentIdentity,
  unsupportedRepositoryRootReason,
  checkoutBranch,
  checkoutCommit,
  cherryPick,
  commit,
  createWorktree,
  getWorktreeBootstrapStatus,
  getBranches,
  getRepositoryRoot,
  getUnpushedBranchCounts,
  getRangeDiff,
  getBranchBase,
  getCommitDiff,
  getCommitFiles,
  getLog,
  getStatus,
  getTrackingBranch,
  getWorktrees,
  isGitRepository,
  observeWorktreeTopology,
  populateWorktreeWithLockRecovery,
  previewWorktreeCreate,
  removeWorktree,
  snapshotWorktree,
  resolvePrimaryWorktreeRoot,
  resolveWorktreeTopLevel,
  resetToCommit,
  resolveBaseRefForLog,
  revertCommit,
  setLocalIdentity,
  clearLocalIdentity,
  configureRepositoryTransport,
  getGlobalIdentity,
  stageFiles,
  subscribeWorktreeTopologyChanges,
  unstageFiles,
  applyHunk,
  getDiff,
  getPathDiff,
  revertFile,
  getUntrackedDiffs,
  getFileDiff,
  commit,
  hasLocalIdentity,
  validateWorktreeCreate,
  parseBranchCreationSource,
  getRangeFiles,
  inspectContributorCheckoutActions,
  getConflictDetails,
  continueMerge,
  continueRebase,
  merge,
  rebase,
  removeRemote,
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
    env: process.platform === 'win32'
      ? { ...process.env, MSYS: [process.env.MSYS, 'noglob'].filter(Boolean).join(' ') }
      : process.env,
  });

const readBranchConfig = (cwd, branch, key) => {
  try {
    return runGit(cwd, ['config', '--get', `branch.${branch}.${key}`]).trim();
  } catch {
    return '';
  }
};

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
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-git-check-'));
  try {
    execFileSync('git', ['--version'], { cwd, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Tests must not depend on developer-machine git state. A global
// excludesFile (say `node_modules/` in the developer's ~/.gitignore) makes a
// fixture directory vanish from status on that machine and nowhere else, so
// every git invocation in this file — the fixtures' runGit and the service's
// own spawns, which inherit process.env — reads an empty global config
// instead. Fixture repos set their identity locally, so nothing else changes.
// Registered outside tempDirs on purpose: afterEach would delete a registered
// dir after the first test.
const emptyGlobalGitConfig = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-git-service-config-')),
  'git-config',
);
fs.writeFileSync(emptyGlobalGitConfig, '');

let savedGitConfigGlobal;

beforeAll(() => {
  savedGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = emptyGlobalGitConfig;
});

afterAll(() => {
  if (savedGitConfigGlobal === undefined) {
    delete process.env.GIT_CONFIG_GLOBAL;
  } else {
    process.env.GIT_CONFIG_GLOBAL = savedGitConfigGlobal;
  }
  fs.rmSync(path.dirname(emptyGlobalGitConfig), { recursive: true, force: true });
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

describe('unsupportedRepositoryRootReason', () => {
  it('rejects a repository rooted at a filesystem root or the home directory', () => {
    const home = path.join(os.tmpdir(), 'unsupported-root-home');
    expect(unsupportedRepositoryRootReason('/', home)).toBe('filesystem-root');
    expect(unsupportedRepositoryRootReason(path.parse(process.cwd()).root, home)).toBe('filesystem-root');
    expect(unsupportedRepositoryRootReason(home, home)).toBe('home');
    expect(unsupportedRepositoryRootReason(`${home}${path.sep}`, home)).toBe('home');
  });

  it('accepts an ordinary project root, including one directly under home', () => {
    const home = path.join(os.tmpdir(), 'unsupported-root-home');
    expect(unsupportedRepositoryRootReason(path.join(home, 'project'), home)).toBeNull();
    expect(unsupportedRepositoryRootReason(path.join(os.tmpdir(), 'repo'), home)).toBeNull();
    expect(unsupportedRepositoryRootReason('', home)).toBeNull();
  });
});

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

describe.runIf(canRunGit())('configureRepositoryTransport', () => {
  const helper = "!'/data/bin/git-credential-openchamber'";
  const helpers = (repo) => {
    try { return execFileSync('git', ['config', '--local', '--get-all', 'credential.helper'], { cwd: repo, encoding: 'utf8' }).replace(/\n$/, '').split('\n'); }
    catch { return []; }
  };
  const sshCommand = (repo) => {
    try { return execFileSync('git', ['config', '--local', '--get', 'core.sshCommand'], { cwd: repo, encoding: 'utf8' }).trim(); }
    catch { return ''; }
  };

  it('names the helper after a reset, leaves the person\'s own entries, and removes only its own', async () => {
    const repo = createTempDir();
    runGit(repo, ['init', '-b', 'main']);
    runGit(repo, ['config', '--local', 'credential.helper', 'osxkeychain']);
    await configureRepositoryTransport(repo, { credentialHelper: helper });
    expect(helpers(repo)).toEqual(['osxkeychain', '', helper]);
    // Writing the same thing again changes nothing.
    await configureRepositoryTransport(repo, { credentialHelper: helper });
    expect(helpers(repo)).toEqual(['osxkeychain', '', helper]);
    await configureRepositoryTransport(repo, { credentialHelper: null });
    expect(helpers(repo)).toEqual(['osxkeychain']);
  });

  it('keeps the person\'s own empty reset and turns on path matching only while it owns it', async () => {
    const repo = createTempDir();
    runGit(repo, ['init', '-b', 'main']);
    const local = (key) => {
      try { return execFileSync('git', ['config', '--local', '--get', key], { cwd: repo, encoding: 'utf8' }).trim(); }
      catch { return null; }
    };
    runGit(repo, ['config', '--local', '--add', 'credential.helper', '']);
    runGit(repo, ['config', '--local', '--add', 'credential.helper', 'store']);
    await configureRepositoryTransport(repo, { credentialHelper: helper });
    expect(helpers(repo)).toEqual(['', 'store', '', helper]);
    expect(local('credential.useHttpPath')).toBe('true');
    await configureRepositoryTransport(repo, { credentialHelper: null });
    expect(helpers(repo)).toEqual(['', 'store']);
    expect(local('credential.useHttpPath')).toBeNull();
    // A value the person set is left alone either way.
    runGit(repo, ['config', '--local', 'credential.useHttpPath', 'false']);
    await configureRepositoryTransport(repo, { credentialHelper: helper });
    await configureRepositoryTransport(repo, { credentialHelper: null });
    expect(local('credential.useHttpPath')).toBe('false');
  });

  it('writes and removes the managed SSH command without touching one the person wrote', async () => {
    const repo = createTempDir();
    runGit(repo, ['init', '-b', 'main']);
    const managed = "OPENCHAMBER_GIT_SSH_KEY='/data/keys/one' '/usr/bin/bun' '/srv/ssh-wrapper.js'";
    await configureRepositoryTransport(repo, { sshCommand: managed });
    expect(sshCommand(repo)).toBe(managed);
    await configureRepositoryTransport(repo, { sshCommand: null });
    expect(sshCommand(repo)).toBe('');
    runGit(repo, ['config', '--local', 'core.sshCommand', 'ssh -i ~/.ssh/mine']);
    await configureRepositoryTransport(repo, { sshCommand: null });
    expect(sshCommand(repo)).toBe('ssh -i ~/.ssh/mine');
  });
});

describe.runIf(canRunGit())('setLocalIdentity', () => {
  beforeEach(() => {
    const home = createTempDir();
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    vi.stubEnv('XDG_CONFIG_HOME', home);
    vi.stubEnv('GIT_CONFIG_GLOBAL', path.join(home, '.gitconfig'));
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    vi.stubEnv('SSH_AUTH_SOCK', path.join(home, 'unused-agent.sock'));
  });

  afterEach(() => vi.unstubAllEnvs());

  it('reads the global author for a repository that sets none, and the local one when set', async () => {
    const { tmpDir } = await createTempRepo();
    runGit(tmpDir, ['config', '--global', 'user.name', 'Global Author']);
    runGit(tmpDir, ['config', '--global', 'user.email', 'global@example.com']);
    expect(await getCurrentIdentity(tmpDir)).toEqual({ userName: 'Test User', userEmail: 'test@example.com', sshCommand: null });

    runGit(tmpDir, ['config', '--local', '--unset-all', 'user.name']);
    runGit(tmpDir, ['config', '--local', '--unset-all', 'user.email']);
    // An unset local key is a null value, not an error: the global author answers.
    expect(await getCurrentIdentity(tmpDir)).toEqual({ userName: 'Global Author', userEmail: 'global@example.com', sshCommand: null });
  });

  it('clears the author, tolerates keys that are not set, and reports a config it could not write', async () => {
    const { tmpDir } = await createTempRepo();
    await expect(clearLocalIdentity(tmpDir)).resolves.toBe(true);
    expect(await getCurrentIdentity(tmpDir)).toMatchObject({ userName: null, userEmail: null });
    // Already clear: every key exits 5, which is success.
    await expect(clearLocalIdentity(tmpDir)).resolves.toBe(true);
    runGit(tmpDir, ['config', '--local', 'user.name', 'Stays']);
    fs.writeFileSync(path.join(tmpDir, '.git', 'config.lock'), '');
    await expect(clearLocalIdentity(tmpDir)).rejects.toThrow();
    fs.rmSync(path.join(tmpDir, '.git', 'config.lock'));
    expect((await getCurrentIdentity(tmpDir)).userName).toBe('Stays');
  });

  it.each([
    ['SSH', { authType: 'ssh', sshKey: '/unused/test key' }],
    ['legacy default SSH', { sshKey: '~/unused/legacy key' }],
    ['token', { authType: 'token', host: 'example.invalid' }],
    ['HTTPS', { authType: 'https', host: 'example.invalid' }],
    ['author only', {}],
    ['global', { id: 'global' }],
  ])('preserves authentication when applying a %s profile', async (_mode, legacyFields) => {
    for (const localAuth of [false, true]) {
      const { tmpDir } = await createTempRepo();
      runGit(tmpDir, ['config', '--global', 'user.name', 'Global Author']);
      runGit(tmpDir, ['config', '--global', 'user.email', 'global@example.com']);
      runGit(tmpDir, ['config', '--global', 'core.sshCommand', "ssh -i '/unused/global key' -o IdentitiesOnly=yes"]);
      runGit(tmpDir, ['config', '--global', '--replace-all', 'credential.helper', 'global-helper']);
      if (localAuth) {
        runGit(tmpDir, ['config', '--local', 'core.sshCommand', 'ssh -F /unused/repository-config']);
        runGit(tmpDir, ['config', '--local', '--add', 'credential.helper', '']);
        runGit(tmpDir, ['config', '--local', '--add', 'credential.helper', 'repository-helper']);
        runGit(tmpDir, ['config', '--local', '--add', 'credential.helper', 'second-helper']);
      }
      const readAuth = () => runGit(tmpDir, ['config', '--null', '--get-regexp', '^(core\\.sshcommand|credential\\.helper)$']);
      const authBefore = readAuth();
      const globalBefore = fs.readFileSync(process.env.GIT_CONFIG_GLOBAL, 'utf8');
      const global = await getGlobalIdentity();
      const profile = {
        userName: 'New Author',
        userEmail: 'new@example.com',
        ...legacyFields,
      };
      if (profile.id === 'global') {
        profile.userName = global.userName;
        profile.userEmail = global.userEmail;
        profile.sshKey = global.sshCommand.replace('ssh -i ', '');
      }
      Object.freeze(profile);

      await expect(setLocalIdentity(tmpDir, profile)).resolves.toBe(true);

      expect(runGit(tmpDir, ['config', '--local', '--get', 'user.name']).trim()).toBe(profile.userName);
      expect(runGit(tmpDir, ['config', '--local', '--get', 'user.email']).trim()).toBe(profile.userEmail);
      expect(readAuth()).toBe(authBefore);
      expect(fs.readFileSync(process.env.GIT_CONFIG_GLOBAL, 'utf8')).toBe(globalBefore);
      const localConfig = runGit(tmpDir, ['config', '--local', '--list']);
      expect(localConfig.includes('core.sshcommand=')).toBe(localAuth);
      expect(localConfig.includes('credential.helper=')).toBe(localAuth);
    }
  });

  it('preserves signing settings unless SSH signing is explicitly enabled with a key', async () => {
    const { tmpDir } = await createTempRepo();
    runGit(tmpDir, ['config', '--local', 'gpg.format', 'openpgp']);
    runGit(tmpDir, ['config', '--local', 'user.signingkey', 'existing-signing-key']);
    runGit(tmpDir, ['config', '--local', 'commit.gpgsign', 'false']);
    const profile = { userName: 'Signing Author', userEmail: 'signing@example.com' };
    for (const signing of [{}, { signCommits: false, signingKey: 'ignored' }, { signCommits: true, signingKey: ' ' }]) {
      await setLocalIdentity(tmpDir, { ...profile, ...signing });
      expect(runGit(tmpDir, ['config', '--local', '--get', 'gpg.format']).trim()).toBe('openpgp');
      expect(runGit(tmpDir, ['config', '--local', '--get', 'user.signingkey']).trim()).toBe('existing-signing-key');
      expect(runGit(tmpDir, ['config', '--local', '--get', 'commit.gpgsign']).trim()).toBe('false');
    }
    await setLocalIdentity(tmpDir, { ...profile, signCommits: true, signingKey: ' /unused/signing.pub ' });
    expect(runGit(tmpDir, ['config', '--local', '--get', 'gpg.format']).trim()).toBe('ssh');
    expect(runGit(tmpDir, ['config', '--local', '--get', 'user.signingkey']).trim()).toBe('/unused/signing.pub');
    expect(runGit(tmpDir, ['config', '--local', '--get', 'commit.gpgsign']).trim()).toBe('true');
  });

  it('commits with the machine author when the repository overrides none, and refuses when there is none at all', async () => {
    const tmpDir = createTempDir();
    runGit(tmpDir, ['init']);
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# identity\n');
    runGit(tmpDir, ['add', 'README.md']);

    // Nothing anywhere: the refusal says how to fix it rather than naming an internal rule.
    await expect(hasLocalIdentity(tmpDir)).resolves.toBe(false);
    await expect(commit(tmpDir, 'No author')).rejects.toThrow('No Git author is configured');

    // A repository on the System identity has no local author on purpose; the
    // machine's own author answers, exactly as plain Git would resolve it.
    runGit(tmpDir, ['config', '--global', 'user.name', 'Machine Author']);
    runGit(tmpDir, ['config', '--global', 'user.email', 'machine@example.com']);
    await expect(hasLocalIdentity(tmpDir)).resolves.toBe(false);
    await expect(commit(tmpDir, 'System identity')).resolves.toMatchObject({ success: true });
    expect(runGit(tmpDir, ['log', '-1', '--format=%an <%ae>']).trim()).toBe('Machine Author <machine@example.com>');

    // An applied identity still decides: its author is the repository's own.
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# identity two\n');
    runGit(tmpDir, ['add', 'README.md']);
    runGit(tmpDir, ['config', '--local', 'user.name', 'Test User']);
    runGit(tmpDir, ['config', '--local', 'user.email', 'test@example.com']);
    await expect(hasLocalIdentity(tmpDir)).resolves.toBe(true);
    await expect(commit(tmpDir, 'Complete identity')).resolves.toMatchObject({ success: true });
    expect(runGit(tmpDir, ['log', '-1', '--format=%an <%ae>']).trim()).toBe('Test User <test@example.com>');
  });

  // Author profiles no longer carry transport configuration: `setLocalIdentity`
  // writes only user.name, user.email and commit signing. Transport lives in the
  // repository binding, and HTTPS credentials come from the loopback credential
  // broker as single-use leases instead of a plaintext `credential.helper store`.
  it('writes only author fields and never a transport credential helper', async () => {
    const { tmpDir } = await createTempRepo();

    await setLocalIdentity(tmpDir, {
      userName: 'Token User',
      userEmail: 'token@example.com',
      authType: 'token',
      host: 'github.com',
    });

    expect(runGit(tmpDir, ['config', '--local', '--get', 'user.name']).trim()).toBe('Token User');
    expect(runGit(tmpDir, ['config', '--local', '--get', 'user.email']).trim()).toBe('token@example.com');
    expect(() => runGit(tmpDir, ['config', '--local', '--get', 'credential.helper'])).toThrow();
    expect(() => runGit(tmpDir, ['config', '--local', '--get', 'core.sshCommand'])).toThrow();
  });

  it('never writes an ssh command for an ssh author profile', async () => {
    const { tmpDir } = await createTempRepo();

    await setLocalIdentity(tmpDir, {
      userName: 'SSH User',
      userEmail: 'ssh@example.com',
      authType: 'ssh',
      sshKey: '/tmp/test key',
    });

    expect(runGit(tmpDir, ['config', '--local', '--get', 'user.email']).trim()).toBe('ssh@example.com');
    expect(() => runGit(tmpDir, ['config', '--local', '--get', 'core.sshCommand'])).toThrow();
    expect(() => runGit(tmpDir, ['config', '--local', '--get', 'credential.helper'])).toThrow();
  });
});

// ---------------------------------------------------------------------------
// applyHunk (per-hunk stage / unstage / discard)
// ---------------------------------------------------------------------------

// Exercise the actual client splitter against the server apply boundary.
import { splitPatchIntoHunks as splitHunks } from '../../../../ui/src/lib/diff/patchFileDiff.ts';

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
  it('stages successive hunks and never discards a stale staged or committed patch', async () => {
    if (!canRunGit()) return;
    const { tmpDir, git } = await createTempRepo();
    const original = Array.from({ length: 60 }, (_, index) => `line${index}`);
    const changed = [...original];
    changed[1] = 'FIRST'; changed[25] = 'SECOND'; changed[50] = 'THIRD';
    await writeFile(tmpDir, 'file.txt', original.join('\n') + '\n');
    await git.add('file.txt'); await git.commit('Initial');
    await writeFile(tmpDir, 'file.txt', changed.join('\n') + '\n');
    const historical = splitHunks(await getDiff(tmpDir, { path: 'file.txt' }));
    expect(historical).toHaveLength(3);
    await applyHunk(tmpDir, 'file.txt', { patch: historical[0], action: 'stage' });
    const remaining = splitHunks(await getDiff(tmpDir, { path: 'file.txt' }));
    expect(remaining).toHaveLength(2);
    await applyHunk(tmpDir, 'file.txt', { patch: remaining[0], action: 'stage' });
    const stalePath = path.join(tmpDir, 'stale.patch');
    await fs.promises.writeFile(stalePath, historical[0]);
    // Git's reverse applicability check accepts it, but it is no longer an
    // unstaged hunk. The server must reject it before touching the working file.
    await git.raw(['apply', '--reverse', '--check', stalePath]);
    await expect(applyHunk(tmpDir, 'file.txt', { patch: historical[0], action: 'discard' })).rejects.toThrow('refresh and try again');
    expect(await readWorking(tmpDir)).toBe(changed.join('\n') + '\n');
    const last = splitHunks(await getDiff(tmpDir, { path: 'file.txt' }));
    expect(last).toHaveLength(1);
    await applyHunk(tmpDir, 'file.txt', { patch: last[0], action: 'discard' });
    changed[50] = original[50];
    expect(await readWorking(tmpDir)).toBe(changed.join('\n') + '\n');
    expect(await readStaged(git)).toBe(changed.join('\n') + '\n');
    const staged = splitHunks(await getDiff(tmpDir, { path: 'file.txt', staged: true }));
    await applyHunk(tmpDir, 'file.txt', { patch: staged[0], action: 'unstage' });
    expect(await readWorking(tmpDir)).toBe(changed.join('\n') + '\n');
    await git.add('file.txt'); await git.commit('Committed changes');
    await expect(applyHunk(tmpDir, 'file.txt', { patch: historical[0], action: 'discard' })).rejects.toThrow('refresh and try again');
  });

  it.each(['crlf', 'mixed'])('preserves %s file bytes through stage, unstage and discard', async (endings) => {
    if (!canRunGit()) return;
    const { tmpDir, git } = await createTempRepo();
    await git.addConfig('core.autocrlf', 'false');
    const serialize = (first, last) => Array.from({ length: 30 }, (_, index) => {
      const text = index === 0 ? first : index === 29 ? last : `line${index}`;
      return text + (endings === 'crlf' || index % 2 === 0 ? '\r\n' : '\n');
    }).join('');
    const original = serialize('first', 'last');
    const edited = serialize('FIRST', 'LAST');
    await writeFile(tmpDir, 'file.txt', original);
    await git.add('file.txt'); await git.commit('Initial');
    await writeFile(tmpDir, 'file.txt', edited);
    const hunks = splitHunks(await getDiff(tmpDir, { path: 'file.txt' }));
    await applyHunk(tmpDir, 'file.txt', { patch: hunks[0], action: 'stage' });
    expect(await git.raw(['show', ':file.txt'])).toBe(serialize('FIRST', 'last'));
    const staged = splitHunks(await getDiff(tmpDir, { path: 'file.txt', staged: true }));
    await applyHunk(tmpDir, 'file.txt', { patch: staged[0], action: 'unstage' });
    expect(await git.raw(['show', ':file.txt'])).toBe(original);
    const working = splitHunks(await getDiff(tmpDir, { path: 'file.txt' }));
    await applyHunk(tmpDir, 'file.txt', { patch: working[0], action: 'discard' });
    expect(await fs.promises.readFile(path.join(tmpDir, 'file.txt'), 'utf8')).toBe(serialize('first', 'LAST'));
  });

  it('rejects extra files hidden before the requested patch', async () => {
    if (!canRunGit()) return;
    const { tmpDir, git } = await createTempRepo();
    for (const name of ['file.txt', 'other.txt']) await writeFile(tmpDir, name, ORIGINAL_FILE);
    await git.add('.'); await git.commit('Initial');
    for (const name of ['file.txt', 'other.txt']) await writeFile(tmpDir, name, EDITED_FILE);
    const other = splitHunks(await getDiff(tmpDir, { path: 'other.txt' }))[0];
    const requested = splitHunks(await getDiff(tmpDir, { path: 'file.txt' }))[0];
    await expect(applyHunk(tmpDir, 'file.txt', { patch: requested + other, action: 'stage' })).rejects.toThrow('refresh and try again');
    expect(await git.raw(['diff', '--cached'])).toBe('');
  });

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

  it.each(['file name.txt', 'зміни.txt'])('accepts hunk patches for %s', async (filePath) => {
    if (!canRunGit()) return;
    const { tmpDir, git } = await createTempRepo();
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

describe.runIf(canRunGit())('untracked diffs', () => {
  it.each(['false', 'warn'])('returns only the patch with core.safecrlf=%s', async (safecrlf) => {
    const { tmpDir, git } = await createTempRepo();
    await git.addConfig('core.autocrlf', 'true');
    await git.addConfig('core.safecrlf', safecrlf);
    fs.writeFileSync(path.join(tmpDir, 'new file.txt'), 'first\nsecond\n');

    // Confirm this fixture produces a real diff exit, including stderr in the warning case.
    let expectedPatch;
    try {
      runGit(tmpDir, ['diff', '--no-color', '--full-index', '--no-index', '--', '/dev/null', 'new file.txt']);
      throw new Error('Expected git diff to exit with differences');
    } catch (error) {
      expect(error.status).toBe(1);
      expectedPatch = error.stdout;
      if (safecrlf === 'warn') {
        expect(error.stderr).toContain('LF will be replaced by CRLF');
      }
    }

    const diff = await getDiff(tmpDir, { path: 'new file.txt' });
    expect(diff).toBe(expectedPatch);
    expect(diff).toContain('+first\n+second\n');
    expect(diff).not.toContain('warning:');
    expect(await getUntrackedDiffs(tmpDir, ['new file.txt'])).toEqual([diff]);
  });

  it('accepts an empty untracked file without a process error', async () => {
    const { tmpDir } = await createTempRepo();
    fs.writeFileSync(path.join(tmpDir, 'empty.txt'), '');
    const diff = await getDiff(tmpDir, { path: 'empty.txt' });
    expect(diff).toContain('new file mode 100644');
    expect(diff).not.toContain('@@');
    expect(await getUntrackedDiffs(tmpDir, ['empty.txt'])).toEqual([diff]);
  });

  it('rejects fatal conversion errors while preserving other batch entries', async () => {
    const { tmpDir } = await createTempRepo();
    runGit(tmpDir, ['config', 'diff.broken.textconv', 'false']);
    fs.writeFileSync(path.join(tmpDir, '.gitattributes'), 'bad.txt diff=broken\n');
    fs.writeFileSync(path.join(tmpDir, 'first.safe'), 'first\n');
    fs.writeFileSync(path.join(tmpDir, 'bad.txt'), 'bad\n');
    fs.writeFileSync(path.join(tmpDir, 'last.safe'), 'last\n');

    await expect(getDiff(tmpDir, { path: 'bad.txt' })).rejects.toThrow('unable to read files to diff');
    const diffs = await getUntrackedDiffs(tmpDir, ['first.safe', 'bad.txt', 'last.safe'], { concurrency: 1 });
    expect(diffs).toHaveLength(3);
    expect(diffs[0]).toContain('+first\n');
    expect(diffs[1]).toBe('');
    expect(diffs[2]).toContain('+last\n');
  });

  it('rejects truncated patches when the process output exceeds the buffer limit', async () => {
    const { tmpDir } = await createTempRepo();
    fs.writeFileSync(path.join(tmpDir, 'large.txt'), 'x'.repeat(21 * 1024 * 1024) + '\n');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(getDiff(tmpDir, { path: 'large.txt' })).rejects.toThrow('maxBuffer');
      expect(await getUntrackedDiffs(tmpDir, ['large.txt'])).toEqual(['']);
    } finally {
      errorSpy.mockRestore();
    }
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
// Status paths that are not plain files (#3586)
// ---------------------------------------------------------------------------

describe.runIf(canRunGit())('diffs for status paths that are not plain files', () => {
  const callDiffRoute = async (endpoint, query) => {
    const routes = new Map();
    registerGitRoutes({ get: (url, handler) => routes.set(url, handler), post() {}, put() {}, delete() {} });
    let status = 200;
    let body;
    await routes.get(`/api/git/${endpoint}`)({ query }, {
      status(value) { status = value; return this; },
      json(value) { body = value; },
    });
    return { status, body };
  };

  const createRepositoryWithSubmodule = () => {
    const { repository } = createRepositoryWithRemote();
    const library = createTempDir();
    runGit(library, ['init', '-b', 'main']);
    runGit(library, ['config', 'user.email', 'test@example.com']);
    runGit(library, ['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(library, 'lib.txt'), 'lib\n');
    runGit(library, ['add', '.']);
    runGit(library, ['commit', '-m', 'lib']);
    runGit(repository, ['-c', 'protocol.file.allow=always', 'submodule', 'add', library, 'sub']);
    runGit(repository, ['commit', '-m', 'add submodule']);
    return { repository, recorded: runGit(repository, ['rev-parse', 'HEAD:sub']).trim() };
  };

  it('answers 404 with a code when a listed file is gone before its diff is requested', async () => {
    const { repository } = createRepositoryWithRemote();
    for (const endpoint of ['diff', 'file-diff']) {
      const { status, body } = await callDiffRoute(endpoint, { directory: repository, path: 'removed.txt' });
      expect(status).toBe(404);
      expect(body).toEqual({ code: 'path_not_found', error: 'Path not found in working tree, index, or HEAD: removed.txt' });
    }
  });

  it('answers 422 for a nested repository that status lists as a directory', async () => {
    const { repository } = createRepositoryWithRemote();
    const nested = path.join(repository, 'nested');
    fs.mkdirSync(nested);
    runGit(nested, ['init', '-b', 'main']);
    fs.writeFileSync(path.join(nested, 'inner.txt'), 'inner\n');
    expect((await getStatus(repository)).files).toContainEqual(expect.objectContaining({ path: 'nested/' }));

    for (const endpoint of ['diff', 'file-diff']) {
      const { status, body } = await callDiffRoute(endpoint, { directory: repository, path: 'nested/' });
      expect(status).toBe(422);
      expect(body.code).toBe('nested_repository');
    }
    await expect(revertFile(repository, 'nested/')).rejects.toMatchObject({ code: 'nested_repository' });
    expect(fs.existsSync(path.join(nested, 'inner.txt'))).toBe(true);
  });

  it('describes a submodule whose checked-out commit moved', async () => {
    const { repository, recorded } = createRepositoryWithSubmodule();
    const submodulePath = path.join(repository, 'sub');
    runGit(submodulePath, ['config', 'user.email', 'test@example.com']);
    runGit(submodulePath, ['config', 'user.name', 'Test']);
    runGit(submodulePath, ['commit', '--allow-empty', '-m', 'moved']);
    const moved = runGit(submodulePath, ['rev-parse', 'HEAD']).trim();
    const submodule = { headCommit: recorded, indexCommit: recorded, worktreeCommit: moved, hasTrackedChanges: false, hasUntrackedFiles: false, hasConflict: false };

    const patch = await callDiffRoute('diff', { directory: repository, path: 'sub' });
    expect(patch.status).toBe(200);
    expect(patch.body.diff).toContain(`+Subproject commit ${moved}`);
    expect(patch.body.submodule).toEqual(submodule);

    const split = await callDiffRoute('file-diff', { directory: repository, path: 'sub' });
    expect(split.body).toEqual({
      original: `Subproject commit ${recorded}\n`,
      modified: `Subproject commit ${moved}\n`,
      path: 'sub',
      isBinary: false,
      submodule,
    });
  });

  it('reports a submodule merge conflict instead of an unchanged commit', async () => {
    const { repository } = createRepositoryWithRemote();
    const library = createTempDir();
    runGit(library, ['init', '-b', 'main']);
    runGit(library, ['config', 'user.email', 'test@example.com']);
    runGit(library, ['config', 'user.name', 'Test']);
    runGit(library, ['commit', '--allow-empty', '-m', 'base']);
    runGit(library, ['checkout', '-b', 'left']);
    runGit(library, ['commit', '--allow-empty', '-m', 'left']);
    runGit(library, ['checkout', '-b', 'right', 'main']);
    runGit(library, ['commit', '--allow-empty', '-m', 'right']);
    runGit(library, ['checkout', 'main']);
    runGit(repository, ['-c', 'protocol.file.allow=always', 'submodule', 'add', library, 'sub']);
    runGit(repository, ['commit', '-m', 'add submodule']);
    const submodulePath = path.join(repository, 'sub');
    for (const [branch, commit] of [['other', 'right'], ['next', 'left']]) {
      if (branch === 'other') runGit(repository, ['checkout', '-b', 'other']);
      else runGit(repository, ['checkout', 'next']);
      runGit(submodulePath, ['checkout', commit]);
      runGit(repository, ['add', 'sub']);
      runGit(repository, ['commit', '-m', `move to ${commit}`]);
    }
    expect(() => runGit(repository, ['merge', 'other'])).toThrow();

    const { submodule } = await getPathDiff(repository, { path: 'sub' });
    expect(submodule).toMatchObject({
      headCommit: runGit(repository, ['rev-parse', 'HEAD:sub']).trim(),
      indexCommit: null,
      hasConflict: true,
    });
  });

  it('reports untracked files inside a submodule even though its patch is empty', async () => {
    const { repository, recorded } = createRepositoryWithSubmodule();
    fs.writeFileSync(path.join(repository, 'sub', 'scratch.txt'), 'scratch\n');

    const result = await getPathDiff(repository, { path: 'sub' });
    expect(result).toEqual({
      diff: '',
      submodule: { headCommit: recorded, indexCommit: recorded, worktreeCommit: recorded, hasTrackedChanges: false, hasUntrackedFiles: true, hasConflict: false },
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

  it('scopes diff stats by staged and working instead of combining a partially staged file', async () => {
    if (!canRunGit()) return;

    const repo = createTempDir();
    runGit(repo, ['init', '-b', 'main']);
    runGit(repo, ['config', 'user.email', 'test@example.com']);
    runGit(repo, ['config', 'user.name', 'Test User']);
    const file = 'test.txt';
    const filePath = path.join(repo, file);
    fs.writeFileSync(filePath, 'one\ntwo\nthree\n');
    runGit(repo, ['add', file]);
    runGit(repo, ['commit', '-m', 'initial']);

    // Stage one new line, then keep editing without staging another.
    fs.writeFileSync(filePath, 'one\ntwo\nthree\nstaged\n');
    runGit(repo, ['add', file]);
    fs.writeFileSync(filePath, 'one\ntwo\nthree\nstaged\nworking\n');

    const status = await getStatus(repo);

    expect(status.diffStats.staged[file]).toEqual({ insertions: 1, deletions: 0 });
    expect(status.diffStats.working[file]).toEqual({ insertions: 1, deletions: 0 });
  });

  it('scopes untracked files to working stats and staged additions to staged stats', async () => {
    if (!canRunGit()) return;

    const repo = createTempDir();
    runGit(repo, ['init', '-b', 'main']);
    runGit(repo, ['config', 'user.email', 'test@example.com']);
    runGit(repo, ['config', 'user.name', 'Test User']);
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'tracked\n');
    runGit(repo, ['add', 'tracked.txt']);
    runGit(repo, ['commit', '-m', 'initial']);

    fs.writeFileSync(path.join(repo, 'untracked.txt'), 'a\nb\n');
    fs.writeFileSync(path.join(repo, 'staged.txt'), 'c\nd\ne\n');
    runGit(repo, ['add', 'staged.txt']);

    const status = await getStatus(repo);

    expect(status.diffStats.working['untracked.txt']).toEqual({ insertions: 2, deletions: 0 });
    expect(status.diffStats.staged['staged.txt']).toEqual({ insertions: 3, deletions: 0 });
    expect(status.diffStats.working['staged.txt']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// worktree root resolution
// ---------------------------------------------------------------------------

describe('worktree root resolution', () => {
  it.each(['repo', 'repo space', 'repo-\u4e2d\u6587'])('uses filesystem paths returned by Git for %s', async (name) => {
    if (!canRunGit()) return;
    const parent = createTempDir();
    const repo = path.join(parent, name);
    const subdirectory = path.join(repo, 'packages', 'app');
    fs.mkdirSync(subdirectory, { recursive: true });
    runGit(repo, ['init', '-b', 'main']);
    runGit(repo, ['config', 'core.autocrlf', 'false']);
    runGit(repo, ['config', 'user.email', 'test@example.com']);
    runGit(repo, ['config', 'user.name', 'Test User']);

    for (const directory of [repo, subdirectory]) {
      expect(await isGitRepository(directory)).toBe(true);
      expect(fs.realpathSync(await getRepositoryRoot(directory))).toBe(fs.realpathSync(repo));
      expect(fs.realpathSync((await resolveWorktreeTopLevel(directory)).root)).toBe(fs.realpathSync(repo));
      expect((await getStatus(directory)).isClean).toBe(true);
    }

    fs.writeFileSync(path.join(repo, 'README.md'), 'before\n');
    runGit(repo, ['add', 'README.md']);
    runGit(repo, ['commit', '-m', 'Initial commit']);
    fs.writeFileSync(path.join(repo, 'README.md'), 'after /c/keep-this-content\n');
    expect((await getBranches(subdirectory)).current).toBe('main');
    expect((await getStatus(repo)).files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'README.md', working_dir: 'M' }),
    ]));
    expect(await getDiff(repo, { path: 'README.md' })).toContain('+after /c/keep-this-content');

    const entries = await getWorktrees(subdirectory);
    expect(entries).toHaveLength(1);
    expect(fs.realpathSync(entries[0].path)).toBe(fs.realpathSync(repo));
  });

  it('creates and queries a managed worktree using native filesystem paths', async () => {
    if (!canRunGit()) return;
    const previousDataHome = process.env.XDG_DATA_HOME;
    const parent = createTempDir();
    process.env.XDG_DATA_HOME = path.join(parent, 'data space');
    try {
      const repo = path.join(parent, 'repo space');
      fs.mkdirSync(repo);
      runGit(repo, ['init', '-b', 'main']);
      runGit(repo, ['config', 'core.autocrlf', 'false']);
      runGit(repo, ['config', 'user.email', 'test@example.com']);
      runGit(repo, ['config', 'user.name', 'Test User']);
      fs.writeFileSync(path.join(repo, 'README.md'), 'initial\n');
      runGit(repo, ['add', 'README.md']);
      runGit(repo, ['commit', '-m', 'Initial commit']);

      const created = await createWorktree(repo, {
        mode: 'new', branchName: 'feature/native-paths', worktreeName: 'native-paths',
      });
      await expect.poll(
        async () => (await getWorktreeBootstrapStatus(created.path)).status,
        { timeout: 20_000 },
      ).not.toBe('pending');
      expect(await getWorktreeBootstrapStatus(created.path)).toMatchObject({ status: 'ready', error: null });
      expect(fs.readFileSync(path.join(created.path, 'README.md'), 'utf8')).toBe('initial\n');
      expect(fs.realpathSync(await getRepositoryRoot(created.path))).toBe(fs.realpathSync(created.path));
      expect(fs.realpathSync((await resolvePrimaryWorktreeRoot(created.path)).root)).toBe(fs.realpathSync(repo));
      expect((await getStatus(created.path)).isClean).toBe(true);
      const entries = await getWorktrees(created.path);
      expect(entries.map((entry) => fs.realpathSync(entry.path)).sort()).toEqual(
        [fs.realpathSync(repo), fs.realpathSync(created.path)].sort(),
      );
      await removeWorktree(repo, { directory: created.path });
      expect(fs.existsSync(created.path)).toBe(false);
      expect(await getWorktrees(repo)).toHaveLength(1);
    } finally {
      if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = previousDataHome;
    }
  });

  it('resolves the git toplevel for a repository subdirectory', async () => {
    if (!canRunGit()) return;

    const repo = createTempDir();
    const subdirectory = path.join(repo, 'packages', 'app');
    runGit(repo, ['init', '-b', 'main']);
    fs.mkdirSync(subdirectory, { recursive: true });

    expect(fs.realpathSync((await resolveWorktreeTopLevel(subdirectory)).root)).toBe(fs.realpathSync(repo));
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

    expect(fs.realpathSync((await resolvePrimaryWorktreeRoot(worktree)).root)).toBe(fs.realpathSync(repo));
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
  it('notifies subscribers only when another git process changes the worktree set', async () => {
    if (!canRunGit()) return;

    const repo = createTempDir();
    runGit(repo, ['init', '-b', 'main']);
    runGit(repo, ['config', 'user.email', 'test@example.com']);
    runGit(repo, ['config', 'user.name', 'Test User']);
    runGit(repo, ['commit', '--allow-empty', '-m', 'init']);
    const worktreePath = path.join(createTempDir(), 'feature');

    const events = [];
    const unsubscribe = subscribeWorktreeTopologyChanges((event) => events.push(event));
    try {
      await observeWorktreeTopology(repo);
      await observeWorktreeTopology(repo);
      expect(events).toHaveLength(0);

      runGit(repo, ['worktree', 'add', worktreePath, '-b', 'feature']);
      await observeWorktreeTopology(worktreePath);
      expect(events).toHaveLength(1);
      expect(events[0].directories).toEqual(expect.arrayContaining([repo, worktreePath]));

      await observeWorktreeTopology(repo);
      expect(events).toHaveLength(1);

      runGit(repo, ['worktree', 'remove', worktreePath]);
      await observeWorktreeTopology(repo);
      expect(events).toHaveLength(2);
    } finally {
      unsubscribe();
    }
  });

  it('publishes worktrees this server creates and removes', async () => {
    if (!canRunGit()) return;

    const previousXdgDataHome = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = createTempDir();
    const events = [];
    const unsubscribe = subscribeWorktreeTopologyChanges((event) => events.push(event));
    try {
      const repo = createTempDir();
      runGit(repo, ['init', '-b', 'main']);
      runGit(repo, ['config', 'user.email', 'test@example.com']);
      runGit(repo, ['config', 'user.name', 'Test User']);
      runGit(repo, ['commit', '--allow-empty', '-m', 'init']);
      await observeWorktreeTopology(repo);

      const created = await createWorktree(repo, {
        mode: 'new',
        worktreeName: 'published',
        branchName: 'openchamber/published',
      });
      expect(events).toHaveLength(1);
      expect(events[0].directories).toContain(repo);

      // The publish refreshed the baseline, so the next observation is quiet.
      await observeWorktreeTopology(repo);
      expect(events).toHaveLength(1);

      await removeWorktree(repo, { directory: created.path });
      expect(events).toHaveLength(2);
    } finally {
      unsubscribe();
      if (previousXdgDataHome === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = previousXdgDataHome;
      }
    }
  });

  it('flags a worktree whose directory was deleted outside git as prunable', async () => {
    const repo = createTempDir();
    runGit(repo, ['init', '-b', 'main']);
    runGit(repo, ['config', 'user.email', 'test@example.com']);
    runGit(repo, ['config', 'user.name', 'Test User']);
    runGit(repo, ['commit', '--allow-empty', '-m', 'init']);
    const worktreePath = path.join(createTempDir(), 'feature');
    runGit(repo, ['worktree', 'add', worktreePath, '-b', 'feature']);

    const before = await getWorktrees(repo);
    expect(before.find((entry) => entry.branch === 'feature')).toMatchObject({ prunable: false });

    fs.rmSync(worktreePath, { recursive: true, force: true });

    const after = await getWorktrees(repo);
    expect(after.find((entry) => entry.branch === 'feature')).toMatchObject({ path: expect.any(String), prunable: true });
    expect(after.find((entry) => entry.branch === 'main')).toMatchObject({ prunable: false });
  });
});

// ---------------------------------------------------------------------------
// createWorktree
// ---------------------------------------------------------------------------

describe('createWorktree', () => {
  // A directory this server never bootstrapped is not being populated. Reading
  // it as failed refused every ordinary repository once the OpenCode proxy
  // started gating on this status.
  it('reads a directory with no bootstrap record as ready', async () => {
    const directory = path.join(createTempDir(), 'missing-worktree');

    await expect(getWorktreeBootstrapStatus(directory)).resolves.toMatchObject({
      status: 'ready',
      phase: 'setup-ready',
    });
  });

  it('still inspects a record left pending with no live bootstrap into a repair blocker', async () => {
    const directory = path.join(createTempDir(), 'crashed-worktree');
    const bootstrapStore = {
      read: vi.fn(async () => ({ status: 'pending', phase: 'directory-created', error: null, updatedAt: 1 })),
      write: vi.fn(async (_directory, state) => state),
    };

    await expect(getWorktreeBootstrapStatus(directory, { bootstrapStore })).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'UNKNOWN',
      error: expect.stringContaining('repair'),
    });
    expect(bootstrapStore.write).toHaveBeenCalledOnce();
  });

  it('fails closed when the bootstrap store cannot be read', async () => {
    const directory = path.join(createTempDir(), 'unreadable-store');
    const bootstrapStore = {
      read: vi.fn(async () => { throw new Error('store unreadable'); }),
      write: vi.fn(),
    };

    await expect(getWorktreeBootstrapStatus(directory, { bootstrapStore })).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'UNKNOWN',
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

  it('does not report Git-ready when checkout hydration is incomplete', async () => {
    if (!canRunGit()) return;
    const repo = createTempDir();
    runGit(repo, ['init', '-b', 'main']);
    runGit(repo, ['config', 'user.email', 'test@example.com']);
    runGit(repo, ['config', 'user.name', 'Test User']);
    fs.writeFileSync(path.join(repo, 'README.md'), '# Test\n');
    runGit(repo, ['add', 'README.md']);
    runGit(repo, ['commit', '-m', 'Initial commit']);
    const hydration = {
      status: 'authorization-required',
      submodules: [{
        path: 'vendor/private', status: 'authorization-required',
        error: { code: 'AUTHENTICATION_REQUIRED', message: 'Explicit grant required' },
      }],
      lfs: [{ path: '.', status: 'not-needed' }],
    };
    const hydrateCheckout = vi.fn(async () => hydration);
    const bootstrapStore = createWorktreeBootstrapStore({
      filePath: path.join(createTempDir(), 'bootstrap.json'),
    });
    const created = await createWorktree(repo, {
      mode: 'new', branchName: 'feature/hydration-failure', worktreeName: 'hydration-failure',
      returnAfterDirectoryCreated: true,
    }, { hydrateCheckout, bootstrapStore });

    await expect.poll(
      async () => (await getWorktreeBootstrapStatus(created.path, { bootstrapStore })).status,
      { timeout: 5_000 },
    ).toBe('failed');
    const expectedFailure = {
      status: 'failed',
      phase: 'directory-created',
      errorCode: 'AUTHENTICATION_REQUIRED',
      hydration: {
        status: 'authorization-required',
        submodules: [{
          path: 'vendor/private',
          status: 'authorization-required',
          error: { code: 'AUTHENTICATION_REQUIRED' },
        }],
        lfs: [{ path: '.', status: 'not-needed' }],
      },
    };
    await expect(getWorktreeBootstrapStatus(created.path, { bootstrapStore })).resolves.toMatchObject(expectedFailure);
    await expect(bootstrapStore.read(created.path)).resolves.toMatchObject(expectedFailure);
    expect(hydrateCheckout).toHaveBeenCalledWith({ directory: created.path, parentRemoteName: '' });
  });

  it('hydrates a checkout made from a local branch through the branch\'s own remote', async () => {
    if (!canRunGit()) return;
    const repo = createTempDir();
    runGit(repo, ['init', '-b', 'main']);
    runGit(repo, ['config', 'user.email', 'test@example.com']);
    runGit(repo, ['config', 'user.name', 'Test User']);
    fs.writeFileSync(path.join(repo, 'README.md'), '# Test\n');
    runGit(repo, ['add', 'README.md']);
    runGit(repo, ['commit', '-m', 'Initial commit']);
    runGit(repo, ['remote', 'add', 'upstream', 'https://example.com/team/repo.git']);
    runGit(repo, ['remote', 'add', 'origin', 'https://example.com/me/repo.git']);
    runGit(repo, ['config', 'branch.main.remote', 'upstream']);
    const hydrateCheckout = vi.fn(async () => ({ status: 'not-needed', submodules: [], lfs: [] }));
    const bootstrapStore = createWorktreeBootstrapStore({ filePath: path.join(createTempDir(), 'bootstrap.json') });
    const created = await createWorktree(repo, {
      mode: 'new', branchName: 'feature/from-local', worktreeName: 'from-local', startRef: 'main',
      returnAfterDirectoryCreated: true,
    }, { hydrateCheckout, bootstrapStore });
    await expect.poll(
      async () => (await getWorktreeBootstrapStatus(created.path, { bootstrapStore })).status,
      { timeout: 5_000 },
    ).not.toBe('pending');
    // The branch's upstream, not the first remote in the list.
    expect(hydrateCheckout).toHaveBeenCalledWith({ directory: created.path, parentRemoteName: 'upstream' });
  });

  const installPostCheckoutHook = (repo, script, executable = true) => {
    const hookPath = path.join(repo, '.git', 'hooks', 'post-checkout');
    fs.writeFileSync(hookPath, script);
    if (executable) {
      fs.chmodSync(hookPath, 0o755);
    }
    return hookPath;
  };

  it('does not run the post-checkout hook while populating a created worktree', async () => {
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

  it('does not execute a failing post-checkout hook during bootstrap', async () => {
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
      expect(fs.existsSync(hookLog)).toBe(false);
    } finally {
      if (previousXdgDataHome === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = previousXdgDataHome;
      }
    }
  });

  it('waits for active bootstrap work before removing through a checkout alias', async () => {
    if (!canRunGit()) return;

    const previousXdgDataHome = process.env.XDG_DATA_HOME;
    const dataHome = createTempDir();
    const setupStarted = path.join(dataHome, 'remove-race-started');
    const setupCompleted = path.join(dataHome, 'remove-race-completed');
    const setupScript = path.join(dataHome, 'remove-race.cjs');
    let createdPath = '';
    const bootstrapStore = {
      write: vi.fn(async (_directory, state) => state),
      read: vi.fn(async () => null),
      remove: vi.fn(async () => {
        expect(fs.existsSync(setupCompleted)).toBe(true);
        expect(fs.existsSync(createdPath)).toBe(true);
        return true;
      }),
    };
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
      }, {
        bootstrapStore,
        hydrateCheckout: async () => ({ status: 'not-needed', submodules: [], lfs: [] }),
      });
      createdPath = created.path;

      await expect.poll(() => fs.existsSync(setupStarted), { timeout: 5_000 }).toBe(true);
      let removalTarget = created.path;
      if (process.platform !== 'win32') {
        const aliasParent = createTempDir();
        const aliasRoot = path.join(aliasParent, 'worktrees');
        fs.symlinkSync(path.dirname(created.path), aliasRoot, 'dir');
        removalTarget = path.join(aliasRoot, path.basename(created.path));
      }
      let removalCompleted = false;
      const removal = removeWorktree(repo, { directory: removalTarget }, { bootstrapStore }).then(() => {
        removalCompleted = true;
      });

      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(removalCompleted).toBe(false);
      await removal;

      expect(fs.existsSync(setupCompleted)).toBe(true);
      expect(fs.existsSync(created.path)).toBe(false);
      expect(bootstrapStore.remove).toHaveBeenCalledOnce();
      // Removal drops the record, so no stale pending state is left behind.
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
    runGit(repo, ['config', 'core.autocrlf', 'false']);
    runGit(repo, ['config', 'user.email', 'test@example.com']);
    runGit(repo, ['config', 'user.name', 'Test User']);
    fs.writeFileSync(path.join(repo, 'README.md'), '# Test\n');
    runGit(repo, ['add', 'README.md']);
    runGit(repo, ['commit', '-m', 'Initial commit']);
    fs.rmSync(worktree, { recursive: true, force: true });
    runGit(repo, ['worktree', 'add', '--no-checkout', '-b', 'feature/stale-lock', worktree, 'HEAD']);

    const lockPath = normalizeGitOutputPath(runGit(worktree, ['rev-parse', '--git-path', 'index.lock']).trim());
    fs.writeFileSync(lockPath, 'stale');

    await expect(populateWorktreeWithLockRecovery(worktree)).resolves.toBeUndefined();
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.readFileSync(path.join(worktree, 'README.md'), 'utf8')).toBe('# Test\n');
  });

  it('disables configured smudge filters while populating a worktree', async () => {
    if (!canRunGit() || process.platform === 'win32') return;

    const repo = createTempDir();
    const worktree = createTempDir();
    const marker = path.join(createTempDir(), 'smudge-ran');
    const filterScript = path.join(createTempDir(), 'smudge.cjs');
    runGit(repo, ['init', '-b', 'main']);
    runGit(repo, ['config', 'user.email', 'test@example.com']);
    runGit(repo, ['config', 'user.name', 'Test User']);
    fs.writeFileSync(path.join(repo, '.gitattributes'), 'payload.txt filter=populate-smudge\n');
    fs.writeFileSync(path.join(repo, 'payload.txt'), 'checkout content\n');
    runGit(repo, ['add', '.gitattributes', 'payload.txt']);
    runGit(repo, ['commit', '-m', 'Initial commit']);
    fs.writeFileSync(
      filterScript,
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran'); process.stdin.pipe(process.stdout);\n`,
    );
    runGit(repo, ['config', 'filter.populate-smudge.smudge', `${JSON.stringify(process.execPath)} ${JSON.stringify(filterScript)}`]);
    runGit(repo, ['config', 'filter.populate-smudge.required', 'true']);
    fs.rmSync(worktree, { recursive: true, force: true });
    runGit(repo, ['worktree', 'add', '--no-checkout', '-b', 'feature/filter-neutral', worktree, 'HEAD']);

    await expect(populateWorktreeWithLockRecovery(worktree)).resolves.toBeUndefined();

    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.readFileSync(path.join(worktree, 'payload.txt'), 'utf8')).toBe('checkout content\n');
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

      const error = await createWorktree(repo, {
        mode: 'existing',
        existingBranch: 'feature/in-use',
        branchName: 'feature/in-use',
        worktreeName: 'feature-in-use',
        returnAfterDirectoryCreated: true,
      }).then(() => null, (error) => error);
      expect(error).toBeInstanceOf(Error);
      expect(error.message.replace(/\\/g, '/')).toBe(
        `Branch is already checked out in ${canonicalWorktree.replace(/\\/g, '/')}`,
      );

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

  it('does not auto-track the remote start ref when creating a new branch from it', async () => {
    if (!canRunGit()) return;

    const previousXdgDataHome = process.env.XDG_DATA_HOME;
    const dataHome = createTempDir();
    process.env.XDG_DATA_HOME = dataHome;

    try {
      const { repository } = createRepositoryWithRemote({ defaultBranch: 'main' });

      const created = await createWorktree(repository, {
        mode: 'new',
        branchName: 'openchamber/feature',
        worktreeName: 'feature-wt',
        startRef: 'remotes/origin/main',
        setUpstream: true,
        upstreamRemote: 'origin',
        upstreamBranch: 'openchamber/feature',
      });

      expect(created.branch).toBe('openchamber/feature');

      await expect.poll(
        () => getWorktreeBootstrapStatus(created.path).then((status) => status.status === 'ready' || status.status === 'failed'),
        { timeout: 5_000 }
      ).toBe(true);

      expect(readBranchConfig(created.path, 'openchamber/feature', 'remote')).toBe('');
      expect(readBranchConfig(created.path, 'openchamber/feature', 'merge')).toBe('');
    } finally {
      if (previousXdgDataHome === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = previousXdgDataHome;
      }
    }
  }, 30_000);

  it('falls back to the remote start ref for upstream tracking when no explicit keys are given', async () => {
    if (!canRunGit()) return;

    const previousXdgDataHome = process.env.XDG_DATA_HOME;
    const dataHome = createTempDir();
    process.env.XDG_DATA_HOME = dataHome;

    try {
      const { repository } = createRepositoryWithRemote({ defaultBranch: 'main' });

      const created = await createWorktree(repository, {
        mode: 'new',
        branchName: 'openchamber/fallback-wt',
        worktreeName: 'fallback-wt',
        startRef: 'remotes/origin/main',
        setUpstream: true,
      });

      await expect.poll(
        () => readBranchConfig(created.path, 'openchamber/fallback-wt', 'merge'),
        { timeout: 5_000 }
      ).toBe('refs/heads/main');
      expect(readBranchConfig(created.path, 'openchamber/fallback-wt', 'remote')).toBe('origin');
    } finally {
      if (previousXdgDataHome === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = previousXdgDataHome;
      }
    }
  }, 30_000);

  it('falls back to the tracked local branch when the source fetch fails', async () => {
    if (!canRunGit()) return;

    const previousXdgDataHome = process.env.XDG_DATA_HOME;
    const dataHome = createTempDir();
    process.env.XDG_DATA_HOME = dataHome;

    try {
      const { repository } = createRepositoryWithRemote({ defaultBranch: 'main' });
      runGit(repository, ['branch', '--set-upstream-to=origin/main', 'next']);
      runGit(repository, ['remote', 'set-url', 'origin', '/nonexistent/openchamber-unreachable.git']);

      const created = await createWorktree(repository, {
        mode: 'new',
        branchName: 'openchamber/stale-ref-wt',
        worktreeName: 'stale-ref-wt',
        startRef: 'remotes/origin/main',
      });

      expect(created.branch).toBe('openchamber/stale-ref-wt');
      expect(created.sourceFetchFailed).toBe(true);
      const expectedHead = runGit(repository, ['rev-parse', 'next']).trim();
      expect(runGit(created.path, ['rev-parse', 'HEAD']).trim()).toBe(expectedHead);
    } finally {
      if (previousXdgDataHome === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = previousXdgDataHome;
      }
    }
  }, 30_000);

  describe('from a local base branch', () => {
    const withDataHome = async (run) => {
      const previousXdgDataHome = process.env.XDG_DATA_HOME;
      process.env.XDG_DATA_HOME = createTempDir();
      try {
        await run();
      } finally {
        if (previousXdgDataHome === undefined) {
          delete process.env.XDG_DATA_HOME;
        } else {
          process.env.XDG_DATA_HOME = previousXdgDataHome;
        }
      }
    };

    // The repository sits on `next` with a local `main` tracking origin/main;
    // a teammate then pushes one commit to main that was never pulled.
    const createRepositoryBehindItsRemote = () => {
      const { remote, repository } = createRepositoryWithRemote({ defaultBranch: 'main' });
      runGit(repository, ['branch', '--track', 'main', 'origin/main']);
      const teammate = createTempDir();
      runGit(teammate, ['clone', remote, '.']);
      runGit(teammate, ['config', 'user.email', 'teammate@example.com']);
      runGit(teammate, ['config', 'user.name', 'Teammate']);
      fs.writeFileSync(path.join(teammate, 'pushed.txt'), 'pushed\n');
      runGit(teammate, ['add', 'pushed.txt']);
      runGit(teammate, ['commit', '-m', 'pushed later']);
      runGit(teammate, ['push', 'origin', 'HEAD:main']);
      return { repository, pushedHead: runGit(teammate, ['rev-parse', 'HEAD']).trim() };
    };

    it('starts from the freshly fetched upstream when nothing is unpublished', async () => {
      if (!canRunGit()) return;
      await withDataHome(async () => {
        const { repository, pushedHead } = createRepositoryBehindItsRemote();
        const localMain = runGit(repository, ['rev-parse', 'main']).trim();

        const created = await createWorktree(repository, {
          mode: 'new',
          branchName: 'openchamber/fresh-base',
          worktreeName: 'fresh-base',
          startRef: 'main',
        });

        expect(created.sourceFetchFailed).toBeUndefined();
        expect(runGit(created.path, ['rev-parse', 'HEAD']).trim()).toBe(pushedHead);
        expect(runGit(repository, ['rev-parse', 'main']).trim()).toBe(localMain);
      });
    }, 30_000);

    it('keeps the local branch when it has unpublished commits', async () => {
      if (!canRunGit()) return;
      await withDataHome(async () => {
        const { repository } = createRepositoryBehindItsRemote();
        runGit(repository, ['checkout', 'main']);
        fs.writeFileSync(path.join(repository, 'local.txt'), 'local\n');
        runGit(repository, ['add', 'local.txt']);
        runGit(repository, ['commit', '-m', 'unpublished']);
        runGit(repository, ['checkout', 'next']);
        const localMain = runGit(repository, ['rev-parse', 'main']).trim();

        const created = await createWorktree(repository, {
          mode: 'new',
          branchName: 'openchamber/local-base',
          worktreeName: 'local-base',
          startRef: 'main',
        });

        expect(runGit(created.path, ['rev-parse', 'HEAD']).trim()).toBe(localMain);
      });
    }, 30_000);

    it('keeps the local branch and reports it when the fetch fails', async () => {
      if (!canRunGit()) return;
      await withDataHome(async () => {
        const { repository } = createRepositoryBehindItsRemote();
        runGit(repository, ['remote', 'set-url', 'origin', '/nonexistent/openchamber-unreachable.git']);
        const localMain = runGit(repository, ['rev-parse', 'main']).trim();

        const created = await createWorktree(repository, {
          mode: 'new',
          branchName: 'openchamber/offline-base',
          worktreeName: 'offline-base',
          startRef: 'main',
        });

        expect(created.sourceFetchFailed).toBe(true);
        expect(runGit(created.path, ['rev-parse', 'HEAD']).trim()).toBe(localMain);
      });
    }, 30_000);
  });

  it('rejects creation from a remote start ref that was never fetched and cannot be fetched', async () => {
    if (!canRunGit()) return;

    const previousXdgDataHome = process.env.XDG_DATA_HOME;
    const dataHome = createTempDir();
    process.env.XDG_DATA_HOME = dataHome;

    try {
      const { repository } = createRepositoryWithRemote({ defaultBranch: 'main' });
      runGit(repository, ['update-ref', '-d', 'refs/remotes/origin/main']);
      runGit(repository, ['remote', 'set-url', 'origin', '/nonexistent/openchamber-unreachable.git']);

      await expect(createWorktree(repository, {
        mode: 'new',
        branchName: 'openchamber/never-fetched-wt',
        worktreeName: 'never-fetched-wt',
        startRef: 'remotes/origin/main',
      })).rejects.toThrow(/does not appear to be a git repository|Could not read from remote repository/i);
    } finally {
      if (previousXdgDataHome === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = previousXdgDataHome;
      }
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// createWorktree with OpenCode worktree.directory
// ---------------------------------------------------------------------------

describe('createWorktree with OpenCode worktree.directory', () => {
  const initRepo = () => {
    const repo = createTempDir();
    runGit(repo, ['init', '-b', 'main']);
    runGit(repo, ['config', 'user.email', 'test@example.com']);
    runGit(repo, ['config', 'user.name', 'Test User']);
    fs.writeFileSync(path.join(repo, 'README.md'), '# Test\n');
    runGit(repo, ['add', 'README.md']);
    runGit(repo, ['commit', '-m', 'Initial commit']);
    return repo;
  };

  const withDataHome = (test) => async () => {
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

  it('creates and previews under a configured relative folder', withDataHome(async () => {
    if (!canRunGit()) return;

    const repo = initRepo();
    fs.writeFileSync(
      path.join(repo, 'opencode.json'),
      JSON.stringify({ worktree: { directory: '.worktrees' } }),
    );

    const preview = await previewWorktreeCreate(repo, { mode: 'new', worktreeName: 'preview-tree' });
    expect(path.basename(preview.path)).toBe('preview-tree');
    expect(fs.realpathSync(path.dirname(preview.path))).toBe(fs.realpathSync(path.join(repo, '.worktrees')));

    const created = await createWorktree(repo, {
      mode: 'new',
      branchName: 'openchamber/configured-tree',
      worktreeName: 'configured-tree',
    });
    expect(fs.realpathSync(created.path)).toBe(fs.realpathSync(path.join(repo, '.worktrees', 'configured-tree')));

    await removeWorktree(repo, { directory: created.path });
    expect(fs.existsSync(created.path)).toBe(false);
  }));

  it('uses an absolute configured folder as-is', withDataHome(async () => {
    if (!canRunGit()) return;

    const repo = initRepo();
    const target = createTempDir();
    fs.writeFileSync(
      path.join(repo, 'opencode.json'),
      JSON.stringify({ worktree: { directory: target } }),
    );

    const created = await createWorktree(repo, {
      mode: 'new',
      branchName: 'openchamber/absolute-tree',
      worktreeName: 'absolute-tree',
    });
    expect(fs.realpathSync(created.path)).toBe(fs.realpathSync(path.join(target, 'absolute-tree')));
  }));

  it('falls back to the data-dir folder when the setting is unset', withDataHome(async (dataHome) => {
    if (!canRunGit()) return;

    const repo = initRepo();
    const projectID = runGit(repo, ['rev-list', '--max-parents=0', '--all']).trim();

    // `worktree: null` in the custom layer forces the setting off even if the
    // machine running the tests has a global `worktree.directory`.
    const previousOpenCodeConfig = process.env.OPENCODE_CONFIG;
    const customConfig = path.join(createTempDir(), 'opencode.json');
    fs.writeFileSync(customConfig, JSON.stringify({ worktree: null }));
    process.env.OPENCODE_CONFIG = customConfig;
    try {
      const created = await createWorktree(repo, {
        mode: 'new',
        branchName: 'openchamber/fallback-tree',
        worktreeName: 'fallback-tree',
      });

      expect(fs.realpathSync(created.path))
        .toBe(fs.realpathSync(path.join(dataHome, 'opencode', 'worktree', projectID, 'fallback-tree')));
    } finally {
      if (previousOpenCodeConfig === undefined) {
        delete process.env.OPENCODE_CONFIG;
      } else {
        process.env.OPENCODE_CONFIG = previousOpenCodeConfig;
      }
    }
  }));

  it('still removes a leftover under the data-dir root after the setting moves new worktrees', withDataHome(async (dataHome) => {
    if (!canRunGit()) return;

    const repo = initRepo();
    const projectID = runGit(repo, ['rev-list', '--max-parents=0', '--all']).trim();
    const legacyOrphan = path.join(dataHome, 'opencode', 'worktree', projectID, 'legacy-orphan');
    fs.mkdirSync(legacyOrphan, { recursive: true });
    fs.writeFileSync(path.join(legacyOrphan, 'leftover.txt'), 'x');

    fs.writeFileSync(
      path.join(repo, 'opencode.json'),
      JSON.stringify({ worktree: { directory: '.worktrees' } }),
    );

    await removeWorktree(repo, { directory: legacyOrphan });
    expect(fs.existsSync(legacyOrphan)).toBe(false);
  }));

  it('leaves an unregistered directory alone when the configured folder is the repository parent', withDataHome(async () => {
    if (!canRunGit()) return;

    const parent = createTempDir();
    const repo = path.join(parent, 'project');
    fs.mkdirSync(repo);
    runGit(repo, ['init', '-b', 'main']);
    runGit(repo, ['config', 'user.email', 'test@example.com']);
    runGit(repo, ['config', 'user.name', 'Test User']);
    fs.writeFileSync(path.join(repo, 'README.md'), '# Test\n');
    runGit(repo, ['add', 'README.md']);
    runGit(repo, ['commit', '-m', 'Initial commit']);
    fs.writeFileSync(path.join(repo, 'opencode.json'), JSON.stringify({ worktree: { directory: '..' } }));

    const sibling = path.join(parent, 'sibling-project');
    fs.mkdirSync(sibling);
    fs.writeFileSync(path.join(sibling, 'keep.txt'), 'x');

    await removeWorktree(repo, { directory: sibling });
    expect(fs.existsSync(path.join(sibling, 'keep.txt'))).toBe(true);
  }));

  it('still removes a worktree when the project config cannot be read', withDataHome(async (dataHome) => {
    if (!canRunGit()) return;

    const repo = initRepo();
    const projectID = runGit(repo, ['rev-list', '--max-parents=0', '--all']).trim();
    const legacyOrphan = path.join(dataHome, 'opencode', 'worktree', projectID, 'unreadable-orphan');
    fs.mkdirSync(legacyOrphan, { recursive: true });
    fs.writeFileSync(path.join(legacyOrphan, 'leftover.txt'), 'x');

    // A directory where the config file is expected makes the read throw. A
    // removal must not depend on the config being readable, so it falls back to
    // the data-dir root instead of failing.
    fs.mkdirSync(path.join(repo, 'opencode.json'));

    await expect(removeWorktree(repo, { directory: legacyOrphan })).resolves.toBe(true);
    expect(fs.existsSync(legacyOrphan)).toBe(false);
  }));
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

  const getRemoteUrlOrNull = (directory, remote) => {
    try {
      return runGit(directory, ['remote', 'get-url', remote]).trim();
    } catch {
      return null;
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

  it('rejects direct contributor creation without managed transfer', async () => {
    if (!canRunGit()) return;

    await withDataHome(async () => {
      const { repository } = createRepositoryWithRemote();
      const fork = createTempDir();
      runGit(fork, ['init', '--bare']);
      publishForkHead(repository, fork, 'feature/login');

      await expect(createWorktree(repository, {
        ...forkWorktreeInput({ fork, worktreeName: 'pr-42' }),
        contributorFork: true,
      }))
        .rejects.toMatchObject({ code: 'CONTRIBUTOR_MANAGED_TRANSFER_REQUIRED', status: 409 });
      expect(runGit(repository, ['remote'])).not.toContain('pr-alice');
    });
  }, 30_000);

  it('persists contributor provenance before success and skips hooks, setup, and upstream', async () => {
    if (!canRunGit()) return;

    await withDataHome(async (dataHome) => {
      const { repository } = createRepositoryWithRemote();
      const fork = createTempDir();
      runGit(fork, ['init', '--bare']);
      const sha = publishForkHead(repository, fork, 'feature/login');
      runGit(repository, ['update-ref', 'refs/remotes/pr-alice/feature/login', sha]);
      const hookMarker = path.join(dataHome, 'contributor-hook');
      const setupMarker = path.join(dataHome, 'contributor-setup');
      const setupScript = path.join(dataHome, 'contributor-setup.cjs');
      fs.writeFileSync(path.join(repository, '.git', 'hooks', 'post-checkout'), `#!/bin/sh\n: > ${JSON.stringify(hookMarker)}\n`);
      fs.chmodSync(path.join(repository, '.git', 'hooks', 'post-checkout'), 0o755);
      fs.writeFileSync(setupScript, `require('node:fs').writeFileSync(${JSON.stringify(setupMarker)}, 'ran');\n`);
      const compareAndSwap = vi.fn(async (_directory, expectedRevision, provenance) => ({
        worktreeId: 'worktree_one', repositoryId: 'repo_one', revision: expectedRevision + 1, provenance,
      }));

      const created = await createWorktree(repository, {
        ...forkWorktreeInput({ fork, worktreeName: 'pr-42-safe' }),
        contributorTransferComplete: true,
        setUpstream: false,
        contributorFork: true,
        expectedRevision: sha,
        returnAfterDirectoryCreated: true,
        startCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(setupScript)}`,
      }, {
        contributorProvenance: { compareAndSwap },
        contributorSource: {
          headRef: 'refs/heads/feature/login', sourceProject: { id: 'alice/app' }, targetProject: { id: 'acme/app' },
          context: { provider: 'github', instance: 'github.com', accountId: 'account_one', bindingRevision: 3, primaryRemote: 'origin' },
        },
      });

      expect(created.provenance).toEqual({
        kind: 'contributor-fork', revision: 1, trust: 'untrusted', push: 'destination-selection-required',
      });
      expect(compareAndSwap).toHaveBeenCalledWith(created.path, 0, {
        kind: 'contributor-fork', remoteName: 'pr-alice',
        endpointFingerprint: expect.any(String), sourceSha: sha,
        sourceRef: 'refs/heads/feature/login', sourceProjectId: 'alice/app', targetProjectId: 'acme/app',
        provider: 'github', instance: 'github.com', accountId: 'account_one', bindingRevision: 3,
        primaryRemote: 'origin', projectId: expect.any(String), setupCommand: expect.any(String),
      });
      await expect.poll(() => getWorktreeBootstrapStatus(created.path).then((status) => status.status), {
        timeout: 5_000,
      }).toBe('ready');
      expect(getBranchTrackingRemote(created.path, 'feature/login')).toBe('');
      expect(fs.existsSync(hookMarker)).toBe(false);
      expect(fs.existsSync(setupMarker)).toBe(false);
    });
  }, 30_000);

  it('does not report contributor creation when provenance persistence fails', async () => {
    if (!canRunGit()) return;
    await withDataHome(async () => {
      const { repository } = createRepositoryWithRemote();
      const fork = createTempDir();
      runGit(fork, ['init', '--bare']);
      const sha = publishForkHead(repository, fork, 'feature/login');
      runGit(repository, ['update-ref', 'refs/remotes/pr-alice/feature/login', sha]);
      await expect(createWorktree(repository, {
        ...forkWorktreeInput({ fork, worktreeName: 'pr-42-provenance-failure' }),
        contributorTransferComplete: true,
        setUpstream: false,
        contributorFork: true,
        expectedRevision: sha,
      }, {
        contributorProvenance: { compareAndSwap: async () => { throw new Error('provenance write failed'); } },
        contributorSource: {
          headRef: 'refs/heads/feature/login', sourceProject: { id: 'alice/app' }, targetProject: { id: 'acme/app' },
          context: { provider: 'github', instance: 'github.com', accountId: 'account_one', bindingRevision: 3, primaryRemote: 'origin' },
        },
      })).rejects.toThrow('provenance write failed');
      expect(runGit(repository, ['worktree', 'list', '--porcelain'])).not.toContain('pr-42-provenance-failure');
    });
  }, 30_000);

  it('fails closed before transferring a contributor head with ambient credentials', async () => {
    if (!canRunGit()) return;
    await withDataHome(async () => {
      const { repository } = createRepositoryWithRemote();
      const fork = createTempDir();
      runGit(fork, ['init', '--bare']);
      const sha = publishForkHead(repository, fork, 'feature/login');
      await expect(createWorktree(repository, {
        ...forkWorktreeInput({ fork, worktreeName: 'pr-42-managed-transfer-required' }),
        contributorFork: true,
        expectedRevision: sha,
      }, { contributorProvenance: { compareAndSwap: vi.fn() } })).rejects.toMatchObject({
        code: 'CONTRIBUTOR_MANAGED_TRANSFER_REQUIRED', status: 409,
      });
      expect(getRemoteUrlOrNull(repository, 'pr-alice')).toBeNull();
    });
  }, 30_000);

  it('requires an explicit contributor transfer before worktree creation', async () => {
    if (!canRunGit()) return;

    await withDataHome(async () => {
      const { repository } = createRepositoryWithRemote();
      const missingFork = path.join(createTempDir(), 'missing-fork.git');
      const before = runGit(repository, ['worktree', 'list', '--porcelain']);

      await expect(createWorktree(repository, forkWorktreeInput({
        fork: missingFork,
        worktreeName: 'pr-42-unreachable',
      }))).rejects.toThrow(/not available locally/i);

      expect(runGit(repository, ['worktree', 'list', '--porcelain'])).toBe(before);
      expect(getRemoteUrlOrNull(repository, 'pr-alice')).toBeNull();

      const validation = await validateWorktreeCreate(repository, forkWorktreeInput({
        fork: missingFork,
        worktreeName: 'pr-42-unreachable',
      }));
      expect(validation.ok).toBe(false);
      expect(validation.errors.some((error) => /not available locally/i.test(error.message))).toBe(true);
    });
  }, 30_000);

  it('never overwrites an existing remote with a different contributor endpoint', async () => {
    if (!canRunGit()) return;

    await withDataHome(async () => {
      const { repository } = createRepositoryWithRemote();
      const originalFork = createTempDir();
      runGit(originalFork, ['init', '--bare']);
      runGit(repository, ['remote', 'add', 'pr-alice', originalFork]);
      const missingFork = path.join(createTempDir(), 'missing-fork.git');
      const marker = path.join(createTempDir(), 'set-url-used');
      const previousPath = process.env.PATH;
      const previousRealGit = process.env.REAL_GIT;
      const previousMarker = process.env.SET_URL_MARKER;
      if (process.platform !== 'win32') {
        const wrapperDirectory = createTempDir();
        const wrapper = path.join(wrapperDirectory, 'git');
        const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
        fs.writeFileSync(wrapper, `#!/bin/sh
if [ "$1" = "remote" ] && [ "$2" = "set-url" ]; then : > "$SET_URL_MARKER"; fi
exec "$REAL_GIT" "$@"
`);
        fs.chmodSync(wrapper, 0o755);
        process.env.PATH = `${wrapperDirectory}${path.delimiter}${previousPath || ''}`;
        process.env.REAL_GIT = realGit;
        process.env.SET_URL_MARKER = marker;
      }

      try {
        await expect(createWorktree(repository, forkWorktreeInput({
          fork: missingFork,
          worktreeName: 'pr-42-restore-remote',
        }))).rejects.toMatchObject({ code: 'CONTRIBUTOR_REMOTE_COLLISION', status: 409 });

        expect(getRemoteUrlOrNull(repository, 'pr-alice')).toBe(originalFork);
        expect(fs.existsSync(marker)).toBe(false);
      } finally {
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
        if (previousRealGit === undefined) delete process.env.REAL_GIT;
        else process.env.REAL_GIT = previousRealGit;
        if (previousMarker === undefined) delete process.env.SET_URL_MARKER;
        else process.env.SET_URL_MARKER = previousMarker;
      }
    });
  }, 30_000);

  it('rejects a fork branch that moved away from the requested PR head revision', async () => {
    if (!canRunGit()) return;

    await withDataHome(async () => {
      const { repository } = createRepositoryWithRemote();
      const fork = createTempDir();
      runGit(fork, ['init', '--bare']);
      const actualRevision = publishForkHead(repository, fork, 'feature/login');
      runGit(repository, ['update-ref', 'refs/remotes/pr-alice/feature/login', actualRevision]);
      const input = {
        ...forkWorktreeInput({ fork, worktreeName: 'pr-42-stale' }),
        expectedRevision: '1111111111111111111111111111111111111111',
      };

      const validation = await validateWorktreeCreate(repository, input);
      expect(validation.ok).toBe(false);
      expect(validation.errors.some((error) => /revision does not match/i.test(error.message))).toBe(true);
      await expect(createWorktree(repository, input)).rejects.toThrow(/revision does not match/i);
    });
  }, 30_000);

  it('creates from the verified revision when the remote-tracking ref moves before worktree add', async () => {
    if (!canRunGit() || process.platform === 'win32') return;

    await withDataHome(async () => {
      const { repository } = createRepositoryWithRemote();
      const fork = createTempDir();
      runGit(fork, ['init', '--bare']);
      const expectedRevision = publishForkHead(repository, fork, 'feature/login');
      runGit(repository, ['update-ref', 'refs/remotes/pr-alice/feature/login', expectedRevision]);

      fs.writeFileSync(path.join(repository, 'FORK.md'), '# moved\n');
      runGit(repository, ['add', 'FORK.md']);
      runGit(repository, ['commit', '-m', 'move tracking ref during worktree creation']);
      const movedRevision = runGit(repository, ['rev-parse', 'HEAD']).trim();

      const wrapperDirectory = createTempDir();
      const marker = path.join(wrapperDirectory, 'moved');
      const wrapper = path.join(wrapperDirectory, 'git');
      const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
      fs.writeFileSync(wrapper, `#!/bin/sh
if [ "$1" = "worktree" ] && [ "$2" = "add" ] && [ ! -e "$RACE_MARKER" ]; then
  : > "$RACE_MARKER"
  "$REAL_GIT" -C "$RACE_REPOSITORY" update-ref "$RACE_REF" "$RACE_REVISION" || exit $?
fi
exec "$REAL_GIT" "$@"
`);
      fs.chmodSync(wrapper, 0o755);

      const previousEnvironment = {
        PATH: process.env.PATH,
        REAL_GIT: process.env.REAL_GIT,
        RACE_MARKER: process.env.RACE_MARKER,
        RACE_REPOSITORY: process.env.RACE_REPOSITORY,
        RACE_REF: process.env.RACE_REF,
        RACE_REVISION: process.env.RACE_REVISION,
      };
      Object.assign(process.env, {
        PATH: `${wrapperDirectory}${path.delimiter}${process.env.PATH || ''}`,
        REAL_GIT: realGit,
        RACE_MARKER: marker,
        RACE_REPOSITORY: repository,
        RACE_REF: 'refs/remotes/pr-alice/feature/login',
        RACE_REVISION: movedRevision,
      });

      try {
        const created = await createWorktree(repository, {
          ...forkWorktreeInput({ fork, worktreeName: 'pr-42-race' }),
          expectedRevision,
        });

        expect(fs.existsSync(marker)).toBe(true);
        expect(runGit(created.path, ['rev-parse', 'HEAD']).trim()).toBe(expectedRevision);
        expect(created.branch).toBe('feature/login');
      } finally {
        for (const [key, value] of Object.entries(previousEnvironment)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
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

describe('contributor checkout trust inspection', () => {
  it('inspects the effective relative hooksPath from the worktree directory', async () => {
    const { repository } = createRepositoryWithRemote();
    const hooksDirectory = path.join(repository, 'trusted-hooks');
    fs.mkdirSync(hooksDirectory);
    const hookPath = path.join(hooksDirectory, 'post-checkout');
    fs.writeFileSync(hookPath, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(hookPath, 0o755);
    runGit(repository, ['config', 'core.hooksPath', 'trusted-hooks']);
    const sourceSha = runGit(repository, ['rev-parse', 'HEAD']).trim();

    const inspection = await inspectContributorCheckoutActions(repository, {
      sourceSha, projectId: 'missing_project', setupCommand: '',
    });

    expect(inspection.actions).toEqual([expect.objectContaining({
      kind: 'post-checkout-hook', path: hookPath,
    })]);
  });

  it('binds checkout trust to the hook invocation path as well as its bytes', async () => {
    const { repository } = createRepositoryWithRemote();
    const firstDirectory = path.join(repository, 'first-hooks');
    const secondDirectory = path.join(repository, 'second-hooks');
    fs.mkdirSync(firstDirectory);
    fs.mkdirSync(secondDirectory);
    for (const directory of [firstDirectory, secondDirectory]) {
      const hookPath = path.join(directory, 'post-checkout');
      fs.writeFileSync(hookPath, '#!/bin/sh\nexit 0\n');
      fs.chmodSync(hookPath, 0o755);
    }
    const sourceSha = runGit(repository, ['rev-parse', 'HEAD']).trim();
    const provenance = { sourceSha, projectId: 'missing_project', setupCommand: '' };
    runGit(repository, ['config', 'core.hooksPath', 'first-hooks']);
    const first = await inspectContributorCheckoutActions(repository, provenance);
    runGit(repository, ['config', 'core.hooksPath', 'second-hooks']);
    const second = await inspectContributorCheckoutActions(repository, provenance);

    expect(first.actions[0].contentDigest).toBe(second.actions[0].contentDigest);
    expect(first.digest).not.toBe(second.digest);
  });
});

// ---------------------------------------------------------------------------
// Option-like remote names
// ---------------------------------------------------------------------------

describe('git remote arguments with option-like names', () => {
  const OPTION_LIKE_REMOTE = '--mirror';

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

  const addOptionLikeRemote = (repository, remoteUrl, { fetch = true } = {}) => {
    runGit(repository, ['remote', 'add', '--', OPTION_LIKE_REMOTE, remoteUrl]);
    if (fetch) {
      runGit(repository, ['fetch', '--', OPTION_LIKE_REMOTE]);
    }
  };

  it('creates a worktree with a remote whose name looks like an option', async () => {
    if (!canRunGit()) return;

    await withDataHome(async () => {
      const { remote, repository } = createRepositoryWithRemote();

      const created = await createWorktree(repository, {
        mode: 'new',
        branchName: 'openchamber/option-like-remote',
        worktreeName: 'option-like-remote',
        ensureRemoteName: OPTION_LIKE_REMOTE,
        ensureRemoteUrl: remote,
      });

      expect(created.branch).toBe('openchamber/option-like-remote');
      expect(runGit(repository, ['remote', 'get-url', '--', OPTION_LIKE_REMOTE]).trim()).toBe(remote);
    });
  }, 30_000);

  it('removes an option-like remote', async () => {
    if (!canRunGit()) return;

    const { remote, repository } = createRepositoryWithRemote();
    addOptionLikeRemote(repository, remote, { fetch: false });

    await removeRemote(repository, { remote: OPTION_LIKE_REMOTE });

    expect(runGit(repository, ['remote']).split('\n').map((line) => line.trim())).not.toContain(OPTION_LIKE_REMOTE);
  }, 30_000);

  it('validates a start ref and upstream on an option-like remote', async () => {
    if (!canRunGit()) return;

    await withDataHome(async () => {
      const { remote, repository } = createRepositoryWithRemote();
      fs.writeFileSync(path.join(repository, 'OPTION.md'), '# option\n');
      runGit(repository, ['add', 'OPTION.md']);
      runGit(repository, ['commit', '-m', 'option-like branch']);
      runGit(repository, ['push', '--', remote, 'HEAD:refs/heads/feature/option-like']);
      addOptionLikeRemote(repository, remote);

      const validation = await validateWorktreeCreate(repository, {
        mode: 'new',
        branchName: 'feature/option-like-worktree',
        worktreeName: 'option-like-worktree',
        startRef: `remotes/${OPTION_LIKE_REMOTE}/feature/option-like`,
        setUpstream: true,
        upstreamRemote: OPTION_LIKE_REMOTE,
        upstreamBranch: 'feature/option-like',
      });

      expect(validation.errors).toEqual([]);
      expect(validation.ok).toBe(true);
    });
  }, 30_000);

  it('creates a worktree from an option-like remote start ref', async () => {
    if (!canRunGit()) return;

    await withDataHome(async () => {
      const { remote, repository } = createRepositoryWithRemote();
      fs.writeFileSync(path.join(repository, 'OPTION.md'), '# option\n');
      runGit(repository, ['add', 'OPTION.md']);
      runGit(repository, ['commit', '-m', 'option-like start ref']);
      const sha = runGit(repository, ['rev-parse', 'HEAD']).trim();
      runGit(repository, ['push', '--', remote, 'HEAD:refs/heads/feature/option-like']);
      addOptionLikeRemote(repository, remote, { fetch: false });

      const created = await createWorktree(repository, {
        mode: 'new',
        branchName: 'openchamber/option-like-start-ref',
        worktreeName: 'option-like-start-ref',
        startRef: `remotes/${OPTION_LIKE_REMOTE}/feature/option-like`,
      });

      expect(created.branch).toBe('openchamber/option-like-start-ref');
      expect(runGit(created.path, ['rev-parse', 'HEAD']).trim()).toBe(sha);
      await expect.poll(
        () => getWorktreeBootstrapStatus(created.path).then((status) => status.status === 'ready' || status.status === 'failed'),
        { timeout: 5_000 }
      ).toBe(true);
    });
  }, 30_000);

  it('lists branches without treating an option-like remote as an option', async () => {
    if (!canRunGit()) return;

    const { remote, repository } = createRepositoryWithRemote();
    addOptionLikeRemote(repository, remote);
    const head = runGit(repository, ['rev-parse', 'HEAD']).trim();
    runGit(repository, ['update-ref', `refs/remotes/${OPTION_LIKE_REMOTE}/gone`, head]);

    const branches = await getBranches(repository);

    expect(branches.all).toContain(`remotes/${OPTION_LIKE_REMOTE}/react`);
    expect(branches.all).not.toContain(`remotes/${OPTION_LIKE_REMOTE}/gone`);
    expect(branches.defaultBranches[OPTION_LIKE_REMOTE]).toBe('react');
  }, 30_000);

  it('does not interpret an option-like ensureRemoteUrl as a git option when validating', async () => {
    if (!canRunGit()) return;

    await withDataHome(async () => {
      const { repository } = createRepositoryWithRemote();
      const markerPath = path.join(createTempDir(), 'upload-pack-ran.marker');
      const scriptPath = path.join(createTempDir(), 'upload-pack-probe.sh');
      fs.writeFileSync(scriptPath, `#!/bin/sh\ntouch ${JSON.stringify(markerPath)}\nexit 1\n`);
      fs.chmodSync(scriptPath, 0o755);

      const validation = await validateWorktreeCreate(repository, {
        mode: 'existing',
        branchName: 'feature/login-wt',
        worktreeName: 'feature-login-wt',
        existingBranch: 'remotes/pr-alice/feature/login',
        ensureRemoteName: 'pr-alice',
        ensureRemoteUrl: `--upload-pack=${scriptPath}`,
      });

      expect(fs.existsSync(markerPath)).toBe(false);
      expect(validation.ok).toBe(false);
    });
  }, 30_000);
});

// ---------------------------------------------------------------------------
// removeWorktree
// ---------------------------------------------------------------------------

describe('removeWorktree', () => {
  const createRemovalWorktree = () => {
    const repo = fs.realpathSync(createTempDir());
    const worktree = path.join(fs.realpathSync(createTempDir()), 'linked');
    runGit(repo, ['init', '-b', 'main']);
    runGit(repo, ['config', 'user.email', 'test@example.com']);
    runGit(repo, ['config', 'user.name', 'Test User']);
    fs.writeFileSync(path.join(repo, 'README.md'), '# Test\n');
    runGit(repo, ['add', 'README.md']);
    runGit(repo, ['commit', '-m', 'init']);
    runGit(repo, ['worktree', 'add', '-b', 'feature/remove', worktree]);
    const gitEntry = path.join(worktree, '.git');
    const metadata = fs.realpathSync(fs.readFileSync(gitEntry, 'utf8').slice('gitdir: '.length).trim());
    return { repo, worktree, gitEntry, metadata };
  };

  const installGitDirectoryLink = ({ worktree, gitEntry, metadata }, absolute = false) => {
    const linkTarget = absolute ? metadata : path.relative(worktree, metadata);
    fs.unlinkSync(gitEntry);
    fs.symlinkSync(linkTarget, gitEntry, 'dir');
    return linkTarget;
  };

  const interceptGitFileReplacement = (gitEntry, afterReplacement) => {
    const link = fs.promises.link.bind(fs.promises);
    let intercepted = false;
    return vi.spyOn(fs.promises, 'link').mockImplementation(async (source, destination) => {
      await link(source, destination);
      if (destination === gitEntry && !intercepted) {
        intercepted = true;
        afterReplacement();
      }
    });
  };

  it('removes a registered worktree with a relative .git directory symlink', async () => {
    if (!canRunGit() || process.platform === 'win32') return;
    const fixture = createRemovalWorktree();
    installGitDirectoryLink(fixture);

    await expect(removeWorktree(fixture.repo, {
      directory: fixture.worktree,
      deleteLocalBranch: true,
    })).resolves.toBe(true);

    expect(fs.existsSync(fixture.worktree)).toBe(false);
    expect(fs.existsSync(fixture.metadata)).toBe(false);
    expect(() => runGit(fixture.repo, ['show-ref', '--verify', 'refs/heads/feature/remove'])).toThrow();
    expect(runGit(fixture.repo, ['worktree', 'list', '--porcelain'])).not.toContain(fixture.worktree);
  });

  it('removes an absolute .git directory symlink only after instance disposal', async () => {
    if (!canRunGit() || process.platform === 'win32') return;
    const fixture = createRemovalWorktree();
    const linkTarget = installGitDirectoryLink(fixture, true);
    const disposalStates = [];

    await expect(removeWorktree(fixture.repo, {
      directory: fixture.worktree,
      disposeInstance: async (directory) => {
        disposalStates.push({
          directory,
          linkTarget: fs.readlinkSync(fixture.gitEntry),
          metadataExists: fs.existsSync(fixture.metadata),
          branch: runGit(directory, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(),
        });
      },
    })).resolves.toBe(true);

    expect(disposalStates).toEqual([{
      directory: fixture.worktree,
      linkTarget,
      metadataExists: true,
      branch: 'feature/remove',
    }]);
    expect(fs.existsSync(fixture.worktree)).toBe(false);
    expect(fs.existsSync(fixture.metadata)).toBe(false);
    expect(runGit(fixture.repo, ['show-ref', '--verify', 'refs/heads/feature/remove'])).toContain('refs/heads/feature/remove');
  });

  it.each([false, true])('removes a standard .git file with deleteLocalBranch=%s', async (deleteLocalBranch) => {
    if (!canRunGit()) return;
    const fixture = createRemovalWorktree();
    expect(fs.lstatSync(fixture.gitEntry).isFile()).toBe(true);
    const renameSpy = vi.spyOn(fs.promises, 'rename');
    try {
      await expect(removeWorktree(fixture.repo, {
        directory: fixture.worktree,
        deleteLocalBranch,
      })).resolves.toBe(true);
      expect(renameSpy).not.toHaveBeenCalled();
    } finally {
      renameSpy.mockRestore();
    }

    expect(fs.existsSync(fixture.worktree)).toBe(false);
    expect(fs.existsSync(fixture.metadata)).toBe(false);
    if (deleteLocalBranch) {
      expect(() => runGit(fixture.repo, ['show-ref', '--verify', 'refs/heads/feature/remove'])).toThrow();
    } else {
      expect(runGit(fixture.repo, ['show-ref', '--verify', 'refs/heads/feature/remove'])).toContain('refs/heads/feature/remove');
    }
  });

  it.each(['file', 'symlink'])('preserves a concurrent .git %s installed before conversion claims the entry', async (kind) => {
    if (!canRunGit() || process.platform === 'win32') return;
    const fixture = createRemovalWorktree();
    const originalTarget = installGitDirectoryLink(fixture);
    const concurrentContents = kind === 'file'
      ? `gitdir: ${fixture.metadata}\nconcurrent entry must survive\n`
      : `./${originalTarget}`;
    runGit(fixture.repo, ['worktree', 'lock', fixture.worktree]);
    const branchHead = runGit(fixture.repo, ['rev-parse', 'feature/remove']).trim();
    const rename = fs.promises.rename.bind(fs.promises);
    let injected = false;
    const renameSpy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (source, destination) => {
      const changesGitEntry = (source === fixture.gitEntry && destination.startsWith(`${fixture.gitEntry}.openchamber-`))
        || (destination === fixture.gitEntry && source.startsWith(`${fixture.gitEntry}.openchamber-`));
      if (!injected && changesGitEntry && fs.lstatSync(fixture.gitEntry).isSymbolicLink()) {
        injected = true;
        execFileSync(process.execPath, ['-e', `
          const fs = require('node:fs');
          const [entry, kind, contents] = process.argv.slice(1);
          const staged = entry + '.concurrent';
          if (kind === 'file') fs.writeFileSync(staged, contents, { flag: 'wx' });
          else fs.symlinkSync(contents, staged, 'dir');
          fs.renameSync(staged, entry);
        `, fixture.gitEntry, kind, concurrentContents], { stdio: 'pipe', timeout: 10_000 });
      }
      await rename(source, destination);
    });
    try {
      await expect(removeWorktree(fixture.repo, {
        directory: fixture.worktree,
        deleteLocalBranch: true,
      })).rejects.toThrow();
    } finally {
      renameSpy.mockRestore();
    }

    expect(injected).toBe(true);
    const entry = fs.lstatSync(fixture.gitEntry);
    if (kind === 'file') {
      expect(entry.isFile()).toBe(true);
      expect(fs.readFileSync(fixture.gitEntry, 'utf8')).toBe(concurrentContents);
    } else {
      expect(entry.isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(fixture.gitEntry)).toBe(concurrentContents);
    }
    expect(fs.existsSync(fixture.metadata)).toBe(true);
    expect(runGit(fixture.repo, ['rev-parse', 'feature/remove']).trim()).toBe(branchHead);
    expect(fs.readdirSync(fixture.worktree).sort()).toEqual(['.git', 'README.md']);
  });

  it.each(['file', 'symlink'])('preserves a newer .git %s created during exclusive installation', async (kind) => {
    if (!canRunGit() || process.platform === 'win32') return;
    const fixture = createRemovalWorktree();
    const originalTarget = installGitDirectoryLink(fixture);
    const concurrentContents = kind === 'file' ? 'newest concurrent gitdir file\n' : `./${originalTarget}`;
    runGit(fixture.repo, ['worktree', 'lock', fixture.worktree]);
    const link = fs.promises.link.bind(fs.promises);
    let injected = false;
    const linkSpy = vi.spyOn(fs.promises, 'link').mockImplementation(async (source, destination) => {
      if (!injected && destination === fixture.gitEntry) {
        injected = true;
        if (kind === 'file') fs.writeFileSync(destination, concurrentContents, { flag: 'wx' });
        else fs.symlinkSync(concurrentContents, destination, 'dir');
      }
      await link(source, destination);
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(removeWorktree(fixture.repo, {
        directory: fixture.worktree,
        deleteLocalBranch: true,
      })).rejects.toThrow();
      expect(injected).toBe(true);
      if (kind === 'file') expect(fs.readFileSync(fixture.gitEntry, 'utf8')).toBe(concurrentContents);
      else expect(fs.readlinkSync(fixture.gitEntry)).toBe(concurrentContents);
      const claims = fs.readdirSync(fixture.worktree).filter(name => name.startsWith('.git.openchamber-'));
      expect(claims).toHaveLength(1);
      const claim = path.join(fixture.worktree, claims[0]);
      expect(fs.readlinkSync(claim)).toBe(originalTarget);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(claim));
      expect(fs.existsSync(fixture.metadata)).toBe(true);
      expect(runGit(fixture.repo, ['show-ref', '--verify', 'refs/heads/feature/remove'])).toContain('refs/heads/feature/remove');
    } finally {
      linkSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it('leaves the original .git entry untouched when preparation cannot claim it', async () => {
    if (!canRunGit() || process.platform === 'win32') return;
    const fixture = createRemovalWorktree();
    const originalTarget = installGitDirectoryLink(fixture);
    const rename = fs.promises.rename.bind(fs.promises);
    const renameSpy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (source, destination) => {
      if (source === fixture.gitEntry) throw new Error('claim denied');
      await rename(source, destination);
    });
    try {
      await expect(removeWorktree(fixture.repo, {
        directory: fixture.worktree,
        deleteLocalBranch: true,
      })).rejects.toThrow();
    } finally {
      renameSpy.mockRestore();
    }
    expect(fs.readlinkSync(fixture.gitEntry)).toBe(originalTarget);
    expect(fs.readdirSync(fixture.worktree).sort()).toEqual(['.git', 'README.md']);
    expect(fs.existsSync(fixture.metadata)).toBe(true);
    expect(runGit(fixture.repo, ['show-ref', '--verify', 'refs/heads/feature/remove'])).toContain('refs/heads/feature/remove');
  });

  it('retains the claimed symlink when preparation cannot install or restore .git', async () => {
    if (!canRunGit() || process.platform === 'win32') return;
    const fixture = createRemovalWorktree();
    const originalTarget = installGitDirectoryLink(fixture);
    runGit(fixture.repo, ['worktree', 'lock', fixture.worktree]);
    const installationError = new Error('installation denied');
    const linkSpy = vi.spyOn(fs.promises, 'link').mockRejectedValue(installationError);
    const symlinkSpy = vi.spyOn(fs.promises, 'symlink').mockRejectedValue(new Error('restoration denied'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(removeWorktree(fixture.repo, {
        directory: fixture.worktree,
        deleteLocalBranch: true,
      })).rejects.toBe(installationError);
      expect(fs.lstatSync(fixture.gitEntry, { throwIfNoEntry: false })).toBeUndefined();
      const claims = fs.readdirSync(fixture.worktree).filter(name => name.startsWith('.git.openchamber-'));
      expect(claims).toHaveLength(1);
      const claim = path.join(fixture.worktree, claims[0]);
      expect(fs.readlinkSync(claim)).toBe(originalTarget);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(claim));
      expect(fs.existsSync(fixture.metadata)).toBe(true);
      expect(runGit(fixture.repo, ['show-ref', '--verify', 'refs/heads/feature/remove'])).toContain('refs/heads/feature/remove');
    } finally {
      linkSpy.mockRestore();
      symlinkSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it.each(['worktree', 'metadata'])('does not recreate a %s removed after the preparation claim', async (kind) => {
    if (!canRunGit() || process.platform === 'win32') return;
    const fixture = createRemovalWorktree();
    const originalTarget = installGitDirectoryLink(fixture);
    const removedPath = kind === 'worktree' ? fixture.worktree : fixture.metadata;
    const rename = fs.promises.rename.bind(fs.promises);
    let claimedEntry;
    const renameSpy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (source, destination) => {
      const claimsSymlink = source === fixture.gitEntry && fs.lstatSync(source).isSymbolicLink();
      await rename(source, destination);
      if (claimsSymlink) {
        claimedEntry = destination;
        fs.rmSync(removedPath, { recursive: true, force: true });
      }
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(removeWorktree(fixture.repo, {
        directory: fixture.worktree,
        deleteLocalBranch: true,
      })).rejects.toThrow();
      expect(claimedEntry).toBeDefined();
      expect(fs.existsSync(removedPath)).toBe(false);
      expect(fs.lstatSync(fixture.gitEntry, { throwIfNoEntry: false })).toBeUndefined();
      if (kind === 'metadata') expect(fs.readlinkSync(claimedEntry)).toBe(originalTarget);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(claimedEntry));
      expect(runGit(fixture.repo, ['show-ref', '--verify', 'refs/heads/feature/remove'])).toContain('refs/heads/feature/remove');
    } finally {
      renameSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it.each([false, true])('restores the exact .git symlink target after locked removal fails, absolute=%s', async (absolute) => {
    if (!canRunGit() || process.platform === 'win32') return;
    const fixture = createRemovalWorktree();
    let linkTarget = installGitDirectoryLink(fixture, absolute);
    if (!absolute) {
      fs.unlinkSync(fixture.gitEntry);
      linkTarget = `.//${linkTarget}`;
      fs.symlinkSync(linkTarget, fixture.gitEntry, 'dir');
    }
    const branchHead = runGit(fixture.repo, ['rev-parse', 'feature/remove']).trim();
    runGit(fixture.repo, ['worktree', 'lock', fixture.worktree]);

    const replacementStates = [];
    const recordReplacement = () => replacementStates.push({
      kind: fs.lstatSync(fixture.gitEntry).isSymbolicLink() ? 'symlink' : 'file',
      metadataExists: fs.existsSync(fixture.metadata),
    });
    const link = fs.promises.link.bind(fs.promises);
    const linkSpy = vi.spyOn(fs.promises, 'link').mockImplementation(async (source, destination) => {
      await link(source, destination);
      if (destination === fixture.gitEntry) recordReplacement();
    });
    const symlink = fs.promises.symlink.bind(fs.promises);
    const symlinkSpy = vi.spyOn(fs.promises, 'symlink').mockImplementation(async (target, destination, type) => {
      await symlink(target, destination, type);
      if (destination === fixture.gitEntry) recordReplacement();
    });
    try {
      await expect(removeWorktree(fixture.repo, {
        directory: fixture.worktree,
        deleteLocalBranch: true,
      })).rejects.toThrow(/locked/);
    } finally {
      linkSpy.mockRestore();
      symlinkSpy.mockRestore();
    }

    expect(replacementStates).toEqual([
      { kind: 'file', metadataExists: true },
      { kind: 'symlink', metadataExists: true },
    ]);
    expect(fs.readlinkSync(fixture.gitEntry)).toBe(linkTarget);
    expect(fs.readFileSync(path.join(fixture.metadata, 'commondir'), 'utf8')).toBe('../..\n');
    expect(fs.readFileSync(path.join(fixture.metadata, 'gitdir'), 'utf8').trim()).toBe(fixture.gitEntry);
    expect(fs.readFileSync(path.join(fixture.worktree, 'README.md'), 'utf8')).toBe('# Test\n');
    expect(runGit(fixture.repo, ['rev-parse', 'feature/remove']).trim()).toBe(branchHead);
    expect(fs.readdirSync(fixture.worktree).sort()).toEqual(['.git', 'README.md']);
  });

  it.each(['edited file', 'replacement file', 'symlink'])('does not overwrite a concurrent .git %s after removal fails', async (kind) => {
    if (!canRunGit() || process.platform === 'win32') return;
    const fixture = createRemovalWorktree();
    installGitDirectoryLink(fixture);
    runGit(fixture.repo, ['worktree', 'lock', fixture.worktree]);
    let concurrentEntry;
    let concurrentContents;
    const renameSpy = interceptGitFileReplacement(fixture.gitEntry, () => {
      const contents = fs.readFileSync(fixture.gitEntry, 'utf8');
      expect(contents).toBe(`gitdir: ${fixture.metadata}\n`);
      if (kind === 'edited file') {
        fs.writeFileSync(fixture.gitEntry, `${contents}concurrent change\n`);
      } else if (kind === 'replacement file') {
        const replacement = path.join(fixture.worktree, 'replacement');
        fs.writeFileSync(replacement, contents);
        fs.renameSync(replacement, fixture.gitEntry);
      } else {
        fs.unlinkSync(fixture.gitEntry);
        fs.symlinkSync(fixture.metadata, fixture.gitEntry, 'dir');
      }
      concurrentEntry = fs.lstatSync(fixture.gitEntry);
      concurrentContents = kind === 'symlink'
        ? fs.readlinkSync(fixture.gitEntry) : fs.readFileSync(fixture.gitEntry, 'utf8');
    });
    try {
      await expect(removeWorktree(fixture.repo, {
        directory: fixture.worktree,
        deleteLocalBranch: true,
      })).rejects.toThrow(/locked/);
    } finally {
      renameSpy.mockRestore();
    }

    expect(fs.lstatSync(fixture.gitEntry).ino).toBe(concurrentEntry.ino);
    expect(kind === 'symlink' ? fs.readlinkSync(fixture.gitEntry) : fs.readFileSync(fixture.gitEntry, 'utf8')).toBe(concurrentContents);
    expect(runGit(fixture.repo, ['show-ref', '--verify', 'refs/heads/feature/remove'])).toContain('refs/heads/feature/remove');
    expect(fs.readdirSync(fixture.worktree).sort()).toEqual(['.git', 'README.md']);
  });

  it.each(['worktree', 'metadata', '.git'])('does not recreate a %s deleted during failed removal', async (kind) => {
    if (!canRunGit() || process.platform === 'win32') return;
    const fixture = createRemovalWorktree();
    installGitDirectoryLink(fixture);
    runGit(fixture.repo, ['worktree', 'lock', fixture.worktree]);
    const removedPath = kind === 'worktree' ? fixture.worktree
      : kind === 'metadata' ? fixture.metadata : fixture.gitEntry;
    const renameSpy = interceptGitFileReplacement(fixture.gitEntry, () => {
      fs.rmSync(removedPath, { recursive: true, force: true });
    });
    try {
      await expect(removeWorktree(fixture.repo, {
        directory: fixture.worktree,
        deleteLocalBranch: true,
      })).rejects.toThrow();
    } finally {
      renameSpy.mockRestore();
    }

    expect(fs.existsSync(removedPath)).toBe(false);
    if (kind === 'metadata') {
      expect(fs.lstatSync(fixture.gitEntry).isFile()).toBe(true);
      expect(fs.readFileSync(fixture.gitEntry, 'utf8')).toBe(`gitdir: ${fixture.metadata}\n`);
    }
    expect(runGit(fixture.repo, ['show-ref', '--verify', 'refs/heads/feature/remove'])).toContain('refs/heads/feature/remove');
  });

  it('does not overwrite a .git edit made while rollback is being prepared', async () => {
    if (!canRunGit() || process.platform === 'win32') return;
    const fixture = createRemovalWorktree();
    installGitDirectoryLink(fixture);
    runGit(fixture.repo, ['worktree', 'lock', fixture.worktree]);
    const symlink = fs.promises.symlink.bind(fs.promises);
    const symlinkSpy = vi.spyOn(fs.promises, 'symlink').mockImplementation(async (target, destination, type) => {
      if (path.dirname(destination) === fixture.worktree) {
        fs.writeFileSync(fixture.gitEntry, 'concurrent gitdir file\n');
      }
      await symlink(target, destination, type);
    });
    try {
      await expect(removeWorktree(fixture.repo, {
        directory: fixture.worktree,
        deleteLocalBranch: true,
      })).rejects.toThrow(/locked/);
    } finally {
      symlinkSpy.mockRestore();
    }

    expect(fs.readFileSync(fixture.gitEntry, 'utf8')).toBe('concurrent gitdir file\n');
    expect(fs.readdirSync(fixture.worktree).sort()).toEqual(['.git', 'README.md']);
    expect(runGit(fixture.repo, ['show-ref', '--verify', 'refs/heads/feature/remove'])).toContain('refs/heads/feature/remove');
  });

  it.each(['edit', 'delete'])('preserves a concurrent .git %s at the rollback rename boundary', async (change) => {
    if (!canRunGit() || process.platform === 'win32') return;
    const fixture = createRemovalWorktree();
    installGitDirectoryLink(fixture);
    runGit(fixture.repo, ['worktree', 'lock', fixture.worktree]);
    const rename = fs.promises.rename.bind(fs.promises);
    let injected = false;
    const renameSpy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (source, destination) => {
      const claimsEntry = source === fixture.gitEntry && fs.lstatSync(source).isFile();
      if (!injected && claimsEntry) {
        injected = true;
        if (change === 'edit') fs.writeFileSync(fixture.gitEntry, 'concurrent gitdir contents\n');
        else fs.unlinkSync(fixture.gitEntry);
      }
      await rename(source, destination);
    });
    try {
      await expect(removeWorktree(fixture.repo, {
        directory: fixture.worktree,
        deleteLocalBranch: true,
      })).rejects.toThrow(/locked/);
    } finally {
      renameSpy.mockRestore();
    }

    expect(injected).toBe(true);
    const entry = fs.lstatSync(fixture.gitEntry, { throwIfNoEntry: false });
    if (change === 'edit') {
      expect(entry?.isFile()).toBe(true);
      expect(fs.readFileSync(fixture.gitEntry, 'utf8')).toBe('concurrent gitdir contents\n');
    } else {
      expect(entry).toBeUndefined();
    }
    expect(fs.readdirSync(fixture.worktree).sort()).toEqual(change === 'edit' ? ['.git', 'README.md'] : ['README.md']);
    expect(fs.existsSync(fixture.metadata)).toBe(true);
    expect(runGit(fixture.repo, ['show-ref', '--verify', 'refs/heads/feature/remove'])).toContain('refs/heads/feature/remove');
  });

  it.each(['directory', 'file', 'dangling'])('restores a claimed concurrent %s symlink when hardlinks follow source symlinks', async (kind) => {
    if (!canRunGit() || process.platform === 'win32') return;
    const fixture = createRemovalWorktree();
    installGitDirectoryLink(fixture);
    runGit(fixture.repo, ['worktree', 'lock', fixture.worktree]);
    const target = kind === 'directory' ? fixture.metadata : path.join(fixture.repo, 'concurrent.gitdir');
    const contents = `gitdir: ${fixture.metadata}\n`;
    if (kind === 'file') fs.writeFileSync(target, contents);
    const linkTarget = Buffer.from(`.//${path.relative(fixture.worktree, target)}`);
    const rename = fs.promises.rename.bind(fs.promises);
    let claimedEntry;
    const renameSpy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (source, destination) => {
      if (source === fixture.gitEntry && fs.lstatSync(source).isFile()) {
        claimedEntry = destination;
        fs.unlinkSync(source);
        fs.symlinkSync(linkTarget, source, kind === 'directory' ? 'dir' : 'file');
      }
      await rename(source, destination);
    });
    const link = fs.promises.link.bind(fs.promises);
    // Darwin link(2) follows its source symlink; use real filesystem operations
    // with that behaviour so this recovery case runs on Linux too.
    const linkSpy = vi.spyOn(fs.promises, 'link').mockImplementation(async (source, destination) => {
      await link(await fs.promises.realpath(source), destination);
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(removeWorktree(fixture.repo, {
        directory: fixture.worktree,
        deleteLocalBranch: true,
      })).rejects.toThrow(/locked/);
      expect(claimedEntry).toBeDefined();
      expect(fs.lstatSync(fixture.gitEntry, { throwIfNoEntry: false })?.isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(fixture.gitEntry, { encoding: 'buffer' })).toEqual(linkTarget);
      expect(fs.lstatSync(claimedEntry, { throwIfNoEntry: false })).toBeUndefined();
      expect(fs.readdirSync(fixture.worktree).sort()).toEqual(['.git', 'README.md']);
      expect(runGit(fixture.repo, ['show-ref', '--verify', 'refs/heads/feature/remove'])).toContain('refs/heads/feature/remove');
      if (kind === 'file') {
        expect(fs.statSync(target).nlink).toBe(1);
        expect(fs.readFileSync(target, 'utf8')).toBe(contents);
      }
      if (kind === 'dangling') expect(fs.existsSync(target)).toBe(false);
      else expect(runGit(fixture.worktree, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('feature/remove');
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      renameSpy.mockRestore();
      linkSpy.mockRestore();
      warnSpy.mockRestore();
    }

  });

  it('retains a claimed concurrent symlink when symlink restoration fails', async () => {
    if (!canRunGit() || process.platform === 'win32') return;
    const fixture = createRemovalWorktree();
    installGitDirectoryLink(fixture);
    runGit(fixture.repo, ['worktree', 'lock', fixture.worktree]);
    const linkTarget = Buffer.from(`.//${path.relative(fixture.worktree, fixture.metadata)}`);
    const rename = fs.promises.rename.bind(fs.promises);
    let claimedEntry;
    const renameSpy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (source, destination) => {
      if (source === fixture.gitEntry && fs.lstatSync(source).isFile()) {
        claimedEntry = destination;
        fs.unlinkSync(source);
        fs.symlinkSync(linkTarget, source, 'dir');
      }
      await rename(source, destination);
    });
    const restoreError = new Error('concurrent symlink restoration denied');
    const symlinkSpy = vi.spyOn(fs.promises, 'symlink').mockRejectedValue(restoreError);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(removeWorktree(fixture.repo, {
        directory: fixture.worktree,
        deleteLocalBranch: true,
      })).rejects.toThrow(/locked/);
      expect(claimedEntry).toBeDefined();
      expect(fs.lstatSync(fixture.gitEntry, { throwIfNoEntry: false })).toBeUndefined();
      expect(fs.readlinkSync(claimedEntry, { encoding: 'buffer' })).toEqual(linkTarget);
      expect(fs.existsSync(fixture.metadata)).toBe(true);
      expect(runGit(fixture.repo, ['show-ref', '--verify', 'refs/heads/feature/remove'])).toContain('refs/heads/feature/remove');
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(claimedEntry));
    } finally {
      renameSpy.mockRestore();
      symlinkSpy.mockRestore();
      warnSpy.mockRestore();
    }

  });

  it.each(['file', 'symlink'])('retains a claimed symlink changed to a %s while its target is restored', async (kind) => {
    if (!canRunGit() || process.platform === 'win32') return;
    const fixture = createRemovalWorktree();
    installGitDirectoryLink(fixture);
    runGit(fixture.repo, ['worktree', 'lock', fixture.worktree]);
    const linkTarget = Buffer.from(`.//${path.relative(fixture.worktree, fixture.metadata)}`);
    const rename = fs.promises.rename.bind(fs.promises);
    let claimedEntry;
    const renameSpy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (source, destination) => {
      if (source === fixture.gitEntry && fs.lstatSync(source).isFile()) {
        claimedEntry = destination;
        fs.unlinkSync(source);
        fs.symlinkSync(linkTarget, source, 'dir');
      }
      await rename(source, destination);
    });
    const symlink = fs.promises.symlink.bind(fs.promises);
    const symlinkSpy = vi.spyOn(fs.promises, 'symlink').mockImplementation(async (target, destination, type) => {
      await symlink(target, destination, type);
      if (destination === fixture.gitEntry) {
        fs.unlinkSync(claimedEntry);
        if (kind === 'file') fs.writeFileSync(claimedEntry, 'concurrent recovery contents\n');
        else fs.symlinkSync('other-concurrent-target', claimedEntry);
      }
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(removeWorktree(fixture.repo, {
        directory: fixture.worktree,
        deleteLocalBranch: true,
      })).rejects.toThrow(/locked/);
      expect(fs.readlinkSync(fixture.gitEntry, { encoding: 'buffer' })).toEqual(linkTarget);
      expect(fs.lstatSync(claimedEntry, { throwIfNoEntry: false })).toBeDefined();
      if (kind === 'file') expect(fs.readFileSync(claimedEntry, 'utf8')).toBe('concurrent recovery contents\n');
      else expect(fs.readlinkSync(claimedEntry)).toBe('other-concurrent-target');
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(claimedEntry));
    } finally {
      renameSpy.mockRestore();
      symlinkSpy.mockRestore();
      warnSpy.mockRestore();
    }

    expect(runGit(fixture.repo, ['show-ref', '--verify', 'refs/heads/feature/remove'])).toContain('refs/heads/feature/remove');
  });

  it.each(['file', 'symlink'])('retains a claimed concurrent .git %s when a newer entry prevents putting it back', async (kind) => {
    if (!canRunGit() || process.platform === 'win32') return;
    const fixture = createRemovalWorktree();
    installGitDirectoryLink(fixture);
    runGit(fixture.repo, ['worktree', 'lock', fixture.worktree]);
    const rename = fs.promises.rename.bind(fs.promises);
    let claimedEntry;
    const renameSpy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (source, destination) => {
      const claimsTemporaryEntry = source === fixture.gitEntry && fs.lstatSync(source).isFile();
      if (claimsTemporaryEntry) {
        claimedEntry = destination;
        if (kind === 'file') {
          fs.writeFileSync(source, 'older concurrent gitdir file\n');
        } else {
          fs.unlinkSync(source);
          fs.symlinkSync(fixture.metadata, source, 'dir');
        }
      }
      await rename(source, destination);
      if (claimsTemporaryEntry) fs.writeFileSync(source, 'newest concurrent gitdir file\n');
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(removeWorktree(fixture.repo, {
        directory: fixture.worktree,
        deleteLocalBranch: true,
      })).rejects.toThrow(/locked/);
      expect(claimedEntry).toBeDefined();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(claimedEntry));
    } finally {
      renameSpy.mockRestore();
      warnSpy.mockRestore();
    }

    expect(fs.readFileSync(fixture.gitEntry, 'utf8')).toBe('newest concurrent gitdir file\n');
    if (kind === 'file') expect(fs.readFileSync(claimedEntry, 'utf8')).toBe('older concurrent gitdir file\n');
    else expect(fs.readlinkSync(claimedEntry)).toBe(fixture.metadata);
    expect(runGit(fixture.repo, ['show-ref', '--verify', 'refs/heads/feature/remove'])).toContain('refs/heads/feature/remove');
  });

  it('retains a claimed concurrent directory at the logged recovery path', async () => {
    if (!canRunGit() || process.platform === 'win32') return;
    const fixture = createRemovalWorktree();
    installGitDirectoryLink(fixture);
    runGit(fixture.repo, ['worktree', 'lock', fixture.worktree]);
    const rename = fs.promises.rename.bind(fs.promises);
    let claimedEntry;
    const renameSpy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (source, destination) => {
      if (source === fixture.gitEntry && fs.lstatSync(source).isFile()) {
        claimedEntry = destination;
        fs.unlinkSync(source);
        fs.mkdirSync(source);
        fs.writeFileSync(path.join(source, 'canary'), 'concurrent directory contents\n');
      }
      await rename(source, destination);
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(removeWorktree(fixture.repo, {
        directory: fixture.worktree,
        deleteLocalBranch: true,
      })).rejects.toThrow(/locked/);
      expect(claimedEntry).toBeDefined();
      expect(fs.lstatSync(fixture.gitEntry, { throwIfNoEntry: false })).toBeUndefined();
      expect(fs.readFileSync(path.join(claimedEntry, 'canary'), 'utf8')).toBe('concurrent directory contents\n');
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(claimedEntry));
    } finally {
      renameSpy.mockRestore();
      warnSpy.mockRestore();
    }

    expect(fs.existsSync(fixture.metadata)).toBe(true);
    expect(runGit(fixture.repo, ['show-ref', '--verify', 'refs/heads/feature/remove'])).toContain('refs/heads/feature/remove');
  });

  it.each(['worktree', 'metadata'])('does not recreate a %s removed after the rollback claim', async (kind) => {
    if (!canRunGit() || process.platform === 'win32') return;
    const fixture = createRemovalWorktree();
    installGitDirectoryLink(fixture);
    runGit(fixture.repo, ['worktree', 'lock', fixture.worktree]);
    const rename = fs.promises.rename.bind(fs.promises);
    const removedPath = kind === 'worktree' ? fixture.worktree : fixture.metadata;
    let claimedEntry;
    const renameSpy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (source, destination) => {
      const claimsTemporaryEntry = source === fixture.gitEntry && fs.lstatSync(source).isFile();
      await rename(source, destination);
      if (claimsTemporaryEntry) {
        claimedEntry = destination;
        fs.rmSync(removedPath, { recursive: true, force: true });
      }
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(removeWorktree(fixture.repo, {
        directory: fixture.worktree,
        deleteLocalBranch: true,
      })).rejects.toThrow(/locked/);
    } finally {
      renameSpy.mockRestore();
      warnSpy.mockRestore();
    }

    expect(claimedEntry).toBeDefined();
    expect(fs.existsSync(removedPath)).toBe(false);
    expect(fs.existsSync(fixture.gitEntry)).toBe(false);
    if (kind === 'metadata') expect(fs.readFileSync(claimedEntry, 'utf8')).toBe(`gitdir: ${fixture.metadata}\n`);
    expect(runGit(fixture.repo, ['show-ref', '--verify', 'refs/heads/feature/remove'])).toContain('refs/heads/feature/remove');
  });

  it('preserves the native removal error and gitdir file when symlink restoration fails', async () => {
    if (!canRunGit() || process.platform === 'win32') return;
    const fixture = createRemovalWorktree();
    installGitDirectoryLink(fixture);
    runGit(fixture.repo, ['worktree', 'lock', fixture.worktree]);
    const restoreError = new Error('symlink restoration denied');
    const symlinkSpy = vi.spyOn(fs.promises, 'symlink').mockRejectedValue(restoreError);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(removeWorktree(fixture.repo, {
        directory: fixture.worktree,
        deleteLocalBranch: true,
      })).rejects.toThrow(/locked/);
      expect(warnSpy).toHaveBeenCalledWith(
        'Failed to restore worktree .git symlink after removal failed:',
        restoreError,
      );
    } finally {
      symlinkSpy.mockRestore();
      warnSpy.mockRestore();
    }

    expect(fs.lstatSync(fixture.gitEntry).isFile()).toBe(true);
    expect(fs.readFileSync(fixture.gitEntry, 'utf8')).toBe(`gitdir: ${fixture.metadata}\n`);
    expect(fs.readdirSync(fixture.worktree).sort()).toEqual(['.git', 'README.md']);
    expect(runGit(fixture.worktree, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('feature/remove');
  });

  it('restores the original .git symlink when exclusive installation fails', async () => {
    if (!canRunGit() || process.platform === 'win32') return;
    const fixture = createRemovalWorktree();
    const linkTarget = installGitDirectoryLink(fixture);
    const link = fs.promises.link.bind(fs.promises);
    const linkSpy = vi.spyOn(fs.promises, 'link').mockImplementation(async (source, destination) => {
      if (destination === fixture.gitEntry) throw new Error('replacement denied');
      await link(source, destination);
    });
    try {
      await expect(removeWorktree(fixture.repo, {
        directory: fixture.worktree,
        deleteLocalBranch: true,
      })).rejects.toThrow('replacement denied');
    } finally {
      linkSpy.mockRestore();
    }

    expect(fs.readlinkSync(fixture.gitEntry)).toBe(linkTarget);
    expect(fs.existsSync(fixture.metadata)).toBe(true);
    expect(fs.readdirSync(fixture.worktree).sort()).toEqual(['.git', 'README.md']);
    expect(runGit(fixture.repo, ['show-ref', '--verify', 'refs/heads/feature/remove'])).toContain('refs/heads/feature/remove');
  });

  it.each(['primary', 'foreign', 'escaped'])('rejects a .git symlink to %s metadata without deleting the worktree or branch', async (kind) => {
    if (!canRunGit() || process.platform === 'win32') return;
    const fixture = createRemovalWorktree();
    let target;
    if (kind === 'primary') {
      target = path.join(fixture.repo, '.git');
    } else if (kind === 'foreign') {
      target = createRemovalWorktree().metadata;
    } else {
      const outside = path.join(createTempDir(), 'metadata');
      fs.cpSync(fixture.metadata, outside, { recursive: true });
      target = path.join(path.dirname(fixture.metadata), 'escaped');
      fs.symlinkSync(outside, target, 'dir');
    }
    const linkTarget = installGitDirectoryLink({ ...fixture, metadata: target }, true);
    const canary = path.join(target, 'canary');
    fs.writeFileSync(canary, 'untouched\n');

    await expect(removeWorktree(fixture.repo, {
      directory: fixture.worktree,
      deleteLocalBranch: true,
    })).rejects.toThrow('outside this repository\'s worktree metadata');

    expect(fs.readlinkSync(fixture.gitEntry)).toBe(linkTarget);
    expect(fs.readFileSync(canary, 'utf8')).toBe('untouched\n');
    expect(fs.readFileSync(path.join(fixture.worktree, 'README.md'), 'utf8')).toBe('# Test\n');
    expect(runGit(fixture.repo, ['show-ref', '--verify', 'refs/heads/feature/remove'])).toContain('refs/heads/feature/remove');
  });

  it('rejects a .git symlink whose metadata has a different commondir', async () => {
    if (!canRunGit() || process.platform === 'win32') return;
    const fixture = createRemovalWorktree();
    const linkTarget = installGitDirectoryLink(fixture);
    const foreignCommonDirectory = path.join(createRemovalWorktree().repo, '.git');
    fs.writeFileSync(path.join(fixture.metadata, 'commondir'), `${foreignCommonDirectory}\n`);

    await expect(removeWorktree(fixture.repo, {
      directory: fixture.worktree,
      deleteLocalBranch: true,
    })).rejects.toThrow('different common directory');

    expect(fs.readlinkSync(fixture.gitEntry)).toBe(linkTarget);
    expect(fs.existsSync(fixture.metadata)).toBe(true);
    expect(runGit(fixture.repo, ['show-ref', '--verify', 'refs/heads/feature/remove'])).toContain('refs/heads/feature/remove');
  });

  it('rejects a metadata backlink to another registered worktree', async () => {
    if (!canRunGit() || process.platform === 'win32') return;
    const fixture = createRemovalWorktree();
    const otherWorktree = path.join(createTempDir(), 'other');
    runGit(fixture.repo, ['worktree', 'add', '-b', 'feature/other', otherWorktree]);
    const otherGitEntry = path.join(otherWorktree, '.git');
    const otherMetadata = fs.readFileSync(otherGitEntry, 'utf8').slice('gitdir: '.length).trim();
    const linkTarget = installGitDirectoryLink({ ...fixture, metadata: otherMetadata }, true);

    await expect(removeWorktree(fixture.repo, {
      directory: fixture.worktree,
      deleteLocalBranch: true,
    })).rejects.toThrow('backlink does not name this worktree');

    expect(fs.readlinkSync(fixture.gitEntry)).toBe(linkTarget);
    expect(runGit(otherWorktree, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('feature/other');
    expect(runGit(fixture.repo, ['show-ref', '--verify', 'refs/heads/feature/remove'])).toContain('refs/heads/feature/remove');
  });

  it('rejects a metadata backlink to a different entry that resolves to the same directory', async () => {
    if (!canRunGit() || process.platform === 'win32') return;
    const fixture = createRemovalWorktree();
    const metadata = path.join(path.dirname(fixture.metadata), 'wrong-backlink');
    const otherGitEntry = path.join(fixture.worktree, '.git.other');
    fs.cpSync(fixture.metadata, metadata, { recursive: true });
    fs.writeFileSync(path.join(metadata, 'gitdir'), `${otherGitEntry}\n`);
    fs.symlinkSync(metadata, otherGitEntry, 'dir');
    const linkTarget = installGitDirectoryLink({ ...fixture, metadata }, true);

    await expect(removeWorktree(fixture.repo, {
      directory: fixture.worktree,
      deleteLocalBranch: true,
    })).rejects.toThrow('backlink does not name this worktree');

    expect(fs.readlinkSync(fixture.gitEntry)).toBe(linkTarget);
    expect(fs.readlinkSync(otherGitEntry)).toBe(metadata);
    expect(runGit(fixture.repo, ['show-ref', '--verify', 'refs/heads/feature/remove'])).toContain('refs/heads/feature/remove');
  });

  it.each([false, true])('protects the primary workspace with a .git directory symlink, absolute=%s', async (absolute) => {
    if (!canRunGit() || process.platform === 'win32') return;
    const fixture = createRemovalWorktree();
    const gitEntry = path.join(fixture.repo, '.git');
    const metadata = path.join(fixture.repo, 'git-metadata');
    fs.renameSync(gitEntry, metadata);
    const linkTarget = absolute ? metadata : 'git-metadata';
    fs.symlinkSync(linkTarget, gitEntry, 'dir');
    const disposeInstance = vi.fn();

    await expect(removeWorktree(fixture.repo, {
      directory: fixture.repo,
      deleteLocalBranch: true,
      disposeInstance,
    })).rejects.toThrow('Cannot remove the primary workspace');

    expect(disposeInstance).not.toHaveBeenCalled();
    expect(fs.readlinkSync(gitEntry)).toBe(linkTarget);
    expect(runGit(fixture.repo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('main');
    expect(fs.readFileSync(path.join(fixture.repo, 'README.md'), 'utf8')).toBe('# Test\n');
  });

  it('leaves an unregistered unmanaged directory and its .git symlink untouched', async () => {
    if (!canRunGit() || process.platform === 'win32') return;
    const fixture = createRemovalWorktree();
    const orphan = createTempDir();
    const gitEntry = path.join(orphan, '.git');
    fs.symlinkSync(fixture.metadata, gitEntry, 'dir');
    const disposeInstance = vi.fn();

    await expect(removeWorktree(fixture.repo, { directory: orphan, disposeInstance })).resolves.toBe(true);

    expect(disposeInstance).not.toHaveBeenCalled();
    expect(fs.readlinkSync(gitEntry)).toBe(fixture.metadata);
    expect(fs.existsSync(fixture.metadata)).toBe(true);
    expect(fs.existsSync(fixture.worktree)).toBe(true);
  });

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

      const disposeInstance = vi.fn();
      await expect(removeWorktree(repo, {
        directory: sentinel,
        deleteLocalBranch: false,
        disposeInstance,
      })).resolves.toBe(true);
      expect(fs.existsSync(canary)).toBe(true);
      expect(disposeInstance).not.toHaveBeenCalled();
    } finally {
      if (previousXdgDataHome === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = previousXdgDataHome;
      }
    }
  });

  it('disposes the registered worktree instance before git removes the directory', async () => {
    if (!canRunGit()) return;

    const previousXdgDataHome = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = createTempDir();

    try {
      const repo = createTempDir();
      runGit(repo, ['init', '-b', 'main']);
      runGit(repo, ['config', 'user.email', 'test@example.com']);
      runGit(repo, ['config', 'user.name', 'Test User']);
      runGit(repo, ['commit', '--allow-empty', '-m', 'init']);

      const created = await createWorktree(repo, {
        mode: 'new',
        branchName: 'feature/dispose-order',
        worktreeName: 'dispose-order',
      });
      const targetRealPath = fs.realpathSync(created.path);

      let observed = null;
      const disposeInstance = vi.fn(async (worktreeDirectory) => {
        observed = {
          realPath: fs.realpathSync(worktreeDirectory),
          directoryExists: fs.existsSync(worktreeDirectory),
        };
      });

      await expect(removeWorktree(repo, {
        directory: created.path,
        disposeInstance,
      })).resolves.toBe(true);

      expect(disposeInstance).toHaveBeenCalledTimes(1);
      expect(observed).toEqual({ realPath: targetRealPath, directoryExists: true });
      expect(fs.existsSync(created.path)).toBe(false);
    } finally {
      if (previousXdgDataHome === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = previousXdgDataHome;
      }
    }
  });

  it('warns about a failed instance disposal and still removes the worktree', async () => {
    if (!canRunGit()) return;

    const previousXdgDataHome = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = createTempDir();

    try {
      const repo = createTempDir();
      runGit(repo, ['init', '-b', 'main']);
      runGit(repo, ['config', 'user.email', 'test@example.com']);
      runGit(repo, ['config', 'user.name', 'Test User']);
      runGit(repo, ['commit', '--allow-empty', '-m', 'init']);

      const created = await createWorktree(repo, {
        mode: 'new',
        branchName: 'feature/dispose-failure',
        worktreeName: 'dispose-failure',
      });

      const disposeInstance = vi.fn(async () => {
        throw new Error('OpenCode API URL is not available');
      });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      try {
        await expect(removeWorktree(repo, {
          directory: created.path,
          disposeInstance,
        })).resolves.toBe(true);

        expect(disposeInstance).toHaveBeenCalledTimes(1);
        expect(fs.existsSync(created.path)).toBe(false);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining(created.path),
          'OpenCode API URL is not available'
        );
      } finally {
        warnSpy.mockRestore();
      }
    } finally {
      if (previousXdgDataHome === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = previousXdgDataHome;
      }
    }
  });

  it('never disposes the primary workspace', async () => {
    if (!canRunGit()) return;

    const previousXdgDataHome = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = createTempDir();

    try {
      const repo = createTempDir();
      runGit(repo, ['init', '-b', 'main']);
      runGit(repo, ['config', 'user.email', 'test@example.com']);
      runGit(repo, ['config', 'user.name', 'Test User']);
      runGit(repo, ['commit', '--allow-empty', '-m', 'init']);

      const disposeInstance = vi.fn();
      await expect(removeWorktree(repo, {
        directory: repo,
        disposeInstance,
      })).rejects.toThrow('Cannot remove the primary workspace');
      expect(disposeInstance).not.toHaveBeenCalled();
    } finally {
      if (previousXdgDataHome === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = previousXdgDataHome;
      }
    }
  });

  it('prunes the metadata a half-finished removal left behind', async () => {
    if (!canRunGit()) return;

    const repo = createTempDir();
    const worktree = path.join(createTempDir(), 'half-removed');
    runGit(repo, ['init', '-b', 'main']);
    runGit(repo, ['config', 'user.email', 'test@example.com']);
    runGit(repo, ['config', 'user.name', 'Test User']);
    runGit(repo, ['commit', '--allow-empty', '-m', 'Initial commit']);
    runGit(repo, ['worktree', 'add', '-b', 'half', worktree]);
    // What a Windows lock leaves: git deleted these files, then stopped.
    const metadata = path.join(repo, '.git', 'worktrees', 'half-removed');
    for (const name of ['gitdir', 'HEAD', 'index']) fs.rmSync(path.join(metadata, name), { force: true });

    await expect(removeWorktree(repo, { directory: worktree })).resolves.toBe(true);
    expect(fs.existsSync(metadata)).toBe(false);
  });

  const canRunGitAnnex = () => {
    try {
      execFileSync('git-annex', ['version'], { stdio: 'ignore', timeout: 10_000 });
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  };

  describe.skipIf(process.platform === 'win32' || !canRunGit() || !canRunGitAnnex())('git-annex integration', () => {
    const payload = 'git-annex worktree removal test payload\n';
    const annexGit = (cwd, args) => execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    });

    const allowFixtureCleanup = (directory) => {
      // Annex object directories are read-only. Only visit owned directories,
      // never targets of symlinks within the fixture.
      fs.chmodSync(directory, 0o700);
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) allowFixtureCleanup(path.join(directory, entry.name));
      }
    };

    const withAnnexWorktree = async (check) => {
      const root = fs.realpathSync(createTempDir());
      const repo = path.join(root, 'repository');
      const worktree = path.join(root, 'linked');
      const home = path.join(root, 'home');
      fs.mkdirSync(repo);
      fs.mkdirSync(home);

      try {
        for (const name of Object.keys(process.env)) {
          if (name.startsWith('GIT_')) vi.stubEnv(name, undefined);
        }
        vi.stubEnv('HOME', home);
        vi.stubEnv('XDG_CONFIG_HOME', path.join(home, 'config'));
        vi.stubEnv('XDG_DATA_HOME', path.join(home, 'data'));
        vi.stubEnv('XDG_CACHE_HOME', path.join(home, 'cache'));
        vi.stubEnv('GIT_CONFIG_GLOBAL', os.devNull);
        vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
        vi.stubEnv('GIT_TERMINAL_PROMPT', '0');
        // A nonempty path keeps these local operations from discovering GnuPG.
        vi.stubEnv('SSH_AUTH_SOCK', path.join(home, 'unused-agent.sock'));

        annexGit(repo, ['init', '-b', 'main']);
        annexGit(repo, ['config', 'user.email', 'test@example.com']);
        annexGit(repo, ['config', 'user.name', 'Test User']);
        annexGit(repo, ['annex', 'init', 'removal test primary']);
        fs.writeFileSync(path.join(repo, 'README.md'), '# Annex removal test\n');
        fs.writeFileSync(path.join(repo, 'payload.dat'), payload);
        annexGit(repo, ['add', 'README.md']);
        annexGit(repo, ['annex', 'add', 'payload.dat']);
        annexGit(repo, ['commit', '-m', 'annex fixture']);
        const branch = 'feature/annex-remove';
        annexGit(repo, ['worktree', 'add', '-b', branch, worktree]);
        annexGit(worktree, ['annex', 'init', 'removal test linked']);

        const gitEntry = path.join(worktree, '.git');
        expect(fs.lstatSync(gitEntry).isSymbolicLink()).toBe(true);
        expect(fs.statSync(gitEntry).isDirectory()).toBe(true);
        const linkTarget = fs.readlinkSync(gitEntry, { encoding: 'buffer' });
        const metadata = fs.realpathSync(gitEntry);
        const branchHead = annexGit(repo, ['rev-parse', branch]).trim();
        expect(fs.readFileSync(path.join(worktree, 'payload.dat'), 'utf8')).toBe(payload);
        expect(annexGit(repo, ['worktree', 'list', '--porcelain'])).toContain(worktree);

        await check({ repo, worktree, gitEntry, metadata, linkTarget, branch, branchHead });
      } finally {
        try {
          allowFixtureCleanup(root);
        } finally {
          vi.unstubAllEnvs();
        }
      }
    };

    it.each([false, true])('removes a worktree initialized by git-annex with deleteLocalBranch=%s', async (deleteLocalBranch) => {
      await withAnnexWorktree(async (fixture) => {
        const disposals = [];
        await expect(removeWorktree(fixture.repo, {
          directory: fixture.worktree,
          deleteLocalBranch,
          disposeInstance: async (directory) => {
            disposals.push({
              directory,
              linkTarget: fs.readlinkSync(fixture.gitEntry, { encoding: 'buffer' }),
            });
          },
        })).resolves.toBe(true);

        expect(disposals).toEqual([{ directory: fixture.worktree, linkTarget: fixture.linkTarget }]);
        expect(fs.existsSync(fixture.worktree)).toBe(false);
        expect(fs.existsSync(fixture.metadata)).toBe(false);
        expect(annexGit(fixture.repo, ['worktree', 'list', '--porcelain'])).not.toContain(fixture.worktree);
        if (deleteLocalBranch) {
          expect(() => annexGit(fixture.repo, ['show-ref', '--verify', `refs/heads/${fixture.branch}`])).toThrow();
        } else {
          expect(annexGit(fixture.repo, ['rev-parse', fixture.branch]).trim()).toBe(fixture.branchHead);
        }
        expect(fs.readFileSync(path.join(fixture.repo, 'payload.dat'), 'utf8')).toBe(payload);
        annexGit(fixture.repo, ['annex', 'fsck', 'payload.dat']);
      });
    }, 60_000);

    it('restores the git-annex symlink and preserves the branch and annex content after locked removal fails', async () => {
      await withAnnexWorktree(async (fixture) => {
        const entries = fs.readdirSync(fixture.worktree).sort();
        annexGit(fixture.repo, ['worktree', 'lock', fixture.worktree]);
        const metadataEntries = fs.readdirSync(fixture.metadata).sort();
        const gitdir = fs.readFileSync(path.join(fixture.metadata, 'gitdir'));
        const commondir = fs.readFileSync(path.join(fixture.metadata, 'commondir'));

        await expect(removeWorktree(fixture.repo, {
          directory: fixture.worktree,
          deleteLocalBranch: true,
        })).rejects.toThrow(/locked/);

        expect(fs.readdirSync(fixture.metadata).sort()).toEqual(metadataEntries);
        expect(fs.readFileSync(path.join(fixture.metadata, 'gitdir'))).toEqual(gitdir);
        expect(fs.readFileSync(path.join(fixture.metadata, 'commondir'))).toEqual(commondir);
        expect(fs.lstatSync(fixture.gitEntry).isSymbolicLink()).toBe(true);
        expect(fs.readlinkSync(fixture.gitEntry, { encoding: 'buffer' })).toEqual(fixture.linkTarget);
        expect(fs.statSync(fixture.metadata).isDirectory()).toBe(true);
        expect(annexGit(fixture.repo, ['rev-parse', fixture.branch]).trim()).toBe(fixture.branchHead);
        expect(annexGit(fixture.worktree, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe(fixture.branch);
        expect(fs.readdirSync(fixture.worktree).sort()).toEqual(entries);
        expect(fs.readFileSync(path.join(fixture.worktree, 'payload.dat'), 'utf8')).toBe(payload);
        annexGit(fixture.worktree, ['annex', 'fsck', 'payload.dat']);
      });
    }, 60_000);
  });
});

// ---------------------------------------------------------------------------
// snapshotWorktree
// ---------------------------------------------------------------------------

describe('snapshotWorktree', () => {
  const createSnapshotRepo = () => {
    const repo = createTempDir();
    runGit(repo, ['init', '-b', 'main']);
    runGit(repo, ['config', 'user.email', 'test@example.com']);
    runGit(repo, ['config', 'user.name', 'Test User']);
    fs.writeFileSync(path.join(repo, 'README.md'), '# Test\n');
    fs.writeFileSync(path.join(repo, '.gitignore'), 'secret.env\n');
    runGit(repo, ['add', 'README.md', '.gitignore']);
    runGit(repo, ['commit', '-m', 'Initial commit']);
    return repo;
  };

  it('captures staged, unstaged and untracked changes without touching the worktree', async () => {
    if (!canRunGit()) return;
    const repo = createSnapshotRepo();
    const head = runGit(repo, ['rev-parse', 'HEAD']).trim();
    fs.writeFileSync(path.join(repo, 'README.md'), '# Changed\n');
    fs.writeFileSync(path.join(repo, 'staged.txt'), 'staged\n');
    runGit(repo, ['add', 'staged.txt']);
    fs.writeFileSync(path.join(repo, 'new.txt'), 'untracked\n');
    fs.writeFileSync(path.join(repo, 'secret.env'), 'TOKEN=1\n');
    const statusBefore = runGit(repo, ['status', '--porcelain']);

    const ref = 'refs/openchamber/runs/group-1/ses_abc';
    const result = await snapshotWorktree(repo, { ref });

    expect(result).toMatchObject({ ref, head });
    expect(runGit(repo, ['rev-parse', ref]).trim()).toBe(result.commit);
    expect(runGit(repo, ['rev-parse', `${result.commit}^`]).trim()).toBe(head);
    const files = runGit(repo, ['ls-tree', '-r', '--name-only', result.commit]).trim().split('\n').sort();
    expect(files).toEqual(['.gitignore', 'README.md', 'new.txt', 'staged.txt']);
    expect(runGit(repo, ['show', `${result.commit}:README.md`])).toBe('# Changed\n');

    expect(runGit(repo, ['rev-parse', 'HEAD']).trim()).toBe(head);
    expect(runGit(repo, ['status', '--porcelain'])).toBe(statusBefore);
    expect(runGit(repo, ['branch', '--list']).trim()).toBe('* main');
  });

  it('rejects refs outside the private namespace', async () => {
    if (!canRunGit()) return;
    const repo = createSnapshotRepo();
    await expect(snapshotWorktree(repo, { ref: 'refs/heads/main' })).rejects.toThrow('Invalid snapshot ref');
    await expect(snapshotWorktree(repo, { ref: 'refs/openchamber/runs/../heads' })).rejects.toThrow('Invalid snapshot ref');
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
// pull
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
// continueRebase / continueMerge
// ---------------------------------------------------------------------------

describe.runIf(canRunGit())('continuing a conflicted rebase or merge', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** `feature` and `main` both change file.txt; `main` is checked out. */
  async function createConflictingBranches() {
    const { tmpDir, git } = await createTempRepo();
    const filePath = path.join(tmpDir, 'file.txt');
    await fs.promises.writeFile(filePath, 'base\n', 'utf8');
    await git.add('file.txt');
    await git.commit('Initial commit');

    await git.checkoutBranch('feature', 'HEAD');
    await fs.promises.writeFile(filePath, 'feature\n', 'utf8');
    await git.add('file.txt');
    await git.commit('Change file in feature');

    await git.checkout('main');
    await fs.promises.writeFile(filePath, 'main\n', 'utf8');
    await git.add('file.txt');
    await git.commit('Change file in main');

    // An editor that fails and inherited variables simple-git refuses in an
    // explicit env. Continuing must neither open an editor nor trip that check.
    vi.stubEnv('GIT_EDITOR', 'false');
    vi.stubEnv('PAGER', 'less');
    vi.stubEnv('GIT_ASKPASS', 'false');

    return { tmpDir, git, filePath };
  }

  it('finishes a rebase after the conflict is resolved', async () => {
    const { tmpDir, git, filePath } = await createConflictingBranches();
    await git.checkout('feature');
    expect(await rebase(tmpDir, { onto: 'main' })).toMatchObject({ success: false, conflict: true });

    await fs.promises.writeFile(filePath, 'resolved\n', 'utf8');
    await git.add('file.txt');

    expect(await continueRebase(tmpDir)).toEqual({ success: true, conflict: false });
    const status = await getStatus(tmpDir);
    expect(status.rebaseInProgress).toBeFalsy();
    expect(status.current).toBe('feature');
    expect((await git.log()).latest?.message).toBe('Change file in feature');
  });

  it('reports files that are still conflicted when continuing a rebase', async () => {
    const { tmpDir, git } = await createConflictingBranches();
    await git.checkout('feature');
    await rebase(tmpDir, { onto: 'main' });

    expect(await continueRebase(tmpDir)).toEqual({ success: false, conflict: true, conflictFiles: ['file.txt'] });
  });

  it('reports a conflict in the next commit after skipping an emptied one', async () => {
    const { tmpDir, git, filePath } = await createConflictingBranches();
    // The apply backend stops with "No changes" instead of dropping the commit.
    await git.addConfig('rebase.backend', 'apply');
    await git.checkout('feature');
    await fs.promises.writeFile(filePath, 'feature again\n', 'utf8');
    await git.add('file.txt');
    await git.commit('Change file in feature again');
    await rebase(tmpDir, { onto: 'main' });

    // Resolving to main's content leaves nothing to commit, so the first
    // commit is skipped and applying the second one conflicts.
    await fs.promises.writeFile(filePath, 'main\n', 'utf8');
    await git.add('file.txt');

    expect(await continueRebase(tmpDir)).toEqual({ success: false, conflict: true, conflictFiles: ['file.txt'] });
    expect((await getStatus(tmpDir)).rebaseInProgress).toBeTruthy();
  });

  it('finishes a merge after the conflict is resolved', async () => {
    const { tmpDir, git, filePath } = await createConflictingBranches();
    expect(await merge(tmpDir, { branch: 'feature' })).toMatchObject({ success: false, conflict: true });

    await fs.promises.writeFile(filePath, 'resolved\n', 'utf8');
    await git.add('file.txt');

    expect(await continueMerge(tmpDir)).toEqual({ success: true, conflict: false });
    const status = await getStatus(tmpDir);
    expect(status.mergeInProgress).toBeFalsy();
    expect((await git.log()).latest?.message).toBe("Merge branch 'feature'");
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

  it('does not infer a default branch when no local remote/HEAD exists', async () => {
    const { repository } = createRepositoryWithRemote({ remoteName: 'origin', defaultBranch: 'react' });
    runGit(repository, ['remote', 'set-head', 'origin', '--delete']);

    await expect(getBranches(repository)).resolves.toMatchObject({
      defaultBranches: {},
    });
  });

  it('keeps the branches of a remote that cannot be reached', async () => {
    const { repository, remote } = createRepositoryWithRemote({ remoteName: 'origin', defaultBranch: 'react' });
    fs.rmSync(remote, { recursive: true, force: true });

    const branches = await getBranches(repository);

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

describe.runIf(canRunGit())('commit comparisons', () => {
  it('shows only the selected commit and gives walkthrough the identical patch', async () => {
    const { repository } = createRepositoryWithRemote();
    fs.writeFileSync(path.join(repository, 'README.md'), 'selected version\n');
    runGit(repository, ['add', '.']);
    runGit(repository, ['commit', '-m', 'selected']);
    const hash = runGit(repository, ['rev-parse', 'HEAD']).trim();
    fs.writeFileSync(path.join(repository, 'README.md'), 'later version\n');
    runGit(repository, ['add', '.']);
    runGit(repository, ['commit', '-m', 'later']);
    fs.writeFileSync(path.join(repository, 'README.md'), 'uncommitted version\n');
    const patch = await getCommitDiff(repository, { hash, path: 'README.md' });
    expect(patch).toContain('+selected version');
    expect(patch).not.toContain('later version');
    expect(patch).not.toContain('uncommitted version');
    expect((await getCommitFiles(repository, hash)).files).toEqual([
      { path: 'README.md', insertions: 1, deletions: 1, isBinary: false, changeType: 'M' },
    ]);
    const source = parseSource({ kind: 'commit', hash });
    expect(sourceKey(source)).toBe(`commit:${hash}`);
    expect((await loadSourceSections(repository, source)).sections).toEqual([{ scope: 'commit', patch }]);
    const routes = new Map();
    registerGitRoutes({
      get: (url, handler) => routes.set(url, handler), post() {}, put() {}, delete() {},
    });
    let response;
    await routes.get('/api/git/commit-diff')(
      { query: { directory: repository, hash, path: 'README.md' } },
      { json: (body) => { response = body; }, status: (code) => { throw new Error(`Unexpected status ${code}`); } },
    );
    expect(response).toEqual({ diff: patch });
  });

  it('handles root and empty commits and rejects invalid hashes', async () => {
    const { repository } = createRepositoryWithRemote();
    const root = runGit(repository, ['rev-parse', 'HEAD']).trim();
    expect(await getCommitDiff(repository, { hash: root })).toContain('+# Test');
    expect((await getCommitFiles(repository, root)).files[0].changeType).toBe('A');
    runGit(repository, ['commit', '--allow-empty', '-m', 'empty']);
    const empty = runGit(repository, ['rev-parse', 'HEAD']).trim();
    expect(await getCommitDiff(repository, { hash: empty })).toBe('');
    expect(await getCommitFiles(repository, empty)).toEqual({ files: [] });
    expect(() => parseSource({ kind: 'commit', hash: 'HEAD' })).toThrow();
    expect(() => parseSource({ kind: 'commit', hash: [root] })).toThrow();
    await expect(getCommitDiff(repository, { hash: 'HEAD' })).rejects.toThrow();
    await expect(getCommitFiles(repository, '0'.repeat(40))).rejects.toThrow();
  });

  it('keeps rename paths and original contents together, including whitespace in names', async () => {
    const { repository } = createRepositoryWithRemote();
    const destination = ' new\nname.md';
    runGit(repository, ['mv', 'README.md', destination]);
    runGit(repository, ['commit', '-m', 'rename']);
    const hash = runGit(repository, ['rev-parse', 'HEAD']).trim();
    const { files } = await getCommitFiles(repository, hash);
    expect(files).toEqual([{ path: destination, previousPath: 'README.md', changeType: 'R', insertions: 0, deletions: 0, isBinary: false }]);
    const patch = await getCommitDiff(repository, { hash, path: destination, previousPath: files[0].previousPath });
    expect(patch).toContain('rename from README.md');
    expect(patch).toContain('similarity index 100%');
  });

  it('compares a merge commit against its first parent', async () => {
    const { repository } = createRepositoryWithRemote();
    runGit(repository, ['checkout', '-b', 'side']);
    fs.writeFileSync(path.join(repository, 'side.txt'), 'side\n');
    runGit(repository, ['add', '.']);
    runGit(repository, ['commit', '-m', 'side']);
    runGit(repository, ['checkout', 'next']);
    fs.writeFileSync(path.join(repository, 'main.txt'), 'main\n');
    runGit(repository, ['add', '.']);
    runGit(repository, ['commit', '-m', 'main']);
    runGit(repository, ['merge', '--no-ff', 'side', '-m', 'merge']);
    const hash = runGit(repository, ['rev-parse', 'HEAD']).trim();
    expect((await getCommitFiles(repository, hash)).files.map((file) => file.path)).toEqual(['side.txt']);
    const patch = await getCommitDiff(repository, { hash });
    expect(patch).toContain('+side');
    expect(patch).not.toContain('main.txt');
  });

  it('limits current-branch history to 50 commits without including another branch', async () => {
    const { repository } = createRepositoryWithRemote();
    runGit(repository, ['checkout', '-b', 'other']);
    runGit(repository, ['commit', '--allow-empty', '-m', 'other branch only']);
    runGit(repository, ['checkout', 'next']);
    for (let index = 0; index < 51; index += 1) runGit(repository, ['commit', '--allow-empty', '-m', `current ${index}`]);
    const history = await getLog(repository, { maxCount: 50, to: 'refs/heads/next' });
    expect(history.all).toHaveLength(50);
    expect(history.all[0].message).toBe('current 50');
    expect(history.all.some((commit) => commit.message === 'other branch only')).toBe(false);
  });
});

describe.runIf(canRunGit())('Git revision arguments', () => {
  it.each([undefined, 'glob'])('preserves revision syntax with inherited MSYS=%j', async (msys) => {
    const { repository } = createRepositoryWithRemote();
    runGit(repository, ['branch', '--set-upstream-to=origin/react', 'next']);
    fs.writeFileSync(path.join(repository, 'feature.txt'), 'feature\n');
    runGit(repository, ['add', 'feature.txt']);
    runGit(repository, ['commit', '-m', 'feature']);

    const previousMsys = process.env.MSYS;
    if (msys === undefined) delete process.env.MSYS;
    else process.env.MSYS = msys;
    try {
      expect(await getRangeDiff(repository, { base: 'origin/react', head: 'next@{0}' })).toContain('+feature');
      expect(await getUnpushedBranchCounts(repository, ['next'])).toEqual({ counts: { next: 1 } });
      expect(process.env.MSYS).toBe(msys);
    } finally {
      if (previousMsys === undefined) delete process.env.MSYS;
      else process.env.MSYS = previousMsys;
    }
  });
});

describe.runIf(canRunGit())('getRangeDiff', () => {
  it('loads a committed deletion that no longer exists in HEAD or the working tree', async () => {
    const { repository } = createRepositoryWithRemote();
    runGit(repository, ['rm', 'README.md']);
    runGit(repository, ['commit', '-m', 'delete file']);
    const diff = await getRangeDiff(repository, { base: 'origin/react', head: 'next', path: 'README.md', includeWorkingTree: true });
    expect(diff).toContain('deleted file mode');
    expect(diff).toContain('-# Test');
  });

  it('carries the working-tree option through the actual HTTP route handlers', async () => {
    const { repository } = createRepositoryWithRemote();
    fs.writeFileSync(path.join(repository, 'local.txt'), 'current local work\n');
    const routes = new Map();
    registerGitRoutes({
      get: (url, handler) => routes.set(url, handler),
      post() {},
      put() {},
      delete() {},
    });
    const query = { directory: repository, base: 'origin/react', head: 'next', includeWorkingTree: 'true' };
    for (const endpoint of ['range-diff', 'range-files']) {
      let status = 200;
      let body;
      const response = {
        status(value) { status = value; return this; },
        json(value) { body = value; },
      };
      await routes.get(`/api/git/${endpoint}`)({ query }, response);
      expect(status).toBe(200);
      if (endpoint === 'range-diff') expect(body.diff).toContain('+current local work');
      else expect(body.files).toEqual([{ path: 'local.txt', status: 'A' }]);
    }
  });

  it('does not treat a branch checked out from its own remote copy as its base', async () => {
    const { repository } = createRepositoryWithRemote();
    runGit(repository, ['checkout', '-b', 'react', '--track', 'origin/react']);
    expect(await getBranchBase(repository, 'react')).toEqual({ base: null });
    runGit(repository, ['checkout', '--no-track', '-b', 'loose', 'origin/react']);
    expect(await getBranchBase(repository, 'loose')).toEqual({ base: 'origin/react' });
  });

  it('asks for a new base after restacking and compares against the selected parent', async () => {
    const { repository } = createRepositoryWithRemote();
    runGit(repository, ['checkout', '-b', 'child', 'origin/react']);
    fs.writeFileSync(path.join(repository, 'child.txt'), 'child\n');
    runGit(repository, ['add', '.']);
    runGit(repository, ['commit', '-m', 'child']);
    expect(await getBranchBase(repository, 'child')).toEqual({ base: 'origin/react' });
    runGit(repository, ['checkout', '-b', 'parent', 'origin/react']);
    fs.writeFileSync(path.join(repository, 'parent.txt'), 'parent\n');
    runGit(repository, ['add', '.']);
    runGit(repository, ['commit', '-m', 'parent']);
    runGit(repository, ['checkout', 'child']);
    runGit(repository, ['rebase', 'parent']);
    expect(await getBranchBase(repository, 'child')).toEqual({ base: null });
    fs.writeFileSync(path.join(repository, 'child.txt'), 'current child\n');
    const options = { base: 'refs/heads/parent', head: 'child', includeWorkingTree: true };
    expect(await getRangeFiles(repository, options)).toEqual([{ path: 'child.txt', status: 'A' }]);
    const diff = await getRangeDiff(repository, options);
    expect(diff).toContain('+current child');
    expect(diff).not.toContain('parent.txt');
  });

  it('combines committed, staged, unstaged and untracked work without changing the real index', async () => {
    const { repository } = createRepositoryWithRemote();
    fs.writeFileSync(path.join(repository, 'README.md'), '# Committed\n');
    runGit(repository, ['add', 'README.md']);
    runGit(repository, ['commit', '-m', 'branch change']);
    fs.writeFileSync(path.join(repository, 'README.md'), '# Staged\n');
    fs.writeFileSync(path.join(repository, 'staged.txt'), 'staged only\n');
    runGit(repository, ['add', '.']);
    fs.writeFileSync(path.join(repository, 'README.md'), '# Current\n');
    fs.writeFileSync(path.join(repository, 'untracked.txt'), 'new local file\n');
    fs.writeFileSync(path.join(repository, ' leading space.txt'), 'space path\n');
    const indexBefore = fs.readFileSync(path.join(repository, '.git/index'));
    const options = { base: 'origin/react', head: 'next', includeWorkingTree: true };

    const diff = await getRangeDiff(repository, options);
    expect(diff).toContain('-# Test');
    expect(diff).toContain('+# Current');
    expect(diff).not.toContain('+# Staged');
    expect(diff).not.toContain('+# Committed');
    expect(diff).toContain('+new local file');
    expect(diff).toContain('+staged only');
    expect(await getRangeFiles(repository, options)).toEqual(expect.arrayContaining([
      { path: 'README.md', status: 'M' },
      { path: 'staged.txt', status: 'A' },
      { path: 'untracked.txt', status: 'A' },
      { path: ' leading space.txt', status: 'A' },
    ]));
    const { sections } = await loadSourceSections(repository, { kind: 'branch', baseRef: options.base, headRef: options.head });
    expect(sections).toEqual([{ scope: 'branch', patch: diff }]);
    expect(fs.readFileSync(path.join(repository, '.git/index'))).toEqual(indexBefore);

    const committed = await getRangeDiff(repository, { base: options.base, head: options.head });
    expect(committed).toContain('+# Committed');
    expect(committed).not.toContain('+new local file');
    fs.writeFileSync(path.join(repository, 'README.md'), '# Latest\n');
    expect(await getRangeDiff(repository, { ...options, path: 'README.md' })).toContain('+# Latest');
  });

  it('reports the final file after a staged deletion is recreated, and omits undone branch changes', async () => {
    const { repository } = createRepositoryWithRemote();
    runGit(repository, ['rm', 'README.md']);
    fs.writeFileSync(path.join(repository, 'README.md'), '# Recreated\n');
    const options = { base: 'origin/react', head: 'next', includeWorkingTree: true };
    expect(await getRangeFiles(repository, options)).toEqual([{ path: 'README.md', status: 'M' }]);
    const diff = await getRangeDiff(repository, options);
    expect(diff).toContain('-# Test');
    expect(diff).toContain('+# Recreated');
    expect(diff.match(/diff --git/g)).toHaveLength(1);
    fs.writeFileSync(path.join(repository, 'README.md'), '# Test\n');
    expect(await getRangeFiles(repository, options)).toEqual([]);
    expect(await getRangeDiff(repository, options)).toBe('');
  });

  it('keeps local and remote bases distinct and rejects a different checked-out branch', async () => {
    const { repository } = createRepositoryWithRemote();
    runGit(repository, ['branch', 'react']);
    fs.writeFileSync(path.join(repository, 'parent.txt'), 'parent work\n');
    runGit(repository, ['add', '.']);
    runGit(repository, ['commit', '-m', 'parent work']);
    runGit(repository, ['branch', '-f', 'react', 'HEAD']);
    fs.writeFileSync(path.join(repository, 'child.txt'), 'child work\n');
    const options = { head: 'next', includeWorkingTree: true };
    const local = await getRangeDiff(repository, { ...options, base: 'react' });
    const remote = await getRangeDiff(repository, { ...options, base: 'origin/react' });
    expect(local).not.toContain('parent.txt');
    expect(remote).toContain('parent.txt');
    expect(local).toContain('child.txt');
    expect(await getRangeFiles(repository, { ...options, base: 'react' })).toEqual([{ path: 'child.txt', status: 'A' }]);
    runGit(repository, ['checkout', 'react']);
    await expect(getRangeDiff(repository, { ...options, base: 'origin/react' })).rejects.toThrow(/checked-out branch/);
  });

  it('includes untracked symlinks as links without reading their targets', async () => {
    const { repository } = createRepositoryWithRemote();
    const outside = path.join(createTempDir(), 'outside.txt');
    fs.writeFileSync(outside, 'must not be in a diff\n');
    fs.symlinkSync(outside, path.join(repository, 'link.txt'));
    const diff = await getRangeDiff(repository, { base: 'origin/react', head: 'next', includeWorkingTree: true });
    expect(diff).toContain('new file mode 120000');
    expect(diff).toContain(outside);
    expect(diff).not.toContain('must not be in a diff');
  });

  it('uses an explicitly selected base on a remote other than origin', async () => {
    const { repository } = createRepositoryWithRemote({ remoteName: 'upstream', defaultBranch: 'react' });
    // The selected remote ref must work without a local branch of that name.
    fs.writeFileSync(path.join(repository, 'feature.txt'), 'work\n');
    runGit(repository, ['add', 'feature.txt']);
    runGit(repository, ['commit', '-m', 'feature']);

    const diff = await getRangeDiff(repository, { base: 'upstream/react', head: 'next' });

    expect(diff).toContain('feature.txt');
    await expect(getRangeDiff(repository, { base: 'react', head: 'next' })).rejects.toThrow(/is not available locally/);
  });

  it('names an unfetched remote-only ref instead of failing with git\'s ambiguous argument (#2735)', async () => {
    const { repository } = createRepositoryWithRemote({ defaultBranch: 'react' });

    await expect(
      getRangeDiff(repository, { base: 'remotes/origin/never-fetched', head: 'next' })
    ).rejects.toThrow(/is not available locally/);
  });
});

describe('parseBranchCreationSource', () => {
  it('does not reuse the creation base after a rebase', () => {
    expect(parseBranchCreationSource('rebase (finish): refs/heads/feature onto abc123\nbranch: Created from main')).toBeNull();
  });
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

    const files = await getRangeFiles(repository, { base: 'origin/react', head: 'next' });

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

    const files = await getRangeFiles(repository, { base: 'origin/react', head: 'next' });

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

    const files = await getRangeFiles(repository, { base: 'origin/react', head: 'next' });

    const copyEntry = files.find((file) => file.status === 'C');
    expect(copyEntry).toBeDefined();
    expect(copyEntry.path).toBe('copied destination.md');
  });
});

// ---------------------------------------------------------------------------
// getTrackingBranch
// ---------------------------------------------------------------------------

describe('getTrackingBranch', () => {
  const createCommittedRepo = () => {
    const repo = createTempDir();
    runGit(repo, ['init', '-b', 'main']);
    runGit(repo, ['config', 'user.email', 'test@example.com']);
    runGit(repo, ['config', 'user.name', 'Test User']);
    runGit(repo, ['commit', '--allow-empty', '-m', 'Initial commit']);
    return repo;
  };

  it('reports the same upstream name as status, including a gone upstream', async () => {
    if (!canRunGit()) return;

    const repo = createCommittedRepo();
    await expect(getTrackingBranch(repo)).resolves.toBeNull();

    runGit(repo, ['remote', 'add', 'origin', 'https://example.invalid/repo.git']);
    runGit(repo, ['config', 'branch.main.remote', 'origin']);
    runGit(repo, ['config', 'branch.main.merge', 'refs/heads/main']);
    await expect(getTrackingBranch(repo)).resolves.toBe('origin/main');
    expect((await getStatus(repo)).tracking).toBe('origin/main');

    runGit(repo, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    await expect(getTrackingBranch(repo)).resolves.toBe('origin/main');
  });

  it('is null for a detached HEAD and outside a repository', async () => {
    if (!canRunGit()) return;

    const repo = createCommittedRepo();
    runGit(repo, ['checkout', '--detach']);
    await expect(getTrackingBranch(repo)).resolves.toBeNull();
    await expect(getTrackingBranch(createTempDir())).resolves.toBeNull();
  });
});

describe('getStatus concurrency', () => {
  it('answers overlapping reads of one repository and reflects changes made while a read ran', async () => {
    if (!canRunGit()) return;

    const repo = createTempDir();
    runGit(repo, ['init', '-b', 'main']);
    runGit(repo, ['config', 'user.email', 'test@example.com']);
    runGit(repo, ['config', 'user.name', 'Test User']);
    runGit(repo, ['commit', '--allow-empty', '-m', 'Initial commit']);

    const first = getStatus(repo);
    fs.writeFileSync(path.join(repo, 'late.txt'), 'added after the first read was admitted\n');
    const second = getStatus(repo, { mode: 'light' });
    const third = getStatus(repo);

    const [firstStatus, secondStatus, thirdStatus] = await Promise.all([first, second, third]);
    expect(firstStatus.current).toBe('main');
    expect(secondStatus.files.map((file) => file.path)).toContain('late.txt');
    expect(thirdStatus.files.map((file) => file.path)).toContain('late.txt');
    // The follow-up run served both later callers at the widest requested mode.
    expect(secondStatus.diffStats).toBeDefined();
    expect(thirdStatus.diffStats).toBeDefined();
  });
});

describe('getStatus untracked directories', () => {
  const callDiffRoute = async (endpoint, query) => {
    const routes = new Map();
    registerGitRoutes({ get: (url, handler) => routes.set(url, handler), post() {}, put() {}, delete() {} });
    let status = 200;
    let body;
    await routes.get(`/api/git/${endpoint}`)({ query }, {
      status(value) { status = value; return this; },
      json(value) { body = value; },
    });
    return { status, body };
  };

  const createCommittedRepo = () => {
    const repo = createTempDir();
    runGit(repo, ['init', '-b', 'main']);
    runGit(repo, ['config', 'user.email', 'test@example.com']);
    runGit(repo, ['config', 'user.name', 'Test User']);
    fs.writeFileSync(path.join(repo, 'README.md'), '# Test\n');
    runGit(repo, ['add', 'README.md']);
    runGit(repo, ['commit', '-m', 'Initial commit']);
    return repo;
  };

  const writeFiles = (root, count) => {
    fs.mkdirSync(root, { recursive: true });
    for (let index = 0; index < count; index += 1) {
      fs.writeFileSync(path.join(root, `file-${String(index).padStart(5, '0')}.txt`), `${index}\n`);
    }
  };

  it('lists the files of an ordinary new directory one by one', async () => {
    if (!canRunGit()) return;

    const repo = createCommittedRepo();
    writeFiles(path.join(repo, 'feature', 'deep'), 3);
    fs.writeFileSync(path.join(repo, 'loose.txt'), 'loose\n');

    const paths = (await getStatus(repo)).files.map((file) => file.path);
    expect(paths).toEqual([
      'feature/deep/file-00000.txt',
      'feature/deep/file-00001.txt',
      'feature/deep/file-00002.txt',
      'loose.txt',
    ]);
  });

  it('keeps a directory with more than a thousand new files as one entry the diff routes explain', async () => {
    if (!canRunGit()) return;

    const repo = createCommittedRepo();
    writeFiles(path.join(repo, 'node_modules', 'pkg'), 1001);
    writeFiles(path.join(repo, 'small'), 2);

    const status = await getStatus(repo);
    expect(status.files.map((file) => file.path)).toEqual([
      'node_modules/',
      'small/file-00000.txt',
      'small/file-00001.txt',
    ]);
    expect(status.files[0]).toMatchObject({ index: '?', working_dir: '?' });

    for (const endpoint of ['diff', 'file-diff']) {
      const { status: httpStatus, body } = await callDiffRoute(endpoint, { directory: repo, path: 'node_modules/' });
      expect(httpStatus).toBe(422);
      expect(body).toEqual({ code: 'untracked_directory', error: 'Path is a directory of untracked files: node_modules/' });
    }
  });
});

describe('git environment through simple-git', () => {
  const withProcessEnv = async (overrides, run) => {
    const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try {
      return await run();
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  };

  /** A repository whose pre-commit hook writes the named variables to a log. */
  const createRepositoryLoggingHookEnv = (names) => {
    const repo = createTempDir();
    runGit(repo, ['init', '-b', 'main']);
    runGit(repo, ['config', 'user.email', 'test@example.com']);
    runGit(repo, ['config', 'user.name', 'Test User']);
    const hookLog = path.join(createTempDir(), 'pre-commit-env.log');
    const hookPath = path.join(repo, '.git', 'hooks', 'pre-commit');
    const fields = names.map((name) => `\${${name}-<unset>}`).join('|');
    fs.writeFileSync(hookPath, `#!/bin/sh\nprintf '%s' "${fields}" > ${JSON.stringify(hookLog)}\n`);
    fs.chmodSync(hookPath, 0o755);
    fs.writeFileSync(path.join(repo, 'README.md'), '# Test\n');
    return { repo, readHookLog: () => fs.readFileSync(hookLog, 'utf8') };
  };

  it('runs git with the environment OpenChamber builds, not the raw process env', async () => {
    if (!canRunGit() || process.platform === 'win32') return;
    await withProcessEnv({
      GIT_TERMINAL_PROMPT: undefined,
      APPDIR: '/tmp/.mount_OpenChAbC123',
      LD_LIBRARY_PATH: '/tmp/.mount_OpenChAbC123/usr/lib:/opt/x:',
    }, async () => {
      const { repo, readHookLog } = createRepositoryLoggingHookEnv(['GIT_TERMINAL_PROMPT', 'LD_LIBRARY_PATH']);
      await commit(repo, 'init', { addAll: true });
      expect(readHookLog()).toBe('0|/opt/x');
    });
  });

  it('keeps working, and passes them to git, when the process env sets editor, pager, ssh or askpass programs', async () => {
    if (!canRunGit() || process.platform === 'win32') return;
    const programs = {
      EDITOR: 'vim',
      GIT_EDITOR: 'vim',
      PAGER: 'less',
      GIT_PAGER: 'less',
      GIT_SSH_COMMAND: 'ssh -i /tmp/openchamber-test-key -o IdentitiesOnly=yes',
      GIT_ASKPASS: '/usr/bin/true',
      SSH_ASKPASS: '/usr/bin/true',
    };
    // Git itself hands hooks GIT_EDITOR=: when a commit message needs no editor.
    const observed = Object.keys(programs).filter((name) => name !== 'GIT_EDITOR');
    await withProcessEnv(programs, async () => {
      const { repo, readHookLog } = createRepositoryLoggingHookEnv(observed);
      await commit(repo, 'init', { addAll: true });
      expect(readHookLog()).toBe(observed.map((name) => programs[name]).join('|'));
      const status = await getStatus(repo);
      expect(status.current).toBe('main');
    });
  });
});

describe('git environment inside an AppImage', () => {
  // Worktree population never runs hooks (an untrusted checkout must not run
  // code), so a branch switch is where a post-checkout hook runs.
  it('runs a post-checkout hook without the AppImage launcher library path', async () => {
    if (!canRunGit() || process.platform === 'win32') return;
    const previous = {
      APPDIR: process.env.APPDIR,
      LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH,
    };
    process.env.APPDIR = '/tmp/.mount_OpenChAbC123';
    process.env.LD_LIBRARY_PATH = '/tmp/.mount_OpenChAbC123/usr/lib:/opt/x:';

    try {
      const repo = createTempDir();
      runGit(repo, ['init', '-b', 'main']);
      runGit(repo, ['config', 'user.email', 'test@example.com']);
      runGit(repo, ['config', 'user.name', 'Test User']);
      fs.writeFileSync(path.join(repo, 'README.md'), '# Test\n');
      runGit(repo, ['add', 'README.md']);
      runGit(repo, ['commit', '-m', 'Initial commit']);
      runGit(repo, ['branch', 'other']);
      const hookLog = path.join(createTempDir(), 'post-checkout-env.log');
      const hookPath = path.join(repo, '.git', 'hooks', 'post-checkout');
      fs.writeFileSync(hookPath, `#!/bin/sh\nprintf '%s' "\${LD_LIBRARY_PATH-<unset>}" > ${JSON.stringify(hookLog)}\n`);
      fs.chmodSync(hookPath, 0o755);

      await checkoutBranch(repo, 'other');

      expect(fs.readFileSync(hookLog, 'utf8')).toBe('/opt/x');
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
