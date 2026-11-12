import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createContributorProvenanceStore, isContributorForkGitDirectory } from './contributor-provenance-storage.js';
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

// Rewrites the store as versions before `gitDirectory` wrote it; a listing then
// has to read every listed identity to find a record.
const forgetGitDirectories = async (filePath) => {
  const state = JSON.parse(await fs.readFile(filePath, 'utf8'));
  for (const record of state.records) delete record.gitDirectory;
  await fs.writeFile(filePath, JSON.stringify(state), { mode: 0o600 });
};

const MIB = 1024 * 1024;

// A store over real folders, where Git's answer for each worktree is `gitDirectories`.
const listingStore = (root, gitDirectories, fsImpl = fs) => {
  const identityReads = { count: 0 };
  const store = createContributorProvenanceStore({
    filePath: path.join(root, 'provenance.json'),
    resolveRepositoryIdentity: async () => {
      identityReads.count += 1;
      return { supported: true, repositoryId: 'repo_one' };
    },
    resolveGitPaths: async (directory) => ({ supported: true, bare: false, gitDirectory: gitDirectories.get(directory) }),
    fsImpl,
  });
  return { store, identityReads };
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

  it('finds a contributor fork by its git directory alone, and fails closed on a store it cannot read', async () => {
    const { root, filePath, store } = await setup();
    const gitDirectory = path.join(root, 'git');
    const other = path.join(root, 'other-git');
    await fs.mkdir(other);
    await expect(isContributorForkGitDirectory({ filePath, gitDirectory })).resolves.toBe(false);

    await store.compareAndSwap('/checkout', 0, provenance);
    await expect(isContributorForkGitDirectory({ filePath, gitDirectory })).resolves.toBe(true);
    await expect(isContributorForkGitDirectory({ filePath, gitDirectory: other })).resolves.toBe(false);

    // A later checkout in the same folder is another git directory on disk. The old
    // one stays on disk elsewhere: ext4 hands a removed directory's inode to the next one.
    await fs.rename(gitDirectory, path.join(root, 'old-git'));
    await fs.mkdir(gitDirectory);
    await expect(isContributorForkGitDirectory({ filePath, gitDirectory })).resolves.toBe(false);

    await fs.writeFile(filePath, '{', { mode: 0o600 });
    await expect(isContributorForkGitDirectory({ filePath, gitDirectory }))
      .rejects.toMatchObject({ code: 'CONTRIBUTOR_PROVENANCE_STORE_INVALID' });
  });

  it('records a worktree of an unbound repository at binding revision 0', async () => {
    const { store } = await setup();
    const unbound = { ...provenance, bindingRevision: 0 };
    await expect(store.compareAndSwap('/checkout', 0, unbound)).resolves.toMatchObject({ revision: 1, provenance: unbound });
    await expect(store.read('/checkout')).resolves.toMatchObject({ provenance: unbound });
    await expect(store.compareAndSwap('/checkout', 1, { ...provenance, bindingRevision: -1 }))
      .rejects.toMatchObject({ code: 'CONTRIBUTOR_PROVENANCE_STORE_INVALID' });
  });

  it('frees the slot of a removed worktree when the store is full', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-contributor-'));
    roots.push(root);
    const directories = new Map();
    for (const name of ['first', 'second']) {
      directories.set(`/${name}`, path.join(root, name));
      await fs.mkdir(path.join(root, name));
    }
    const store = createContributorProvenanceStore({
      filePath: path.join(root, 'provenance.json'),
      maxRecords: 1,
      resolveRepositoryIdentity: async () => ({ supported: true, repositoryId: 'repo_one' }),
      resolveGitPaths: async (directory) => ({ supported: true, bare: false, gitDirectory: directories.get(directory) }),
    });
    await store.compareAndSwap('/first', 0, provenance);
    await expect(store.compareAndSwap('/second', 0, provenance))
      .rejects.toMatchObject({ code: 'CONTRIBUTOR_PROVENANCE_STORE_CAPACITY' });

    await fs.rm(path.join(root, 'first'), { recursive: true });
    await expect(store.compareAndSwap('/second', 0, provenance)).resolves.toMatchObject({ revision: 1, provenance });
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

  it('takes the Git directory from the resolver instead of resolving it twice', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-contributor-oneprobe-'));
    roots.push(root);
    const gitDirectory = path.join(root, 'git');
    await fs.mkdir(gitDirectory);
    let resolveGitPathsCalls = 0;
    const store = createContributorProvenanceStore({
      filePath: path.join(root, 'provenance.json'),
      // The resolver answers what a record is keyed by, Git directory included.
      resolveRepositoryIdentity: async () => ({ supported: true, repositoryId: 'repo_one', gitDirectory }),
      resolveGitPaths: async () => {
        resolveGitPathsCalls += 1;
        return { supported: true, bare: false, gitDirectory };
      },
    });

    const read = await store.read('/checkout');
    expect(read).toMatchObject({ revision: 0, provenance: null });
    expect(resolveGitPathsCalls).toBe(0);
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

  it('reads an unresolvable listed worktree as no provenance instead of failing the batch', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-contributor-batch-'));
    roots.push(root);
    const gitDirectory = path.join(root, 'one');
    await fs.mkdir(gitDirectory);
    const store = createContributorProvenanceStore({
      filePath: path.join(root, 'provenance.json'),
      resolveRepositoryIdentity: async (directory) => (directory === '/gone'
        ? { supported: false }
        : { supported: true, repositoryId: 'repo_one' }),
      resolveGitPaths: async (directory) => (directory === '/gone'
        ? { supported: false, reason: 'not-a-git-repository' }
        : { supported: true, bare: false, gitDirectory }),
    });

    // A worktree deleted outside git (or a bare repository root) has no
    // identity to look up; the rest of the listing still answers.
    await store.compareAndSwap('/one', 0, provenance);
    await forgetGitDirectories(path.join(root, 'provenance.json'));
    const records = await store.readMany(['/one', '/gone']);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ revision: 1, provenance });
    expect(records[1]).toEqual({ revision: 0, provenance: null });

    // Store corruption stays a hard failure.
    await fs.writeFile(path.join(root, 'provenance.json'), '{"version":1,"records":"bad"}', { mode: 0o600 });
    await expect(store.readMany(['/one', '/gone'])).rejects.toMatchObject({
      code: 'CONTRIBUTOR_PROVENANCE_STORE_INVALID',
    });
  });

  it('lists worktrees without asking Git while no contributor-fork record is stored', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-contributor-batch-'));
    roots.push(root);
    const gitDirectory = path.join(root, 'one');
    await fs.mkdir(gitDirectory);
    let identityReads = 0;
    const store = createContributorProvenanceStore({
      filePath: path.join(root, 'provenance.json'),
      resolveRepositoryIdentity: async () => {
        identityReads += 1;
        return { supported: true, repositoryId: 'repo_one' };
      },
      resolveGitPaths: async () => ({ supported: true, bare: false, gitDirectory }),
    });

    // No store file at all.
    const directories = ['/one', '/two', '/three'];
    await expect(store.readMany(directories)).resolves.toEqual(directories.map(() => ({ revision: 0, provenance: null })));
    expect(identityReads).toBe(0);

    // A store holding only a cleared record.
    await store.compareAndSwap('/one', 0, provenance);
    await store.compareAndSwap('/one', 1, null);
    identityReads = 0;
    await expect(store.readMany(directories)).resolves.toEqual(directories.map(() => ({ revision: 0, provenance: null })));
    expect(identityReads).toBe(0);
  });

  it('skips the identity read of a listed worktree whose .git entry names no marking record', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-contributor-batch-'));
    roots.push(root);
    // A main worktree with a `.git` directory, and linked worktrees whose `.git`
    // file names their Git directory absolutely and relatively.
    const main = path.join(root, 'repo');
    const linked = path.join(root, 'linked');
    const relative = path.join(root, 'relative');
    const unreadable = path.join(root, 'unreadable');
    const gitDirectories = new Map([
      [main, path.join(main, '.git')],
      [linked, path.join(main, '.git', 'worktrees', 'linked')],
      [relative, path.join(main, '.git', 'worktrees', 'relative')],
      [unreadable, path.join(main, '.git', 'worktrees', 'unreadable')],
    ]);
    for (const [worktree, gitDirectory] of gitDirectories) {
      await fs.mkdir(worktree, { recursive: true });
      await fs.mkdir(gitDirectory, { recursive: true });
    }
    await fs.writeFile(path.join(linked, '.git'), `gitdir: ${gitDirectories.get(linked)}\n`);
    await fs.writeFile(path.join(relative, '.git'), 'gitdir: ../repo/.git/worktrees/relative\n');
    // A `.git` entry this read does not understand is left to the identity read.
    await fs.writeFile(path.join(unreadable, '.git'), 'not a gitdir pointer\n');
    let identityReads = 0;
    const store = createContributorProvenanceStore({
      filePath: path.join(root, 'provenance.json'),
      resolveRepositoryIdentity: async () => {
        identityReads += 1;
        return { supported: true, repositoryId: 'repo_one' };
      },
      resolveGitPaths: async (directory) => (gitDirectories.has(directory)
        ? { supported: true, bare: false, gitDirectory: gitDirectories.get(directory) }
        : { supported: false, reason: 'not-a-git-repository' }),
    });
    await store.compareAndSwap(main, 0, provenance);
    await store.compareAndSwap(relative, 0, provenance);
    await store.compareAndSwap(unreadable, 0, provenance);
    identityReads = 0;

    // Only `linked` names a Git directory no record names, so only its identity is not read.
    const records = await store.readMany([main, linked, relative, unreadable, path.join(root, 'gone')]);
    expect(identityReads).toBe(4);
    expect(records[0]).toMatchObject({ revision: 1, provenance });
    expect(records[1]).toEqual({ revision: 0, provenance: null });
    expect(records[2]).toMatchObject({ revision: 1, provenance });
    expect(records[3]).toMatchObject({ revision: 1, provenance });
    expect(records[4]).toEqual({ revision: 0, provenance: null });
  });

  it('reads a .git file the way Git does: after the exact prefix, up to trailing line breaks', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-contributor-batch-'));
    roots.push(root);
    // Git keeps a space after `gitdir: ` as part of the path, so a sibling
    // without it is a different directory.
    const spaced = path.join(root, 'spaced');
    await fs.mkdir(path.join(spaced, ' metadata'), { recursive: true });
    await fs.mkdir(path.join(spaced, 'metadata'));
    await fs.writeFile(path.join(spaced, '.git'), 'gitdir:  metadata\n');
    const crlf = path.join(root, 'crlf');
    await fs.mkdir(path.join(crlf, 'metadata'), { recursive: true });
    await fs.writeFile(path.join(crlf, '.git'), 'gitdir: metadata\r\n');
    const gitDirectories = new Map([
      [spaced, path.join(spaced, ' metadata')],
      [crlf, path.join(crlf, 'metadata')],
    ]);
    let identityReads = 0;
    const store = createContributorProvenanceStore({
      filePath: path.join(root, 'provenance.json'),
      resolveRepositoryIdentity: async () => {
        identityReads += 1;
        return { supported: true, repositoryId: 'repo_one' };
      },
      resolveGitPaths: async (directory) => ({ supported: true, bare: false, gitDirectory: gitDirectories.get(directory) }),
    });
    await store.compareAndSwap(spaced, 0, provenance);
    await store.compareAndSwap(crlf, 0, provenance);
    identityReads = 0;

    const records = await store.readMany([spaced, crlf]);
    expect(identityReads).toBe(2);
    expect(records.every((record) => record.provenance?.kind === 'contributor-fork')).toBe(true);
  });

  it('matches a .git entry that names the Git directory through a symlinked folder', async () => {
    // On macOS `/var` is a symlink to `/private/var`: a `.git` file may name the
    // Git directory through the link while the record holds the resolved path.
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-contributor-batch-')));
    roots.push(root);
    const realGitDirectory = path.join(root, 'private', 'repo', '.git', 'worktrees', 'checkout');
    await fs.mkdir(realGitDirectory, { recursive: true });
    await fs.symlink(path.join(root, 'private'), path.join(root, 'linked'), 'junction');
    const linkedGitDirectory = path.join(root, 'linked', 'repo', '.git', 'worktrees', 'checkout');
    const worktree = path.join(root, 'checkout');
    await fs.mkdir(worktree);
    await fs.writeFile(path.join(worktree, '.git'), `gitdir: ${linkedGitDirectory}\n`);
    let identityReads = 0;
    const store = createContributorProvenanceStore({
      filePath: path.join(root, 'provenance.json'),
      resolveRepositoryIdentity: async () => {
        identityReads += 1;
        return { supported: true, repositoryId: 'repo_one' };
      },
      resolveGitPaths: async () => ({ supported: true, bare: false, gitDirectory: linkedGitDirectory }),
    });
    const created = await store.compareAndSwap(worktree, 0, provenance);
    expect(created.gitDirectory).toBe(realGitDirectory);
    identityReads = 0;

    const [record] = await store.readMany([worktree]);
    expect(identityReads).toBe(1);
    expect(record).toMatchObject({ revision: 1, provenance });
  });

  it('keeps the mark of a relative .git target whose .. leaves a symlinked folder', async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-contributor-batch-')));
    roots.push(root);
    const worktree = path.join(root, 'checkout');
    const gitDirectory = path.join(root, 'elsewhere', 'metadata');
    await fs.mkdir(path.join(root, 'elsewhere', 'deep'), { recursive: true });
    await fs.mkdir(gitDirectory);
    // `hop/..` is `elsewhere` for Git; collapsed as text it would be this decoy.
    await fs.mkdir(path.join(worktree, 'metadata'), { recursive: true });
    await fs.symlink(path.join(root, 'elsewhere', 'deep'), path.join(worktree, 'hop'), 'junction');
    await fs.writeFile(path.join(worktree, '.git'), 'gitdir: hop/../metadata\n');
    const { store, identityReads } = listingStore(root, new Map([[worktree, gitDirectory]]));
    await store.compareAndSwap(worktree, 0, provenance);
    identityReads.count = 0;

    const [record] = await store.readMany([worktree]);
    expect(identityReads.count).toBe(1);
    expect(record).toMatchObject({ revision: 1, provenance });
  });

  it('keeps the mark of a worktree whose .git entry is a symlink to its Git directory', async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-contributor-batch-')));
    roots.push(root);
    const worktree = path.join(root, 'annexed');
    const gitDirectory = path.join(root, 'repo', '.git', 'worktrees', 'annexed');
    await fs.mkdir(gitDirectory, { recursive: true });
    await fs.mkdir(worktree);
    await fs.symlink(gitDirectory, path.join(worktree, '.git'), 'junction');
    const { store, identityReads } = listingStore(root, new Map([[worktree, gitDirectory]]));
    await store.compareAndSwap(worktree, 0, provenance);
    identityReads.count = 0;

    const [record] = await store.readMany([worktree]);
    expect(identityReads.count).toBe(1);
    expect(record).toMatchObject({ revision: 1, provenance });
  });

  it('leaves a .git file above Git\'s size limit to the identity read without reading it', async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-contributor-batch-')));
    roots.push(root);
    const gitfile = async (worktree, size) => {
      await fs.mkdir(worktree);
      const pointer = `gitdir: ${path.join(root, 'unrecorded')}`;
      await fs.writeFile(path.join(worktree, '.git'), pointer.padEnd(size, '\n'));
    };
    await fs.mkdir(path.join(root, 'unrecorded'));
    const oversized = path.join(root, 'oversized');
    const atLimit = path.join(root, 'at-limit');
    await gitfile(oversized, MIB + 1);
    await gitfile(atLimit, MIB);
    const gitDirectory = path.join(root, 'marked');
    await fs.mkdir(gitDirectory);
    const opened = [];
    const fsImpl = { ...fs, open: (file, ...rest) => { opened.push(file); return fs.open(file, ...rest); } };
    const { store, identityReads } = listingStore(root, new Map([
      [oversized, gitDirectory],
      [atLimit, path.join(root, 'unrecorded')],
    ]), fsImpl);
    await store.compareAndSwap(oversized, 0, provenance);
    identityReads.count = 0;

    const records = await store.readMany([oversized, atLimit]);
    // Both files name `unrecorded`; only the one Git would still read is skipped by it.
    expect(identityReads.count).toBe(1);
    expect(records[0]).toMatchObject({ revision: 1, provenance });
    expect(records[1]).toEqual({ revision: 0, provenance: null });
    expect(opened).not.toContain(path.join(oversized, '.git'));
  });

  it('stops reading a .git file that grew after its size was checked', async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-contributor-batch-')));
    roots.push(root);
    const worktree = path.join(root, 'growing');
    const gitDirectory = path.join(root, 'marked');
    await fs.mkdir(worktree);
    await fs.mkdir(gitDirectory);
    await fs.mkdir(path.join(root, 'unrecorded'));
    const entry = path.join(worktree, '.git');
    const pointer = `gitdir: ${path.join(root, 'unrecorded')}`;
    await fs.writeFile(entry, pointer.padEnd(2 * MIB, '\n'));
    const staleSize = Buffer.byteLength(pointer);
    let bytesRead = 0;
    const fsImpl = {
      ...fs,
      stat: async (file, ...rest) => {
        const stats = await fs.stat(file, ...rest);
        return file === entry ? Object.assign(Object.create(stats), { size: staleSize }) : stats;
      },
      open: async (file, ...rest) => {
        const handle = await fs.open(file, ...rest);
        if (file !== entry) return handle;
        return {
          read: async (...args) => {
            const result = await handle.read(...args);
            bytesRead += result.bytesRead;
            return result;
          },
          close: () => handle.close(),
        };
      },
    };
    const { store } = listingStore(root, new Map([[worktree, gitDirectory]]), fsImpl);
    await store.compareAndSwap(worktree, 0, provenance);

    const [record] = await store.readMany([worktree]);
    expect(bytesRead).toBe(staleSize + 1);
    expect(record).toMatchObject({ revision: 1, provenance });
  });

  it('resolves listed identities a few at a time while a contributor-fork record is stored', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-contributor-batch-'));
    roots.push(root);
    const gitDirectories = new Map();
    for (let index = 0; index < 12; index += 1) {
      const gitDirectory = path.join(root, `worktree-${index}`);
      await fs.mkdir(gitDirectory);
      gitDirectories.set(`/worktree-${index}`, gitDirectory);
    }
    let inFlight = 0;
    let mostInFlight = 0;
    const store = createContributorProvenanceStore({
      filePath: path.join(root, 'provenance.json'),
      resolveRepositoryIdentity: async (directory) => {
        inFlight += 1;
        mostInFlight = Math.max(mostInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return gitDirectories.has(directory) ? { supported: true, repositoryId: 'repo_one' } : { supported: false };
      },
      resolveGitPaths: async (directory) => (gitDirectories.has(directory)
        ? { supported: true, bare: false, gitDirectory: gitDirectories.get(directory) }
        : { supported: false, reason: 'not-a-git-repository' }),
    });
    await store.compareAndSwap('/worktree-3', 0, provenance);
    await forgetGitDirectories(path.join(root, 'provenance.json'));
    mostInFlight = 0;

    const listed = [...gitDirectories.keys(), '/gone'];
    const records = await store.readMany(listed);
    expect(mostInFlight).toBeGreaterThan(1);
    expect(mostInFlight).toBeLessThanOrEqual(4);
    expect(records).toHaveLength(listed.length);
    expect(records[3]).toMatchObject({ revision: 1, provenance });
    expect(records.filter((record) => record.provenance !== null)).toHaveLength(1);
    expect(records.at(-1)).toEqual({ revision: 0, provenance: null });
  });

  it('lets another process write while a listing is still resolving identities', async () => {
    const { root, filePath } = await setup();
    const [marked, listed, written] = ['marked', 'listed', 'written'].map((name) => path.join(root, name));
    await Promise.all([marked, listed, written].map((directory) => fs.mkdir(directory)));
    let listingResolving;
    const listingReachedGate = new Promise((resolve) => { listingResolving = resolve; });
    let releaseListing;
    const listingGate = new Promise((resolve) => { releaseListing = resolve; });
    // Same resolvers as the storage process fixture, so both processes agree on worktree IDs.
    const store = createContributorProvenanceStore({
      filePath,
      resolveRepositoryIdentity: async (directory) => {
        if (directory === listed) {
          listingResolving();
          await listingGate;
        }
        return { supported: true, repositoryId: 'repo_one' };
      },
      resolveGitPaths: async (directory) => ({ supported: true, bare: false, gitDirectory: directory }),
    });
    await store.compareAndSwap(marked, 0, provenance);
    await forgetGitDirectories(filePath);

    const listing = store.readMany([marked, listed]);
    await listingReachedGate;
    const other = await gitStorageProcess('provenance', filePath);
    children.push(other);
    // The other process waits 500 ms for the store lock before it gives up.
    const write = await other.call('compareAndSwap', [written, 0, provenance]).result;
    releaseListing();
    expect(write).toMatchObject({ ok: true, value: { revision: 1 } });
    const records = await listing;
    expect(records[0]).toMatchObject({ revision: 1, provenance });
    expect(records[1]).toMatchObject({ revision: 0, provenance: null });
  });
});
