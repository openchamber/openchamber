import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addChangeIdToHead, CHANGE_STACK_LIMIT, readBranchChangeIds, readBranchTip } from './change-id.js';

const ID_A = `I${'a'.repeat(40)}`;
const ID_B = `I${'b'.repeat(40)}`;
const ID_C = `I${'c'.repeat(40)}`;

let directory;
const git = (...args) => execFileSync('git', args, {
  cwd: directory,
  encoding: 'utf8',
}).trim();
const commit = (message) => {
  git('commit', '--allow-empty', '--cleanup=verbatim', '-q', '-m', message);
  return git('rev-parse', 'HEAD');
};

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'change-id-'));
  git('init', '-q', '-b', 'main');
  // The code under test runs its own git, so the identity lives in the repo,
  // not in this helper's env: CI runners have no global one.
  git('config', 'user.name', 'T');
  git('config', 'user.email', 't@example.com');
  commit('Base');
  git('switch', '-q', '-c', 'feature');
});
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

describe('readBranchChangeIds', () => {
  it('reads the tip\'s Change-Id trailer, and the last one when there are several', async () => {
    const sha = commit(`Fix the thing\n\nChange-Id: ${ID_A}\nChange-Id: ${ID_B}\n`);
    await expect(readBranchChangeIds(directory, 'feature')).resolves.toEqual({
      head: { sha, changeId: ID_B }, stack: [], truncated: false,
    });
  });

  it('ignores a Change-Id in the body above the trailer block', async () => {
    const sha = commit(`Explain Change-Ids\n\nChange-Id: ${ID_A}\nis how a change is named.\n\nSigned-off-by: T <t@example.com>\n`);
    await expect(readBranchChangeIds(directory, 'feature')).resolves.toMatchObject({ head: { sha, changeId: null } });
  });

  it('answers null for a tip without one, and for a malformed one', async () => {
    commit('No trailer at all');
    await expect(readBranchChangeIds(directory, 'feature')).resolves.toMatchObject({ head: { changeId: null } });
    commit('Bad trailer\n\nChange-Id: Inothex\n');
    await expect(readBranchChangeIds(directory, 'feature')).resolves.toMatchObject({ head: { changeId: null } });
  });

  it('reads a trailer written with CRLF line endings', async () => {
    const sha = commit(`Windows editor\r\n\r\nChange-Id: ${ID_C}\r\n`);
    await expect(readBranchChangeIds(directory, 'feature')).resolves.toMatchObject({ head: { sha, changeId: ID_C } });
  });

  it('lists a stack above the base, oldest first, each with its own Change-Id', async () => {
    const first = commit(`One\n\nChange-Id: ${ID_A}\n`);
    const second = commit('Two, without one');
    const third = commit(`Three\n\nChange-Id: ${ID_C}\n`);
    await expect(readBranchChangeIds(directory, 'feature', 'main')).resolves.toEqual({
      head: { sha: third, changeId: ID_C },
      stack: [{ sha: first, changeId: ID_A }, { sha: second, changeId: null }, { sha: third, changeId: ID_C }],
      truncated: false,
    });
  });

  it('reads at most the limit of a long stack, from the tip', async () => {
    const shas = [];
    for (let index = 0; index <= CHANGE_STACK_LIMIT; index += 1) shas.push(commit(`Commit ${index}`));
    const { stack, truncated, head } = await readBranchChangeIds(directory, 'feature', 'main');
    expect(truncated).toBe(true);
    expect(stack).toHaveLength(CHANGE_STACK_LIMIT);
    expect(stack.at(-1).sha).toBe(head.sha);
    expect(stack[0].sha).toBe(shas[1]);
  });

  it('refuses option-shaped or range refs and rejects a missing branch', async () => {
    await expect(readBranchChangeIds(directory, '--output=x')).rejects.toMatchObject({ code: 'INVALID_GIT_REF' });
    await expect(readBranchChangeIds(directory, 'feature', 'main..x')).rejects.toMatchObject({ code: 'INVALID_GIT_REF' });
    // A branch that does not exist is a 404 the route shell answers as JSON, not a process failure.
    await expect(readBranchChangeIds(directory, 'missing')).rejects.toMatchObject({ code: 'GIT_BRANCH_NOT_FOUND', status: 404 });
  });
});

describe('addChangeIdToHead', () => {
  it('rebuilds HEAD with a Change-Id trailer, keeping its tree, parent and author', async () => {
    fs.writeFileSync(path.join(directory, 'file.txt'), 'one\n');
    git('add', 'file.txt');
    const before = commit('Add a file\n\nWhy it matters.\n');
    const parent = git('rev-parse', 'HEAD^');
    const author = git('log', '-1', '--format=%an <%ae> %ad', '--date=raw');

    const result = await addChangeIdToHead(directory, before);
    expect(result.changeId).toMatch(/^I[0-9a-f]{40}$/);
    expect(git('rev-parse', 'HEAD')).toBe(result.sha);
    expect(result.sha).not.toBe(before);
    expect(git('rev-parse', 'HEAD^{tree}')).toBe(git('rev-parse', `${before}^{tree}`));
    expect(git('rev-parse', 'HEAD^')).toBe(parent);
    expect(git('log', '-1', '--format=%an <%ae> %ad', '--date=raw')).toBe(author);
    expect(git('log', '-1', '--format=%B')).toBe(`Add a file\n\nWhy it matters.\n\nChange-Id: ${result.changeId}`);
    await expect(readBranchChangeIds(directory, 'feature')).resolves.toMatchObject({ head: { changeId: result.changeId } });
  });

  it('refuses a stale head, a dirty tree, a detached HEAD and a commit that has one', async () => {
    fs.writeFileSync(path.join(directory, 'file.txt'), 'one\n');
    git('add', 'file.txt');
    const head = commit('Add a file');
    await expect(addChangeIdToHead(directory, 'f'.repeat(40))).rejects.toMatchObject({ code: 'STALE_HEAD', status: 409 });
    await expect(addChangeIdToHead(directory, 'nope')).rejects.toMatchObject({ status: 400 });

    fs.writeFileSync(path.join(directory, 'file.txt'), 'two\n');
    await expect(addChangeIdToHead(directory, head)).rejects.toMatchObject({ code: 'DIRTY_WORKTREE' });
    git('checkout', '--', 'file.txt');
    // An untracked file is not part of the commit and does not block it.
    fs.writeFileSync(path.join(directory, 'scratch.txt'), 'x\n');

    git('switch', '-q', '--detach');
    await expect(addChangeIdToHead(directory, head)).rejects.toMatchObject({ code: 'DETACHED_HEAD' });
    git('switch', '-q', 'feature');

    const { sha, branch } = await addChangeIdToHead(directory, head);
    expect(branch).toBe('feature');
    await expect(addChangeIdToHead(directory, sha)).rejects.toMatchObject({ code: 'CHANGE_ID_PRESENT' });
  });

  // A stopped cherry-pick, revert, rebase or `git am` can leave HEAD on the
  // branch with a clean tree; rewriting the tip under it would lose its place.
  it.each([
    ['CHERRY_PICK_HEAD', 'file'],
    ['REVERT_HEAD', 'file'],
    ['rebase-merge', 'directory'],
    ['rebase-apply', 'directory'],
  ])('refuses while %s is there, and changes nothing', async (name, kind) => {
    const head = commit('Add a file');
    const statePath = path.join(directory, git('rev-parse', '--git-path', name));
    if (kind === 'file') fs.writeFileSync(statePath, `${head}\n`);
    else fs.mkdirSync(statePath);
    await expect(addChangeIdToHead(directory, head)).rejects.toMatchObject({ code: 'OPERATION_IN_PROGRESS', status: 409 });
    expect(git('rev-parse', 'HEAD')).toBe(head);
  });

  it('reads the state of a linked worktree from its own Git directory', async () => {
    commit('Add a file');
    const linked = `${directory}-linked`;
    git('worktree', 'add', '-q', '-b', 'linked', linked);
    try {
      const head = git('-C', linked, 'rev-parse', 'HEAD');
      const statePath = path.resolve(linked, git('-C', linked, 'rev-parse', '--git-path', 'rebase-apply'));
      fs.mkdirSync(statePath);
      await expect(addChangeIdToHead(linked, head)).rejects.toMatchObject({ code: 'OPERATION_IN_PROGRESS' });
      // The main worktree has no such state of its own.
      await expect(addChangeIdToHead(directory, git('rev-parse', 'HEAD'))).resolves.toMatchObject({ branch: 'feature' });
    } finally {
      fs.rmSync(linked, { recursive: true, force: true });
    }
  });
});

describe('readBranchTip', () => {
  it('answers the branch tip, or null for a branch that does not exist', async () => {
    await expect(readBranchTip(directory, 'feature')).resolves.toBe(git('rev-parse', 'feature'));
    await expect(readBranchTip(directory, 'missing')).resolves.toBeNull();
    await expect(readBranchTip(directory, '--all')).resolves.toBeNull();
  });
});

