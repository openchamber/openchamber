import { describe, expect, it, vi } from 'vitest';
import { createBindingService } from './binding-service.js';
import { fingerprintRemoteUrl, redactRemoteUrl } from './url-redaction.js';
import { createBindingStore } from './binding-storage.js';
import { createHttpsCredentialReference, createSshCredentialReference, normalizeGitRemoteEndpoint } from '../git/credential-resolver.js';
import { resolveBindingReadiness } from './binding-contract.js';

const createMemoryBindingFs = () => {
  const files = new Map();
  const lockStats = new Map();
  let nextInode = 1n;
  const fsImpl = {
    readFile: async (file) => {
      if (!files.has(file)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return files.get(file);
    },
    mkdir: async () => {},
    chmod: async () => {},
    rm: async (file) => { files.delete(file); },
    writeFile: async (file, text) => { files.set(file, text); },
    rename: async (from, to) => { files.set(to, files.get(from)); files.delete(from); },
    open: async (file) => {
      if (files.has(file)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      files.set(file, '');
      const stat = { dev: 1n, ino: nextInode++ };
      lockStats.set(file, stat);
      return { writeFile: async (text) => { files.set(file, text); }, stat: async () => stat, close: async () => {} };
    },
    lstat: async (file) => lockStats.get(file),
    unlink: async (file) => { files.delete(file); lockStats.delete(file); },
  };
  return { files, fsImpl };
};

describe('explicit remote transport configuration', () => {
  const endpoint = (url) => ({ rawUrl: url, displayUrl: redactRemoteUrl(url), fingerprint: fingerprintRemoteUrl(url) });
  const remote = (name, host = 'github.com') => ({ name,
    fetch: endpoint(`https://${host}/team/repo.git`), push: endpoint(`https://${host}/team/repo.git`),
  });
  const context = { supported: true, repositoryId: 'repo_transport', configRevision: 'topology_one', bare: false,
    remotes: [remote('origin'), remote('sibling')], transportRevision: 'private_revision',
  };
  const account = { provider: 'github', instance: 'github.com', accountId: 'credential-three' };
  const resolvedAccount = {
    accountId: account.accountId,
    credentialId: account.accountId,
    credentialRevision: 3,
    providerUserId: 'github.com#42',
    status: 'valid',
    accessToken: 'canary-private-token',
  };
  const accountReference = () => createHttpsCredentialReference({
    provider: account.provider,
    instance: account.instance,
    credentialId: resolvedAccount.credentialId,
    credentialRevision: resolvedAccount.credentialRevision,
    providerUserId: resolvedAccount.providerUserId,
  });
  const wholeBindingAuthority = (expectedRevision, binding) => ({ directory: '/repo', expectedRepositoryId: context.repositoryId,
    expectedConfigRevision: context.configRevision, expectedRevision, binding,
  });
  const setup = async (overrides = {}) => {
    const { files, fsImpl } = createMemoryBindingFs();
    const store = createBindingStore({ filePath: '/bindings.json', fsImpl });
    const resolveTransportRepository = vi.fn(async () => structuredClone(context));
    const readTransportAccount = vi.fn(async () => resolvedAccount);
    const service = createBindingService({ store, resolveRepository: async () => ({ ...context,
      remotes: context.remotes.map((remote) => ({ name: remote.name,
        fetch: { displayUrl: remote.fetch.displayUrl, fingerprint: remote.fetch.fingerprint },
        push: { displayUrl: remote.push.displayUrl, fingerprint: remote.push.fingerprint },
      })),
    }),
      resolveTransportRepository, readTransportAccount, ...overrides });
    const input = { directory: '/repo', expectedRepositoryId: context.repositoryId, expectedRevision: 0,
      expectedConfigRevision: context.configRevision, expectedFetchFingerprint: context.remotes[0].fetch.fingerprint,
      expectedPushFingerprint: context.remotes[0].push.fingerprint, remote: 'origin', transport: 'system', unverifiedConfirmed: true,
    };
    return { store, service, input, resolveTransportRepository, readTransportAccount, files };
  };

  it('creates an explicit System grant without a provider or credential lookup', async () => {
    const { service, input, readTransportAccount } = await setup();
    const after = await service.configureTransportBinding(input);
    expect(after.binding).toMatchObject({ providers: [], auxiliary: [], remotes: [{ name: 'origin', mode: 'system' }] });
    expect(after.binding.remotes[0]).not.toHaveProperty('credentialId');
    expect(readTransportAccount).not.toHaveBeenCalled();
  });

  it('configures anonymous read authority without account lookup and rejects write authority', async () => {
    const { service, input, readTransportAccount } = await setup();
    const { unverifiedConfirmed: _confirmation, ...selection } = input;
    const after = await service.configureTransportBinding({ ...selection, transport: 'anonymous' });
    expect(after.binding.remotes[0]).toEqual({ name: 'origin', mode: 'anonymous', readiness: 'ready',
      fetch: { displayUrl: context.remotes[0].fetch.displayUrl, fingerprint: context.remotes[0].fetch.fingerprint },
      push: { displayUrl: context.remotes[0].push.displayUrl, fingerprint: context.remotes[0].push.fingerprint } });
    expect(readTransportAccount).not.toHaveBeenCalled();
    const authority = { directory: '/repo', repositoryId: context.repositoryId, bindingRevision: after.revision,
      configRevision: context.configRevision, remote: 'origin', endpointKind: 'fetch' };
    expect(await service.validateGitTransportContext(authority)).toMatchObject({ transportMode: 'anonymous' });
    await expect(service.validateGitTransportContext({ ...authority, endpointKind: 'push' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    for (const extra of [{ credentialId: 'secret' }, { credentialAccount: account }, { unverifiedConfirmed: true }]) {
      await expect(service.configureTransportBinding({ ...selection, transport: 'anonymous', ...extra })).rejects.toMatchObject({ code: 'INVALID_SOURCE_CONTROL_BINDING' });
    }
  });

  it('configures and removes one rediscovered auxiliary grant while preserving siblings', async () => {
    const childEndpoints = {
      'vendor/one': { displayUrl: 'https://modules.example/one.git', fingerprint: fingerprintRemoteUrl('https://modules.example/one.git') },
      'vendor/two': { displayUrl: 'https://modules.example/two.git', fingerprint: fingerprintRemoteUrl('https://modules.example/two.git') },
    };
    const resolveCheckoutAuxiliary = vi.fn(async ({ kind, path }) => ({ kind, path, endpoint: childEndpoints[path] }));
    const { service, input } = await setup({ resolveCheckoutAuxiliary });
    const parent = await service.configureTransportBinding(input);
    const authority = (revision, path) => ({
      directory: '/repo', expectedRepositoryId: context.repositoryId, expectedRevision: revision,
      expectedConfigRevision: context.configRevision, parentRemote: 'origin',
      expectedParentFingerprint: context.remotes[0].fetch.fingerprint,
      kind: 'submodule', path, expectedEndpointFingerprint: childEndpoints[path].fingerprint,
    });

    const first = await service.configureAuxiliaryBinding({
      ...authority(parent.revision, 'vendor/one'), operation: 'configure', transport: 'anonymous',
    });
    const second = await service.configureAuxiliaryBinding({
      ...authority(first.revision, 'vendor/two'), operation: 'configure', transport: 'system', unverifiedConfirmed: true,
    });
    const replaced = await service.configureAuxiliaryBinding({
      ...authority(second.revision, 'vendor/one'), operation: 'configure', transport: 'system', unverifiedConfirmed: true,
    });
    expect(replaced.binding.auxiliary).toEqual([
      { kind: 'submodule', endpoint: childEndpoints['vendor/one'], mode: 'system', readiness: 'ready' },
      { kind: 'submodule', endpoint: childEndpoints['vendor/two'], mode: 'system', readiness: 'ready' },
    ]);
    const removed = await service.configureAuxiliaryBinding({
      ...authority(replaced.revision, 'vendor/one'), operation: 'remove',
    });
    expect(removed.binding.auxiliary).toEqual([
      { kind: 'submodule', endpoint: childEndpoints['vendor/two'], mode: 'system', readiness: 'ready' },
    ]);
    expect(resolveCheckoutAuxiliary).toHaveBeenCalledTimes(8);
    await expect(service.configureAuxiliaryBinding({
      ...authority(replaced.revision, 'vendor/two'), operation: 'remove',
    })).rejects.toMatchObject({ code: 'SOURCE_CONTROL_BINDING_STALE', status: 409 });
    await expect(service.configureAuxiliaryBinding({
      ...authority(removed.revision, 'vendor/two'), path: 'vendor/two\tother', operation: 'remove',
    })).rejects.toMatchObject({ code: 'INVALID_SOURCE_CONTROL_BINDING', status: 400 });
  });

  it('requires per-grant System consent and pins the selected HTTPS account revision', async () => {
    const childEndpoint = { displayUrl: 'https://github.com/team/child.git', fingerprint: fingerprintRemoteUrl('https://github.com/team/child.git') };
    const resolveCheckoutAuxiliary = vi.fn(async ({ kind, path }) => ({ kind, path, endpoint: childEndpoint }));
    const { service, input, readTransportAccount } = await setup({ resolveCheckoutAuxiliary });
    const parent = await service.configureTransportBinding(input);
    const authority = {
      directory: '/repo', expectedRepositoryId: context.repositoryId, expectedRevision: parent.revision,
      expectedConfigRevision: context.configRevision, parentRemote: 'origin',
      expectedParentFingerprint: context.remotes[0].fetch.fingerprint,
      kind: 'lfs', path: '.', expectedEndpointFingerprint: childEndpoint.fingerprint,
      operation: 'configure',
    };
    await expect(service.configureAuxiliaryBinding({ ...authority, transport: 'system' }))
      .rejects.toMatchObject({ code: 'INVALID_SOURCE_CONTROL_BINDING', status: 400 });

    const configured = await service.configureAuxiliaryBinding({ ...authority, transport: 'https', credentialAccount: account });
    expect(configured.binding.auxiliary).toEqual([{
      kind: 'lfs', endpoint: childEndpoint, mode: 'managed', readiness: 'ready', credentialId: accountReference(),
    }]);
    expect(readTransportAccount).toHaveBeenCalledWith(account);
  });

  it('binds exactly the anonymous clone grant at revision 1', async () => {
    const { service, readTransportAccount } = await setup();
    const result = await service.bindClonedRepository({ directory: '/repo', approvedEndpoint: context.remotes[0].fetch.rawUrl, transportMode: 'anonymous' });
    expect(result).toMatchObject({ revision: 1, binding: { providers: [], auxiliary: [], remotes: [{ name: 'origin', mode: 'anonymous', readiness: 'ready' }] } });
    expect(result.binding.remotes[0]).not.toHaveProperty('credentialId');
    expect(readTransportAccount).not.toHaveBeenCalled();
  });

  it('records the provider account chosen while cloning alongside the transport grant', async () => {
    const { service } = await setup();
    const result = await service.bindClonedRepository({
      directory: '/repo',
      approvedEndpoint: context.remotes[0].fetch.rawUrl,
      transportMode: 'anonymous',
      providerAccount: { provider: 'github', instance: 'github.com', accountId: 'credential-three' },
    });
    expect(result.binding.providers).toEqual([{
      provider: 'github',
      instance: 'github.com',
      accountId: 'credential-three',
      primaryRemote: 'origin',
      readiness: 'ready',
      endpoint: { displayUrl: context.remotes[0].fetch.displayUrl, fingerprint: context.remotes[0].fetch.fingerprint },
      repository: { owner: 'team', name: 'repo' },
    }]);
    expect(result.binding.state).toBe('bound');
  });

  it('rejects a clone provider account that names a remote the clone does not have', async () => {
    const { service } = await setup();
    await expect(service.bindClonedRepository({
      directory: '/repo',
      approvedEndpoint: context.remotes[0].fetch.rawUrl,
      transportMode: 'anonymous',
      providerAccount: { provider: 'github', instance: 'github.com', accountId: '' },
    })).rejects.toThrow();
  });

  it('accepts anonymous whole-binding updates using authoritative public endpoints', async () => {
    const { service, readTransportAccount } = await setup();
    const binding = { providers: [], remotes: [{ name: 'origin', mode: 'anonymous' }], auxiliary: [], state: 'bound' };
    const result = await service.set(wholeBindingAuthority(0, binding));
    expect(result.binding.remotes[0]).toMatchObject({ mode: 'anonymous', readiness: 'ready' });
    expect(readTransportAccount).not.toHaveBeenCalled();
    for (const extra of [{ credentialId: 'secret' }, { credentialAccount: account }, { unverifiedConfirmed: true }]) {
      await expect(service.set(wholeBindingAuthority(1, { ...binding,
        remotes: [{ ...binding.remotes[0], ...extra }] }))).rejects.toMatchObject({ code: 'INVALID_SOURCE_CONTROL_BINDING' });
    }
  });

  it('exact account removal leaves independent SSH and sibling providers operational, but the removed managed token fails resolution', async () => {
    const { store } = await setup();
    const ssh = { name: 'ssh', fetch: endpoint('ssh://git@github.com/team/repo.git'), push: endpoint('ssh://git@github.com/team/repo.git') };
    const repository = { ...context, remotes: [...context.remotes, ssh] };
    const service = createBindingService({ store,
      resolveRepository: async () => ({ ...repository, remotes: repository.remotes.map((remote) => ({ name: remote.name,
        fetch: { displayUrl: remote.fetch.displayUrl, fingerprint: remote.fetch.fingerprint },
        push: { displayUrl: remote.push.displayUrl, fingerprint: remote.push.fingerprint },
      })) }), resolveTransportRepository: async () => repository,
    });
    const provider = { ...account, primaryRemote: 'origin' };
    const sibling = { ...account, accountId: 'sibling-account', primaryRemote: 'sibling' };
    const saved = await service.set(wholeBindingAuthority(0, {
      providers: [provider, sibling], auxiliary: [], state: 'bound',
      remotes: [{ name: 'origin', mode: 'managed', credentialId: accountReference() },
        { name: 'ssh', mode: 'managed', credentialId: createSshCredentialReference('independent-key') }],
    }));
    await service.accountUnavailable(account);
    const read = await service.get('/repo');
    expect(read.revision).toBe(2);
    expect(read.binding.state).toBe('needs-attention');
    expect(read.binding.providers[0].readiness).toBe('account-unavailable');
    expect(read.binding.providers[1]).toEqual(saved.binding.providers[1]);
    expect(read.binding.remotes[0]).toEqual({ ...saved.binding.remotes[0], readiness: 'confirmation-required',
      presentation: { status: 'unavailable' } });
    expect(read.binding.remotes[1]).toEqual({ ...saved.binding.remotes[1], presentation: { status: 'unavailable' } });
    const readContext = { directory: '/repo', repositoryId: repository.repositoryId, bindingRevision: read.revision, ...sibling };
    await expect(service.validateReadContext(readContext)).resolves.toEqual(readContext);
    await expect(service.validateReadContext({ ...readContext, ...provider })).rejects.toMatchObject({ code: 'SOURCE_CONTROL_BINDING_NEEDS_ATTENTION' });
    await expect(service.validateReadContext({ ...readContext, bindingRevision: 1 })).rejects.toMatchObject({ code: 'SOURCE_CONTROL_BINDING_STALE' });
    const transport = { directory: '/repo', repositoryId: repository.repositoryId, bindingRevision: read.revision,
      configRevision: repository.configRevision, remote: 'ssh', endpointKind: 'fetch' };
    await expect(service.validateGitTransportContext(transport)).resolves.toMatchObject({ credentialId: createSshCredentialReference('independent-key') });
    await expect(service.validateGitTransportContext({ ...transport, remote: 'origin' }))
      .rejects.toMatchObject({ code: 'SOURCE_CONTROL_BINDING_STALE' });
    const repaired = await service.mutateProvider({ directory: '/repo', expectedRepositoryId: repository.repositoryId, expectedRevision: 2,
      operation: 'replace', target: provider, provider: { ...provider, accountId: 'new-account' } });
    expect(repaired.binding.providers[0].readiness).toBe('ready');
    expect(repaired.binding.remotes[0].readiness).toBe('confirmation-required');
    expect(repaired.binding.remotes[1]).toEqual(saved.binding.remotes[1]);
  });

  it('unconfirmed System grants have no execution authority until exact transport confirmation', async () => {
    const { service, input, files } = await setup();
    files.set('/bindings.json', JSON.stringify({ version: 2, repositories: { [context.repositoryId]: {
      revision: 1, binding: { repositoryId: context.repositoryId, revision: 1, state: 'bound', configRevision: 'old-public-revision',
        providers: [], auxiliary: [], remotes: [{ name: 'origin', mode: 'system', readiness: 'confirmation-required',
          fetch: { displayUrl: context.remotes[0].fetch.displayUrl, fingerprint: context.remotes[0].fetch.fingerprint },
          push: { displayUrl: context.remotes[0].push.displayUrl, fingerprint: context.remotes[0].push.fingerprint } }],
      },
    } } }));
    const read = await service.get('/repo');
    expect(read.binding.remotes[0].readiness).toBe('confirmation-required');
    const transport = { directory: '/repo', repositoryId: context.repositoryId, bindingRevision: read.revision,
      configRevision: context.configRevision, remote: 'origin', endpointKind: 'fetch' };
    await expect(service.validateGitTransportContext(transport)).rejects.toMatchObject({ code: 'SOURCE_CONTROL_BINDING_STALE' });
    const repaired = await service.configureTransportBinding({ ...input, expectedRevision: read.revision });
    await expect(service.validateGitTransportContext({ ...transport, bindingRevision: repaired.revision })).resolves.toMatchObject({ transportMode: 'system' });
  });

  it('rejects absent selection, confirmation, authority fields and client secret/path fields without writing', async () => {
    const { service, store, input } = await setup();
    for (const field of ['transport', 'unverifiedConfirmed', 'expectedRepositoryId', 'expectedRevision',
      'expectedConfigRevision', 'expectedFetchFingerprint', 'expectedPushFingerprint']) {
      const invalid = { ...input };
      delete invalid[field];
      await expect(service.configureTransportBinding(invalid)).rejects.toMatchObject({ code: 'INVALID_SOURCE_CONTROL_BINDING' });
    }
    for (const extra of [{ unverifiedConfirmed: false }, { credentialId: 'invented' }, { token: 'private' }, { privateKeyPath: '/secret/key' }]) {
      await expect(service.configureTransportBinding({ ...input, ...extra })).rejects.toMatchObject({ code: 'INVALID_SOURCE_CONTROL_BINDING' });
    }
    expect(await store.read(context.repositoryId)).toEqual({ revision: 0, binding: null });
  });

  it.each(['expectedRepositoryId', 'expectedRevision', 'expectedConfigRevision', 'expectedFetchFingerprint', 'expectedPushFingerprint'])(
    'rejects %s conflicts without granting transport', async (field) => {
      const { service, input, store } = await setup();
      await expect(service.configureTransportBinding({ ...input, [field]: field === 'expectedRevision' ? 3 : 'changed' }))
        .rejects.toMatchObject({ code: 'SOURCE_CONTROL_BINDING_STALE', status: 409 });
      expect(await store.read(context.repositoryId)).toEqual({ revision: 0, binding: null });
    });

  it('constructs the exact HTTPS account reference independently of provider selection and preserves sibling records', async () => {
    const { service, input, files, readTransportAccount } = await setup();
    const before = await service.set(wholeBindingAuthority(0, {
      providers: [{ provider: 'github', instance: 'github.com', accountId: 'different-provider-account', primaryRemote: 'origin' }],
      remotes: [{ name: 'sibling', mode: 'managed', credentialId: 'unrelated-grant' }, { name: 'origin', mode: 'system' }],
      auxiliary: [{ kind: 'lfs', endpoint: { displayUrl: 'https://elsewhere.example/lfs', fingerprint: 'lfs' }, mode: 'managed', credentialId: 'lfs-grant' }], state: 'bound',
    }));
    const { unverifiedConfirmed: _confirmation, ...authority } = input;
    const after = await service.configureTransportBinding({ ...authority, expectedRevision: 1, transport: 'https', credentialAccount: account });
    expect(readTransportAccount).toHaveBeenCalledExactlyOnceWith(account);
    expect(after.binding.remotes[1]).toMatchObject({ name: 'origin', mode: 'managed', credentialId: accountReference() });
    for (const field of ['providers', 'auxiliary']) expect(JSON.stringify(after.binding[field])).toBe(JSON.stringify(before.binding[field]));
    expect(JSON.stringify(after.binding.remotes[0])).toBe(JSON.stringify(before.binding.remotes[0]));
    expect(JSON.stringify(after)).not.toMatch(/canary-private-token|rawUrl|\/repo"|private_revision/);
    expect([...files.values()].join('')).not.toContain('canary-private-token');
  });

  it('removes one exact committed remote grant while preserving providers, siblings, auxiliary grants, and credentials', async () => {
    const { service, input, readTransportAccount } = await setup();
    const credentialId = accountReference();
    const before = await service.set(wholeBindingAuthority(0, {
      providers: [{ ...account, primaryRemote: 'origin' }],
      remotes: [{ name: 'origin', mode: 'managed', credentialId }, { name: 'sibling', mode: 'system' }],
      auxiliary: [{ kind: 'lfs', endpoint: { displayUrl: 'https://elsewhere.example/lfs', fingerprint: 'lfs' },
        mode: 'managed', credentialId: 'independent-auxiliary-grant' }],
      state: 'bound',
    }));
    const { transport: _transport, unverifiedConfirmed: _confirmation, ...authority } = input;

    const after = await service.removeTransportBinding({ ...authority, expectedRevision: before.revision });

    expect(after.binding.providers).toEqual(before.binding.providers);
    expect(after.binding.remotes).toEqual([before.binding.remotes[1]]);
    expect(after.binding.auxiliary).toEqual(before.binding.auxiliary);
    expect(readTransportAccount).not.toHaveBeenCalled();
    await expect(service.removeTransportBinding({ ...authority, expectedRevision: before.revision }))
      .rejects.toMatchObject({ code: 'SOURCE_CONTROL_BINDING_STALE', status: 409 });
  });

  it.each(['expectedRepositoryId', 'expectedRevision', 'expectedConfigRevision', 'expectedFetchFingerprint', 'expectedPushFingerprint'])(
    'rejects stale transport removal %s authority without changing any grant', async (field) => {
      const { service, input, store } = await setup();
      const before = await service.configureTransportBinding(input);
      const { transport: _transport, unverifiedConfirmed: _confirmation, ...authority } = input;
      await expect(service.removeTransportBinding({ ...authority, expectedRevision: before.revision,
        [field]: field === 'expectedRevision' ? before.revision + 1 : 'changed',
      })).rejects.toMatchObject({ code: 'SOURCE_CONTROL_BINDING_STALE', status: 409 });
      expect(await store.read(context.repositoryId)).toEqual({ revision: before.revision, binding: before.binding });
    });

  it.each(['configure', 'remove'])(
    'rejects %s when the selected remote disappears during final transport revalidation', async (operation) => {
      const { service, input, store, resolveTransportRepository } = await setup();
      let before = { revision: 0, binding: null };
      let mutation = input;
      if (operation === 'remove') {
        before = await service.configureTransportBinding(input);
        const { transport: _transport, unverifiedConfirmed: _confirmation, ...authority } = input;
        mutation = { ...authority, expectedRevision: before.revision };
      }
      resolveTransportRepository.mockReset()
        .mockResolvedValueOnce(structuredClone(context))
        .mockResolvedValueOnce({ ...structuredClone(context), remotes: [structuredClone(context.remotes[1])] });

      const result = operation === 'remove'
        ? service.removeTransportBinding(mutation)
        : service.configureTransportBinding(mutation);
      await expect(result).rejects.toMatchObject({
        code: 'SOURCE_CONTROL_BINDING_STALE', status: 409,
        current: { revision: before.revision, repository: { remotes: [{ name: 'sibling' }] } },
      });
      expect(resolveTransportRepository).toHaveBeenCalledTimes(2);
      expect(await store.read(context.repositoryId)).toEqual({ revision: before.revision, binding: before.binding });
    },
  );

  it.each(['configure', 'remove'])(
    'rejects auxiliary %s when its parent remote disappears during final revalidation', async (operation) => {
      const target = { displayUrl: 'https://modules.example/target.git', fingerprint: fingerprintRemoteUrl('https://modules.example/target.git') };
      const sibling = { displayUrl: 'https://modules.example/sibling.git', fingerprint: fingerprintRemoteUrl('https://modules.example/sibling.git') };
      const resolveCheckoutAuxiliary = vi.fn(async ({ kind, path }) => ({ kind, path, endpoint: target }));
      const { service, store, resolveTransportRepository } = await setup({ resolveCheckoutAuxiliary });
      const before = await service.set(wholeBindingAuthority(0, {
        providers: [], remotes: [{ name: 'origin', mode: 'system', unverifiedConfirmed: true }],
        auxiliary: [
          ...(operation === 'remove'
            ? [{ kind: 'submodule', endpoint: target, mode: 'system', unverifiedConfirmed: true }]
            : []),
          { kind: 'lfs', endpoint: sibling, mode: 'system', unverifiedConfirmed: true },
        ],
        state: 'bound',
      }));
      resolveTransportRepository.mockReset()
        .mockResolvedValueOnce(structuredClone(context))
        .mockResolvedValueOnce(structuredClone(context))
        .mockResolvedValueOnce({ ...structuredClone(context), remotes: [structuredClone(context.remotes[1])] });
      const authority = {
        operation, directory: '/repo', expectedRepositoryId: context.repositoryId, expectedRevision: before.revision,
        expectedConfigRevision: context.configRevision, parentRemote: 'origin',
        expectedParentFingerprint: context.remotes[0].fetch.fingerprint,
        kind: 'submodule', path: 'vendor/target', expectedEndpointFingerprint: target.fingerprint,
      };

      await expect(service.configureAuxiliaryBinding(operation === 'configure'
        ? { ...authority, transport: 'anonymous' }
        : authority)).rejects.toMatchObject({
        code: 'SOURCE_CONTROL_BINDING_STALE', status: 409,
        current: { revision: before.revision, repository: { remotes: [{ name: 'sibling' }] } },
      });
      expect(resolveTransportRepository).toHaveBeenCalledTimes(3);
      expect(resolveCheckoutAuxiliary).toHaveBeenCalledOnce();
      expect(await store.read(context.repositoryId)).toEqual({ revision: before.revision, binding: before.binding });
    },
  );

  it('rejects wrong-host, missing, invalid and mismatched exact credential accounts', async () => {
    const { service, input, readTransportAccount } = await setup();
    const { unverifiedConfirmed: _confirmation, ...authority } = input;
    const https = { ...authority, transport: 'https', credentialAccount: account };
    await expect(service.configureTransportBinding({ ...https, credentialAccount: { ...account, provider: 'gitlab', instance: 'https://gitlab.com' } }))
      .rejects.toThrow('does not match');
    expect(readTransportAccount).not.toHaveBeenCalled();
    for (const resolved of [null, { ...resolvedAccount, credentialId: 'another' },
      { ...resolvedAccount, status: 'invalid' }, { ...resolvedAccount, credentialRevision: 0 },
      { ...resolvedAccount, providerUserId: '' }]) {
      readTransportAccount.mockResolvedValueOnce(resolved);
      await expect(service.configureTransportBinding(https)).rejects.toThrow('unavailable');
    }
  });

  it('pins an exact self-managed GitLab account and rejects a different push host or port', async () => {
    const { service, input, readTransportAccount, resolveTransportRepository } = await setup();
    const selectedAccount = { provider: 'gitlab', instance: 'https://gitlab.example:8443', accountId: 'gitlab-credential-four' };
    const origin = remote('origin', 'gitlab.example:8443');
    resolveTransportRepository.mockResolvedValue({ ...context, remotes: [origin] });
    const selectedCredential = {
      id: selectedAccount.accountId, credentialId: selectedAccount.accountId, credentialRevision: 4,
      providerUserId: 'https://gitlab.example:8443#42', status: 'valid', token: 'private-gitlab-token',
    };
    readTransportAccount.mockResolvedValue(selectedCredential);
    const { unverifiedConfirmed: _confirmation, ...authority } = input;
    const intent = { ...authority, transport: 'https', credentialAccount: selectedAccount,
      expectedFetchFingerprint: origin.fetch.fingerprint, expectedPushFingerprint: origin.push.fingerprint,
    };
    const after = await service.configureTransportBinding(intent);
    expect(readTransportAccount).toHaveBeenCalledExactlyOnceWith(selectedAccount);
    expect(after.binding.remotes[0].credentialId).toBe(createHttpsCredentialReference({
      provider: selectedAccount.provider, instance: selectedAccount.instance,
      credentialId: selectedCredential.credentialId, credentialRevision: selectedCredential.credentialRevision,
      providerUserId: selectedCredential.providerUserId,
    }));
    for (const host of ['gitlab.example', 'other.example:8443']) {
      const changed = { ...origin, push: endpoint(`https://${host}/team/repo.git`) };
      resolveTransportRepository.mockResolvedValue({ ...context, remotes: [changed] });
      await expect(service.configureTransportBinding({ ...intent, expectedRevision: 1, expectedPushFingerprint: changed.push.fingerprint }))
        .rejects.toThrow('does not match');
    }
    expect(readTransportAccount).toHaveBeenCalledTimes(1);
  });

  it('preserves stale sibling topology while allowing independent repair, and fails closed on reads and CAS races', async () => {
    const { service, input, store, resolveTransportRepository } = await setup();
    const before = await service.set(wholeBindingAuthority(0, {
      providers: [], remotes: [{ name: 'sibling', mode: 'system' }], auxiliary: [], state: 'bound',
    }));
    resolveTransportRepository.mockResolvedValueOnce({ ...context, remotes: [context.remotes[0], remote('sibling', 'changed.example')] });
    const repaired = await service.configureTransportBinding({ ...input, expectedRevision: 1 });
    expect(repaired.binding.remotes[0]).toEqual(before.binding.remotes[0]);
    expect(repaired.binding.remotes[1].readiness).toBe('ready');
    resolveTransportRepository.mockRejectedValueOnce(new Error('read failed'));
    await expect(service.configureTransportBinding({ ...input, expectedRevision: 1 })).rejects.toThrow('read failed');
    const racing = createBindingService({ resolveTransportRepository: async () => context, store: {
      read: async (id) => {
        const current = await store.read(id);
        await store.compareAndSwap(id, current.revision, current.binding);
        return current;
      }, compareAndSwap: store.compareAndSwap,
    } });
    await expect(racing.configureTransportBinding({ ...input, expectedRevision: 2 })).rejects.toMatchObject({ code: 'SOURCE_CONTROL_BINDING_CONFLICT' });
    expect((await store.read(context.repositoryId)).binding).toEqual({ ...repaired.binding, revision: 3 });
  });
});

const repository = {
  supported: true,
  repositoryId: 'repo_one',
  configRevision: 'config_one',
  bare: false,
  remotes: [{
    name: 'origin',
    fetch: { displayUrl: 'https://github.com/owner/repo.git', fingerprint: 'fetch' },
    push: { displayUrl: 'git@github.com:owner/repo.git', fingerprint: 'push' },
  }],
};
const providerRemotes = {
  origin: repository.remotes[0],
  mirror: { ...repository.remotes[0], name: 'mirror',
    fetch: { displayUrl: 'https://gitlab.example.com/team/repo.git', fingerprint: 'mirror-fetch' },
    push: { displayUrl: 'git@gitlab.example.com:team/repo.git', fingerprint: 'mirror-push' },
  },
  sibling: { ...repository.remotes[0], name: 'sibling',
    fetch: { displayUrl: 'https://gitlab.com/team/repo.git', fingerprint: 'sibling-fetch' },
    push: { displayUrl: 'git@gitlab.com:team/repo.git', fingerprint: 'sibling-push' },
  },
};
const readyProvider = (provider) => ({ ...provider, readiness: 'ready', endpoint: providerRemotes[provider.primaryRemote].fetch,
  repository: provider.primaryRemote === 'origin' ? { owner: 'owner', name: 'repo' } : { owner: 'team', name: 'repo' },
});
const wholeBindingInput = (directory, expectedRevision, binding, context = repository) => ({
  directory, expectedRepositoryId: context.repositoryId, expectedRevision,
  expectedConfigRevision: context.configRevision, binding,
});

describe('narrow provider association mutations', () => {
  const original = { provider: 'github', instance: 'github.com', accountId: 'github#1', primaryRemote: 'origin' };
  const sibling = { provider: 'gitlab', instance: 'https://gitlab.com', accountId: 'gitlab#2', primaryRemote: 'sibling', repository: { owner: 'team', name: 'repo' } };
  const context = { ...repository, remotes: [providerRemotes.origin, providerRemotes.mirror, providerRemotes.sibling] };
  const additional = { provider: 'gitlab', instance: 'https://gitlab.example.com', accountId: 'gitlab#3', primaryRemote: 'mirror' };
  const setup = async () => {
    const { fsImpl } = createMemoryBindingFs();
    const store = createBindingStore({ filePath: '/bindings.json', fsImpl });
    const resolveRepository = vi.fn(async () => context);
    const service = createBindingService({ store, resolveRepository });
    const before = await service.set(wholeBindingInput('/repo', 0, {
      providers: [original, sibling],
      remotes: [{ name: 'origin', mode: 'managed', credentialId: 'remote-grant' }, { name: 'mirror', mode: 'system' }],
      auxiliary: [
        { kind: 'submodule', mode: 'managed', credentialId: 'child-grant', endpoint: { displayUrl: 'https://example.com/child.git', fingerprint: 'child' } },
        { kind: 'lfs', mode: 'system', endpoint: { displayUrl: 'https://example.com/lfs', fingerprint: 'lfs' } },
      ],
      state: 'bound',
    }, context));
    const input = { directory: '/repo', expectedRepositoryId: context.repositoryId, expectedRevision: before.revision };
    return { service, store, before, input, resolveRepository };
  };

  it('replaces the exact original association across provider and remote changes without touching siblings or grants', async () => {
    const { service, before, input } = await setup();
    const provider = { ...additional, accountId: 'other-account' };
    const after = await service.mutateProvider({ ...input, operation: 'replace', target: original, provider });
    expect(after.binding).toEqual({ ...before.binding, revision: 2, providers: [readyProvider(provider), readyProvider(sibling)] });
    expect(JSON.stringify(after.binding.remotes)).toBe(JSON.stringify(before.binding.remotes));
    expect(JSON.stringify(after.binding.auxiliary)).toBe(JSON.stringify(before.binding.auxiliary));
  });

  it('removes one association, retaining every remote and auxiliary grant even after the last provider is removed', async () => {
    const { service, before, input } = await setup();
    const after = await service.mutateProvider({ ...input, operation: 'remove', target: original });
    expect(after.binding).toEqual({ ...before.binding, revision: 2, providers: [readyProvider(sibling)] });
    const { repository: _repository, ...target } = sibling;
    const empty = await service.mutateProvider({ ...input, expectedRevision: 2, operation: 'remove', target });
    expect(empty.binding).toEqual({ ...before.binding, revision: 3, providers: [] });
  });

  it('adds explicitly without replacing an association and creates no implicit transport grant', async () => {
    const { service, before, input } = await setup();
    const provider = additional;
    const after = await service.mutateProvider({ ...input, operation: 'add', provider });
    expect(after.binding).toEqual({ ...before.binding, revision: 2, providers: [original, sibling, provider].map(readyProvider) });
    await service.resetRepositoryBinding({ directory: '/repo', expectedRepositoryId: context.repositoryId, expectedRevision: 2,
      expectedConfigRevision: context.configRevision, confirmed: true });
    const created = await service.mutateProvider({ ...input, expectedRevision: 3, operation: 'add', provider });
    expect(created.binding).toMatchObject({ providers: [provider], remotes: [], auxiliary: [], revision: 4 });
  });

  it('rejects forged provider repository metadata and provider hosts', async () => {
    const { service, store, before, input, resolveRepository } = await setup();
    await expect(service.mutateProvider({ ...input, operation: 'add', provider: {
      ...additional, repository: { owner: 'attacker', name: 'different' },
    } })).rejects.toMatchObject({ code: 'INVALID_SOURCE_CONTROL_BINDING' });
    resolveRepository.mockResolvedValue({ ...context, remotes: context.remotes.map((remote) => remote.name === 'mirror'
      ? { ...remote, fetch: { ...remote.fetch, displayUrl: 'https://attacker.invalid/team/repo.git' } } : remote) });
    await expect(service.mutateProvider({ ...input, operation: 'add', provider: additional }))
      .rejects.toMatchObject({ code: 'INVALID_SOURCE_CONTROL_BINDING' });
    expect(await store.read(context.repositoryId)).toEqual({ revision: 1, binding: before.binding });
  });

  it('rejects provider writes when repository topology changes during validation', async () => {
    const { service, store, before, input, resolveRepository } = await setup();
    resolveRepository.mockReset()
      .mockResolvedValueOnce(context)
      .mockResolvedValueOnce({ ...context, configRevision: 'changed-during-write' });
    await expect(service.mutateProvider({ ...input, operation: 'add', provider: additional }))
      .rejects.toMatchObject({ code: 'SOURCE_CONTROL_BINDING_STALE', status: 409 });
    expect(await store.read(context.repositoryId)).toEqual({ revision: 1, binding: before.binding });
  });

  it.each(['add', 'replace', 'remove'])('rejects a stale repository identity for %s even with a matching revision', async (operation) => {
    const { service, store, before, input } = await setup();
    const mutation = operation === 'add' ? { operation, provider: original }
      : operation === 'remove' ? { operation, target: original } : { operation, target: original, provider: original };
    await expect(service.mutateProvider({ ...input, ...mutation, expectedRepositoryId: 'replaced-repository' }))
      .rejects.toMatchObject({ code: 'SOURCE_CONTROL_BINDING_REPOSITORY_MISMATCH', status: 409 });
    expect(await store.read(context.repositoryId)).toEqual({ revision: 1, binding: before.binding });
  });

  it('rejects stale revisions, missing exact targets, and add/replace collisions without retry', async () => {
    const { service, store, before, input } = await setup();
    for (const mutation of [
      { ...input, expectedRevision: 0, operation: 'remove', target: original },
      { ...input, operation: 'remove', target: { ...original, accountId: 'other-account' } },
      { ...input, operation: 'replace', target: original, provider: sibling },
      { ...input, operation: 'add', provider: original },
    ]) {
      await expect(service.mutateProvider(mutation)).rejects.toMatchObject({ code: 'SOURCE_CONTROL_BINDING_STALE', status: 409 });
      expect(await store.read(context.repositoryId)).toEqual({ revision: 1, binding: before.binding });
    }
  });

  it('uses the original CAS revision when a competing mutation commits after the read', async () => {
    const { store, before, input } = await setup();
    const service = createBindingService({ resolveRepository: async () => context, store: {
      read: async (id) => {
        const current = await store.read(id);
        await store.compareAndSwap(id, current.revision, { ...current.binding, providers: [readyProvider(sibling)] });
        return current;
      },
      compareAndSwap: store.compareAndSwap,
    } });
    await expect(service.mutateProvider({ ...input, operation: 'replace', target: original, provider: { ...original, accountId: 'new' } }))
      .rejects.toMatchObject({ code: 'SOURCE_CONTROL_BINDING_CONFLICT' });
    expect(await store.read(context.repositoryId)).toEqual({ revision: 2, binding: { ...before.binding, revision: 2, providers: [readyProvider(sibling)] } });
  });

  it.each(['config', 'fetch', 'push'])('provider edits preserve exact transport endpoints through %s drift', async (drift) => {
    const { service, store, before, input, resolveRepository } = await setup();
    resolveRepository.mockResolvedValue(drift === 'config' ? { ...context, configRevision: 'changed' } : {
      ...context,
      remotes: context.remotes.map((remote) => ({ ...remote, [drift]: { ...remote[drift], fingerprint: 'changed-destination' } })),
    });
    let expectedRevision = 1;
    for (const mutation of [
      { operation: 'replace', target: original, provider: { ...original, accountId: 'new' } },
      { operation: 'remove', target: { ...original, accountId: 'new' } },
      { operation: 'add', provider: additional },
    ]) {
      const after = await service.mutateProvider({ ...input, expectedRevision, ...mutation });
      expectedRevision = after.revision;
      expect(after.binding.configRevision).toBe(before.binding.configRevision);
      for (const [index, remote] of after.binding.remotes.entries()) {
        expect(remote.fetch).toEqual(before.binding.remotes[index].fetch);
        expect(remote.push).toEqual(before.binding.remotes[index].push);
      }
      if (drift !== 'config') expect(after.binding.remotes[0].readiness).toBe('config-changed');
      if (mutation.operation === 'replace' && drift === 'fetch') {
        expect(after.binding.providers[0].endpoint).toEqual(before.binding.providers[0].endpoint);
        expect(after.binding.providers[0].readiness).toBe('config-changed');
        await expect(service.validateReadContext({ directory: '/repo', repositoryId: context.repositoryId,
          bindingRevision: after.revision, ...original, accountId: 'new' })).rejects.toMatchObject({ code: 'SOURCE_CONTROL_BINDING_STALE' });
      }
      expect((await store.read(context.repositoryId)).revision).toBe(expectedRevision);
    }
  });

  it('does not clear unrelated needs-attention state during a provider edit', async () => {
    const { service, input } = await setup();
    await service.accountUnavailable(sibling);
    const after = await service.mutateProvider({ ...input, expectedRevision: 2, operation: 'replace', target: original, provider: { ...original, accountId: 'new' } });
    expect(after.binding.state).toBe('needs-attention');
    expect(after.binding.providers[1]).toEqual({ ...readyProvider(sibling), readiness: 'account-unavailable' });
  });

  it('repairing transport does not clear provider health or confirm legacy auxiliary System grants', async () => {
    const { service, store, before } = await setup();
    await service.accountUnavailable(original);
    const contextWithPrivate = { ...context, transportRevision: 'private', remotes: context.remotes.map((remote) => ({ ...remote,
      fetch: { ...remote.fetch, rawUrl: remote.fetch.displayUrl }, push: { ...remote.push, rawUrl: remote.push.displayUrl },
    })) };
    const transportService = createBindingService({ store, resolveTransportRepository: async () => contextWithPrivate });
    const after = await transportService.configureTransportBinding({ directory: '/repo', expectedRepositoryId: context.repositoryId,
      expectedRevision: 2, expectedConfigRevision: context.configRevision,
      expectedFetchFingerprint: context.remotes[0].fetch.fingerprint, expectedPushFingerprint: context.remotes[0].push.fingerprint,
      remote: 'origin', transport: 'system', unverifiedConfirmed: true });
    expect(after.binding.providers[0].readiness).toBe('account-unavailable');
    expect(after.binding.providers[1]).toEqual(before.binding.providers[1]);
    expect(after.binding.remotes[0].readiness).toBe('ready');
    expect(after.binding.remotes[1]).toEqual(before.binding.remotes[1]);
    expect(after.binding.auxiliary).toEqual(before.binding.auxiliary);
  });

  it.each([
    { expectedRepositoryId: undefined }, { expectedRevision: undefined }, { expectedRevision: -1 },
    { target: undefined }, { operation: 'set' }, { remotes: [] }, { configRevision: 'new' },
  ])('rejects malformed or entire-binding fields in a provider mutation: %j', async (override) => {
    const { service, input } = await setup();
    await expect(service.mutateProvider({ ...input, operation: 'remove', target: original, ...override }))
      .rejects.toMatchObject({ code: 'INVALID_SOURCE_CONTROL_BINDING' });
  });
});

describe('source-control binding service', () => {
  const transportRepository = {
    ...repository,
    transportRevision: 'transport_one',
    remotes: [{
      ...repository.remotes[0],
      fetch: { ...repository.remotes[0].fetch, rawUrl: 'https://github.com/owner/repo.git' },
      push: { ...repository.remotes[0].push, rawUrl: 'ssh://git@github.com/owner/repo.git' },
    }],
  };

  it('projects safe exact credential metadata once per managed reference and isolates failures', async () => {
    const httpsReference = createHttpsCredentialReference({
      provider: 'gitlab', instance: 'https://gitlab.example.com', credentialId: 'credential-one',
      credentialRevision: 7, providerUserId: 'https://gitlab.example.com#42',
    });
    const staleReference = createHttpsCredentialReference({
      provider: 'github', instance: 'github.com', credentialId: 'credential-stale',
      credentialRevision: 3, providerUserId: 'github.com#17',
    });
    const sshReference = createSshCredentialReference('key-one');
    const fingerprint = `SHA256:${'a'.repeat(43)}`;
    const remotes = [
      ['origin', httpsReference], ['duplicate', httpsReference], ['stale', staleReference],
      ['ssh', sshReference], ['broken', createSshCredentialReference('broken')],
    ].map(([name, credentialId], index) => ({
      name,
      fetch: { displayUrl: `https://example.com/team/repo-${index}.git`, fingerprint: `fetch-${index}` },
      push: { displayUrl: `https://example.com/team/repo-${index}.git`, fingerprint: `push-${index}` },
      mode: 'managed', credentialId, readiness: 'ready',
    }));
    const context = { supported: true, repositoryId: 'repo_presented', configRevision: 'config', bare: false,
      remotes: remotes.map(({ name, fetch, push }) => ({ name, fetch, push })) };
    const binding = { repositoryId: context.repositoryId, revision: 5, state: 'bound', configRevision: 'config',
      providers: [], remotes, auxiliary: [] };
    const readTransportAccount = vi.fn(async ({ accountId }) => accountId === 'credential-one' ? {
      credentialId: 'credential-one', credentialRevision: 7, providerUserId: 'https://gitlab.example.com#42',
      status: 'valid', source: 'pat', user: { id: 42, login: 'safe-user' }, token: 'private-canary-token',
    } : null);
    const readManagedSshCredentialPresentation = vi.fn(async (credentialId) => {
      if (credentialId.endsWith('YnJva2Vu')) throw new Error('/private/key failed');
      return { fingerprint, privateKeyPath: '/private/key' };
    });
    const service = createBindingService({
      store: { read: async () => ({ revision: 5, binding }) }, resolveRepository: async () => context,
      readTransportAccount, readManagedSshCredentialPresentation,
    });

    const read = await service.get('/repository');
    expect(read.binding.remotes.map((remote) => remote.presentation)).toEqual([
      { status: 'available', transport: 'https', provider: 'gitlab', instance: 'https://gitlab.example.com',
        source: 'pat', username: 'safe-user', providerUserId: 'https://gitlab.example.com#42' },
      { status: 'available', transport: 'https', provider: 'gitlab', instance: 'https://gitlab.example.com',
        source: 'pat', username: 'safe-user', providerUserId: 'https://gitlab.example.com#42' },
      { status: 'unavailable' },
      { status: 'available', transport: 'ssh', fingerprint },
      { status: 'unavailable' },
    ]);
    expect(read.binding.remotes.map((remote) => remote.readiness)).toEqual(Array(5).fill('ready'));
    expect(readTransportAccount).toHaveBeenCalledTimes(2);
    expect(readTransportAccount).toHaveBeenCalledWith({ provider: 'gitlab', instance: 'https://gitlab.example.com',
      accountId: 'credential-one', credentialRevision: 7 });
    expect(readTransportAccount).toHaveBeenCalledWith({ provider: 'github', instance: 'github.com',
      accountId: 'credential-stale', credentialRevision: 3 });
    expect(readManagedSshCredentialPresentation).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(read.binding.remotes.map((remote) => remote.presentation)))
      .not.toMatch(/private-canary-token|privateKeyPath|\/private\/key|credential-one|ocgit:/);
  });

  it('bounds one binding projection to 256 unique managed credential lookups', async () => {
    const remotes = Array.from({ length: 257 }, (_, index) => {
      const endpoint = { displayUrl: `https://github.com/team/repo-${index}.git`, fingerprint: `endpoint-${index}` };
      return { name: `remote-${index}`, fetch: endpoint, push: endpoint, mode: 'managed', readiness: 'ready',
        credentialId: createHttpsCredentialReference({ provider: 'github', instance: 'github.com',
          credentialId: `credential-${index}`, credentialRevision: 1, providerUserId: `github.com#${index}` }) };
    });
    const context = { supported: true, repositoryId: 'repo_bounded', configRevision: 'config', bare: false,
      remotes: remotes.map(({ name, fetch, push }) => ({ name, fetch, push })) };
    const binding = { repositoryId: context.repositoryId, revision: 1, state: 'bound', configRevision: 'config',
      providers: [], remotes, auxiliary: [] };
    const readTransportAccount = vi.fn(async () => null);
    const service = createBindingService({
      store: { read: async () => ({ revision: 1, binding }) }, resolveRepository: async () => context,
      readTransportAccount,
    });

    const read = await service.get('/repository');
    expect(readTransportAccount).toHaveBeenCalledTimes(256);
    expect(read.binding.remotes).toHaveLength(257);
    expect(read.binding.remotes.every((remote) => remote.presentation.status === 'unavailable')).toBe(true);
  });

  it('validates the exact current bound read context', async () => {
    const binding = {
      repositoryId: 'repo_one', revision: 3, state: 'bound', configRevision: 'config_one', remotes: [], auxiliary: [],
      providers: [readyProvider({ provider: 'github', instance: 'github.com', accountId: 'github.com#1', primaryRemote: 'origin' })],
    };
    const service = createBindingService({
      store: { read: vi.fn(async () => ({ revision: 3, binding })), compareAndSwap: vi.fn() },
      resolveRepository: async () => repository,
    });

    await expect(service.validateReadContext({
      directory: '/repository', repositoryId: 'repo_one', provider: 'github', instance: 'https://GitHub.com/',
      accountId: 'github.com#1', bindingRevision: 3, primaryRemote: 'origin',
    })).resolves.toEqual({
      directory: '/repository', repositoryId: 'repo_one', provider: 'github', instance: 'github.com',
      accountId: 'github.com#1', bindingRevision: 3, primaryRemote: 'origin',
    });
  });

  it('validates and copies mutation context after the authoritative binding', async () => {
    const binding = {
      repositoryId: 'repo_one', revision: 3, state: 'bound', configRevision: 'config_one', remotes: [], auxiliary: [],
      providers: [readyProvider({ provider: 'github', instance: 'github.com', accountId: 'github.com#1', primaryRemote: 'origin' })],
    };
    const service = createBindingService({
      store: { read: vi.fn(async () => ({ revision: 3, binding })), compareAndSwap: vi.fn() },
      resolveRepository: async () => repository,
    });
    const target = { project: { owner: ' openchamber ', name: ' openchamber ' }, number: 12, head: ' feature ', base: ' main ', headSha: ' abc ' };

    const result = await service.validateMutationContext({
      directory: '/repository', repositoryId: 'repo_one', provider: 'github', instance: 'https://GitHub.com/',
      accountId: 'github.com#1', bindingRevision: 3, primaryRemote: 'origin', idempotencyKey: ' request-one ', target,
    });

    expect(result).toEqual({
      directory: '/repository', repositoryId: 'repo_one', provider: 'github', instance: 'github.com',
      accountId: 'github.com#1', bindingRevision: 3, primaryRemote: 'origin', idempotencyKey: 'request-one',
      target: { project: { owner: 'openchamber', name: 'openchamber' }, number: 12, head: 'feature', base: 'main', headSha: 'abc' },
    });
    expect(result.target).not.toBe(target);
    expect(result.target.project).not.toBe(target.project);
  });

  it('returns the exact private endpoint for an authoritative transport binding', async () => {
    const binding = {
      repositoryId: 'repo_one', revision: 3, state: 'bound', configRevision: 'config_one', providers: [], auxiliary: [],
      remotes: [{
        name: 'origin', fetch: repository.remotes[0].fetch, push: repository.remotes[0].push,
        mode: 'managed', credentialId: 'credential_one', readiness: 'ready',
      }],
    };
    const service = createBindingService({
      store: { read: vi.fn(async () => ({ revision: 3, binding })), compareAndSwap: vi.fn() },
      resolveRepository: async () => repository,
      resolveTransportRepository: async () => transportRepository,
    });

    await expect(service.validateGitTransportContext({
      directory: '/repository', repositoryId: 'repo_one', bindingRevision: 3,
      configRevision: 'config_one', remote: 'origin', endpointKind: 'push',
    })).resolves.toEqual({
      directory: '/repository', repositoryId: 'repo_one', bindingRevision: 3,
      configRevision: 'config_one', remote: 'origin', endpointKind: 'push',
      endpoint: 'ssh://git@github.com/owner/repo.git', endpointFingerprint: 'push',
      transportMode: 'managed', credentialId: 'credential_one',
      transportRevision: 'transport_one',
    });
  });

  it('requires an exact auxiliary path grant and returns only its endpoint credential', async () => {
    const childEndpoint = 'https://example.com/owner/child.git';
    const binding = {
      repositoryId: 'repo_one', revision: 3, state: 'bound', configRevision: 'config_one', providers: [], remotes: [],
      auxiliary: [{
        kind: 'submodule', mode: 'managed', credentialId: 'child-only-credential', readiness: 'ready',
        endpoint: { displayUrl: childEndpoint, fingerprint: fingerprintRemoteUrl(childEndpoint) },
      }],
    };
    const service = createBindingService({
      store: { read: vi.fn(async () => ({ revision: 3, binding })), compareAndSwap: vi.fn() },
      resolveRepository: async () => repository,
      resolveTransportRepository: async () => transportRepository,
    });
    const input = {
      directory: '/repository', repositoryId: 'repo_one', bindingRevision: 3,
      configRevision: 'config_one', kind: 'submodule', rawEndpoint: childEndpoint,
    };

    await expect(service.validateGitAuxiliaryContext(input)).resolves.toMatchObject({
      endpoint: childEndpoint,
      endpointFingerprint: fingerprintRemoteUrl(childEndpoint),
      credentialId: 'child-only-credential',
    });
    await expect(service.validateGitAuxiliaryContext({
      ...input, rawEndpoint: 'https://example.com/owner/other.git',
    })).rejects.toMatchObject({ code: 'GIT_AUXILIARY_AUTHORIZATION_REQUIRED', status: 409 });
  });

  it.each([
    ['unknown input key', { extra: true }],
    ['invalid endpoint kind', { endpointKind: 'receive' }],
    ['missing revision', { bindingRevision: undefined }],
  ])('rejects malformed transport context with 400 for %s', async (_label, override) => {
    const service = createBindingService({
      store: { read: vi.fn(), compareAndSwap: vi.fn() },
      resolveRepository: async () => repository,
      resolveTransportRepository: async () => transportRepository,
    });
    await expect(service.validateGitTransportContext({
      directory: '/repository', repositoryId: 'repo_one', bindingRevision: 3,
      configRevision: 'config_one', remote: 'origin', endpointKind: 'fetch', ...override,
    })).rejects.toMatchObject({ code: 'INVALID_GIT_TRANSPORT_CONTEXT', status: 400 });
  });

  it.each([
    ['repository', { repositoryId: 'repo_other' }, {}],
    ['binding revision', { bindingRevision: 2 }, {}],
    ['config revision', { configRevision: 'config_old' }, {}],
    ['remote', { remote: 'upstream' }, {}],
    ['endpoint fingerprint', {}, { remotes: [{ ...transportRepository.remotes[0], fetch: { ...transportRepository.remotes[0].fetch, fingerprint: 'changed' } }] }],
  ])('returns redacted current authority for stale transport %s', async (_label, override, repositoryOverride) => {
    const binding = {
      repositoryId: 'repo_one', revision: 3, state: 'bound', configRevision: 'config_one', providers: [],
      auxiliary: [],
      remotes: [{ name: 'origin', fetch: repository.remotes[0].fetch, push: repository.remotes[0].push, mode: 'system', readiness: 'ready' }],
    };
    const currentRepository = { ...transportRepository, ...repositoryOverride };
    const service = createBindingService({
      store: { read: vi.fn(async () => ({ revision: 3, binding })), compareAndSwap: vi.fn() },
      resolveRepository: async () => repository,
      resolveTransportRepository: async () => currentRepository,
    });
    let error;
    try {
      await service.validateGitTransportContext({
        directory: '/repository', repositoryId: 'repo_one', bindingRevision: 3,
        configRevision: 'config_one', remote: 'origin', endpointKind: 'fetch', ...override,
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: 'SOURCE_CONTROL_BINDING_STALE', status: 409 });
    expect(error.current).toEqual({
      repository: {
        supported: true,
        repositoryId: currentRepository.repositoryId,
        configRevision: currentRepository.configRevision,
        bare: currentRepository.bare,
        remotes: currentRepository.remotes.map((candidate) => ({
          name: candidate.name,
          fetch: { displayUrl: candidate.fetch.displayUrl, fingerprint: candidate.fetch.fingerprint },
          push: { displayUrl: candidate.push.displayUrl, fingerprint: candidate.push.fingerprint },
        })),
      },
      revision: 3,
      binding: resolveBindingReadiness(binding, currentRepository),
    });
    expect(JSON.stringify(error.current)).not.toContain('rawUrl');
    expect(JSON.stringify(error.current)).not.toContain('transport_one');
  });

  it('requires a credential for managed transport and marks system transport uncredentialed', async () => {
    const makeService = (mode, credentialId) => {
      const remote = {
        name: 'origin', fetch: repository.remotes[0].fetch, push: repository.remotes[0].push, mode, readiness: 'ready',
      };
      if (credentialId) remote.credentialId = credentialId;
      return createBindingService({
        store: {
          read: vi.fn(async () => ({
          revision: 3,
          binding: {
            repositoryId: 'repo_one', revision: 3, state: 'bound', configRevision: 'config_one', providers: [],
            remotes: [remote], auxiliary: [],
          },
          })),
          compareAndSwap: vi.fn(),
        },
        resolveRepository: async () => repository,
        resolveTransportRepository: async () => transportRepository,
      });
    };
    const input = {
      directory: '/repository', repositoryId: 'repo_one', bindingRevision: 3,
      configRevision: 'config_one', remote: 'origin', endpointKind: 'fetch',
    };

    await expect(makeService('managed').validateGitTransportContext(input))
      .rejects.toMatchObject({ code: 'SOURCE_CONTROL_BINDING_STALE', status: 409 });
    await expect(makeService('system').validateGitTransportContext(input))
      .resolves.not.toHaveProperty('credentialId');
  });

  it.each([
    ['missing idempotency key', { idempotencyKey: undefined }],
    ['array target', { target: [] }],
    ['unknown target field', { target: { project: { owner: 'owner', name: 'repo' }, private: 'text' } }],
    ['unknown project field', { target: { project: { owner: 'owner', name: 'repo', id: 'private' } } }],
    ['unsafe number', { target: { project: { owner: 'owner', name: 'repo' }, number: Number.MAX_VALUE } }],
    ['empty head', { target: { project: { owner: 'owner', name: 'repo' }, head: ' ' } }],
  ])('rejects mutation context with %s', async (_label, override) => {
    const binding = {
      repositoryId: 'repo_one', revision: 3, state: 'bound', configRevision: 'config_one', remotes: [], auxiliary: [],
      providers: [readyProvider({ provider: 'github', instance: 'github.com', accountId: 'github.com#1', primaryRemote: 'origin' })],
    };
    const service = createBindingService({
      store: { read: vi.fn(async () => ({ revision: 3, binding })), compareAndSwap: vi.fn() },
      resolveRepository: async () => repository,
    });
    await expect(service.validateMutationContext({
      directory: '/repository', repositoryId: 'repo_one', provider: 'github', instance: 'github.com',
      accountId: 'github.com#1', bindingRevision: 3, primaryRemote: 'origin', idempotencyKey: 'request-one',
      target: { project: { owner: 'owner', name: 'repo' } }, ...override,
    })).rejects.toMatchObject({ code: 'INVALID_SOURCE_CONTROL_MUTATION_CONTEXT', status: 400 });
  });

  it('preserves binding mismatch errors for mutation context', async () => {
    const service = createBindingService({
      store: { read: vi.fn(), compareAndSwap: vi.fn() },
      resolveRepository: async () => repository,
    });
    await expect(service.validateMutationContext({
      directory: '/repository', repositoryId: 'other', provider: 'github', instance: 'github.com',
      accountId: 'github.com#1', bindingRevision: 3, primaryRemote: 'origin', idempotencyKey: 'request-one',
      target: { project: { owner: 'owner', name: 'repo' } },
    })).rejects.toMatchObject({ code: 'SOURCE_CONTROL_BINDING_REPOSITORY_MISMATCH', status: 409 });
  });

  it('validates each exact binding when one provider instance has multiple accounts and remotes', async () => {
    const repositoryWithUpstream = {
      ...repository,
      remotes: [
        ...repository.remotes,
        {
          name: 'upstream',
          fetch: { displayUrl: 'https://example.com/upstream/repo.git', fingerprint: 'upstream-fetch' },
          push: { displayUrl: 'git@example.com:upstream/repo.git', fingerprint: 'upstream-push' },
        },
      ],
    };
    const binding = {
      repositoryId: 'repo_one', revision: 3, state: 'bound', configRevision: 'config_one', remotes: [], auxiliary: [],
      providers: [
        { provider: 'gitlab', instance: 'https://gitlab.example.com', accountId: 'account-one', primaryRemote: 'origin', readiness: 'ready', endpoint: repositoryWithUpstream.remotes[0].fetch },
        { provider: 'gitlab', instance: 'https://gitlab.example.com', accountId: 'account-two', primaryRemote: 'upstream', readiness: 'ready', endpoint: repositoryWithUpstream.remotes[1].fetch },
      ],
    };
    const service = createBindingService({
      store: { read: vi.fn(async () => ({ revision: 3, binding })), compareAndSwap: vi.fn() },
      resolveRepository: async () => repositoryWithUpstream,
    });
    const context = (accountId, primaryRemote) => ({
      directory: '/repository', repositoryId: 'repo_one', provider: 'gitlab', instance: 'gitlab.example.com',
      accountId, bindingRevision: 3, primaryRemote,
    });

    await expect(service.validateReadContext(context('account-one', 'origin'))).resolves.toMatchObject({
      accountId: 'account-one', primaryRemote: 'origin',
    });
    await expect(service.validateReadContext(context('account-two', 'upstream'))).resolves.toMatchObject({
      accountId: 'account-two', primaryRemote: 'upstream',
    });
    await expect(service.validateReadContext(context('account-one', 'upstream'))).rejects.toMatchObject({
      code: 'SOURCE_CONTROL_BINDING_CONTEXT_MISMATCH',
    });
    await expect(service.validateReadContext(context('account-two', 'origin'))).rejects.toMatchObject({
      code: 'SOURCE_CONTROL_BINDING_CONTEXT_MISMATCH',
    });
  });

  it.each([
    ['wrong repository', { repositoryId: 'repo_other' }, 'SOURCE_CONTROL_BINDING_REPOSITORY_MISMATCH'],
    ['stale revision', { bindingRevision: 2 }, 'SOURCE_CONTROL_BINDING_STALE'],
    ['wrong account', { accountId: 'github.com#2' }, 'SOURCE_CONTROL_BINDING_CONTEXT_MISMATCH'],
  ])('rejects %s before a status read can use provider credentials', async (_label, override, code) => {
    const binding = {
      repositoryId: 'repo_one', revision: 3, state: 'bound', configRevision: 'config_one', remotes: [], auxiliary: [],
      providers: [readyProvider({ provider: 'github', instance: 'github.com', accountId: 'github.com#1', primaryRemote: 'origin' })],
    };
    const service = createBindingService({
      store: { read: vi.fn(async () => ({ revision: 3, binding })), compareAndSwap: vi.fn() },
      resolveRepository: async () => repository,
    });
    await expect(service.validateReadContext({
      directory: '/repository', repositoryId: 'repo_one', provider: 'github', instance: 'github.com',
      accountId: 'github.com#1', bindingRevision: 3, primaryRemote: 'origin', ...override,
    })).rejects.toMatchObject({ code });
  });

  it.each([
    ['binding revision', repository, { bindingRevision: 2 }],
    ['repository remotes', { ...repository, remotes: [] }, {}],
  ])('returns the authoritative record for stale %s', async (_label, currentRepository, override) => {
    const binding = {
      repositoryId: 'repo_one', revision: 3, state: 'bound', configRevision: 'config_one', remotes: [], auxiliary: [],
      providers: [readyProvider({ provider: 'github', instance: 'github.com', accountId: 'github.com#1', primaryRemote: 'origin' })],
    };
    const service = createBindingService({
      store: { read: vi.fn(async () => ({ revision: 3, binding })), compareAndSwap: vi.fn() },
      resolveRepository: async () => ({ ...currentRepository, rawUrl: 'https://secret@example.com/owner/repo.git' }),
    });

    await expect(service.validateReadContext({
      directory: '/repository', repositoryId: 'repo_one', provider: 'github', instance: 'github.com',
      accountId: 'github.com#1', bindingRevision: 3, primaryRemote: 'origin', ...override,
    })).rejects.toMatchObject({
      code: 'SOURCE_CONTROL_BINDING_STALE',
      status: 409,
      current: {
        repository: {
          supported: true,
          repositoryId: 'repo_one',
          configRevision: currentRepository.configRevision,
          bare: false,
          remotes: currentRepository.remotes,
        },
        revision: 3,
        binding: resolveBindingReadiness(binding, currentRepository),
      },
    });
  });

  it('rejects a missing binding', async () => {
    const service = createBindingService({
      store: { read: vi.fn(async () => ({ revision: 0, binding: null })), compareAndSwap: vi.fn() },
      resolveRepository: async () => repository,
    });
    await expect(service.validateReadContext({
      directory: '/repository', repositoryId: 'repo_one', provider: 'github', instance: 'github.com',
      accountId: 'github.com#1', bindingRevision: 1, primaryRemote: 'origin',
    })).rejects.toMatchObject({ code: 'SOURCE_CONTROL_BINDING_MISSING' });
  });

  it('rejects client-provided endpoint fields before persistence', async () => {
    const compareAndSwap = vi.fn(async (repositoryId, expectedRevision, binding) => ({
      revision: 1,
      binding: { ...binding, repositoryId, revision: 1 },
    }));
    const service = createBindingService({
      store: { read: vi.fn(async () => ({ revision: 0, binding: null })), compareAndSwap },
      resolveRepository: async () => repository,
    });

    await expect(service.set(wholeBindingInput('/repository', 0, {
        state: 'bound',
        providers: [{
          provider: 'github',
          instance: 'github.com',
          accountId: 'github.com#1',
          primaryRemote: 'origin',
          repository: { owner: 'owner', name: 'repo' },
        }],
        remotes: [{
          name: 'origin',
          mode: 'managed',
          credentialId: 'credential_one',
          pushUrl: 'https://attacker.invalid/repository',
        }],
      }))).rejects.toMatchObject({ code: 'INVALID_SOURCE_CONTROL_BINDING' });
    expect(compareAndSwap).not.toHaveBeenCalled();
  });

  it.each([
    ['GitHub', 'github', 'github.com', 'https://GitHub.com/'],
    ['GitLab', 'gitlab', 'gitlab.example.com', 'https://gitlab.example.com/'],
  ])('rejects normalization-equivalent duplicate %s provider bindings', async (_label, provider, first, second) => {
    const compareAndSwap = vi.fn();
    const providerRepository = provider === 'github' ? repository : {
      ...repository,
      remotes: [{ ...repository.remotes[0],
        fetch: { displayUrl: 'https://gitlab.example.com/owner/repo.git', fingerprint: 'fetch' },
        push: { displayUrl: 'git@gitlab.example.com:owner/repo.git', fingerprint: 'push' },
      }],
    };
    const service = createBindingService({
      store: { read: vi.fn(async () => ({ revision: 0, binding: null })), compareAndSwap },
      resolveRepository: async () => providerRepository,
    });

    await expect(service.set(wholeBindingInput('/repository', 0, {
        state: 'bound',
        providers: [
          { provider, instance: first, accountId: 'account-one', primaryRemote: 'origin' },
          { provider, instance: second, accountId: 'account-two', primaryRemote: 'origin' },
        ],
        remotes: [],
      }, providerRepository))).rejects.toMatchObject({ code: 'INVALID_SOURCE_CONTROL_BINDING' });
    expect(compareAndSwap).not.toHaveBeenCalled();
  });

  it('rejects unknown remotes and missing revisions before persistence', async () => {
    const compareAndSwap = vi.fn();
    const service = createBindingService({
      store: { read: vi.fn(async () => ({ revision: 0, binding: null })), compareAndSwap },
      resolveRepository: async () => repository,
    });
    const binding = { providers: [], remotes: [{ name: 'upstream', mode: 'system' }], state: 'bound' };

    await expect(service.set(wholeBindingInput('/repository', 0, binding))).rejects.toMatchObject({
      code: 'INVALID_SOURCE_CONTROL_BINDING',
    });
    await expect(service.resetRepositoryBinding({ directory: '/repository' })).rejects.toMatchObject({
      code: 'INVALID_SOURCE_CONTROL_BINDING',
    });
    await expect(service.set(wholeBindingInput('/repository', 0,
      { providers: [], remotes: [{ name: 'origin', mode: 'managed' }], state: 'bound' })))
      .rejects.toMatchObject({ code: 'INVALID_SOURCE_CONTROL_BINDING' });
    expect(compareAndSwap).not.toHaveBeenCalled();
  });

  it('rejects credentialId on a system remote before persistence', async () => {
    const compareAndSwap = vi.fn();
    const service = createBindingService({
      store: { read: vi.fn(async () => ({ revision: 0, binding: null })), compareAndSwap },
      resolveRepository: async () => repository,
    });
    await expect(service.set(wholeBindingInput('/repository', 0, {
        providers: [], state: 'bound',
        remotes: [{ name: 'origin', mode: 'system', credentialId: 'must-not-persist' }],
      }))).rejects.toMatchObject({ code: 'INVALID_SOURCE_CONTROL_BINDING' });
    expect(compareAndSwap).not.toHaveBeenCalled();
  });

  it('rejects unknown whole-binding fields before persistence', async () => {
    const compareAndSwap = vi.fn();
    const service = createBindingService({
      store: { read: vi.fn(async () => ({ revision: 0, binding: null })), compareAndSwap },
      resolveRepository: async () => repository,
    });
    await expect(service.set(wholeBindingInput('/repository', 0,
      { providers: [], remotes: [], state: 'bound', token: 'must-not-persist' })))
      .rejects.toMatchObject({ code: 'INVALID_SOURCE_CONTROL_BINDING' });
    expect(compareAndSwap).not.toHaveBeenCalled();
  });

  it.each([
    ['repository identity', { expectedRepositoryId: 'repo_other' }],
    ['Git config revision', { expectedConfigRevision: 'config_other' }],
    ['binding revision', { expectedRevision: 2 }],
  ])('rejects stale whole-binding %s authority before persistence', async (_label, override) => {
    const compareAndSwap = vi.fn();
    const service = createBindingService({
      store: { read: vi.fn(async () => ({ revision: 0, binding: null })), compareAndSwap },
      resolveRepository: async () => repository,
    });
    await expect(service.set({ ...wholeBindingInput('/repository', 0,
      { providers: [], remotes: [], state: 'bound' }), ...override }))
      .rejects.toMatchObject({ code: 'SOURCE_CONTROL_BINDING_STALE', status: 409 });
    expect(compareAndSwap).not.toHaveBeenCalled();
  });

  it('requires exact repository and config authority plus confirmation for a full reset', async () => {
    const compareAndSwap = vi.fn(async () => ({ revision: 2, binding: null }));
    const binding = { repositoryId: repository.repositoryId, revision: 1, configRevision: repository.configRevision,
      state: 'bound', providers: [], remotes: [], auxiliary: [],
    };
    const service = createBindingService({
      store: { read: vi.fn(async () => ({ revision: 1, binding })), compareAndSwap },
      resolveRepository: async () => repository,
    });
    const authority = { directory: '/repository', expectedRepositoryId: repository.repositoryId,
      expectedRevision: 1, expectedConfigRevision: repository.configRevision,
    };
    await expect(service.resetRepositoryBinding(authority)).rejects.toMatchObject({ code: 'INVALID_SOURCE_CONTROL_BINDING' });
    await expect(service.resetRepositoryBinding({ ...authority, confirmed: true })).resolves.toMatchObject({ revision: 2, binding: null });
    expect(compareAndSwap).toHaveBeenCalledWith(repository.repositoryId, 1, null);
  });

  it('rejects whole-binding replacement when repository topology changes during validation', async () => {
    const compareAndSwap = vi.fn();
    const resolveRepository = vi.fn()
      .mockResolvedValueOnce(repository)
      .mockResolvedValueOnce({ ...repository, configRevision: 'changed-during-write' });
    const service = createBindingService({
      store: { read: vi.fn(async () => ({ revision: 0, binding: null })), compareAndSwap },
      resolveRepository,
    });
    await expect(service.set(wholeBindingInput('/repository', 0,
      { providers: [], remotes: [], state: 'bound' })))
      .rejects.toMatchObject({ code: 'SOURCE_CONTROL_BINDING_STALE', status: 409 });
    expect(compareAndSwap).not.toHaveBeenCalled();
  });

  it.each([
    ['github', 'https://GitHub.com/', 'github.com'],
    ['gitlab', 'gitlab.example.com/', 'https://gitlab.example.com'],
  ])('normalizes %s account identity before binding reconciliation', async (provider, instance, normalizedInstance) => {
    const reconcileAccount = vi.fn(async () => [{ revision: 2 }]);
    const service = createBindingService({
      store: { read: vi.fn(), compareAndSwap: vi.fn(), reconcileAccount },
      resolveRepository: async () => repository,
    });

    await expect(service.accountUnavailable({
      provider,
      instance,
      accountId: 'account-one',
    })).resolves.toEqual([{ revision: 2 }]);
    expect(reconcileAccount).toHaveBeenCalledWith({ provider, instance: normalizedInstance, accountId: 'account-one' });
  });
});
