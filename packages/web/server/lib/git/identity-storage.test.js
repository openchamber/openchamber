import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createGitIdentityStore } from './identity-storage.js';
import { gitStorageProcess } from './storage-process.test-support.js';

const roots = [];
const children = [];
const profile = (id) => ({ id, name: id, userName: id, userEmail: `${id}@example.com` });
const account = { provider: 'github', instance: 'github.com', accountId: 'occred:v1:github:one:r1' };
// An identity is an account, a transport and a signature; this is the smallest complete one.
const complete = (id) => ({ ...profile(id), account, transport: 'account' });
const setup = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-identities-'));
  roots.push(root);
  const dataDir = path.join(root, 'owned');
  const filePath = path.join(dataDir, 'git-identities.json');
  return { root, filePath, store: createGitIdentityStore({ dataDir }) };
};

afterEach(async () => {
  await Promise.all(children.splice(0).map((child) => child.stop()));
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('git identity storage', () => {
  it('owns the injected data directory and copies shipped profiles once', async () => {
    const { root, filePath } = await setup();
    const legacyFilePath = path.join(root, 'legacy', 'git-identities.json');
    const shipped = { ...profile('legacy'), authType: 'token', sshKey: '/retained/key', credentialHelper: 'retained-helper' };
    await fs.mkdir(path.dirname(legacyFilePath), { recursive: true });
    await fs.writeFile(legacyFilePath, JSON.stringify({ profiles: [shipped] }), { mode: 0o644 });
    const store = createGitIdentityStore({ filePath, legacyFilePath });

    expect(store.getProfiles()).toEqual([shipped]);
    expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
    await fs.writeFile(legacyFilePath, JSON.stringify({ profiles: [profile('changed')] }), { mode: 0o644 });
    expect(store.getProfiles()).toEqual([shipped]);
  });

  it('reads a store an earlier release left group-writable and makes it private', async () => {
    const { store, filePath } = await setup();
    const earlier = profile('earlier');
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify({ profiles: [earlier] }), { mode: 0o664 });
    await fs.chmod(filePath, 0o664);
    expect(store.getProfiles()).toEqual([earlier]);
    expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
  });

  it('stores an identity as an account, a transport and a signature', async () => {
    const { store } = await setup();
    const created = store.createProfile({ ...profile('work'), account, transport: 'account' });
    expect(created).toMatchObject({ account, transport: 'account' });

    const ssh = store.createProfile({
      ...profile('deploy'), transport: 'ssh', sshCredentialId: 'ocgit:v1:ssh:key-one', account,
    });
    // An SSH identity still names an account, because issues and change
    // requests are a question about the host, not about the transfer.
    expect(ssh).toMatchObject({ transport: 'ssh', sshCredentialId: 'ocgit:v1:ssh:key-one', account });

    // A signature that pushes with the machine's own Git needs no account,
    // and may still name one so it answers for issues and change requests.
    expect(store.createProfile(profile('personal'))).toMatchObject({ account: null, transport: 'system' });
    expect(store.createProfile({ ...profile('personal-with-account'), account, transport: 'system' }))
      .toMatchObject({ account, transport: 'system' });
  });

  it('refuses an identity whose transport and credentials disagree', async () => {
    const { store } = await setup();
    expect(() => store.createProfile({ ...profile('a'), transport: 'account' }))
      .toThrow(/requires an account/i);
    expect(() => store.createProfile({ ...profile('b'), account, transport: 'ssh' }))
      .toThrow(/SSH transport requires a managed key/i);
    expect(() => store.createProfile({ ...profile('c'), account, transport: 'account', sshCredentialId: 'k' }))
      .toThrow(/Only an SSH transport names a managed key/i);
    expect(() => store.createProfile({ ...profile('d'), transport: 'made-up' }))
      .toThrow(/Invalid Git identity transport/i);
    expect(() => store.createProfile({ ...profile('e'), account: { provider: 'bitbucket', instance: 'x', accountId: 'y' }, transport: 'account' }))
      .toThrow(/Invalid Git identity account/i);
  });

  it('retains server-only legacy fields while merging public author edits', async () => {
    const { filePath } = await setup();
    const legacy = {
      ...profile('legacy'),
      authType: 'token',
      sshKey: '/retained/private-key',
      host: 'legacy.example',
    };
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify({ profiles: [legacy] }), { mode: 0o600 });
    const store = createGitIdentityStore({ filePath });

    const updated = store.updateProfile('legacy', {
      ...complete('legacy'),
      name: 'Updated author',
      signCommits: true,
      signingKey: '/public/signing-key.pub',
      color: 'string',
      icon: 'briefcase',
    });

    expect(updated).toEqual({
      ...legacy,
      name: 'Updated author',
      signCommits: true,
      signingKey: '/public/signing-key.pub',
      color: 'string',
      icon: 'briefcase',
      // An edit completes the identity with its account and transport. The
      // legacy fields beside it named no credential this build can resolve, so
      // they are kept but not read.
      account,
      transport: 'account',
    });
    expect(JSON.parse(await fs.readFile(filePath, 'utf8')).profiles[0]).toEqual(updated);
  });

  it('rejects legacy fields from callers', async () => {
    const { store } = await setup();
    expect(() => store.createProfile({ ...profile('new'), sshKey: '/client/key' }))
      .toThrow('Invalid public Git identity profile');
    expect(store.getProfiles()).toEqual([]);
  });

  it('distinguishes a missing store from malformed state', async () => {
    const { filePath, store } = await setup();
    expect(store.getProfiles()).toEqual([]);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, '{broken', { mode: 0o600 });
    expect(() => store.getProfiles()).toThrow(expect.objectContaining({ code: 'GIT_IDENTITY_STORE_INVALID' }));
    expect(await fs.readFile(filePath, 'utf8')).toBe('{broken');
  });

  it('preserves sibling profiles written by independent processes', async () => {
    const { filePath, store } = await setup();
    const pair = await Promise.all([
      gitStorageProcess('identity', filePath),
      gitStorageProcess('identity', filePath),
    ]);
    children.push(...pair);
    const results = await Promise.all([
      pair[0].call('createProfile', [complete('one')]).result,
      pair[1].call('createProfile', [complete('two')]).result,
    ]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(store.getProfiles().map((entry) => entry.id).sort()).toEqual(['one', 'two']);
    expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
    expect((await fs.readdir(path.dirname(filePath))).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('reclaims a crashed owner\'s lock rather than reading an empty store, and waits on a live one', async () => {
    const { filePath } = await setup();
    const owner = await gitStorageProcess('identity', filePath);
    children.push(owner);
    owner.call('hold-lock');
    await expect.poll(() => owner.events.some((event) => event.event === 'locked')).toBe(true);
    // Contention with a live writer is busy, never empty.
    expect(() => createGitIdentityStore({ filePath, lockWaitMs: 20 }).getProfiles()).toThrow(expect.objectContaining({
      code: 'SOURCE_CONTROL_LOCK_BUSY', status: 503,
    }));
    await owner.stop();
    expect(createGitIdentityStore({ filePath, lockWaitMs: 20 }).getProfiles()).toEqual([]);
    await expect(fs.stat(`${filePath}.lock`)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
