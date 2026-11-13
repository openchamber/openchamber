import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { trustProjectRepositories } from './git-trust.js';

const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

/** A git whose global `safe.directory` list starts as `listed` and records each change. */
const fakeGit = (listed = []) => {
  const entries = [...listed];
  const calls = [];
  const runGit = async (args) => {
    calls.push(args);
    if (args.includes('--get-all')) return entries.length ? { code: 0, stdout: `${entries.join('\n')}\n` } : { code: 1, stdout: '' };
    entries.push(args.at(-1));
    return { code: 0, stdout: '' };
  };
  return { runGit, entries, calls };
};

describe('the agent\'s trust in the human\'s repositories', () => {
  it('trusts each project and the folder of its repository, once, and keeps what was there', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'git-trust-')); roots.push(root);
    const repository = path.join(root, 'repo');
    await fs.mkdir(path.join(repository, '.git'), { recursive: true });
    await fs.mkdir(path.join(repository, 'packages', 'app'), { recursive: true });
    const git = fakeGit(['/agent/own']);
    const added = await trustProjectRepositories({ projects: [{ path: repository }, { path: path.join(repository, 'packages', 'app') }], runGit: git.runGit });
    expect(added).toEqual([repository, path.join(repository, 'packages', 'app')]);
    expect(git.entries).toEqual(['/agent/own', repository, path.join(repository, 'packages', 'app')]);
    expect(await trustProjectRepositories({ projects: [{ path: repository }], runGit: git.runGit })).toEqual([]);
    expect(git.calls.filter((args) => args.includes('--add'))).toHaveLength(2);
  });

  it('adds nothing for a relative path, a project outside a repository twice, or when everything is trusted', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'git-trust-')); roots.push(root);
    const plain = fakeGit();
    expect(await trustProjectRepositories({ projects: [{ path: 'relative/path' }, { path: root }], runGit: plain.runGit })).toEqual([root]);
    const everything = fakeGit(['*']);
    expect(await trustProjectRepositories({ projects: [{ path: root }], runGit: everything.runGit })).toEqual([]);
  });
});
