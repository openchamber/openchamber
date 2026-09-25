// Code in, with real host git in temporary directories and no Docker. The live file under places/
// proves the same path into a real space.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { SECRET, SETUP_GIT, blob, createTestHost, forConfig, hostState, makeBait, readTree, removeTestHosts, shortStatus, unexpectedChanges } from './code-in-bait.js';
import { buildExtUrl, createCodeIn } from './code-in.js';
import { SpaceError } from './errors.js';
import { createHostGit } from './host-git.js';
import { IMAGE_ONLY_PATH, IMAGE_SH } from './layout.js';
import { runCommand } from './run-command.js';

const WIN = process.platform === 'win32';
// `*` cannot be in a file name on Windows; brackets, `!`, `#`, spaces and non-ASCII can.
const ODD_NAME = WIN ? 'odd [!] #name ї' : 'odd [*] name';
const SPACE_ID = 'a1b2c3d4e5f6';
const OTHER_SPACE_ID = 'f6e5d4c3b2a1';

afterAll(removeTestHosts);

/** What changed in a repository folder since `before`, apart from what code in writes by design for these spaces. */
const changedSince = (before, directory, spaceIds = [SPACE_ID]) => unexpectedChanges(before, hostState(directory), { spaceIds });

const snapshotOf = (host, repository, mode = 'uncommitted') => host.codeIn().takeSnapshot({ repository, spaceId: SPACE_ID, mode });

/** A committed repository of its own in `folder` of `repo`, or one with no commit. */
const nestRepository = (host, repo, folder, { commit = true } = {}) => {
  const nested = path.join(repo, folder);
  host.sh(repo, ['init', '--quiet', folder]);
  fs.writeFileSync(path.join(nested, 'inner.txt'), 'inner\n');
  if (commit) {
    host.sh(nested, ['add', 'inner.txt']);
    host.sh(nested, ['commit', '--quiet', '-m', 'inner']);
  }
  return nested;
};

describe('hostState and unexpectedChanges', () => {
  // Each of these changes a repository in a way code in must never do. The helper has to see every one.
  const CHANGES = [
    ['.git/config', (repo, g) => g(['config', 'core.hooksPath', '/elsewhere']), '.git/config'],
    ['a new hook', (repo) => fs.writeFileSync(path.join(repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\n'), '.git/hooks/pre-commit'],
    ['info/exclude', (repo) => fs.appendFileSync(path.join(repo, '.git', 'info', 'exclude'), 'more\n'), '.git/info/exclude'],
    ['MERGE_HEAD', (repo, g) => fs.writeFileSync(path.join(repo, '.git', 'MERGE_HEAD'), g(['rev-parse', 'HEAD'])), '.git/MERGE_HEAD'],
    ['a shared index file', (repo) => fs.writeFileSync(path.join(repo, '.git', `sharedindex.${'0'.repeat(40)}`), 'x'), `.git/sharedindex.${'0'.repeat(40)}`],
    ['a new empty folder', (repo) => fs.mkdirSync(path.join(repo, 'empty folder')), 'empty folder'],
    ['packed refs', (repo, g) => g(['pack-refs', '--all']), '.git/packed-refs'],
    ['a reflog', (repo) => fs.appendFileSync(path.join(repo, '.git', 'logs', 'HEAD'), 'x\n'), '.git/logs/HEAD'],
    ['a ref of ours outside this space', (repo, g) => g(['update-ref', 'refs/openchamber/other', 'HEAD']), '.git/refs/openchamber/other'],
    ['the ref of another space', (repo, g) => g(['update-ref', `refs/openchamber/spaces/${OTHER_SPACE_ID}/start`, 'HEAD']), `.git/refs/openchamber/spaces/${OTHER_SPACE_ID}/start`],
    ['a loose object rewritten', (repo, g) => {
      const id = g(['hash-object', '-w', '--stdin'], { input: 'existing\n' }).trim();
      fs.chmodSync(path.join(repo, '.git', 'objects', id.slice(0, 2), id.slice(2)), 0o644);
      fs.writeFileSync(path.join(repo, '.git', 'objects', id.slice(0, 2), id.slice(2)), 'changed');
    }, null],
    ...(WIN ? [] : [['chmod +x of an untracked file', (repo) => fs.chmodSync(path.join(repo, 'untracked plain.txt'), 0o755), 'untracked plain.txt']]),
  ];

  it.each(CHANGES)('sees %s', (_, change, expectedPath) => {
    const host = createTestHost();
    const { repo, g } = makeBait(host);
    // The object the rewrite changes has to exist before the first look.
    if (expectedPath === null) g(['hash-object', '-w', '--stdin'], { input: 'existing\n' });
    const before = hostState(repo);
    change(repo, (args, options) => host.sh(repo, args, options));
    const changed = changedSince(before, repo);
    expect(changed.length).toBeGreaterThan(0);
    if (expectedPath !== null) expect(changed).toContain(expectedPath);
  });

  // Two changes that looked like what code in writes by design, and are not.
  it('sees the start ref of this space moved to another commit', () => {
    const host = createTestHost();
    const { repo, g } = makeBait(host);
    g(['update-ref', `refs/openchamber/spaces/${SPACE_ID}/start`, 'HEAD']);
    const before = hostState(repo);
    g(['update-ref', `refs/openchamber/spaces/${SPACE_ID}/start`, 'HEAD~1']);
    expect(changedSince(before, repo)).toEqual([`.git/refs/openchamber/spaces/${SPACE_ID}/start`]);
  });

  it('sees a new loose object in a nested repository', () => {
    const host = createTestHost();
    const { repo } = makeBait(host);
    const nested = nestRepository(host, repo, 'nested');
    const before = hostState(repo);
    const id = host.sh(nested, ['hash-object', '-w', '--stdin'], { input: 'inside the nested one\n' }).trim();
    expect(changedSince(before, repo)).toContain(`nested/.git/objects/${id.slice(0, 2)}/${id.slice(2)}`);
  });

  // An fsmonitor daemon keeps a socket in `.git`. Reading it crashed the helper, and a FIFO would hang it.
  it.skipIf(WIN)('describes a socket and a FIFO by type, and sees each appear', async () => {
    const host = createTestHost();
    const { repo } = makeBait(host);
    const before = hostState(repo);
    // A socket path has a short length limit, so it is made in a short folder and moved in.
    const short = fs.mkdtempSync('/tmp/oc-');
    const server = net.createServer();
    let writer = null;
    await new Promise((resolve) => { server.listen(path.join(short, 's'), resolve); });
    try {
      fs.renameSync(path.join(short, 's'), path.join(repo, '.git', 'daemon.ipc'));
      const fifo = path.join(repo, '.git', 'a-fifo');
      expect(spawnSync('mkfifo', [fifo]).status).toBe(0);
      // A writer waits on the other end, so a helper that read the FIFO would finish, with the wrong
      // answer, instead of hanging the test.
      writer = spawn('/bin/sh', ['-c', 'printf x > "$1"', 'sh', fifo], { stdio: 'ignore' });
      const after = hostState(repo);
      expect(after['.git/daemon.ipc']).toMatch(/^socket /);
      expect(after['.git/a-fifo']).toMatch(/^fifo /);
      expect(unexpectedChanges(before, after, { spaceIds: [SPACE_ID] })).toEqual(['.git/a-fifo', '.git/daemon.ipc']);
    } finally {
      if (Number.isInteger(writer?.pid) && writer.pid > 1 && writer.exitCode === null) writer.kill('SIGKILL');
      server.close();
      fs.rmSync(short, { recursive: true, force: true });
    }
  });

  it('allows a new loose object and the start ref of this space, and nothing else', () => {
    const host = createTestHost();
    const { repo, g } = makeBait(host);
    const before = hostState(repo);
    g(['hash-object', '-w', '--stdin'], { input: 'a new object\n' });
    g(['update-ref', `refs/openchamber/spaces/${SPACE_ID}/start`, 'HEAD']);
    expect(changedSince(before, repo)).toEqual([]);
    expect(changedSince(before, repo, [])).toEqual([
      '.git/refs/openchamber',
      '.git/refs/openchamber/spaces',
      `.git/refs/openchamber/spaces/${SPACE_ID}`,
      `.git/refs/openchamber/spaces/${SPACE_ID}/start`,
    ]);
  });
});

describe('takeSnapshot', () => {
  it('holds the working tree in the start and the index in the staged commit, and leaves ignored files out', async () => {
    const host = createTestHost();
    const { repo, g } = makeBait(host);
    const head = g(['rev-parse', 'HEAD']).trim();
    const snapshot = await snapshotOf(host, repo);

    expect(snapshot).toMatchObject({ base: head, branch: 'main', objectFormat: 'sha1', identity: { name: 'Bait Author', email: 'bait@example.invalid' } });
    expect(g(['rev-parse', `${snapshot.staged}^`]).trim()).toBe(head);
    expect(g(['rev-parse', `${snapshot.start}^`]).trim()).toBe(snapshot.staged);
    expect(g(['log', '-1', '--format=%an <%ae>', snapshot.start]).trim()).toBe('OpenChamber <spaces@openchamber.invalid>');

    const start = readTree(g, snapshot.start);
    expect(start['run.sh'].mode).toBe('100755');
    expect(blob(g, snapshot.start, 'tracked-to-edit.txt')).toBe('one\ntwo staged\nthree unstaged\n');
    expect(Object.keys(start)).toEqual(expect.arrayContaining(['staged-new.txt', 'untracked plain.txt', 'юнікод.txt', '.gitignore', 'README.md']));
    expect(start['tracked-to-delete.txt']).toBeUndefined();
    if (!WIN) expect(start['link-to-readme'].mode).toBe('120000');
    // Ignored by the repository, and by the global ignore file only.
    expect(start['.env']).toBeUndefined();
    expect(Object.keys(start).filter((file) => file.startsWith('node_modules/'))).toEqual([]);
    expect(start['secret-by-global-ignore.txt']).toBeUndefined();
    for (const file of Object.keys(start).filter((name) => start[name].mode !== '120000')) {
      expect(blob(g, snapshot.start, file)).not.toContain(SECRET);
    }

    const staged = readTree(g, snapshot.staged);
    expect(blob(g, snapshot.staged, 'tracked-to-edit.txt')).toBe('one\ntwo staged\n');
    expect(staged['tracked-to-delete.txt']).toBeDefined();
    expect(staged['staged-new.txt']).toBeDefined();
    expect(staged['untracked plain.txt']).toBeUndefined();
  });

  // The snapshot runs with the user's normal config for this. Run without the global config, it
  // would carry every file the user keeps out through their global ignore file.
  it('keeps a file that only the global ignore file names out of the snapshot and out of the list', async () => {
    const host = createTestHost();
    const { repo, g } = makeBait(host);
    const snapshot = await snapshotOf(host, repo);
    expect(Object.keys(readTree(g, snapshot.start))).not.toContain('secret-by-global-ignore.txt');
    expect((await host.codeIn().listTravellingFiles(repo)).files.map((file) => file.path)).not.toContain('secret-by-global-ignore.txt');
  });

  it('changes nothing in the repository folder, .git included, but new loose objects and its own ref', async () => {
    const host = createTestHost();
    const { repo } = makeBait(host);
    const before = hostState(repo);
    await snapshotOf(host, repo);
    expect(changedSince(before, repo)).toEqual([]);
  });

  it('keeps the start alive with a host ref, refuses a second one, and removes the refs of one space only', async () => {
    const host = createTestHost();
    const { repo, g } = makeBait(host);
    const codeIn = host.codeIn();
    const snapshot = await snapshotOf(host, repo);
    const other = await codeIn.takeSnapshot({ repository: repo, spaceId: OTHER_SPACE_ID, mode: 'clean' });
    expect(g(['rev-parse', `refs/openchamber/spaces/${SPACE_ID}/start`]).trim()).toBe(snapshot.start);
    const before = hostState(repo);
    await expect(snapshotOf(host, repo)).rejects.toMatchObject({ code: 'space_ref_exists' });
    expect(changedSince(before, repo, [])).toEqual([]);

    expect(await codeIn.removeSpaceRefs({ repository: repo, spaceId: SPACE_ID })).toEqual([`refs/openchamber/spaces/${SPACE_ID}/start`]);
    expect(g(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/openchamber/'])).toBe(`refs/openchamber/spaces/${OTHER_SPACE_ID}/start ${other.start}\n`);
    expect(await codeIn.removeSpaceRefs({ repository: repo, spaceId: SPACE_ID })).toEqual([]);
    expect(changedSince(before, repo)).toEqual([]);
  });

  it('starts at HEAD with nothing uncommitted in the clean mode', async () => {
    const host = createTestHost();
    const { repo, g } = makeBait(host);
    const head = g(['rev-parse', 'HEAD']).trim();
    expect(await snapshotOf(host, repo, 'clean')).toMatchObject({ base: head, staged: head, start: head });
  });

  it('does not sign the snapshot commits for a user who signs every commit', async () => {
    const host = createTestHost();
    const { repo, g } = makeBait(host);
    host.addConfig('[commit]\n\tgpgSign = true\n[gpg]\n\tprogram = openchamber-no-such-gpg-program');
    // The control: with this config a commit tries to sign and fails. Measured with git 2.50.1,
    // `commit-tree` itself ignores `commit.gpgSign`, so `--no-gpg-sign` there guards against a git
    // that reads it; this test proves the outcome, a snapshot that works, whichever git runs.
    const control = path.join(host.root, 'signing control');
    host.sh(host.root, ['init', '--quiet', control]);
    expect(spawnSync('git', [...SETUP_GIT, '-C', control, 'commit', '--allow-empty', '-m', 'control'], { env: host.environment, windowsHide: true }).status).not.toBe(0);

    const snapshot = await snapshotOf(host, repo);
    expect(g(['cat-file', 'commit', snapshot.start])).not.toContain('gpgsig');
  });

  it('works for a user without a git identity, and guesses none', async () => {
    const host = createTestHost({ identity: false });
    const { repo } = makeBait(host);
    expect((await snapshotOf(host, repo)).identity).toEqual({ name: '', email: '' });
  });

  it('refuses a folder outside a working tree, a bare repository, a repository with no commit, and unresolved conflicts, and changes nothing', async () => {
    const host = createTestHost();
    const refuses = async (repository, code) => {
      const before = hostState(repository);
      await expect(snapshotOf(host, repository)).rejects.toMatchObject({ code });
      expect(changedSince(before, repository, [])).toEqual([]);
    };

    const plain = path.join(host.root, 'plain folder');
    fs.mkdirSync(plain);
    fs.writeFileSync(path.join(plain, 'a.txt'), 'a\n');
    await refuses(plain, 'not_a_git_work_tree');

    const bare = path.join(host.root, 'bare.git');
    host.sh(host.root, ['init', '--quiet', '--bare', bare]);
    await refuses(bare, 'not_a_git_work_tree');

    const unborn = path.join(host.root, 'unborn');
    host.sh(host.root, ['init', '--quiet', unborn]);
    fs.writeFileSync(path.join(unborn, 'a.txt'), 'a\n');
    await refuses(unborn, 'repository_has_no_commit');

    const { repo, g } = makeBait(host, { name: 'conflict' });
    g(['stash', '--include-untracked', '--quiet']);
    g(['checkout', '--quiet', '-b', 'other']);
    fs.writeFileSync(path.join(repo, 'history.txt'), 'other side\n');
    g(['commit', '--quiet', '-am', 'other side']);
    g(['checkout', '--quiet', 'main']);
    fs.writeFileSync(path.join(repo, 'history.txt'), 'main side\n');
    g(['commit', '--quiet', '-am', 'main side']);
    expect(spawnSync('git', [...SETUP_GIT, '-C', repo, 'merge', 'other'], { env: host.environment, windowsHide: true }).status).not.toBe(0);
    await refuses(repo, 'repository_has_unmerged_changes');
  });

  it.each([
    ['ignored', (repo) => { fs.mkdirSync(path.join(repo, 'scratch')); fs.writeFileSync(path.join(repo, 'scratch', 'notes.txt'), 'notes\n'); fs.appendFileSync(path.join(repo, '.gitignore'), 'scratch/\n'); }],
    ['empty', (repo) => { fs.mkdirSync(path.join(repo, 'scratch')); }],
  ])('refuses a project in a subfolder that is %s, before anything reaches the space, and changes nothing but loose objects', async (_, make) => {
    const host = createTestHost();
    const { repo, g } = makeBait(host);
    make(repo);
    const before = hostState(repo);
    const place = { exec: async () => { throw new Error('the space must not be asked'); }, execArgv: async () => { throw new Error('the space must not be asked'); } };
    for (const mode of ['uncommitted', 'clean']) {
      await expect(host.codeIn(place).bringCodeIn({ repository: path.join(repo, 'scratch'), spaceId: SPACE_ID, mode })).rejects.toMatchObject({ code: 'project_folder_does_not_travel' });
    }
    expect(g(['for-each-ref', 'refs/openchamber/'])).toBe('');
    expect(changedSince(before, repo, [])).toEqual([]);
  });

  it('keeps untracked repositories out of the snapshot, with or without a commit, however they are named', async () => {
    const host = createTestHost();
    const { repo, g } = makeBait(host);
    nestRepository(host, repo, 'nested');
    nestRepository(host, repo, ODD_NAME, { commit: false });
    // Read as a pattern, `file[s]` would also exclude the untracked file `files`, which must travel.
    nestRepository(host, repo, 'file[s]');
    // Pathspecs separated by lines instead of NUL would split this one in two.
    if (!WIN) nestRepository(host, repo, 'line\nbreak');
    fs.writeFileSync(path.join(repo, 'files'), 'travels despite the repository next to it\n');
    const before = hostState(repo);
    const snapshot = await snapshotOf(host, repo);
    const start = Object.keys(readTree(g, snapshot.start));
    expect(start.filter((file) => file.startsWith('nested') || file.startsWith('odd') || file.startsWith('file[') || file.startsWith('line'))).toEqual([]);
    expect(start).toContain('files');
    expect(start).toContain('untracked plain.txt');
    expect(start).not.toContain('tracked-to-delete.txt');
    expect(changedSince(before, repo)).toEqual([]);
  });

  it('works in a SHA-256 repository', async () => {
    const host = createTestHost();
    const { repo, g } = makeBait(host, { objectFormat: 'sha256' });
    const before = hostState(repo);
    const snapshot = await snapshotOf(host, repo);
    expect(snapshot.objectFormat).toBe('sha256');
    expect(snapshot.start).toMatch(/^[0-9a-f]{64}$/);
    expect(readTree(g, snapshot.start)['untracked plain.txt']).toBeDefined();
    expect(changedSince(before, repo)).toEqual([]);
  });

  it('works in a linked worktree, from its own index and HEAD, and leaves both checkouts alone', async () => {
    const host = createTestHost();
    const { repo, g } = makeBait(host);
    const worktree = path.join(host.root, 'linked worktree');
    g(['worktree', 'add', '--quiet', '-b', 'feature', worktree]);
    const w = (args) => host.sh(worktree, args);
    fs.writeFileSync(path.join(worktree, 'feature.txt'), 'feature\n');
    w(['add', 'feature.txt']);
    fs.writeFileSync(path.join(worktree, 'README.md'), 'changed in the worktree\n');
    const mainBefore = hostState(repo);
    const worktreeBefore = hostState(worktree);

    const snapshot = await snapshotOf(host, worktree);
    expect(snapshot).toMatchObject({ branch: 'feature', repository: worktree });
    expect(readTree(w, snapshot.staged)['feature.txt']).toBeDefined();
    expect(blob(w, snapshot.start, 'README.md')).toBe('changed in the worktree\n');
    expect(readTree(w, snapshot.start)['untracked plain.txt']).toBeUndefined();
    expect(changedSince(mainBefore, repo)).toEqual([]);
    expect(changedSince(worktreeBefore, worktree)).toEqual([]);
  });

  it('writes no shared index file into the repository of a user with a split index', async () => {
    const host = createTestHost({ config: '[core]\n\tsplitIndex = true' });
    const { repo, g } = makeBait(host);
    g(['update-index', '--split-index']);
    const before = hostState(repo);
    expect(Object.keys(before).filter((file) => file.startsWith('.git/sharedindex.')).length).toBeGreaterThan(0);

    const snapshot = await snapshotOf(host, repo);
    expect(readTree(g, snapshot.start)['untracked plain.txt']).toBeDefined();
    expect(blob(g, snapshot.staged, 'tracked-to-edit.txt')).toBe('one\ntwo staged\n');
    expect(changedSince(before, repo)).toEqual([]);
  });

  it('brings the content of an intent-to-add file in the start, where it is new', async () => {
    const host = createTestHost();
    const { repo, g } = makeBait(host);
    fs.writeFileSync(path.join(repo, 'intended.txt'), 'intended\n');
    g(['add', '--intent-to-add', 'intended.txt']);
    const before = hostState(repo);
    const snapshot = await snapshotOf(host, repo);
    expect(readTree(g, snapshot.staged)['intended.txt']).toBeUndefined();
    expect(blob(g, snapshot.start, 'intended.txt')).toBe('intended\n');
    expect(changedSince(before, repo)).toEqual([]);
  });

  it('reports a detached HEAD as no branch, and a project in a subfolder by its prefix', async () => {
    const host = createTestHost();
    const { repo, g } = makeBait(host);
    fs.mkdirSync(path.join(repo, 'packages', 'app'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'packages', 'app', 'index.js'), 'app\n');
    g(['checkout', '--quiet', '--detach']);
    const snapshot = await snapshotOf(host, path.join(repo, 'packages', 'app'));
    expect(snapshot).toMatchObject({ branch: null, prefix: 'packages/app/', repository: repo });
  });
});

describe('listTravellingFiles', () => {
  it('lists exactly what the snapshot adds, and untracked repositories as not travelling', async () => {
    const host = createTestHost();
    const { repo, g } = makeBait(host);
    nestRepository(host, repo, 'nested');
    nestRepository(host, repo, 'empty-nested', { commit: false });
    const codeIn = host.codeIn();

    const { files, notTravelling, totalBytes } = await codeIn.listTravellingFiles(repo);
    const snapshot = await snapshotOf(host, repo);
    const added = g(['diff-tree', '-r', '-z', '--no-renames', '--name-only', '--diff-filter=A', snapshot.staged, snapshot.start]).split('\0').filter(Boolean);
    expect(files.map((file) => file.path).sort()).toEqual(added.sort());

    expect(notTravelling).toEqual(expect.arrayContaining([{ path: 'nested', kind: 'repository' }, { path: 'empty-nested', kind: 'repository' }]));
    expect(notTravelling).toHaveLength(2);
    expect(files.map((file) => file.path).filter((file) => file.includes('nested'))).toEqual([]);
    expect(files).toContainEqual({ path: 'untracked plain.txt', kind: 'file', size: Buffer.byteLength('untracked travels\n') });
    expect(files.map((file) => file.path)).toEqual(expect.not.arrayContaining(['.env', 'secret-by-global-ignore.txt', 'node_modules/x.js']));
    if (!WIN) expect(files).toContainEqual({ path: 'link-to-readme', kind: 'symlink', size: Buffer.byteLength('README.md') });
    expect(totalBytes).toBe(files.reduce((sum, file) => sum + (file.size ?? 0), 0));
  });
});

describe('readTransferLimits', () => {
  it('names submodule paths and sees Git LFS', async () => {
    const host = createTestHost();
    const { repo, g } = makeBait(host);
    expect(await host.codeIn().readTransferLimits(repo)).toEqual({ submodules: [], usesLfs: false });

    const head = g(['rev-parse', 'HEAD']).trim();
    g(['update-index', '--add', '--cacheinfo', `160000,${head},vendor/lib`]);
    fs.writeFileSync(path.join(repo, '.gitattributes'), 'model.bin filter=lfs diff=lfs merge=lfs -text\n');
    fs.writeFileSync(path.join(repo, 'model.bin'), 'weights\n');
    expect(await host.codeIn().readTransferLimits(repo)).toEqual({ submodules: ['vendor/lib'], usesLfs: true });
  });
});

describe('buildExtUrl', () => {
  it('writes spaces and percent signs the way git-remote-ext reads them', () => {
    expect(buildExtUrl(['C:\\Program Files\\Docker\\docker.exe', 'exec', '--interactive', '50%', 'a %s b'])).toBe(
      'ext::C:\\Program% Files\\Docker\\docker.exe exec --interactive 50%% a% %%s% b',
    );
  });

  it.each([[[]], [['docker', '']], [['docker', 'a\nb']], [['docker', 'a\tb']], [['docker', 'a\0b']], [['docker', 'a\x7fb']]])('refuses what it cannot carry: %j', (argv) => {
    expect(() => buildExtUrl(argv)).toThrow(SpaceError);
  });
});

describe('sendHistory from a shallow host repository', () => {
  it('reports that there is no history to send, and touches no space', async () => {
    const host = createTestHost();
    const { repo } = makeBait(host);
    const shallow = path.join(host.root, 'shallow clone');
    host.sh(host.root, ['clone', '--quiet', '--depth', '1', `file://${forConfig(repo)}`, shallow]);
    const place = { exec: async () => { throw new Error('the space must not be asked'); }, execArgv: async () => { throw new Error('the space must not be asked'); } };
    expect(await host.codeIn(place).sendHistory({ repository: shallow, spaceId: SPACE_ID, spacePath: `/spaces/${SPACE_ID}/shallow-clone`, base: host.sh(shallow, ['rev-parse', 'HEAD']).trim() })).toEqual({ status: 'host_shallow' });
  });
});

describe('the git version floor', () => {
  // The real host git, except that it answers `git version` with what the test says.
  const gitAnswering = (host, text) => ({
    run: (directory, args, options) => (args[args.length - 1] === 'version'
      ? Promise.resolve({ code: 0, stdout: text, stderr: '' })
      : host.git.run(directory, args, options)),
    output: (directory, args, options) => host.git.output(directory, args, options),
  });

  it.each([
    ['git version 2.26.2\n', 'git_too_old'],
    ['git version 1.9.5\n', 'git_too_old'],
    ['something else\n', 'git_version_unreadable'],
  ])('refuses %j before it takes a snapshot', async (text, code) => {
    const host = createTestHost();
    const { repo } = makeBait(host);
    const before = hostState(repo);
    const codeIn = createCodeIn({ git: gitAnswering(host, text), place: null, temporaryDirectory: host.root });
    const failure = await codeIn.takeSnapshot({ repository: repo, spaceId: SPACE_ID, mode: 'uncommitted' }).catch((error) => error);
    expect(failure).toMatchObject({ code });
    if (code === 'git_too_old') expect(failure.message).toMatch(/needs git 2\.27 or newer/);
    expect(changedSince(before, repo, [])).toEqual([]);
  });

  it('lets 2.27.0 and every build suffix through, and refuses an old git for the history too', async () => {
    const host = createTestHost();
    const { repo } = makeBait(host);
    for (const text of ['git version 2.27.0\n', 'git version 2.50.1 (Apple Git-155)\n', 'git version 2.54.0.windows.1\n']) {
      const codeIn = createCodeIn({ git: gitAnswering(host, text), place: null, temporaryDirectory: host.root });
      await codeIn.takeSnapshot({ repository: repo, spaceId: SPACE_ID, mode: 'clean' });
      await codeIn.removeSpaceRefs({ repository: repo, spaceId: SPACE_ID });
    }
    const old = createCodeIn({ git: gitAnswering(host, 'git version 2.20.1\n'), place: null, temporaryDirectory: host.root });
    await expect(old.sendHistory({ repository: repo, spaceId: SPACE_ID, spacePath: `/spaces/${SPACE_ID}/bait-repo-`, base: host.sh(repo, ['rev-parse', 'HEAD']).trim() }))
      .rejects.toMatchObject({ code: 'history_transfer_failed', details: { cause: 'git_too_old' } });
  });
});

describe('failures keep their codes', () => {
  const unreachablePlace = { exec: async () => { throw new SpaceError('space_not_found', 'no such space'); }, execArgv: async () => { throw new SpaceError('space_not_found', 'no such space'); } };

  it('reports a temporary folder that cannot be made with the documented codes, a step and a cause', async () => {
    const host = createTestHost();
    const { repo, g } = makeBait(host);
    const nowhere = { temporaryDirectory: path.join(host.root, 'no such folder') };
    await expect(host.codeIn(unreachablePlace, nowhere).bringCodeIn({ repository: repo, spaceId: SPACE_ID }))
      .rejects.toMatchObject({ code: 'code_transfer_failed', details: { step: 'make a temporary folder', cause: 'ENOENT' } });
    await expect(host.codeIn(unreachablePlace, nowhere).sendHistory({ repository: repo, spaceId: SPACE_ID, spacePath: `/spaces/${SPACE_ID}/bait-repo-`, base: g(['rev-parse', 'HEAD']).trim() }))
      .rejects.toMatchObject({ code: 'history_transfer_failed', details: { step: 'make a temporary folder', cause: 'ENOENT' } });
  });

  it.each([
    ['a repository moved away', (host) => ({ repository: path.join(host.root, 'moved away') }), 'project_folder_missing'],
    ['a folder that is no repository', (host) => { const plain = path.join(host.root, 'plain'); fs.mkdirSync(plain, { recursive: true }); return { repository: plain }; }, 'not_a_git_work_tree'],
    ['a space that cannot be reached', () => ({}), 'space_not_found'],
    ['a space path code in did not return', () => ({ spacePath: `/spaces/${SPACE_ID}/../elsewhere` }), 'invalid_space_path'],
  ])('rejects the history with history_transfer_failed for %s, with the cause', async (_, change, cause) => {
    const host = createTestHost();
    const { repo, g } = makeBait(host);
    const request = { repository: repo, spaceId: SPACE_ID, spacePath: `/spaces/${SPACE_ID}/bait-repo-`, base: g(['rev-parse', 'HEAD']).trim(), ...change(host) };
    const failure = await host.codeIn(unreachablePlace).sendHistory(request).catch((error) => error);
    expect(failure).toMatchObject({ code: 'history_transfer_failed', details: { cause } });
    expect(failure.details.step).toEqual(expect.any(String));
  });

  it('turns a failure of the place into code_transfer_failed, with the place\'s code as the cause', async () => {
    const host = createTestHost();
    const { repo, g } = makeBait(host);
    const before = hostState(repo);
    const failure = await host.codeIn(unreachablePlace).bringCodeIn({ repository: repo, spaceId: SPACE_ID }).catch((error) => error);
    expect(failure).toMatchObject({ code: 'code_transfer_failed', details: { step: 'reach the space', cause: 'space_not_found' } });
    expect(g(['for-each-ref', 'refs/openchamber/'])).toBe('');
    expect(changedSince(before, repo)).toEqual([]);
  });

  it('turns a runner failure during the snapshot into code_transfer_failed, and passes the refusals as they are', async () => {
    const host = createTestHost();
    const { repo } = makeBait(host);
    const timingOut = {
      run: (directory, args, options) => host.git.run(directory, args, options),
      output: (directory, args, options) => (args.includes('add')
        ? Promise.reject(new SpaceError('command_timeout', 'git add did not finish'))
        : host.git.output(directory, args, options)),
    };
    await expect(createCodeIn({ git: timingOut, place: unreachablePlace, temporaryDirectory: host.root }).bringCodeIn({ repository: repo, spaceId: SPACE_ID }))
      .rejects.toMatchObject({ code: 'code_transfer_failed', details: { step: 'take the snapshot', cause: 'command_timeout' } });
    await expect(host.codeIn(unreachablePlace).bringCodeIn({ repository: repo, spaceId: SPACE_ID, mode: 'neither' }))
      .rejects.toMatchObject({ code: 'invalid_snapshot_mode' });
  });

  it('asks the place for the argv before anything runs inside, so a stopped space is refused cleanly', async () => {
    const host = createTestHost();
    const { repo, g } = makeBait(host);
    const ranInside = [];
    const stopped = {
      execArgv: async () => { throw new SpaceError('space_not_running', 'Space is stopped. Start it, then try again.'); },
      exec: async (spaceId, argv) => { ranInside.push(argv); return { code: 1, stdout: '', stderr: 'container is not running' }; },
    };
    await expect(host.codeIn(stopped).bringCodeIn({ repository: repo, spaceId: SPACE_ID }))
      .rejects.toMatchObject({ code: 'code_transfer_failed', message: expect.stringMatching(/is stopped/), details: { cause: 'space_not_running' } });
    await expect(host.codeIn(stopped).sendHistory({ repository: repo, spaceId: SPACE_ID, spacePath: `/spaces/${SPACE_ID}/bait-repo-`, base: g(['rev-parse', 'HEAD']).trim() }))
      .rejects.toMatchObject({ code: 'history_transfer_failed', details: { cause: 'space_not_running' } });
    expect(ranInside).toEqual([]);
  });

  it('rejects a missing request with a SpaceError, not a TypeError', async () => {
    const host = createTestHost();
    const codeIn = host.codeIn(unreachablePlace);
    await expect(codeIn.bringCodeIn(undefined)).rejects.toMatchObject({ code: 'invalid_space_id' });
    await expect(codeIn.takeSnapshot(undefined)).rejects.toMatchObject({ code: 'invalid_space_id' });
    await expect(codeIn.removeSpaceRefs(undefined)).rejects.toMatchObject({ code: 'invalid_space_id' });
    await expect(codeIn.sendHistory(undefined)).rejects.toMatchObject({ code: 'history_transfer_failed', details: { cause: 'invalid_space_id' } });
    await expect(codeIn.sendHistory(null)).rejects.toMatchObject({ code: 'history_transfer_failed', details: { cause: 'invalid_space_id' } });
  });

  it('refuses a time limit that is not a whole number of milliseconds in range', async () => {
    const host = createTestHost();
    const { repo, g } = makeBait(host);
    const codeIn = host.codeIn(unreachablePlace);
    for (const timeoutMs of ['60000', Number.NaN, 0, 999, 1500.5, 86_400_001]) {
      await expect(codeIn.bringCodeIn({ repository: repo, spaceId: SPACE_ID, timeoutMs })).rejects.toMatchObject({ code: 'invalid_timeout' });
      await expect(codeIn.sendHistory({ repository: repo, spaceId: SPACE_ID, spacePath: `/spaces/${SPACE_ID}/bait-repo-`, base: g(['rev-parse', 'HEAD']).trim(), timeoutMs }))
        .rejects.toMatchObject({ code: 'history_transfer_failed', details: { cause: 'invalid_timeout' } });
    }
    expect(g(['for-each-ref', 'refs/openchamber/'])).toBe('');
  });

  // An inherited GIT_LITERAL_PATHSPECS would read `:(exclude,literal)<dir>` as a path, and `add` would
  // fail, and `:(attr:filter=lfs)` would match nothing.
  it('keeps working for a user whose environment sets GIT_LITERAL_PATHSPECS', async () => {
    const host = createTestHost();
    const { repo, g } = makeBait(host);
    nestRepository(host, repo, 'nested');
    fs.writeFileSync(path.join(repo, '.gitattributes'), 'model.bin filter=lfs diff=lfs merge=lfs -text\n');
    fs.writeFileSync(path.join(repo, 'model.bin'), 'weights\n');
    const git = createHostGit({ runCommand, environment: { ...host.environment, GIT_LITERAL_PATHSPECS: '1' } });
    const codeIn = createCodeIn({ git, place: null, temporaryDirectory: host.root });
    const snapshot = await codeIn.takeSnapshot({ repository: repo, spaceId: SPACE_ID, mode: 'uncommitted' });
    expect(Object.keys(readTree(g, snapshot.start)).filter((file) => file.startsWith('nested'))).toEqual([]);
    expect((await codeIn.readTransferLimits(repo)).usesLfs).toBe(true);
  });

  it('says a folder that does not exist does not exist', async () => {
    const host = createTestHost();
    await expect(host.codeIn().takeSnapshot({ repository: path.join(host.root, 'not here'), spaceId: SPACE_ID, mode: 'uncommitted' }))
      .rejects.toMatchObject({ code: 'project_folder_missing', message: expect.stringMatching(/does not exist/) });
  });

  it('gives the plain message for a git that cannot be started, and the history keeps it as its cause', async () => {
    const host = createTestHost();
    const { repo, g } = makeBait(host);
    const missing = createHostGit({ runCommand, gitPath: path.join(host.root, 'no-such-git'), environment: host.environment });
    const codeIn = createCodeIn({ git: missing, place: unreachablePlace, temporaryDirectory: host.root });
    await expect(codeIn.bringCodeIn({ repository: repo, spaceId: SPACE_ID }))
      .rejects.toMatchObject({ code: 'git_version_unreadable', details: { cause: 'command_spawn_failed' } });
    await expect(codeIn.sendHistory({ repository: repo, spaceId: SPACE_ID, spacePath: `/spaces/${SPACE_ID}/bait-repo-`, base: g(['rev-parse', 'HEAD']).trim() }))
      .rejects.toMatchObject({ code: 'history_transfer_failed', details: { cause: 'git_version_unreadable' } });
  });

  it('keeps the error of the work when the temporary folder cannot be removed, and names the folder', async () => {
    const host = createTestHost();
    const { repo, g } = makeBait(host);
    const before = hostState(repo);
    const stuck = { removeDirectory: async () => { throw Object.assign(new Error('resource busy or locked'), { code: 'EBUSY' }); } };
    const failure = await host.codeIn(unreachablePlace, stuck).bringCodeIn({ repository: repo, spaceId: SPACE_ID }).catch((error) => error);
    expect(failure).toMatchObject({ code: 'code_transfer_failed', details: { step: 'reach the space', cause: 'space_not_found' } });
    expect(failure.details.temporaryDirectoryLeft).toEqual(expect.stringContaining('openchamber-code-in-'));
    expect(g(['for-each-ref', 'refs/openchamber/'])).toBe('');
    expect(changedSince(before, repo)).toEqual([]);
    // After a call that worked, the leftover folder does not turn it into a failure.
    expect(await host.codeIn(null, stuck).listTravellingFiles(repo)).toMatchObject({ files: expect.any(Array) });
  });
});

// The receiving side of a push, standing in for `docker exec ... git receive-pack` in a real space.
// It checks that the host wrote out the fixed command, and maps /spaces/ into a local folder.
const RECEIVER = `
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const [root, behaviour, ...command] = process.argv.slice(2);
const [timeoutPath, dashS, signal, seconds, gitPath, service, target] = command;
if (command.length !== 7 || timeoutPath !== '/usr/bin/timeout' || dashS !== '-s' || signal !== 'KILL' || !/^[0-9]+$/.test(seconds)
  || gitPath !== '/usr/bin/git' || service !== 'receive-pack' || !target.startsWith('/spaces/')) {
  process.stderr.write('unexpected command ' + JSON.stringify(command) + '\\n');
  process.exit(2);
}
fs.writeFileSync(path.join(root, 'last-command.json'), JSON.stringify(command));
fs.appendFileSync(path.join(root, 'commands.log'), target + '\\n');
if (behaviour === 'refuse') { process.stderr.write('refused by the space\\n'); process.exit(1); }
if (behaviour === 'flood') {
  const chunk = 'x'.repeat(65536);
  const pump = () => { while (process.stderr.write(chunk)) {} process.stderr.once('drain', pump); };
  pump();
} else if (behaviour === 'hang') {
  const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  fs.writeFileSync(path.join(root, 'hang.pid'), String(grandchild.pid));
  setInterval(() => {}, 1000);
} else {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  const child = spawn('git', ['receive-pack', path.join(root, target)], { stdio: 'inherit', env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: ${JSON.stringify(os.devNull)} } });
  child.on('exit', (code) => process.exit(code ?? 1));
}
`;

/**
 * A stand-in place for one space in a local folder. `exec` runs the module's fixed scripts with the
 * host's `sh` and `git`, with /spaces/ mapped into the folder and a `timeout` that only drops its
 * limit, since the host may have none. `execArgv` points at RECEIVER, kept in a folder whose name has
 * a space and a percent sign, so the ext escaping is exercised through git itself.
 */
function createLocalPlace(host, behaviour = 'receive') {
  const root = path.join(host.root, 'stand in 50% place');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(path.join(root, 'spaces', SPACE_ID), { recursive: true });
  fs.mkdirSync(bin);
  const receiver = path.join(root, 'receiver.cjs');
  fs.writeFileSync(receiver, RECEIVER);
  fs.writeFileSync(path.join(bin, 'timeout'), '#!/bin/sh\nshift 3\nexec "$@"\n', { mode: 0o755 });
  const emptyConfig = path.join(root, 'inside-gitconfig');
  fs.writeFileSync(emptyConfig, '');
  const insideEnvironment = { PATH: `${bin}${path.delimiter}${process.env.PATH}`, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: emptyConfig };
  const local = (inside) => path.join(root, inside);
  return {
    root,
    local,
    inside: (args) => {
      const result = spawnSync('git', args, { env: insideEnvironment, encoding: 'utf8' });
      return { code: result.status, stdout: result.stdout };
    },
    lastCommand: () => JSON.parse(fs.readFileSync(path.join(root, 'last-command.json'), 'utf8')),
    /** How many pushes reached the history side repository. */
    historyPushes: () => (fs.existsSync(path.join(root, 'commands.log')) ? fs.readFileSync(path.join(root, 'commands.log'), 'utf8').split('\n').filter((line) => line.endsWith('.openchamber-history.git')).length : 0),
    hangPid: () => Number(fs.readFileSync(path.join(root, 'hang.pid'), 'utf8')),
    place: {
      execArgv: async (spaceId) => {
        if (spaceId !== SPACE_ID) throw new SpaceError('space_not_found', 'no such space');
        return [process.execPath, receiver, path.join(root), behaviour];
      },
      exec: async (spaceId, argv, { timeoutMs }) => {
        const [shell, flag, script, zero, ...args] = argv;
        expect([shell, flag, zero]).toEqual([IMAGE_SH, '-c', 'sh']);
        expect(script.startsWith(IMAGE_ONLY_PATH)).toBe(true);
        // Quoted: the stand-in's folder name has a space in it, which the image's own PATH never has.
        const localScript = `PATH='${insideEnvironment.PATH}';${script.slice(IMAGE_ONLY_PATH.length)}`;
        return runCommand('/bin/sh', ['-c', localScript, zero, ...args.map((arg) => (arg.startsWith('/spaces/') ? local(arg) : arg))], { env: insideEnvironment, timeoutMs });
      },
    },
  };
}

// Every hook that git on the host could run during code in, each writing a marker of its own name.
const HOOK_NAMES = ['pre-push', 'post-index-change', 'reference-transaction', 'post-checkout', 'pre-commit', 'post-commit', 'pre-auto-gc', 'post-rewrite', 'push-to-checkout', 'pre-receive', 'post-receive', 'update', 'post-update'];

describe.skipIf(WIN)('transfer into a local stand-in for a space', () => {
  it('brings the bait in as staged and unstaged changes on the same branch, with the identity, and nothing ignored', async () => {
    const host = createTestHost();
    const { repo, g } = makeBait(host);
    const local = createLocalPlace(host);
    const before = hostState(repo);
    const result = await host.codeIn(local.place).bringCodeIn({ repository: repo, spaceId: SPACE_ID, timeoutMs: 60_000 });

    expect(result.spacePath).toBe(`/spaces/${SPACE_ID}/bait-repo-`);
    expect(result.projectPath).toBe(result.spacePath);
    expect(result.identityCopied).toEqual({ name: true, email: true });
    const inside = local.local(result.spacePath);
    const gi = (args) => local.inside(['-C', inside, ...args]);
    expect(gi(['--no-optional-locks', 'status', '--porcelain=v1', '--untracked-files=all']).stdout).toBe(shortStatus(g));
    expect(gi(['symbolic-ref', 'HEAD']).stdout).toBe('refs/heads/main\n');
    expect(gi(['rev-parse', 'HEAD']).stdout.trim()).toBe(result.base);
    expect(gi(['rev-parse', '--is-shallow-repository']).stdout).toBe('true\n');
    expect(gi(['config', 'user.name']).stdout).toBe('Bait Author\n');
    expect(gi(['config', 'user.email']).stdout).toBe('bait@example.invalid\n');
    // The repository starts on the host's branch: no stray `master` in the agent's reflog.
    expect(gi(['reflog', '--format=%gs']).stdout).not.toContain('master');
    expect(fs.statSync(path.join(inside, 'run.sh')).mode & 0o111).not.toBe(0);
    for (const absent of ['.env', 'node_modules', 'secret-by-global-ignore.txt']) {
      expect(fs.existsSync(path.join(inside, absent))).toBe(false);
    }
    // The inner limit is the host's limit plus a margin, never less.
    expect(Number(local.lastCommand()[3])).toBe(65);
    expect(changedSince(before, repo)).toEqual([]);
    expect(g(['rev-parse', `refs/openchamber/spaces/${SPACE_ID}/start`]).trim()).toBe(result.start);

    expect(await host.codeIn(local.place).sendHistory({ repository: repo, spaceId: SPACE_ID, spacePath: result.spacePath, base: result.base })).toEqual({ status: 'sent' });
    expect(gi(['rev-list', '--count', 'HEAD']).stdout).toBe(g(['rev-list', '--count', 'HEAD']));
    expect(gi(['rev-parse', '--is-shallow-repository']).stdout).toBe('false\n');
    expect(fs.existsSync(local.local(`/spaces/${SPACE_ID}/.openchamber-history.git`))).toBe(false);
    expect(gi(['--no-optional-locks', 'status', '--porcelain=v1', '--untracked-files=all']).stdout).toBe(shortStatus(g));
    expect(changedSince(before, repo)).toEqual([]);
  });

  it.each([
    ['no identity', { identity: false }, '', { name: false, email: false }],
    ['a name only', { identity: false }, '[user]\n\tname = Only A Name', { name: true, email: false }],
  ])('reports which parts of the identity it copied for a user with %s, and guesses nothing', async (_, options, config, copied) => {
    const host = createTestHost(options);
    const { repo } = makeBait(host);
    if (config) host.addConfig(config);
    const local = createLocalPlace(host);
    const result = await host.codeIn(local.place).bringCodeIn({ repository: repo, spaceId: SPACE_ID, timeoutMs: 60_000 });
    expect(result.identityCopied).toEqual(copied);
    const gi = (args) => local.inside(['-C', local.local(result.spacePath), ...args]);
    expect(gi(['config', '--local', 'user.email']).code).not.toBe(0);
    expect(gi(['config', '--local', 'user.name']).stdout).toBe(copied.name ? 'Only A Name\n' : '');
  });

  it('leaves out untracked repositories, so the start and the working tree inside agree', async () => {
    const host = createTestHost();
    const { repo, g } = makeBait(host);
    nestRepository(host, repo, 'nested');
    nestRepository(host, repo, ODD_NAME, { commit: false });
    const local = createLocalPlace(host);
    const result = await host.codeIn(local.place).bringCodeIn({ repository: repo, spaceId: SPACE_ID, timeoutMs: 60_000 });
    const inside = local.local(result.spacePath);
    // What the space's working tree holds, as a tree, the way a 3b snapshot inside would see it.
    const index = path.join(local.root, 'agree-index');
    const withIndex = (args) => spawnSync('git', ['-C', inside, ...args], { env: { ...process.env, GIT_INDEX_FILE: index, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull }, encoding: 'utf8' });
    withIndex(['read-tree', 'refs/openchamber/start']);
    withIndex(['add', '--all']);
    expect(withIndex(['write-tree']).stdout.trim()).toBe(g(['rev-parse', `${result.start}^{tree}`]).trim());
    expect(fs.existsSync(path.join(inside, 'nested'))).toBe(false);
  });

  it('runs none of the user\'s hooks on the host, in the snapshot, the ref writes, the pushes or the history', async () => {
    const host = createTestHost();
    const hooks = path.join(host.root, 'global hooks');
    const markers = path.join(host.root, 'markers');
    fs.mkdirSync(hooks);
    fs.mkdirSync(markers);
    for (const name of HOOK_NAMES) {
      fs.writeFileSync(path.join(hooks, name), `#!/bin/sh\ntouch '${markers}/${name}'\ncat > /dev/null 2>&1 || true\n`, { mode: 0o755 });
    }
    host.addConfig(`[core]\n\thooksPath = ${forConfig(hooks)}`);
    const { repo, g } = makeBait(host);

    // The control, in a copy: with this config, an index write, a ref write and a push run the hooks.
    const control = makeBait(host, { name: 'control' });
    control.g(['add', 'untracked plain.txt']);
    control.g(['update-ref', 'refs/heads/control', 'HEAD']);
    const bare = path.join(host.root, 'control.git');
    host.sh(host.root, ['init', '--quiet', '--bare', bare]);
    control.g(['push', '--quiet', bare, 'HEAD:refs/heads/control']);
    expect(fs.readdirSync(markers).sort()).toEqual(expect.arrayContaining(['post-index-change', 'pre-push', 'reference-transaction']));
    for (const marker of fs.readdirSync(markers)) fs.rmSync(path.join(markers, marker));

    const codeIn = host.codeIn(createLocalPlace(host).place);
    const result = await codeIn.bringCodeIn({ repository: repo, spaceId: SPACE_ID, timeoutMs: 60_000 });
    await codeIn.sendHistory({ repository: repo, spaceId: SPACE_ID, spacePath: result.spacePath, base: result.base });
    await codeIn.listTravellingFiles(repo);
    await codeIn.readTransferLimits(repo);
    await codeIn.removeSpaceRefs({ repository: repo, spaceId: SPACE_ID });
    expect(fs.readdirSync(markers)).toEqual([]);
    expect(g(['for-each-ref', 'refs/openchamber/'])).toBe('');
  });

  /** A whole code in, the history, both lists and the ref removal, for the tests that watch what it starts. */
  const everything = async (host, repo) => {
    const codeIn = host.codeIn(createLocalPlace(host).place);
    const result = await codeIn.bringCodeIn({ repository: repo, spaceId: SPACE_ID, timeoutMs: 60_000 });
    await codeIn.sendHistory({ repository: repo, spaceId: SPACE_ID, spacePath: result.spacePath, base: result.base });
    await codeIn.listTravellingFiles(repo);
    await codeIn.readTransferLimits(repo);
    await codeIn.removeSpaceRefs({ repository: repo, spaceId: SPACE_ID });
  };

  it('runs no fsmonitor program of the user\'s', async () => {
    const host = createTestHost();
    const marker = path.join(host.root, 'fsmonitor-ran');
    const program = path.join(host.root, 'fsmonitor.sh');
    fs.writeFileSync(program, `#!/bin/sh\necho "$GIT_INDEX_FILE" >> '${marker}'\nexit 1\n`, { mode: 0o755 });
    host.addConfig(`[core]\n\tfsmonitor = ${forConfig(program)}`);
    const { repo } = makeBait(host);
    // The control, in a copy: with this config a status runs the program.
    const control = makeBait(host, { name: 'control' });
    control.g(['status', '--porcelain']);
    expect(fs.existsSync(marker)).toBe(true);
    fs.rmSync(marker);
    const before = hostState(repo);

    await everything(host, repo);
    expect(fs.existsSync(marker)).toBe(false);
    expect(changedSince(before, repo)).toEqual([]);
  });

  // The built-in daemon exists on macOS and Windows builds of git, not on Linux.
  it.skipIf(process.platform === 'linux')('starts no fsmonitor daemon for a user with core.fsmonitor=true, and leaves none of its files', async () => {
    const host = createTestHost();
    host.addConfig('[core]\n\tfsmonitor = true');
    const { repo } = makeBait(host);
    const control = makeBait(host, { name: 'control' });
    const daemonRuns = (directory) => spawnSync('git', ['-C', directory, 'fsmonitor--daemon', 'status'], { env: host.environment, windowsHide: true }).status === 0;
    const stop = (directory) => spawnSync('git', ['-C', directory, 'fsmonitor--daemon', 'stop'], { env: host.environment, windowsHide: true });
    try {
      // The control: with this config a status starts the daemon.
      control.g(['status', '--porcelain']);
      expect(daemonRuns(control.repo)).toBe(true);
      const before = hostState(repo);
      await everything(host, repo);
      expect(daemonRuns(repo)).toBe(false);
      expect(changedSince(before, repo)).toEqual([]);
    } finally {
      stop(control.repo);
      stop(repo);
    }
  });

  // None of our commands runs `gc --auto` or maintenance, which git starts after commit, merge,
  // fetch, am and rebase. A gc here would repack, and the comparison would see a new pack.
  it('starts no automatic gc or maintenance, even for a user who asks for them at every chance', async () => {
    const host = createTestHost();
    // Two packs, one more than `gc.autoPackLimit` allows below, so any `gc --auto` consolidates them.
    const packs = (repo) => fs.readdirSync(path.join(repo, '.git', 'objects', 'pack')).filter((file) => file.endsWith('.pack')).length;
    const twoPacks = ({ repo, g }) => {
      g(['repack', '-q', '-d']);
      g(['commit', '--quiet', '--allow-empty', '-m', 'a second pack']);
      g(['repack', '-q', '-d']);
      expect(packs(repo)).toBe(2);
    };
    const bait = makeBait(host);
    const control = makeBait(host, { name: 'control' });
    twoPacks(bait);
    twoPacks(control);
    // Everything in the foreground and pinned to the gc task. A detached gc or maintenance would
    // consolidate the packs after the test looked, and the control and the main assertion alike would
    // look too early; measured in CI with git 2.55.0, the control saw two packs. Newer git also knows
    // other maintenance strategies, so the strategy and the task are named rather than left to a default.
    host.addConfig([
      '[gc]', '\tauto = 1', '\tautoDetach = false', '\tautoPackLimit = 1',
      '[maintenance]', '\tauto = true', '\tautoDetach = false', '\tstrategy = gc',
      '[maintenance "gc"]', '\tenabled = true',
    ].join('\n'));
    // The control, in the copy: with this config an ordinary commit consolidates the packs. Plain
    // git here, not `control.g`: the setup git opts out of maintenance, which is what the control proves.
    const commit = spawnSync('git', ['-C', control.repo, 'commit', '--quiet', '--allow-empty', '-m', 'control'], { env: host.environment, encoding: 'utf8', windowsHide: true });
    expect(commit.status, commit.stderr).toBe(0);
    expect(packs(control.repo)).toBe(1);
    const before = hostState(bait.repo);
    await everything(host, bait.repo);
    expect(packs(bait.repo)).toBe(2);
    expect(changedSince(before, bait.repo)).toEqual([]);
  });

  it('sends the history into the path code in returned, even after the host folder was renamed', async () => {
    const host = createTestHost();
    const { repo } = makeBait(host);
    const local = createLocalPlace(host);
    const codeIn = host.codeIn(local.place);
    const result = await codeIn.bringCodeIn({ repository: repo, spaceId: SPACE_ID, timeoutMs: 60_000 });
    const renamed = path.join(host.root, 'renamed checkout');
    fs.renameSync(repo, renamed);
    expect(await codeIn.sendHistory({ repository: renamed, spaceId: SPACE_ID, spacePath: result.spacePath, base: result.base })).toEqual({ status: 'sent' });
    expect(local.inside(['-C', local.local(result.spacePath), 'rev-parse', '--is-shallow-repository']).stdout).toBe('false\n');
  });

  it('shares one run between calls for the same space, and sends nothing again once the history is there', async () => {
    const host = createTestHost();
    const { repo, g } = makeBait(host);
    const local = createLocalPlace(host);
    const codeIn = host.codeIn(local.place);
    const result = await codeIn.bringCodeIn({ repository: repo, spaceId: SPACE_ID, timeoutMs: 60_000 });
    const request = { repository: repo, spaceId: SPACE_ID, spacePath: result.spacePath, base: result.base };
    // A retry while the first run is still going: the side repository is one per space.
    expect(await Promise.all([codeIn.sendHistory(request), codeIn.sendHistory(request)])).toEqual([{ status: 'sent' }, { status: 'sent' }]);
    expect(local.historyPushes()).toBe(1);
    // Afterwards the repository is complete, and a call says so and pushes nothing.
    expect(await codeIn.sendHistory(request)).toEqual({ status: 'already_complete' });
    expect(local.historyPushes()).toBe(1);
    expect(local.inside(['-C', local.local(result.spacePath), 'rev-list', '--count', 'HEAD']).stdout).toBe(g(['rev-list', '--count', 'HEAD']));
  });

  it('checks each call before it joins a run, refuses one that asks for something else, and shares across instances', async () => {
    const host = createTestHost();
    const { repo, g } = makeBait(host);
    const local = createLocalPlace(host);
    const first = host.codeIn(local.place);
    const second = host.codeIn(local.place);
    const result = await first.bringCodeIn({ repository: repo, spaceId: SPACE_ID, timeoutMs: 60_000 });
    const request = { repository: repo, spaceId: SPACE_ID, spacePath: result.spacePath, base: result.base };
    const running = first.sendHistory(request);
    const joined = second.sendHistory(request);
    const badPath = second.sendHistory({ ...request, spacePath: '/elsewhere', base: 'not a commit' }).catch((error) => error);
    const otherPath = second.sendHistory({ ...request, spacePath: `/spaces/${SPACE_ID}/other` }).catch((error) => error);
    const otherBase = second.sendHistory({ ...request, base: g(['rev-parse', 'HEAD~1']).trim() }).catch((error) => error);
    const otherCheckout = second.sendHistory({ ...request, repository: path.join(host.root, 'another checkout') }).catch((error) => error);
    expect(await Promise.all([running, joined])).toEqual([{ status: 'sent' }, { status: 'sent' }]);
    expect(local.historyPushes()).toBe(1);
    expect(await badPath).toMatchObject({ code: 'history_transfer_failed', details: { step: 'check the request', cause: 'invalid_space_path' } });
    expect(await otherPath).toMatchObject({ code: 'history_transfer_failed', details: { cause: 'history_in_progress' } });
    expect(await otherBase).toMatchObject({ code: 'history_transfer_failed', details: { cause: 'history_in_progress' } });
    expect(await otherCheckout).toMatchObject({ code: 'history_transfer_failed', details: { cause: 'history_in_progress' } });
  });

  it('puts the margin it is given between the host limit and the limit inside, and refuses one that is not a length', async () => {
    const host = createTestHost();
    const { repo, g } = makeBait(host);
    const local = createLocalPlace(host);
    const codeIn = host.codeIn(local.place);
    const result = await codeIn.bringCodeIn({ repository: repo, spaceId: SPACE_ID, timeoutMs: 60_000, innerMarginSeconds: 9 });
    expect(Number(local.lastCommand()[3])).toBe(69);
    for (const innerMarginSeconds of [0, -1, 1.5, 3601, '9']) {
      await expect(codeIn.bringCodeIn({ repository: repo, spaceId: OTHER_SPACE_ID, innerMarginSeconds })).rejects.toMatchObject({ code: 'invalid_inner_margin' });
      await expect(codeIn.sendHistory({ repository: repo, spaceId: SPACE_ID, spacePath: result.spacePath, base: result.base, innerMarginSeconds }))
        .rejects.toMatchObject({ code: 'history_transfer_failed', details: { cause: 'invalid_inner_margin' } });
    }
    expect(g(['for-each-ref', `refs/openchamber/spaces/${OTHER_SPACE_ID}/`])).toBe('');
  });

  it('brings a SHA-256 repository into a SHA-256 repository', async () => {
    const host = createTestHost();
    const { repo, g } = makeBait(host, { objectFormat: 'sha256' });
    const local = createLocalPlace(host);
    const result = await host.codeIn(local.place).bringCodeIn({ repository: repo, spaceId: SPACE_ID, timeoutMs: 60_000 });
    const gi = (args) => local.inside(['-C', local.local(result.spacePath), ...args]);
    expect(gi(['rev-parse', '--show-object-format']).stdout).toBe('sha256\n');
    expect(gi(['--no-optional-locks', 'status', '--porcelain=v1', '--untracked-files=all']).stdout).toBe(shortStatus(g));
  });

  it('brings a linked worktree in with its own branch, and a detached HEAD as a detached HEAD', async () => {
    const host = createTestHost();
    const { repo, g } = makeBait(host);
    const worktree = path.join(host.root, 'linked');
    g(['worktree', 'add', '--quiet', '-b', 'feature', worktree]);
    fs.writeFileSync(path.join(worktree, 'feature.txt'), 'feature\n');
    const local = createLocalPlace(host);
    const result = await host.codeIn(local.place).bringCodeIn({ repository: worktree, spaceId: SPACE_ID, timeoutMs: 60_000 });
    const gi = (args) => local.inside(['-C', local.local(result.spacePath), ...args]);
    expect(result.spacePath).toBe(`/spaces/${SPACE_ID}/linked`);
    expect(gi(['symbolic-ref', 'HEAD']).stdout).toBe('refs/heads/feature\n');
    expect(gi(['--no-optional-locks', 'status', '--porcelain=v1', '--untracked-files=all']).stdout).toBe(shortStatus((args) => host.sh(worktree, args)));

    const detachedHost = createTestHost();
    const detached = makeBait(detachedHost);
    detached.g(['checkout', '--quiet', '--detach']);
    const detachedLocal = createLocalPlace(detachedHost);
    const detachedResult = await detachedHost.codeIn(detachedLocal.place).bringCodeIn({ repository: detached.repo, spaceId: SPACE_ID, timeoutMs: 60_000 });
    const detachedInside = detachedLocal.inside(['-C', detachedLocal.local(detachedResult.spacePath), 'symbolic-ref', '--quiet', 'HEAD']);
    expect(detachedInside.code).not.toBe(0);
  });

  it.each([
    ['refuses', 'refuse', null, 'refused by the space'],
    ['prints far more than a push does', 'flood', 'command_output_too_large', ''],
  ])('leaves the host repository as it was and removes its ref when the space %s', async (_, behaviour, cause, printed) => {
    const host = createTestHost();
    const { repo, g } = makeBait(host);
    const local = createLocalPlace(host, behaviour);
    const before = hostState(repo);
    const failure = await host.codeIn(local.place).bringCodeIn({ repository: repo, spaceId: SPACE_ID, timeoutMs: 20_000 }).catch((error) => error);
    expect(failure).toMatchObject({ code: 'code_transfer_failed', details: { step: 'the base commit', cause } });
    // The receiving side really ran, with the command the host wrote out, and did what it was set to.
    expect(local.lastCommand().slice(4)).toEqual(['/usr/bin/git', 'receive-pack', `/spaces/${SPACE_ID}/bait-repo-`]);
    expect(failure.message).toContain(printed);
    expect(g(['for-each-ref', 'refs/openchamber/'])).toBe('');
    expect(changedSince(before, repo)).toEqual([]);
  });

  it('ends a space that never answers at the host timeout, and leaves no host process behind', async () => {
    const host = createTestHost();
    const { repo, g } = makeBait(host);
    const local = createLocalPlace(host, 'hang');
    const before = hostState(repo);
    const failure = await host.codeIn(local.place).bringCodeIn({ repository: repo, spaceId: SPACE_ID, timeoutMs: 3000 }).catch((error) => error);
    expect(failure).toMatchObject({ code: 'code_transfer_failed', details: { cause: 'command_timeout' } });
    const pid = local.hangPid();
    expect(Number.isInteger(pid) && pid > 1).toBe(true);
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let attempt = 0; attempt < 50 && alive(); attempt += 1) {
      await new Promise((resolve) => { setTimeout(resolve, 100); });
    }
    const survived = alive();
    if (survived) process.kill(pid, 'SIGKILL');
    expect(survived).toBe(false);
    expect(g(['for-each-ref', 'refs/openchamber/'])).toBe('');
    expect(changedSince(before, repo)).toEqual([]);
  });

  it('refuses a project path that is already taken inside, says what to do, keeps what is there, and changes nothing on the host', async () => {
    const host = createTestHost();
    const { repo, g } = makeBait(host);
    const local = createLocalPlace(host);
    const taken = local.local(`/spaces/${SPACE_ID}/bait-repo-`);
    fs.mkdirSync(taken);
    fs.writeFileSync(path.join(taken, 'keep.txt'), 'keep\n');
    const before = hostState(repo);
    const failure = await host.codeIn(local.place).bringCodeIn({ repository: repo, spaceId: SPACE_ID, timeoutMs: 20_000 }).catch((error) => error);
    expect(failure).toMatchObject({ code: 'space_path_in_use' });
    expect(failure.message).toMatch(/remove this space and create a new one/);
    expect(fs.readFileSync(path.join(taken, 'keep.txt'), 'utf8')).toBe('keep\n');
    expect(g(['for-each-ref', 'refs/openchamber/'])).toBe('');
    expect(changedSince(before, repo)).toEqual([]);
  });

  it('reports a failure inside the history with its cause, removes the side repository, and changes nothing on the host', async () => {
    const host = createTestHost();
    const { repo } = makeBait(host);
    const local = createLocalPlace(host);
    const codeIn = host.codeIn(local.place);
    const result = await codeIn.bringCodeIn({ repository: repo, spaceId: SPACE_ID, timeoutMs: 60_000 });
    // Something inside holds the lock that the unshallow needs.
    fs.writeFileSync(path.join(local.local(result.spacePath), '.git', 'shallow.lock'), '');
    const before = hostState(repo);
    const failure = await codeIn.sendHistory({ repository: repo, spaceId: SPACE_ID, spacePath: result.spacePath, base: result.base, timeoutMs: 20_000 }).catch((error) => error);
    expect(failure).toMatchObject({ code: 'history_transfer_failed', details: { step: 'take the history into the repository', cause: 'inside_command_failed' } });
    expect(fs.existsSync(local.local(`/spaces/${SPACE_ID}/.openchamber-history.git`))).toBe(false);
    expect(changedSince(before, repo)).toEqual([]);
  });
});
