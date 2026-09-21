import { afterEach, describe, expect, test } from 'bun:test';
import type {
  GitIdentityProfile,
  GitTransportBindingIntent,
  GitTransportBindingRemovalIntent,
  SourceControlBindingRead,
  SourceControlProviderBindingMutation,
  SourceControlRepositoryBinding,
} from '@/lib/api/types';
import { applyIdentityToRepository, auxiliaryGrantIntent, describeIdentityApplicability, grantIdentityToRemote, identityApplicability, isSignatureOnlyIdentity, needsSystemAcknowledgement } from './applyIdentity';
import { repositoryBindingOwner } from './repository-binding';
import { usePendingOpenCodeRestartStore } from '@/stores/usePendingOpenCodeRestartStore';

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
      .toBe('gitView.identity.unavailableScheme:{"scheme":"SSH"}');
    expect(describeIdentityApplicability({ applicable: true }, t)).toBe('');
  });
});

describe('needsSystemAcknowledgement', () => {
  const system = identity({ id: 'global', transport: 'system' });

  test('asks before the identity that uses whatever the machine holds', () => {
    expect(needsSystemAcknowledgement(system, true)).toBe(true);
    // A stored identity that names no account is a signature, not a claim on
    // the machine's credentials, so it asks nothing.
    expect(needsSystemAcknowledgement(identity(), true)).toBe(false);
  });

  test('asks nothing when the identity names its own credentials', () => {
    expect(needsSystemAcknowledgement(identity({ account, transport: 'account' }), true)).toBe(false);
    expect(needsSystemAcknowledgement(identity({ transport: 'ssh', sshCredentialId: 'k' }), true)).toBe(false);
    expect(needsSystemAcknowledgement(identity({ transport: 'anonymous' }), true)).toBe(false);
  });

  test('asks nothing when there is no remote to bind', () => {
    expect(needsSystemAcknowledgement(identity({ transport: 'system' }), false)).toBe(false);
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

  test('asks for an OpenCode restart when a remote first gets an HTTPS credential grant', async () => {
    const pending = () => usePendingOpenCodeRestartStore.getState().changes.map((change) => change.id);
    usePendingOpenCodeRestartStore.getState().clear();
    await applyIdentityToRepository(
      { directory: '/repo', remoteName: 'origin', identity: identity({ account, transport: 'account' }) },
      harness().apis,
    );
    expect(pending().some((id) => id.startsWith('cli:agent-git:/repo:'))).toBe(true);

    // A key travels over SSH and never through the credential helper.
    usePendingOpenCodeRestartStore.getState().clear();
    await applyIdentityToRepository(
      { directory: '/repo', remoteName: 'origin', identity: identity({ transport: 'ssh', sshCredentialId: 'ocgit:v1:ssh:key' }) },
      harness().apis,
    );
    expect(pending()).toEqual([]);

    // A remote the agent already answers for needs no second restart.
    const answered = read();
    answered.binding!.remotes = [{ ...remote, mode: 'managed', credentialId: 'grant', readiness: 'ready' }];
    usePendingOpenCodeRestartStore.getState().clear();
    await applyIdentityToRepository(
      { directory: '/repo', remoteName: 'origin', identity: identity({ account, transport: 'account' }) },
      harness(answered).apis,
    );
    expect(pending()).toEqual([]);
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

  test('asks before trusting whatever the machine holds', async () => {
    const unacknowledged = harness();
    expect(await applyIdentityToRepository(
      { directory: '/repo', remoteName: 'origin', identity: identity({ id: 'global', transport: 'system' }) },
      unacknowledged.apis,
    )).toEqual({ status: 'acknowledgement-required' });
    expect(unacknowledged.transportCalls).toEqual([]);
    // The signature is still written: it is about who commits, not about trust.
    expect(unacknowledged.authorCalls).toEqual(['/repo:global']);

    const acknowledged = harness();
    expect(await applyIdentityToRepository({
      directory: '/repo', remoteName: 'origin', identity: identity({ id: 'global', transport: 'system' }), acknowledgedSystem: true,
    }, acknowledged.apis)).toEqual({ status: 'applied' });
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
      acknowledgedSystem: true,
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

    // Otherwise the repository would push to one address as the person it now
    // acts as, and to the other as the person it used to be.
    expect(transportCalls.map((call) => [call.remote, call.transport])).toEqual([['origin', 'https'], ['fork', 'https']]);
    expect(transportCalls[1]).toEqual({
      directory: '/repo',
      expectedRepositoryId: 'repo_one',
      expectedRevision: 2,
      expectedConfigRevision: 'config_one',
      expectedFetchFingerprint: 'fork-fetch',
      expectedPushFingerprint: 'fork-push',
      remote: 'fork',
      transport: 'https',
      credentialAccount: next,
    });
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
    let call = 0;
    apis.git.configureTransportBinding = async (intent: GitTransportBindingIntent) => {
      transportCalls.push(intent);
      call += 1;
      if (call > 1) throw new Error('conflict');
      return { status: 'configured' as const, binding: withFork('https://github.com/ada/repo.git') };
    };
    expect(await applyIdentityToRepository(
      { directory: '/repo', remoteName: 'origin', identity: identity({ account: next, transport: 'account' }) },
      apis,
    )).toEqual({ status: 'failed', reason: 'binding' });
    expect(transportCalls.map((call) => call.remote)).toEqual(['origin', 'fork']);
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
    expect(auxiliaryGrantIntent(identity({ account, transport: 'account' }), authority, false))
      .toEqual({ ...authority, operation: 'configure', transport: 'https', credentialAccount: account });
  });

  test('a managed key answers over SSH', () => {
    expect(auxiliaryGrantIntent(identity({ transport: 'ssh', sshCredentialId: 'ocgit:v1:ssh:key' }), authority, false))
      .toEqual({ ...authority, operation: 'configure', transport: 'ssh', sshCredentialId: 'ocgit:v1:ssh:key' });
  });

  test('an anonymous identity reads without naming anyone', () => {
    expect(auxiliaryGrantIntent(identity({ transport: 'anonymous' }), authority, false))
      .toEqual({ ...authority, operation: 'configure', transport: 'anonymous' });
  });

  test('System Git is written only once someone has said so', () => {
    const system = identity({ id: 'global', transport: 'system' });
    expect(auxiliaryGrantIntent(system, authority, false)).toBeNull();
    expect(auxiliaryGrantIntent(system, authority, true))
      .toEqual({ ...authority, operation: 'configure', transport: 'system', unverifiedConfirmed: true });
  });

  test('names nothing when the identity carries no way to reach the endpoint', () => {
    // An identity from an earlier release claims no credentials, so confirming
    // System Git on its behalf would grant what it never named.
    expect(auxiliaryGrantIntent(identity({ id: 'profile-1' }), authority, true)).toBeNull();
    // An account with no credential, and a key that is not there.
    expect(auxiliaryGrantIntent(identity({ transport: 'account' }), authority, false)).toBeNull();
    expect(auxiliaryGrantIntent(identity({ transport: 'ssh' }), authority, false)).toBeNull();
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
  const pending = () => usePendingOpenCodeRestartStore.getState().changes.map((change) => change.id);

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

  test('gives nothing away for an identity from an earlier release', async () => {
    const { apis, transportCalls } = harness(withFork());
    expect(await grantIdentityToRemote(
      { directory: '/repo', remoteName: 'fork', identity: identity({ id: 'profile-1' }) },
      apis,
    )).toEqual({ status: 'failed', reason: 'binding' });
    expect(transportCalls).toEqual([]);
  });

  test('asks before trusting whatever the machine holds', async () => {
    const system = identity({ id: 'global', transport: 'system' });
    const unconfirmed = harness(withFork());
    expect(await grantIdentityToRemote({ directory: '/repo', remoteName: 'fork', identity: system }, unconfirmed.apis))
      .toEqual({ status: 'acknowledgement-required' });
    expect(unconfirmed.transportCalls).toEqual([]);

    const confirmed = harness(withFork());
    expect(await grantIdentityToRemote(
      { directory: '/repo', remoteName: 'fork', identity: system, acknowledgedSystem: true },
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

  test('asks for an OpenCode restart only when the new address travels over HTTPS', async () => {
    usePendingOpenCodeRestartStore.getState().clear();
    await grantIdentityToRemote(
      { directory: '/repo', remoteName: 'fork', identity: identity({ account, transport: 'account' }) },
      harness(withFork()).apis,
    );
    expect(pending().some((id) => id.startsWith('cli:agent-git:/repo:'))).toBe(true);

    // A key travels over SSH and never through the credential helper.
    const sshFork = withFork();
    sshFork.repository.remotes = [remote, {
      name: 'fork',
      fetch: { displayUrl: 'git@github.com:ada/repo.git', fingerprint: 'fork-fetch' },
      push: { displayUrl: 'git@github.com:ada/repo.git', fingerprint: 'fork-push' },
    }];
    usePendingOpenCodeRestartStore.getState().clear();
    await grantIdentityToRemote(
      { directory: '/repo', remoteName: 'fork', identity: identity({ transport: 'ssh', sshCredentialId: 'ocgit:v1:ssh:key' }) },
      harness(sshFork).apis,
    );
    expect(pending()).toEqual([]);
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

describe('signature-only identities from an earlier release', () => {
  const legacy = identity({ id: 'profile-1', name: 'Work' });

  test('writes the author and leaves the repository account and transport alone', async () => {
    const bound = {
      provider: 'github' as const, instance: 'github.com', accountId: 'occred:v1:github:one:r1',
      primaryRemote: 'origin', readiness: 'ready' as const, endpoint: endpoint('fetch-one'),
    };
    const { apis, providerCalls, transportCalls, authorCalls } = harness(read([bound]));

    expect(await applyIdentityToRepository({ directory: '/repo', remoteName: 'origin', identity: legacy }, apis))
      .toEqual({ status: 'applied' });
    expect(authorCalls).toEqual(['/repo:profile-1']);
    // In the release that made these, choosing one wrote the author and nothing
    // else. Removing the repository's account here would be a new behaviour.
    expect(providerCalls).toEqual([]);
    expect(transportCalls).toEqual([]);
  });

  test('is not the System identity, so it asks for no acknowledgement', () => {
    expect(isSignatureOnlyIdentity(legacy)).toBe(true);
    expect(needsSystemAcknowledgement(legacy, true)).toBe(false);
    // The System identity still asks: it does claim the machine's credentials.
    expect(isSignatureOnlyIdentity(identity({ id: 'global', transport: 'system' }))).toBe(false);
    expect(needsSystemAcknowledgement(identity({ id: 'global', transport: 'system' }), true)).toBe(true);
    // An identity that names an account is complete, not a signature.
    expect(isSignatureOnlyIdentity(identity({ account, transport: 'account' }))).toBe(false);
  });
});
