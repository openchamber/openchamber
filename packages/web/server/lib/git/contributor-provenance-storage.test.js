import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createContributorProvenanceStore } from './contributor-provenance-storage.js';
import { gitStorageProcess } from './storage-process.test-support.js';

const roots = [];
const children = [];
afterEach(async () => {
  await Promise.all(children.splice(0).map((child) => child.stop()));
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const setup = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-contributor-'));
  roots.push(root);
  const gitDirectory = path.join(root, 'git');
  await fs.mkdir(gitDirectory);
  const filePath = path.join(root, 'provenance.json');
  const store = createContributorProvenanceStore({
    filePath,
    resolveRepositoryIdentity: async () => ({ supported: true, repositoryId: 'repo_one' }),
    resolveGitPaths: async () => ({ supported: true, bare: false, gitDirectory }),
  });
  return { root, filePath, store };
};

const provenance = {
  kind: 'contributor-fork', remoteName: 'pr-alice',
  endpointFingerprint: 'endpoint_one', sourceSha: 'a'.repeat(40),
  sourceRef: 'refs/heads/feature/login', sourceProjectId: 'alice/app', targetProjectId: 'acme/app',
  provider: 'github', instance: 'github.com', accountId: 'account_one', bindingRevision: 3,
  primaryRemote: 'origin', projectId: 'project_one', setupCommand: '',
};

describe('contributor provenance storage', () => {
  it('writes mode-0600 records and rejects stale replacement', async () => {
    const { filePath, store } = await setup();
    const created = await store.compareAndSwap('/checkout', 0, provenance);
    expect(created).toMatchObject({ repositoryId: 'repo_one', revision: 1, provenance });
    expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
    await expect(store.compareAndSwap('/checkout', 0, provenance))
      .rejects.toMatchObject({ code: 'CONTRIBUTOR_PROVENANCE_CONFLICT', status: 409 });
  });

  it('serializes independent process CAS and preserves sibling worktrees', async () => {
    const { root, filePath } = await setup();
    const worktrees = ['same', 'sibling-one', 'sibling-two'].map((name) => path.join(root, name));
    await Promise.all(worktrees.map((directory) => fs.mkdir(directory)));
    const pair = await Promise.all([
      gitStorageProcess('provenance', filePath),
      gitStorageProcess('provenance', filePath),
    ]);
    children.push(...pair);
    const competing = await Promise.all(pair.map((child) => (
      child.call('compareAndSwap', [worktrees[0], 0, provenance]).result
    )));
    expect(competing.filter((result) => result.ok)).toHaveLength(1);
    expect(competing.find((result) => !result.ok).error).toMatchObject({
      code: 'CONTRIBUTOR_PROVENANCE_CONFLICT', current: { revision: 1 },
    });
    const siblings = await Promise.all([
      pair[0].call('compareAndSwap', [worktrees[1], 0, provenance]).result,
      pair[1].call('compareAndSwap', [worktrees[2], 0, provenance]).result,
    ]);
    expect(siblings.every((result) => result.ok)).toBe(true);
    expect(JSON.parse(await fs.readFile(filePath, 'utf8')).records).toHaveLength(3);
  });

  it('fails closed for malformed and over-permissive persisted state', async () => {
    const { filePath, store } = await setup();
    await fs.writeFile(filePath, '{"version":1,"records":"bad"}', { mode: 0o600 });
    await expect(store.read('/checkout')).rejects.toMatchObject({
      code: 'CONTRIBUTOR_PROVENANCE_STORE_INVALID',
    });
    await fs.chmod(filePath, 0o644);
    await expect(store.read('/checkout')).rejects.toMatchObject({
      code: 'CONTRIBUTOR_PROVENANCE_STORE_INVALID',
    });
  });

  it('reads a bounded worktree batch from one authoritative store snapshot', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-contributor-batch-'));
    roots.push(root);
    const gitDirectories = new Map();
    for (const name of ['one', 'two']) {
      const gitDirectory = path.join(root, name);
      await fs.mkdir(gitDirectory);
      gitDirectories.set(`/${name}`, gitDirectory);
    }
    let storeReads = 0;
    const fsImpl = {
      ...fs,
      open: async (...args) => {
        if (args[0] === path.join(root, 'provenance.json')) storeReads += 1;
        return fs.open(...args);
      },
    };
    const store = createContributorProvenanceStore({
      filePath: path.join(root, 'provenance.json'), fsImpl,
      resolveRepositoryIdentity: async () => ({ supported: true, repositoryId: 'repo_one' }),
      resolveGitPaths: async (directory) => ({ supported: true, bare: false, gitDirectory: gitDirectories.get(directory) }),
    });

    const records = await store.readMany(['/one', '/two']);
    expect(records).toHaveLength(2);
    expect(records.every((record) => record.provenance === null)).toBe(true);
    expect(storeReads).toBe(1);
  });
});
