// Code out, with real host git in temporary directories and no Docker. The apply tests run on every
// platform against a result made on the host; the transfer tests run against the stand-in space of
// code-in-bait.js, which runs its scripts with a POSIX `sh`. The live file under places/ proves the
// same path out of a real space.

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { blob, createLocalPlace, createTestHost, forConfig, hostState, makeBait, removeTestHosts, unexpectedChanges } from './code-in-bait.js';
import { createCodeOut, firstRedirectedFolder, nameNotAllowedHere } from './code-out.js';
import { SpaceError } from './errors.js';

const WIN = process.platform === 'win32';
const SPACE_ID = 'a1b2c3d4e5f6';
const OTHER_SPACE_ID = 'f6e5d4c3b2a1';
const START = `refs/openchamber/spaces/${SPACE_ID}/start`;
const RESULT = `refs/openchamber/spaces/${SPACE_ID}/result`;
const APPLIED = `refs/openchamber/spaces/${SPACE_ID}/applied`;
const CLOSED = `refs/openchamber/spaces/${SPACE_ID}/changes-closed`;
const APPLYING = `refs/openchamber/spaces/${SPACE_ID}/applying`;
// What a refused apply writes, and the only thing it writes: from then on the space is a branch.
const CLOSURE = [`.git/refs/openchamber/spaces/${SPACE_ID}/changes-closed`];

afterAll(removeTestHosts);

/** What changed in a repository folder since `before`, apart from what code in and code out write by design for this space. */
const changedSince = (before, directory) => unexpectedChanges(before, hostState(directory), { spaceIds: [SPACE_ID], codeOut: true });
/** What changed at all, with no allowance: nothing of the space reached the repository. */
const anyChangeSince = (before, directory) => unexpectedChanges(before, hostState(directory), { spaceIds: [] });
/** The part of a host state under `.git`. */
const gitOnly = (state) => Object.fromEntries(Object.entries(state).filter(([name]) => name === '.git' || name.startsWith('.git/')));
/** Temporary folders code out left in the test host's root. */
const leftFolders = (host) => fs.readdirSync(host.root).filter((name) => name.startsWith('openchamber-code-out-'));

/** The tree the working tree of `directory` holds, starting from `treeish`, without touching its index. */
const workingTreeAs = (host, directory, treeish) => {
  const index = path.join(host.root, `tree-index-${crypto.randomBytes(4).toString('hex')}`);
  const env = { ...host.environment, GIT_INDEX_FILE: index };
  const git = (args) => {
    const result = spawnSync('git', ['-C', directory, ...args], { env, encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };
  try {
    git(['read-tree', treeish]);
    git(['add', '--all']);
    return git(['write-tree']);
  } finally {
    fs.rmSync(index, { force: true });
  }
};

/**
 * A result made on the host, for the apply tests on every platform: the start snapshot of the space
 * from code in, then `edit` applied to a scratch checkout of it, committed and fetched into the
 * repository as the space's result ref. Everything here happens before the test looks.
 */
const hostResult = async (host, { objectFormat = 'sha1', edit, prepare } = {}) => {
  const bait = makeBait(host, { objectFormat });
  prepare?.(bait);
  const snapshot = await host.codeIn().takeSnapshot({ repository: bait.repo, spaceId: SPACE_ID, mode: 'uncommitted' });
  const scratch = path.join(host.root, `scratch-${crypto.randomBytes(4).toString('hex')}`);
  host.sh(host.root, ['init', '--quiet', `--object-format=${objectFormat}`, scratch]);
  const s = (args, options) => host.sh(scratch, args, options);
  s(['fetch', '--quiet', '--no-write-fetch-head', bait.repo, `${START}:refs/heads/work`]);
  s(['checkout', '--quiet', 'work']);
  edit?.(scratch, s);
  s(['add', '--all']);
  s(['commit', '--quiet', '--allow-empty', '-m', 'the agent']);
  bait.g(['fetch', '--quiet', '--no-write-fetch-head', scratch, `refs/heads/work:${RESULT}`]);
  return { ...bait, snapshot, result: bait.g(['rev-parse', RESULT]).trim() };
};

const ordinaryEdit = (scratch, s) => {
  fs.writeFileSync(path.join(scratch, 'tracked-to-edit.txt'), 'one\ntwo staged\nthree unstaged\nfour from the space\n');
  fs.writeFileSync(path.join(scratch, 'added by the space.txt'), 'new\n');
  fs.writeFileSync(path.join(scratch, 'binary.bin'), Buffer.from([0, 1, 2, 255, 0, 10, 13, 0]));
  fs.rmSync(path.join(scratch, 'README.md'));
  fs.writeFileSync(path.join(scratch, 'tool.sh'), '#!/bin/sh\necho tool\n');
  if (!WIN) fs.chmodSync(path.join(scratch, 'tool.sh'), 0o755);
  s(['add', 'tool.sh']);
  s(['update-index', '--chmod=+x', 'tool.sh']);
  if (!WIN) fs.symlinkSync('/etc/passwd', path.join(scratch, 'link-outside'));
};

describe('unexpectedChanges for code out', () => {
  it('allows a new pack and the result ref of this space only with codeOut, and moves of the result ref', () => {
    const host = createTestHost();
    const { repo, g } = makeBait(host);
    g(['update-ref', RESULT, 'HEAD~1']);
    g(['update-ref', APPLIED, 'HEAD~1']);
    g(['update-ref', CLOSED, 'HEAD~1']);
    g(['update-ref', APPLYING, 'HEAD~1']);
    const before = hostState(repo);
    g(['repack', '-q', '-n']);
    g(['update-ref', RESULT, 'HEAD']);
    g(['update-ref', APPLIED, 'HEAD']);
    g(['update-ref', CLOSED, 'HEAD']);
    g(['update-ref', APPLYING, 'HEAD']);
    const added = Object.keys(hostState(repo)).filter((name) => /^\.git\/objects\/pack\/pack-/.test(name) && before[name] === undefined);
    expect(added.length).toBeGreaterThan(0);
    expect(changedSince(before, repo)).toEqual([]);
    // Without the code out allowance, the same changes all show.
    expect(unexpectedChanges(before, hostState(repo), { spaceIds: [SPACE_ID] }))
      .toEqual([...added, ...['applied', 'applying', 'changes-closed', 'result'].map((name) => `.git/refs/openchamber/spaces/${SPACE_ID}/${name}`)].sort());
  });

  it.each([
    ['the result ref of another space', (repo, g) => g(['update-ref', `refs/openchamber/spaces/${OTHER_SPACE_ID}/result`, 'HEAD']), `.git/refs/openchamber/spaces/${OTHER_SPACE_ID}/result`],
    ['a branch', (repo, g) => g(['update-ref', 'refs/heads/from-the-space', 'HEAD']), '.git/refs/heads/from-the-space'],
    ['FETCH_HEAD', (repo) => fs.writeFileSync(path.join(repo, '.git', 'FETCH_HEAD'), 'x\n'), '.git/FETCH_HEAD'],
    ['a shallow file', (repo) => fs.writeFileSync(path.join(repo, '.git', 'shallow'), 'x\n'), '.git/shallow'],
    ['a commit graph', (repo) => fs.writeFileSync(path.join(repo, '.git', 'objects', 'info', 'commit-graph'), 'x'), '.git/objects/info/commit-graph'],
    ['a pack rewritten', (repo) => {
      const pack = fs.readdirSync(path.join(repo, '.git', 'objects', 'pack')).find((name) => name.endsWith('.pack'));
      fs.chmodSync(path.join(repo, '.git', 'objects', 'pack', pack), 0o644);
      fs.appendFileSync(path.join(repo, '.git', 'objects', 'pack', pack), 'x');
    }, null],
    ['a changed working tree file', (repo) => fs.writeFileSync(path.join(repo, 'README.md'), 'changed\n'), 'README.md'],
  ])('still sees %s', (_, change, expectedPath) => {
    const host = createTestHost();
    const { repo, g } = makeBait(host);
    g(['repack', '-q', '-n']);
    const before = hostState(repo);
    change(repo, g);
    const changed = changedSince(before, repo);
    expect(changed.length).toBeGreaterThan(0);
    if (expectedPath !== null) expect(changed).toContain(expectedPath);
  });
});

describe('applyAsChanges', () => {
  it('writes exactly the result into the working tree, and leaves the index, HEAD and .git alone', async () => {
    const host = createTestHost();
    const { repo, g, result } = await hostResult(host, { edit: ordinaryEdit });
    const head = g(['rev-parse', 'HEAD']).trim();
    const before = hostState(repo);
    expect(await host.codeOut().applyAsChanges({ repository: repo, spaceId: SPACE_ID })).toEqual({
      status: 'applied', appliedPaths: WIN ? 5 : 6, remembered: true, nestedRepositories: { count: 0, paths: [] }, conflicted: { count: 0, paths: [] },
    });
    expect(workingTreeAs(host, repo, result)).toBe(g(['rev-parse', `${result}^{tree}`]).trim());
    if (!WIN) {
      expect(fs.statSync(path.join(repo, 'tool.sh')).mode & 0o111).not.toBe(0);
      expect(fs.readlinkSync(path.join(repo, 'link-outside'))).toBe('/etc/passwd');
    }
    expect(fs.existsSync(path.join(repo, 'README.md'))).toBe(false);
    expect(g(['rev-parse', 'HEAD']).trim()).toBe(head);
    // Nothing in `.git` but the ref that remembers what was applied.
    expect(unexpectedChanges(gitOnly(before), gitOnly(hostState(repo)), { spaceIds: [SPACE_ID], codeOut: true })).toEqual([]);
    expect(unexpectedChanges(gitOnly(before), gitOnly(hostState(repo)))).toEqual([`.git/refs/openchamber/spaces/${SPACE_ID}/applied`]);
    expect(leftFolders(host)).toEqual([]);
  });

  it('says there is nothing to apply when the space changed nothing, and changes nothing', async () => {
    const host = createTestHost();
    const { repo } = await hostResult(host);
    const before = hostState(repo);
    expect(await host.codeOut().applyAsChanges({ repository: repo, spaceId: SPACE_ID })).toEqual({ status: 'nothing_to_apply' });
    expect(anyChangeSince(before, repo)).toEqual([]);
  });

  it.each([
    ['the user edited the same line since', (repo) => fs.writeFileSync(path.join(repo, 'tracked-to-edit.txt'), 'one\ntwo staged\nthree changed on the host\n')],
    ['the user has an untracked file where the space adds one', (repo) => fs.writeFileSync(path.join(repo, 'added by the space.txt'), 'mine\n')],
    ['the user deleted a file the space changes', (repo) => fs.rmSync(path.join(repo, 'tracked-to-edit.txt'))],
  ])('touches nothing and offers the branch when %s', async (_, userChange) => {
    const host = createTestHost();
    const { repo } = await hostResult(host, { edit: ordinaryEdit });
    userChange(repo);
    const before = hostState(repo);
    const failure = await host.codeOut().applyAsChanges({ repository: repo, spaceId: SPACE_ID }).catch((error) => error);
    expect(failure).toMatchObject({ code: 'changes_do_not_apply' });
    expect(failure.message).toMatch(/nothing was changed now/);
    expect(failure.message).toMatch(/since the space was made/);
    expect(failure.message).toMatch(/applied as a branch/);
    expect(anyChangeSince(before, repo)).toEqual(CLOSURE);
    expect(leftFolders(host)).toEqual([]);
  });

  it('refuses without a result or a start, and changes nothing', async () => {
    const host = createTestHost();
    const { repo, g } = makeBait(host);
    const before = hostState(repo);
    await expect(host.codeOut().applyAsChanges({ repository: repo, spaceId: SPACE_ID })).rejects.toMatchObject({ code: 'space_start_missing' });
    g(['update-ref', START, 'HEAD']);
    await expect(host.codeOut().applyAsChanges({ repository: repo, spaceId: SPACE_ID })).rejects.toMatchObject({ code: 'result_missing' });
    await expect(host.codeOut().applyAsChanges(undefined)).rejects.toMatchObject({ code: 'invalid_space_id' });
    expect(unexpectedChanges(before, hostState(repo), { spaceIds: [SPACE_ID] })).toEqual([]);
  });

  // The user's own git config broke the obvious commands in the maintainer's probe. Each case first
  // shows the obvious command failing with that config, then code out working with it.
  const whitespaceEdit = (scratch) => fs.writeFileSync(path.join(scratch, 'tracked-to-edit.txt'), 'one\ntwo staged\nthree unstaged\ntrailing spaces   \n');

  it('applies the exact bytes for a user with apply.whitespace=fix, which silently changes them otherwise', async () => {
    const host = createTestHost();
    const { repo, g, snapshot, result } = await hostResult(host, { edit: whitespaceEdit });
    host.addConfig('[apply]\n\twhitespace = fix');
    // The control, in a copy: a plain apply of the same patch strips the trailing spaces and says nothing.
    const control = makeBait(host, { name: 'control' });
    const patch = path.join(host.root, 'control.patch');
    g(['diff-tree', '-p', '--binary', `--output=${forConfig(patch)}`, snapshot.start, result]);
    control.g(['apply', forConfig(patch)]);
    expect(fs.readFileSync(path.join(control.repo, 'tracked-to-edit.txt'), 'utf8')).toContain('trailing spaces\n');

    await host.codeOut().applyAsChanges({ repository: repo, spaceId: SPACE_ID });
    expect(fs.readFileSync(path.join(repo, 'tracked-to-edit.txt'), 'utf8')).toContain('trailing spaces   \n');
    expect(workingTreeAs(host, repo, result)).toBe(g(['rev-parse', `${result}^{tree}`]).trim());
  });

  it('applies for a user with apply.whitespace=error, which refuses otherwise', async () => {
    const host = createTestHost();
    const { repo, g, snapshot, result } = await hostResult(host, { edit: whitespaceEdit });
    host.addConfig('[apply]\n\twhitespace = error');
    const patch = path.join(host.root, 'control.patch');
    g(['diff-tree', '-p', '--binary', `--output=${forConfig(patch)}`, snapshot.start, result]);
    expect(spawnSync('git', ['-C', repo, 'apply', '--check', forConfig(patch)], { env: host.environment, windowsHide: true }).status).not.toBe(0);

    expect(await host.codeOut().applyAsChanges({ repository: repo, spaceId: SPACE_ID })).toMatchObject({ status: 'applied' });
    expect(workingTreeAs(host, repo, result)).toBe(g(['rev-parse', `${result}^{tree}`]).trim());
  });

  it('respects every whitespace difference for a user with apply.ignoreWhitespace=change', async () => {
    const host = createTestHost();
    const { repo, g, snapshot, result } = await hostResult(host, { edit: whitespaceEdit });
    host.addConfig('[apply]\n\tignoreWhitespace = change');
    // The user changed the whitespace of a line the patch has as context.
    fs.writeFileSync(path.join(repo, 'tracked-to-edit.txt'), 'one\ntwo  staged\nthree unstaged\n');
    const patch = path.join(host.root, 'control.patch');
    g(['diff-tree', '-p', '--binary', `--output=${forConfig(patch)}`, snapshot.start, result]);
    // The control: with that config the patch lands on a line it does not match.
    expect(spawnSync('git', ['-C', repo, 'apply', '--check', forConfig(patch)], { env: host.environment, windowsHide: true }).status).toBe(0);
    const before = hostState(repo);
    await expect(host.codeOut().applyAsChanges({ repository: repo, spaceId: SPACE_ID })).rejects.toMatchObject({ code: 'changes_do_not_apply' });
    expect(anyChangeSince(before, repo)).toEqual(CLOSURE);
  });

  it('builds a patch that applies for a user with diff.noprefix, where the porcelain diff does not', async () => {
    const host = createTestHost();
    const { repo, g, snapshot, result } = await hostResult(host, { edit: ordinaryEdit });
    host.addConfig('[diff]\n\tnoprefix = true');
    const control = makeBait(host, { name: 'control' });
    const patch = path.join(host.root, 'control.patch');
    g(['diff', '--binary', `--output=${forConfig(patch)}`, snapshot.start, result]);
    expect(spawnSync('git', ['-C', control.repo, 'apply', '--check', forConfig(patch)], { env: host.environment, windowsHide: true }).status).not.toBe(0);

    await host.codeOut().applyAsChanges({ repository: repo, spaceId: SPACE_ID });
    expect(workingTreeAs(host, repo, result)).toBe(g(['rev-parse', `${result}^{tree}`]).trim());
  });

  it('applies the whole result from a project subfolder for a user with diff.relative, where the porcelain diff loses paths', async () => {
    const host = createTestHost();
    const { repo, g, snapshot, result } = await hostResult(host, {
      edit: (scratch) => {
        fs.mkdirSync(path.join(scratch, 'packages', 'app'), { recursive: true });
        fs.writeFileSync(path.join(scratch, 'packages', 'app', 'index.js'), 'app\n');
        fs.writeFileSync(path.join(scratch, 'top-level.txt'), 'outside the subfolder\n');
      },
    });
    fs.mkdirSync(path.join(repo, 'packages', 'app'), { recursive: true });
    host.addConfig('[diff]\n\trelative = true');
    const subfolder = path.join(repo, 'packages');
    const porcelain = host.sh(subfolder, ['diff', '--name-only', snapshot.start, result]);
    expect(porcelain).not.toContain('top-level.txt');

    await host.codeOut().applyAsChanges({ repository: subfolder, spaceId: SPACE_ID });
    expect(fs.readFileSync(path.join(repo, 'top-level.txt'), 'utf8')).toBe('outside the subfolder\n');
    expect(workingTreeAs(host, repo, result)).toBe(g(['rev-parse', `${result}^{tree}`]).trim());
  });

  it('works in a SHA-256 repository', async () => {
    const host = createTestHost();
    const { repo, g, result } = await hostResult(host, { objectFormat: 'sha256', edit: ordinaryEdit });
    expect(result).toMatch(/^[0-9a-f]{64}$/);
    await host.codeOut().applyAsChanges({ repository: repo, spaceId: SPACE_ID });
    expect(workingTreeAs(host, repo, result)).toBe(g(['rev-parse', `${result}^{tree}`]).trim());
  });

  // Git must not be trusted with this. Measured on Windows 11 with Git for Windows 2.54: `git apply`
  // wrote through a directory junction into the folder it points at, where git on POSIX refuses. The
  // host looks at every folder on the way itself, and the test builds a junction on Windows.
  it.each([
    ['a file the space adds under it', (scratch) => {
      fs.mkdirSync(path.join(scratch, 'cache'));
      fs.writeFileSync(path.join(scratch, 'cache', 'planted.txt'), 'through the link\n');
    }, null],
    ['a file the space deletes under it', (scratch) => fs.rmSync(path.join(scratch, 'cache', 'kept.txt')), 'kept.txt'],
    ['a folder several levels under it', (scratch) => {
      fs.mkdirSync(path.join(scratch, 'cache', 'deep', 'deeper'), { recursive: true });
      fs.writeFileSync(path.join(scratch, 'cache', 'deep', 'deeper', 'planted.txt'), 'through the link\n');
    }, null],
  ])('refuses to write through a link the user has in the working tree: %s', async (_, edit, userFile) => {
    const host = createTestHost();
    const outside = path.join(host.root, 'outside');
    fs.mkdirSync(outside);
    const { repo } = await hostResult(host, {
      prepare: userFile === null ? undefined : ({ repo: bait, g }) => {
        fs.mkdirSync(path.join(bait, 'cache'));
        fs.writeFileSync(path.join(bait, 'cache', userFile), 'the user\'s\n');
        g(['add', 'cache']);
        g(['commit', '--quiet', '-m', 'a folder of the user', '--', 'cache']);
      },
      edit,
    });
    // The folder becomes a link on the host, to a place outside the repository that holds the same file.
    if (userFile !== null) {
      fs.cpSync(path.join(repo, 'cache'), outside, { recursive: true });
      fs.rmSync(path.join(repo, 'cache'), { recursive: true });
    } else {
      fs.appendFileSync(path.join(repo, '.git', 'info', 'exclude'), 'cache\n');
    }
    fs.symlinkSync(outside, path.join(repo, 'cache'), WIN ? 'junction' : 'dir');
    const outsideBefore = fs.readdirSync(outside).sort();
    const before = hostState(repo);
    const failure = await host.codeOut().applyAsChanges({ repository: repo, spaceId: SPACE_ID }).catch((error) => error);
    expect(failure).toMatchObject({ code: 'changes_blocked_by_link', details: { path: 'cache' } });
    expect(failure.message).toMatch(/is a link to another place, so nothing was changed/);
    expect(failure.message).toMatch(/applied as a branch/);
    expect(fs.readdirSync(outside).sort()).toEqual(outsideBefore);
    expect(anyChangeSince(before, repo)).toEqual(CLOSURE);
    // It is the same family as a collision: the route is closed.
    await expect(host.codeOut().applyAsChanges({ repository: repo, spaceId: SPACE_ID })).rejects.toMatchObject({ code: 'changes_route_closed' });
  });

  it.skipIf(WIN)('refuses a link that points inside the working tree as well, and applies around a link the patch does not pass', async () => {
    const host = createTestHost();
    const { repo } = await hostResult(host, {
      edit: (scratch) => {
        fs.mkdirSync(path.join(scratch, 'docs'));
        fs.writeFileSync(path.join(scratch, 'docs', 'new.md'), 'new\n');
      },
    });
    fs.mkdirSync(path.join(repo, 'documentation'));
    fs.appendFileSync(path.join(repo, '.git', 'info', 'exclude'), 'docs\ndocumentation\nelsewhere\n');
    fs.symlinkSync('documentation', path.join(repo, 'docs'), 'dir');
    await expect(host.codeOut().applyAsChanges({ repository: repo, spaceId: SPACE_ID })).rejects.toMatchObject({ code: 'changes_blocked_by_link', details: { path: 'docs' } });
    expect(fs.readdirSync(path.join(repo, 'documentation'))).toEqual([]);

    // The control, in a fresh repository: a link beside the patch's paths is none of its business.
    const clean = createTestHost();
    const other = await hostResult(clean, {
      edit: (scratch) => {
        fs.mkdirSync(path.join(scratch, 'docs'));
        fs.writeFileSync(path.join(scratch, 'docs', 'new.md'), 'new\n');
      },
    });
    fs.appendFileSync(path.join(other.repo, '.git', 'info', 'exclude'), 'elsewhere\n');
    fs.symlinkSync(clean.root, path.join(other.repo, 'elsewhere'), 'dir');
    expect(await clean.codeOut().applyAsChanges({ repository: other.repo, spaceId: SPACE_ID })).toMatchObject({ status: 'applied' });
    expect(fs.readFileSync(path.join(other.repo, 'docs', 'new.md'), 'utf8')).toBe('new\n');
  });
});

// The user's own filters run when the patch is applied, as they would for a `git pull`; a filter
// named by a `.gitattributes` that arrives in the patch does not. The branch runs nothing.
describe.skipIf(WIN)('filters', () => {
  const filterHost = () => {
    const host = createTestHost();
    const markers = path.join(host.root, 'filter-markers');
    fs.mkdirSync(markers);
    const filter = (name, step) => {
      const program = path.join(host.root, `${name}-${step}.sh`);
      fs.writeFileSync(program, `#!/bin/sh\necho ran >> '${markers}/${name}-${step}'\ncat\n`, { mode: 0o755 });
      return forConfig(program);
    };
    host.addConfig([
      '[filter "mine"]', `\tclean = ${filter('mine', 'clean')}`, `\tsmudge = ${filter('mine', 'smudge')}`,
      '[filter "arriving"]', `\tclean = ${filter('arriving', 'clean')}`, `\tsmudge = ${filter('arriving', 'smudge')}`,
    ].join('\n'));
    const ran = () => fs.readdirSync(markers).sort();
    const clear = () => { for (const marker of fs.readdirSync(markers)) fs.rmSync(path.join(markers, marker)); };
    return { host, ran, clear };
  };
  const edit = (scratch) => {
    fs.writeFileSync(path.join(scratch, 'data.mine'), 'changed by the space\n');
    fs.mkdirSync(path.join(scratch, 'arrived'));
    fs.writeFileSync(path.join(scratch, 'arrived', '.gitattributes'), '*.bin filter=arriving\n');
    fs.writeFileSync(path.join(scratch, 'arrived', 'a.bin'), 'bin\n');
  };

  it('runs the user\'s own filter for a file their .gitattributes covers, and not one a patch brings', async () => {
    const { host, ran, clear } = filterHost();
    // The control: both filters run on an ordinary command, each where its attributes are.
    const control = makeBait(host, { name: 'control' });
    fs.writeFileSync(path.join(control.repo, '.gitattributes'), '*.mine filter=mine\n*.bin filter=arriving\n');
    fs.writeFileSync(path.join(control.repo, 'x.mine'), 'x\n');
    fs.writeFileSync(path.join(control.repo, 'x.bin'), 'x\n');
    control.g(['add', 'x.mine', 'x.bin']);
    expect(ran()).toEqual(['arriving-clean', 'mine-clean']);
    clear();

    // The user's repository has the attributes and the file before the space's change arrives.
    const { repo: user } = await hostResult(host, {
      prepare: ({ repo, g }) => {
        fs.writeFileSync(path.join(repo, '.gitattributes'), '*.mine filter=mine\n');
        fs.writeFileSync(path.join(repo, 'data.mine'), 'data\n');
        g(['add', '.gitattributes', 'data.mine']);
        g(['commit', '--quiet', '-m', 'the user has a filter', '--', '.gitattributes', 'data.mine']);
      },
      edit,
    });
    clear();

    await host.codeOut().applyAsBranch({ repository: user, spaceId: SPACE_ID, branch: 'from-the-space' });
    expect(ran()).toEqual([]);
    await host.codeOut().applyAsChanges({ repository: user, spaceId: SPACE_ID });
    expect(fs.readFileSync(path.join(user, 'data.mine'), 'utf8')).toBe('changed by the space\n');
    expect(fs.readFileSync(path.join(user, 'arrived', 'a.bin'), 'utf8')).toBe('bin\n');
    expect(ran()).toContain('mine-smudge');
    expect(ran().filter((marker) => marker.startsWith('arriving'))).toEqual([]);
  });
});

// The dry run passes and the apply itself does not: a folder that cannot be written, or a full disk.
// Part of the work is then in the working tree, and nothing else may pretend otherwise.
describe.skipIf(WIN || process.getuid?.() === 0)('an apply that stops in the middle', () => {
  const lockedResult = async (host) => hostResult(host, {
    prepare: ({ repo, g }) => {
      fs.mkdirSync(path.join(repo, 'locked'));
      fs.writeFileSync(path.join(repo, 'locked', 'keep.txt'), 'one\n');
      g(['add', 'locked/keep.txt']);
      g(['commit', '--quiet', '-m', 'a folder of the user', '--', 'locked/keep.txt']);
    },
    edit: (scratch) => {
      fs.writeFileSync(path.join(scratch, 'locked', 'keep.txt'), 'one\ntwo from the space\n');
      fs.writeFileSync(path.join(scratch, 'plain.txt'), 'plain\n');
    },
  });

  it('says that part of the work may be in the project, and does not remember the apply', async () => {
    const host = createTestHost();
    const { repo, g, result } = await lockedResult(host);
    fs.chmodSync(path.join(repo, 'locked'), 0o500);
    try {
      const failure = await host.codeOut().applyAsChanges({ repository: repo, spaceId: SPACE_ID }).catch((error) => error);
      expect(failure).toMatchObject({ code: 'changes_partly_applied' });
      expect(failure.message).toMatch(/part of it may be in your project/);
      expect(failure.message).toMatch(/as a branch/);
      // The work is not in the project: the locked file kept its content, and which of the other
      // files git had already written when it stopped is its own order, which is why the message
      // says that part of it may be there.
      expect(fs.readFileSync(path.join(repo, 'locked', 'keep.txt'), 'utf8')).toBe('one\n');
      expect(workingTreeAs(host, repo, result)).not.toBe(g(['rev-parse', `${result}^{tree}`]).trim());
      // Nothing was remembered, so no later apply may think this one went through.
      expect(g(['for-each-ref', APPLIED])).toBe('');
      // And the route is closed: the project is in a state this cannot reason about.
      expect(failure.message).toMatch(/applied as a branch/);
      expect(g(['rev-parse', CLOSED]).trim()).toBe(result);
      await expect(host.codeOut().applyAsChanges({ repository: repo, spaceId: SPACE_ID })).rejects.toMatchObject({ code: 'changes_route_closed' });
    } finally {
      fs.chmodSync(path.join(repo, 'locked'), 0o700);
    }
  });

  // The control: with the folder writable the same result applies and is remembered.
  it('applies and remembers when the folder can be written', async () => {
    const host = createTestHost();
    const { repo, g, result } = await lockedResult(host);
    expect(await host.codeOut().applyAsChanges({ repository: repo, spaceId: SPACE_ID })).toMatchObject({ status: 'applied', remembered: true });
    expect(g(['rev-parse', APPLIED]).trim()).toBe(result);
    expect(g(['for-each-ref', CLOSED])).toBe('');
  });
});

describe('a host git that fails where code out has to answer for it', () => {
  /** The host's git, except that the call whose arguments `breaks` names fails. */
  const gitBreaking = (host, breaks) => ({
    run: (directory, args, options) => (breaks(args) ? Promise.resolve({ code: 128, stdout: '', stderr: 'fatal: broken on purpose\n' }) : host.git.run(directory, args, options)),
    output: async (directory, args, options) => {
      if (breaks(args)) throw new SpaceError('git_command_failed', 'git diff-tree failed: fatal: unable to generate diff', { exitCode: 128 });
      return host.git.output(directory, args, options);
    },
  });

  it('says a patch could not be built at all, and points at the branch', async () => {
    const host = createTestHost();
    const { repo } = await hostResult(host, { edit: ordinaryEdit });
    const codeOut = createCodeOut({ git: gitBreaking(host, (args) => args.some((argument) => String(argument).startsWith('--output='))), place: null, temporaryDirectory: host.root });
    const before = hostState(repo);
    const failure = await codeOut.applyAsChanges({ repository: repo, spaceId: SPACE_ID }).catch((error) => error);
    expect(failure).toMatchObject({ code: 'patch_not_possible', details: { cause: 'git_command_failed' } });
    expect(failure.message).toMatch(/as a branch/);
    expect(anyChangeSince(before, repo)).toEqual([]);
  });

  it('says the apply was not remembered when the ref cannot be written, and leaves the changes in place', async () => {
    const host = createTestHost();
    const { repo, g, result } = await hostResult(host, { edit: ordinaryEdit });
    // The record after the apply is one transaction on stdin; it is what fails here.
    const codeOut = createCodeOut({ git: gitBreaking(host, (args) => args.includes('update-ref') && args.includes('--stdin')), place: null, temporaryDirectory: host.root });
    expect(await codeOut.applyAsChanges({ repository: repo, spaceId: SPACE_ID })).toMatchObject({ status: 'applied', remembered: false });
    expect(workingTreeAs(host, repo, result)).toBe(g(['rev-parse', `${result}^{tree}`]).trim());
    expect(g(['for-each-ref', APPLIED])).toBe('');
    // The intent stayed, so the next call finds the work in the working tree and finishes the record.
    expect(g(['rev-parse', APPLYING]).trim()).toBe(result);
    expect(await host.codeOut().applyAsChanges({ repository: repo, spaceId: SPACE_ID })).toEqual({ status: 'nothing_to_apply' });
    expect(g(['rev-parse', APPLIED]).trim()).toBe(result);
    expect(g(['for-each-ref', APPLYING, CLOSED])).toBe('');
  });
});

// Each of the two ways the check sees a folder that leads elsewhere, alone. On a POSIX machine a
// symbolic link trips both, so these fakes stand for what only other systems produce: a junction
// that `lstat` reports as a link and whose real path Node may not resolve, and a redirection that
// `lstat` reports as a plain folder.
describe('firstRedirectedFolder', () => {
  const root = path.join(path.sep, 'work');
  const folder = { isSymbolicLink: () => false, isDirectory: () => true };
  const link = { isSymbolicLink: () => true, isDirectory: () => false };
  const fakes = (kinds, reals = {}) => ({
    lstat: async (full) => {
      const relative = path.relative(root, full).split(path.sep).join('/');
      if (!(relative in kinds)) throw Object.assign(new Error('absent'), { code: 'ENOENT' });
      return kinds[relative];
    },
    realpath: async (full) => {
      const relative = path.relative(root, full).split(path.sep).join('/');
      return relative in reals ? reals[relative] : full;
    },
  });

  it('sees a folder that lstat reports as a link, even when its real path looks like its own', async () => {
    const check = fakes({ a: folder, 'a/b': link });
    expect(await firstRedirectedFolder(root, ['a/b/c/file.txt'], { ignoreCase: true, ...check })).toBe('a/b');
  });

  it('sees a plain folder whose real path is somewhere else', async () => {
    const check = fakes({ a: folder }, { a: path.join(path.sep, 'elsewhere') });
    expect(await firstRedirectedFolder(root, ['a/file.txt'], check)).toBe('a');
  });

  it('lets plain folders, folders that do not exist yet, and a different case where the repository ignores case through', async () => {
    const check = fakes({ a: folder, 'a/b': folder }, { 'a/b': path.join(root, 'A', 'B') });
    expect(await firstRedirectedFolder(root, ['a/b/file.txt', 'new/deeper/file.txt', 'top.txt'], { ignoreCase: true, ...check })).toBeNull();
    // The same answer is a different folder where case counts.
    expect(await firstRedirectedFolder(root, ['a/b/file.txt'], check)).toBe('a/b');
  });
});

// The names a patch may create, per platform. The Windows rules run here on every machine through
// the platform argument; each comes from Microsoft's naming documentation or from git's own check.
describe('nameNotAllowedHere', () => {
  const refused = (name, platform = 'win32') => nameNotAllowedHere([name], [name], { platform });

  it.each([
    ...['<', '>', ':', '"', '\\', '|', '?', '*', '\x01', '\t', '\x1f'].map((character) => [`a${character}b.txt`, 'reserved_character']),
    ['CON', 'device_name'], ['con', 'device_name'], ['Con.txt', 'device_name'], ['nul.tar.gz', 'device_name'],
    ['aux .txt', 'device_name'], ['PRN', 'device_name'], ['com1', 'device_name'], ['COM9.log', 'device_name'],
    ['lpt0', 'device_name'], ['LPT¹', 'device_name'], ['com³.x', 'device_name'], ['CONIN$', 'device_name'], ['conout$.txt', 'device_name'],
    ['name.', 'trailing_space_or_period'], ['name ', 'trailing_space_or_period'], ['folder./file.txt', 'trailing_space_or_period'],
  ])('refuses %j on Windows as %s, and lets it through on macOS and Linux', (name, rule) => {
    expect(refused(name)).toMatchObject({ path: name, rule });
    expect(refused(name, 'darwin')).toBeNull();
    expect(refused(name, 'linux')).toBeNull();
  });

  // The control: ordinary names, and names that only look like the refused ones.
  it.each([
    'README.md', 'with spaces inside.txt', 'юнікод.txt', '.env', '..hidden', '[brackets] (and) {braces}.txt', 'a.b.c',
    'console.log', 'auxiliary.txt', 'nullable', 'com0', 'com10', 'lpt10', 'CONIN', 'src/components/Button.tsx',
  ])('lets %j through on every platform', (name) => {
    for (const platform of ['win32', 'darwin', 'linux']) expect(refused(name, platform)).toBeNull();
  });

  // Case-blindness is the repository's, as git found it on the disk, not the operating system's.
  const blind = { ignoreCase: true };
  it('sees names that differ only in case, of files and of folders, where the repository ignores case', () => {
    for (const platform of ['win32', 'darwin', 'linux']) {
      expect(nameNotAllowedHere(['readme.md'], ['README.md', 'readme.md'], { platform, ...blind })).toMatchObject({ path: 'readme.md', rule: 'differs_only_in_case', other: 'README.md' });
      expect(nameNotAllowedHere(['docs/new.md'], ['Docs/old.md', 'docs/new.md'], { platform, ...blind })).toMatchObject({ path: 'docs/new.md', rule: 'differs_only_in_case', other: 'Docs' });
      // Where the repository does not ignore case, on any system, the two are two files.
      expect(nameNotAllowedHere(['readme.md'], ['README.md', 'readme.md'], { platform })).toBeNull();
    }
    // A collision the user already has, between two names the patch does not create, is theirs.
    expect(nameNotAllowedHere(['new.md'], ['A.md', 'a.md', 'new.md'], blind)).toBeNull();
  });

  it('lets a new file into a folder the user already has in two spellings', () => {
    const all = ['Docs/old.md', 'docs/other.md', 'docs/new.md', 'Docs/also-new.md'];
    expect(nameNotAllowedHere(['docs/new.md', 'Docs/also-new.md'], all, blind)).toBeNull();
    // The control: with only one of the two spellings there before, the new one is the agent's.
    expect(nameNotAllowedHere(['docs/new.md'], ['Docs/old.md', 'docs/new.md'], blind)).toMatchObject({ rule: 'differs_only_in_case', other: 'Docs' });
  });

  it('sees a rename that changes only the case, of a file and of a folder', () => {
    expect(nameNotAllowedHere(['README.md'], ['README.md'], { ...blind, deleted: ['readme.md'] }))
      .toMatchObject({ path: 'README.md', rule: 'case_only_rename', other: 'readme.md' });
    expect(nameNotAllowedHere(['lib/a.js', 'lib/b.js'], ['lib/a.js', 'lib/b.js'], { ...blind, deleted: ['Lib/a.js', 'Lib/b.js'] }))
      .toMatchObject({ path: 'lib/a.js', rule: 'case_only_rename', other: 'Lib' });
    // The control: an ordinary rename is none of this check's business.
    expect(nameNotAllowedHere(['lib/a.js'], ['lib/a.js'], { ...blind, deleted: ['src/a.js'] })).toBeNull();
  });

  it('takes the two Unicode spellings of an accent for one name where the repository precomposes', () => {
    const composed = 'café.txt';
    const decomposed = 'café.txt';
    expect(nameNotAllowedHere([composed], [decomposed, composed], { precompose: true })).toMatchObject({ rule: 'differs_only_in_case' });
    expect(nameNotAllowedHere([composed], [decomposed, composed], blind)).toBeNull();
  });

  it('refuses a name longer than 255 bytes and a path longer than 1024 bytes on every platform, and a long Windows path without core.longpaths', () => {
    for (const platform of ['win32', 'darwin', 'linux']) {
      expect(refused('n'.repeat(256), platform)).toMatchObject({ rule: 'name_too_long' });
      expect(refused('\u00e9'.repeat(128), platform)).toMatchObject({ rule: 'name_too_long' });
      expect(refused(`${'folder/'.repeat(147)}f`, platform)).toMatchObject({ rule: 'path_too_long' });
      expect(refused('n'.repeat(255), platform)).toBeNull();
    }
    // 40 folders: 288 characters below the project, past Windows' 259 and far below 1024 bytes.
    const deep = `${'folder/'.repeat(40)}file.txt`;
    const top = 'C:\\Users\\someone\\project';
    expect(nameNotAllowedHere([deep], [deep], { platform: 'win32', top })).toMatchObject({ rule: 'path_too_long' });
    expect(nameNotAllowedHere([deep], [deep], { platform: 'win32', top, longPaths: true })).toBeNull();
    expect(nameNotAllowedHere([deep], [deep], { platform: 'linux', top: '/home/someone/project' })).toBeNull();
  });

  // Measured before this: every folder of every path was kept as a string of its own, and one result
  // with sixteen paths 2048 folders deep ran Node out of memory. The length rule stops such a path
  // first; and a whole large tree with one new file keeps only the folders on the way of that file.
  it('stays cheap for a large tree with a few new files', () => {
    const all = [];
    for (let file = 0; file < 200_000; file += 1) all.push(`packages/p${file % 500}/src/deep/er/file-${file}.ts`);
    all.push('packages/p1/src/new.ts');
    const started = process.hrtime.bigint();
    expect(nameNotAllowedHere(['packages/p1/src/new.ts'], all, blind)).toBeNull();
    const took = Number(process.hrtime.bigint() - started) / 1e6;
    expect(took).toBeLessThan(2000);
  });
});

/**
 * A result made with git's plumbing: the space's start with `files` added at its top level, as
 * `{ name: content }`, without any of them on a disk, so a name this computer cannot hold can still be
 * in it. The tree is written raw, not through the index: Git for Windows refuses a name like
 * `line\nbreak.txt` in the index, and the point is a tree that holds exactly such a name.
 */
const plumbedResult = async (host, files) => {
  const bait = makeBait(host);
  await host.codeIn().takeSnapshot({ repository: bait.repo, spaceId: SPACE_ID, mode: 'uncommitted' });
  const commitOn = (parent, entries) => {
    const listing = bait.g(['ls-tree', '-z', parent]).split('\0').filter(Boolean).map((line) => {
      const [mode, type, id] = line.slice(0, line.indexOf('\t')).split(' ');
      return { mode, type, id, name: line.slice(line.indexOf('\t') + 1) };
    });
    for (const [name, content] of Object.entries(entries)) {
      expect(name.includes('/'), 'a plumbed name is one name at the top level').toBe(false);
      // null takes a name out, which is how a rename is made.
      if (content === null) {
        listing.splice(listing.findIndex((entry) => entry.name === name), 1);
      } else {
        listing.push({ mode: '100644', type: 'blob', id: bait.g(['hash-object', '-w', '--stdin'], { input: content }).trim(), name });
      }
    }
    // Git's own order: by bytes, a folder as if its name ended in a slash.
    const key = (entry) => Buffer.from(entry.type === 'tree' ? `${entry.name}/` : entry.name);
    listing.sort((a, b) => Buffer.compare(key(a), key(b)));
    const raw = Buffer.concat(listing.flatMap((entry) => [
      Buffer.from(`${entry.mode === '040000' ? '40000' : entry.mode} ${entry.name}\0`),
      Buffer.from(entry.id, 'hex'),
    ]));
    const tree = bait.g(['hash-object', '-t', 'tree', '--literally', '-w', '--stdin'], { input: raw }).trim();
    return bait.g(['commit-tree', tree, '-p', parent, '-m', 'plumbed']).trim();
  };
  bait.g(['update-ref', RESULT, commitOn(START, files)]);
  return { ...bait, commitOn };
};

describe('applyAsChanges and a name this computer cannot hold', () => {
  it('refuses a name that differs only in case from one in the project, touches nothing, and keeps the route open', async () => {
    const host = createTestHost();
    const { repo, g, commitOn } = await plumbedResult(host, { 'readme.md': 'a second readme\n' });
    // What git sets for a repository on a disk that ignores case; the check reads it from here.
    g(['config', 'core.ignorecase', 'true']);
    const codeOut = host.codeOut();
    const before = hostState(repo);
    const failure = await codeOut.applyAsChanges({ repository: repo, spaceId: SPACE_ID }).catch((error) => error);
    expect(failure).toMatchObject({ code: 'name_not_allowed_here', details: { path: 'readme.md', rule: 'differs_only_in_case', other: 'README.md' } });
    expect(failure.message).toBe('The agent made readme.md, which differs from README.md only in case, and this computer takes the two for one file, so nothing was changed. Have the agent rename it, then bring the work out again.');
    expect(anyChangeSince(before, repo)).toEqual([]);
    expect(g(['for-each-ref', CLOSED])).toBe('');
    // The agent renames it, the work comes out again, and it applies.
    g(['update-ref', RESULT, commitOn(START, { 'readme-second.md': 'a second readme\n' })]);
    expect(await codeOut.applyAsChanges({ repository: repo, spaceId: SPACE_ID })).toMatchObject({ status: 'applied', appliedPaths: 1 });
    expect(fs.readFileSync(path.join(repo, 'readme-second.md'), 'utf8')).toBe('a second readme\n');
  });

  it('redacts a control character in the name it reports', async () => {
    const host = createTestHost();
    const { repo } = await plumbedResult(host, { 'line\nbreak.txt': 'x\n' });
    const codeOut = createCodeOut({ git: host.git, place: null, temporaryDirectory: host.root, platform: 'win32' });
    const failure = await codeOut.applyAsChanges({ repository: repo, spaceId: SPACE_ID }).catch((error) => error);
    expect(failure).toMatchObject({ code: 'name_not_allowed_here', details: { path: 'line?break.txt', rule: 'reserved_character' } });
    expect(failure.message).toContain('The agent made line?break.txt, which has a name this computer cannot hold');
  });
});

describe('applyAsChanges after round four', () => {
  it('refuses a rename that changes only the case, touches nothing, and keeps the route open', async () => {
    const host = createTestHost();
    const { repo, g, commitOn } = await plumbedResult(host, { 'README.md': null, 'readme.md': 'hello\n' });
    g(['config', 'core.ignorecase', 'true']);
    const before = hostState(repo);
    const failure = await host.codeOut().applyAsChanges({ repository: repo, spaceId: SPACE_ID }).catch((error) => error);
    expect(failure).toMatchObject({ code: 'case_only_rename', details: { path: 'readme.md', rule: 'case_only_rename', other: 'README.md' } });
    expect(failure.message).toBe('The agent renamed README.md to readme.md, changing only the case of the name, and on this computer that cannot be applied as uncommitted changes, so nothing was changed. The branch holds it: apply the work as a branch, or have the agent choose a new name and bring the work out again.');
    expect(anyChangeSince(before, repo)).toEqual([]);
    expect(g(['for-each-ref', CLOSED])).toBe('');
    // The branch holds it, and after a new name the work applies.
    await host.codeOut().applyAsBranch({ repository: repo, spaceId: SPACE_ID, branch: 'with-the-rename' });
    g(['update-ref', RESULT, commitOn(START, { 'README.md': null, 'read-me.md': 'hello\n' })]);
    expect(await host.codeOut().applyAsChanges({ repository: repo, spaceId: SPACE_ID })).toMatchObject({ status: 'applied' });
  });

  it('says so when a file the user keeps out of git is in the way, and still closes the route', async () => {
    const host = createTestHost();
    const { repo, g } = await hostResult(host, { edit: (scratch) => fs.writeFileSync(path.join(scratch, 'generated.txt'), 'from the space\n') });
    fs.appendFileSync(path.join(repo, '.git', 'info', 'exclude'), 'generated.txt\n');
    fs.writeFileSync(path.join(repo, 'generated.txt'), 'the user\'s own\n');
    const failure = await host.codeOut().applyAsChanges({ repository: repo, spaceId: SPACE_ID }).catch((error) => error);
    expect(failure).toMatchObject({ code: 'changes_do_not_apply', details: { ignoredInTheWay: { count: 1, paths: ['generated.txt'] } } });
    expect(failure.message).toMatch(/^Your project already has generated.txt, which git ignores here, and the work of the space adds a file of the same name, so nothing was changed\./);
    expect(fs.readFileSync(path.join(repo, 'generated.txt'), 'utf8')).toBe('the user\'s own\n');
    expect(g(['for-each-ref', CLOSED])).not.toBe('');
  });

  describe('an apply the host did not live to record', () => {
    it('forgets an attempt that wrote nothing, and applies', async () => {
      const host = createTestHost();
      const { repo, g, result } = await hostResult(host, { edit: ordinaryEdit });
      g(['update-ref', APPLYING, result]);
      expect(await host.codeOut().applyAsChanges({ repository: repo, spaceId: SPACE_ID })).toMatchObject({ status: 'applied', remembered: true });
      expect(g(['rev-parse', APPLIED]).trim()).toBe(result);
      expect(g(['for-each-ref', APPLYING, CLOSED])).toBe('');
      expect(workingTreeAs(host, repo, result)).toBe(g(['rev-parse', `${result}^{tree}`]).trim());
    });

    it('says that part of the work is in the project when the attempt stopped halfway, and closes the route', async () => {
      const host = createTestHost();
      const { repo, g, result } = await hostResult(host, { edit: ordinaryEdit });
      g(['update-ref', APPLYING, result]);
      // What an interrupted apply leaves: one of its files, and not the others.
      fs.writeFileSync(path.join(repo, 'added by the space.txt'), 'new\n');
      const failure = await host.codeOut().applyAsChanges({ repository: repo, spaceId: SPACE_ID }).catch((error) => error);
      expect(failure).toMatchObject({ code: 'changes_partly_applied', details: { interrupted: true } });
      expect(failure.message).toMatch(/^An earlier apply of the work of this space was interrupted, and part of it is in your project/);
      expect(failure.message).toMatch(/applied as a branch/);
      expect(g(['rev-parse', CLOSED]).trim()).toBe(result);
      expect(g(['for-each-ref', APPLYING, APPLIED])).toBe('');
    });

    it('finishes the record of an attempt that wrote everything, and has nothing left to apply', async () => {
      const host = createTestHost();
      const { repo, g, result, snapshot } = await hostResult(host, { edit: ordinaryEdit });
      g(['update-ref', APPLYING, result]);
      // What an apply that finished and was not recorded leaves: all of it.
      const patch = path.join(host.root, 'finished.patch');
      g(['diff-tree', '-r', '-p', '--binary', '--full-index', `--output=${forConfig(patch)}`, snapshot.start, result]);
      g(['apply', '--binary', forConfig(patch)]);
      expect(await host.codeOut().applyAsChanges({ repository: repo, spaceId: SPACE_ID })).toEqual({ status: 'nothing_to_apply' });
      expect(g(['rev-parse', APPLIED]).trim()).toBe(result);
      expect(g(['for-each-ref', APPLYING, CLOSED])).toBe('');
    });
  });

  it('tells a caller where the space stands without changing anything', async () => {
    const host = createTestHost();
    const { repo, g, result } = await hostResult(host, { edit: ordinaryEdit });
    const before = hostState(repo);
    expect(await host.codeOut().describeApplyState({ repository: repo, spaceId: SPACE_ID })).toEqual({
      changesRoute: 'open', result, lastApplied: null, newPaths: WIN ? 5 : 6, interruptedApply: false,
    });
    expect(anyChangeSince(before, repo)).toEqual([]);
    await host.codeOut().applyAsChanges({ repository: repo, spaceId: SPACE_ID });
    expect(await host.codeOut().describeApplyState({ repository: repo, spaceId: SPACE_ID })).toMatchObject({ lastApplied: result, newPaths: 0 });
    g(['update-ref', APPLYING, result]);
    g(['update-ref', CLOSED, result]);
    expect(await host.codeOut().describeApplyState({ repository: repo, spaceId: SPACE_ID })).toMatchObject({ changesRoute: 'closed', interruptedApply: true });
  });

  // git reports a folder by the precomposed form of its name, and a macOS disk may hold the other form.
  // That is the same folder, not a link.
  it('does not take a folder whose name is stored in the other Unicode form for a link', async () => {
    const check = {
      lstat: async () => ({ isSymbolicLink: () => false, isDirectory: () => true }),
      realpath: async (full) => full.normalize('NFD'),
    };
    const root = path.join(path.sep, 'work');
    expect(await firstRedirectedFolder(root, ['café/new.txt'], { precompose: true, ...check })).toBeNull();
    // The control: where the repository does not precompose, the two forms are two names.
    expect(await firstRedirectedFolder(root, ['café/new.txt'], check)).toBe('café');
  });

  it.skipIf(process.platform !== 'darwin')('applies into a tracked and an untracked folder whose names the disk stores decomposed', async () => {
    const host = createTestHost();
    const { repo, g, result } = await hostResult(host, {
      prepare: ({ repo: bait, g: bg }) => {
        fs.mkdirSync(path.join(bait, 'café'));
        fs.writeFileSync(path.join(bait, 'café', 'menu.txt'), 'menu\n');
        bg(['add', '--all']);
        bg(['commit', '--quiet', '-m', 'a folder stored decomposed']);
      },
      edit: (scratch) => {
        fs.writeFileSync(path.join(scratch, 'café', 'new.txt'), 'new\n');
        fs.mkdirSync(path.join(scratch, 'notés'), { recursive: true });
        fs.writeFileSync(path.join(scratch, 'notés', 'n.txt'), 'n\n');
      },
    });
    // The untracked folder, on the host, in the decomposed form.
    fs.mkdirSync(path.join(repo, 'notés'), { recursive: true });
    expect(g(['config', '--bool', 'core.precomposeunicode']).trim()).toBe('true');
    expect(await host.codeOut().applyAsChanges({ repository: repo, spaceId: SPACE_ID })).toMatchObject({ status: 'applied' });
    expect(workingTreeAs(host, repo, result)).toBe(g(['rev-parse', `${result}^{tree}`]).trim());
    expect(g(['for-each-ref', CLOSED])).toBe('');
  });
});

describe('applyAsBranch', () => {
  it('makes the branch at the result without checking it out, and changes nothing else', async () => {
    const host = createTestHost();
    const { repo, g, result } = await hostResult(host, { edit: ordinaryEdit });
    const before = hostState(repo);
    expect(await host.codeOut().applyAsBranch({ repository: repo, spaceId: SPACE_ID, branch: 'space/work' })).toEqual({ branch: 'space/work', commit: result });
    expect(g(['rev-parse', 'refs/heads/space/work']).trim()).toBe(result);
    expect(g(['symbolic-ref', 'HEAD']).trim()).toBe('refs/heads/main');
    expect(unexpectedChanges(before, hostState(repo), { spaceIds: [SPACE_ID], codeOut: true }))
      .toEqual(['.git/logs/refs/heads/space', '.git/logs/refs/heads/space/work', '.git/refs/heads/space', '.git/refs/heads/space/work']);
  });

  it('refuses an existing branch and leaves it where it was', async () => {
    const host = createTestHost();
    const { repo, g } = await hostResult(host, { edit: ordinaryEdit });
    const head = g(['rev-parse', 'HEAD']).trim();
    g(['branch', 'taken']);
    const before = hostState(repo);
    await expect(host.codeOut().applyAsBranch({ repository: repo, spaceId: SPACE_ID, branch: 'taken' })).rejects.toMatchObject({ code: 'branch_exists' });
    await expect(host.codeOut().applyAsBranch({ repository: repo, spaceId: SPACE_ID, branch: 'main' })).rejects.toMatchObject({ code: 'branch_exists' });
    expect(g(['rev-parse', 'refs/heads/taken']).trim()).toBe(head);
    expect(anyChangeSince(before, repo)).toEqual([]);
  });

  it.each([
    [''], ['-starts-with-dash'], ['has space'], ['a..b'], ['ends.lock'], ['HEAD'], ['@{-1}'], ['tab\tinside'], ['line\nbreak'], ['trailing/'], [42], [null],
  ])('refuses the branch name %j and changes nothing', async (branch) => {
    const host = createTestHost();
    const { repo, g } = await hostResult(host, { edit: ordinaryEdit });
    // A previous branch, so that `@{-1}` would expand to a real name.
    g(['checkout', '--quiet', '-b', 'previous']);
    g(['checkout', '--quiet', 'main']);
    const before = hostState(repo);
    await expect(host.codeOut().applyAsBranch({ repository: repo, spaceId: SPACE_ID, branch })).rejects.toMatchObject({ code: 'invalid_branch_name' });
    expect(anyChangeSince(before, repo)).toEqual([]);
  });

  it('refuses without a result', async () => {
    const host = createTestHost();
    const { repo } = makeBait(host);
    await expect(host.codeOut().applyAsBranch({ repository: repo, spaceId: SPACE_ID, branch: 'work' })).rejects.toMatchObject({ code: 'result_missing' });
  });

  it('works in a SHA-256 repository and in a linked worktree, where the branch is seen from both', async () => {
    const host = createTestHost();
    const { g, result } = await hostResult(host, { objectFormat: 'sha256', edit: ordinaryEdit });
    const worktree = path.join(host.root, 'linked worktree');
    g(['worktree', 'add', '--quiet', '-b', 'feature', worktree]);
    await host.codeOut().applyAsBranch({ repository: worktree, spaceId: SPACE_ID, branch: 'from-the-space' });
    expect(g(['rev-parse', 'refs/heads/from-the-space']).trim()).toBe(result);
    expect(host.sh(worktree, ['symbolic-ref', 'HEAD']).trim()).toBe('refs/heads/feature');
  });
});

/**
 * A space with the bait in it, through code in into the stand-in, and code out for it. `gi` runs git
 * in the space's repository as the agent would, `write` writes a file there.
 */
const spaceWithCode = async (host, { objectFormat = 'sha1', history = true, repository = null } = {}) => {
  const bait = makeBait(host, { objectFormat });
  const local = createLocalPlace(host, 'receive', SPACE_ID, { codeOut: true });
  const codeIn = host.codeIn(local.place);
  const came = await codeIn.bringCodeIn({ repository: repository ? repository(bait) : bait.repo, spaceId: SPACE_ID, timeoutMs: 60_000 });
  if (history) await codeIn.sendHistory({ repository: bait.repo, spaceId: SPACE_ID, spacePath: came.spacePath, base: came.base });
  const inside = local.local(came.spacePath);
  const gi = (args, options) => {
    const result = local.inside(['-C', inside, ...args], options);
    if (result.code !== 0) throw new Error(`git ${args.join(' ')} in the space: ${result.stderr}`);
    return result.stdout;
  };
  const write = (file, content) => {
    fs.mkdirSync(path.dirname(path.join(inside, file)), { recursive: true });
    fs.writeFileSync(path.join(inside, file), content);
  };
  const codeOut = host.codeOut(local.place);
  const request = (extra = {}) => ({ repository: bait.repo, spaceId: SPACE_ID, spacePath: came.spacePath, timeoutMs: 60_000, ...extra });
  return { ...bait, local, came, inside, gi, write, codeOut, request, out: (extra) => codeOut.bringCodeOut(request(extra)) };
};

/** A commit in the space whose tree holds one entry named `name`, built without git's path checks, on top of HEAD. */
const commitLiteralTree = (space, name) => {
  const blobId = space.gi(['hash-object', '-w', '--stdin'], { input: 'planted\n' }).trim();
  const tree = (entryName, mode, id) => space.gi(['hash-object', '-t', 'tree', '--literally', '-w', '--stdin'], {
    input: Buffer.concat([Buffer.from(`${mode} ${entryName}\0`), Buffer.from(id, 'hex')]),
  }).trim();
  // `.git/hooks/x` is three trees deep, the others are one entry.
  const parts = name.split('/');
  const nested = name.startsWith('.git/');
  let id = tree(nested ? parts.at(-1) : name, '100644', blobId);
  if (nested) {
    for (const part of parts.slice(0, -1).reverse()) id = tree(part, '40000', id);
  }
  const commit = space.gi(['commit-tree', id, '-p', 'HEAD', '-m', 'planted'], {}).trim();
  space.gi(['update-ref', 'HEAD', commit]);
};

// Every hook that git on the host could run during code out, each writing a marker of its own name.
const HOOK_NAMES = ['pre-push', 'post-index-change', 'reference-transaction', 'post-checkout', 'pre-commit', 'post-commit', 'pre-auto-gc', 'post-rewrite', 'push-to-checkout', 'pre-receive', 'post-receive', 'update', 'post-update', 'post-merge'];

describe.skipIf(WIN)('bringCodeOut from a local stand-in for a space', () => {
  it('brings the agent\'s commits and the uncommitted rest as one commit on top, and applies both ways', async () => {
    const host = createTestHost();
    const space = await spaceWithCode(host);
    const { repo, g, gi, write } = space;
    write('committed by the agent.txt', 'committed\n');
    gi(['add', 'committed by the agent.txt']);
    gi(['commit', '--quiet', '-m', 'the agent commits']);
    const agentHead = gi(['rev-parse', 'HEAD']).trim();
    write('tracked-to-edit.txt', 'one\ntwo staged\nthree unstaged\nfour, uncommitted in the space\n');
    write('untracked in the space.txt', 'untracked\n');
    const statusInside = gi(['status', '--porcelain=v1', '--untracked-files=all']);
    const before = hostState(repo);

    const out = await space.out();
    expect(out).toMatchObject({ changedPaths: expect.any(Number), changedBytes: expect.any(Number) });
    expect(g(['rev-parse', RESULT]).trim()).toBe(out.result);
    expect(g(['rev-parse', `${out.result}^`]).trim()).toBe(agentHead);
    expect(g(['log', '-1', '--format=%an <%ae>%n%s', out.result]).trim()).toBe('OpenChamber <spaces@openchamber.invalid>\nopenchamber: uncommitted changes from the space');
    expect(blob(g, out.result, 'untracked in the space.txt')).toBe('untracked\n');
    // The agent's working tree and index are as they were.
    expect(gi(['status', '--porcelain=v1', '--untracked-files=all'])).toBe(statusInside);
    expect(gi(['rev-parse', 'HEAD']).trim()).toBe(agentHead);
    // Only new objects and the result ref: no FETCH_HEAD, no shallow file, no tag, no commit graph.
    expect(changedSince(before, repo)).toEqual([]);
    expect(leftFolders(host)).toEqual([]);
    // The changed paths against the start: the committed file, the edited one and the untracked one.
    expect(out.changedPaths).toBe(3);

    const branchBefore = hostState(repo);
    await space.codeOut.applyAsBranch({ repository: repo, spaceId: SPACE_ID, branch: 'from-the-space' });
    expect(g(['rev-parse', 'refs/heads/from-the-space']).trim()).toBe(out.result);
    expect(unexpectedChanges(branchBefore, hostState(repo), { spaceIds: [SPACE_ID], codeOut: true }))
      .toEqual(['.git/logs/refs/heads/from-the-space', '.git/refs/heads/from-the-space']);

    expect(await space.codeOut.applyAsChanges({ repository: repo, spaceId: SPACE_ID })).toMatchObject({ status: 'applied', appliedPaths: 3, remembered: true });
    expect(workingTreeAs(host, repo, out.result)).toBe(g(['rev-parse', `${out.result}^{tree}`]).trim());
    expect(g(['symbolic-ref', 'HEAD']).trim()).toBe('refs/heads/main');
  });

  it('adds no commit when nothing is uncommitted, so the result is the agent\'s HEAD', async () => {
    const host = createTestHost();
    const space = await spaceWithCode(host);
    space.gi(['add', '--all']);
    space.gi(['commit', '--quiet', '-m', 'the agent commits everything']);
    const out = await space.out();
    expect(out.result).toBe(space.gi(['rev-parse', 'HEAD']).trim());
    expect(await space.codeOut.applyAsChanges({ repository: space.repo, spaceId: SPACE_ID })).toEqual({ status: 'nothing_to_apply' });
  });

  it('comes out of a space whose history has not arrived, and the user\'s repository stays complete', async () => {
    const host = createTestHost();
    const space = await spaceWithCode(host, { history: false });
    expect(space.gi(['rev-parse', '--is-shallow-repository']).trim()).toBe('true');
    space.write('from a shallow space.txt', 'shallow\n');
    const before = hostState(space.repo);
    const out = await space.out();
    expect(blob(space.g, out.result, 'from a shallow space.txt')).toBe('shallow\n');
    expect(fs.existsSync(path.join(space.repo, '.git', 'shallow'))).toBe(false);
    expect(space.g(['rev-parse', '--is-shallow-repository']).trim()).toBe('false');
    expect(changedSince(before, space.repo)).toEqual([]);
  });

  it('refuses a result whose history claims a shallow root, instead of taking git\'s silent exit 0, and never makes the repository shallow', async () => {
    const host = createTestHost();
    const space = await spaceWithCode(host);
    space.write('c1.txt', 'c1\n');
    space.gi(['add', 'c1.txt']);
    space.gi(['commit', '--quiet', '-m', 'c1']);
    const c1 = space.gi(['rev-parse', 'HEAD']).trim();
    space.write('c2.txt', 'c2\n');
    space.gi(['add', 'c2.txt']);
    space.gi(['commit', '--quiet', '-m', 'c2']);
    fs.writeFileSync(path.join(space.inside, '.git', 'shallow'), `${c1}\n`);
    const before = hostState(space.repo);
    const failure = await space.out().catch((error) => error);
    expect(failure).toMatchObject({ code: 'result_ref_missing', details: { step: 'promote the result' } });
    expect(space.g(['for-each-ref', RESULT])).toBe('');
    expect(fs.existsSync(path.join(space.repo, '.git', 'shallow'))).toBe(false);
    expect(changedSince(before, space.repo)).toEqual([]);
    expect(leftFolders(host)).toEqual([]);
  });

  it('keeps a later result: the ref moves, within this space\'s namespace only', async () => {
    const host = createTestHost();
    const space = await spaceWithCode(host);
    space.write('first.txt', 'first\n');
    const first = await space.out();
    space.write('second.txt', 'second\n');
    const second = await space.out();
    expect(second.result).not.toBe(first.result);
    expect(space.g(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/openchamber/'])).toBe(`${RESULT} ${second.result}\n${START} ${space.came.start}\n`);
    // removeSpaceRefs of code in takes the result with the start.
    await space.codeOut.applyAsChanges({ repository: space.repo, spaceId: SPACE_ID });
    space.g(['update-ref', CLOSED, second.result]);
    space.g(['update-ref', APPLYING, second.result]);
    expect(await host.codeIn().removeSpaceRefs({ repository: space.repo, spaceId: SPACE_ID })).toEqual([APPLIED, APPLYING, CLOSED, RESULT, START]);
    expect(space.g(['for-each-ref', 'refs/openchamber/'])).toBe('');
  });

  // Git's object checks on the quarantine fetch refuse each of these. The test asks for the refusal
  // at the quarantine: the promote checks the same objects, and a test that let it catch them there
  // would pass with the quarantine's checks gone.
  it.each(['.git', '.GIT', '.Git', 'git~1', '.git ', '.git.', '..', '.', 'a/../../x', '.git/hooks/x'])('refuses a tree entry named %j at the quarantine, and nothing reaches the repository', async (name) => {
    const host = createTestHost();
    const space = await spaceWithCode(host);
    commitLiteralTree(space, name);
    const before = hostState(space.repo);
    const failure = await space.out().catch((error) => error);
    expect(failure).toMatchObject({ code: 'code_out_failed', details: { step: 'fetch into the quarantine' } });
    expect(space.g(['for-each-ref', RESULT])).toBe('');
    expect(anyChangeSince(before, space.repo)).toEqual([]);
    expect(leftFolders(host)).toEqual([]);
  });

  // The positive control of the test above: a tree built the same way with an ordinary name comes out.
  it('brings a tree built the same way with an ordinary name out', async () => {
    const host = createTestHost();
    const space = await spaceWithCode(host);
    commitLiteralTree(space, 'ordinary.txt');
    const out = await space.out();
    expect(blob(space.g, `${out.result}^`, 'ordinary.txt')).toBe('planted\n');
  });

  it('takes no tag and no ref of the space but its result', async () => {
    const host = createTestHost();
    const space = await spaceWithCode(host);
    space.write('tagged.txt', 'tagged\n');
    space.gi(['add', 'tagged.txt']);
    space.gi(['commit', '--quiet', '-m', 'tagged']);
    space.gi(['tag', 'planted-light']);
    space.gi(['tag', '-a', '-m', 'annotated', 'planted-annotated']);
    space.gi(['update-ref', 'refs/heads/planted-branch', 'HEAD']);
    space.gi(['update-ref', `refs/openchamber/spaces/${OTHER_SPACE_ID}/start`, 'HEAD']);
    // The control: an ordinary fetch of the same result from the space does follow its tags.
    const control = path.join(host.root, 'tag control');
    host.sh(host.root, ['init', '--quiet', control]);
    host.sh(control, ['fetch', '--quiet', space.inside, 'HEAD:refs/heads/fetched']);
    expect(host.sh(control, ['tag', '--list']).split('\n').filter(Boolean).sort()).toEqual(['planted-annotated', 'planted-light']);

    const refs = () => space.g(['for-each-ref', '--format=%(refname)']).split('\n').filter(Boolean);
    const refsBefore = refs();
    await space.out();
    expect(refs()).toEqual([...refsBefore, RESULT].sort());
  });

  it.each([
    ['refuses', 'refuse', null, 'refused by the space'],
    ['prints far more than a fetch does', 'flood', 'command_output_too_large', ''],
  ])('changes nothing when the space %s', async (_, behaviour, cause, printed) => {
    const host = createTestHost();
    const space = await spaceWithCode(host);
    space.local.setBehaviour(behaviour);
    const before = hostState(space.repo);
    const failure = await space.out({ timeoutMs: 20_000 }).catch((error) => error);
    expect(failure).toMatchObject({ code: 'code_out_failed', details: { step: 'fetch into the quarantine', cause } });
    // The space side really ran, with the command the host wrote out.
    expect(space.local.lastCommand().slice(4)).toEqual(['/usr/bin/git', 'upload-pack', space.came.spacePath]);
    expect(failure.message).toContain(printed);
    expect(anyChangeSince(before, space.repo)).toEqual([]);
    expect(leftFolders(host)).toEqual([]);
  });

  it('ends a space that never answers at the host timeout, and leaves no host process and no quarantine behind', async () => {
    const host = createTestHost();
    const space = await spaceWithCode(host);
    space.local.setBehaviour('hang');
    const before = hostState(space.repo);
    const failure = await space.out({ timeoutMs: 3000 }).catch((error) => error);
    expect(failure).toMatchObject({ code: 'code_out_failed', details: { step: 'fetch into the quarantine', cause: 'command_timeout' } });
    const pid = space.local.hangPid();
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
    expect(anyChangeSince(before, space.repo)).toEqual([]);
    expect(leftFolders(host)).toEqual([]);
  });

  // The stand-in sends at about 3 MB/s, so eight random megabytes take close to three seconds. The
  // cap is one: the fetch must be stopped in the middle, which the upload-pack in the space shows by
  // never reporting how it ended.
  it('stops a transfer that passes the size cap in the middle, and nothing reaches the repository', async () => {
    const host = createTestHost();
    const space = await spaceWithCode(host);
    space.write('large.bin', crypto.randomBytes(8 * 1024 * 1024));
    space.local.setBehaviour('slow');
    const before = hostState(space.repo);
    const failure = await space.out({ maxTransferBytes: 1024 * 1024 }).catch((error) => error);
    expect(failure).toMatchObject({ code: 'result_transfer_too_large', details: { step: 'fetch into the quarantine' } });
    expect(space.local.lastCommand()[5]).toBe('upload-pack');
    expect(space.local.uploadPackExit()).toBeNull();
    expect(anyChangeSince(before, space.repo)).toEqual([]);
    expect(leftFolders(host)).toEqual([]);
    // The control: the same space with room for it comes out, and its upload-pack ends normally.
    const out = await space.out();
    expect(out.changedBytes).toBe(8 * 1024 * 1024);
    expect(space.local.uploadPackExit()).toBe('0');
  });

  // The space can move its own result ref between the snapshot and the fetch: a reviewer did it live
  // with a loop inside. What the host reports must describe the object it delivered, so the fetch
  // takes the commit the snapshot said it made, and nothing else. Here the swap happens at the one
  // moment that matters, the moment the snapshot call is over.
  it('refuses a result the space swapped for another between the snapshot and the fetch', async () => {
    const host = createTestHost();
    const space = await spaceWithCode(host);
    space.write('conflict.txt', 'the file the warnings would be about\n');
    // A commit of the agent's with a tree of its own, which it puts in place of the snapshot.
    const blobId = space.gi(['hash-object', '-w', '--stdin'], { input: 'swapped\n' }).trim();
    const tree = space.gi(['mktree'], { input: `100644 blob ${blobId}\tonly-this-file.txt\n` }).trim();
    const swapped = space.gi(['commit-tree', tree, '-p', 'HEAD', '-m', 'swapped']).trim();
    let swap = true;
    const swapping = {
      execArgv: (...args) => space.local.place.execArgv(...args),
      exec: async (...args) => {
        const result = await space.local.place.exec(...args);
        if (swap) space.gi(['update-ref', 'refs/openchamber/result', swapped]);
        return result;
      },
    };
    const codeOut = createCodeOut({ git: host.git, place: swapping, temporaryDirectory: host.root });
    const before = hostState(space.repo);

    const failure = await codeOut.bringCodeOut(space.request()).catch((error) => error);
    expect(failure).toMatchObject({ code: 'result_ref_missing', details: { step: 'fetch into the quarantine' } });
    expect(space.g(['for-each-ref', RESULT])).toBe('');
    expect(anyChangeSince(before, space.repo)).toEqual([]);
    // The control: without the swap the same place brings the result out, and it holds the file the
    // warnings would name, not the one the swap offered.
    swap = false;
    const out = await codeOut.bringCodeOut(space.request());
    expect(blob(space.g, out.result, 'conflict.txt')).toBe('the file the warnings would be about\n');
    expect(space.g(['ls-tree', '--name-only', out.result]).split('\n')).not.toContain('only-this-file.txt');
  });

  it('refuses one object that is not a file and is larger than an object may be', async () => {
    const host = createTestHost();
    const space = await spaceWithCode(host);
    const message = path.join(host.root, 'very-long-message.txt');
    fs.writeFileSync(message, 'a line that says nothing, many times over\n'.repeat(130_000));
    expect(fs.statSync(message).size).toBeGreaterThan(5 * 1024 * 1024);
    space.gi(['commit', '--quiet', '--allow-empty', '-F', message]);
    const before = hostState(space.repo);
    // Far more room than the message needs: the cap of one object is what refuses it.
    const failure = await space.out({ maxChangedBytes: 512 * 1024 * 1024 }).catch((error) => error);
    expect(failure).toMatchObject({ code: 'result_too_large', details: { objectType: 'commit' } });
    expect(failure.details.objectBytes).toBeGreaterThan(5 * 1024 * 1024);
    expect(anyChangeSince(before, space.repo)).toEqual([]);
    // The control: without that commit in its history, a message under the cap comes out.
    space.gi(['update-ref', 'HEAD', space.gi(['rev-parse', 'HEAD~1']).trim()]);
    fs.writeFileSync(message, 'a line that says nothing, many times over\n'.repeat(20_000));
    space.gi(['commit', '--quiet', '--allow-empty', '-F', message]);
    expect(await space.out({ maxChangedBytes: 512 * 1024 * 1024 })).toMatchObject({ result: expect.any(String) });
  }, 60_000);

  // A deletion brings no object at all, and both `diff-tree` and `apply` read the file that goes.
  it('charges what a deletion costs, and refuses to apply what is too large to patch', async () => {
    const host = createTestHost();
    const space = await spaceWithCode(host, {
      repository: (bait) => {
        fs.writeFileSync(path.join(bait.repo, 'large.bin'), crypto.randomBytes(4 * 1024 * 1024));
        bait.g(['add', 'large.bin']);
        bait.g(['commit', '--quiet', '-m', 'a large file of the user']);
        return bait.repo;
      },
    });
    space.gi(['rm', '--quiet', 'large.bin']);
    const out = await space.out();
    expect(out.changedBytes).toBeGreaterThanOrEqual(4 * 1024 * 1024);
    expect(out.newBytes).toBeLessThan(4096);
    const before = hostState(space.repo);
    const failure = await space.codeOut.applyAsChanges({ repository: space.repo, spaceId: SPACE_ID, maxChangedBytes: 1024 * 1024 }).catch((error) => error);
    expect(failure).toMatchObject({ code: 'changes_too_large' });
    expect(failure.message).toMatch(/as a branch/);
    expect(anyChangeSince(before, space.repo)).toEqual([]);
    // The control: with room for it the deletion applies.
    expect(await space.codeOut.applyAsChanges({ repository: space.repo, spaceId: SPACE_ID })).toMatchObject({ status: 'applied' });
    expect(fs.existsSync(path.join(space.repo, 'large.bin'))).toBe(false);
  });

  it('refuses to apply many copies of a file the user already has, which brings almost no object', async () => {
    const host = createTestHost();
    const space = await spaceWithCode(host, {
      repository: (bait) => {
        fs.writeFileSync(path.join(bait.repo, 'host-large.bin'), crypto.randomBytes(1024 * 1024));
        bait.g(['add', 'host-large.bin']);
        bait.g(['commit', '--quiet', '-m', 'a large file of the user']);
        return bait.repo;
      },
    });
    for (let copy = 0; copy < 12; copy += 1) fs.copyFileSync(path.join(space.inside, 'host-large.bin'), path.join(space.inside, `copy-${copy}.bin`));
    const out = await space.out();
    expect(out.changedBytes).toBeGreaterThanOrEqual(12 * 1024 * 1024);
    const before = hostState(space.repo);
    await expect(space.codeOut.applyAsChanges({ repository: space.repo, spaceId: SPACE_ID, maxChangedBytes: 8 * 1024 * 1024 }))
      .rejects.toMatchObject({ code: 'changes_too_large' });
    expect(anyChangeSince(before, space.repo)).toEqual([]);
    expect(await space.codeOut.applyAsChanges({ repository: space.repo, spaceId: SPACE_ID })).toMatchObject({ status: 'applied' });
  });

  // A hook of the agent's prints during the snapshot. Its output must not be read as part of the report.
  // An ordinary-path check: the work still comes out while a hook of the agent's prints. The proofs
  // of the report's channel are the test just below and the live test through /proc.
  it('brings the work out while a hook of the agent prints during the snapshot', async () => {
    const host = createTestHost();
    const space = await spaceWithCode(host);
    const noisy = path.join(space.inside, '.git', 'hooks', 'reference-transaction');
    const marker = path.join(space.inside, 'hook-ran');
    fs.mkdirSync(path.dirname(noisy), { recursive: true });
    fs.writeFileSync(noisy, [
      '#!/bin/sh',
      `: > '${marker}'`,
      'printf "100644 0000000000000000000000000000000000000000 1\\tinvented-by-a-hook.txt\\0"',
      'printf "and a line of its own\\n"',
      'exit 0',
      '',
    ].join('\n'), { mode: 0o755 });
    space.write('real.txt', 'real\n');
    const out = await space.out();
    // The control: the hook really ran and really printed while the snapshot was being made.
    expect(fs.existsSync(marker)).toBe(true);
    expect(out.unmerged).toEqual({ count: 0, paths: [] });
    expect(blob(space.g, out.result, 'real.txt')).toBe('real\n');
  });

  // A hook of the agent's inherits whatever its git has open. It moves the result ref to a commit of
  // its own a moment after the snapshot wrote it, and writes that commit's id on descriptor 3 first,
  // where the report goes. Every command of the snapshot runs with descriptor 3 closed, so the id the
  // host reads is the snapshot's, and the moved ref is refused rather than taken.
  it('does not let a hook write into the report through descriptor 3', async () => {
    const host = createTestHost();
    const space = await spaceWithCode(host);
    const blobId = space.gi(['hash-object', '-w', '--stdin'], { input: 'planted\n' }).trim();
    const tree = space.gi(['mktree'], { input: `100644 blob ${blobId}\tplanted.txt\n` }).trim();
    const planted = space.gi(['commit-tree', tree, '-p', 'HEAD', '-m', 'planted']).trim();
    const hook = path.join(space.inside, '.git', 'hooks', 'reference-transaction');
    const tried = path.join(space.inside, '.git', 'hook-tried-descriptor-3');
    fs.mkdirSync(path.dirname(hook), { recursive: true });
    fs.writeFileSync(hook, [
      '#!/bin/sh',
      '[ "$1" = committed ] || exit 0',
      `[ -e '${tried}' ] && exit 0`,
      `: > '${tried}'`,
      `printf '%s\\n' ${planted} >&3`,
      `( sleep 0.3; git update-ref refs/openchamber/result ${planted} ) &`,
      'exit 0',
      '',
    ].join('\n'), { mode: 0o755 });
    space.write('real.txt', 'real\n');
    const before = hostState(space.repo);
    const failure = await space.out().catch((error) => error);
    // The control: the hook ran on the snapshot's own ref write.
    expect(fs.existsSync(tried)).toBe(true);
    expect(failure).toMatchObject({ code: 'result_ref_missing', details: { step: 'fetch into the quarantine' } });
    expect(anyChangeSince(before, space.repo)).toEqual([]);
  });

  it.skipIf(WIN)('counts a path the space names with a control character, and shows it redacted', async () => {
    const host = createTestHost();
    const space = await spaceWithCode(host);
    // A repository of the agent's whose name holds a line break, and a conflict in a file named the same way.
    space.gi(['init', '--quiet', 'made\nby the agent']);
    space.write('made\nby the agent/inner.txt', 'inner\n');
    const nested = ['-C', path.join(space.inside, 'made\nby the agent')];
    space.gi([...nested, 'add', 'inner.txt']);
    space.gi([...nested, '-c', 'user.name=Agent', '-c', 'user.email=agent@example.invalid', 'commit', '--quiet', '-m', 'inner']);
    space.write('conflicted\nname.txt', 'one\n');
    space.gi(['add', '--', 'conflicted\nname.txt']);
    space.gi(['commit', '--quiet', '-m', 'the agent starts']);
    space.gi(['checkout', '--quiet', '-b', 'side']);
    space.write('conflicted\nname.txt', 'side\n');
    space.gi(['commit', '--quiet', '-am', 'side']);
    space.gi(['checkout', '--quiet', 'main']);
    space.write('conflicted\nname.txt', 'main\n');
    space.gi(['commit', '--quiet', '-am', 'main']);
    expect(space.local.inside(['-C', space.inside, 'merge', 'side']).code).not.toBe(0);

    const out = await space.out();
    expect(out.unmerged.count).toBe(1);
    expect(out.unmerged.paths).toEqual(['conflicted?name.txt']);
    expect(out.nestedRepositories.count).toBe(1);
    expect(out.nestedRepositories.paths).toEqual(['made?by the agent']);
  });

  it('reports what it applied: the nested repositories and the conflict markers in it', async () => {
    const host = createTestHost();
    const space = await spaceWithCode(host);
    space.gi(['init', '--quiet', 'made-by-the-agent']);
    space.write('made-by-the-agent/inner.txt', 'inner\n');
    const nested = ['-C', path.join(space.inside, 'made-by-the-agent')];
    space.gi([...nested, 'add', 'inner.txt']);
    space.gi([...nested, '-c', 'user.name=Agent', '-c', 'user.email=agent@example.invalid', 'commit', '--quiet', '-m', 'inner']);
    space.write('README.md', '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> side\n');
    await space.out();
    const applied = await space.codeOut.applyAsChanges({ repository: space.repo, spaceId: SPACE_ID });
    expect(applied).toMatchObject({
      status: 'applied',
      nestedRepositories: { count: 1, paths: ['made-by-the-agent'] },
      conflicted: { count: 1, paths: ['README.md'] },
    });
  });

  it.each([
    ['a file of zeros that compresses to almost nothing', (space) => space.write('zeros.bin', Buffer.alloc(24 * 1024 * 1024))],
    ['a large file committed and deleted again', (space) => {
      space.write('zeros.bin', Buffer.alloc(24 * 1024 * 1024));
      space.gi(['add', 'zeros.bin']);
      space.gi(['commit', '--quiet', '-m', 'large']);
      space.gi(['rm', '--quiet', 'zeros.bin']);
      space.gi(['commit', '--quiet', '-m', 'gone again']);
    }],
  ])('refuses %s over the changed-bytes cap before it reaches the repository', async (_, make) => {
    const host = createTestHost();
    const space = await spaceWithCode(host, {
      repository: (bait) => {
        fs.writeFileSync(path.join(bait.repo, 'host-large.bin'), crypto.randomBytes(1024 * 1024));
        bait.g(['add', 'host-large.bin']);
        bait.g(['commit', '--quiet', '-m', 'a large file of the user']);
        return bait.repo;
      },
    });
    make(space);
    const before = hostState(space.repo);
    const failure = await space.out({ maxChangedBytes: 8 * 1024 * 1024 }).catch((error) => error);
    expect(failure).toMatchObject({ code: 'result_too_large', details: { step: 'measure the result' } });
    expect(anyChangeSince(before, space.repo)).toEqual([]);
    // The control: with room for it, the same result comes out.
    const out = await space.out({ maxChangedBytes: 64 * 1024 * 1024 });
    expect(space.g(['rev-parse', RESULT]).trim()).toBe(out.result);
  });

  // A commit message and a tree object weigh as much as a file, and repetitive text travels in a pack
  // of a few kilobytes, so neither cap sees it on the way. Both are sized as every other new object.
  it.each([
    ['a huge commit message', (space, host) => {
      const message = path.join(host.root, 'huge-message.txt');
      fs.writeFileSync(message, 'a line that says nothing, many times over\n'.repeat(26_000));
      expect(fs.statSync(message).size).toBeGreaterThan(1024 * 1024);
      space.gi(['commit', '--quiet', '--allow-empty', '-F', message]);
    }],
    ['a tree object with forty thousand entries', (space) => {
      const blobId = space.gi(['hash-object', '-w', '--stdin'], { input: 'one\n' }).trim();
      const entries = [];
      for (let entry = 0; entry < 40_000; entry += 1) {
        entries.push(Buffer.from(`100644 f${String(entry).padStart(6, '0')}\0`), Buffer.from(blobId, 'hex'));
      }
      const tree = space.gi(['hash-object', '-t', 'tree', '--literally', '-w', '--stdin'], { input: Buffer.concat(entries) }).trim();
      space.gi(['update-ref', 'HEAD', space.gi(['commit-tree', tree, '-p', 'HEAD', '-m', 'wide']).trim()]);
    }],
  ])('refuses %s over the changed-bytes cap, although it changes no file', async (_, make) => {
    const host = createTestHost();
    const space = await spaceWithCode(host);
    make(space, host);
    const before = hostState(space.repo);
    const failure = await space.out({ maxChangedBytes: 512 * 1024 }).catch((error) => error);
    expect(failure).toMatchObject({ code: 'result_too_large', details: { step: 'measure the result' } });
    expect(failure.details.newBytes).toBeGreaterThan(512 * 1024);
    expect(anyChangeSince(before, space.repo)).toEqual([]);
    // The control: with room for it, the same result comes out, and it changes no file.
    const out = await space.out({ maxChangedBytes: 8 * 1024 * 1024 });
    expect(out.changedPaths).toBe(0);
    expect(space.g(['rev-parse', RESULT]).trim()).toBe(out.result);
  }, 60_000);

  // A result small enough to arrive between two polls is held to the cap once the fetch is over. The
  // space's own sender ends normally here, which is what tells the two checks apart.
  it('refuses a transfer over the cap that arrived in one piece', async () => {
    const host = createTestHost();
    const space = await spaceWithCode(host);
    space.write('middling.bin', crypto.randomBytes(1536 * 1024));
    const before = hostState(space.repo);
    const failure = await space.out({ maxTransferBytes: 1024 * 1024 }).catch((error) => error);
    expect(failure).toMatchObject({ code: 'result_transfer_too_large', details: { step: 'fetch into the quarantine' } });
    expect(space.local.uploadPackExit(), 'the fetch was stopped in the middle, so this proves nothing about the cap after it').toBe('0');
    expect(anyChangeSince(before, space.repo)).toEqual([]);
  });

  it('reports a repository the agent made inside its project, which travels as a gitlink and nothing else', async () => {
    const host = createTestHost();
    const space = await spaceWithCode(host);
    space.gi(['init', '--quiet', 'made-by-the-agent']);
    space.write('made-by-the-agent/inner.txt', 'inner\n');
    const nested = ['-C', path.join(space.inside, 'made-by-the-agent')];
    space.gi([...nested, 'add', 'inner.txt']);
    space.gi([...nested, '-c', 'user.name=Agent', '-c', 'user.email=agent@example.invalid', 'commit', '--quiet', '-m', 'inner']);
    const out = await space.out();
    expect(out.nestedRepositories).toEqual({ count: 1, paths: ['made-by-the-agent'] });
    expect(out.unmerged).toEqual({ count: 0, paths: [] });
    // What it is in the result: a gitlink, whose commit never travelled.
    expect(space.g(['ls-tree', out.result, 'made-by-the-agent']).split(' ')[0]).toBe('160000');
    await space.codeOut.applyAsChanges({ repository: space.repo, spaceId: SPACE_ID });
    expect(fs.readdirSync(path.join(space.repo, 'made-by-the-agent'))).toEqual([]);
  });

  it('reports the paths the agent left in a conflicted merge, whose markers are in the result as content', async () => {
    const host = createTestHost();
    const space = await spaceWithCode(host);
    space.gi(['add', '--all']);
    space.gi(['commit', '--quiet', '-m', 'the agent starts']);
    space.gi(['checkout', '--quiet', '-b', 'side']);
    space.write('README.md', 'from the side branch\n');
    space.gi(['commit', '--quiet', '-am', 'side']);
    space.gi(['checkout', '--quiet', 'main']);
    space.write('README.md', 'from the main branch\n');
    space.gi(['commit', '--quiet', '-am', 'main']);
    expect(space.local.inside(['-C', space.inside, 'merge', 'side']).code).not.toBe(0);

    const out = await space.out();
    expect(out.unmerged).toEqual({ count: 1, paths: ['README.md'] });
    expect(blob(space.g, out.result, 'README.md')).toContain('<<<<<<<');
    // The second parent of the merge is not in the result: it is one commit on one parent.
    expect(space.g(['rev-list', '--count', '--merges', `${space.came.base}..${out.result}`]).trim()).toBe('0');
  });

  it.each([
    // One content in every file, so there are many paths and only a handful of new objects.
    ['too many changed paths', (space) => { for (let file = 0; file < 150; file += 1) space.write(`many/${file}.txt`, 'the same\n'); }],
    ['too many new objects in its history', (space) => {
      for (let file = 0; file < 150; file += 1) space.write(`many/${file}.txt`, `${file}\n`);
      space.gi(['add', 'many']);
      space.gi(['commit', '--quiet', '-m', 'many']);
      space.gi(['rm', '-r', '--quiet', 'many']);
      space.gi(['commit', '--quiet', '-m', 'none again']);
    }],
  ])('refuses a result with %s', async (_, make) => {
    const host = createTestHost();
    const space = await spaceWithCode(host);
    make(space);
    const before = hostState(space.repo);
    await expect(space.out({ maxChangedEntries: 100 })).rejects.toMatchObject({ code: 'result_too_many_changes', details: { step: 'measure the result' } });
    expect(anyChangeSince(before, space.repo)).toEqual([]);
    await space.out({ maxChangedEntries: 1000 });
  });

  // A second apply brings what is new since the first one, and nothing of it again.
  it('applies only what is new since the last apply, and leaves the user\'s own work beside it alone', async () => {
    const host = createTestHost();
    const space = await spaceWithCode(host);
    const { repo, g } = space;
    space.write('first round.txt', 'first\n');
    const first = await space.out();
    expect(await space.codeOut.applyAsChanges({ repository: repo, spaceId: SPACE_ID })).toMatchObject({ status: 'applied', remembered: true });
    expect(g(['rev-parse', APPLIED]).trim()).toBe(first.result);
    expect(workingTreeAs(host, repo, first.result)).toBe(g(['rev-parse', `${first.result}^{tree}`]).trim());

    // The agent works on, and the user edits a file of their own in the meantime.
    space.write('second round.txt', 'second\n');
    space.write('first round.txt', 'first, changed by the agent\n');
    fs.writeFileSync(path.join(repo, 'only the user.txt'), 'the user wrote this\n');
    const second = await space.out();
    expect(await space.codeOut.applyAsChanges({ repository: repo, spaceId: SPACE_ID })).toMatchObject({ status: 'applied', appliedPaths: 2, remembered: true });
    expect(g(['rev-parse', APPLIED]).trim()).toBe(second.result);
    // Nothing was refused, so the route stays open.
    expect(g(['for-each-ref', CLOSED])).toBe('');
    expect(fs.readFileSync(path.join(repo, 'second round.txt'), 'utf8')).toBe('second\n');
    expect(fs.readFileSync(path.join(repo, 'first round.txt'), 'utf8')).toBe('first, changed by the agent\n');
    expect(fs.readFileSync(path.join(repo, 'only the user.txt'), 'utf8')).toBe('the user wrote this\n');
    // Everything but the user's own file is the second result.
    fs.rmSync(path.join(repo, 'only the user.txt'));
    expect(workingTreeAs(host, repo, second.result)).toBe(g(['rev-parse', `${second.result}^{tree}`]).trim());
  });

  it('has nothing to apply when the same result is applied again', async () => {
    const host = createTestHost();
    const space = await spaceWithCode(host);
    space.write('once.txt', 'once\n');
    await space.out();
    expect(await space.codeOut.applyAsChanges({ repository: space.repo, spaceId: SPACE_ID })).toMatchObject({ status: 'applied' });
    const before = hostState(space.repo);
    expect(await space.codeOut.applyAsChanges({ repository: space.repo, spaceId: SPACE_ID })).toEqual({ status: 'nothing_to_apply' });
    // And again after the same result came out once more.
    await space.out();
    expect(await space.codeOut.applyAsChanges({ repository: space.repo, spaceId: SPACE_ID })).toEqual({ status: 'nothing_to_apply' });
    expect(changedSince(before, space.repo)).toEqual([]);
  });

  it('touches nothing on a second apply that collides with the user\'s own edit, and remembers only what went through', async () => {
    const host = createTestHost();
    const space = await spaceWithCode(host);
    const { repo, g } = space;
    space.write('shared.txt', 'one\n');
    const first = await space.out();
    await space.codeOut.applyAsChanges({ repository: repo, spaceId: SPACE_ID });
    // The user writes their own line where the agent's next change goes.
    fs.writeFileSync(path.join(repo, 'shared.txt'), 'one\nthe user\n');
    space.write('shared.txt', 'one\nthe agent\n');
    await space.out();
    const before = hostState(repo);
    const failure = await space.codeOut.applyAsChanges({ repository: repo, spaceId: SPACE_ID }).catch((error) => error);
    expect(failure).toMatchObject({ code: 'changes_do_not_apply' });
    expect(failure.message).toMatch(/since its work was last applied here/);
    expect(failure.message).toMatch(/applied as a branch/);
    expect(anyChangeSince(before, repo)).toEqual(CLOSURE);
    expect(g(['rev-parse', APPLIED]).trim()).toBe(first.result);
  });

  it('remembers nothing when the first apply is refused, and the branch closes and moves nothing', async () => {
    const host = createTestHost();
    const space = await spaceWithCode(host);
    const { repo, g } = space;
    space.write('tracked-to-edit.txt', 'one\ntwo staged\nthree unstaged\nfrom the space\n');
    const out = await space.out();
    // The user changed the same line first.
    fs.writeFileSync(path.join(repo, 'tracked-to-edit.txt'), 'one\ntwo staged\nthree changed by the user\n');
    await expect(space.codeOut.applyAsChanges({ repository: repo, spaceId: SPACE_ID })).rejects.toMatchObject({ code: 'changes_do_not_apply' });
    expect(g(['for-each-ref', APPLIED])).toBe('');
    // The branch works after that, and moves neither of the two refs.
    await space.codeOut.applyAsBranch({ repository: repo, spaceId: SPACE_ID, branch: 'after-the-refusal' });
    expect(g(['rev-parse', 'refs/heads/after-the-refusal']).trim()).toBe(out.result);
    expect(g(['for-each-ref', APPLIED])).toBe('');
    expect(g(['rev-parse', CLOSED]).trim()).toBe(out.result);
  });

  it('remembers an apply that went through, and a branch on either side of it changes nothing', async () => {
    const host = createTestHost();
    const space = await spaceWithCode(host);
    const { repo, g } = space;
    space.write('from the space.txt', 'from the space\n');
    const out = await space.out();
    await space.codeOut.applyAsBranch({ repository: repo, spaceId: SPACE_ID, branch: 'before-the-apply' });
    expect(g(['for-each-ref', APPLIED])).toBe('');
    expect(await space.codeOut.applyAsChanges({ repository: repo, spaceId: SPACE_ID })).toMatchObject({ status: 'applied' });
    expect(g(['rev-parse', APPLIED]).trim()).toBe(out.result);
    await space.codeOut.applyAsBranch({ repository: repo, spaceId: SPACE_ID, branch: 'after-the-apply' });
    expect(g(['rev-parse', APPLIED]).trim()).toBe(out.result);
    expect(g(['for-each-ref', CLOSED])).toBe('');
  });

  // Once the two have gone apart, this space is applied as a branch, and every later attempt says so.
  it('closes the changes route after a refused round, and refuses at once from then on', async () => {
    const host = createTestHost();
    const space = await spaceWithCode(host);
    const { repo, g } = space;
    space.write('tracked-to-edit.txt', 'one\ntwo staged\nthree unstaged\nfrom the space\n');
    const first = await space.out();
    // The user changed the same line first.
    fs.writeFileSync(path.join(repo, 'tracked-to-edit.txt'), 'one\ntwo staged\nthree changed by the user\n');
    const refused = await space.codeOut.applyAsChanges({ repository: repo, spaceId: SPACE_ID }).catch((error) => error);
    expect(refused).toMatchObject({ code: 'changes_do_not_apply' });
    expect(refused.message).toMatch(/applied as a branch/);
    expect(refused.message).toMatch(/the rounds you already applied included/);
    expect(g(['rev-parse', CLOSED]).trim()).toBe(first.result);

    // Every later attempt: the same answer, without a patch, whatever the project looks like now.
    const patchBuilds = [];
    const watched = {
      run: (directory, args, options) => { patchBuilds.push(args); return host.git.run(directory, args, options); },
      output: (directory, args, options) => { patchBuilds.push(args); return host.git.output(directory, args, options); },
    };
    const watching = createCodeOut({ git: watched, place: space.local.place, temporaryDirectory: host.root });
    // Even with the user's own line back, so a collision would no longer be the reason.
    fs.writeFileSync(path.join(repo, 'tracked-to-edit.txt'), 'one\ntwo staged\nthree unstaged\n');
    const before = hostState(repo);
    const closed = await watching.applyAsChanges({ repository: repo, spaceId: SPACE_ID }).catch((error) => error);
    expect(closed).toMatchObject({ code: 'changes_route_closed' });
    expect(closed.message).toMatch(/no longer applied as uncommitted changes/);
    expect(closed.message).toMatch(/applied as a branch/);
    expect(patchBuilds.some((args) => args.some((argument) => String(argument).startsWith('--output=')))).toBe(false);
    expect(anyChangeSince(before, repo)).toEqual([]);

    // The branch still works, and holds the same commit it would have held before.
    const branch = await space.codeOut.applyAsBranch({ repository: repo, spaceId: SPACE_ID, branch: 'from-the-space' });
    expect(branch.commit).toBe(first.result);
    expect(g(['rev-parse', 'refs/heads/from-the-space']).trim()).toBe(first.result);
    // And it closed nothing more and reopened nothing.
    expect(g(['rev-parse', CLOSED]).trim()).toBe(first.result);

    // A new result of the same space changes nothing about it.
    space.write('more.txt', 'more\n');
    await space.out();
    await expect(space.codeOut.applyAsChanges({ repository: repo, spaceId: SPACE_ID })).rejects.toMatchObject({ code: 'changes_route_closed' });
  });

  // A name Windows cannot hold, made in the space and brought out for real, with the rules of Windows
  // given to code out: refused, nothing touched, the route open, and after the agent renames the file
  // the next bring-out applies.
  it('refuses a name this computer cannot hold, and applies once the agent renamed it', async () => {
    const host = createTestHost();
    const space = await spaceWithCode(host);
    const codeOut = createCodeOut({ git: host.git, place: space.local.place, temporaryDirectory: host.root, platform: 'win32' });
    space.write('aux.txt', 'auxiliary\n');
    await codeOut.bringCodeOut(space.request());
    const before = hostState(space.repo);
    const failure = await codeOut.applyAsChanges({ repository: space.repo, spaceId: SPACE_ID }).catch((error) => error);
    expect(failure).toMatchObject({ code: 'name_not_allowed_here', details: { path: 'aux.txt', rule: 'device_name' } });
    expect(failure.message).toBe('The agent made aux.txt, which has a name this computer cannot hold, so nothing was changed. Have the agent rename it, then bring the work out again.');
    expect(anyChangeSince(before, space.repo)).toEqual([]);
    expect(space.g(['for-each-ref', CLOSED])).toBe('');

    fs.renameSync(path.join(space.inside, 'aux.txt'), path.join(space.inside, 'auxiliary.txt'));
    await codeOut.bringCodeOut(space.request());
    expect(await codeOut.applyAsChanges({ repository: space.repo, spaceId: SPACE_ID })).toMatchObject({ status: 'applied' });
    expect(fs.readFileSync(path.join(space.repo, 'auxiliary.txt'), 'utf8')).toBe('auxiliary\n');
    expect(fs.existsSync(path.join(space.repo, 'aux.txt'))).toBe(false);
  });

  it('refuses bad requests before it asks the space anything', async () => {
    const host = createTestHost();
    const { repo, g } = makeBait(host);
    const asked = [];
    const place = { execArgv: async (...args) => { asked.push(args); return []; }, exec: async (...args) => { asked.push(args); return { code: 1, stdout: '', stderr: '' }; } };
    const codeOut = host.codeOut(place);
    const request = { repository: repo, spaceId: SPACE_ID, spacePath: `/spaces/${SPACE_ID}/bait-repo-` };
    await expect(codeOut.bringCodeOut(request)).rejects.toMatchObject({ code: 'space_start_missing' });
    g(['update-ref', START, 'HEAD']);
    for (const [extra, code] of [
      [{ spacePath: `/spaces/${SPACE_ID}/../elsewhere` }, 'invalid_space_path'],
      [{ spacePath: `/spaces/${OTHER_SPACE_ID}/bait-repo-` }, 'invalid_space_path'],
      [{ spaceId: 'not an id' }, 'invalid_space_id'],
      [{ timeoutMs: 10 }, 'invalid_timeout'],
      [{ innerMarginSeconds: 0 }, 'invalid_inner_margin'],
      [{ maxTransferBytes: 0 }, 'invalid_limit'],
      [{ maxChangedBytes: 1.5 }, 'invalid_limit'],
      [{ maxChangedEntries: '100' }, 'invalid_limit'],
      [{ repository: path.join(host.root, 'not here') }, 'project_folder_missing'],
    ]) {
      await expect(codeOut.bringCodeOut({ ...request, ...extra })).rejects.toMatchObject({ code });
    }
    await expect(codeOut.bringCodeOut(undefined)).rejects.toMatchObject({ code: 'invalid_space_id' });
    expect(asked).toEqual([]);
  });

  it('turns a space that cannot be reached, and a snapshot that fails inside, into code_out_failed with the cause', async () => {
    const host = createTestHost();
    const space = await spaceWithCode(host);
    const gone = { execArgv: async () => { throw new SpaceError('space_not_found', 'no such space'); }, exec: async () => { throw new SpaceError('space_not_found', 'no such space'); } };
    await expect(host.codeOut(gone).bringCodeOut(space.request())).rejects.toMatchObject({ code: 'code_out_failed', details: { step: 'reach the space', cause: 'space_not_found' } });
    // The agent left the repository on a branch with no commit.
    space.gi(['checkout', '--quiet', '--orphan', 'empty']);
    const before = hostState(space.repo);
    await expect(space.out()).rejects.toMatchObject({ code: 'code_out_failed', details: { step: 'snapshot the space', cause: 'inside_command_failed' } });
    expect(anyChangeSince(before, space.repo)).toEqual([]);
    expect(leftFolders(host)).toEqual([]);
  });

  it('keeps the error of the work when the temporary folder cannot be removed, and names the folder', async () => {
    const host = createTestHost();
    const space = await spaceWithCode(host);
    space.local.setBehaviour('refuse');
    const stuck = createCodeOut({ git: host.git, place: space.local.place, temporaryDirectory: host.root, removeDirectory: async () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); } });
    const failure = await stuck.bringCodeOut(space.request()).catch((error) => error);
    expect(failure).toMatchObject({ code: 'code_out_failed', details: { step: 'fetch into the quarantine' } });
    expect(failure.details.temporaryDirectoryLeft).toEqual(expect.stringContaining('openchamber-code-out-'));
  });

  it('works in a SHA-256 repository', async () => {
    const host = createTestHost();
    const space = await spaceWithCode(host, { objectFormat: 'sha256' });
    space.write('sha256.txt', 'sha256\n');
    const out = await space.out();
    expect(out.result).toMatch(/^[0-9a-f]{64}$/);
    await space.codeOut.applyAsChanges({ repository: space.repo, spaceId: SPACE_ID });
    expect(workingTreeAs(host, space.repo, out.result)).toBe(space.g(['rev-parse', `${out.result}^{tree}`]).trim());
  });

  it('comes out into a project in a subfolder and into a linked worktree', async () => {
    const host = createTestHost();
    const space = await spaceWithCode(host, {
      repository: (bait) => {
        bait.g(['worktree', 'add', '--quiet', '-b', 'feature', path.join(host.root, 'linked')]);
        fs.mkdirSync(path.join(host.root, 'linked', 'app'));
        fs.writeFileSync(path.join(host.root, 'linked', 'app', 'index.js'), 'app\n');
        return path.join(host.root, 'linked', 'app');
      },
    });
    const linked = path.join(host.root, 'linked');
    space.write('app/index.js', 'app, changed in the space\n');
    space.write('top.txt', 'top\n');
    const out = await space.codeOut.bringCodeOut(space.request({ repository: path.join(linked, 'app') }));
    await space.codeOut.applyAsChanges({ repository: path.join(linked, 'app'), spaceId: SPACE_ID });
    expect(fs.readFileSync(path.join(linked, 'top.txt'), 'utf8')).toBe('top\n');
    expect(workingTreeAs(host, linked, out.result)).toBe(space.g(['rev-parse', `${out.result}^{tree}`]).trim());
    expect(host.sh(linked, ['symbolic-ref', 'HEAD']).trim()).toBe('refs/heads/feature');
  });

  it('runs none of the user\'s hooks and no fsmonitor program on the host, bringing out or applying', async () => {
    const host = createTestHost();
    const hooks = path.join(host.root, 'global hooks');
    const markers = path.join(host.root, 'markers');
    fs.mkdirSync(hooks);
    fs.mkdirSync(markers);
    for (const name of HOOK_NAMES) {
      fs.writeFileSync(path.join(hooks, name), `#!/bin/sh\ntouch '${markers}/${name}'\ncat > /dev/null 2>&1 || true\n`, { mode: 0o755 });
    }
    // git runs an fsmonitor program through the shell, so its path has no space in it.
    const fsmonitor = path.join(host.root, 'fsmonitor.sh');
    fs.writeFileSync(fsmonitor, `#!/bin/sh\ntouch '${markers}/fsmonitor'\nexit 1\n`, { mode: 0o755 });
    const space = await spaceWithCode(host);
    host.addConfig(`[core]\n\thooksPath = ${forConfig(hooks)}\n\tfsmonitor = ${forConfig(fsmonitor)}`);
    // The control, in a copy: with this config a ref write, an index write and a status run them.
    const control = makeBait(host, { name: 'control' });
    control.g(['update-ref', 'refs/heads/control', 'HEAD']);
    control.g(['add', 'untracked plain.txt']);
    control.g(['status', '--porcelain']);
    expect(fs.readdirSync(markers)).toEqual(expect.arrayContaining(['reference-transaction', 'post-index-change', 'fsmonitor']));
    for (const marker of fs.readdirSync(markers)) fs.rmSync(path.join(markers, marker));

    space.write('from the space.txt', 'x\n');
    await space.out();
    await space.codeOut.applyAsBranch({ repository: space.repo, spaceId: SPACE_ID, branch: 'from-the-space' });
    await space.codeOut.applyAsChanges({ repository: space.repo, spaceId: SPACE_ID });
    expect(fs.readdirSync(markers)).toEqual([]);
  });

  // A fetch runs `maintenance --auto` and can write a commit graph. Neither may touch the user's `.git`.
  it('starts no automatic gc or maintenance and writes no commit graph, even for a user who asks for them', async () => {
    const host = createTestHost();
    const space = await spaceWithCode(host);
    const packs = (repo) => fs.readdirSync(path.join(repo, '.git', 'objects', 'pack')).filter((file) => file.endsWith('.pack')).sort();
    const twoPacks = ({ repo, g }) => {
      g(['repack', '-q', '-d']);
      g(['commit', '--quiet', '--allow-empty', '-m', 'a second pack']);
      g(['repack', '-q', '-d']);
      expect(packs(repo)).toHaveLength(2);
    };
    const control = makeBait(host, { name: 'control' });
    twoPacks(space);
    twoPacks(control);
    host.addConfig([
      '[gc]', '\tauto = 1', '\tautoDetach = false', '\tautoPackLimit = 1',
      '[maintenance]', '\tauto = true', '\tautoDetach = false', '\tstrategy = gc',
      '[maintenance "gc"]', '\tenabled = true',
      '[fetch]', '\twriteCommitGraph = true',
    ].join('\n'));
    // The control, in the copy: an ordinary fetch consolidates the packs and writes a commit graph.
    // Plain git for the fetch, not `control.g`: the setup git opts out of maintenance, which is what
    // the control proves. The clone and the commit that give it something to fetch are setup.
    const source = path.join(host.root, 'fetch source');
    host.sh(host.root, ['clone', '--quiet', control.repo, source]);
    host.sh(source, ['commit', '--quiet', '--allow-empty', '-m', 'new']);
    const fetched = spawnSync('git', ['-C', control.repo, 'fetch', '--quiet', source, 'HEAD:refs/heads/fetched'], { env: host.environment, encoding: 'utf8', windowsHide: true });
    expect(fetched.status, fetched.stderr).toBe(0);
    expect(packs(control.repo).length).toBeLessThan(2);
    expect(fs.existsSync(path.join(control.repo, '.git', 'objects', 'info', 'commit-graph')) || fs.existsSync(path.join(control.repo, '.git', 'objects', 'info', 'commit-graphs'))).toBe(true);

    const kept = packs(space.repo);
    space.write('from the space.txt', 'x\n');
    const before = hostState(space.repo);
    await space.out();
    expect(packs(space.repo)).toEqual(expect.arrayContaining(kept));
    expect(changedSince(before, space.repo)).toEqual([]);
  });
});
