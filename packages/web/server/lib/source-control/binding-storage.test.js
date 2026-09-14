import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createBindingStore } from './binding-storage.js';
import { storageProcess } from './storage-process.test-support.js';
import { createHttpsCredentialReference, createSshCredentialReference } from '../git/credential-resolver.js';

const directories = [];
const children = [];
const makeStore = async (fsImpl = fs) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-bindings-'));
  directories.push(directory);
  const filePath = path.join(directory, 'source-control-bindings.json');
  return { filePath, store: createBindingStore({ filePath, fsImpl }) };
};
const bindingFor = (provider, instance, accountId) => ({
  providers: [{ provider, instance, accountId, primaryRemote: 'origin', readiness: 'ready',
    endpoint: { displayUrl: 'https://example.com/repo.git', fingerprint: 'fetch' } }],
  auxiliary: [],
  remotes: [{
    name: 'origin',
    fetch: { displayUrl: 'https://example.com/repo.git', fingerprint: 'fetch' },
    push: { displayUrl: 'https://example.com/repo.git', fingerprint: 'push' },
    mode: 'system',
    readiness: 'ready',
  }],
  state: 'bound',
  configRevision: 'config_one',
});

afterEach(async () => {
  await Promise.all(children.splice(0).map((child) => child.stop()));
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('source-control binding storage', () => {
  it('serializes independent process CAS and sibling writes', async () => {
    const { filePath, store } = await makeStore();
    const pair = await Promise.all([storageProcess('binding', filePath), storageProcess('binding', filePath)]);
    children.push(...pair);
    const results = await Promise.all(pair.map((child) => child.call('compareAndSwap', ['same', 0, null]).result));
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok).error).toMatchObject({ code: 'SOURCE_CONTROL_BINDING_CONFLICT', current: { revision: 1 } });
    const siblings = await Promise.all(pair.map((child, index) => child.call('compareAndSwap', [`sibling_${index}`, 0, null]).result));
    expect(siblings.every((result) => result.ok)).toBe(true);
    for (const key of ['same', 'sibling_0', 'sibling_1']) expect(await store.read(key)).toEqual({ revision: 1, binding: null });
  });

  it('locks reads and account reconciliation against independent writers', async () => {
    const { filePath, store } = await makeStore();
    const existing = { version: 2, repositories: {
      legacy: { revision: 4, binding: { repositoryId: 'legacy', revision: 4, configRevision: 'old', state: 'bound', providers: [], remotes: [], auxiliary: [] } },
    } };
    await fs.writeFile(filePath, JSON.stringify(existing));
    const pair = await Promise.all([storageProcess('binding', filePath), storageProcess('binding', filePath)]);
    children.push(...pair);
    const results = await Promise.all([
      pair[0].call('read', ['legacy']).result,
      pair[1].call('compareAndSwap', ['sibling', 0, bindingFor('github', 'github.com', 'one')]).result,
    ]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect((await store.read('legacy')).revision).toBe(4);
    const writes = await Promise.all([
      pair[0].call('reconcileAccount', [{ provider: 'github', instance: 'github.com', accountId: 'one' }]).result,
      pair[1].call('compareAndSwap', ['other', 0, null]).result,
    ]);
    expect(writes.every((result) => result.ok)).toBe(true);
    expect(await store.read('sibling')).toMatchObject({ revision: 2, binding: { state: 'needs-attention' } });
    expect(await store.read('other')).toEqual({ revision: 1, binding: null });
  });

  it('fails busy instead of granting an empty binding while the snapshot lock exists', async () => {
    const { filePath } = await makeStore();
    await fs.writeFile(`${filePath}.lock`, 'orphan');
    const store = createBindingStore({ filePath, lockWaitMs: 20 });
    await expect(store.read('missing')).rejects.toMatchObject({ code: 'SOURCE_CONTROL_LOCK_BUSY', status: 503 });
    await expect(store.compareAndSwap('missing', 0, null)).rejects.toMatchObject({ code: 'SOURCE_CONTROL_LOCK_BUSY' });
    expect(await fs.readFile(`${filePath}.lock`, 'utf8')).toBe('orphan');
  });

  it('round trips anonymous v2 grants without converting managed or System siblings', async () => {
    const { filePath, store } = await makeStore();
    const input = bindingFor('github', 'github.com', 'account-one');
    input.remotes.push({ ...input.remotes[0], name: 'public', mode: 'anonymous' },
      { ...input.remotes[0], name: 'managed', mode: 'managed', credentialId: 'opaque-key' });
    input.auxiliary = [{ kind: 'submodule', endpoint: input.remotes[0].fetch, mode: 'anonymous', readiness: 'ready' }];
    const written = await store.compareAndSwap('repo_one', 0, input);
    expect(await createBindingStore({ filePath }).read('repo_one')).toEqual(written);
    const encoded = JSON.parse(await fs.readFile(filePath, 'utf8'));
    expect(encoded.version).toBe(2);
    for (const extra of [{ credentialId: 'secret' }, { credentialAccount: {} }, { unverifiedConfirmed: true }, { unknown: true }]) {
      const invalid = structuredClone(encoded);
      Object.assign(invalid.repositories.repo_one.binding.remotes[1], extra);
      await fs.writeFile(filePath, JSON.stringify(invalid));
      await expect(store.read('repo_one')).rejects.toMatchObject({ code: 'INVALID_SOURCE_CONTROL_BINDINGS' });
    }
  });

  it('rejects ephemeral credential presentation from persisted bindings', async () => {
    const { store } = await makeStore();
    const input = bindingFor('github', 'github.com', 'account-one');
    input.remotes[0] = { ...input.remotes[0], mode: 'managed', credentialId: 'opaque-reference',
      presentation: { status: 'unavailable' } };

    await expect(store.compareAndSwap('repo_one', 0, input))
      .rejects.toMatchObject({ code: 'INVALID_SOURCE_CONTROL_BINDINGS' });
    expect(await store.read('repo_one')).toEqual({ revision: 0, binding: null });
  });
  it('preserves the entire file after a failed write and retries without losing siblings', async () => {
    const { filePath } = await makeStore();
    const value = { version: 2, repositories: {
      repo_one: { revision: 4, binding: { repositoryId: 'repo_one', revision: 4, configRevision: 'old', state: 'bound', providers: [], remotes: [], auxiliary: [] } },
      removed: { revision: 9, binding: null },
    } };
    const encoded = JSON.stringify(value);
    await fs.writeFile(filePath, encoded);
    const failing = createBindingStore({ filePath, fsImpl: { ...fs, rename: async () => { throw new Error('write failed'); } } });
    await expect(failing.compareAndSwap('other', 0, null)).rejects.toThrow('write failed');
    expect(await fs.readFile(filePath, 'utf8')).toBe(encoded);
    expect((await fs.readdir(path.dirname(filePath))).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect(await createBindingStore({ filePath }).read('removed')).toEqual({ revision: 9, binding: null });
  });

  it.each([
    { version: 1, repositories: {}, unknown: true },
    { version: 1, repositories: { repo_one: { revision: 1, binding: null, unknown: true } } },
    { version: 2, repositories: { repo_one: { revision: 1, binding: { ...bindingFor('github', 'github.com', 'one'), repositoryId: 'repo_one', revision: 2 } } } },
  ])('rejects malformed stores without replacement', async (value) => {
    const { filePath, store } = await makeStore();
    const encoded = JSON.stringify(value);
    await fs.writeFile(filePath, encoded);
    await expect(store.read('repo_one')).rejects.toMatchObject({ code: 'INVALID_SOURCE_CONTROL_BINDINGS' });
    await expect(store.compareAndSwap('repo_one', 0, null)).rejects.toMatchObject({ code: 'INVALID_SOURCE_CONTROL_BINDINGS' });
    expect(await fs.readFile(filePath, 'utf8')).toBe(encoded);
  });

  it('treats a missing file as empty and writes versioned state with mode 0600', async () => {
    const { filePath, store } = await makeStore();
    await expect(store.read('repo_one')).resolves.toEqual({ revision: 0, binding: null });

    await store.compareAndSwap('repo_one', 0, { providers: [], remotes: [], auxiliary: [], state: 'bound', configRevision: 'config_one' });

    expect(JSON.parse(await fs.readFile(filePath, 'utf8'))).toEqual({
      version: 2,
      repositories: {
        repo_one: {
          revision: 1,
          binding: { repositoryId: 'repo_one', revision: 1, providers: [], remotes: [], auxiliary: [], state: 'bound', configRevision: 'config_one' },
        },
      },
    });
    expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
    expect((await fs.readdir(path.dirname(filePath))).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('keeps malformed and unsupported files unchanged when a mutation is attempted', async () => {
    const { filePath, store } = await makeStore();
    await fs.writeFile(filePath, JSON.stringify({ version: 3, repositories: {} }), 'utf8');

    await expect(store.read('repo_one')).rejects.toMatchObject({ code: 'INVALID_SOURCE_CONTROL_BINDINGS' });
    await expect(store.compareAndSwap('repo_one', 0, {})).rejects.toMatchObject({ code: 'INVALID_SOURCE_CONTROL_BINDINGS' });
    expect(JSON.parse(await fs.readFile(filePath, 'utf8'))).toEqual({ version: 3, repositories: {} });

    await fs.writeFile(filePath, '{broken', 'utf8');
    await expect(store.compareAndSwap('repo_one', 0, {})).rejects.toBeInstanceOf(SyntaxError);
    expect(await fs.readFile(filePath, 'utf8')).toBe('{broken');
  });

  it('allows one concurrent revision commit and returns the authoritative record to the conflict', async () => {
    const { store } = await makeStore();
    const results = await Promise.allSettled([
      store.compareAndSwap('repo_one', 0, { providers: [], remotes: [], auxiliary: [], state: 'bound', configRevision: 'config_one' }),
      store.compareAndSwap('repo_one', 0, { providers: [], remotes: [], auxiliary: [], state: 'needs-attention', configRevision: 'config_one' }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const conflict = results.find((result) => result.status === 'rejected');
    expect(conflict.reason).toMatchObject({
      code: 'SOURCE_CONTROL_BINDING_CONFLICT',
      current: { revision: 1, binding: { repositoryId: 'repo_one', revision: 1 } },
    });
  });

  it('keeps a tombstone revision so stale writers cannot recreate a deleted binding', async () => {
    const { store } = await makeStore();
    await store.compareAndSwap('repo_one', 0, { providers: [], remotes: [], auxiliary: [], state: 'bound', configRevision: 'config_one' });
    await expect(store.compareAndSwap('repo_one', 1, null)).resolves.toEqual({ revision: 2, binding: null });
    await expect(store.compareAndSwap('repo_one', 1, {})).rejects.toMatchObject({
      code: 'SOURCE_CONTROL_BINDING_CONFLICT',
      current: { revision: 2, binding: null },
    });
  });

  it('rejects unknown binding fields before writing them', async () => {
    const { filePath, store } = await makeStore();
    await expect(store.compareAndSwap('repo_one', 0, {
      providers: [],
      remotes: [],
      state: 'bound',
      configRevision: 'config_one',
      token: 'must-not-persist',
    })).rejects.toMatchObject({ code: 'INVALID_SOURCE_CONTROL_BINDINGS' });
    await expect(fs.readFile(filePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects credentialId in a persisted system remote', async () => {
    const { filePath, store } = await makeStore();
    await fs.writeFile(filePath, JSON.stringify({
      version: 1,
      repositories: {
        repo_one: {
          revision: 1,
          binding: {
            repositoryId: 'repo_one', revision: 1, providers: [], state: 'bound', configRevision: 'config_one',
            remotes: [{
              name: 'origin', mode: 'system', credentialId: 'credential_one',
              fetch: { displayUrl: 'https://example.com/repo.git', fingerprint: 'fetch' },
              push: { displayUrl: 'https://example.com/repo.git', fingerprint: 'push' },
            }],
          },
        },
      },
    }), { mode: 0o600 });
    await expect(store.read('repo_one')).rejects.toMatchObject({ code: 'INVALID_SOURCE_CONTROL_BINDINGS' });
  });

  it('preserves the previous snapshot when the atomic rename fails', async () => {
    const { filePath, store } = await makeStore();
    await store.compareAndSwap('repo_one', 0, { providers: [], remotes: [], auxiliary: [], state: 'bound', configRevision: 'config_one' });
    const previous = await fs.readFile(filePath, 'utf8');
    const failingStore = createBindingStore({
      filePath,
      fsImpl: { ...fs, rename: async () => { throw new Error('rename failed'); } },
    });

    await expect(failingStore.compareAndSwap('repo_one', 1, null)).rejects.toThrow('rename failed');
    expect(await fs.readFile(filePath, 'utf8')).toBe(previous);
  });

  it('marks only exact matching account bindings as needs-attention', async () => {
    const { store } = await makeStore();
    await store.compareAndSwap('repo_match', 0, bindingFor('gitlab', 'https://gitlab.example.com', 'account_one'));
    await store.compareAndSwap('repo_other_account', 0, bindingFor('gitlab', 'https://gitlab.example.com', 'account_two'));
    await store.compareAndSwap('repo_other_instance', 0, bindingFor('gitlab', 'https://gitlab.other.com', 'account_one'));
    await store.compareAndSwap('repo_tombstone', 0, bindingFor('gitlab', 'https://gitlab.example.com', 'account_one'));
    await store.compareAndSwap('repo_tombstone', 1, null);

    const changed = await store.reconcileAccount({ provider: 'gitlab', instance: 'https://gitlab.example.com', accountId: 'account_one' });

    expect(changed).toEqual([expect.objectContaining({ revision: 2, binding: expect.objectContaining({ repositoryId: 'repo_match', revision: 2, state: 'needs-attention' }) })]);
    await expect(store.read('repo_other_account')).resolves.toMatchObject({ revision: 1, binding: { state: 'bound' } });
    await expect(store.read('repo_other_instance')).resolves.toMatchObject({ revision: 1, binding: { state: 'bound' } });
    await expect(store.read('repo_tombstone')).resolves.toEqual({ revision: 2, binding: null });
    await expect(store.reconcileAccount({ provider: 'gitlab', instance: 'https://gitlab.example.com', accountId: 'account_one' })).resolves.toEqual([]);
    await expect(store.read('repo_match')).resolves.toMatchObject({ revision: 2, binding: { state: 'needs-attention' } });
  });

  it('revokes only managed HTTPS grants that reference the unavailable account', async () => {
    const { store } = await makeStore();
    const account = { provider: 'github', instance: 'github.com', accountId: 'credential-one' };
    const sibling = { ...account, accountId: 'credential-two' };
    const reference = (identity, providerUserId) => createHttpsCredentialReference({
      provider: identity.provider, instance: identity.instance, credentialId: identity.accountId,
      credentialRevision: 1, providerUserId,
    });
    const binding = bindingFor(account.provider, account.instance, account.accountId);
    binding.remotes = [
      { ...binding.remotes[0], mode: 'managed', credentialId: reference(account, 'github.com#1') },
      { ...binding.remotes[0], name: 'sibling', mode: 'managed', credentialId: reference(sibling, 'github.com#2') },
      { ...binding.remotes[0], name: 'ssh', mode: 'managed', credentialId: createSshCredentialReference('key-one') },
      { ...binding.remotes[0], name: 'opaque', mode: 'managed', credentialId: 'credential-one' },
    ];
    binding.auxiliary = [
      { kind: 'submodule', endpoint: { displayUrl: 'https://github.com/team/child.git', fingerprint: 'child' },
        mode: 'managed', credentialId: reference(account, 'github.com#1'), readiness: 'ready' },
      { kind: 'lfs', endpoint: { displayUrl: 'https://github.com/team/repo.git', fingerprint: 'lfs' },
        mode: 'managed', credentialId: reference(sibling, 'github.com#2'), readiness: 'ready' },
    ];
    await store.compareAndSwap('repo_one', 0, binding);

    await store.reconcileAccount(account);

    const reconciled = await store.read('repo_one');
    expect(reconciled.revision).toBe(2);
    expect(reconciled.binding.providers[0].readiness).toBe('account-unavailable');
    expect(reconciled.binding.remotes.map((remote) => remote.readiness))
      .toEqual(['confirmation-required', 'ready', 'ready', 'ready']);
    expect(reconciled.binding.auxiliary.map((grant) => grant.readiness))
      .toEqual(['confirmation-required', 'ready']);
    await expect(store.reconcileAccount(account)).resolves.toEqual([]);
  });

  it.each([
    ['credential-bearing HTTPS', { displayUrl: 'https://token@github.com/team/repo.git', fingerprint: 'safe' }],
    ['unsupported local file', { displayUrl: 'file:///private/repo.git', fingerprint: 'safe' }],
    ['unsafe fingerprint', { displayUrl: 'https://github.com/team/repo.git', fingerprint: '../secret' }],
  ])('rejects persisted %s endpoint metadata', async (_label, endpoint) => {
    const { filePath, store } = await makeStore();
    const binding = bindingFor('github', 'github.com', 'account-one');
    binding.providers[0].endpoint = endpoint;
    await expect(store.compareAndSwap('repo_one', 0, binding))
      .rejects.toMatchObject({ code: 'INVALID_SOURCE_CONTROL_BINDINGS' });
    await expect(fs.readFile(filePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    'https://github.com/team/repo.git',
    'ssh://github.com/team/repo.git',
    'ssh://git@github.com/team/repo.git',
    'git@github.com:team/repo.git',
  ])('accepts safe redacted endpoint metadata for %s', async (displayUrl) => {
    const { store } = await makeStore();
    const binding = bindingFor('github', 'github.com', 'account-one');
    binding.providers[0].endpoint = { displayUrl, fingerprint: 'safe-fingerprint' };
    await expect(store.compareAndSwap('repo_one', 0, binding)).resolves.toMatchObject({ revision: 1 });
  });

  it.each([
    ['github', 'https://GitHub.com/', 'github.com'],
    ['gitlab', 'gitlab.example.com/', 'https://gitlab.example.com'],
  ])('reconciles normalization-equivalent persisted %s instances', async (provider, persistedInstance, requestedInstance) => {
    const { store } = await makeStore();
    await store.compareAndSwap('repo_match', 0, bindingFor(provider, persistedInstance, 'account_one'));

    await expect(store.reconcileAccount({ provider, instance: requestedInstance, accountId: 'account_one' }))
      .resolves.toEqual([expect.objectContaining({ revision: 2, binding: expect.objectContaining({ state: 'needs-attention' }) })]);
  });

  it('serializes account reconciliation with client compare-and-swap', async () => {
    const { store } = await makeStore();
    await store.compareAndSwap('repo_one', 0, bindingFor('github', 'github.com', 'github.com#1'));

    const [reconciliation, clientWrite] = await Promise.allSettled([
      store.reconcileAccount({ provider: 'github', instance: 'github.com', accountId: 'github.com#1' }),
      store.compareAndSwap('repo_one', 1, bindingFor('github', 'github.com', 'github.com#2')),
    ]);

    expect(reconciliation.status).toBe('fulfilled');
    expect(clientWrite).toMatchObject({ status: 'rejected', reason: { code: 'SOURCE_CONTROL_BINDING_CONFLICT' } });
    await expect(store.read('repo_one')).resolves.toMatchObject({ revision: 2, binding: { state: 'needs-attention' } });
  });
});
