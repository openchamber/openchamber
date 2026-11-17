import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { trustMigratedBotCheckout, trustProjectRepositories } from './git-trust.js';

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
  const retained = async () => {
    const root = await fs.mkdtemp('/tmp/opencode/git-retained-bot-'); roots.push(root);
    const directory = path.join(root, 'retained'); const gitDirectory = path.join(directory, '.git');
    await fs.mkdir(gitDirectory, { recursive: true });
    const identity = async (value) => { const stat = await fs.lstat(value, { bigint: true }); return `${stat.dev}:${stat.ino}`; };
    return { projectId: 'project', itemId: 'item', directory, gitDirectory,
      directoryIdentity: await identity(directory), gitIdentity: await identity(gitDirectory) };
  };

  it('trusts only the exact retained checkout after both physical identities match, idempotently', async () => {
    const mapping = await retained(); const git = fakeGit(['/existing']);
    await trustMigratedBotCheckout({ mapping, runGit: git.runGit });
    await trustMigratedBotCheckout({ mapping, runGit: git.runGit });
    expect(git.entries).toEqual(['/existing', mapping.directory]);
    expect(git.calls.filter((args) => args.includes('--add'))).toHaveLength(1);
    expect(git.entries).not.toContain(path.dirname(mapping.directory));
    expect(git.entries).not.toContain(mapping.gitDirectory);
  });

  it('refuses a replacement or redirected retained path before reading or changing Git trust', async () => {
    const mapping = await retained(); const git = fakeGit(['*']);
    await fs.rename(mapping.gitDirectory, `${mapping.gitDirectory}.saved`);
    await fs.mkdir(mapping.gitDirectory);
    await expect(trustMigratedBotCheckout({ mapping, runGit: git.runGit })).rejects.toMatchObject({ code: 'BOT_MIGRATION_PATH_AUTHORITY_MISMATCH' });
    expect(git.calls).toEqual([]);
    await fs.rmdir(mapping.gitDirectory);
    await fs.symlink(`${mapping.gitDirectory}.saved`, mapping.gitDirectory);
    await expect(trustMigratedBotCheckout({ mapping, runGit: git.runGit })).rejects.toMatchObject({ code: 'BOT_MIGRATION_PATH_AUTHORITY_MISMATCH' });
    expect(git.calls).toEqual([]);
  });

  it('reports failed exact Git trust rather than proceeding with a retained checkout', async () => {
    const mapping = await retained();
    await expect(trustMigratedBotCheckout({ mapping, runGit: async () => ({ code: 1, stdout: '' }) }))
      .rejects.toMatchObject({ code: 'BOT_MIGRATION_GIT_TRUST_FAILED' });
  });

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
