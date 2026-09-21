import { describe, expect, it, vi } from 'vitest';
import { fingerprintRemoteUrl } from '../source-control/url-redaction.js';
import { parseGitCredentialReference } from './credential-resolver.js';
import { createNetworkOperationPlanner } from './network-operation-plan.js';

const SHA = 'a'.repeat(40);
const REMOTE_SHA = 'b'.repeat(40);
const authority = {
  endpoint: 'https://example.com/owner/repository.git',
  endpointFingerprint: fingerprintRemoteUrl('https://example.com/owner/repository.git'),
  transportMode: 'managed',
  credentialId: 'credential_one',
  transportRevision: 'transport_one',
};
const existingInput = (type, overrides = {}) => ({
  operation: type,
  directory: '/repository',
  repositoryId: 'repo_one',
  bindingRevision: 4,
  configRevision: 'config_one',
  remote: {
    name: 'upstream',
    endpoint: {
      displayUrl: 'https://example.com/owner/repository.git',
      fingerprint: authority.endpointFingerprint,
    },
  },
  sourceRef: 'refs/heads/feature',
  destinationRef: 'refs/heads/feature',
  transportMode: 'managed',
  ...overrides,
});
const syncInput = (overrides = {}) => ({
  operation: 'sync',
  directory: '/repository',
  repositoryId: 'repo_one',
  bindingRevision: 4,
  configRevision: 'config_one',
  fetch: {
    remote: existingInput('fetch').remote,
    sourceRef: 'refs/heads/main',
    destinationRef: 'refs/remotes/upstream/main',
    transportMode: 'managed',
  },
  pull: { destinationRef: 'refs/heads/feature' },
  push: {
    remote: { ...existingInput('push').remote, name: 'origin' },
    sourceRef: 'refs/heads/feature',
    destinationRef: 'refs/heads/feature',
    transportMode: 'managed',
  },
  ...overrides,
});
const makePlanner = (overrides = {}) => createNetworkOperationPlanner({
  validateGitTransportContext: vi.fn(async () => authority),
  resolveSourceControlAccount: vi.fn(async ({ provider, instance, accountId }) => ({
    id: accountId,
    accountId,
    credentialId: accountId,
    credentialRevision: 3,
    providerUserId: provider === 'github' ? 'github.com#42' : `${instance}#42`,
    status: 'valid',
    accessToken: 'github-secret',
    token: 'gitlab-secret',
  })),
  resolveRef: vi.fn(async () => SHA),
  resolveSymbolicRef: vi.fn(async () => 'refs/heads/feature'),
  runtimeIdentity: { id: 'server_one', platform: 'web' },
  systemPushAcknowledgements: {
    isAcknowledged: vi.fn(async () => true),
    acknowledge: vi.fn(async () => {}),
  },
  idFactory: () => 'git_operation_one',
  fsImpl: { stat: vi.fn(async () => { const error = new Error('missing'); error.code = 'ENOENT'; throw error; }) },
  ...overrides,
});

describe('Git network operation planner', () => {
  it.each(['fetch', 'pull'])('plans credential-free anonymous HTTPS %s', async (operation) => {
    const planner = makePlanner({ validateGitTransportContext: async () => ({ ...authority, transportMode: 'anonymous', credentialId: undefined }) });
    const plans = await planner.planNetworkOperation(existingInput(operation, { transportMode: 'anonymous' }));
    expect(plans.publicPlan.transport).toEqual({ mode: 'anonymous', verification: { status: 'anonymous' } });
    expect(plans.internalPlan).not.toHaveProperty('credentialId');
  });

  it('rejects anonymous publishing before authority or ref resolution', async () => {
    const validateGitTransportContext = vi.fn();
    const resolveRef = vi.fn();
    const planner = makePlanner({ validateGitTransportContext, resolveRef });
    const deletion = existingInput('delete-remote-branch', { transportMode: 'anonymous' });
    delete deletion.sourceRef;
    const sync = syncInput();
    sync.push.transportMode = 'anonymous';
    for (const input of [existingInput('push', { transportMode: 'anonymous' }), deletion, sync]) {
      await expect(planner.planNetworkOperation(input)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    }
    expect(validateGitTransportContext).not.toHaveBeenCalled();
    expect(resolveRef).not.toHaveBeenCalled();
  });

  it('keeps anonymous clone intent strict and HTTPS-only', async () => {
    const input = { operation: 'clone', remoteUrl: authority.endpoint, destinationPath: '/new/repo', transportMode: 'anonymous' };
    const plans = await makePlanner().planNetworkOperation(input);
    expect(plans.publicPlan.transport).toEqual({ mode: 'anonymous', verification: { status: 'anonymous' } });
    expect(plans.internalPlan).not.toHaveProperty('credentialId');
    for (const extra of [{ credentialId: 'secret' }, { credentialAccount: {} }, { unverifiedConfirmed: true },
      { acknowledgeSystemTransport: true }, { credentialAccount: undefined }, { unexpected: true }]) {
      await expect(makePlanner().planNetworkOperation({ ...input, ...extra })).rejects.toThrow();
    }
    for (const remoteUrl of ['git@example.com:owner/repo.git', 'ssh://example.com/owner/repo.git']) {
      await expect(makePlanner().planNetworkOperation({ ...input, remoteUrl })).rejects.toMatchObject({ code: 'RUNTIME_UNSUPPORTED' });
    }
  });

  it('carries a clone provider account privately and checks it against the clone endpoint', async () => {
    const input = { operation: 'clone', remoteUrl: 'https://gitlab.com/owner/repository.git', destinationPath: '/new/repo', transportMode: 'anonymous' };
    const account = { provider: 'gitlab', instance: 'https://gitlab.com', accountId: 'gitlab-one' };
    const plans = await makePlanner().planNetworkOperation({ ...input, providerAccount: account });
    expect(plans.internalPlan.providerAccount).toEqual(account);
    // The association names an account; it must not reach the public plan.
    expect(JSON.stringify(plans.publicPlan)).not.toContain('gitlab-one');

    // Omitted entirely is the supported way to bind no provider.
    expect(await makePlanner().planNetworkOperation(input)).not.toHaveProperty('internalPlan.providerAccount');

    for (const invalid of [
      { provider: 'github', instance: 'github.com', accountId: 'a' },
      { provider: 'bitbucket', instance: 'https://gitlab.com', accountId: 'a' },
      { provider: 'gitlab', instance: 'https://gitlab.com', accountId: '' },
      { provider: 'gitlab', instance: 'https://gitlab.com', accountId: 'a', extra: true },
    ]) {
      await expect(makePlanner().planNetworkOperation({ ...input, providerAccount: invalid })).rejects.toThrow();
    }
  });

  it('requires separate System consent for every clone auxiliary grant and keeps grants private', async () => {
    const endpoint = { displayUrl: 'https://modules.example/child.git', fingerprint: fingerprintRemoteUrl('https://modules.example/child.git') };
    const input = {
      operation: 'clone', remoteUrl: authority.endpoint, destinationPath: '/new/repo',
      transportMode: 'system', unverifiedConfirmed: true,
      auxiliaryGrants: [{ kind: 'submodule', endpoint, transportMode: 'system' }],
    };
    await expect(makePlanner().planNetworkOperation(input)).rejects.toMatchObject({ code: 'INVALID_GIT_NETWORK_OPERATION' });

    const plans = await makePlanner().planNetworkOperation({
      ...input,
      auxiliaryGrants: [{ ...input.auxiliaryGrants[0], unverifiedConfirmed: true }],
    });
    expect(plans.internalPlan.auxiliaryGrants).toEqual([{
      kind: 'submodule', endpoint, transportMode: 'system', unverifiedConfirmed: true,
    }]);
    expect(JSON.stringify(plans.publicPlan)).not.toContain('modules.example');
    expect(JSON.stringify(plans.publicPlan)).not.toContain('auxiliaryGrants');
  });

  it('rejects anonymous credentials and SSH authority for existing reads', async () => {
    for (const changed of [{ credentialId: 'forbidden' }, { endpoint: 'git@example.com:owner/repo.git' }]) {
      const planner = makePlanner({ validateGitTransportContext: async () => ({ ...authority, credentialId: undefined, transportMode: 'anonymous', ...changed }) });
      await expect(planner.planNetworkOperation(existingInput('fetch', { transportMode: 'anonymous' }))).rejects.toThrow();
    }
  });
  const remoteFetchInput = () => {
    const input = existingInput('fetch');
    delete input.sourceRef;
    delete input.destinationRef;
    return { ...input, fetchScope: 'remote' };
  };

  it.each(['', '+'])('plans configured remote Fetch with force prefix "%s" without reading HEAD', async (prefix) => {
    const resolveRef = vi.fn(async () => { throw new Error('must not resolve a local ref'); });
    const resolveSymbolicRef = vi.fn(async () => { throw new Error('detached HEAD'); });
    const resolveRemoteFetchMapping = vi.fn(async () => `${prefix}refs/heads/*:refs/remotes/upstream/*\0`);
    const plans = await makePlanner({ resolveRef, resolveSymbolicRef, resolveRemoteFetchMapping })
      .planNetworkOperation(remoteFetchInput());
    expect(plans.publicPlan.target).toEqual({
      operation: 'fetch', fetchScope: 'remote', force: prefix === '+',
      repositoryId: 'repo_one', bindingRevision: 4, configRevision: 'config_one', remote: existingInput('fetch').remote,
    });
    expect(plans.internalPlan.fetchRefspec).toBe(`${prefix}refs/heads/*:refs/remotes/upstream/*`);
    expect(resolveRemoteFetchMapping).toHaveBeenCalledExactlyOnceWith('/repository', 'upstream');
    expect(resolveRef).not.toHaveBeenCalled();
    expect(resolveSymbolicRef).not.toHaveBeenCalled();
    expect(JSON.stringify(plans.publicPlan)).not.toContain('refs/');
  });

  it('retains explicitly selected exact-ref Fetch without reading configured mappings', async () => {
    const resolveRemoteFetchMapping = vi.fn(async () => { throw new Error('not a remote-scope fetch'); });
    const plans = await makePlanner({ resolveRemoteFetchMapping }).planNetworkOperation(existingInput('fetch', { fetchScope: 'ref' }));
    expect(plans.publicPlan.target).toMatchObject({
      operation: 'fetch', fetchScope: 'ref', sourceRef: 'refs/heads/feature', destinationRef: 'refs/heads/feature',
    });
    expect(resolveRemoteFetchMapping).not.toHaveBeenCalled();
  });

  it.each([
    '', '\0', '+refs/heads/*:refs/remotes/origin/*\0',
    '+refs/*:refs/*\0', '+refs/heads/*:refs/heads/*\0',
    '+refs/heads/main:refs/remotes/upstream/main\0', '^refs/heads/private/*\0',
    '+refs/heads/*:refs/remotes/upstream/*\0^refs/heads/private/*\0',
    '+refs/heads/*:refs/remotes/upstream/*\0+refs/heads/*:refs/remotes/upstream/*\0',
    '+refs/heads/*:refs/remotes/upstream/*', '--upload-pack=bad\0',
  ])('rejects unsupported remote Fetch configuration %j', async (output) => {
    await expect(makePlanner({ resolveRemoteFetchMapping: async () => output }).planNetworkOperation(remoteFetchInput()))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it.each([
    { sourceRef: 'refs/heads/main' }, { destinationRef: 'refs/remotes/upstream/main' },
    { refspec: '+refs/*:refs/*' }, { force: true }, { fetchScope: 'all' },
  ])('rejects caller-injected remote Fetch fields %j before resolving configuration', async (override) => {
    const resolveRemoteFetchMapping = vi.fn();
    await expect(makePlanner({ resolveRemoteFetchMapping }).planNetworkOperation({ ...remoteFetchInput(), ...override }))
      .rejects.toMatchObject({ code: 'INVALID_GIT_NETWORK_OPERATION' });
    expect(resolveRemoteFetchMapping).not.toHaveBeenCalled();
  });

  it.each([
    ['push', 'push'],
    ['fetch', 'fetch'],
    ['pull', 'fetch'],
  ])('pins authority and the resolved SHA for %s', async (type, endpointKind) => {
    const validateGitTransportContext = vi.fn(async () => authority);
    const resolveRef = vi.fn(async () => SHA);
    const planner = makePlanner({ validateGitTransportContext, resolveRef });

    const plans = await planner.planNetworkOperation(existingInput(type));

    expect(validateGitTransportContext).toHaveBeenCalledWith({
      directory: '/repository', repositoryId: 'repo_one', bindingRevision: 4,
      configRevision: 'config_one', remote: 'upstream', endpointKind,
    });
    if (type === 'push') expect(resolveRef).toHaveBeenCalledWith('/repository', 'refs/heads/feature');
    else if (type === 'pull') expect(resolveRef).toHaveBeenCalledWith('/repository', 'refs/heads/feature');
    else expect(resolveRef).not.toHaveBeenCalled();
    expect(plans.internalPlan).toMatchObject({ rawEndpoint: authority.endpoint, credentialId: 'credential_one' });
    if (type === 'push') expect(plans.internalPlan.sourceSha).toBe(SHA);
    else expect(plans.internalPlan).not.toHaveProperty('sourceSha');
    if (type === 'pull') expect(plans.internalPlan.destinationSha).toBe(SHA);
    expect(plans.publicPlan).toMatchObject({
      operationId: 'git_operation_one',
      runtimeIdentity: { id: 'server_one', platform: 'web' },
      transport: { mode: 'managed', verification: { status: 'verified', method: 'credential' } },
      target: { operation: type, sourceRef: 'refs/heads/feature', destinationRef: 'refs/heads/feature' },
      state: 'planned',
      completedSteps: [],
    });
    expect(Object.isFrozen(plans.internalPlan)).toBe(true);
    expect(Object.isFrozen(plans.publicPlan.runtimeIdentity)).toBe(true);
    expect(JSON.stringify(plans.publicPlan)).not.toContain('rawUrl');
    expect(plans.publicPlan).not.toHaveProperty('endpoint');
    expect(JSON.stringify(plans.publicPlan)).not.toContain('credential_one');
    expect(JSON.stringify(plans.publicPlan)).not.toContain('transport_one');
  });

  it('plans checkout hydration from pinned repository, parent remote, HEAD, and discovered endpoints', async () => {
    const inspectCheckoutHydration = vi.fn(async () => ({
      headSha: SHA,
      requirements: [{
        kind: 'submodule', path: 'vendor/library',
        endpoint: { displayUrl: 'https://modules.example/library.git', fingerprint: fingerprintRemoteUrl('https://modules.example/library.git') },
      }, {
        kind: 'lfs', path: '.',
        endpoint: { displayUrl: 'https://media.example/library.git', fingerprint: fingerprintRemoteUrl('https://media.example/library.git') },
      }],
      transfers: [{
        kind: 'submodule', path: 'vendor/library', rawEndpoint: 'https://modules.example/library.git',
        endpoint: { displayUrl: 'https://modules.example/library.git', fingerprint: fingerprintRemoteUrl('https://modules.example/library.git') },
      }],
    }));
    const validateGitTransportContext = vi.fn(async () => authority);
    const planner = makePlanner({ inspectCheckoutHydration, validateGitTransportContext });
    const input = {
      operation: 'checkout-hydration', directory: '/repository', repositoryId: 'repo_one',
      bindingRevision: 4, configRevision: 'config_one', remote: existingInput('fetch').remote,
    };

    const plans = await planner.planNetworkOperation(input);

    expect(validateGitTransportContext).toHaveBeenCalledExactlyOnceWith({
      directory: '/repository', repositoryId: 'repo_one', bindingRevision: 4,
      configRevision: 'config_one', remote: 'upstream', endpointKind: 'fetch',
    });
    expect(inspectCheckoutHydration).toHaveBeenCalledExactlyOnceWith({
      directory: '/repository', parentEndpoint: authority.endpoint, parentRemoteName: 'upstream',
    });
    expect(plans.publicPlan.target).toEqual({
      operation: 'checkout-hydration', repositoryId: 'repo_one', bindingRevision: 4,
      configRevision: 'config_one', remote: existingInput('fetch').remote,
      requirements: (await inspectCheckoutHydration.mock.results[0].value).requirements,
    });
    expect(plans.internalPlan).toMatchObject({
      expectedHeadSha: SHA, parentEndpoint: authority.endpoint, parentRemoteName: 'upstream',
      plannedTransfers: [{ kind: 'submodule', path: 'vendor/library', rawEndpoint: 'https://modules.example/library.git' }],
      plannedSourceRequired: false,
      repositoryAuthority: { directory: '/repository', repositoryId: 'repo_one', bindingRevision: 4, configRevision: 'config_one' },
    });
    expect(JSON.stringify(plans.publicPlan)).not.toContain('"directory":"/repository"');
    expect(JSON.stringify(plans.publicPlan)).not.toContain('credential_one');
  });

  it('rejects stale checkout hydration source before inspection and rejects absolute discovered paths', async () => {
    const inspectCheckoutHydration = vi.fn(async () => ({ headSha: SHA, requirements: [], transfers: [] }));
    const input = {
      operation: 'checkout-hydration', directory: '/repository', repositoryId: 'repo_one',
      bindingRevision: 4, configRevision: 'config_one', remote: existingInput('fetch').remote,
    };
    await expect(makePlanner({
      inspectCheckoutHydration,
      validateGitTransportContext: async () => ({ ...authority, endpointFingerprint: 'changed' }),
    }).planNetworkOperation(input)).rejects.toMatchObject({ code: 'GIT_NETWORK_OPERATION_AUTHORITY_CHANGED' });
    expect(inspectCheckoutHydration).not.toHaveBeenCalled();

    await expect(makePlanner({ inspectCheckoutHydration: async () => ({
      headSha: SHA,
      requirements: [{ kind: 'lfs', path: '/private/repository', endpoint: existingInput('fetch').remote.endpoint }],
      transfers: [{ kind: 'lfs', path: '/private/repository', endpoint: existingInput('fetch').remote.endpoint, rawEndpoint: authority.endpoint }],
    }) }).planNetworkOperation(input)).rejects.toMatchObject({ code: 'INVALID_GIT_NETWORK_OPERATION' });
    await expect(makePlanner({ inspectCheckoutHydration: async () => ({
      headSha: SHA,
      requirements: [{ kind: 'lfs', path: 'asset\tname.bin', endpoint: existingInput('fetch').remote.endpoint }],
      transfers: [{ kind: 'lfs', path: 'asset\tname.bin', endpoint: existingInput('fetch').remote.endpoint, rawEndpoint: authority.endpoint }],
    }) }).planNetworkOperation(input)).rejects.toMatchObject({ code: 'INVALID_GIT_NETWORK_OPERATION' });
    await expect(makePlanner({ inspectCheckoutHydration: async () => ({
      headSha: SHA,
      requirements: [{ kind: 'lfs', path: '.', endpoint: existingInput('fetch').remote.endpoint }],
      transfers: [{ kind: 'lfs', path: '.', endpoint: existingInput('fetch').remote.endpoint, rawEndpoint: 'https://other.example/repository.git' }],
    }) }).planNetworkOperation(input)).rejects.toMatchObject({ code: 'INVALID_GIT_NETWORK_OPERATION' });
    await expect(makePlanner({ inspectCheckoutHydration: async () => ({
      headSha: SHA,
      requirements: [{ kind: 'lfs', path: '.', endpoint: existingInput('fetch').remote.endpoint }],
      transfers: Array.from({ length: 2 }, () => ({
        kind: 'lfs', path: '.', endpoint: existingInput('fetch').remote.endpoint, rawEndpoint: authority.endpoint,
      })),
    }) }).planNetworkOperation(input)).rejects.toMatchObject({ code: 'INVALID_GIT_NETWORK_OPERATION' });
  });

  it('stores force intent only as an expected remote SHA', async () => {
    const plans = await makePlanner().planNetworkOperation(existingInput('push', {
      forceWithLease: { expectedRemoteSha: REMOTE_SHA },
    }));
    expect(plans.internalPlan.target.forceWithLease).toEqual({ expectedRemoteSha: REMOTE_SHA });

    await expect(makePlanner().planNetworkOperation(existingInput('push', { forceWithLease: true })))
      .rejects.toMatchObject({ code: 'INVALID_GIT_NETWORK_OPERATION', status: 400 });
    await expect(makePlanner().planNetworkOperation(existingInput('push', {
      forceWithLease: { expectedRemoteSha: REMOTE_SHA, mode: 'force' },
    }))).rejects.toMatchObject({ code: 'INVALID_GIT_NETWORK_OPERATION' });
  });

  it('requires an exact one-use selection even for an independently authorized contributor fork', async () => {
    const contributor = {
      worktreeId: 'worktree_one', repositoryId: 'repo_one', revision: 3,
      provenance: { kind: 'contributor-fork', endpointFingerprint: authority.endpointFingerprint },
    };
    const contributorProvenance = { read: vi.fn(async () => contributor) };
    const planner = makePlanner({ contributorProvenance });

    await expect(planner.planNetworkOperation(existingInput('push'))).rejects.toMatchObject({
      code: 'DESTINATION_SELECTION_REQUIRED', status: 409,
    });
    await expect(planner.planNetworkOperation(existingInput('fetch', { transportMode: 'system' })))
      .rejects.toMatchObject({ code: 'CONTRIBUTOR_MANAGED_TRANSPORT_REQUIRED', status: 409 });

    const selection = await planner.issueContributorDestination({
      directory: '/repository', repositoryId: 'repo_one', bindingRevision: 4,
      configRevision: 'config_one', provenanceRevision: 3,
      remote: existingInput('push').remote,
      sourceRef: 'refs/heads/feature', destinationRef: 'refs/heads/feature', transportMode: 'managed',
    });
    await expect(planner.planNetworkOperation(existingInput('push', {
      destinationSelectionId: selection.selectionId,
    }))).resolves.toMatchObject({
      internalPlan: {
        sourceSha: SHA,
        contributorAuthority: { worktreeId: 'worktree_one', revision: 3 },
      },
    });
    await expect(planner.planNetworkOperation(existingInput('push', {
      destinationSelectionId: selection.selectionId,
    }))).rejects.toMatchObject({ code: 'DESTINATION_SELECTION_REQUIRED' });
  });

  it('plans sync with separate exact fetch and push authority', async () => {
    const validateGitTransportContext = vi.fn(async (input) => ({
      ...authority,
      endpoint: `https://example.com/${input.remote}/repository.git`,
      endpointFingerprint: fingerprintRemoteUrl(`https://example.com/${input.remote}/repository.git`),
      credentialId: `credential_${input.remote}`,
      transportRevision: `transport_${input.remote}`,
    }));
    const input = syncInput();
    input.fetch.remote.endpoint = {
      displayUrl: 'https://example.com/upstream/repository.git',
      fingerprint: fingerprintRemoteUrl('https://example.com/upstream/repository.git'),
    };
    input.push.remote.endpoint = {
      displayUrl: 'https://example.com/origin/repository.git',
      fingerprint: fingerprintRemoteUrl('https://example.com/origin/repository.git'),
    };
    const plans = await makePlanner({ validateGitTransportContext }).planNetworkOperation(input);

    expect(validateGitTransportContext.mock.calls.map(([value]) => [value.remote, value.endpointKind]))
      .toEqual([['upstream', 'fetch'], ['origin', 'push']]);
    expect(plans.publicPlan).toMatchObject({
      target: {
        operation: 'sync',
        fetch: { name: 'upstream', sourceRef: 'refs/heads/main', destinationRef: 'refs/remotes/upstream/main' },
        pull: { destinationRef: 'refs/heads/feature' },
        push: { name: 'origin', sourceRef: 'refs/heads/feature', destinationRef: 'refs/heads/feature' },
      },
      transport: {
        fetch: { mode: 'managed' },
        push: { mode: 'managed' },
      },
    });
    expect(plans.internalPlan.fetch.rawEndpoint).toBe('https://example.com/upstream/repository.git');
    expect(plans.internalPlan.push.rawEndpoint).toBe('https://example.com/origin/repository.git');
    expect(JSON.stringify(plans.publicPlan)).not.toContain('credential_');
  });

  it.each([
    ['missing fetch target', { fetch: undefined }],
    ['missing push target', { push: undefined }],
    ['detached HEAD', {}, null],
  ])('does not infer sync authority for %s', async (_label, override, headRef = 'refs/heads/feature') => {
    await expect(makePlanner({ resolveSymbolicRef: vi.fn(async () => headRef) })
      .planNetworkOperation(syncInput(override)))
      .rejects.toMatchObject({ code: expect.any(String) });
  });

  it('requires and persists acknowledgement for each system push transport revision', async () => {
    const systemAuthority = { ...authority, transportMode: 'system', credentialId: undefined };
    const systemPushAcknowledgements = {
      isAcknowledged: vi.fn(async (_repositoryId, _remoteName, _endpointFingerprint, transportRevision) => (
        transportRevision === 'transport_acknowledged'
      )),
      acknowledge: vi.fn(async () => {}),
    };
    const planner = makePlanner({
      validateGitTransportContext: vi.fn(async () => systemAuthority),
      systemPushAcknowledgements,
    });
    const input = existingInput('push', { transportMode: 'system' });

    await expect(planner.planNetworkOperation(input)).rejects.toMatchObject({
      code: 'ACKNOWLEDGEMENT_REQUIRED', status: 409,
    });
    await expect(planner.planNetworkOperation({ ...input, acknowledgeSystemTransport: true }))
      .resolves.toHaveProperty('publicPlan.state', 'planned');
    expect(systemPushAcknowledgements.isAcknowledged).toHaveBeenCalledWith(
      'repo_one', 'upstream', authority.endpointFingerprint, 'transport_one',
    );
    expect(systemPushAcknowledgements.acknowledge).toHaveBeenCalledWith(
      'repo_one', 'upstream', authority.endpointFingerprint, 'transport_one',
    );
    await expect(makePlanner({
      validateGitTransportContext: vi.fn(async () => ({
        ...systemAuthority, transportRevision: 'transport_acknowledged',
      })),
      systemPushAcknowledgements,
    }).planNetworkOperation(input))
      .resolves.toHaveProperty('publicPlan.state', 'planned');
  });

  it('keys sync acknowledgement to the exact push target rather than its fetch target', async () => {
    const pushEndpoint = 'https://push.example.com/owner/repository.git';
    const pushFingerprint = fingerprintRemoteUrl(pushEndpoint);
    const systemPushAcknowledgements = {
      isAcknowledged: vi.fn(async () => false),
      acknowledge: vi.fn(async () => {}),
    };
    const validateGitTransportContext = vi.fn(async ({ endpointKind }) => endpointKind === 'push' ? {
      ...authority,
      endpoint: pushEndpoint,
      endpointFingerprint: pushFingerprint,
      transportMode: 'system',
      credentialId: undefined,
      transportRevision: 'transport_push',
    } : authority);
    const input = syncInput();
    input.push = {
      ...input.push,
      remote: { name: 'publish', endpoint: { displayUrl: pushEndpoint, fingerprint: pushFingerprint } },
      transportMode: 'system',
    };
    const planner = makePlanner({ validateGitTransportContext, systemPushAcknowledgements });

    await expect(planner.planNetworkOperation(input)).rejects.toMatchObject({
      code: 'ACKNOWLEDGEMENT_REQUIRED', status: 409,
    });
    await expect(planner.planNetworkOperation({
      ...input, push: { ...input.push, acknowledgeSystemTransport: true },
    })).resolves.toHaveProperty('publicPlan.state', 'planned');
    expect(systemPushAcknowledgements.isAcknowledged).toHaveBeenCalledWith(
      'repo_one', 'publish', pushFingerprint, 'transport_push',
    );
    expect(systemPushAcknowledgements.acknowledge).toHaveBeenCalledExactlyOnceWith(
      'repo_one', 'publish', pushFingerprint, 'transport_push',
    );
    expect(systemPushAcknowledgements.isAcknowledged).not.toHaveBeenCalledWith(
      'repo_one', 'upstream', authority.endpointFingerprint, authority.transportRevision,
    );
  });

  it('rejects acknowledgement on managed push and every non-push operation', async () => {
    await expect(makePlanner().planNetworkOperation(existingInput('push', { acknowledgeSystemTransport: true })))
      .rejects.toMatchObject({ code: 'INVALID_GIT_NETWORK_OPERATION' });
    await expect(makePlanner().planNetworkOperation(existingInput('fetch', { acknowledgeSystemTransport: true })))
      .rejects.toMatchObject({ code: 'INVALID_GIT_NETWORK_OPERATION' });
  });

  it('fails closed when acknowledgement persistence fails', async () => {
    const resolveRef = vi.fn(async () => SHA);
    const planner = makePlanner({
      validateGitTransportContext: vi.fn(async () => ({ ...authority, transportMode: 'system', credentialId: undefined })),
      resolveRef,
      systemPushAcknowledgements: {
        isAcknowledged: vi.fn(async () => false),
        acknowledge: vi.fn(async () => { throw new Error('write failed'); }),
      },
    });
    await expect(planner.planNetworkOperation(existingInput('push', {
      transportMode: 'system', acknowledgeSystemTransport: true,
    }))).rejects.toThrow('write failed');
    expect(resolveRef).not.toHaveBeenCalled();
  });

  it('fails closed when acknowledgement state is malformed', async () => {
    const resolveRef = vi.fn(async () => SHA);
    const planner = makePlanner({
      validateGitTransportContext: vi.fn(async () => ({ ...authority, transportMode: 'system', credentialId: undefined })),
      resolveRef,
      systemPushAcknowledgements: {
        isAcknowledged: vi.fn(async () => { throw Object.assign(new Error('malformed'), { code: 'SYSTEM_PUSH_ACKNOWLEDGEMENT_STORE_INVALID' }); }),
        acknowledge: vi.fn(async () => {}),
      },
    });
    await expect(planner.planNetworkOperation(existingInput('push', { transportMode: 'system' })))
      .rejects.toMatchObject({ code: 'SYSTEM_PUSH_ACKNOWLEDGEMENT_STORE_INVALID' });
    expect(resolveRef).not.toHaveBeenCalled();
  });

  it('blocks planning when effective transport configuration cannot be queried', async () => {
    const privateFailure = new Error('/private/included.gitconfig is invalid');
    const planner = makePlanner({
      validateGitTransportContext: vi.fn(async () => { throw privateFailure; }),
    });

    await expect(planner.planNetworkOperation(existingInput('fetch'))).rejects.toBe(privateFailure);
  });

  it.each([
    ['missing remote', { remote: undefined }],
    ['missing source', { sourceRef: undefined }],
    ['missing destination', { destinationRef: undefined }],
    ['unknown field', { upstream: 'origin/main' }],
  ])('does not infer push context for %s', async (_label, override) => {
    await expect(makePlanner().planNetworkOperation(existingInput('push', override)))
      .rejects.toMatchObject({ code: 'INVALID_GIT_NETWORK_OPERATION', status: 400 });
  });

  it('rejects credentials embedded in an authoritative endpoint', async () => {
    const planner = makePlanner({
      validateGitTransportContext: async () => ({ ...authority, endpoint: 'https://user:secret@example.com/repo.git' }),
    });
    await expect(planner.planNetworkOperation(existingInput('fetch')))
      .rejects.toThrow('Git endpoint is invalid');
  });

  it.each([
    'https://user@example.com/repo.git',
    'https://example.com/repo.git?access_token=secret',
    'https://example.com/repo.git#private',
    'ssh://git@example.com/owner/repo.git',
    'ssh://example.com/owner/repo.git?key=secret',
    'git@example.com:owner/repo.git?key=secret',
    'git@example.com:owner/repo.git#private',
  ])('rejects unsafe authoritative endpoint %s before producing a plan', async (endpoint) => {
    const planner = makePlanner({ validateGitTransportContext: async () => ({ ...authority, endpoint }) });
    await expect(planner.planNetworkOperation(existingInput('fetch')))
      .rejects.toMatchObject({ code: 'INVALID_GIT_NETWORK_OPERATION', status: 400 });
  });

  it.each([
    'https://example.com/owner/repo.git',
    'ssh://example.com/owner/repo.git',
    'git@example.com:owner/repo.git',
  ])('accepts strict authoritative endpoint %s', async (endpoint) => {
    const endpointAuthority = {
      ...authority,
      endpoint,
      endpointFingerprint: fingerprintRemoteUrl(endpoint),
    };
    const planner = makePlanner({ validateGitTransportContext: async () => endpointAuthority });
    const input = existingInput('fetch', {
      remote: { name: 'upstream', endpoint: { displayUrl: endpoint, fingerprint: endpointAuthority.endpointFingerprint } },
    });
    await expect(planner.planNetworkOperation(input)).resolves.toHaveProperty('publicPlan.target.remote.endpoint.displayUrl', endpoint);
  });

  it.each([
    'http://example.com/repo.git',
    'file:///tmp/repo',
    '/tmp/repo',
    '../repo',
    'ext::command repo',
    'custom://example.com/repo',
    'https://user:secret@example.com/repo.git',
    'https://example.com/repo.git?token=secret',
    'git@example.com:../repo',
  ])('rejects unsafe clone endpoint %s', async (remoteUrl) => {
    await expect(makePlanner().planNetworkOperation({
      operation: 'clone', remoteUrl, destinationPath: '/projects/repo', transportMode: 'system',
    })).rejects.toMatchObject({ code: 'INVALID_GIT_NETWORK_OPERATION', status: 400 });
  });

  it.each([
    ['push', '+refs/heads/main', 'refs/heads/main'],
    ['push', 'refs/heads/main~1', 'refs/heads/main'],
    ['push', 'refs/heads/*', 'refs/heads/main'],
    ['push', 'refs/heads/main', ':refs/heads/main'],
    ['fetch', 'refs/heads/main:refs/heads/other', 'refs/remotes/origin/main'],
    ['pull', 'HEAD', 'refs/heads/feature'],
    ['pull', 'refs/heads/main', 'refs/remotes/origin/main'],
  ])('rejects non-exact %s refs', async (operation, sourceRef, destinationRef) => {
    await expect(makePlanner().planNetworkOperation(existingInput(operation, { sourceRef, destinationRef })))
      .rejects.toMatchObject({ code: 'INVALID_GIT_NETWORK_OPERATION', status: 400 });
  });

  it('allows upstream configuration only for a push between branch refs', async () => {
    await expect(makePlanner().planNetworkOperation(existingInput('push', { configureUpstream: true })))
      .resolves.toMatchObject({ publicPlan: { target: { operation: 'push', configureUpstream: true } } });
    await expect(makePlanner().planNetworkOperation(existingInput('push', {
      sourceRef: 'refs/tags/v1', configureUpstream: true,
    }))).rejects.toMatchObject({ code: 'INVALID_GIT_NETWORK_OPERATION', status: 400 });
    await expect(makePlanner().planNetworkOperation(existingInput('fetch', { configureUpstream: true })))
      .rejects.toMatchObject({ code: 'INVALID_GIT_NETWORK_OPERATION', status: 400 });
  });

  it('plans remote branch deletion without inventing a source ref', async () => {
    const input = existingInput('push');
    delete input.sourceRef;
    input.operation = 'delete-remote-branch';

    const plans = await makePlanner().planNetworkOperation(input);

    expect(plans.publicPlan.target).toEqual({
      operation: 'delete-remote-branch', repositoryId: 'repo_one', bindingRevision: 4,
      configRevision: 'config_one', remote: input.remote, destinationRef: 'refs/heads/feature',
    });
    expect(plans.internalPlan).not.toHaveProperty('sourceSha');
  });

  it('rejects stale client endpoint and transport metadata', async () => {
    await expect(makePlanner().planNetworkOperation(existingInput('fetch', {
      remote: {
        name: 'upstream',
        endpoint: { displayUrl: authority.endpoint, fingerprint: 'stale-fingerprint' },
      },
    }))).rejects.toMatchObject({ code: 'GIT_NETWORK_OPERATION_AUTHORITY_CHANGED', status: 409 });
    await expect(makePlanner().planNetworkOperation(existingInput('fetch', { transportMode: 'system' })))
      .rejects.toMatchObject({ code: 'GIT_NETWORK_OPERATION_AUTHORITY_CHANGED', status: 409 });
  });

  it('plans clone into a deterministic operation-owned sibling', async () => {
    const stat = vi.fn(async () => { const error = new Error('missing'); error.code = 'ENOENT'; throw error; });
    const plans = await makePlanner({ fsImpl: { stat } }).planNetworkOperation({
      operation: 'clone',
      remoteUrl: 'https://example.com/owner/repository.git',
      destinationPath: '/projects/repository',
      transportMode: 'system',
      unverifiedConfirmed: true,
    });

    expect(plans.internalPlan).toMatchObject({
      destination: '/projects/repository',
      temporaryDirectory: '/projects/.repository.openchamber-git_operation_one.tmp',
    });
    expect(plans.publicPlan).not.toHaveProperty('temporaryDirectory');
    expect(plans.publicPlan.target).toMatchObject({
      operation: 'clone',
      remote: { displayUrl: 'https://example.com/owner/repository.git' },
      destination: { displayName: 'repository' },
    });
    expect(plans.publicPlan.target.destination.fingerprint).toBeTruthy();
    expect(plans.publicPlan.transport).toEqual({
      mode: 'system', verification: { status: 'unverified', reason: 'system-credentials' },
    });
    expect(plans.publicPlan).not.toHaveProperty('credentialId');
    expect(stat).toHaveBeenCalledTimes(2);
  });

  it('requires explicit transport authority before checking clone destinations', async () => {
    const stat = vi.fn();
    const planner = makePlanner({ fsImpl: { stat } });
    const input = { operation: 'clone', remoteUrl: 'https://example.com/team/repo.git', destinationPath: '/new/repo' };
    for (const selection of [{}, { transportMode: 'system' }, { transportMode: 'system', unverifiedConfirmed: false },
      { transportMode: 'managed' }, { transportMode: 'managed', credentialId: 'renderer-chosen-key' },
      { transportMode: 'system', gitIdentityId: 'legacy-ssh-profile' },
      { transportMode: 'managed', credentialAccount: { provider: 'github', instance: 'github.com', accountId: 'other' } },
      { transportMode: 'managed', credentialAccount: { provider: 'gitlab', instance: 'https://example.com', accountId: 'one', token: 'private' } },
    ]) await expect(planner.planNetworkOperation({ ...input, ...selection })).rejects.toThrow();
    expect(stat).not.toHaveBeenCalled();
  });

  it('rejects deriving a managed SSH key from a source or author account', async () => {
    await expect(makePlanner().planNetworkOperation({ operation: 'clone', remoteUrl: 'git@example.com:team/repo.git',
      destinationPath: '/new/repo', transportMode: 'managed',
      credentialAccount: { provider: 'gitlab', instance: 'https://example.com', accountId: 'one' },
    })).rejects.toMatchObject({ status: 400, code: 'INVALID_GIT_NETWORK_OPERATION' });
  });

  it('plans managed SSH clone only with an explicitly selected existing host reference, kept out of public plans', async () => {
    const sshCredentialId = 'ocgit:v1:ssh:a2V5X29uZQ';
    const validateManagedSshCredential = vi.fn(async () => {});
    const planner = makePlanner({ validateManagedSshCredential });
    const input = { operation: 'clone', remoteUrl: 'git@example.com:team/repo.git', destinationPath: '/new/repo',
      transportMode: 'managed', sshCredentialId };
    const plans = await planner.planNetworkOperation(input);
    expect(validateManagedSshCredential).toHaveBeenCalledExactlyOnceWith(sshCredentialId);
    expect(plans.internalPlan.credentialId).toBe(sshCredentialId);
    expect(plans.publicPlan.transport.mode).toBe('managed');
    expect(JSON.stringify(plans.publicPlan)).not.toContain(sshCredentialId);
    expect(JSON.stringify(plans.publicPlan)).not.toContain('/new/repo');
    for (const extra of [{ remoteUrl: 'https://example.com/team/repo.git' }, { credentialAccount: {} },
      { privateKeyPath: '/private/key' }, { credentialId: sshCredentialId }, { unverifiedConfirmed: true },
      { transportMode: 'anonymous' }, { transportMode: 'system', unverifiedConfirmed: true }]) {
      await expect(planner.planNetworkOperation({ ...input, ...extra })).rejects.toThrow();
    }
    expect(validateManagedSshCredential).toHaveBeenCalledTimes(1);
    await expect(makePlanner().planNetworkOperation(input)).rejects.toMatchObject({ code: 'RUNTIME_UNSUPPORTED' });
    await expect(makePlanner({ validateManagedSshCredential: async () => { throw new Error('/private/key denied'); } })
      .planNetworkOperation(input)).rejects.toThrow('Selected managed SSH credential is unavailable');
  });

  it('resolves and pins the exact persisted credential for a managed HTTPS clone', async () => {
    const credentialAccount = {
      provider: 'gitlab', instance: 'https://example.com', accountId: 'credential-three',
    };
    const resolveSourceControlAccount = vi.fn(async () => ({
      id: credentialAccount.accountId,
      credentialId: credentialAccount.accountId,
      credentialRevision: 7,
      providerUserId: 'https://example.com#42',
      status: 'valid',
      token: 'private-token',
    }));
    const plans = await makePlanner({ resolveSourceControlAccount }).planNetworkOperation({
      operation: 'clone', remoteUrl: 'https://example.com/team/repo.git', destinationPath: '/new/repo',
      transportMode: 'managed', credentialAccount,
    });

    expect(resolveSourceControlAccount).toHaveBeenCalledExactlyOnceWith(credentialAccount);
    expect(parseGitCredentialReference(plans.internalPlan.credentialId)).toEqual({
      version: 2, transport: 'https', provider: 'gitlab', instance: 'https://example.com',
      credentialId: 'credential-three', credentialRevision: 7,
      providerUserId: 'https://example.com#42',
    });
    expect(JSON.stringify(plans.publicPlan)).not.toMatch(/credential-three|private-token|example\.com#42/);
  });

  it('rejects unavailable, CLI-only, or changed managed HTTPS selections before checking clone paths', async () => {
    const stat = vi.fn();
    const input = {
      operation: 'clone', remoteUrl: 'https://example.com/team/repo.git', destinationPath: '/new/repo',
      transportMode: 'managed',
      credentialAccount: { provider: 'gitlab', instance: 'https://example.com', accountId: 'credential-three' },
    };
    for (const resolved of [null, {
      credentialId: 'replacement', credentialRevision: 1, providerUserId: 'https://example.com#42',
      status: 'valid', token: 'secret',
    }, {
      credentialId: 'credential-three', credentialRevision: 2, providerUserId: 'https://example.com#42',
      status: 'invalid', token: 'secret',
    }]) {
      await expect(makePlanner({ fsImpl: { stat }, resolveSourceControlAccount: vi.fn(async () => resolved) })
        .planNetworkOperation(input)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    }
    expect(stat).not.toHaveBeenCalled();
    await expect(makePlanner({ fsImpl: { stat }, resolveSourceControlAccount: undefined })
      .planNetworkOperation(input)).rejects.toMatchObject({ code: 'RUNTIME_UNSUPPORTED' });
    expect(stat).not.toHaveBeenCalled();
  });

  it('rejects an existing clone destination and managed clone without a credential', async () => {
    const existing = makePlanner({ fsImpl: { stat: vi.fn(async () => ({})) } });
    await expect(existing.planNetworkOperation({
      operation: 'clone', remoteUrl: 'https://example.com/repo.git', destinationPath: '/projects/repo', transportMode: 'system', unverifiedConfirmed: true,
    })).rejects.toThrow('Clone destination already exists');
    await expect(makePlanner().planNetworkOperation({
      operation: 'clone', remoteUrl: 'https://example.com/repo.git', destinationPath: '/projects/repo', transportMode: 'managed',
    })).rejects.toThrow('explicit credential account');
  });
});
