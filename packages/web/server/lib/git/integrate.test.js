import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  abortIntegrate,
  computeIntegratePlan,
  continueIntegrate,
  getWorktrees,
  listIntegrateConflicts,
  integrateWorktreeCommits,
  isIntegrateInProgress,
} from './service.js';

let root;
let repo;
let source;

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (cwd, file, text) => fs.writeFileSync(path.join(cwd, file), text);
const read = (cwd, file) => fs.readFileSync(path.join(cwd, file), 'utf8');
let authorSeconds = 1_700_000_000;
const commitFile = (cwd, file, text) => {
  write(cwd, file, text);
  git(cwd, 'add', '-f', file);
  // Commits made within one second would count as the same author time.
  authorSeconds += 1;
  git(cwd, 'commit', '-qm', `change ${file}`, '--date', `${authorSeconds} +0000`);
  return git(cwd, 'rev-parse', 'HEAD');
};
const tipOf = (branch) => git(repo, 'rev-parse', `refs/heads/${branch}`);
const statusOf = (cwd) => git(cwd, 'status', '--porcelain');
const worktreeCount = () => git(repo, 'worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree ')).length;
const integrate = async (targetBranch = 'main') =>
  integrateWorktreeCommits(await computeIntegratePlan({ repoRoot: repo, sourceBranch: 'task', targetBranch }));
const integrateIntoConflict = async (targetBranch = 'main') => {
  const result = await integrate(targetBranch);
  expect(result.kind).toBe('conflict');
  return result.state;
};

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-integrate-')));
  vi.stubEnv('HOME', root);
  vi.stubEnv('USERPROFILE', root);
  vi.stubEnv('GIT_CONFIG_GLOBAL', path.join(root, 'gitconfig'));
  write(root, 'gitconfig', '[user]\n\tname = Test\n\temail = test@example.com\n[commit]\n\tgpgsign = false\n[core]\n\tautocrlf = false\n');
  repo = path.join(root, 'repo');
  source = path.join(root, 'task');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  commitFile(repo, 'shared.txt', 'base\n');
  commitFile(repo, 'other.txt', 'base\n');
  git(repo, 'worktree', 'add', '-q', '-b', 'task', source);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('integrating into a branch another checkout holds', () => {
  it('moves the branch together with the checkout that holds it', async () => {
    commitFile(source, 'shared.txt', 'task\n');

    await expect(integrate()).resolves.toEqual({ kind: 'success', moved: 1 });

    expect(read(repo, 'shared.txt')).toBe('task\n');
    expect(statusOf(repo)).toBe('');
    expect(worktreeCount()).toBe(2);
  });

  it('keeps local work the new commits do not touch', async () => {
    commitFile(source, 'shared.txt', 'task\n');
    write(repo, 'other.txt', 'mine\n');
    write(repo, 'notes.txt', 'mine\n');

    await integrate();

    expect(read(repo, 'shared.txt')).toBe('task\n');
    expect(statusOf(repo).split('\n').map((line) => line.trim())).toEqual(['M other.txt', '?? notes.txt']);
  });

  it.each([
    ['an uncommitted edit', () => write(repo, 'shared.txt', 'mine\n')],
    ['a staged edit', () => { write(repo, 'shared.txt', 'mine\n'); git(repo, 'add', 'shared.txt'); }],
    ['an untracked file', () => write(repo, 'shared.txt', 'base\n'), 'fresh.txt'],
    ['an ignored file', () => write(repo, '.git/info/exclude', 'fresh.txt\n'), 'fresh.txt'],
    ['merge.autoStash on', () => { git(repo, 'config', 'merge.autoStash', 'true'); git(repo, 'config', 'branch.main.mergeOptions', '--autostash'); write(repo, 'shared.txt', 'mine\n'); }],
  ])('refuses without touching anything: %s', async (_name, prepare, file = 'shared.txt') => {
    commitFile(source, file, 'task\n');
    prepare();
    if (file === 'fresh.txt') write(repo, file, 'mine\n');
    const before = [tipOf('main'), statusOf(repo)];

    await expect(integrate()).rejects.toThrow(new RegExp(`main.*${path.basename(repo)}[^]*${file}`));

    expect([tipOf('main'), statusOf(repo)]).toEqual(before);
    expect(read(repo, file)).toBe('mine\n');
    expect(worktreeCount()).toBe(2);
  });

  it('says so when the branch is locked halfway, and finishes on the next run', async () => {
    commitFile(source, 'shared.txt', 'task\n');
    const lock = path.join(repo, '.git', 'refs', 'heads', 'main.lock');
    fs.writeFileSync(lock, '');
    await expect(integrate()).rejects.toThrow(/stopped partway/);

    fs.rmSync(lock);
    await integrate();
    expect([read(repo, 'shared.txt'), statusOf(repo)]).toEqual(['task\n', '']);
  });

  it('refuses a branch two checkouts hold', async () => {
    const second = path.join(root, 'second');
    git(repo, 'worktree', 'add', '-q', '--force', second, 'main');
    commitFile(source, 'shared.txt', 'task\n');
    const before = tipOf('main');

    await expect(integrate()).rejects.toThrow(/more than one checkout/);

    expect(tipOf('main')).toBe(before);
    expect([statusOf(repo), statusOf(second)]).toEqual(['', '']);
  });

  it('refuses an alias of a branch', async () => {
    git(repo, 'symbolic-ref', 'refs/heads/alias', 'refs/heads/main');
    commitFile(source, 'shared.txt', 'task\n');
    const before = tipOf('main');

    await expect(integrate('alias')).rejects.toThrow(/alias of main/);

    expect([tipOf('main'), statusOf(repo)]).toEqual([before, '']);
  });

  it('refuses a branch a checkout is rebasing', async () => {
    const next = path.join(root, 'next');
    git(repo, 'worktree', 'add', '-q', '-b', 'next', next);
    commitFile(next, 'other.txt', 'next\n');
    commitFile(repo, 'other.txt', 'main\n');
    expect(() => git(next, 'rebase', 'main')).toThrow();
    commitFile(source, 'shared.txt', 'task\n');
    const before = tipOf('next');

    await expect(integrate('next')).rejects.toThrow(/next/);

    expect(tipOf('next')).toBe(before);
  });

  it('fast-forwards to the upstream first', async () => {
    git(repo, 'branch', '-q', 'upstream');
    const upstream = path.join(root, 'upstream');
    git(repo, 'worktree', 'add', '-q', upstream, 'upstream');
    const upstreamTip = commitFile(upstream, 'other.txt', 'upstream\n');
    git(repo, 'branch', '-q', '--set-upstream-to=upstream', 'main');
    commitFile(source, 'shared.txt', 'task\n');

    await integrate();

    expect(git(repo, 'rev-parse', 'main~1')).toBe(upstreamTip);
    expect([read(repo, 'other.txt'), read(repo, 'shared.txt'), statusOf(repo)]).toEqual(['upstream\n', 'task\n', '']);
  });
});

describe('integrating into a branch no checkout holds', () => {
  it('moves the branch', async () => {
    git(repo, 'branch', '-q', 'free');
    commitFile(source, 'shared.txt', 'task\n');

    await integrate('free');

    expect(git(repo, 'show', 'free:shared.txt')).toBe('task');
    expect(tipOf('main')).not.toBe(tipOf('free'));
  });
});

describe('integration conflicts', () => {
  beforeEach(() => {
    commitFile(source, 'first.txt', 'task\n');
    commitFile(source, 'shared.txt', 'task\n');
    commitFile(source, 'last.txt', 'task\n');
    commitFile(repo, 'shared.txt', 'main\n');
  });

  const resolve = (state) => {
    write(state.tempWorktreePath, 'shared.txt', 'resolved\n');
    git(state.tempWorktreePath, 'add', 'shared.txt');
  };

  it('leaves the branch and its checkout alone until the conflict is resolved', async () => {
    const before = tipOf('main');
    const state = await integrateIntoConflict();
    expect([tipOf('main'), statusOf(repo)]).toEqual([before, '']);

    resolve(state);
    expect((await continueIntegrate(state)).kind).toBe('success');

    expect([read(repo, 'first.txt'), read(repo, 'shared.txt'), read(repo, 'last.txt')]).toEqual(['task\n', 'resolved\n', 'task\n']);
    expect(statusOf(repo)).toBe('');
    expect(worktreeCount()).toBe(2);
  });

  it('abort changes nothing', async () => {
    const before = tipOf('main');
    await abortIntegrate(await integrateIntoConflict());
    expect([tipOf('main'), statusOf(repo), worktreeCount()]).toEqual([before, '', 2]);
  });

  it('continues after the resolver already committed the pick', async () => {
    const state = await integrateIntoConflict();
    resolve(state);
    git(state.tempWorktreePath, '-c', 'core.editor=true', 'cherry-pick', '--continue');
    await expect(isIntegrateInProgress(state.tempWorktreePath)).resolves.toEqual({ inProgress: true });

    expect((await continueIntegrate(state)).kind).toBe('success');

    expect([read(repo, 'shared.txt'), read(repo, 'last.txt'), statusOf(repo)]).toEqual(['resolved\n', 'task\n', '']);
  });

  it('keeps the resolution when the checkout refuses, and lands it on the next continue', async () => {
    const state = await integrateIntoConflict();
    resolve(state);
    write(repo, 'shared.txt', 'mine\n');

    const refused = await continueIntegrate(state);
    expect(refused).toMatchObject({ kind: 'conflict', message: expect.stringContaining('shared.txt') });
    expect(read(repo, 'shared.txt')).toBe('mine\n');

    git(repo, 'checkout', '-q', '--', 'shared.txt');
    expect((await continueIntegrate(refused.state)).kind).toBe('success');
    expect([read(repo, 'shared.txt'), read(repo, 'last.txt'), statusOf(repo)]).toEqual(['resolved\n', 'task\n', '']);
  });

  it.each([
    ['aborted', (tmp) => git(tmp, 'cherry-pick', '--abort')],
    ['skipped', (tmp) => git(tmp, 'cherry-pick', '--skip')],
    ['aborted and something else committed', (tmp) => {
      git(tmp, 'cherry-pick', '--abort');
      write(tmp, 'unrelated.txt', 'mine\n');
      git(tmp, 'add', '.');
      git(tmp, 'commit', '-qm', 'unrelated', '--date=2001-01-01T00:00:00Z');
    }],
    ['aborted and an earlier pick reset away', (tmp) => {
      git(tmp, 'cherry-pick', '--abort');
      git(tmp, 'reset', '-q', '--hard', 'main');
    }],
    ['aborted and a later commit picked', (tmp) => {
      git(tmp, 'cherry-pick', '--abort');
      git(tmp, 'cherry-pick', 'task');
    }],
  ])('says so and picks again when a pick was %s by hand', async (_name, leave) => {
    const before = tipOf('main');
    const state = await integrateIntoConflict();
    leave(state.tempWorktreePath);

    const again = await continueIntegrate(state);
    expect(again).toMatchObject({
      kind: 'conflict',
      message: expect.stringContaining(state.currentCommit.slice(0, 7)),
      details: { unmergedFiles: ['shared.txt'] },
    });
    expect(tipOf('main')).toBe(before);

    resolve(again.state);
    expect((await continueIntegrate(again.state)).kind).toBe('success');
    expect([read(repo, 'first.txt'), read(repo, 'shared.txt'), read(repo, 'last.txt'), statusOf(repo)]).toEqual(['task\n', 'resolved\n', 'task\n', '']);
  });

  it.each([
    ['rewords the pick', (tmp) => git(tmp, 'commit', '-qm', 'reworded')],
    ['commits an empty pick', (tmp) => { git(tmp, 'checkout', '-q', 'HEAD', '--', 'shared.txt'); git(tmp, 'commit', '-q', '--allow-empty', '--no-edit'); }, 'main\n'],
  ])('does not pick again when the resolver %s', async (_name, finish, text = 'resolved\n') => {
    const state = await integrateIntoConflict();
    resolve(state);
    finish(state.tempWorktreePath);

    expect((await continueIntegrate(state)).kind).toBe('success');
    expect([read(repo, 'shared.txt'), read(repo, 'last.txt')]).toEqual([text, 'task\n']);
  });

  it('keeps a later commit whose pick could not start', async () => {
    const state = await integrateIntoConflict();
    resolve(state);
    write(state.tempWorktreePath, 'last.txt', 'mine\n');

    const refused = await continueIntegrate(state);
    expect(refused).toMatchObject({ kind: 'conflict', message: expect.stringContaining('last.txt') });

    commitFile(state.tempWorktreePath, 'unrelated.txt', 'mine\n');
    fs.rmSync(path.join(state.tempWorktreePath, 'last.txt'));
    expect((await continueIntegrate(refused.state)).kind).toBe('success');
    expect([read(repo, 'shared.txt'), read(repo, 'last.txt')]).toEqual(['resolved\n', 'task\n']);
  });

  it.each([false, true])('continues from where the checkout is when the browser missed an answer, pick committed: %s', async (committed) => {
    commitFile(source, 'second.txt', 'task\n');
    commitFile(repo, 'second.txt', 'main\n');
    const stale = await integrateIntoConflict();
    resolve(stale);
    expect((await continueIntegrate(stale)).kind).toBe('conflict');
    write(stale.tempWorktreePath, 'second.txt', 'resolved\n');
    git(stale.tempWorktreePath, 'add', 'second.txt');

    if (committed) git(stale.tempWorktreePath, '-c', 'core.editor=true', 'cherry-pick', '--continue');

    const current = await continueIntegrate(stale);
    expect(current).toMatchObject({ kind: 'conflict', reason: 'changed' });
    expect((await continueIntegrate(current.state)).kind).toBe('success');
    expect([read(repo, 'shared.txt'), read(repo, 'second.txt'), statusOf(repo)]).toEqual(['resolved\n', 'resolved\n', '']);
  });

  it('continues past a conflict resolved to what the target has', async () => {
    const state = await integrateIntoConflict();
    git(state.tempWorktreePath, 'checkout', '-q', 'HEAD', '--', 'shared.txt');

    expect((await continueIntegrate(state)).kind).toBe('success');
    expect([read(repo, 'shared.txt'), read(repo, 'last.txt'), statusOf(repo)]).toEqual(['main\n', 'task\n', '']);
  });

  it('remembers a commit resolved to nothing when a later one stops', async () => {
    commitFile(source, 'second.txt', 'task\n');
    commitFile(repo, 'second.txt', 'main\n');
    const state = await integrateIntoConflict();
    git(state.tempWorktreePath, 'checkout', '-q', 'HEAD', '--', 'shared.txt');
    const next = await continueIntegrate(state);
    expect(next).toMatchObject({ kind: 'conflict', details: { unmergedFiles: ['second.txt'] } });
    write(next.state.tempWorktreePath, 'second.txt', 'resolved\n');
    git(next.state.tempWorktreePath, 'add', 'second.txt');

    expect((await continueIntegrate(next.state)).kind).toBe('success');
    expect([read(repo, 'shared.txt'), read(repo, 'second.txt')]).toEqual(['main\n', 'resolved\n']);
  });

  it('refuses when the branch moved while the conflict was open', async () => {
    const state = await integrateIntoConflict();
    resolve(state);
    const moved = commitFile(repo, 'other.txt', 'main\n');

    expect(await continueIntegrate(state)).toMatchObject({ kind: 'conflict', message: expect.stringContaining('moved') });

    expect([tipOf('main'), statusOf(repo)]).toEqual([moved, '']);
    expect(read(state.tempWorktreePath, 'shared.txt')).toBe('resolved\n');
  });

  it('does not drop work left in a submodule of the temporary checkout', async () => {
    const library = path.join(root, 'library');
    fs.mkdirSync(library);
    git(library, 'init', '-q');
    commitFile(library, 'lib.txt', 'lib\n');
    git(repo, '-c', 'protocol.file.allow=always', 'submodule', '--quiet', 'add', library, 'library');
    git(repo, 'commit', '-qm', 'library');
    git(repo, 'config', 'submodule.library.ignore', 'dirty');
    const state = await integrateIntoConflict();
    git(state.tempWorktreePath, '-c', 'protocol.file.allow=always', 'submodule', '--quiet', 'update', '--init');
    resolve(state);
    const left = path.join(state.tempWorktreePath, 'library', 'left.txt');
    fs.writeFileSync(left, 'mine\n');

    expect(await continueIntegrate(state)).toMatchObject({ kind: 'conflict', message: expect.stringContaining('uncommitted') });
    expect(fs.readFileSync(left, 'utf8')).toBe('mine\n');
  });

  it('does not drop uncommitted work left in the temporary checkout', async () => {
    const before = tipOf('main');
    const state = await integrateIntoConflict();
    git(repo, 'config', 'status.showUntrackedFiles', 'no');
    resolve(state);
    write(state.tempWorktreePath, 'forgotten.txt', 'mine\n');

    expect(await continueIntegrate(state)).toMatchObject({ kind: 'conflict', message: expect.stringContaining('uncommitted') });

    expect(tipOf('main')).toBe(before);
    expect(read(state.tempWorktreePath, 'forgotten.txt')).toBe('mine\n');
  });
});

describe('listing worktrees while a conflict is open', () => {
  const integrateRows = async () => (await getWorktrees(repo)).filter((entry) => entry.integrateCheckout).map((entry) => fs.realpathSync(entry.path));

  it('marks the temporary checkout until it is aborted, and no worktree the user made', async () => {
    const lookalike = path.join(root, '.config', 'openchamber', 'tmp', 'oc-integrate-mine');
    git(repo, 'worktree', 'add', '-q', '--detach', lookalike);
    commitFile(source, 'shared.txt', 'task\n');
    commitFile(repo, 'shared.txt', 'main\n');

    const state = await integrateIntoConflict();

    expect(await integrateRows()).toEqual([fs.realpathSync(state.tempWorktreePath)]);
    vi.resetModules();
    const restarted = await import('./service.js');
    expect((await restarted.getWorktrees(source)).filter((entry) => entry.integrateCheckout)).toHaveLength(1);

    await abortIntegrate(state);
    git(repo, 'worktree', 'add', '-q', '--detach', state.tempWorktreePath);
    expect(await integrateRows()).toEqual([]);
  });

  it('marks a checkout with a relative worktree link, and shows the row once its folder is gone', async () => {
    commitFile(source, 'shared.txt', 'task\n');
    commitFile(repo, 'shared.txt', 'main\n');
    const state = await integrateIntoConflict();
    const checkout = fs.realpathSync(state.tempWorktreePath);
    const gitDirectory = git(checkout, 'rev-parse', '--absolute-git-dir');
    write(gitDirectory, 'gitdir', `${path.relative(gitDirectory, path.join(checkout, '.git'))}\n`);
    expect(await integrateRows()).toEqual([checkout]);

    write(gitDirectory, 'gitdir', `${path.join(checkout, '.git')}\n`);
    fs.rmSync(checkout, { recursive: true });
    expect((await getWorktrees(repo)).filter((entry) => entry.integrateCheckout)).toEqual([]);
    expect(await listIntegrateConflicts(repo)).toEqual([]);
  });

  it('never lists the checkout unmarked, even while it is being created', async () => {
    commitFile(source, 'shared.txt', 'task\n');
    commitFile(repo, 'shared.txt', 'main\n');
    const unmarked = [];
    let running = true;
    const watching = (async () => {
      while (running) {
        unmarked.push(...(await getWorktrees(repo)).filter((entry) => entry.name.startsWith('oc-integrate-') && !entry.integrateCheckout));
      }
    })();
    const state = await integrateIntoConflict();
    running = false;
    await watching;
    expect(unmarked).toEqual([]);
    await abortIntegrate(state);
  });

  it('shows the checkout as a worktree again when git refuses to remove it', async () => {
    commitFile(source, 'shared.txt', 'task\n');
    commitFile(repo, 'shared.txt', 'main\n');
    const state = await integrateIntoConflict();
    git(repo, 'worktree', 'lock', state.tempWorktreePath);
    await abortIntegrate(state);
    expect(await integrateRows()).toEqual([]);
    expect((await getWorktrees(repo)).map((entry) => entry.name)).toContain(path.basename(state.tempWorktreePath));
  });
});

describe('restoring a conflict from the record beside the checkout', () => {
  const startConflict = async () => {
    commitFile(source, 'shared.txt', 'task\n');
    commitFile(repo, 'shared.txt', 'main\n');
    return integrateIntoConflict();
  };
  const resolve = (state) => {
    write(state.tempWorktreePath, 'shared.txt', 'resolved\n');
    git(state.tempWorktreePath, 'add', 'shared.txt');
  };
  const recordOf = (state) => path.join(git(state.tempWorktreePath, 'rev-parse', '--absolute-git-dir'), 'openchamber-integrate');

  it('lists it from any checkout of the repository after a restart, and finishes it', async () => {
    const state = await startConflict();
    vi.resetModules();
    const restarted = await import('./service.js');

    const [fromMain] = await restarted.listIntegrateConflicts(repo);
    const [fromTask] = await restarted.listIntegrateConflicts(source);
    expect(fromTask).toEqual(fromMain);
    expect(fromMain).toMatchObject({ state: { sourceBranch: 'task', targetBranch: 'main' }, details: { unmergedFiles: ['shared.txt'] } });
    resolve(state);
    expect((await restarted.continueIntegrate(fromMain.state)).kind).toBe('success');
    expect(read(repo, 'shared.txt')).toBe('resolved\n');
    expect(await restarted.listIntegrateConflicts(repo)).toEqual([]);
  });

  it.each([
    ['not JSON', () => '{'],
    ['empty', () => ''],
    ['incomplete', (text) => JSON.stringify({ ...JSON.parse(text), pickBase: undefined })],
    ['from another version', (text) => JSON.stringify({ ...JSON.parse(text), version: 2 })],
    ['naming a repository that is gone', (text) => JSON.stringify({ ...JSON.parse(text), repoRoot: '/nowhere/at/all' })],
    ['naming a missing folder inside the repository', (text) => JSON.stringify({ ...JSON.parse(text), repoRoot: path.join(repo, 'gone') })],
    ['naming another repository', (text) => { const other = path.join(root, 'other'); fs.mkdirSync(other); git(other, 'init', '-q'); return JSON.stringify({ ...JSON.parse(text), repoRoot: other }); }],
    ['left by a run that died', () => JSON.stringify({ version: 1, phase: 'picking', pid: 2 ** 30, host: os.hostname(), at: Date.now() })],
  ])('shows the row when the record is %s', async (_name, damage) => {
    const state = await startConflict();
    const file = recordOf(state);
    fs.writeFileSync(file, damage(fs.readFileSync(file, 'utf8')));

    expect(await listIntegrateConflicts(repo)).toEqual([]);
    const row = (await getWorktrees(repo)).find((entry) => entry.name === path.basename(state.tempWorktreePath));
    expect(row).toBeDefined();
    expect(row.integrateCheckout).toBeUndefined();
    await expect(continueIntegrate(state)).resolves.toEqual({ kind: 'gone' });
    expect(fs.existsSync(state.tempWorktreePath)).toBe(true);
  });

  it('keeps the reason Continue stopped for the next client', async () => {
    const state = await startConflict();
    resolve(state);
    write(state.tempWorktreePath, 'stray.txt', 'mine\n');
    const refused = await continueIntegrate(state);
    expect((await listIntegrateConflicts(repo))[0].message).toBe(refused.message);
  });

  it('lets one of two clients finish, and tells the other it is over', async () => {
    const state = await startConflict();
    resolve(state);
    const results = await Promise.all([continueIntegrate(state), continueIntegrate(state)]);
    expect(results.map((result) => result.kind).filter((kind) => kind !== 'busy' && kind !== 'gone')).toEqual(['success']);
    expect((await continueIntegrate(state)).kind).toBe('gone');
    expect((await abortIntegrate(state)).kind).toBe('gone');
    expect(git(repo, 'rev-list', '--count', 'main')).toBe('4');
  });

  it('does not abort work another client has continued', async () => {
    commitFile(source, 'second.txt', 'task\n');
    commitFile(repo, 'second.txt', 'main\n');
    const stale = await startConflict();
    write(stale.tempWorktreePath, 'second.txt', 'resolved\n');
    git(stale.tempWorktreePath, 'add', 'second.txt');
    const moved = await continueIntegrate(stale);
    expect(moved.kind).toBe('conflict');

    expect(await abortIntegrate(stale)).toMatchObject({ kind: 'conflict', reason: 'changed', state: { revision: moved.state.revision } });
    expect(fs.existsSync(stale.tempWorktreePath)).toBe(true);
    expect((await abortIntegrate(moved.state)).kind).toBe('aborted');
  });

  it('answers a second start of the same branches with the open conflict', async () => {
    const state = await startConflict();
    expect(await integrate()).toMatchObject({ kind: 'conflict', reason: 'alreadyOpen', state: { tempWorktreePath: fs.realpathSync(state.tempWorktreePath) } });
    expect(worktreeCount()).toBe(3);
  });

  it('gives a client that sends no revision the current state', async () => {
    const { revision: _revision, ...state } = await startConflict();
    expect(await abortIntegrate(state)).toMatchObject({ kind: 'conflict', reason: 'changed' });
    expect(fs.existsSync(state.tempWorktreePath)).toBe(true);
  });

  it('touches no checkout it did not record', async () => {
    const state = await startConflict();
    await expect(abortIntegrate({ ...state, tempWorktreePath: source })).resolves.toEqual({ kind: 'gone' });
    expect(fs.existsSync(source)).toBe(true);
  });

  it('says another window is busy while the lock is held', async () => {
    const state = await startConflict();
    write(path.join(repo, '.git'), 'openchamber-integrate.lock', JSON.stringify({ pid: process.pid, host: os.hostname(), at: Date.now() }));
    await expect(abortIntegrate(state)).resolves.toEqual({ kind: 'busy' });
    expect(fs.existsSync(state.tempWorktreePath)).toBe(true);
  });
});
