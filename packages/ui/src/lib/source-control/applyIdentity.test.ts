import { afterEach, describe, expect, test } from 'bun:test';
import type {
  GitIdentityProfile,
  GitTransportBindingIntent,
  GitTransportBindingRemovalIntent,
  SourceControlBindingRead,
  SourceControlProviderBindingMutation,
  SourceControlRepositoryBinding,
} from '@/lib/api/types';
import { applyIdentityToRepository, auxiliaryGrantIntent, describeIdentityApplicability, grantIdentityToRemote, identityApplicability } from './applyIdentity';
import { repositoryBindingOwner } from './repository-binding';

const account = { provider: 'github', instance: 'github.com', accountId: 'occred:v1:github:one:r1' } as const;
const endpoint = (fingerprint: string) => ({ displayUrl: 'https://github.com/team/repo.git', fingerprint });
const remote = { name: 'origin', fetch: endpoint('fetch-one'), push: endpoint('push-one') };

type BoundProvider = SourceControlRepositoryBinding['providers'][number];

const read = (providers: BoundProvider[] = []): SourceControlBindingRead => ({
  status: 'bound',
  revision: 2,
  repository: { repositoryId: 'repo_one', configRevision: 'config_one', bare: false, remotes: [remote] },
  binding: {
    repositoryId: 'repo_one', configRevision: 'config_one', revision: 2, state: 'bound',
    providers, remotes: [], auxiliary: [],
  },
});

const identity = (overrides: Partial<GitIdentityProfile> = {}): GitIdentityProfile => ({
  id: 'work', name: 'Work', userName: 'Ada', userEmail: 'ada@example.com', ...overrides,
});

const harness = (initial = read()) => {
  const providerCalls: SourceControlProviderBindingMutation[] = [];
  const transportCalls: GitTransportBindingIntent[] = [];
  const removalCalls: GitTransportBindingRemovalIntent[] = [];
  const authorCalls: string[] = [];
  return {
    providerCalls,
    transportCalls,
    removalCalls,
    authorCalls,
    apis: {
      git: {
        configureTransportBinding: async (intent: GitTransportBindingIntent) => {
          transportCalls.push(intent);
          return { status: 'configured' as const, binding: initial };
        },
        removeTransportBinding: async (intent: GitTransportBindingRemovalIntent) => {
          removalCalls.push(intent);
          return { status: 'removed' as const, binding: initial };
        },
        setGitIdentity: async (directory: string, profileId: string) => {
          authorCalls.push(`${directory}:${profileId}`);
          return { success: true, profile: identity() };
        },
      },
      sourceControl: {
        repositoryBinding: async () => initial,
        repositoryProviderBindingMutate: async (mutation: SourceControlProviderBindingMutation) => {
          providerCalls.push(mutation);
          return initial;
        },
      },
    },
  };
};

afterEach(() => { repositoryBindingOwner.reset(); });

describe('identityApplicability', () => {
  const https = { host: 'gitlab.com', https: true, ssh: false };
  const ssh = { host: 'gitlab.com', https: false, ssh: true };
  const gitlabCom = { provider: 'gitlab', instance: 'https://gitlab.com', accountId: 'a' } as const;
  const privateGitlab = { provider: 'gitlab', instance: 'https://private.gitlab.example', accountId: 'b' } as const;

  test('an identity is specific to its instance', () => {
    expect(identityApplicability(identity({ account: gitlabCom, transport: 'account' }), https)).toEqual({ applicable: true });
    expect(identityApplicability(identity({ account: privateGitlab, transport: 'account' }), https))
      .toEqual({ applicable: false, reason: 'host', host: 'private.gitlab.example' });
    // The instance rule holds whatever the transport: an SSH identity that
    // answers to another instance's account is still the wrong identity here.
    expect(identityApplicability(identity({ account: privateGitlab, transport: 'ssh', sshCredentialId: 'k' }), ssh))
      .toEqual({ applicable: false, reason: 'host', host: 'private.gitlab.example' });
  });

  test('a transport has to reach the address', () => {
    expect(identityApplicability(identity({ account: gitlabCom, transport: 'account' }), ssh))
      .toEqual({ applicable: false, reason: 'scheme', scheme: 'https' });
    expect(identityApplicability(identity({ transport: 'anonymous' }), ssh))
      .toEqual({ applicable: false, reason: 'scheme', scheme: 'https' });
    expect(identityApplicability(identity({ transport: 'ssh', sshCredentialId: 'k' }), https))
      .toEqual({ applicable: false, reason: 'scheme', scheme: 'ssh' });
    expect(identityApplicability(identity({ transport: 'ssh', sshCredentialId: 'k' }), ssh)).toEqual({ applicable: true });
  });

  test('System Git reaches whatever the machine reaches, on any instance', () => {
    expect(identityApplicability(identity({ transport: 'system' }), https)).toEqual({ applicable: true });
    expect(identityApplicability(identity({ transport: 'system' }), ssh)).toEqual({ applicable: true });
    expect(identityApplicability(identity(), { host: 'anything.example', https: false, ssh: false })).toEqual({ applicable: true });
  });

  test('says why, in the words the picker shows', () => {
    const t = (key: string, params?: Record<string, string>) => `${key}:${JSON.stringify(params ?? {})}`;
    expect(describeIdentityApplicability({ applicable: false, reason: 'host', host: 'private.gitlab.example' }, t))
      .toBe('gitView.identity.unavailableHost:{"host":"private.gitlab.example"}');
    expect(describeIdentityApplicability({ applicable: false, reason: 'scheme', scheme: 'ssh' }, t))
      .toBe('gitView.identity.unavailableNeedsSsh:{}');
    expect(describeIdentityApplicability({ applicable: true }, t)).toBe('');
  });
});

describe('applyIdentityToRepository', () => {
  test('writes the account, the transport and the signature from one identity', async () => {
    const { apis, providerCalls, transportCalls, authorCalls } = harness();
    const outcome = await applyIdentityToRepository(
      { directory: '/repo', remoteName: 'origin', identity: identity({ account, transport: 'account' }) },
      apis,
    );
    expect(outcome).toEqual({ status: 'applied' });
    expect(providerCalls[0]).toEqual({
      directory: '/repo', expectedRepositoryId: 'repo_one', expectedRevision: 2,
      operation: 'add', provider: { ...account, primaryRemote: 'origin' },
    });
    expect(transportCalls[0]).toEqual({
      directory: '/repo', expectedRepositoryId: 'repo_one', expectedRevision: 2, expectedConfigRevision: 'config_one',
      expectedFetchFingerprint: 'fetch-one', expectedPushFingerprint: 'push-one', remote: 'origin',
      transport: 'https', credentialAccount: account,
    });
    expect(authorCalls).toEqual(['/repo:work']);
  });

  test('writes nothing more once the runtime switched mid-apply', async () => {
    const { apis, transportCalls, authorCalls } = harness();
    let runtime = 'host-a';
    const outcome = await applyIdentityToRepository(
      { directory: '/repo', remoteName: 'origin', identity: identity({ account, transport: 'account' }) },
      {
        ...apis,
        runtimeKey: () => runtime,
        sourceControl: {
          ...apis.sourceControl,
          repositoryProviderBindingMutate: async () => {
            runtime = 'host-b';
            throw new Error('binding failed');
          },
        },
      },
    );
    expect(outcome).toEqual({ status: 'failed', reason: 'runtime' });
    expect(transportCalls).toEqual([]);
    expect(authorCalls).toEqual([]);
  });

  test('replaces the account a repository already answers to', async () => {
    const bound = {
      ...account, accountId: 'occred:v1:github:old:r1', primaryRemote: 'origin',
      readiness: 'ready' as const, endpoint: endpoint('fetch-one'),
    };
    const { apis, providerCalls } = harness(read([bound]));
    await applyIdentityToRepository(
      { directory: '/repo', remoteName: 'origin', identity: identity({ account, transport: 'account' }) },
      apis,
    );
    expect(providerCalls[0]).toEqual({
      directory: '/repo', expectedRepositoryId: 'repo_one', expectedRevision: 2, operation: 'replace',
      target: {
        provider: bound.provider, instance: bound.instance, accountId: bound.accountId, primaryRemote: bound.primaryRemote,
      },
      provider: { ...account, primaryRemote: 'origin' },
    });
  });

  test('binds a managed key, and an SSH identity may still answer to an account', async () => {
    const { apis, transportCalls, providerCalls } = harness();
    await applyIdentityToRepository({
      directory: '/repo',
      remoteName: 'origin',
      identity: identity({ account, transport: 'ssh', sshCredentialId: 'ocgit:v1:ssh:key' }),
    }, apis);
    expect(transportCalls[0]).toEqual({
      directory: '/repo', expectedRepositoryId: 'repo_one', expectedRevision: 2, expectedConfigRevision: 'config_one',
      expectedFetchFingerprint: 'fetch-one', expectedPushFingerprint: 'push-one', remote: 'origin',
      transport: 'ssh', sshCredentialId: 'ocgit:v1:ssh:key',
    });
    expect(providerCalls).toHaveLength(1);
  });

  test('writes System Git without asking: it is what a repository uses by default', async () => {
    const acknowledged = harness();
    expect(await applyIdentityToRepository({
      directory: '/repo', remoteName: 'origin', identity: identity({ id: 'global', transport: 'system' }),
    }, acknowledged.apis)).toEqual({ status: 'applied' });
    expect(acknowledged.authorCalls).toEqual(['/repo:global']);
    expect(acknowledged.transportCalls[0]).toEqual({
      directory: '/repo', expectedRepositoryId: 'repo_one', expectedRevision: 2, expectedConfigRevision: 'config_one',
      expectedFetchFingerprint: 'fetch-one', expectedPushFingerprint: 'push-one', remote: 'origin',
      transport: 'system', unverifiedConfirmed: true,
    });
  });

  test('binds an anonymous transport without an account', async () => {
    const { apis, transportCalls, providerCalls } = harness();
    await applyIdentityToRepository(
      { directory: '/repo', remoteName: 'origin', identity: identity({ transport: 'anonymous' }) },
      apis,
    );
    expect(transportCalls[0]).toEqual({
      directory: '/repo', expectedRepositoryId: 'repo_one', expectedRevision: 2, expectedConfigRevision: 'config_one',
      expectedFetchFingerprint: 'fetch-one', expectedPushFingerprint: 'push-one', remote: 'origin',
      transport: 'anonymous',
    });
    expect(providerCalls).toEqual([]);
  });

  test('applies the system identity as the absence of an override', async () => {
    const bound = {
      ...account, primaryRemote: 'origin', readiness: 'ready' as const, endpoint: endpoint('fetch-one'),
    };
    const { apis, providerCalls, authorCalls } = harness(read([bound]));
    await applyIdentityToRepository({
      directory: '/repo', remoteName: 'origin', identity: identity({ id: 'global', transport: 'system' }),
    }, apis);
    // The account it used to answer to belonged to the identity it replaced.
    expect(providerCalls[0]).toEqual({
      directory: '/repo', expectedRepositoryId: 'repo_one', expectedRevision: 2, operation: 'remove',
      target: {
        provider: bound.provider, instance: bound.instance, accountId: bound.accountId, primaryRemote: bound.primaryRemote,
      },
    });
    // The server reads `global` as "remove this repository's own author".
    expect(authorCalls).toEqual(['/repo:global']);
  });

  test('leaves no account bound for an identity that names none', async () => {
    const bound = {
      ...account, primaryRemote: 'origin', readiness: 'ready' as const, endpoint: endpoint('fetch-one'),
    };
    const { apis, providerCalls } = harness(read([bound]));
    await applyIdentityToRepository(
      { directory: '/repo', remoteName: 'origin', identity: identity({ transport: 'anonymous' }) },
      apis,
    );
    expect(providerCalls).toHaveLength(1);
    expect(providerCalls[0].operation).toBe('remove');
  });

  test('reports a binding it could not write, and still writes the signature', async () => {
    const { apis, authorCalls } = harness();
    apis.sourceControl.repositoryProviderBindingMutate = async () => { throw new Error('conflict'); };
    expect(await applyIdentityToRepository(
      { directory: '/repo', remoteName: 'origin', identity: identity({ account, transport: 'account' }) },
      apis,
    )).toEqual({ status: 'failed', reason: 'binding' });
    expect(authorCalls).toEqual(['/repo:work']);
  });

  test('writes the signature alone when the runtime cannot bind transports', async () => {
    const { apis, authorCalls, providerCalls } = harness();
    expect(await applyIdentityToRepository(
      { directory: '/repo', remoteName: 'origin', identity: identity({ account, transport: 'account' }) },
      { ...apis, git: { setGitIdentity: apis.git.setGitIdentity } },
    )).toEqual({ status: 'applied' });
    expect(authorCalls).toEqual(['/repo:work']);
    expect(providerCalls).toEqual([]);
  });

  test('writes the signature alone for a repository with no remote', async () => {
    const { apis, authorCalls, providerCalls, transportCalls } = harness();
    expect(await applyIdentityToRepository(
      { directory: '/repo', remoteName: null, identity: identity({ account, transport: 'account' }) },
      apis,
    )).toEqual({ status: 'applied' });
    expect(authorCalls).toEqual(['/repo:work']);
    expect(providerCalls).toEqual([]);
    expect(transportCalls).toEqual([]);
  });
});

describe('the addresses an identity was already given', () => {
  const fork = (url: string) => ({
    name: 'fork',
    fetch: { displayUrl: url, fingerprint: 'fork-fetch' },
    push: { displayUrl: url, fingerprint: 'fork-push' },
  });
  const withFork = (url: string): SourceControlBindingRead => {
    const state = read([{
      provider: 'github' as const, instance: 'github.com', accountId: 'occred:v1:github:one:r1',
      primaryRemote: 'origin', readiness: 'ready' as const, endpoint: endpoint('fetch-one'),
    }]);
    state.repository.remotes = [remote, fork(url)];
    state.binding!.remotes = [
      { ...remote, mode: 'managed', credentialId: 'grant-origin', readiness: 'ready' },
      { ...fork(url), mode: 'managed', credentialId: 'grant-fork', readiness: 'ready' },
    ];
    return state;
  };
  const next = { provider: 'github', instance: 'github.com', accountId: 'occred:v1:github:two:r1' } as const;

  test('follow the identity the repository is given', async () => {
    const { apis, transportCalls, removalCalls } = harness(withFork('https://github.com/ada/repo.git'));

    expect(await applyIdentityToRepository(
      { directory: '/repo', remoteName: 'origin', identity: identity({ account: next, transport: 'account' }) },
      apis,
    )).toEqual({ status: 'applied' });

    // A grant the previous identity saved would keep pushing as the person
    // the repository used to be; without it the fork follows the new one.
    expect(transportCalls.map((call) => [call.remote, call.transport])).toEqual([['origin', 'https']]);
    expect(removalCalls).toEqual([{
      directory: '/repo',
      expectedRepositoryId: 'repo_one',
      expectedRevision: 2,
      expectedConfigRevision: 'config_one',
      expectedFetchFingerprint: 'fork-fetch',
      expectedPushFingerprint: 'fork-push',
      remote: 'fork',
    }]);
  });

  test('an address that was never granted is left to follow the identity', async () => {
    // A fork beside its upstream: the server derives its grant from the
    // identity's own, so nothing is written for it.
    const state = withFork('https://github.com/ada/repo.git');
    state.binding!.remotes = [
      { ...remote, mode: 'managed', credentialId: 'grant-origin', readiness: 'ready' },
      { ...fork('https://github.com/ada/repo.git'), mode: 'managed', credentialId: 'grant-origin', readiness: 'ready', inherited: true },
    ];
    const { apis, transportCalls, removalCalls } = harness(state);
    expect(await applyIdentityToRepository(
      { directory: '/repo', remoteName: 'origin', identity: identity({ account: next, transport: 'account' }) },
      apis,
    )).toEqual({ status: 'applied' });
    expect(transportCalls.map((call) => [call.remote, call.transport])).toEqual([['origin', 'https']]);
    expect(removalCalls).toEqual([]);
  });

  test('an address that was never granted and cannot be served is left alone', async () => {
    const state = withFork('https://gitlab.com/ada/repo.git');
    state.binding!.remotes = [{ ...remote, mode: 'managed', credentialId: 'grant-origin', readiness: 'ready' }];
    const { apis, transportCalls, removalCalls } = harness(state);
    await applyIdentityToRepository(
      { directory: '/repo', remoteName: 'origin', identity: identity({ account: next, transport: 'account' }) },
      apis,
    );
    expect(transportCalls.map((call) => call.remote)).toEqual(['origin']);
    expect(removalCalls).toEqual([]);
  });

  test('lose their grant when the identity cannot serve them', async () => {
    const { apis, transportCalls, removalCalls } = harness(withFork('https://gitlab.com/ada/repo.git'));

    expect(await applyIdentityToRepository(
      { directory: '/repo', remoteName: 'origin', identity: identity({ account: next, transport: 'account' }) },
      apis,
    )).toEqual({ status: 'applied' });

    expect(transportCalls.map((call) => call.remote)).toEqual(['origin']);
    expect(removalCalls).toEqual([{
      directory: '/repo',
      expectedRepositoryId: 'repo_one',
      expectedRevision: 2,
      expectedConfigRevision: 'config_one',
      expectedFetchFingerprint: 'fork-fetch',
      expectedPushFingerprint: 'fork-push',
      remote: 'fork',
    }]);
  });

  test('are left alone by a runtime that cannot remove a grant', async () => {
    const { apis, transportCalls } = harness(withFork('https://gitlab.com/ada/repo.git'));
    expect(await applyIdentityToRepository(
      { directory: '/repo', remoteName: 'origin', identity: identity({ account: next, transport: 'account' }) },
      { ...apis, git: { configureTransportBinding: apis.git.configureTransportBinding, setGitIdentity: apis.git.setGitIdentity } },
    )).toEqual({ status: 'applied' });
    expect(transportCalls.map((call) => call.remote)).toEqual(['origin']);
  });

  test('leave a stale grant to the repository configuration', async () => {
    // Its address moved under it, so the authority a rewrite would be written
    // against is gone and the server would refuse either way.
    const stale = withFork('https://gitlab.com/ada/repo.git');
    stale.binding!.remotes[1] = { ...stale.binding!.remotes[1], readiness: 'config-changed' };
    const { apis, transportCalls, removalCalls } = harness(stale);

    expect(await applyIdentityToRepository(
      { directory: '/repo', remoteName: 'origin', identity: identity({ account: next, transport: 'account' }) },
      apis,
    )).toEqual({ status: 'applied' });
    expect(transportCalls.map((call) => call.remote)).toEqual(['origin']);
    expect(removalCalls).toEqual([]);
  });

  test('one that cannot follow leaves the rest written', async () => {
    const { apis, transportCalls } = harness(withFork('https://github.com/ada/repo.git'));
    apis.git.removeTransportBinding = async () => { throw new Error('conflict'); };
    expect(await applyIdentityToRepository(
      { directory: '/repo', remoteName: 'origin', identity: identity({ account: next, transport: 'account' }) },
      apis,
    )).toEqual({ status: 'failed', reason: 'binding' });
    expect(transportCalls.map((call) => call.remote)).toEqual(['origin']);
  });
});

describe('auxiliaryGrantIntent', () => {
  const authority = {
    directory: '/repo',
    expectedRepositoryId: 'repo_one',
    expectedRevision: 2,
    expectedConfigRevision: 'config_one',
    parentRemote: 'origin',
    expectedParentFingerprint: 'fetch-one',
    kind: 'submodule' as const,
    path: 'vendor/lib',
    expectedEndpointFingerprint: 'endpoint-one',
  };

  test('an account answers over HTTPS with its own credential', () => {
    expect(auxiliaryGrantIntent(identity({ account, transport: 'account' }), authority))
      .toEqual({ ...authority, operation: 'configure', transport: 'https', credentialAccount: account });
  });

  test('a managed key answers over SSH', () => {
    expect(auxiliaryGrantIntent(identity({ transport: 'ssh', sshCredentialId: 'ocgit:v1:ssh:key' }), authority))
      .toEqual({ ...authority, operation: 'configure', transport: 'ssh', sshCredentialId: 'ocgit:v1:ssh:key' });
  });

  test('an anonymous identity reads without naming anyone', () => {
    expect(auxiliaryGrantIntent(identity({ transport: 'anonymous' }), authority))
      .toEqual({ ...authority, operation: 'configure', transport: 'anonymous' });
  });

  test('System Git answers without a separate confirmation', () => {
    const system = identity({ id: 'global', transport: 'system' });
    expect(auxiliaryGrantIntent(system, authority))
      .toEqual({ ...authority, operation: 'configure', transport: 'system', unverifiedConfirmed: true });
  });

  test('names nothing when the identity carries no way to reach the endpoint', () => {
    // An identity from an earlier release reaches it with the machine's own Git.
    expect(auxiliaryGrantIntent(identity({ id: 'profile-1' }), authority))
      .toEqual({ ...authority, operation: 'configure', transport: 'system', unverifiedConfirmed: true });
    // An account with no credential, and a key that is not there.
    expect(auxiliaryGrantIntent(identity({ transport: 'account' }), authority)).toBeNull();
    expect(auxiliaryGrantIntent(identity({ transport: 'ssh' }), authority)).toBeNull();
  });
});

describe('grantIdentityToRemote', () => {
  const fork = {
    name: 'fork',
    fetch: { displayUrl: 'https://github.com/ada/repo.git', fingerprint: 'fork-fetch' },
    push: { displayUrl: 'https://github.com/ada/repo.git', fingerprint: 'fork-push' },
  };
  const bound = {
    provider: 'github' as const, instance: 'github.com', accountId: 'occred:v1:github:one:r1',
    primaryRemote: 'origin', readiness: 'ready' as const, endpoint: endpoint('fetch-one'),
  };
  const withFork = (): SourceControlBindingRead => {
    const state = read([bound]);
    state.repository.remotes = [remote, fork];
    state.binding!.remotes = [{ ...remote, mode: 'managed', credentialId: 'grant-origin', readiness: 'ready' }];
    return state;
  };

  test('writes the transfer half for the named remote and leaves the account alone', async () => {
    const { apis, transportCalls, providerCalls, authorCalls } = harness(withFork());

    expect(await grantIdentityToRemote(
      { directory: '/repo', remoteName: 'fork', identity: identity({ account, transport: 'account' }) },
      apis,
    )).toEqual({ status: 'applied' });

    expect(transportCalls).toEqual([{
      directory: '/repo',
      expectedRepositoryId: 'repo_one',
      expectedRevision: 2,
      expectedConfigRevision: 'config_one',
      expectedFetchFingerprint: 'fork-fetch',
      expectedPushFingerprint: 'fork-push',
      remote: 'fork',
      transport: 'https',
      credentialAccount: account,
    }]);
    // Which account the repository answers to, and who commits, were settled
    // when the identity was applied; naming one more address revisits neither.
    expect(providerCalls).toEqual([]);
    expect(authorCalls).toEqual([]);
  });

  test('gives System Git to another address without asking', async () => {
    const system = identity({ id: 'global', transport: 'system' });
    const confirmed = harness(withFork());
    expect(await grantIdentityToRemote(
      { directory: '/repo', remoteName: 'fork', identity: system },
      confirmed.apis,
    )).toEqual({ status: 'applied' });
    expect(confirmed.transportCalls[0]).toEqual({
      directory: '/repo',
      expectedRepositoryId: 'repo_one',
      expectedRevision: 2,
      expectedConfigRevision: 'config_one',
      expectedFetchFingerprint: 'fork-fetch',
      expectedPushFingerprint: 'fork-push',
      remote: 'fork',
      transport: 'system',
      unverifiedConfirmed: true,
    });
  });

  test('reports what it could not write, and names a remote the repository does not have', async () => {
    const { apis } = harness(withFork());
    apis.git.configureTransportBinding = async () => { throw new Error('conflict'); };
    expect(await grantIdentityToRemote(
      { directory: '/repo', remoteName: 'fork', identity: identity({ account, transport: 'account' }) },
      apis,
    )).toEqual({ status: 'failed', reason: 'binding' });

    const missing = harness(withFork());
    expect(await grantIdentityToRemote(
      { directory: '/repo', remoteName: 'nowhere', identity: identity({ account, transport: 'account' }) },
      missing.apis,
    )).toEqual({ status: 'failed', reason: 'binding' });
    expect(missing.transportCalls).toEqual([]);
  });

  test('gives nothing away in a runtime that holds no bindings', async () => {
    const { apis, transportCalls } = harness(withFork());
    expect(await grantIdentityToRemote(
      { directory: '/repo', remoteName: 'fork', identity: identity({ account, transport: 'account' }) },
      { ...apis, git: { setGitIdentity: apis.git.setGitIdentity } },
    )).toEqual({ status: 'failed', reason: 'binding' });
    expect(transportCalls).toEqual([]);
  });
});

describe('identities from an earlier release', () => {
  const legacy = identity({ id: 'profile-1', name: 'Work' });

  test('writes the author and gives every remote the machine\'s own Git, dropping the previous account', async () => {
    const bound = {
      provider: 'github' as const, instance: 'github.com', accountId: 'occred:v1:github:one:r1',
      primaryRemote: 'origin', readiness: 'ready' as const, endpoint: endpoint('fetch-one'),
    };
    const { apis, providerCalls, transportCalls, authorCalls } = harness(read([bound]));

    expect(await applyIdentityToRepository({ directory: '/repo', remoteName: 'origin', identity: legacy }, apis))
      .toEqual({ status: 'applied' });
    expect(authorCalls).toEqual(['/repo:profile-1']);
    // It names no account, so the repository stops answering to the one it had.
    expect(providerCalls.map((call) => call.operation)).toEqual(['remove']);
    expect(transportCalls.map((call) => [call.remote, call.transport])).toEqual([['origin', 'system']]);
  });
});
