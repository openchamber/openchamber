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
const APPLIED_FROM = `refs/openchamber/spaces/${SPACE_ID}/applied-from`;
const APPLYING_FROM = `refs/openchamber/spaces/${SPACE_ID}/applying-from`;
const APPLIED_HEAD = `refs/openchamber/spaces/${SPACE_ID}/applied-head`;
const APPLYING_HEAD = `refs/openchamber/spaces/${SPACE_ID}/applying-head`;
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
    g(['update-ref', APPLIED_FROM, 'HEAD~1']);
    g(['update-ref', APPLYING_FROM, 'HEAD~1']);
    g(['update-ref', APPLIED_HEAD, 'HEAD~1']);
    g(['update-ref', APPLYING_HEAD, 'HEAD~1']);
    const before = hostState(repo);
    g(['repack', '-q', '-n']);
    g(['update-ref', RESULT, 'HEAD']);
    g(['update-ref', APPLIED, 'HEAD']);
    g(['update-ref', CLOSED, 'HEAD']);
    g(['update-ref', APPLYING, 'HEAD']);
    g(['update-ref', APPLIED_FROM, 'HEAD']);
    g(['update-ref', APPLYING_FROM, 'HEAD']);
    g(['update-ref', APPLIED_HEAD, 'HEAD']);
    g(['update-ref', APPLYING_HEAD, 'HEAD']);
    const added = Object.keys(hostState(repo)).filter((name) => /^\.git\/objects\/pack\/pack-/.test(name) && before[name] === undefined);
    expect(added.length).toBeGreaterThan(0);
    expect(changedSince(before, repo)).toEqual([]);
    // Without the code out allowance, the same changes all show.
    expect(unexpectedChanges(before, hostState(repo), { spaceIds: [SPACE_ID] }))
      .toEqual([...added, ...['applied', 'applied-from', 'applied-head', 'applying', 'applying-from', 'applying-head', 'changes-closed', 'result'].map((name) => `.git/refs/openchamber/spaces/${SPACE_ID}/${name}`)].sort());
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
    // Nothing in `.git` but the refs that remember what was applied, from where, and HEAD then.
    expect(unexpectedChanges(gitOnly(before), gitOnly(hostState(repo)), { spaceIds: [SPACE_ID], codeOut: true })).toEqual([]);
    expect(unexpectedChanges(gitOnly(before), gitOnly(hostState(repo)))).toEqual(['applied', 'applied-from', 'applied-head'].map((name) => `.git/refs/openchamber/spaces/${SPACE_ID}/${name}`));
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
      // The intent went with the closure, in the same transaction, so nothing reports it as interrupted.
      expect(failure.details.recorded).toBe(true);
      expect(g(['for-each-ref', APPLYING])).toBe('');
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
    run: (directory, args, options) => (breaks(args, options) ? Promise.resolve({ code: 128, stdout: '', stderr: 'fatal: broken on purpose\n' }) : host.git.run(directory, args, options)),
    output: async (directory, args, options) => {
      if (breaks(args, options)) throw new SpaceError('git_command_failed', 'git diff-tree failed: fatal: unable to generate diff', { exitCode: 128 });
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
    const record = (args, options) => args.includes('update-ref') && String(options?.stdin ?? '').startsWith(`update ${APPLIED} `);
    const codeOut = createCodeOut({ git: gitBreaking(host, record), place: null, temporaryDirectory: host.root });
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

  // The patch deletes the link `Lnk` and writes into `lnk`: on a disk that ignores case, `lstat` of
  // `lnk` finds the link, which the patch does not delete under that spelling.
  it('passes over a link the patch deletes only under the exact spelling the patch deletes', async () => {
    const check = fakes({ lnk: link });
    expect(await firstRedirectedFolder(root, ['lnk/evil.txt'], { ignoreCase: true, deletedLinks: ['Lnk'], ...check })).toBe('lnk');
    expect(await firstRedirectedFolder(root, ['lnk/evil.txt'], { ignoreCase: true, deletedLinks: ['lnk'], ...check })).toBeNull();
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

  // Every path of the patch is walked, whatever comes before it: a file at the top, with no folder on
  // its way, and a path through plain folders first.
  it('looks at every path, not only the first, and past a path with no folder on its way', async () => {
    const check = fakes({ plain: folder, 'plain/deeper': folder, a: folder, 'a/b': link });
    expect(await firstRedirectedFolder(root, ['top.txt', 'plain/deeper/file.txt', 'a/b/c/file.txt'], check)).toBe('a/b');
    const elsewhere = fakes({ plain: folder, a: folder }, { a: path.join(path.sep, 'elsewhere') });
    expect(await firstRedirectedFolder(root, ['top.txt', 'plain/file.txt', 'a/file.txt'], elsewhere)).toBe('a');
  });

  it('passes over a link the patch deletes as a link, and no other', async () => {
    const check = fakes({ lib: link, other: link });
    expect(await firstRedirectedFolder(root, ['lib', 'lib/own.txt'], { ...check, deletedLinks: ['lib'] })).toBeNull();
    // The control: the same link, with the patch deleting a different one, or none.
    expect(await firstRedirectedFolder(root, ['lib/own.txt'], { ...check, deletedLinks: ['other'] })).toBe('lib');
    expect(await firstRedirectedFolder(root, ['lib/own.txt'], check)).toBe('lib');
  });

  // realpath reports the name as the disk stores it, which on APFS may be another case-folded spelling.
  it('takes a spelling the disk folds together with git\'s for the same folder where the repository ignores case', async () => {
    const check = fakes({ 'straße': folder }, { 'straße': path.join(root, 'STRASSE') });
    expect(await firstRedirectedFolder(root, ['straße/file.txt'], { ignoreCase: true, ...check })).toBeNull();
    expect(await firstRedirectedFolder(root, ['straße/file.txt'], check)).toBe('straße');
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

  // APFS ignores the form wherever it ignores case, so ignoring case alone is enough for it too.
  it('takes the two Unicode spellings of an accent for one name where the repository precomposes or ignores case', () => {
    const composed = 'caf\u00e9.txt';
    const decomposed = 'cafe\u0301.txt';
    expect(nameNotAllowedHere([composed], [decomposed, composed], { precompose: true })).toMatchObject({ rule: 'differs_only_in_case' });
    expect(nameNotAllowedHere([composed], [decomposed, composed], blind)).toMatchObject({ rule: 'differs_only_in_case' });
    // The control: where the repository does neither, the two are two names.
    expect(nameNotAllowedHere([composed], [decomposed, composed])).toBeNull();
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

  // Each pair is one name on APFS, checked on a real disk below. Lowering alone kept each apart.
  const APFS_PAIRS = [['strasse.txt', 'straße.txt'], ['σ.txt', 'ς.txt'], ['fi.txt', 'ﬁ.txt'], ['s.txt', 'ſ.txt'], ['β.txt', 'ϐ.txt'], ['ΑΣ.txt', 'ασ.txt'], ['ss.txt', 'ẞ.txt']];

  it.each(APFS_PAIRS)('takes %j and %j for one name where the repository ignores case', (one, other) => {
    expect(nameNotAllowedHere([other], [one, other], blind)).toMatchObject({ path: other, rule: 'differs_only_in_case', other: one });
    expect(nameNotAllowedHere([other], [other], { ...blind, deleted: [one] })).toMatchObject({ path: other, rule: 'case_only_rename', other: one });
    // Where case counts, the two are two names.
    expect(nameNotAllowedHere([other], [one, other])).toBeNull();
  });

  it.skipIf(process.platform !== 'darwin')('folds at least as wide as this Mac\'s disk, for each pair', () => {
    const host = createTestHost();
    const probe = path.join(host.root, 'fold-probe');
    fs.mkdirSync(probe);
    fs.writeFileSync(path.join(probe, 'Case.txt'), '');
    // The control: this test means something only on a disk that ignores case.
    expect(fs.existsSync(path.join(probe, 'case.txt')), 'the test folder is on a disk that ignores case').toBe(true);
    for (const [one, other] of APFS_PAIRS) {
      const folder = fs.mkdtempSync(path.join(probe, 'pair-'));
      fs.writeFileSync(path.join(folder, one), '');
      expect(fs.existsSync(path.join(folder, other)), `the disk takes ${one} and ${other} for one name`).toBe(true);
      expect(nameNotAllowedHere([other], [one, other], blind), `the check takes ${one} and ${other} for one name`).not.toBeNull();
    }
  });

  it('refuses a path whose whole length, the project\'s folder included, passes 1023 bytes', () => {
    const top = `/home/${'p'.repeat(60)}`;
    // 66 + 1 + 956 = 1023 bytes, then one more.
    const fits = `${'folder/'.repeat(136)}ffff`;
    expect(Buffer.byteLength(path.posix.join(top, fits))).toBe(1023);
    for (const platform of ['darwin', 'linux']) {
      expect(nameNotAllowedHere([fits], [fits], { platform, top })).toBeNull();
      expect(nameNotAllowedHere([`${fits}f`], [`${fits}f`], { platform, top })).toMatchObject({ rule: 'path_too_long' });
    }
  });

  it('holds Windows to 259 characters for a file and 247 for the folder it goes into, unless core.longpaths', () => {
    const top = 'C:\\p';
    // 4 + 1 + 254 = 259 characters for the file, in a folder of 4 + 1 + 242 = 247.
    const folder = `${'d'.repeat(120)}/${'e'.repeat(121)}`;
    const file = `${folder}/${'f'.repeat(11)}`;
    expect(path.win32.join(top, file).length).toBe(259);
    expect(path.win32.join(top, folder).length).toBe(247);
    const check = (created, extra = {}) => nameNotAllowedHere([created], [created], { platform: 'win32', top, ...extra });
    expect(check(file)).toBeNull();
    expect(check(`${file}f`)).toMatchObject({ rule: 'path_too_long' });
    // One more character in the folder, the file no longer.
    const deeper = `${folder}e/${'f'.repeat(10)}`;
    expect(path.win32.join(top, deeper).length).toBe(259);
    expect(check(deeper)).toMatchObject({ rule: 'path_too_long' });
    expect(check(`${file}f`, { longPaths: true })).toBeNull();
    expect(check(deeper, { longPaths: true })).toBeNull();
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
      changesRoute: 'open', result, lastApplied: null, newPaths: WIN ? 5 : 6, newPathsOverLimit: false, newPathsUndecided: false, interruptedApply: false,
    });
    expect(anyChangeSince(before, repo)).toEqual([]);
    await host.codeOut().applyAsChanges({ repository: repo, spaceId: SPACE_ID });
    expect(await host.codeOut().describeApplyState({ repository: repo, spaceId: SPACE_ID })).toMatchObject({ lastApplied: result, newPaths: 0 });
    g(['update-ref', APPLYING, result]);
    expect(await host.codeOut().describeApplyState({ repository: repo, spaceId: SPACE_ID })).toMatchObject({ changesRoute: 'open', interruptedApply: true });
    // An intent beside a closed route is not reported: nothing applies as changes there any more.
    g(['update-ref', CLOSED, result]);
    expect(await host.codeOut().describeApplyState({ repository: repo, spaceId: SPACE_ID })).toMatchObject({ changesRoute: 'closed', interruptedApply: false });
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

/**
 * A result made with git's plumbing on top of the space's start, for shapes a disk cannot easily
 * hold or would take long to make. `files` maps a path to its content, each under a new top-level
 * folder. `chains` adds `count` top-level folders `x0`, `x1` and so on, which all hold one and the
 * same tree: `depth` folders `a`, one inside the other, with a file `f` at the bottom.
 */
const treeResult = async (host, { files = {}, chains = null } = {}) => {
  const bait = makeBait(host);
  await host.codeIn().takeSnapshot({ repository: bait.repo, spaceId: SPACE_ID, mode: 'uncommitted' });
  const mktree = (entries) => bait.g(['mktree', '-z'], { input: entries.map((entry) => `${entry}\0`).join('') }).trim();
  const blobOf = (content) => bait.g(['hash-object', '-w', '--stdin'], { input: content }).trim();
  const build = (entries) => {
    const here = [];
    const below = new Map();
    for (const [names, content] of entries) {
      if (names.length === 1) {
        here.push(`100644 blob ${blobOf(content)}\t${names[0]}`);
      } else {
        if (!below.has(names[0])) below.set(names[0], []);
        below.get(names[0]).push([names.slice(1), content]);
      }
    }
    for (const [name, inner] of below) here.push(`040000 tree ${mktree(build(inner))}\t${name}`);
    return here;
  };
  const top = bait.g(['ls-tree', '-z', START]).split('\0').filter(Boolean);
  top.push(...build(Object.entries(files).map(([file, content]) => [file.split('/'), content])));
  let tree = mktree(top);
  if (chains) {
    // Every chain in one `fast-import`: a `mktree` per folder cost 90 ms a process on Windows, 36 s for
    // a chain 400 deep, which alone passed the test's time there.
    const TEMPORARY = `refs/test-chains-${crypto.randomBytes(4).toString('hex')}`;
    const lines = [`commit ${TEMPORARY}`, 'committer t <t@example.invalid> 0 +0000', 'data 6', 'chains', `from ${bait.g(['commit-tree', tree, '-m', 'base']).trim()}`];
    const chain = Array(chains.depth).fill('a').join('/');
    for (let index = 0; index < chains.count; index += 1) lines.push(`M 100644 inline x${index}/${chain}/f`, 'data 2', 'f');
    bait.g(['fast-import', '--quiet'], { input: `${lines.join('\n')}\n\n` });
    tree = bait.g(['rev-parse', `${TEMPORARY}^{tree}`]).trim();
    bait.g(['update-ref', '-d', TEMPORARY]);
  }
  const commit = bait.g(['commit-tree', tree, '-p', START, '-m', 'plumbed']).trim();
  bait.g(['update-ref', RESULT, commit]);
  // In a pack, as a fetch leaves them: git reads a deep tree of loose objects many times slower.
  bait.g(['repack', '-a', '-d', '-q']);
  return { ...bait, result: commit };
};

/** A file of `lines` lines, `line 1` to `line <lines>`, with `changes` put in by line number. */
const numbered = (lines, changes = {}) => Array.from({ length: lines }, (_, index) => changes[index + 1] ?? `line ${index + 1}`).join('\n').concat('\n');

/** Applies the patch from the space's start to `result` to the working tree, as an apply the host did not live to record would have. */
const applyByHand = (host, g, snapshot, result) => {
  const patch = path.join(host.root, `by-hand-${crypto.randomBytes(4).toString('hex')}.patch`);
  g(['diff-tree', '-r', '-p', '--binary', '--full-index', `--output=${forConfig(patch)}`, snapshot.start, result]);
  g(['apply', '--binary', forConfig(patch)]);
};

describe('applyAsChanges after round five', () => {
  // Twenty thousand files five hundred folders deep, in one shared tree, passed every cap and ran the
  // host out of memory in the checks before an apply. The folders count against a cap of their own.
  it('refuses a change through more folders than the cap before anything is built, touches nothing, and the branch holds it', async () => {
    const host = createTestHost();
    const { repo, g, result } = await treeResult(host, { chains: { count: 30, depth: 5 } });
    const before = hostState(repo);
    const failure = await host.codeOut().applyAsChanges({ repository: repo, spaceId: SPACE_ID, maxChangedEntries: 100 }).catch((error) => error);
    expect(failure).toMatchObject({ code: 'changes_too_large', details: { limit: 100 } });
    expect(failure.message).toBe('The work of the space is too large to apply as uncommitted changes: it changes files in more than 100 folders. Nothing was changed. Apply it as a branch instead.');
    expect(anyChangeSince(before, repo)).toEqual([]);
    expect(leftFolders(host)).toEqual([]);
    expect(await host.codeOut().applyAsBranch({ repository: repo, spaceId: SPACE_ID, branch: 'deep' })).toEqual({ branch: 'deep', commit: result });
    // The control: 30 paths and 180 folders, within caps of 200.
    expect(await host.codeOut().applyAsChanges({ repository: repo, spaceId: SPACE_ID, maxChangedEntries: 200 })).toMatchObject({ status: 'applied', appliedPaths: 30 });
    expect(g(['for-each-ref', CLOSED])).toBe('');
  });

  // Within the folder cap, but so deep that every look at a folder and every file written walks a long
  // way down: two chains of 100 folders are 200 folders and 10,300 steps.
  it('refuses a change whose folders lie too deep in all, and applies it with room for it', async () => {
    const host = createTestHost();
    const { repo, g } = await treeResult(host, { chains: { count: 2, depth: 99 } });
    // Paths two hundred characters long and more: on Windows the path rule would refuse them before the
    // steps are counted, and git there writes them only with core.longpaths. Elsewhere it changes nothing.
    g(['config', 'core.longpaths', 'true']);
    const before = hostState(repo);
    const failure = await host.codeOut().applyAsChanges({ repository: repo, spaceId: SPACE_ID, maxChangedEntries: 200 }).catch((error) => error);
    expect(failure).toMatchObject({ code: 'changes_too_large', details: { limit: 6400 } });
    expect(failure.message).toBe('The work of the space is too large to apply as uncommitted changes: it changes files so deep among so many folders that reaching them all takes more than 6400 steps from a folder into the next. Nothing was changed. Apply it as a branch instead.');
    expect(anyChangeSince(before, repo)).toEqual([]);
    expect(await host.codeOut().applyAsChanges({ repository: repo, spaceId: SPACE_ID, maxChangedEntries: 400 })).toMatchObject({ status: 'applied', appliedPaths: 2 });
  });

  it('refuses at the default cap the shape that ran the host out of memory, and does so quickly', async () => {
    const host = createTestHost();
    // 300 paths 401 folders deep, which are 120,300 folders, from 404 objects.
    const { repo } = await treeResult(host, { chains: { count: 300, depth: 400 } });
    const before = hostState(repo);
    const started = Date.now();
    await expect(host.codeOut().applyAsChanges({ repository: repo, spaceId: SPACE_ID }))
      .rejects.toMatchObject({ code: 'changes_too_large', message: expect.stringContaining('Apply it as a branch instead.') });
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(anyChangeSince(before, repo)).toEqual([]);
  });

  // A tracked link that the space turned into a folder: git apply deletes the link first, so the
  // link is not in the way. A link of the user's that the patch does not delete still is.
  it.skipIf(WIN)('applies a folder where the patch deletes a tracked link, and keeps refusing a link it does not delete', async () => {
    const host = createTestHost();
    const { repo, g } = await hostResult(host, {
      prepare: ({ repo: bait, g: bg }) => {
        fs.symlinkSync('somewhere', path.join(bait, 'lib'));
        bg(['add', 'lib']);
        bg(['commit', '--quiet', '-m', 'a link', '--', 'lib']);
      },
      edit: (scratch) => {
        fs.rmSync(path.join(scratch, 'lib'));
        fs.mkdirSync(path.join(scratch, 'lib'));
        fs.writeFileSync(path.join(scratch, 'lib', 'own.txt'), 'own\n');
      },
    });
    expect(await host.codeOut().applyAsChanges({ repository: repo, spaceId: SPACE_ID })).toMatchObject({ status: 'applied' });
    expect(fs.lstatSync(path.join(repo, 'lib')).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(repo, 'lib', 'own.txt'), 'utf8')).toBe('own\n');
    expect(g(['for-each-ref', CLOSED])).toBe('');
  });

  // Two applies of one space at once each passed the dry run, then the second found its patch no
  // longer fitting and closed the route.
  it('lets two applies of one space at once take turns: one applies, the other has nothing left', async () => {
    const host = createTestHost();
    const { repo, g, result } = await hostResult(host, { edit: ordinaryEdit });
    const outcomes = await Promise.all([
      host.codeOut().applyAsChanges({ repository: repo, spaceId: SPACE_ID }),
      host.codeOut().applyAsChanges({ repository: repo, spaceId: SPACE_ID }),
      host.codeOut().describeApplyState({ repository: repo, spaceId: SPACE_ID }),
    ]);
    expect(outcomes.slice(0, 2).map((outcome) => outcome.status).sort()).toEqual(['applied', 'nothing_to_apply']);
    // The read takes its turn too, before or after the applies, and never sees one under way.
    expect(outcomes[2]).toMatchObject({ changesRoute: 'open', interruptedApply: false });
    expect(g(['rev-parse', APPLIED]).trim()).toBe(result);
    expect(g(['for-each-ref', CLOSED, APPLYING])).toBe('');
    expect(workingTreeAs(host, repo, result)).toBe(g(['rev-parse', `${result}^{tree}`]).trim());
  });

  describe('an apply the host did not live to record, with an edit of the user\'s since', () => {
    const longResult = (host, extra = {}) => hostResult(host, {
      prepare: ({ repo, g }) => {
        fs.writeFileSync(path.join(repo, 'long.txt'), numbered(20));
        fs.writeFileSync(path.join(repo, 'other.txt'), 'other\n');
        g(['add', 'long.txt', 'other.txt']);
        g(['commit', '--quiet', '-m', 'long files of the user', '--', 'long.txt', 'other.txt']);
      },
      edit: (scratch) => {
        fs.writeFileSync(path.join(scratch, 'long.txt'), numbered(20, { 2: 'line 2 from the space' }));
        fs.writeFileSync(path.join(scratch, 'other.txt'), 'other from the space\n');
      },
      ...extra,
    });
    const userEdit = (repo) => {
      const file = path.join(repo, 'long.txt');
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('line 18\n', 'line 18 of the user\n'));
    };

    it('takes an attempt that wrote nothing for one never started, and applies beside the edit', async () => {
      const host = createTestHost();
      const { repo, g, result } = await longResult(host);
      g(['update-ref', APPLYING, result]);
      userEdit(repo);
      expect(await host.codeOut().applyAsChanges({ repository: repo, spaceId: SPACE_ID })).toMatchObject({ status: 'applied' });
      expect(fs.readFileSync(path.join(repo, 'long.txt'), 'utf8')).toBe(numbered(20, { 2: 'line 2 from the space', 18: 'line 18 of the user' }));
      expect(g(['rev-parse', APPLIED]).trim()).toBe(result);
      expect(g(['for-each-ref', APPLYING, CLOSED])).toBe('');
    });

    it('takes an attempt that wrote everything for a finished one, with the edit beside it', async () => {
      const host = createTestHost();
      const { repo, g, result, snapshot } = await longResult(host);
      g(['update-ref', APPLYING, result]);
      applyByHand(host, g, snapshot, result);
      userEdit(repo);
      const before = hostState(repo);
      // Read first: it counts from what the working tree holds, and changes nothing.
      expect(await host.codeOut().describeApplyState({ repository: repo, spaceId: SPACE_ID })).toMatchObject({ interruptedApply: true, lastApplied: null, newPaths: 0 });
      expect(anyChangeSince(before, repo)).toEqual([]);
      expect(await host.codeOut().applyAsChanges({ repository: repo, spaceId: SPACE_ID })).toEqual({ status: 'nothing_to_apply' });
      expect(g(['rev-parse', APPLIED]).trim()).toBe(result);
      expect(g(['for-each-ref', APPLYING, CLOSED])).toBe('');
    });

    // `git apply` wrote one file and not the other. The file it wrote takes the same insertion a second
    // time, among lines that repeat, so the dry run alone would call the attempt never started.
    it('does not take a file the attempt wrote for one it never wrote, where its lines repeat', async () => {
      const host = createTestHost();
      const repeated = (withNew) => `${'x\n'.repeat(4)}${withNew ? 'new\n' : ''}${'x\n'.repeat(16)}`;
      const { repo, g, result } = await longResult(host, {
        prepare: ({ repo: bait, g: bg }) => {
          fs.writeFileSync(path.join(bait, 'repeated.txt'), repeated(false));
          fs.writeFileSync(path.join(bait, 'other.txt'), 'other\n');
          bg(['add', 'repeated.txt', 'other.txt']);
          bg(['commit', '--quiet', '-m', 'files of the user', '--', 'repeated.txt', 'other.txt']);
        },
        edit: (scratch) => {
          fs.writeFileSync(path.join(scratch, 'repeated.txt'), repeated(true));
          fs.writeFileSync(path.join(scratch, 'other.txt'), 'other from the space\n');
        },
      });
      g(['update-ref', APPLYING, result]);
      fs.writeFileSync(path.join(repo, 'repeated.txt'), repeated(true));
      const failure = await host.codeOut().applyAsChanges({ repository: repo, spaceId: SPACE_ID }).catch((error) => error);
      expect(failure).toMatchObject({ code: 'changes_partly_applied', details: { interrupted: true, recorded: true } });
      expect(fs.readFileSync(path.join(repo, 'repeated.txt'), 'utf8')).toBe(repeated(true));
    });

    // The intent names an older result than the one there now: the route closes at what was being
    // applied, and the intent goes in the same transaction.
    it('closes the route at the interrupted result, not at a newer one, and drops the intent with it', async () => {
      const host = createTestHost();
      const { repo, g, result: interrupted } = await longResult(host);
      g(['update-ref', APPLYING, interrupted]);
      fs.writeFileSync(path.join(repo, 'other.txt'), 'other from the space\n');
      const newer = g(['commit-tree', `${interrupted}^{tree}`, '-p', interrupted, '-m', 'a later round']).trim();
      g(['update-ref', RESULT, newer]);
      const failure = await host.codeOut().applyAsChanges({ repository: repo, spaceId: SPACE_ID }).catch((error) => error);
      expect(failure).toMatchObject({ code: 'changes_partly_applied', details: { interrupted: true, recorded: true } });
      expect(g(['rev-parse', CLOSED]).trim()).toBe(interrupted);
      expect(g(['for-each-ref', APPLYING])).toBe('');
    });
  });

  it('does not report an intent beside a closed route as an interrupted apply', async () => {
    const host = createTestHost();
    const { repo, g, result } = await hostResult(host, { edit: ordinaryEdit });
    g(['update-ref', APPLYING, result]);
    g(['update-ref', CLOSED, result]);
    expect(await host.codeOut().describeApplyState({ repository: repo, spaceId: SPACE_ID })).toMatchObject({ changesRoute: 'closed', interruptedApply: false });
  });

  it('says what was exceeded when the list of changed paths is longer than the host reads, and describes that honestly', async () => {
    const host = createTestHost();
    const { repo, result } = await hostResult(host, { edit: ordinaryEdit });
    const listing = (args) => args.includes('diff-tree') && args.includes('-z') && !args.includes('-p');
    const git = {
      run: (directory, args, options) => host.git.run(directory, args, options),
      output: async (directory, args, options) => {
        if (listing(args)) throw new SpaceError('command_output_too_large', 'git diff-tree printed more than 67108864 bytes and was stopped');
        return host.git.output(directory, args, options);
      },
    };
    const codeOut = createCodeOut({ git, place: null, temporaryDirectory: host.root });
    const before = hostState(repo);
    const failure = await codeOut.applyAsChanges({ repository: repo, spaceId: SPACE_ID }).catch((error) => error);
    expect(failure).toMatchObject({ code: 'changes_too_large', details: { limit: 64 * 1024 * 1024 } });
    expect(failure.message).toBe('The work of the space is too large to apply as uncommitted changes: it changes so many paths that their list is longer than 67108864 bytes. Nothing was changed. Apply it as a branch instead.');
    expect(await codeOut.describeApplyState({ repository: repo, spaceId: SPACE_ID })).toEqual({
      changesRoute: 'open', result, lastApplied: null, newPaths: null, newPathsOverLimit: true, newPathsUndecided: false, interruptedApply: false,
    });
    expect(anyChangeSince(before, repo)).toEqual([]);
  });

  // Windows limits a whole path to 259 characters unless the repository has `core.longpaths`, which
  // the apply reads from the repository itself.
  it('refuses a path too long for Windows, touches nothing, keeps the route open, and applies it once the repository has core.longpaths', async () => {
    const host = createTestHost();
    const deep = `${'folder-of-twenty-six-chars/'.repeat(10)}file.txt`;
    const { repo, g } = await treeResult(host, { files: { [deep]: 'deep\n' } });
    const codeOut = createCodeOut({ git: host.git, place: null, temporaryDirectory: host.root, platform: 'win32' });
    const before = hostState(repo);
    const failure = await codeOut.applyAsChanges({ repository: repo, spaceId: SPACE_ID }).catch((error) => error);
    expect(failure).toMatchObject({ code: 'name_not_allowed_here', details: { path: deep, rule: 'path_too_long' } });
    expect(failure.message).toBe(`The agent made ${deep}, which is a path too long for this computer, in your project's folder, so nothing was changed. Have the agent rename it, then bring the work out again.`);
    expect(anyChangeSince(before, repo)).toEqual([]);
    g(['config', 'core.longpaths', 'true']);
    expect(await codeOut.applyAsChanges({ repository: repo, spaceId: SPACE_ID })).toMatchObject({ status: 'applied' });
  });

  // Within the 1024 bytes a path may have below the project, and past what the host can open once the
  // project's own path is in front of it.
  it.skipIf(WIN)('refuses a path that is too long only with the project\'s folder in front of it, with a clear message', async () => {
    const host = createTestHost();
    const deep = `${`${'d'.repeat(99)}/`.repeat(9)}${'f'.repeat(90)}`;
    expect(Buffer.byteLength(deep)).toBeLessThanOrEqual(1023);
    const { repo, g } = await treeResult(host, { files: { [deep]: 'deep\n' } });
    expect(Buffer.byteLength(path.join(repo, deep))).toBeGreaterThan(1023);
    const before = hostState(repo);
    const failure = await host.codeOut().applyAsChanges({ repository: repo, spaceId: SPACE_ID }).catch((error) => error);
    expect(failure).toMatchObject({ code: 'name_not_allowed_here', details: { rule: 'path_too_long' } });
    expect(anyChangeSince(before, repo)).toEqual([]);
    expect(g(['for-each-ref', CLOSED])).toBe('');
  });
});

/**
 * Rounds of a space's work, made on the host: the bait with files of ten lines committed, `own`, the
 * space's start from code in, and `round(files)`, which writes `files` into a scratch checkout of the
 * work so far, null taking one out, commits, and makes that commit the space's result. `putBack`
 * does what a user who throws an apply away does: puts `paths` back in the working tree as `treeish`
 * has them, and removes the ones it does not have.
 */
const roundsResult = async (host, own = ['one.txt', 'two.txt', 'three.txt'], { prepare } = {}) => {
  const bait = makeBait(host);
  prepare?.(bait);
  for (const name of own) fs.writeFileSync(path.join(bait.repo, name), numbered(10));
  bait.g(['add', ...own]);
  bait.g(['commit', '--quiet', '-m', 'files of the user', '--', ...own]);
  const snapshot = await host.codeIn().takeSnapshot({ repository: bait.repo, spaceId: SPACE_ID, mode: 'uncommitted' });
  const scratch = path.join(host.root, `scratch-${crypto.randomBytes(4).toString('hex')}`);
  host.sh(host.root, ['init', '--quiet', scratch]);
  const s = (args) => host.sh(scratch, args);
  s(['fetch', '--quiet', '--no-write-fetch-head', bait.repo, `${START}:refs/heads/work`]);
  s(['checkout', '--quiet', 'work']);
  const round = (files) => {
    for (const [name, content] of Object.entries(files)) {
      if (content === null) {
        fs.rmSync(path.join(scratch, name));
      } else {
        fs.mkdirSync(path.dirname(path.join(scratch, name)), { recursive: true });
        fs.writeFileSync(path.join(scratch, name), content);
      }
    }
    s(['add', '--all']);
    s(['commit', '--quiet', '--allow-empty', '-m', 'a round of the agent']);
    bait.g(['fetch', '--quiet', '--no-write-fetch-head', scratch, `refs/heads/work:${RESULT}`]);
    return bait.g(['rev-parse', RESULT]).trim();
  };
  const putBack = (treeish, paths) => {
    for (const name of paths) {
      const file = path.join(bait.repo, name);
      if (bait.g(['ls-tree', '--name-only', treeish, '--', name]).trim() === '') fs.rmSync(file);
      else fs.writeFileSync(file, bait.g(['show', `${treeish}:${name}`]));
    }
  };
  return { ...bait, start: snapshot.start, round, putBack };
};

// The maintainer's decision of 2026-09-25: the user applies, dislikes it, throws it all away, has the
// agent redo it, and applies again. When the working tree holds no trace of the last apply, the next
// one brings the whole work again from before it, and the route stays open.
describe('applyAsChanges after the user threw an apply away', () => {
  const firstRound = { 'one.txt': numbered(10, { 3: 'line 3 from round one' }), 'added.txt': 'added in round one\n' };
  // The redo changes the line of one.txt that round one changed, so the ordinary patch does not apply
  // once round one is gone, and changes two.txt besides.
  const redo = { 'one.txt': numbered(10, { 3: 'line 3 redone' }), 'two.txt': numbered(10, { 5: 'line 5 redone' }) };
  const firstApplied = async (host) => {
    const work = await roundsResult(host);
    const first = work.round(firstRound);
    expect(await host.codeOut().applyAsChanges({ repository: work.repo, spaceId: SPACE_ID })).toMatchObject({ status: 'applied', appliedPaths: 2 });
    expect(work.g(['rev-parse', APPLIED_FROM]).trim()).toBe(work.start);
    return { ...work, first };
  };
  const describeState = (host, repo) => host.codeOut().describeApplyState({ repository: repo, spaceId: SPACE_ID });

  it('brings the whole work again after the last apply was thrown away, and keeps the route open', async () => {
    const host = createTestHost();
    const { repo, g, start, round, putBack } = await firstApplied(host);
    putBack(start, ['one.txt', 'added.txt']);
    const second = round(redo);
    // The ordinary patch, from what was applied, has two paths; the whole work has three.
    expect(g(['diff-tree', '-r', '--name-only', APPLIED, second]).trim().split('\n')).toHaveLength(2);
    const before = hostState(repo);
    expect(await describeState(host, repo)).toMatchObject({ changesRoute: 'open', newPaths: 3, interruptedApply: false });
    expect(anyChangeSince(before, repo)).toEqual([]);
    expect(await host.codeOut().applyAsChanges({ repository: repo, spaceId: SPACE_ID })).toMatchObject({ status: 'applied', appliedPaths: 3, remembered: true });
    for (const name of ['one.txt', 'two.txt', 'added.txt']) expect(fs.readFileSync(path.join(repo, name), 'utf8')).toBe(g(['show', `${second}:${name}`]));
    expect(g(['rev-parse', APPLIED]).trim()).toBe(second);
    expect(g(['rev-parse', APPLIED_FROM]).trim()).toBe(start);
    expect(g(['for-each-ref', CLOSED, APPLYING, APPLYING_FROM])).toBe('');
    expect(await describeState(host, repo)).toMatchObject({ changesRoute: 'open', lastApplied: second, newPaths: 0 });
  });

  // The redo also takes out the file round one added, and the user kept that file. The whole work
  // from the start would apply, since it does not touch that file, and leave it behind: it is not
  // taken, because part of the last apply is still there, and the message names both parts.
  it('refuses and closes the route when only part of the last apply was thrown away, naming what is gone and what is there', async () => {
    const host = createTestHost();
    const { repo, g, start, round, putBack } = await firstApplied(host);
    putBack(start, ['one.txt']);
    const second = round({ ...redo, 'added.txt': null });
    expect(g(['diff-tree', '-r', '--name-only', start, second]).trim().split('\n')).toEqual(['one.txt', 'two.txt']);
    expect(await describeState(host, repo)).toMatchObject({ newPaths: 3 });
    const before = hostState(repo);
    const failure = await host.codeOut().applyAsChanges({ repository: repo, spaceId: SPACE_ID }).catch((error) => error);
    expect(failure).toMatchObject({
      code: 'changes_do_not_apply',
      details: { thrownAway: { count: 1, paths: ['one.txt'] }, stillThere: { count: 1, paths: ['added.txt'] } },
    });
    expect(failure.message).toBe('You threw away part of what was last applied from this space: one.txt is back as before, while added.txt is still there or changed since. An apply now would leave out what you threw away without a word, so nothing was changed. From now on this space is applied as a branch, which holds its whole work, the rounds you already applied included. Before you merge that branch or switch to it, remove or commit the files of this space that are still in your project, or git will refuse.');
    expect(anyChangeSince(before, repo)).toEqual(CLOSURE);
    expect(g(['rev-parse', CLOSED]).trim()).toBe(second);
  });

  it('brings the whole work again beside an edit of the user\'s on a file the last apply did not touch', async () => {
    const host = createTestHost();
    const { repo, g, start, round, putBack } = await firstApplied(host);
    putBack(start, ['one.txt', 'added.txt']);
    fs.writeFileSync(path.join(repo, 'three.txt'), numbered(10, { 7: 'line 7 of the user' }));
    fs.writeFileSync(path.join(repo, 'the user\'s own.txt'), 'own\n');
    const second = round(redo);
    expect(await describeState(host, repo)).toMatchObject({ newPaths: 3 });
    expect(await host.codeOut().applyAsChanges({ repository: repo, spaceId: SPACE_ID })).toMatchObject({ status: 'applied', appliedPaths: 3 });
    expect(fs.readFileSync(path.join(repo, 'one.txt'), 'utf8')).toBe(g(['show', `${second}:one.txt`]));
    expect(fs.readFileSync(path.join(repo, 'three.txt'), 'utf8')).toBe(numbered(10, { 7: 'line 7 of the user' }));
    expect(fs.readFileSync(path.join(repo, 'the user\'s own.txt'), 'utf8')).toBe('own\n');
    expect(g(['for-each-ref', CLOSED])).toBe('');
  });

  // The user threw round one away and then edited another line of one of its files. The whole work
  // from the start would apply beside that edit; it is not taken, because that path is not back as it was.
  it('refuses when the user edited a path the last apply changed, even where the whole work would fit', async () => {
    const host = createTestHost();
    const { repo, g, start, round, putBack } = await firstApplied(host);
    putBack(start, ['one.txt', 'added.txt']);
    fs.writeFileSync(path.join(repo, 'one.txt'), numbered(10, { 9: 'line 9 of the user' }));
    const second = round(redo);
    expect(await describeState(host, repo)).toMatchObject({ newPaths: 2 });
    const before = hostState(repo);
    await expect(host.codeOut().applyAsChanges({ repository: repo, spaceId: SPACE_ID })).rejects.toMatchObject({ code: 'changes_do_not_apply' });
    expect(anyChangeSince(before, repo)).toEqual(CLOSURE);
    expect(g(['rev-parse', CLOSED]).trim()).toBe(second);
  });

  it('brings only the last round again when only the last of two applies was thrown away', async () => {
    const host = createTestHost();
    const { repo, g, first, round, putBack } = await firstApplied(host);
    const second = round({ 'two.txt': numbered(10, { 5: 'line 5 from round two' }) });
    expect(await host.codeOut().applyAsChanges({ repository: repo, spaceId: SPACE_ID })).toMatchObject({ status: 'applied', appliedPaths: 1 });
    expect(g(['rev-parse', APPLIED_FROM]).trim()).toBe(first);
    putBack(first, ['two.txt']);
    const third = round({ 'two.txt': numbered(10, { 5: 'line 5 redone' }), 'three.txt': numbered(10, { 1: 'line 1 redone' }) });
    expect(second).not.toBe(third);
    expect(await describeState(host, repo)).toMatchObject({ newPaths: 2 });
    expect(await host.codeOut().applyAsChanges({ repository: repo, spaceId: SPACE_ID })).toMatchObject({ status: 'applied', appliedPaths: 2 });
    // Round one stays as it was applied, and round two comes again as redone.
    for (const name of ['one.txt', 'added.txt', 'two.txt', 'three.txt']) expect(fs.readFileSync(path.join(repo, name), 'utf8')).toBe(g(['show', `${third}:${name}`]));
    expect(g(['rev-parse', APPLIED]).trim()).toBe(third);
    expect(g(['rev-parse', APPLIED_FROM]).trim()).toBe(first);
    expect(g(['for-each-ref', CLOSED])).toBe('');
  });

  it('takes the ordinary way when nothing was thrown away, and remembers where each apply came from', async () => {
    const host = createTestHost();
    const { repo, g, first, round } = await firstApplied(host);
    const second = round({ 'two.txt': numbered(10, { 5: 'line 5 from round two' }) });
    expect(await describeState(host, repo)).toMatchObject({ newPaths: 1 });
    expect(await host.codeOut().applyAsChanges({ repository: repo, spaceId: SPACE_ID })).toMatchObject({ status: 'applied', appliedPaths: 1 });
    expect(fs.readFileSync(path.join(repo, 'one.txt'), 'utf8')).toBe(firstRound['one.txt']);
    expect(g(['rev-parse', APPLIED]).trim()).toBe(second);
    expect(g(['rev-parse', APPLIED_FROM]).trim()).toBe(first);
  });

  // After a discard the whole work comes again even where the patch from the last apply would fit:
  // the redo touches only a file round one did not, and round one must not be lost with it.
  it('brings the whole work again after a discard even where the patch from the last apply would fit', async () => {
    const host = createTestHost();
    const { repo, g, start, round, putBack } = await firstApplied(host);
    putBack(start, ['one.txt', 'added.txt']);
    const second = round({ 'three.txt': numbered(10, { 1: 'line 1 from round two' }) });
    expect(g(['diff-tree', '-r', '--name-only', APPLIED, second]).trim()).toBe('three.txt');
    expect(await describeState(host, repo)).toMatchObject({ newPaths: 3 });
    expect(await host.codeOut().applyAsChanges({ repository: repo, spaceId: SPACE_ID })).toMatchObject({ status: 'applied', appliedPaths: 3 });
    for (const name of ['one.txt', 'added.txt', 'three.txt']) expect(fs.readFileSync(path.join(repo, name), 'utf8')).toBe(g(['show', `${second}:${name}`]));
    expect(g(['rev-parse', APPLIED_FROM]).trim()).toBe(start);
    expect(g(['for-each-ref', CLOSED])).toBe('');
  });

  // Thrown away and asked for again, with nothing new brought out: the same result applies again.
  it('applies the same result again after it was thrown away', async () => {
    const host = createTestHost();
    const { repo, g, start, first, putBack } = await firstApplied(host);
    putBack(start, ['one.txt', 'added.txt']);
    expect(await describeState(host, repo)).toMatchObject({ lastApplied: first, newPaths: 2 });
    expect(await host.codeOut().applyAsChanges({ repository: repo, spaceId: SPACE_ID })).toMatchObject({ status: 'applied', appliedPaths: 2 });
    for (const name of ['one.txt', 'added.txt']) expect(fs.readFileSync(path.join(repo, name), 'utf8')).toBe(g(['show', `${first}:${name}`]));
    expect(g(['rev-parse', APPLIED]).trim()).toBe(first);
    expect(g(['rev-parse', APPLIED_FROM]).trim()).toBe(start);
    // Kept this time: nothing more to apply.
    expect(await host.codeOut().applyAsChanges({ repository: repo, spaceId: SPACE_ID })).toEqual({ status: 'nothing_to_apply' });
  });

  it('behaves as before in a repository that never recorded where the last apply came from', async () => {
    const host = createTestHost();
    const { repo, g, start, round, putBack } = await firstApplied(host);
    g(['update-ref', '-d', APPLIED_FROM]);
    putBack(start, ['one.txt', 'added.txt']);
    round(redo);
    expect(await describeState(host, repo)).toMatchObject({ newPaths: 2 });
    await expect(host.codeOut().applyAsChanges({ repository: repo, spaceId: SPACE_ID })).rejects.toMatchObject({ code: 'changes_do_not_apply' });
  });

  it('holds the whole work to the caps, and refuses it as too large with the route open', async () => {
    const host = createTestHost();
    const { repo, g, start, round, putBack } = await firstApplied(host);
    putBack(start, ['one.txt', 'added.txt']);
    round(redo);
    // Two paths pass a cap of two; the three of the whole work do not.
    const before = hostState(repo);
    const failure = await host.codeOut().applyAsChanges({ repository: repo, spaceId: SPACE_ID, maxChangedEntries: 2 }).catch((error) => error);
    expect(failure).toMatchObject({ code: 'changes_too_large', details: { limit: 2 } });
    expect(anyChangeSince(before, repo)).toEqual([]);
    expect(await host.codeOut().applyAsChanges({ repository: repo, spaceId: SPACE_ID })).toMatchObject({ status: 'applied', appliedPaths: 3 });
  });

  describe('an apply of the whole work the host did not live to record', () => {
    /** Code out whose `git apply`, the real one and not the dry run, ends the call as a host that died would: before it runs, or right after. */
    const dying = (host, { afterApply }) => createCodeOut({
      git: {
        output: (directory, args, options) => host.git.output(directory, args, options),
        run: async (directory, args, options) => {
          if (!(args.includes('apply') && !args.includes('--check'))) return host.git.run(directory, args, options);
          if (afterApply) await host.git.run(directory, args, options);
          throw new Error('the host went away');
        },
      },
      place: null,
      temporaryDirectory: host.root,
    });
    const discarded = async (host) => {
      const work = await firstApplied(host);
      work.putBack(work.start, ['one.txt', 'added.txt']);
      return { ...work, second: work.round(redo) };
    };

    it('finishes the record, from where that apply came from, when it wrote everything', async () => {
      const host = createTestHost();
      const { repo, g, start, second } = await discarded(host);
      await expect(dying(host, { afterApply: true }).applyAsChanges({ repository: repo, spaceId: SPACE_ID })).rejects.toThrow();
      expect(g(['rev-parse', APPLYING]).trim()).toBe(second);
      expect(g(['rev-parse', APPLYING_FROM]).trim()).toBe(start);
      expect(await describeState(host, repo)).toMatchObject({ interruptedApply: true, newPaths: 0 });
      expect(await host.codeOut().applyAsChanges({ repository: repo, spaceId: SPACE_ID })).toEqual({ status: 'nothing_to_apply' });
      expect(g(['rev-parse', APPLIED]).trim()).toBe(second);
      expect(g(['rev-parse', APPLIED_FROM]).trim()).toBe(start);
      expect(g(['for-each-ref', APPLYING, APPLYING_FROM, CLOSED])).toBe('');
    });

    it('forgets it when it wrote nothing, and brings the whole work again', async () => {
      const host = createTestHost();
      const { repo, g, start, second } = await discarded(host);
      await expect(dying(host, { afterApply: false }).applyAsChanges({ repository: repo, spaceId: SPACE_ID })).rejects.toThrow();
      expect(g(['rev-parse', APPLYING_FROM]).trim()).toBe(start);
      expect(await describeState(host, repo)).toMatchObject({ interruptedApply: true, newPaths: 3 });
      expect(await host.codeOut().applyAsChanges({ repository: repo, spaceId: SPACE_ID })).toMatchObject({ status: 'applied', appliedPaths: 3 });
      expect(g(['rev-parse', APPLIED]).trim()).toBe(second);
      expect(g(['rev-parse', APPLIED_FROM]).trim()).toBe(start);
      expect(g(['for-each-ref', APPLYING, APPLYING_FROM, CLOSED])).toBe('');
    });

    it('closes the route and drops both halves of the intent when it stopped halfway', async () => {
      const host = createTestHost();
      const { repo, g, second } = await discarded(host);
      await expect(dying(host, { afterApply: false }).applyAsChanges({ repository: repo, spaceId: SPACE_ID })).rejects.toThrow();
      fs.writeFileSync(path.join(repo, 'added.txt'), 'added in round one\n');
      const failure = await host.codeOut().applyAsChanges({ repository: repo, spaceId: SPACE_ID }).catch((error) => error);
      expect(failure).toMatchObject({ code: 'changes_partly_applied', details: { interrupted: true, recorded: true } });
      expect(g(['rev-parse', CLOSED]).trim()).toBe(second);
      expect(g(['for-each-ref', APPLYING, APPLYING_FROM])).toBe('');
    });
  });
});

// Round seven: "thrown away" is decided from authoritative state, and a part thrown away is never
// passed over in silence. See `decideBase` in code-out.js and decision 7 in DESIGN.md.
describe('applyAsChanges after round six', () => {
  const firstRound = { 'one.txt': numbered(10, { 3: 'line 3 from round one' }), 'added.txt': 'added in round one\n' };
  const firstApplied = async (host, own) => {
    const work = await roundsResult(host, own);
    const first = work.round(firstRound);
    expect(await host.codeOut().applyAsChanges({ repository: work.repo, spaceId: SPACE_ID })).toMatchObject({ status: 'applied', appliedPaths: 2 });
    return { ...work, first };
  };
  const describeState = (host, repo, codeOut = host.codeOut()) => codeOut.describeApplyState({ repository: repo, spaceId: SPACE_ID });
  const apply = (host, repo, codeOut = host.codeOut()) => codeOut.applyAsChanges({ repository: repo, spaceId: SPACE_ID });
  const isRealApply = (args) => args.includes('apply') && !args.includes('--check');
  /** Code out whose real `git apply` ends the call as a host that died would: before it runs, or right after. */
  const dying = (host, { afterApply }) => createCodeOut({
    git: {
      output: (directory, args, options) => host.git.output(directory, args, options),
      run: async (directory, args, options) => {
        if (!isRealApply(args)) return host.git.run(directory, args, options);
        if (afterApply) await host.git.run(directory, args, options);
        throw new Error('the host went away');
      },
    },
    place: null,
    temporaryDirectory: host.root,
  });
  /** Code out whose git fails the calls `breaks` picks, as a git that cannot write would. */
  const breaking = (host, breaks) => createCodeOut({
    git: {
      run: (directory, args, options) => (breaks(args, options) ? Promise.resolve({ code: 128, stdout: '', stderr: 'fatal: broken\n' }) : host.git.run(directory, args, options)),
      output: async (directory, args, options) => {
        if (breaks(args, options)) throw new SpaceError('git_command_failed', 'git failed: broken', { exitCode: 128 });
        return host.git.output(directory, args, options);
      },
    },
    place: null,
    temporaryDirectory: host.root,
  });

  // The bot's probe: `git restore .` puts back what round one changed and leaves the file it added,
  // and the redo touches only another file, so the patch from the last apply fits. Applied, the part
  // the user threw away would have been gone without a word.
  it('refuses a part thrown away even where the redo touches only other files, and names both parts', async () => {
    const host = createTestHost();
    const { repo, g, round } = await firstApplied(host);
    g(['restore', '.']);
    const second = round({ 'three.txt': numbered(10, { 1: 'line 1 redone' }) });
    expect(g(['diff-tree', '-r', '--name-only', APPLIED, second]).trim()).toBe('three.txt');
    const before = hostState(repo);
    const failure = await apply(host, repo).catch((error) => error);
    expect(failure).toMatchObject({
      code: 'changes_do_not_apply',
      details: { thrownAway: { count: 1, paths: ['one.txt'] }, stillThere: { count: 1, paths: ['added.txt'] } },
    });
    expect(failure.message).toMatch(/^You threw away part of what was last applied from this space: one\.txt is back as before, while added\.txt is still there or changed since\./);
    expect(failure.message).toMatch(/the rounds you already applied included\. Before you merge that branch or switch to it, remove or commit the files of this space that are still in your project, or git will refuse\.$/);
    expect(anyChangeSince(before, repo)).toEqual(CLOSURE);
    expect(g(['rev-parse', CLOSED]).trim()).toBe(second);
  });

  // An edit is not a throw-away: the path holds neither side, and the rest of the apply is there.
  it('takes an edit of the user\'s on a file of the last apply for kept, and brings only what is new', async () => {
    const host = createTestHost();
    const { repo, g, first, round } = await firstApplied(host);
    fs.writeFileSync(path.join(repo, 'one.txt'), numbered(10, { 3: 'line 3 from round one', 9: 'line 9 of the user' }));
    round({ 'three.txt': numbered(10, { 1: 'line 1 redone' }) });
    expect(await describeState(host, repo)).toMatchObject({ newPaths: 1 });
    expect(await apply(host, repo)).toMatchObject({ status: 'applied', appliedPaths: 1 });
    expect(fs.readFileSync(path.join(repo, 'one.txt'), 'utf8')).toBe(numbered(10, { 3: 'line 3 from round one', 9: 'line 9 of the user' }));
    expect(g(['rev-parse', APPLIED_FROM]).trim()).toBe(first);
    expect(g(['for-each-ref', CLOSED])).toBe('');
  });

  // Both of two applies thrown away: the patch from before the last one assumes round one, so it
  // either failed its dry run and closed, or applied without round one and said nothing.
  it('brings the whole work from the start when every apply was thrown away', async () => {
    const host = createTestHost();
    const { repo, g, start, first, round, putBack } = await firstApplied(host);
    round({ 'two.txt': numbered(10, { 5: 'line 5 from round two' }) });
    expect(await apply(host, repo)).toMatchObject({ status: 'applied', appliedPaths: 1 });
    expect(g(['rev-parse', APPLIED_FROM]).trim()).toBe(first);
    putBack(start, ['one.txt', 'added.txt', 'two.txt']);
    const third = round({ 'three.txt': numbered(10, { 1: 'line 1 from round three' }) });
    const before = hostState(repo);
    expect(await describeState(host, repo)).toMatchObject({ changesRoute: 'open', newPaths: 4 });
    expect(anyChangeSince(before, repo)).toEqual([]);
    expect(await apply(host, repo)).toMatchObject({ status: 'applied', appliedPaths: 4 });
    for (const name of ['one.txt', 'added.txt', 'two.txt', 'three.txt']) expect(fs.readFileSync(path.join(repo, name), 'utf8')).toBe(g(['show', `${third}:${name}`]));
    expect(g(['rev-parse', APPLIED_FROM]).trim()).toBe(start);
    expect(g(['for-each-ref', CLOSED])).toBe('');
  });

  // The user committed round one: that is keeping it. Its files put back as before it afterwards hold
  // the side before the apply, but a commit of the user's since changed them, so each is the user's own
  // edit, and the whole work does not come again.
  it('takes the files of a last apply the user committed for kept, even where they look as before it', async () => {
    const host = createTestHost();
    const { repo, g, start, first, round, putBack } = await firstApplied(host);
    expect(g(['rev-parse', APPLIED_HEAD]).trim()).toBe(g(['rev-parse', 'HEAD']).trim());
    g(['add', 'one.txt', 'added.txt']);
    g(['commit', '--quiet', '-m', 'round one, kept', '--', 'one.txt', 'added.txt']);
    putBack(start, ['one.txt', 'added.txt']);
    const second = round({ 'three.txt': numbered(10, { 1: 'line 1 from round two' }) });
    expect(await describeState(host, repo)).toMatchObject({ newPaths: 1 });
    expect(await apply(host, repo)).toMatchObject({ status: 'applied', appliedPaths: 1 });
    expect(fs.readFileSync(path.join(repo, 'one.txt'), 'utf8')).toBe(g(['show', `${start}:one.txt`]));
    expect(fs.existsSync(path.join(repo, 'added.txt'))).toBe(false);
    expect(g(['rev-parse', APPLIED]).trim()).toBe(second);
    expect(g(['rev-parse', APPLIED_FROM]).trim()).toBe(first);
    expect(g(['rev-parse', APPLIED_HEAD]).trim()).toBe(g(['rev-parse', 'HEAD']).trim());
  });

  // Committed, then one file of it deleted: a commit of the user's added that file, so the deletion is
  // the user's own edit, not a throw-away, and nothing is refused for it; only the dry run decides.
  it('takes a file deleted after the user committed the last apply for an edit, and lets the dry run decide', async () => {
    const host = createTestHost();
    const { repo, g, round } = await firstApplied(host);
    g(['add', 'one.txt', 'added.txt']);
    g(['commit', '--quiet', '-m', 'round one, kept', '--', 'one.txt', 'added.txt']);
    fs.rmSync(path.join(repo, 'added.txt'));
    const second = round({ 'three.txt': numbered(10, { 1: 'line 1 from round two' }) });
    expect(await describeState(host, repo)).toMatchObject({ newPaths: 1 });
    expect(await apply(host, repo)).toMatchObject({ status: 'applied', appliedPaths: 1 });
    expect(fs.existsSync(path.join(repo, 'added.txt'))).toBe(false);
    expect(g(['rev-parse', APPLIED]).trim()).toBe(second);
    expect(g(['for-each-ref', CLOSED])).toBe('');
    // A redo that touches the deleted file does not fit, the ordinary refusal.
    const third = round({ 'added.txt': 'added and redone\n' });
    const before = hostState(repo);
    const failure = await apply(host, repo).catch((error) => error);
    expect(failure).toMatchObject({ code: 'changes_do_not_apply', details: { exitCode: 1 } });
    expect(failure.message).toMatch(/^The work of the space does not fit your project any more: your project changed since its work was last applied here/);
    expect(anyChangeSince(before, repo)).toEqual(CLOSURE);
    expect(g(['rev-parse', CLOSED]).trim()).toBe(third);
  });

  // A last apply that changed only a gitlink leaves nothing the comparison can see, which is no
  // evidence that it is gone: the whole work came again on every later apply.
  it('takes a last apply that changed only a gitlink for kept', async () => {
    const host = createTestHost();
    const { repo, g, start } = await roundsResult(host);
    const commitWith = (base, entries) => {
      const names = entries.map(([, name]) => name);
      const kept = g(['ls-tree', '-z', base]).split('\0').filter(Boolean).filter((entry) => !names.includes(entry.slice(entry.indexOf('\t') + 1)));
      const tree = g(['mktree', '-z'], { input: [...kept, ...entries.map(([entry]) => entry)].map((entry) => `${entry}\0`).join('') }).trim();
      const commit = g(['commit-tree', tree, '-p', base, '-m', 'plumbed']).trim();
      g(['update-ref', RESULT, commit]);
      return commit;
    };
    const first = commitWith(start, [[`160000 commit ${start}\tnested`, 'nested']]);
    expect(await apply(host, repo)).toMatchObject({ status: 'applied', appliedPaths: 1 });
    const second = commitWith(first, [[`160000 commit ${g(['rev-parse', 'HEAD']).trim()}\tnested`, 'nested']]);
    expect(await apply(host, repo)).toMatchObject({ status: 'applied', appliedPaths: 1 });
    expect(g(['rev-parse', APPLIED_FROM]).trim()).toBe(first);
    const three = g(['hash-object', '-w', '--stdin'], { input: numbered(10, { 1: 'line 1 from round three' }) }).trim();
    commitWith(second, [[`100644 blob ${three}\tthree.txt`, 'three.txt']]);
    expect(await describeState(host, repo)).toMatchObject({ newPaths: 1 });
    expect(await apply(host, repo)).toMatchObject({ status: 'applied', appliedPaths: 1 });
    expect(g(['rev-parse', APPLIED_FROM]).trim()).toBe(second);
  });

  // A dry run reads every file of the patch through the user's filters, and one that does not end
  // within the deadline of the apply failed every later call the same way.
  it('answers a dry run that does not end in time, and closes the route', async () => {
    const host = createTestHost();
    const { repo, g, round } = await roundsResult(host);
    const result = round({ 'two.txt': numbered(10, { 5: 'line 5 from the space' }) });
    const before = hostState(repo);
    const stalled = createCodeOut({
      git: {
        output: (directory, args, options) => host.git.output(directory, args, options),
        run: (directory, args, options) => (args.includes('--check')
          ? Promise.reject(new SpaceError('command_timeout', 'git apply did not finish within 600000 ms and was stopped'))
          : host.git.run(directory, args, options)),
      },
      place: null,
      temporaryDirectory: host.root,
    });
    const stuck = await apply(host, repo, stalled).catch((error) => error);
    expect(stuck).toMatchObject({ code: 'changes_undecided', details: { limitMs: 600_000 } });
    expect(stuck.message).toMatch(/^Checking whether the work of the space fits your project took longer than 600 seconds, so nothing was changed\./);
    expect(g(['rev-parse', CLOSED]).trim()).toBe(result);
    expect(anyChangeSince(before, repo)).toEqual(CLOSURE);
  });

  // The agent brought an attribute that makes git store x.txt with plain line endings, then a round
  // that only turns x.txt to CRLF. Through the user's attributes that change cannot be seen: a kept
  // apply read as thrown away, and the same result applied again forever.
  it.skipIf(WIN)('takes a kept apply the comparison cannot see for kept, alone and beside one it can', async () => {
    const host = createTestHost();
    const { repo, g, round } = await roundsResult(host);
    round({ '.gitattributes': 'x.txt text eol=lf\n', 'x.txt': 'a\nb\n' });
    expect(await apply(host, repo)).toMatchObject({ status: 'applied', appliedPaths: 2 });
    const plumbed = (base, files) => {
      const entries = g(['ls-tree', base]).split('\n').filter(Boolean).filter((entry) => !Object.keys(files).some((name) => entry.endsWith(`\t${name}`)));
      for (const [name, content] of Object.entries(files)) entries.push(`100644 blob ${g(['hash-object', '-w', '--no-filters', '--stdin'], { input: content }).trim()}\t${name}`);
      const commit = g(['commit-tree', g(['mktree'], { input: `${entries.join('\n')}\n` }).trim(), '-p', base, '-m', 'plumbed']).trim();
      g(['update-ref', RESULT, commit]);
      return commit;
    };
    const crlf = plumbed(g(['rev-parse', RESULT]).trim(), { 'x.txt': 'a\r\nb\r\n' });
    expect(await apply(host, repo)).toMatchObject({ status: 'applied', appliedPaths: 1 });
    expect(await describeState(host, repo)).toMatchObject({ newPaths: 0 });
    expect(await apply(host, repo)).toEqual({ status: 'nothing_to_apply' });
    // Beside a change it can see, the one it cannot is not taken for a part thrown away.
    plumbed(crlf, { 'x.txt': 'c\r\nd\r\n', 'two.txt': numbered(10, { 5: 'line 5 from round three' }) });
    expect(await apply(host, repo)).toMatchObject({ status: 'applied', appliedPaths: 2 });
    plumbed(g(['rev-parse', RESULT]).trim(), { 'three.txt': numbered(10, { 1: 'line 1 from round four' }) });
    expect(await apply(host, repo)).toMatchObject({ status: 'applied', appliedPaths: 1 });
    expect(g(['for-each-ref', CLOSED])).toBe('');
  });

  // The host died before its `git apply` of round two, and then the user threw round one away. The
  // attempt wrote nothing; read against round one alone it looked like a part and closed the route.
  it('takes an attempt that wrote nothing for one never started after the user threw the apply before it away', async () => {
    const host = createTestHost();
    const { repo, g, start, round, putBack } = await firstApplied(host);
    const second = round({ 'one.txt': numbered(10, { 3: 'line 3 from round one', 4: 'line 4 from round two' }) });
    await expect(apply(host, repo, dying(host, { afterApply: false }))).rejects.toThrow();
    expect(g(['rev-parse', APPLYING]).trim()).toBe(second);
    putBack(start, ['one.txt', 'added.txt']);
    const before = hostState(repo);
    expect(await describeState(host, repo)).toMatchObject({ interruptedApply: true, newPaths: 2 });
    expect(anyChangeSince(before, repo)).toEqual([]);
    expect(await apply(host, repo)).toMatchObject({ status: 'applied', appliedPaths: 2 });
    for (const name of ['one.txt', 'added.txt']) expect(fs.readFileSync(path.join(repo, name), 'utf8')).toBe(g(['show', `${second}:${name}`]));
    expect(g(['rev-parse', APPLIED_FROM]).trim()).toBe(start);
    expect(g(['for-each-ref', CLOSED, APPLYING, APPLYING_FROM, APPLYING_HEAD])).toBe('');
  });

  // Where the interrupted apply is read as a part, the apply closes before it chooses a base, so the
  // read does not count from a base the apply never takes.
  it('counts from the last apply beside an interrupted apply that left a part, even after a throw-away', async () => {
    const host = createTestHost();
    const { repo, g, start, first, round, putBack } = await firstApplied(host);
    const second = round({ 'one.txt': numbered(10, { 3: 'line 3 redone' }), 'two.txt': numbered(10, { 5: 'line 5 redone' }) });
    g(['update-ref', APPLYING, second]);
    g(['update-ref', APPLYING_FROM, first]);
    putBack(start, ['one.txt', 'added.txt']);
    fs.writeFileSync(path.join(repo, 'two.txt'), g(['show', `${second}:two.txt`]));
    const before = hostState(repo);
    expect(await describeState(host, repo)).toMatchObject({ interruptedApply: true, newPaths: 2 });
    expect(anyChangeSince(before, repo)).toEqual([]);
    await expect(apply(host, repo)).rejects.toMatchObject({ code: 'changes_partly_applied', details: { interrupted: true, recorded: true } });
  });

  // The verifier's: a route closed stays closed, whatever the user does to the working tree after.
  it('keeps a closed route closed once the user throws the last apply away', async () => {
    const host = createTestHost();
    const { repo, g, start, round, putBack } = await firstApplied(host);
    putBack(start, ['one.txt']);
    round({ 'one.txt': numbered(10, { 3: 'line 3 redone' }) });
    fs.writeFileSync(path.join(repo, 'one.txt'), numbered(10, { 3: 'line 3 of the user' }));
    await expect(apply(host, repo)).rejects.toMatchObject({ code: 'changes_do_not_apply' });
    putBack(start, ['one.txt', 'added.txt']);
    const before = hostState(repo);
    expect(await describeState(host, repo)).toMatchObject({ changesRoute: 'closed' });
    await expect(apply(host, repo)).rejects.toMatchObject({ code: 'changes_route_closed' });
    expect(anyChangeSince(before, repo)).toEqual([]);
  });

  // The verifier's: reading where the space stands writes nothing, beside an intent that wrote nothing.
  it('changes nothing when it reads an intent that wrote nothing', async () => {
    const host = createTestHost();
    const { repo, g, round } = await firstApplied(host);
    round({ 'two.txt': numbered(10, { 5: 'line 5 from round two' }) });
    await expect(apply(host, repo, dying(host, { afterApply: false }))).rejects.toThrow();
    const before = hostState(repo);
    const refs = g(['for-each-ref']);
    expect(await describeState(host, repo)).toMatchObject({ interruptedApply: true, newPaths: 1 });
    expect(anyChangeSince(before, repo)).toEqual([]);
    expect(g(['for-each-ref'])).toBe(refs);
  });

  // The verifier's: a failed write of the intent leaves nothing behind, and the next apply brings the
  // whole work once.
  it('brings the whole work once after the intent of a whole-work apply could not be written', async () => {
    const host = createTestHost();
    const { repo, g, start, round, putBack } = await firstApplied(host);
    putBack(start, ['one.txt', 'added.txt']);
    round({ 'one.txt': numbered(10, { 3: 'line 3 redone' }), 'two.txt': numbered(10, { 5: 'line 5 redone' }) });
    const before = hostState(repo);
    await expect(apply(host, repo, breaking(host, (args, options) => args.includes('update-ref') && String(options?.stdin ?? '').startsWith(`update ${APPLYING} `)))).rejects.toBeTruthy();
    expect(anyChangeSince(before, repo)).toEqual([]);
    expect(await apply(host, repo)).toMatchObject({ status: 'applied', appliedPaths: 3 });
    expect(fs.readFileSync(path.join(repo, 'one.txt'), 'utf8')).toBe(numbered(10, { 3: 'line 3 redone' }));
    expect(g(['rev-parse', APPLIED_FROM]).trim()).toBe(start);
  });

  // The verifier's: the host died after its `git apply`, and the first call to sort that out could not
  // write its record. The next one does, and nothing is applied twice.
  it('records a whole-work apply the host did not live to record, after a first attempt to sort it out failed', async () => {
    const host = createTestHost();
    const { repo, g, start, round, putBack } = await firstApplied(host);
    putBack(start, ['one.txt', 'added.txt']);
    const second = round({ 'one.txt': numbered(10, { 3: 'line 3 redone' }), 'two.txt': numbered(10, { 5: 'line 5 redone' }) });
    await expect(apply(host, repo, dying(host, { afterApply: true }))).rejects.toThrow();
    const after = hostState(repo);
    await expect(apply(host, repo, breaking(host, (args) => args.includes('update-ref') && args.some((arg) => String(arg).includes('sorted out'))))).rejects.toBeTruthy();
    expect(g(['rev-parse', APPLYING]).trim()).toBe(second);
    expect(await apply(host, repo)).toEqual({ status: 'nothing_to_apply' });
    expect(unexpectedChanges(after, hostState(repo), { spaceIds: [SPACE_ID], codeOut: true })).toEqual([]);
    expect(g(['rev-parse', APPLIED]).trim()).toBe(second);
    expect(g(['rev-parse', APPLIED_FROM]).trim()).toBe(start);
    expect(g(['rev-parse', APPLIED_HEAD]).trim()).toBe(g(['rev-parse', 'HEAD']).trim());
    expect(g(['for-each-ref', APPLYING, APPLYING_FROM, APPLYING_HEAD, CLOSED])).toBe('');
  });

  // The verifier's: the patch deletes a file F and makes a folder F, and the user's F is a link to
  // another place. Only a link the patch deletes as a link, mode 120000, is passed over.
  it.skipIf(WIN)('refuses a folder where the patch deletes a file that is a link on the user\'s disk', async () => {
    const host = createTestHost();
    const outside = path.join(host.root, `outside-${crypto.randomBytes(4).toString('hex')}`);
    fs.mkdirSync(outside);
    const { repo, g } = await hostResult(host, {
      prepare: ({ repo: bait, g: bg }) => {
        fs.writeFileSync(path.join(bait, 'F'), 'a file\n');
        bg(['add', 'F']);
        bg(['commit', '--quiet', '-m', 'a file', '--', 'F']);
      },
      edit: (scratch) => {
        fs.rmSync(path.join(scratch, 'F'));
        fs.mkdirSync(path.join(scratch, 'F'));
        fs.writeFileSync(path.join(scratch, 'F', 'evil.txt'), 'evil\n');
      },
    });
    fs.rmSync(path.join(repo, 'F'));
    fs.symlinkSync(outside, path.join(repo, 'F'));
    await expect(apply(host, repo)).rejects.toMatchObject({ code: 'changes_blocked_by_link', details: { path: 'F' } });
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(g(['for-each-ref', CLOSED])).not.toBe('');
  });

  // 30 paths through 180 folders: a cap of 180 takes them, 179 does not.
  it('holds the folder cap to its exact number', async () => {
    const host = createTestHost();
    const { repo } = await treeResult(host, { chains: { count: 30, depth: 5 } });
    const before = hostState(repo);
    await expect(host.codeOut().applyAsChanges({ repository: repo, spaceId: SPACE_ID, maxChangedEntries: 179 }))
      .rejects.toMatchObject({ code: 'changes_too_large', message: expect.stringContaining('in more than 179 folders') });
    expect(anyChangeSince(before, repo)).toEqual([]);
    expect(await host.codeOut().applyAsChanges({ repository: repo, spaceId: SPACE_ID, maxChangedEntries: 180 })).toMatchObject({ status: 'applied', appliedPaths: 30 });
  });

  // Two linked worktrees of one repository share the refs of a space, so an apply from one and a read
  // from the other take turns: the read never sees the apply under way as interrupted.
  it('makes calls from two linked worktrees of one repository take turns', async () => {
    const host = createTestHost();
    const { repo, g, result } = await hostResult(host, { edit: ordinaryEdit });
    const other = path.join(host.root, `linked-${crypto.randomBytes(4).toString('hex')}`);
    g(['worktree', 'add', '--quiet', '--detach', other]);
    let reached;
    const atApply = new Promise((resolve) => { reached = resolve; });
    const slow = createCodeOut({
      git: {
        output: (directory, args, options) => host.git.output(directory, args, options),
        run: async (directory, args, options) => {
          if (isRealApply(args)) {
            reached();
            await new Promise((resolve) => { setTimeout(resolve, 1500); });
          }
          return host.git.run(directory, args, options);
        },
      },
      place: null,
      temporaryDirectory: host.root,
    });
    const applying = apply(host, repo, slow);
    await atApply;
    const seen = await describeState(host, other);
    expect(seen).toMatchObject({ interruptedApply: false, lastApplied: result });
    expect(await applying).toMatchObject({ status: 'applied', remembered: true });
    expect(g(['for-each-ref', APPLYING, CLOSED])).toBe('');
  });

  // A dry run that fails prints a line or two for every path that does not fit. Past four megabytes
  // the host's output cap stopped it, and every later call failed the same way.
  it.skipIf(WIN)('answers a dry run that fails on thousands of long paths, however much git prints', { timeout: 120_000 }, async () => {
    const host = createTestHost();
    const bait = makeBait(host);
    await host.codeIn().takeSnapshot({ repository: bait.repo, spaceId: SPACE_ID, mode: 'uncommitted' });
    const { repo, g } = bait;
    const count = 8000;
    const folder = ['d'.repeat(200), 'e'.repeat(200)];
    const name = (index) => `${'f'.repeat(150)}-${index}.txt`;
    const blobId = g(['hash-object', '-w', '--stdin'], { input: 'from the space\n' }).trim();
    const mktree = (entries) => g(['mktree', '-z'], { input: entries.map((entry) => `${entry}\0`).join('') }).trim();
    let tree = mktree(Array.from({ length: count }, (_, index) => `100644 blob ${blobId}\t${name(index)}`));
    tree = mktree([`040000 tree ${tree}\t${folder[1]}`]);
    const top = g(['ls-tree', '-z', START]).split('\0').filter(Boolean);
    const result = g(['commit-tree', mktree([...top, `040000 tree ${tree}\t${folder[0]}`]), '-p', START, '-m', 'plumbed']).trim();
    g(['update-ref', RESULT, result]);
    // The user already has every one of those files.
    fs.mkdirSync(path.join(repo, ...folder), { recursive: true });
    for (let index = 0; index < count; index += 1) fs.writeFileSync(path.join(repo, ...folder, name(index)), 'the user\'s\n');
    const failure = await apply(host, repo).catch((error) => error);
    expect(failure).toMatchObject({ code: 'changes_do_not_apply' });
    expect(failure.message).toMatch(/already exists in working directory$/);
    expect(g(['rev-parse', CLOSED]).trim()).toBe(result);
    // The same at the recovery of an intent, whose dry runs print as much.
    g(['update-ref', '-d', CLOSED]);
    g(['update-ref', APPLYING, result]);
    await expect(apply(host, repo)).rejects.toMatchObject({ code: 'changes_partly_applied', details: { interrupted: true, recorded: true } });
    expect(g(['for-each-ref', APPLYING])).toBe('');
  });

  // Reading the working tree back is bounded: past its time the call answers, closes the route, and
  // every later call answers at once, instead of every call failing the same way.
  it('answers a read-back that does not end in time, and closes the route with the intent', async () => {
    const host = createTestHost();
    const { repo, g, round } = await firstApplied(host);
    round({ 'two.txt': numbered(10, { 5: 'line 5 from round two' }) });
    const hurried = host.codeOut(null, { readBackTimeoutMs: 1 });
    const before = hostState(repo);
    expect(await describeState(host, repo, hurried)).toMatchObject({ newPaths: null, newPathsUndecided: true, newPathsOverLimit: false });
    expect(anyChangeSince(before, repo)).toEqual([]);
    const failure = await apply(host, repo, hurried).catch((error) => error);
    expect(failure).toMatchObject({ code: 'changes_undecided', details: { recorded: true } });
    expect(failure.message).toMatch(/^Reading your project back took longer than 0 seconds/);
    expect(anyChangeSince(before, repo)).toEqual(CLOSURE);
    await expect(apply(host, repo)).rejects.toMatchObject({ code: 'changes_route_closed' });
    // With an intent, the closure and its removal are one.
    const other = createTestHost();
    const again = await firstApplied(other);
    again.round({ 'two.txt': numbered(10, { 5: 'line 5 from round two' }) });
    await expect(apply(other, again.repo, dying(other, { afterApply: false }))).rejects.toThrow();
    await expect(apply(other, again.repo, other.codeOut(null, { readBackTimeoutMs: 1 }))).rejects.toMatchObject({ code: 'changes_undecided', details: { recorded: true } });
    expect(again.g(['for-each-ref', APPLYING, APPLYING_FROM, APPLYING_HEAD])).toBe('');
    expect(again.g(['for-each-ref', CLOSED])).not.toBe('');
  });

  // The same with a clean filter slow enough, a second a file, which is what made every call fail. The
  // user edited every file of the last apply, so none is byte for byte a side of it, and each is read
  // back through the filter.
  it.skipIf(WIN)('answers in time where the user\'s clean filter makes every file slow to read', { timeout: 60_000 }, async () => {
    const host = createTestHost();
    const own = ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt', 'one.txt'];
    const { repo, g, round } = await firstApplied(host, own);
    round(Object.fromEntries(own.slice(0, 5).map((name) => [name, numbered(10, { 2: 'from round two' })])));
    expect(await apply(host, repo)).toMatchObject({ status: 'applied', appliedPaths: 5 });
    for (const name of own.slice(0, 5)) fs.writeFileSync(path.join(repo, name), numbered(10, { 2: 'from round two', 9: 'line 9 of the user' }));
    round({ 'one.txt': numbered(10, { 3: 'line 3 from round one', 7: 'line 7 from round three' }) });
    g(['config', 'filter.slow.clean', 'sleep 1; cat']);
    fs.writeFileSync(path.join(repo, '.git', 'info', 'attributes'), '*.txt filter=slow\n');
    const started = Date.now();
    await expect(apply(host, repo, host.codeOut(null, { readBackTimeoutMs: 2000 }))).rejects.toMatchObject({ code: 'changes_undecided' });
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(g(['for-each-ref', CLOSED])).not.toBe('');
  });

  // Where an earlier apply is still there, one look at one path answers whether any apply was thrown
  // away; only the last apply's own paths are all read, for a part thrown away.
  it('stops at the first path that shows an earlier apply is still there', async () => {
    const host = createTestHost();
    const own = [...Array.from({ length: 40 }, (_, index) => `n${String(index).padStart(2, '0')}.txt`), 'three.txt'];
    const work = await roundsResult(host, own);
    work.round(Object.fromEntries(own.slice(0, 40).map((name) => [name, numbered(10, { 3: 'from round one' })])));
    expect(await apply(host, work.repo)).toMatchObject({ status: 'applied', appliedPaths: 40 });
    work.round({ 'three.txt': numbered(10, { 1: 'from round two' }) });
    expect(await apply(host, work.repo)).toMatchObject({ status: 'applied', appliedPaths: 1 });
    work.round({ 'n00.txt': numbered(10, { 3: 'from round one', 5: 'from round three' }) });
    let compared = 0;
    const counting = host.codeOut(null, { files: { ...fs.promises, open: (...args) => { compared += 1; return fs.promises.open(...args); } } });
    expect(await apply(host, work.repo, counting)).toMatchObject({ status: 'applied', appliedPaths: 1 });
    // One path of the 41 the applies changed, and the one path of the last apply.
    expect(compared).toBe(2);
  });
});

// Round eight: each path of the last apply is judged by what the working tree holds and by the
// user's commits since, and reading the tree back reads the user's files as they are, with exactly
// the attributes the working tree holds now. See `whatBecameOf` and `sidesHeld` in code-out.js.
describe('applyAsChanges after round seven', () => {
  const apply = (host, repo, codeOut = host.codeOut()) => codeOut.applyAsChanges({ repository: repo, spaceId: SPACE_ID });
  const tryApply = (host, repo, codeOut) => apply(host, repo, codeOut).catch((error) => error);
  const describeState = (host, repo, codeOut = host.codeOut()) => codeOut.describeApplyState({ repository: repo, spaceId: SPACE_ID });
  const isRealApply = (args) => args.includes('apply') && !args.includes('--check');
  /** Code out whose real `git apply` ends the call as a host that died would: before it runs, or right after. */
  const dying = (host, { afterApply }) => createCodeOut({
    git: {
      output: (directory, args, options) => host.git.output(directory, args, options),
      run: async (directory, args, options) => {
        if (!isRealApply(args)) return host.git.run(directory, args, options);
        if (afterApply) await host.git.run(directory, args, options);
        throw new Error('the host went away');
      },
    },
    place: null,
    temporaryDirectory: host.root,
  });
  /** Whether the working tree holds each of `names` byte for byte as `treeish` has it, or not at all where it has none. */
  const holdsAll = ({ repo, g }, treeish, names) => names.every((name) => {
    const file = path.join(repo, name);
    if (g(['ls-tree', '--name-only', treeish, '--', name]).trim() === '') return !fs.existsSync(file);
    return fs.existsSync(file) && fs.readFileSync(file, 'utf8') === g(['show', `${treeish}:${name}`]);
  });
  const closed = ({ g }) => g(['for-each-ref', CLOSED]) !== '';

  // The ordinary reviewer's matrix, with the user's actions done by git. Round one changes a.txt and
  // adds feature.ts.
  describe('what the user did after an apply', () => {
    const roundOne = { 'a.txt': numbered(10, { 5: 'line 5 from round one' }), 'feature.ts': 'export const x = 1;\n' };
    const b = { 'b.txt': numbered(10, { 3: 'line 3 from round two' }) };
    const c = { 'c.txt': numbered(10, { 7: 'line 7 from round three' }) };
    // The agent redid the work from its start: round one is gone from the result.
    const redoneFromScratch = { 'a.txt': numbered(10), 'feature.ts': null, ...b };
    const applied = async (host) => {
      const work = await roundsResult(host, ['a.txt', 'b.txt', 'c.txt']);
      work.round(roundOne);
      expect(await apply(host, work.repo)).toMatchObject({ status: 'applied', appliedPaths: 2 });
      return work;
    };
    const throwAway = (work) => work.putBack(work.start, ['a.txt', 'feature.ts']);
    const commit = ({ g }, names, message = 'kept') => {
      g(['add', ...names]);
      g(['commit', '--quiet', '-m', message, '--', ...names]);
    };
    // What a pull of a colleague's work does to HEAD and the working tree.
    const pull = (work) => {
      fs.writeFileSync(path.join(work.repo, 'CHANGES.md'), 'from a colleague\n');
      commit(work, ['CHANGES.md'], 'a colleague');
    };
    const sideBranch = ({ repo, g }) => {
      g(['switch', '--quiet', '-c', 'side']);
      fs.writeFileSync(path.join(repo, 'side.txt'), 'side\n');
      commit({ g }, ['side.txt'], 'side');
      g(['switch', '--quiet', '-']);
    };

    it('E1: kept, then a pull: only what is new', async () => {
      const host = createTestHost();
      const work = await applied(host);
      pull(work);
      const second = work.round(b);
      expect(await apply(host, work.repo)).toMatchObject({ status: 'applied', appliedPaths: 1 });
      expect(holdsAll(work, second, ['a.txt', 'b.txt', 'feature.ts'])).toBe(true);
    });

    it('E2: thrown away, then a pull, and the agent went on: the whole work', async () => {
      const host = createTestHost();
      const work = await applied(host);
      throwAway(work);
      pull(work);
      const second = work.round(b);
      expect(await describeState(host, work.repo)).toMatchObject({ newPaths: 3 });
      expect(await apply(host, work.repo)).toMatchObject({ status: 'applied', appliedPaths: 3 });
      expect(holdsAll(work, second, ['a.txt', 'b.txt', 'feature.ts'])).toBe(true);
      expect(closed(work)).toBe(false);
    });

    it('E3: thrown away, then a pull, and the agent redid it: the redo', async () => {
      const host = createTestHost();
      const work = await applied(host);
      throwAway(work);
      pull(work);
      const second = work.round(redoneFromScratch);
      expect(await apply(host, work.repo)).toMatchObject({ status: 'applied', appliedPaths: 1 });
      expect(holdsAll(work, second, ['a.txt', 'b.txt', 'feature.ts'])).toBe(true);
      expect(closed(work)).toBe(false);
    });

    it('B3: thrown away, then a switch to another branch, and the agent went on: the whole work', async () => {
      const host = createTestHost();
      const work = await applied(host);
      sideBranch(work);
      throwAway(work);
      work.g(['switch', '--quiet', 'side']);
      const second = work.round(b);
      expect(await apply(host, work.repo)).toMatchObject({ status: 'applied', appliedPaths: 3 });
      expect(holdsAll(work, second, ['a.txt', 'b.txt', 'feature.ts'])).toBe(true);
      expect(closed(work)).toBe(false);
    });

    it('B4: thrown away, then a switch to another branch, and the agent redid it: the redo', async () => {
      const host = createTestHost();
      const work = await applied(host);
      sideBranch(work);
      throwAway(work);
      work.g(['switch', '--quiet', 'side']);
      const second = work.round(redoneFromScratch);
      expect(await apply(host, work.repo)).toMatchObject({ status: 'applied', appliedPaths: 1 });
      expect(holdsAll(work, second, ['a.txt', 'b.txt', 'feature.ts'])).toBe(true);
      expect(closed(work)).toBe(false);
    });

    it('C1: stashed and popped again: kept, only what is new', async () => {
      const host = createTestHost();
      const work = await applied(host);
      work.g(['stash', 'push', '--quiet', '--include-untracked', '--', 'a.txt', 'feature.ts']);
      work.g(['stash', 'pop', '--quiet']);
      const second = work.round(b);
      expect(await apply(host, work.repo)).toMatchObject({ status: 'applied', appliedPaths: 1 });
      expect(holdsAll(work, second, ['a.txt', 'b.txt', 'feature.ts'])).toBe(true);
    });

    it('C2: stashed, and the next round applied while it is stashed: the whole work', async () => {
      const host = createTestHost();
      const work = await applied(host);
      work.g(['stash', 'push', '--quiet', '--include-untracked', '--', 'a.txt', 'feature.ts']);
      const second = work.round(b);
      expect(await apply(host, work.repo)).toMatchObject({ status: 'applied', appliedPaths: 3 });
      expect(holdsAll(work, second, ['a.txt', 'b.txt', 'feature.ts'])).toBe(true);
    });

    it('C3: stashed and dropped: the whole work', async () => {
      const host = createTestHost();
      const work = await applied(host);
      work.g(['stash', 'push', '--quiet', '--include-untracked', '--', 'a.txt', 'feature.ts']);
      work.g(['stash', 'drop', '--quiet']);
      const second = work.round(b);
      expect(await apply(host, work.repo)).toMatchObject({ status: 'applied', appliedPaths: 3 });
      expect(holdsAll(work, second, ['a.txt', 'b.txt', 'feature.ts'])).toBe(true);
    });

    it('D1: committed, the next round amended into that commit: only what is new', async () => {
      const host = createTestHost();
      const work = await applied(host);
      commit(work, ['a.txt', 'feature.ts']);
      work.round(b);
      expect(await apply(host, work.repo)).toMatchObject({ status: 'applied', appliedPaths: 1 });
      work.g(['commit', '--quiet', '--amend', '--no-edit', '--', 'b.txt']);
      const third = work.round(c);
      expect(await apply(host, work.repo)).toMatchObject({ status: 'applied', appliedPaths: 1 });
      expect(holdsAll(work, third, ['a.txt', 'b.txt', 'c.txt', 'feature.ts'])).toBe(true);
    });

    // The reset takes back the user's own commit of round one: a move back adds no commit, so every file
    // of both rounds is back as before with no commit of the user's since, and the whole work comes.
    it('D2: committed, the next round applied, then a hard reset to before both: the whole work', async () => {
      const host = createTestHost();
      const work = await applied(host);
      const before = work.g(['rev-parse', 'HEAD']).trim();
      commit(work, ['a.txt', 'feature.ts']);
      work.round(b);
      expect(await apply(host, work.repo)).toMatchObject({ status: 'applied', appliedPaths: 1 });
      work.g(['reset', '--quiet', '--hard', before]);
      const third = work.round(c);
      expect(await apply(host, work.repo)).toMatchObject({ status: 'applied', appliedPaths: 4 });
      expect(holdsAll(work, third, ['a.txt', 'b.txt', 'c.txt', 'feature.ts'])).toBe(true);
      expect(closed(work)).toBe(false);
    });

    // A revert is a new commit of the user's: the files it put back are the user's change, not a throw-away.
    it('R: committed, then the commit reverted: an edit, only what is new', async () => {
      const host = createTestHost();
      const work = await applied(host);
      commit(work, ['a.txt', 'feature.ts']);
      // `git revert`, done by hand beside the user's other uncommitted work: a new commit that puts both back.
      work.putBack(work.start, ['a.txt', 'feature.ts']);
      work.g(['add', '--all', '--', 'a.txt', 'feature.ts']);
      work.g(['commit', '--quiet', '-m', 'Revert round one', '--', 'a.txt', 'feature.ts']);
      const second = work.round(b);
      expect(await apply(host, work.repo)).toMatchObject({ status: 'applied', appliedPaths: 1 });
      expect(holdsAll(work, second, ['b.txt'])).toBe(true);
      expect(holdsAll(work, work.start, ['a.txt', 'feature.ts'])).toBe(true);
      expect(closed(work)).toBe(false);
    });

    it('A1: committed, then a file of it deleted and another moved: an edit, and a round that touches them does not fit', async () => {
      const host = createTestHost();
      const work = await applied(host);
      commit(work, ['a.txt', 'feature.ts']);
      fs.rmSync(path.join(work.repo, 'feature.ts'));
      fs.mkdirSync(path.join(work.repo, 'lib'));
      work.g(['mv', 'a.txt', 'lib/a.txt']);
      work.round(c);
      expect(await apply(host, work.repo)).toMatchObject({ status: 'applied', appliedPaths: 1 });
      expect(fs.existsSync(path.join(work.repo, 'feature.ts'))).toBe(false);
      expect(closed(work)).toBe(false);
      work.round({ 'feature.ts': 'export const x = 2;\n' });
      const failure = await tryApply(host, work.repo);
      expect(failure).toMatchObject({ code: 'changes_do_not_apply', details: { exitCode: 1 } });
      expect(failure.message).toMatch(/^The work of the space does not fit your project any more/);
      expect(closed(work)).toBe(true);
    });

    it('A2: committed, then a file of it moved in another commit, and a round that touches it: does not fit', async () => {
      const host = createTestHost();
      const work = await applied(host);
      commit(work, ['a.txt', 'feature.ts']);
      fs.mkdirSync(path.join(work.repo, 'lib'));
      work.g(['mv', 'a.txt', 'lib/a.txt']);
      work.g(['commit', '--quiet', '-m', 'moved', '--', 'a.txt', 'lib/a.txt']);
      work.round({ 'a.txt': numbered(10, { 5: 'line 5 from round one', 9: 'line 9 from round two' }) });
      const failure = await tryApply(host, work.repo);
      expect(failure).toMatchObject({ code: 'changes_do_not_apply', details: { exitCode: 1 } });
      expect(failure.message).toMatch(/^The work of the space does not fit your project any more/);
    });

    it('A3: committed, the next round applied, then a file of the first round deleted: not the last apply, not seen', async () => {
      const host = createTestHost();
      const work = await applied(host);
      commit(work, ['a.txt', 'feature.ts']);
      work.round(b);
      expect(await apply(host, work.repo)).toMatchObject({ status: 'applied', appliedPaths: 1 });
      fs.rmSync(path.join(work.repo, 'feature.ts'));
      work.round(c);
      expect(await apply(host, work.repo)).toMatchObject({ status: 'applied', appliedPaths: 1 });
      expect(fs.existsSync(path.join(work.repo, 'feature.ts'))).toBe(false);
      expect(closed(work)).toBe(false);
    });
  });

  // The verifier's A4: the refs of a space are shared by linked worktrees, HEAD is not. An apply from
  // a second worktree after one in the first gave round two alone. Its working tree holds nothing of
  // round one, so round one is thrown away there and the whole work comes; back in the first worktree,
  // where round one is and round two is not, the part thrown away is refused.
  it('gives the whole work in a second linked worktree, and refuses the part in the first', async () => {
    const host = createTestHost();
    const work = await roundsResult(host);
    work.round({ 'one.txt': numbered(10, { 3: 'line 3 from round one' }) });
    expect(await apply(host, work.repo)).toMatchObject({ status: 'applied', appliedPaths: 1 });
    const other = path.join(host.root, `linked-${crypto.randomBytes(4).toString('hex')}`);
    work.g(['worktree', 'add', '--quiet', '-b', 'feature', other, 'HEAD']);
    host.sh(other, ['commit', '--quiet', '--allow-empty', '-m', 'work on feature in the other worktree']);
    const second = work.round({ 'two.txt': numbered(10, { 5: 'line 5 from round two' }) });
    expect(await apply(host, other)).toMatchObject({ status: 'applied', appliedPaths: 2 });
    for (const name of ['one.txt', 'two.txt']) expect(fs.readFileSync(path.join(other, name), 'utf8')).toBe(work.g(['show', `${second}:${name}`]));
    work.round({ 'three.txt': numbered(10, { 1: 'line 1 from round three' }) });
    await expect(apply(host, work.repo)).rejects.toMatchObject({
      code: 'changes_do_not_apply', details: { thrownAway: { count: 1, paths: ['two.txt'] }, stillThere: { count: 1, paths: ['one.txt'] } },
    });
  });

  // The verifier's G1: the host died after its `git apply`, the user committed that work, and a call
  // sorted it out. The record keeps the HEAD of the intent, so the commit counts as the user's.
  it('keeps the HEAD of the intent when it records an apply the host did not live to record', async () => {
    const host = createTestHost();
    const { repo, g, round } = await roundsResult(host);
    round({ 'one.txt': numbered(10, { 3: 'line 3 from round one' }), 'added.txt': 'added\n' });
    await expect(apply(host, repo, dying(host, { afterApply: true }))).rejects.toThrow();
    g(['add', 'one.txt', 'added.txt']);
    g(['commit', '--quiet', '-m', 'kept', '--', 'one.txt', 'added.txt']);
    expect(await apply(host, repo)).toEqual({ status: 'nothing_to_apply' });
    fs.rmSync(path.join(repo, 'added.txt'));
    round({ 'three.txt': numbered(10, { 1: 'line 1 from round two' }) });
    expect(await describeState(host, repo)).toMatchObject({ newPaths: 1 });
    expect(await apply(host, repo)).toMatchObject({ status: 'applied', appliedPaths: 1 });
  });

  // The verifier's G3: two applies, so the last one did not start from the start, then an attempt that
  // wrote nothing, and then the user threw the second apply away.
  it('takes an attempt that wrote nothing for one never started after the second of two applies was thrown away', async () => {
    const host = createTestHost();
    const { repo, g, round } = await roundsResult(host);
    const first = round({ 'one.txt': numbered(10, { 3: 'round one' }) });
    await apply(host, repo);
    round({ 'one.txt': numbered(10, { 3: 'round one', 6: 'round two' }) });
    await apply(host, repo);
    const third = round({ 'one.txt': numbered(10, { 3: 'round one', 6: 'round two', 9: 'round three' }) });
    await expect(apply(host, repo, dying(host, { afterApply: false }))).rejects.toThrow();
    fs.writeFileSync(path.join(repo, 'one.txt'), g(['show', `${first}:one.txt`]));
    expect(await describeState(host, repo)).toMatchObject({ interruptedApply: true, newPaths: 1, changesRoute: 'open' });
    expect(await apply(host, repo)).toMatchObject({ status: 'applied', appliedPaths: 1 });
    expect(fs.readFileSync(path.join(repo, 'one.txt'), 'utf8')).toBe(g(['show', `${third}:one.txt`]));
    expect(g(['for-each-ref', CLOSED])).toBe('');
  });

  // The verifier's G4: an apply that turns x.txt to CRLF, which the attributes undo, beside one that
  // changes two.txt visibly, both kept: the next round applies.
  it.skipIf(WIN)('takes an apply of a change the attributes undo beside a visible one for kept', async () => {
    const host = createTestHost();
    const { repo, g, round } = await roundsResult(host);
    round({ '.gitattributes': 'x.txt text eol=lf\n', 'x.txt': 'a\nb\n' });
    expect(await apply(host, repo)).toMatchObject({ status: 'applied', appliedPaths: 2 });
    const plumbed = (base, entries) => {
      const kept = g(['ls-tree', base]).split('\n').filter(Boolean).filter((entry) => !Object.keys(entries).some((name) => entry.endsWith(`\t${name}`)));
      for (const [name, content] of Object.entries(entries)) kept.push(`100644 blob ${g(['hash-object', '-w', '--no-filters', '--stdin'], { input: content }).trim()}\t${name}`);
      const commit = g(['commit-tree', g(['mktree'], { input: `${kept.join('\n')}\n` }).trim(), '-p', base, '-m', 'plumbed']).trim();
      g(['update-ref', RESULT, commit]);
      return commit;
    };
    const second = plumbed(g(['rev-parse', RESULT]).trim(), { 'x.txt': 'a\r\nb\r\n', 'two.txt': numbered(10, { 5: 'round two' }) });
    expect(await apply(host, repo)).toMatchObject({ status: 'applied', appliedPaths: 2 });
    plumbed(second, { 'three.txt': numbered(10, { 1: 'round three' }) });
    expect(await apply(host, repo)).toMatchObject({ status: 'applied', appliedPaths: 1 });
    expect(g(['for-each-ref', CLOSED])).toBe('');
  });

  // The verifier's D1: on a closed route nothing is read back, since no apply would choose a base.
  it('reads nothing back to describe a closed route', async () => {
    const host = createTestHost();
    const { repo, round, putBack, start } = await roundsResult(host);
    round({ 'one.txt': numbered(10, { 3: 'line 3 from round one' }) });
    expect(await apply(host, repo)).toMatchObject({ status: 'applied' });
    fs.writeFileSync(path.join(repo, 'one.txt'), numbered(10, { 3: 'line 3 of the user' }));
    round({ 'one.txt': numbered(10, { 3: 'line 3 redone' }) });
    await expect(apply(host, repo)).rejects.toMatchObject({ code: 'changes_do_not_apply' });
    putBack(start, ['one.txt']);
    let opened = 0;
    const counting = host.codeOut(null, { readBackTimeoutMs: 1, files: { ...fs.promises, open: (...args) => { opened += 1; return fs.promises.open(...args); } } });
    expect(await describeState(host, repo, counting)).toMatchObject({ changesRoute: 'closed', newPaths: 1, newPathsUndecided: false });
    expect(opened).toBe(0);
  });

  // A listing longer than the host reads, while reading back, is answered like one that took too long.
  it('answers a read-back whose listing is longer than the host reads, and closes the route', async () => {
    const host = createTestHost();
    const { repo, g, round, putBack, start } = await roundsResult(host);
    round({ 'one.txt': numbered(10, { 3: 'line 3 from round one' }) });
    expect(await apply(host, repo)).toMatchObject({ status: 'applied' });
    putBack(start, ['one.txt']);
    round({ 'two.txt': numbered(10, { 5: 'line 5 from round two' }) });
    const listing = (args) => args.includes('diff-tree') && args.includes('-z') && !args.includes('--name-only');
    const tooLong = () => Promise.reject(new SpaceError('command_output_too_large', 'git diff-tree printed more than 67108864 bytes and was stopped'));
    const long = createCodeOut({
      git: {
        run: (directory, args, options) => (listing(args) ? tooLong() : host.git.run(directory, args, options)),
        output: (directory, args, options) => (listing(args) ? tooLong() : host.git.output(directory, args, options)),
      },
      place: null,
      temporaryDirectory: host.root,
    });
    expect(await describeState(host, repo, long)).toMatchObject({ newPaths: null, newPathsUndecided: true });
    await expect(apply(host, repo, long)).rejects.toMatchObject({ code: 'changes_undecided' });
    expect(g(['for-each-ref', CLOSED])).not.toBe('');
  });

  // The verifier's D10c: the time for reading back is the call's, shared by every command of it, not
  // each command's own. Two reads that each fit within it do not fit together.
  it.skipIf(WIN)('shares the read-back time among every command of the call', { timeout: 60_000 }, async () => {
    const host = createTestHost();
    const { repo, g, round } = await roundsResult(host);
    round({ 'one.txt': numbered(10, { 3: 'round one' }), 'added.txt': 'added\n' });
    expect(await apply(host, repo)).toMatchObject({ status: 'applied', appliedPaths: 2 });
    round({ 'two.txt': numbered(10, { 3: 'round two' }), 'three.txt': numbered(10, { 3: 'round two' }) });
    expect(await apply(host, repo)).toMatchObject({ status: 'applied', appliedPaths: 2 });
    // Edited by the user, so each is read back through the clean filter: half a second a file.
    fs.writeFileSync(path.join(repo, 'added.txt'), 'added\nand edited\n');
    for (const name of ['two.txt', 'three.txt']) fs.writeFileSync(path.join(repo, name), numbered(10, { 3: 'round two', 9: 'the user' }));
    round({ 'one.txt': numbered(10, { 3: 'round one', 7: 'round three' }) });
    g(['config', 'filter.slow.clean', 'sleep 0.5; cat']);
    fs.writeFileSync(path.join(repo, '.git', 'info', 'attributes'), '*.txt filter=slow\n');
    // One file for the look at every apply, then two for the last apply: about 1.5 s in all.
    await expect(apply(host, repo, host.codeOut(null, { readBackTimeoutMs: 1300 }))).rejects.toMatchObject({ code: 'changes_undecided' });
  });

  // A clean filter that talks on stderr for every file it reads must not make reading back fail.
  it.skipIf(WIN)('reads back through a filter that prints a lot for every file', { timeout: 60_000 }, async () => {
    const host = createTestHost();
    const own = Array.from({ length: 40 }, (_, index) => `f${String(index).padStart(2, '0')}.txt`);
    const { repo, g, round } = await roundsResult(host, [...own, 'one.txt']);
    round(Object.fromEntries(own.map((name) => [name, numbered(10, { 3: 'round one' })])));
    expect(await apply(host, repo)).toMatchObject({ status: 'applied', appliedPaths: 40 });
    for (const name of own) fs.writeFileSync(path.join(repo, name), numbered(10, { 3: 'round one', 9: 'the user' }));
    round({ 'one.txt': numbered(10, { 1: 'round two' }) });
    // 200 KB on stderr a file, 8 MB in all, past any cap on what the host keeps of it.
    g(['config', 'filter.chatty.clean', 'yes x | head -c 200000 >&2; cat']);
    fs.writeFileSync(path.join(repo, '.git', 'info', 'attributes'), '*.txt filter=chatty\n');
    expect(await apply(host, repo)).toMatchObject({ status: 'applied', appliedPaths: 1 });
    expect(g(['for-each-ref', CLOSED])).toBe('');
  });

  // A counting `files` sees what is read. The whole of a last apply that is kept, byte for byte, is read
  // by the host alone: no git runs for it, however slow the user's clean filter is.
  it.skipIf(WIN)('reads a kept last apply byte for byte, without running the user\'s clean filter', async () => {
    const host = createTestHost();
    const own = ['a.txt', 'b.txt', 'c.txt', 'one.txt'];
    const { repo, g, round } = await roundsResult(host, own);
    round(Object.fromEntries(own.slice(0, 3).map((name) => [name, numbered(10, { 3: 'round one' })])));
    expect(await apply(host, repo)).toMatchObject({ status: 'applied', appliedPaths: 3 });
    round({ 'one.txt': numbered(10, { 1: 'round two' }) });
    const markers = path.join(host.root, 'clean-ran');
    g(['config', 'filter.slow.clean', `echo ran >> '${forConfig(markers)}'; sleep 2; cat`]);
    fs.writeFileSync(path.join(repo, '.git', 'info', 'attributes'), '*.txt filter=slow\n');
    const hashed = [];
    const counting = host.codeOut(null, { readBackTimeoutMs: 1000, files: { ...fs.promises, open: (file, ...rest) => { hashed.push(path.basename(file)); return fs.promises.open(file, ...rest); } } });
    expect(await describeState(host, repo, counting)).toMatchObject({ newPaths: 1, newPathsUndecided: false });
    expect(hashed.sort()).toEqual(['a.txt', 'b.txt', 'c.txt']);
    expect(fs.existsSync(markers)).toBe(false);
  });

  // The time of the call is checked while one file is read, not only between git commands: a file that
  // is slow to read, here a disk that gives 64 KiB every 50 ms, cannot hold the call past its time.
  it('checks the read-back time while it reads a large file', async () => {
    const host = createTestHost();
    const { repo, round } = await roundsResult(host);
    round({ 'one.txt': numbered(10, { 3: 'round one' }), 'large.bin': Buffer.alloc(40 * 64 * 1024, 7) });
    expect(await apply(host, repo)).toMatchObject({ status: 'applied', appliedPaths: 2 });
    round({ 'two.txt': numbered(10, { 5: 'round two' }) });
    const slowDisk = {
      ...fs.promises,
      open: async (...args) => {
        const handle = await fs.promises.open(...args);
        const read = handle.read.bind(handle);
        handle.read = async (...readArgs) => { await new Promise((resolve) => { setTimeout(resolve, 50); }); return read(...readArgs); };
        return handle;
      },
    };
    const started = Date.now();
    expect(await describeState(host, repo, host.codeOut(null, { readBackTimeoutMs: 600, files: slowDisk }))).toMatchObject({ newPaths: null, newPathsUndecided: true });
    expect(Date.now() - started).toBeLessThan(1800);
  });

  // An LFS-like filter: the user's file is the real content, git keeps a pointer. The agent changed
  // such a file; applied, it is the agent's bytes, which the filter reads back as another pointer, so
  // a second round on it cannot fit. That is said as it is, not as "your project changed".
  it.skipIf(WIN)('says so when a file an LFS-like filter handles cannot be updated a second time', async () => {
    const host = createTestHost();
    const store = path.join(host.root, `lfs-store-${crypto.randomBytes(4).toString('hex')}`);
    fs.mkdirSync(store);
    const script = (name, body) => {
      const file = path.join(host.root, `${name}-${crypto.randomBytes(4).toString('hex')}.sh`);
      fs.writeFileSync(file, `#!/bin/sh\nt=$(mktemp); cat > "$t"\n${body}\nrm -f "$t"\n`, { mode: 0o755 });
      return forConfig(file);
    };
    const clean = script('lfs-clean', `if [ "$(head -c 4 "$t")" = "ptr " ]; then cat "$t"; else s=$(cksum < "$t" | cut -d' ' -f1); cp "$t" '${store}'/"$s"; printf 'ptr %s\\n' "$s"; fi`);
    const smudge = script('lfs-smudge', `s=$(sed -n 's/^ptr //p' "$t"); if [ "$(head -c 4 "$t")" = "ptr " ] && [ -f '${store}'/"$s" ]; then cat '${store}'/"$s"; else cat "$t"; fi`);
    const work = await roundsResult(host, ['one.txt', 'two.txt'], {
      prepare: ({ repo, g }) => {
        g(['config', 'filter.fakelfs.clean', clean]);
        g(['config', 'filter.fakelfs.smudge', smudge]);
        g(['config', 'filter.fakelfs.required', 'true']);
        fs.writeFileSync(path.join(repo, '.gitattributes'), '*.bin filter=fakelfs\n');
        fs.writeFileSync(path.join(repo, 'logo.bin'), 'the real logo\n');
        // A file of the filter whose object is not here: the working file is the pointer itself, which
        // the filter reads back as the same pointer, so it is not in the way.
        fs.writeFileSync(path.join(repo, 'other.bin'), 'ptr 999\n');
        g(['add', '.gitattributes', 'logo.bin', 'other.bin']);
        g(['commit', '--quiet', '-m', 'a logo in LFS', '--', '.gitattributes', 'logo.bin', 'other.bin']);
      },
    });
    expect(work.g(['show', 'HEAD:logo.bin'])).toMatch(/^ptr /);
    work.round({ 'logo.bin': 'the logo of the agent\n', 'one.txt': numbered(10, { 3: 'round one' }) });
    expect(await apply(host, work.repo)).toMatchObject({ status: 'applied', appliedPaths: 2 });
    expect(fs.readFileSync(path.join(work.repo, 'logo.bin'), 'utf8')).toBe('the logo of the agent\n');
    // Kept, and a round on another file: applies.
    work.round({ 'two.txt': numbered(10, { 5: 'round two' }) });
    expect(await apply(host, work.repo)).toMatchObject({ status: 'applied', appliedPaths: 1 });
    // A round on the logo again cannot fit, and says why, naming only the file the filter keeps apart.
    const third = work.round({ 'logo.bin': 'the logo of the agent, again\n', 'other.bin': 'the other of the agent\n' });
    const before = hostState(work.repo);
    const failure = await tryApply(host, work.repo);
    expect(failure).toMatchObject({ code: 'changes_do_not_apply', details: { filteredInTheWay: { count: 1, paths: ['logo.bin'] } } });
    expect(failure.message).toMatch(/^The work of the space changes logo\.bin again, which a filter such as Git LFS handles in your project\. Files like that cannot be updated as uncommitted changes a second time, so nothing was changed\./);
    expect(anyChangeSince(before, work.repo)).toEqual(CLOSURE);
    expect(work.g(['rev-parse', CLOSED]).trim()).toBe(third);
  });

  // A folder of the last apply that the user replaced with a link to another place holding the same
  // file: git status reads the path as gone, and nothing is read through the link.
  it.skipIf(WIN)('reads a path below a link as gone, and reads nothing through the link', async () => {
    const host = createTestHost();
    const { repo, round } = await roundsResult(host);
    fs.mkdirSync(path.join(host.root, 'elsewhere'));
    round({ 'one.txt': numbered(10, { 3: 'round one' }), 'dir/x.txt': 'x\n' });
    expect(await apply(host, repo)).toMatchObject({ status: 'applied', appliedPaths: 2 });
    fs.renameSync(path.join(repo, 'dir'), path.join(host.root, 'elsewhere', 'dir'));
    fs.symlinkSync(path.join(host.root, 'elsewhere', 'dir'), path.join(repo, 'dir'));
    round({ 'two.txt': numbered(10, { 5: 'round two' }) });
    await expect(apply(host, repo)).rejects.toMatchObject({ code: 'changes_do_not_apply', details: { thrownAway: { paths: ['dir/x.txt'] }, stillThere: { paths: ['one.txt'] } } });
  });

  // Where git here does not see the exec bit, a change of it alone cannot be told apart on disk, so it
  // is no evidence either way: thrown away beside a visible change, the whole work comes again.
  it.skipIf(WIN)('leaves a change of the exec bit alone out where core.filemode is off', async () => {
    const host = createTestHost();
    const { repo, g, start, round, putBack } = await roundsResult(host);
    g(['config', 'core.filemode', 'false']);
    const first = round({ 'one.txt': numbered(10, { 3: 'round one' }) });
    const two = g(['ls-tree', first, '--', 'two.txt']).trim().split(/\s/)[2];
    g(['update-ref', RESULT, g(['commit-tree', g(['mktree'], { input: g(['ls-tree', first]).replace(`100644 blob ${two}\ttwo.txt`, `100755 blob ${two}\ttwo.txt`) }).trim(), '-p', first, '-m', 'plumbed']).trim()]);
    expect(await apply(host, repo)).toMatchObject({ status: 'applied', appliedPaths: 2 });
    putBack(start, ['one.txt']);
    const applied = g(['rev-parse', RESULT]).trim();
    const three = g(['hash-object', '-w', '--stdin'], { input: numbered(10, { 1: 'round two' }) }).trim();
    const tree = g(['ls-tree', applied]).split('\n').filter((entry) => entry !== '' && !entry.endsWith('\tthree.txt')).concat(`100644 blob ${three}\tthree.txt`).join('\n');
    g(['update-ref', RESULT, g(['commit-tree', g(['mktree'], { input: `${tree}\n` }).trim(), '-p', applied, '-m', 'plumbed']).trim()]);
    expect(await apply(host, repo)).toMatchObject({ status: 'applied', appliedPaths: 3 });
    expect(g(['for-each-ref', CLOSED])).toBe('');
  });

  // A name the agent made with a line break in it, edited by the user, is read back on its own: the
  // line-by-line input of `hash-object --stdin-paths` cannot carry it.
  it.skipIf(WIN)('reads back a file whose name holds a line break', async () => {
    const host = createTestHost();
    const { repo, g, round } = await roundsResult(host);
    round({ 'one.txt': numbered(10, { 3: 'round one' }), 'odd\nname.txt': numbered(10) });
    expect(await apply(host, repo)).toMatchObject({ status: 'applied', appliedPaths: 2 });
    fs.writeFileSync(path.join(repo, 'odd\nname.txt'), numbered(10, { 9: 'the user' }));
    fs.writeFileSync(path.join(repo, 'one.txt'), numbered(10, { 3: 'round one', 9: 'the user' }));
    round({ 'two.txt': numbered(10, { 5: 'round two' }) });
    expect(await apply(host, repo)).toMatchObject({ status: 'applied', appliedPaths: 1 });
    expect(g(['for-each-ref', CLOSED])).toBe('');
  });

  describe.skipIf(WIN)('the attributes it reads back with', () => {
    // Each filter program notes where it ran and on what, so a run in a folder of ours would show.
    const filterHost = () => {
      const host = createTestHost();
      const markers = path.join(host.root, 'filter-markers');
      fs.mkdirSync(markers);
      const filter = (name, step) => {
        const program = path.join(host.root, `${name}-${step}.sh`);
        fs.writeFileSync(program, `#!/bin/sh\necho "$PWD|$1" >> '${markers}/${name}-${step}'\ncat\n`, { mode: 0o755 });
        return forConfig(program);
      };
      host.addConfig([
        '[filter "mine"]', `\tclean = ${filter('mine', 'clean')} %f`, `\tsmudge = ${filter('mine', 'smudge')} %f`,
        '[filter "arriving"]', `\tclean = ${filter('arriving', 'clean')} %f`, `\tsmudge = ${filter('arriving', 'smudge')} %f`,
      ].join('\n'));
      const ran = () => Object.fromEntries(fs.readdirSync(markers).sort().map((marker) => [marker, fs.readFileSync(path.join(markers, marker), 'utf8').split('\n').filter(Boolean)]));
      const clear = () => { for (const marker of fs.readdirSync(markers)) fs.rmSync(path.join(markers, marker)); };
      return { host, ran, clear };
    };
    const own = (repo, g, files) => {
      for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(repo, name), content);
      g(['add', ...Object.keys(files)]);
      g(['commit', '--quiet', '-m', 'files of the user', '--', ...Object.keys(files)]);
    };

    // The verifier's A1: the space changes the user's .gitattributes to name the arriving filter for
    // every file, and changes data.bin and x.mine. The user throws the apply away but for an edit of
    // x.mine, so the working tree holds only the user's own attributes again: x.mine is read back
    // through the user's filter, in the user's folder, and the arriving filter and no smudge run.
    it('reads back with the attributes of the working tree now, never with a thrown-away .gitattributes', async () => {
      const { host, ran, clear } = filterHost();
      const work = await roundsResult(host, ['one.txt'], { prepare: ({ repo, g }) => own(repo, g, { '.gitattributes': '*.mine filter=mine\n', 'data.bin': numbered(10), 'x.mine': numbered(10) }) });
      work.round({
        '.gitattributes': '*.mine filter=mine\n* filter=arriving\n', 'data.bin': numbered(10, { 3: 'from the space' }), 'x.mine': numbered(10, { 3: 'from the space' }),
        '.lfsconfig': '[lfs]\n\turl = https://lfs.invalid\n', '.gitmodules': '[submodule "x"]\n\tpath = x\n\turl = https://invalid\n',
      });
      expect(await apply(host, work.repo)).toMatchObject({ status: 'applied', appliedPaths: 5 });
      work.putBack(work.start, ['.gitattributes', 'data.bin', '.lfsconfig', '.gitmodules']);
      clear();
      // x.mine is kept, the rest thrown away: a part, which the apply refuses, so it counts from the last apply.
      expect(await describeState(host, work.repo)).toMatchObject({ newPaths: 0, newPathsUndecided: false });
      expect(ran()).toEqual({});
      fs.writeFileSync(path.join(work.repo, 'x.mine'), numbered(10, { 3: 'from the space', 9: 'line 9 of the user' }));
      clear();
      expect(await describeState(host, work.repo)).toMatchObject({ newPaths: 0, newPathsUndecided: false });
      expect(ran()).toEqual({ 'mine-clean': [`${fs.realpathSync(work.repo)}|x.mine`] });
      await expect(apply(host, work.repo)).rejects.toMatchObject({ code: 'changes_do_not_apply', details: { stillThere: { paths: ['x.mine'] } } });
      expect(Object.keys(ran()).filter((marker) => marker.startsWith('arriving') || marker.endsWith('-smudge'))).toEqual([]);
    });

    // The verifier's A3: the host died before its `git apply` of a patch that adds a .gitattributes
    // naming the arriving filter. It was never written, so reading the working tree back, at describe
    // and at the next apply, must not run it.
    it('runs no filter a .gitattributes of an interrupted apply named, which never reached the working tree', async () => {
      const { host, ran, clear } = filterHost();
      const work = await roundsResult(host, ['one.txt'], { prepare: ({ repo, g }) => own(repo, g, { 'data.bin': numbered(10) }) });
      work.round({ '.gitattributes': '* filter=arriving\n', 'data.bin': numbered(10, { 3: 'from the space' }) });
      await expect(apply(host, work.repo, dying(host, { afterApply: false }))).rejects.toThrow();
      expect(fs.existsSync(path.join(work.repo, '.gitattributes'))).toBe(false);
      // Edited by the user, so data.bin is read back through whatever filter its attributes name.
      fs.writeFileSync(path.join(work.repo, 'data.bin'), numbered(10, { 9: 'line 9 of the user' }));
      clear();
      expect(await describeState(host, work.repo)).toMatchObject({ interruptedApply: true });
      expect(Object.keys(ran()).filter((marker) => marker.startsWith('arriving'))).toEqual([]);
      expect(await apply(host, work.repo)).toMatchObject({ status: 'applied', appliedPaths: 2 });
      expect(Object.keys(ran()).filter((marker) => marker.startsWith('arriving'))).toEqual([]);
    });

    // A .gitattributes the user kept from an apply is the user's now: the apply itself honours it, and
    // so does reading back.
    it('reads back with a .gitattributes the user kept from an apply, as the apply itself does', async () => {
      const { host, ran, clear } = filterHost();
      const work = await roundsResult(host, ['one.txt'], { prepare: ({ repo, g }) => own(repo, g, { '.gitattributes': '*.mine filter=mine\n', 'data.bin': numbered(10) }) });
      work.round({ '.gitattributes': '*.mine filter=mine\n*.bin filter=arriving\n', 'data.bin': numbered(10, { 3: 'from the space' }) });
      expect(await apply(host, work.repo)).toMatchObject({ status: 'applied', appliedPaths: 2 });
      fs.writeFileSync(path.join(work.repo, 'data.bin'), numbered(10, { 3: 'from the space', 9: 'line 9 of the user' }));
      work.round({ '.gitattributes': '*.mine filter=mine\n*.bin filter=arriving\n', 'data.bin': numbered(10, { 3: 'from the space', 5: 'from round two' }) });
      clear();
      expect(await describeState(host, work.repo)).toMatchObject({ newPaths: 1, newPathsUndecided: false });
      expect(ran()['arriving-clean']).toEqual([`${fs.realpathSync(work.repo)}|data.bin`]);
      clear();
      expect(await apply(host, work.repo)).toMatchObject({ status: 'applied', appliedPaths: 1 });
      expect(ran()['arriving-clean']?.length).toBeGreaterThan(0);
      expect(fs.readFileSync(path.join(work.repo, 'data.bin'), 'utf8')).toBe(numbered(10, { 3: 'from the space', 5: 'from round two', 9: 'line 9 of the user' }));
    });
  });
});

describe('applyAsChanges after round eight', () => {
  const apply = (host, repo, codeOut = host.codeOut()) => codeOut.applyAsChanges({ repository: repo, spaceId: SPACE_ID });
  const tryApply = (host, repo, codeOut) => apply(host, repo, codeOut).catch((error) => error);
  const describeState = (host, repo, codeOut = host.codeOut()) => codeOut.describeApplyState({ repository: repo, spaceId: SPACE_ID });
  const closed = ({ g }) => g(['for-each-ref', CLOSED]) !== '';
  const commitAll = ({ g }, message) => {
    g(['add', '--all']);
    g(['commit', '--quiet', '-m', message]);
  };
  /** Whether the process `pid` still runs, asked with signal 0, which signals nothing. */
  const alive = (pid) => {
    if (!Number.isInteger(pid) || pid <= 1) throw new Error(`not a pid to ask about: ${pid}`);
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  /** Waits up to `ms` for the pids written into `file` to be gone, and resolves those still alive. */
  const leftAfter = async (file, ms = 3000) => {
    const pids = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(Number);
    expect(pids.length).toBeGreaterThan(0);
    const until = Date.now() + ms;
    while (pids.some(alive) && Date.now() < until) await new Promise((resolve) => { setTimeout(resolve, 100); });
    return pids.filter(alive);
  };

  // The verifier's P-magic2. The user undid round one by commits, deleting the space's file named like
  // pathspec magic: both paths are the user's committed edit, so only round two comes. Read as magic,
  // `:(exclude)a.txt` would have hidden the commit of a.txt, and round one would have come back over it.
  // Not on Windows: pathspec magic starts with ':' and its globs use '*', and neither can be in a name
  // there, so such a file cannot be in a Windows work tree and its magic cannot reach the log.
  it.skipIf(WIN)('takes a name of the space that reads like pathspec magic as a name when it looks for the user\'s commits', async () => {
    const host = createTestHost();
    const work = await roundsResult(host, ['a.txt', 'b.txt']);
    work.round({ 'a.txt': numbered(10, { 5: 'round one' }), ':(exclude)a.txt': 'magic\n' });
    expect(await apply(host, work.repo)).toMatchObject({ status: 'applied', appliedPaths: 2 });
    commitAll(work, 'kept');
    fs.writeFileSync(path.join(work.repo, 'a.txt'), work.g(['show', `${work.start}:a.txt`]));
    fs.rmSync(path.join(work.repo, ':(exclude)a.txt'));
    commitAll(work, 'round one undone by a commit');
    work.round({ 'b.txt': numbered(10, { 5: 'round two' }) });
    expect(await apply(host, work.repo)).toMatchObject({ status: 'applied', appliedPaths: 1 });
    expect(fs.readFileSync(path.join(work.repo, 'a.txt'), 'utf8')).toBe(numbered(10));
    expect(closed(work)).toBe(false);
  });

  // The verifier's O-odd: a name with a line break, which the user deleted by a commit, is the user's
  // edit, found in the NUL-separated list of the log.
  it.skipIf(WIN)('takes a name with a line break that the user deleted by a commit for the user\'s edit', async () => {
    const host = createTestHost();
    const work = await roundsResult(host, ['a.txt', 'b.txt']);
    work.round({ 'odd\nname.txt': 'odd\n' });
    expect(await apply(host, work.repo)).toMatchObject({ status: 'applied', appliedPaths: 1 });
    commitAll(work, 'kept');
    fs.rmSync(path.join(work.repo, 'odd\nname.txt'));
    commitAll(work, 'deleted by the user');
    work.round({ 'b.txt': numbered(10, { 5: 'round two' }) });
    expect(await apply(host, work.repo)).toMatchObject({ status: 'applied', appliedPaths: 1 });
    expect(fs.existsSync(path.join(work.repo, 'odd\nname.txt'))).toBe(false);
  });

  // The verifier's M-mixed: the answer is per path. a.txt went back by a commit, the user's edit;
  // b.txt went back without one, thrown away: a part. The file still there is committed as it is, so
  // the refusal gives no advice about clearing the way for the branch, which git would not refuse.
  it('answers per path, a committed undo beside one without a commit being a part, and advises only where git would refuse', async () => {
    const host = createTestHost();
    const work = await roundsResult(host, ['a.txt', 'b.txt', 'c.txt']);
    work.round({ 'a.txt': numbered(10, { 5: 'round one' }), 'b.txt': numbered(10, { 5: 'round one' }) });
    expect(await apply(host, work.repo)).toMatchObject({ status: 'applied', appliedPaths: 2 });
    work.g(['commit', '--quiet', '-m', 'kept a only', '--', 'a.txt']);
    work.putBack(work.start, ['a.txt']);
    work.g(['commit', '--quiet', '-m', 'undo a', '--', 'a.txt']);
    work.putBack(work.start, ['b.txt']);
    work.round({ 'c.txt': numbered(10, { 5: 'round two' }) });
    const failure = await tryApply(host, work.repo);
    expect(failure).toMatchObject({ code: 'changes_do_not_apply', details: { thrownAway: { count: 1, paths: ['b.txt'] }, stillThere: { count: 1, paths: ['a.txt'] } } });
    expect(failure.message).toBe('You threw away part of what was last applied from this space: b.txt is back as before, while a.txt is still there or changed since. An apply now would leave out what you threw away without a word, so nothing was changed. From now on this space is applied as a branch, which holds its whole work, the rounds you already applied included.');
    expect(closed(work)).toBe(true);
  });

  // The verifier's RB-fail: a clean filter of the user's that fails while reading back is not taken for
  // any answer: nothing is known, the route closes, and the cause says so.
  it.skipIf(WIN)('answers a clean filter that fails while reading back with changes_undecided, read_back_failed', async () => {
    const host = createTestHost();
    const failing = path.join(host.root, 'failing-clean.sh');
    fs.writeFileSync(failing, '#!/bin/sh\ncat >/dev/null\necho broken >&2\nexit 3\n', { mode: 0o755 });
    const work = await roundsResult(host, ['a.txt', 'b.txt']);
    work.round({ 'a.txt': numbered(10, { 5: 'round one' }) });
    expect(await apply(host, work.repo)).toMatchObject({ status: 'applied' });
    host.addConfig(`[filter "failing"]\n\tclean = ${forConfig(failing)}\n\trequired = true`);
    fs.writeFileSync(path.join(work.repo, '.git', 'info', 'attributes'), 'a.txt filter=failing\n');
    fs.writeFileSync(path.join(work.repo, 'a.txt'), numbered(10, { 5: 'round one', 9: 'the user' }));
    work.round({ 'b.txt': numbered(10, { 5: 'round two' }) });
    expect(await describeState(host, work.repo)).toMatchObject({ newPaths: null, newPathsUndecided: true });
    const failure = await tryApply(host, work.repo);
    expect(failure).toMatchObject({ code: 'changes_undecided', details: { cause: 'read_back_failed', recorded: true } });
    expect(failure.message).toMatch(/Git said: .*broken/);
    expect(closed(work)).toBe(true);
  });

  // The list of what the user committed since the last apply is read whole, up to 64 MiB. Here it is
  // about 5 MB, past the 4 MiB a host git call keeps by default, and the answer is still exact.
  it('reads a list of the user\'s commits longer than four megabytes, and answers from it', async () => {
    const host = createTestHost();
    const work = await roundsResult(host);
    work.round({ 'one.txt': numbered(10, { 3: 'round one' }) });
    expect(await apply(host, work.repo)).toMatchObject({ status: 'applied', appliedPaths: 1 });
    work.putBack(work.start, ['one.txt']);
    const branch = work.g(['symbolic-ref', 'HEAD']).trim();
    const lines = ['blob', 'mark :1', 'data 5', 'bulk', `commit ${branch}`, 'committer u <u@example.invalid> 0 +0000', 'data 4', 'bulk', `from ${work.g(['rev-parse', 'HEAD']).trim()}`];
    for (let index = 0; index < 60_000; index += 1) lines.push(`M 100644 :1 bulk/${index % 300}/${'x'.repeat(66)}-${index}.txt`);
    work.g(['fast-import', '--quiet', '--force'], { input: `${lines.join('\n')}\n\n` });
    const listed = spawnSync('git', ['-C', work.repo, 'log', '--format=', '--name-only', '-z', '-1'], { env: host.environment, maxBuffer: 64 * 1024 * 1024 });
    expect(listed.stdout.length).toBeGreaterThan(4 * 1024 * 1024);
    work.round({ 'two.txt': numbered(10, { 5: 'round two' }) });
    // one.txt is back and no commit touched it: thrown away, so the whole work comes.
    expect(await apply(host, work.repo)).toMatchObject({ status: 'applied', appliedPaths: 2 });
    expect(closed(work)).toBe(false);
  });

  // One list of the user's commits per call, over every path, whatever the call asks of it: here the
  // look at every apply asks about a.txt and the look at the last apply about c.txt. Asked path by
  // path, a reviewer measured 112 s for a hundred thousand paths over ten thousand commits.
  it('asks git for the user\'s commits once per call, over every path', async () => {
    const host = createTestHost();
    const work = await roundsResult(host, ['a.txt', 'b.txt', 'c.txt']);
    work.round({ 'a.txt': numbered(10, { 5: 'round one' }) });
    expect(await apply(host, work.repo)).toMatchObject({ status: 'applied', appliedPaths: 1 });
    work.round({ 'b.txt': numbered(10, { 5: 'round two' }), 'c.txt': numbered(10, { 5: 'round two' }) });
    expect(await apply(host, work.repo)).toMatchObject({ status: 'applied', appliedPaths: 2 });
    fs.writeFileSync(path.join(work.repo, 'CHANGES.md'), 'from a colleague\n');
    work.g(['add', 'CHANGES.md']);
    work.g(['commit', '--quiet', '-m', 'a colleague', '--', 'CHANGES.md']);
    const logs = [];
    const counting = createCodeOut({
      git: {
        run: (directory, args, options) => host.git.run(directory, args, options),
        output: (directory, args, options) => {
          if (args.includes('log')) logs.push(args.slice(args.indexOf('--') + 1));
          return host.git.output(directory, args, options);
        },
      },
      place: null,
      temporaryDirectory: host.root,
    });
    // Everything kept: no path is back as before, so no commit is asked about.
    expect(await describeState(host, work.repo, counting)).toMatchObject({ newPaths: 0, newPathsUndecided: false });
    expect(logs).toEqual([]);
    work.putBack(work.start, ['a.txt', 'c.txt']);
    // b.txt is kept, so the whole work does not come; c.txt is back as before: a part.
    expect(await describeState(host, work.repo, counting)).toMatchObject({ newPaths: 0, newPathsUndecided: false });
    expect(logs).toEqual([[]]);
    await expect(apply(host, work.repo, counting)).rejects.toMatchObject({ code: 'changes_do_not_apply', details: { thrownAway: { paths: ['c.txt'] }, stillThere: { paths: ['b.txt'] } } });
    expect(logs).toEqual([[], []]);
  });

  // Past the listing cap nothing is known: the call is changes_undecided and the route closes.
  it('answers a list of the user\'s commits longer than the host reads with changes_undecided', async () => {
    const host = createTestHost();
    const work = await roundsResult(host);
    work.round({ 'one.txt': numbered(10, { 3: 'round one' }) });
    expect(await apply(host, work.repo)).toMatchObject({ status: 'applied' });
    work.putBack(work.start, ['one.txt']);
    fs.writeFileSync(path.join(work.repo, 'CHANGES.md'), 'from a colleague\n');
    work.g(['add', 'CHANGES.md']);
    work.g(['commit', '--quiet', '-m', 'a colleague', '--', 'CHANGES.md']);
    work.round({ 'two.txt': numbered(10, { 5: 'round two' }) });
    const isLog = (args) => args.includes('log');
    const long = createCodeOut({
      git: {
        run: (directory, args, options) => host.git.run(directory, args, options),
        output: (directory, args, options) => (isLog(args)
          ? Promise.reject(new SpaceError('command_output_too_large', 'git log printed more than 67108864 bytes and was stopped'))
          : host.git.output(directory, args, options)),
      },
      place: null,
      temporaryDirectory: host.root,
    });
    expect(await describeState(host, work.repo, long)).toMatchObject({ newPaths: null, newPathsUndecided: true });
    await expect(apply(host, work.repo, long)).rejects.toMatchObject({ code: 'changes_undecided' });
    expect(closed(work)).toBe(true);
  });

  // A HEAD with no commit, after a checkout of an orphan branch, has no commit of the user's since the
  // apply: what is back as before is thrown away.
  it('reads a HEAD with no commit as no commit of the user\'s since the apply', async () => {
    const host = createTestHost();
    const work = await roundsResult(host);
    work.round({ 'one.txt': numbered(10, { 3: 'round one' }) });
    expect(await apply(host, work.repo)).toMatchObject({ status: 'applied', appliedPaths: 1 });
    work.g(['checkout', '--quiet', '--orphan', 'fresh']);
    work.putBack(work.start, ['one.txt']);
    const second = work.round({ 'two.txt': numbered(10, { 5: 'round two' }) });
    expect(await describeState(host, work.repo)).toMatchObject({ newPaths: 2, newPathsUndecided: false });
    expect(await apply(host, work.repo)).toMatchObject({ status: 'applied', appliedPaths: 2 });
    expect(fs.readFileSync(path.join(work.repo, 'one.txt'), 'utf8')).toBe(work.g(['show', `${second}:one.txt`]));
  });

  // The verifier's W2: between the host's lstat and its open, a.txt becomes a FIFO. The open does not
  // wait for a writer, and what it opened is no plain file: nothing is known, and git is not asked
  // instead. Before, the open waited for ever and no deadline was checked.
  it.skipIf(WIN)('answers a FIFO swapped in after the look at a file with changes_undecided, at once', async () => {
    const host = createTestHost();
    const work = await roundsResult(host, ['a.txt', 'b.txt']);
    work.round({ 'a.txt': numbered(10, { 5: 'round one' }) });
    expect(await apply(host, work.repo)).toMatchObject({ status: 'applied' });
    work.round({ 'b.txt': numbered(10, { 5: 'round two' }) });
    const target = path.join(fs.realpathSync(work.repo), 'a.txt');
    let swapped = 0;
    const swapping = {
      ...fs.promises,
      lstat: async (file, ...rest) => {
        const stats = await fs.promises.lstat(file, ...rest);
        if (file === target && swapped === 0) {
          swapped += 1;
          fs.rmSync(file);
          expect(spawnSync('mkfifo', [file]).status).toBe(0);
        }
        return stats;
      },
    };
    const started = Date.now();
    try {
      const outcome = await Promise.race([
        describeState(host, work.repo, host.codeOut(null, { files: swapping })),
        new Promise((resolve) => { setTimeout(() => resolve('still waiting'), 5000); }),
      ]);
      expect(swapped).toBe(1);
      expect(outcome).toMatchObject({ newPaths: null, newPathsUndecided: true });
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      // An open that waits for a writer, as before, is let go by one.
      try {
        fs.closeSync(fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK));
      } catch {
        // No reader waiting.
      }
      fs.rmSync(target, { force: true });
    }
  });

  // A link to a file outside the project, swapped in after the host's lstat, holding exactly what the
  // apply wrote: it is not followed, and no git is asked to read it instead. Read through, the user's
  // edit would have been taken for the kept apply.
  it.skipIf(WIN)('follows no link swapped in after the look at a file, and hands it to no git', async () => {
    const host = createTestHost();
    const work = await roundsResult(host, ['a.txt', 'b.txt']);
    const first = work.round({ 'a.txt': numbered(10, { 5: 'round one' }) });
    expect(await apply(host, work.repo)).toMatchObject({ status: 'applied' });
    work.round({ 'b.txt': numbered(10, { 5: 'round two' }) });
    const outside = path.join(host.root, `outside-${crypto.randomBytes(4).toString('hex')}.txt`);
    fs.writeFileSync(outside, work.g(['show', `${first}:a.txt`]));
    fs.writeFileSync(path.join(work.repo, 'a.txt'), 'the user\'s edit\n');
    const target = path.join(fs.realpathSync(work.repo), 'a.txt');
    let swapped = 0;
    const swapping = {
      ...fs.promises,
      lstat: async (file, ...rest) => {
        const stats = await fs.promises.lstat(file, ...rest);
        if (file === target && swapped === 0) {
          swapped += 1;
          fs.rmSync(file);
          fs.symlinkSync(outside, file);
        }
        return stats;
      },
    };
    const failure = await tryApply(host, work.repo, host.codeOut(null, { files: swapping }));
    expect(swapped).toBe(1);
    expect(failure).toMatchObject({ code: 'changes_undecided', details: { cause: 'read_back_failed' } });
    expect(failure.message).toMatch(/a\.txt could not be read as a plain file\./);
  });

  // The real apply is killed with its tree on a timeout, but left to finish when the server leaves: in
  // the middle it would leave a part written and close the route.
  it('runs the real apply with its tree killed on a timeout and kept at the server\'s exit', async () => {
    const host = createTestHost();
    const work = await roundsResult(host);
    work.round({ 'one.txt': numbered(10, { 3: 'round one' }) });
    const seen = [];
    const recording = createCodeOut({
      git: {
        run: (directory, args, options) => {
          if (args.includes('apply')) seen.push({ check: args.includes('--check'), killTree: options.killTree, keepAtExit: options.keepAtExit ?? false });
          return host.git.run(directory, args, options);
        },
        output: (directory, args, options) => host.git.output(directory, args, options),
      },
      place: null,
      temporaryDirectory: host.root,
    });
    expect(await apply(host, work.repo, recording)).toMatchObject({ status: 'applied' });
    expect(seen).toEqual([{ check: true, killTree: true, keepAtExit: false }, { check: false, killTree: true, keepAtExit: true }]);
  });

  // A file that changes size while it is read, as an editor saving it at that moment makes it, is read
  // again; only one that keeps changing is not known. Here `stat` of the open file says one byte more
  // than it holds, the first `changing` times.
  const changingFiles = (target, changing) => {
    let opened = 0;
    return {
      ...fs.promises,
      open: async (file, ...rest) => {
        const handle = await fs.promises.open(file, ...rest);
        if (file !== target) return handle;
        opened += 1;
        if (opened <= changing) {
          const stat = handle.stat.bind(handle);
          handle.stat = async (...args) => { const stats = await stat(...args); stats.size += 1; return stats; };
        }
        return handle;
      },
      opened: () => opened,
    };
  };
  const keptWork = async (host) => {
    const work = await roundsResult(host);
    work.round({ 'one.txt': numbered(10, { 3: 'round one' }) });
    expect(await apply(host, work.repo)).toMatchObject({ status: 'applied', appliedPaths: 1 });
    work.round({ 'two.txt': numbered(10, { 5: 'round two' }) });
    return { work, target: path.join(fs.realpathSync(work.repo), 'one.txt') };
  };

  it('reads a file again that changed while it was read, and answers from the read that held still', async () => {
    const host = createTestHost();
    const { work, target } = await keptWork(host);
    const files = changingFiles(target, 2);
    expect(await apply(host, work.repo, host.codeOut(null, { files }))).toMatchObject({ status: 'applied', appliedPaths: 1 });
    expect(files.opened()).toBe(3);
    expect(closed(work)).toBe(false);
  });

  it('answers a file that keeps changing while it is read with changes_undecided, after a few reads', async () => {
    const host = createTestHost();
    const { work, target } = await keptWork(host);
    const files = changingFiles(target, Number.MAX_SAFE_INTEGER);
    const failure = await tryApply(host, work.repo, host.codeOut(null, { files }));
    expect(failure).toMatchObject({ code: 'changes_undecided', details: { cause: 'read_back_failed' } });
    expect(failure.message).toMatch(/one\.txt kept changing while it was read\./);
    expect(files.opened()).toBe(4);
  });

  describe.skipIf(WIN)('a filter that hangs', () => {
    // A clean filter that notes its pid and then never ends; with `after`, only from its second run on
    // for a file, so the first read goes through and a later one hangs.
    const hangingFilter = (host, repo, { after = false } = {}) => {
      const pids = path.join(host.root, `filter-pids-${crypto.randomBytes(4).toString('hex')}`);
      const seen = path.join(host.root, `filter-seen-${crypto.randomBytes(4).toString('hex')}`);
      fs.mkdirSync(seen);
      const program = path.join(host.root, `hanging-clean-${crypto.randomBytes(4).toString('hex')}.sh`);
      const hang = `echo $$ >> '${pids}'; exec sleep 60`;
      fs.writeFileSync(program, after
        ? `#!/bin/sh\nif [ -e '${seen}'/"$1" ]; then ${hang}; fi\ntouch '${seen}'/"$1"\ncat\n`
        : `#!/bin/sh\n${hang}\n`, { mode: 0o755 });
      host.addConfig(`[filter "hanging"]\n\tclean = ${forConfig(program)} %f`);
      fs.writeFileSync(path.join(repo, '.git', 'info', 'attributes'), '*.txt filter=hanging\n');
      return pids;
    };
    /** Code out whose git gives the command `picks` picks `ms` to run, as a deadline that came early. */
    const hurried = (host, picks, ms) => createCodeOut({
      git: {
        run: (directory, args, options) => host.git.run(directory, args, picks(args) ? { ...options, timeoutMs: ms } : options),
        output: (directory, args, options) => host.git.output(directory, args, picks(args) ? { ...options, timeoutMs: ms } : options),
      },
      place: null,
      temporaryDirectory: host.root,
    });

    // The verifier's W1: five calls ran out of time on a clean filter that hangs, and each left one
    // filter behind. Now the whole tree of git ends with it.
    it('ends the filter with the read-back that ran out of time', async () => {
      const host = createTestHost();
      const work = await roundsResult(host);
      work.round({ 'one.txt': numbered(10, { 3: 'round one' }) });
      expect(await apply(host, work.repo)).toMatchObject({ status: 'applied' });
      fs.writeFileSync(path.join(work.repo, 'one.txt'), numbered(10, { 3: 'round one', 9: 'the user' }));
      work.round({ 'two.txt': numbered(10, { 5: 'round two' }) });
      const pids = hangingFilter(host, work.repo);
      expect(await describeState(host, work.repo, host.codeOut(null, { readBackTimeoutMs: 1500 }))).toMatchObject({ newPathsUndecided: true });
      expect(await leftAfter(pids)).toEqual([]);
    });

    it('ends the filter with a dry run that ran out of time', async () => {
      const host = createTestHost();
      const work = await roundsResult(host);
      work.round({ 'one.txt': numbered(10, { 3: 'round one' }) });
      const pids = hangingFilter(host, work.repo);
      await expect(apply(host, work.repo, hurried(host, (args) => args.includes('--check'), 1500))).rejects.toMatchObject({ code: 'changes_undecided' });
      expect(await leftAfter(pids)).toEqual([]);
    });

    it('ends the filter with an apply that ran out of time', async () => {
      const host = createTestHost();
      const work = await roundsResult(host);
      work.round({ 'one.txt': numbered(10, { 3: 'round one' }) });
      const pids = hangingFilter(host, work.repo, { after: true });
      await expect(apply(host, work.repo, hurried(host, (args) => args.includes('apply') && !args.includes('--check'), 1500))).rejects.toMatchObject({ code: 'command_timeout' });
      expect(await leftAfter(pids)).toEqual([]);
    });
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
    ['feature/x', 'feature', 'feature'],
    ['topic', 'topic/one', 'topic/one'],
  ])('refuses %j beside the branch %j as an existing branch, and changes nothing', async (branch, existing, named) => {
    const host = createTestHost();
    const { repo, g } = await hostResult(host, { edit: ordinaryEdit });
    g(['branch', existing]);
    const before = hostState(repo);
    const failure = await host.codeOut().applyAsBranch({ repository: repo, spaceId: SPACE_ID, branch }).catch((error) => error);
    expect(failure).toMatchObject({ code: 'branch_exists', details: { branch: named } });
    expect(failure.message).toBe(`A branch named ${named} already exists, and git cannot keep a branch named ${branch} beside it. Choose another name; the existing branch was not changed.`);
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
    expect(await host.codeIn().removeSpaceRefs({ repository: space.repo, spaceId: SPACE_ID })).toEqual([APPLIED, APPLIED_FROM, APPLIED_HEAD, APPLYING, CLOSED, RESULT, START]);
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
  // host reads is the snapshot's, and the moved ref is refused rather than taken. This is the plain
  // route through the descriptor the hook inherits, and no more: the channel is not private, and on
  // Linux a process of the agent's can still open the shell's copy of it through /proc. The host
  // treats the report as data from the space either way, see the snapshot script.
  it('does not let a hook write into the report through the descriptor 3 it inherits', async () => {
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

  // The folders are what a patch pays for, like the bytes it reads and writes, so the bring-out does
  // not refuse them: the branch holds such work, and only the apply as changes refuses it.
  it('brings out work through more folders than the cap, and only the apply as changes refuses it', async () => {
    const host = createTestHost();
    const space = await spaceWithCode(host);
    for (let index = 0; index < 30; index += 1) space.write(`x${index}/a/a/a/a/f.txt`, 'the same\n');
    const out = await space.out({ maxChangedEntries: 100 });
    expect(out.changedPaths).toBe(30);
    await expect(space.codeOut.applyAsChanges({ repository: space.repo, spaceId: SPACE_ID, maxChangedEntries: 100 }))
      .rejects.toMatchObject({ code: 'changes_too_large', message: expect.stringContaining('more than 100 folders') });
    expect(await space.codeOut.applyAsBranch({ repository: space.repo, spaceId: SPACE_ID, branch: 'deep' })).toEqual({ branch: 'deep', commit: out.result });
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
