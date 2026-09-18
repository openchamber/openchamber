import { describe, expect, test } from 'bun:test';
import type { GitRemote, SourceControlBindingRead, SourceControlIdentity } from '@/lib/api/types';
import { gitIdentityProfileSchema, identityTransport } from '@/lib/api/git-identity';
import {
  getBoundSourceControlReadContexts,
  getSourceControlBaseUrl,
  mergeIncompleteSourceControlPage,
  resolveSourceControlIdentity,
  resolveSourceControlTarget,
  gitRemoteHost,
  isSshRemoteUrl,
  proposeIdentityForHost,
  selectableIdentities,
  identityDisplayName,
  identityAccountConnected,
  buildManagedAccountOptions,
  activeIdentityFor,
  remoteTraits,
  instanceHost,
} from './identity';

const remote = (url: string): GitRemote => ({ name: 'origin', fetchUrl: url, pushUrl: url });

const repository = {
  repositoryId: 'repo-one',
  configRevision: 'config-one',
  bare: false,
  remotes: [{ name: 'origin', fetch: { displayUrl: 'https://github.com/team/repo', fingerprint: 'fetch' },
    push: { displayUrl: 'https://github.com/team/repo', fingerprint: 'push' } }],
};

const bindingRead = (status: 'bound' | 'needs-attention' | 'missing'): SourceControlBindingRead => {
  if (status === 'missing') return { status, repository, revision: 0, binding: null };
  return {
    status,
    repository,
    revision: 3,
    binding: {
      repositoryId: repository.repositoryId,
      revision: 3,
      providers: [{ provider: 'github', instance: 'github.com', accountId: 'github.com#7', primaryRemote: 'origin',
        readiness: status === 'bound' ? 'ready' : 'account-unavailable', endpoint: repository.remotes[0].fetch }],
      remotes: [],
      auxiliary: [],
      state: status === 'bound' ? 'bound' : 'needs-attention',
      configRevision: repository.configRevision,
    },
  };
};

describe('source-control identity resolution', () => {
  test('recognizes GitLab.com HTTPS and SSH remotes', () => {
    const expected = { provider: 'gitlab', instance: 'https://gitlab.com' };
    expect(resolveSourceControlIdentity(remote('https://gitlab.com/team/repo.git'), [])).toEqual(expected);
    expect(resolveSourceControlIdentity(remote('git@gitlab.com:team/repo.git'), [])).toEqual(expected);
  });

  test('matches a known self-managed instance by remote host', () => {
    const identity = { provider: 'gitlab', instance: 'https://gitlab.example.com' } satisfies SourceControlIdentity;
    expect(resolveSourceControlIdentity(remote('ssh://git@gitlab.example.com/team/repo.git'), [identity])).toBe(identity);
  });

  test('recognizes GitHub and rejects unknown hosts', () => {
    const expected = { provider: 'github', instance: 'github.com' };
    expect(resolveSourceControlIdentity(remote('git@github.com:team/repo.git'), [])).toEqual(expected);
    expect(resolveSourceControlIdentity(remote('git@example.com:team/repo.git'), [])).toBeNull();
  });

  test('strict target resolution rejects unknown and ambiguous remotes', () => {
    expect(resolveSourceControlTarget([remote('git@example.com:team/repo.git')], [])).toBeNull();

    const upstream = { ...remote('https://github.com/team/repo.git'), name: 'upstream' };
    const origin = { ...remote('https://gitlab.com/team/repo.git'), name: 'origin' };
    expect(resolveSourceControlTarget([upstream, origin], [])).toBeNull();
  });

  test('matches self-managed instances by host and port', () => {
    const first = { provider: 'gitlab', instance: 'https://gitlab.example.com:8443' } satisfies SourceControlIdentity;
    const second = { provider: 'gitlab', instance: 'https://gitlab.example.com:9443' } satisfies SourceControlIdentity;
    expect(resolveSourceControlTarget(
      [remote('ssh://git@gitlab.example.com:9443/team/repo.git')],
      [first, second],
    )?.identity).toBe(second);
  });

  test('normalizes provider instances for browser links', () => {
    expect(getSourceControlBaseUrl({ provider: 'github', instance: 'github.com' })).toBe('https://github.com');
    expect(getSourceControlBaseUrl({ provider: 'gitlab', instance: 'https://gitlab.example.com' })).toBe('https://gitlab.example.com');
  });
});

describe('source-control binding read contexts', () => {
  test('a valid binding provides the exact account, remote and revision', () => {
    expect(getBoundSourceControlReadContexts(bindingRead('bound'), '/repo')).toEqual([{
      provider: 'github', instance: 'github.com', accountId: 'github.com#7', primaryRemote: 'origin',
      directory: '/repo', repositoryId: 'repo-one', bindingRevision: 3,
    }]);
  });

  test('missing and needs-attention bindings grant no read authority', () => {
    for (const status of ['missing', 'needs-attention'] as const) {
      expect(getBoundSourceControlReadContexts(bindingRead(status), '/repo')).toEqual([]);
    }
  });
});

describe('partial source-control pages', () => {
  const item = (projectId: string, number: number) => ({ project: { id: projectId }, number });

  test('preserves only failed project items missing from the next page', () => {
    const retained = item('upstream/repo', 2);
    const replaced = item('upstream/repo', 3);
    const staleComplete = item('owner/repo', 4);
    const nextReplacement = item('upstream/repo', 3);
    const freshComplete = item('owner/repo', 5);

    expect(mergeIncompleteSourceControlPage(
      [retained, replaced, staleComplete],
      {
        items: [nextReplacement, freshComplete],
        page: 1,
        hasMore: false,
        incompleteProjectIds: ['upstream/repo'],
      },
    )).toEqual([nextReplacement, freshComplete, retained]);
  });

  test('accepts an authoritative empty page when every project completed', () => {
    expect(mergeIncompleteSourceControlPage(
      [item('owner/repo', 1)],
      { items: [], page: 1, hasMore: false },
    )).toEqual([]);
  });
});

describe('gitRemoteHost', () => {
  test('reads the host from https and scp-like remotes alike', () => {
    expect(gitRemoteHost('https://github.com/team/repo.git')).toBe('github.com');
    expect(gitRemoteHost('https://GitLab.example.com:8443/team/repo.git')).toBe('gitlab.example.com');
    expect(gitRemoteHost('git@github.com:team/repo.git')).toBe('github.com');
    expect(gitRemoteHost('ssh://git@gitlab.example.com/team/repo.git')).toBe('gitlab.example.com');
    expect(gitRemoteHost('  git@GitHub.com:team/repo.git  ')).toBe('github.com');
  });

  test('returns null when there is no host to read', () => {
    expect(gitRemoteHost('')).toBeNull();
    expect(gitRemoteHost('   ')).toBeNull();
    expect(gitRemoteHost('team/repo.git')).toBeNull();
    expect(gitRemoteHost('not a url')).toBeNull();
  });
});

describe('isSshRemoteUrl', () => {
  test('recognises explicit and scp-like SSH remotes', () => {
    expect(isSshRemoteUrl('ssh://git@github.com/team/repo.git')).toBe(true);
    expect(isSshRemoteUrl('git@github.com:team/repo.git')).toBe(true);
    expect(isSshRemoteUrl('  gitlab.example.com:team/repo.git  ')).toBe(true);
  });

  test('does not mistake an HTTPS remote for the scp-like form', () => {
    // `https:` also reads as `<word>:<rest>`, which is why the scheme is checked.
    expect(isSshRemoteUrl('https://github.com/team/repo.git')).toBe(false);
    expect(isSshRemoteUrl('http://gitlab.example.com:8080/team/repo.git')).toBe(false);
    expect(isSshRemoteUrl('')).toBe(false);
  });
});

describe('gitIdentityProfileSchema', () => {
  const signature = { id: 'work', name: 'Work', userName: 'Ada', userEmail: 'ada@example.com' };
  const account = { provider: 'github', instance: 'github.com', accountId: 'occred:v1:github:one:r1' } as const;

  test('reads an identity written before identities carried a transport as System Git', () => {
    const parsed = gitIdentityProfileSchema.parse(signature);
    expect(identityTransport(parsed)).toBe('system');
    expect(parsed.account ?? null).toBeNull();
  });

  test('accepts an account, an SSH key, and an SSH key that still names an account', () => {
    expect(gitIdentityProfileSchema.parse({ ...signature, account, transport: 'account' }).account).toEqual(account);
    const ssh = gitIdentityProfileSchema.parse({
      ...signature, transport: 'ssh', sshCredentialId: 'ocgit:v1:ssh:key', account,
    });
    expect(identityTransport(ssh)).toBe('ssh');
    expect(ssh.account).toEqual(account);
  });

  test('refuses a transport its credentials cannot serve', () => {
    expect(() => gitIdentityProfileSchema.parse({ ...signature, transport: 'account' })).toThrow();
    expect(() => gitIdentityProfileSchema.parse({ ...signature, transport: 'ssh' })).toThrow();
    expect(() => gitIdentityProfileSchema.parse({ ...signature, transport: 'system', sshCredentialId: 'k' })).toThrow();
  });
});

describe('proposeIdentityForHost', () => {
  const github = { id: 'gh', account: { instance: 'github.com' } };
  const gitlab = { id: 'gl', account: { instance: 'https://gitlab.com' } };
  const plain = { id: 'plain', account: null };

  test('offers the identity that already names an account on the host', () => {
    expect(proposeIdentityForHost([plain, gitlab, github], 'github.com')?.id).toBe('gh');
    expect(proposeIdentityForHost([plain, github, gitlab], 'gitlab.com')?.id).toBe('gl');
  });

  test('falls back to the default identity, then to System, and never to a guess', () => {
    const system = { id: 'global', account: null };
    expect(proposeIdentityForHost([plain, github], 'gitlab.com', 'plain')?.id).toBe('plain');
    expect(proposeIdentityForHost([plain, github], 'gitlab.com')).toBeNull();
    expect(proposeIdentityForHost([plain, github], null, 'missing')).toBeNull();
    expect(proposeIdentityForHost([system, plain, github], 'gitlab.com')?.id).toBe('global');
    expect(proposeIdentityForHost([system, plain, github], 'gitlab.com', 'plain')?.id).toBe('plain');
    // A host match wins over the default: it answers a question the default cannot.
    expect(proposeIdentityForHost([plain, github], 'github.com', 'plain')?.id).toBe('gh');
  });
});

describe('remoteTraits and instanceHost', () => {
  test('reads what a remote allows', () => {
    expect(remoteTraits('https://gitlab.com/team/repo.git')).toEqual({ host: 'gitlab.com', https: true, ssh: false });
    expect(remoteTraits('git@github.com:team/repo.git')).toEqual({ host: 'github.com', https: false, ssh: true });
    expect(remoteTraits('ssh://git@private.gitlab.example/team/repo.git')).toEqual({ host: 'private.gitlab.example', https: false, ssh: true });
    expect(remoteTraits('  ')).toEqual({ host: null, https: false, ssh: false });
  });

  test('reads a provider instance whether stored bare or as a URL', () => {
    expect(instanceHost('github.com')).toBe('github.com');
    expect(instanceHost('https://gitlab.com')).toBe('gitlab.com');
    expect(instanceHost('https://private.gitlab.example:8443')).toBe('private.gitlab.example');
  });
});

describe('selectableIdentities', () => {
  const complete = (profile: { id: string }) => profile.id.startsWith('ok');
  const system = { id: 'global' };

  test('always offers the system identity and only complete stored ones', () => {
    expect(selectableIdentities([{ id: 'ok-one' }, { id: 'bad' }], system, complete).map((i) => i.id))
      .toEqual(['global', 'ok-one']);
    // Without a system identity the list is what is complete, and nothing else.
    expect(selectableIdentities([{ id: 'ok-one' }, { id: 'bad' }], null, complete).map((i) => i.id))
      .toEqual(['ok-one']);
    // A stored record that took the system id cannot displace the discovered one.
    expect(selectableIdentities([{ id: 'global' }], system, () => true).map((i) => i.id)).toEqual(['global']);
    expect(selectableIdentities([{ id: 'global' }], system, () => true)[0]).toBe(system);
  });
});

describe('identityDisplayName', () => {
  test('names the system identity by the product, and every other by its record', () => {
    const t = () => 'System identity';
    expect(identityDisplayName({ id: 'global', name: 'Ada Lovelace' }, t)).toBe('System identity');
    expect(identityDisplayName({ id: 'work', name: 'Work' }, t)).toBe('Work');
    expect(identityDisplayName(null, t)).toBe('');
  });
});

describe('identityAccountConnected', () => {
  const account = { provider: 'github', instance: 'github.com', accountId: 'occred:v1:github:one:r1' } as const;
  const identity = { account };

  test('keeps an identity whose credential is connected, and drops one whose account was removed', () => {
    expect(identityAccountConnected(identity, () => [account.accountId])).toBe(true);
    expect(identityAccountConnected(identity, () => ['occred:v1:github:other:r1'])).toBe(false);
    expect(identityAccountConnected(identity, () => [])).toBe(false);
  });

  test('an instance that has not been read yet is not treated as disconnected', () => {
    expect(identityAccountConnected(identity, () => null)).toBe(true);
    // The System identity names no account, so there is nothing to check.
    expect(identityAccountConnected({ account: null }, () => [])).toBe(true);
  });
});

describe('buildManagedAccountOptions', () => {
  const identity = { provider: 'gitlab', instance: 'https://gitlab.com' } as const;
  const account = (id: string, providerUserId: string, current: boolean) => ({
    id, providerUserId, current, status: 'valid', source: 'pat', credentialId: id, credentialRevision: 1,
    providerUserStatus: 'available',
    user: { id: 'gitlab-7', username: 'ada', provider: 'gitlab', instance: 'https://gitlab.com' },
  } as const);

  test('offers one option per person, preferring the current credential', () => {
    const options = buildManagedAccountOptions(identity, [
      account('occred:v1:gitlab:old:r1', 'gitlab#7', false),
      account('occred:v1:gitlab:new:r1', 'gitlab#7', true),
      account('occred:v1:gitlab:other:r1', 'gitlab#9', false),
    ], () => 'Personal access token');

    expect(options.map((option) => option.reference.accountId))
      .toEqual(['occred:v1:gitlab:new:r1', 'occred:v1:gitlab:other:r1']);
  });

  test('names the person and never the credential reference', () => {
    const [option] = buildManagedAccountOptions(identity, [account('occred:v1:gitlab:new:r1', 'gitlab#7', true)], () => 'Personal access token');
    expect(option.label).toBe('GitLab @ada · https://gitlab.com · Personal access token');
    expect(option.label).not.toContain('occred');
  });
});

describe('activeIdentityFor', () => {
  const fromAuthor = (author: { userName: string; userEmail: string }) =>
    ({ id: 'local-config', name: author.userName, ...author });
  const work = { id: 'work', name: 'Work', userName: 'Ada', userEmail: 'ada@work.example' };
  const system = { id: 'global', name: 'Machine', userName: 'Machine', userEmail: 'machine@example.invalid' };

  test('a repository with no author of its own is on the system identity', () => {
    // Both surfaces have to answer this the same way: the mobile Changes view
    // used to read "no identity" where the panel read "system identity".
    expect(activeIdentityFor([work], system, null, fromAuthor)).toBe(system);
    expect(activeIdentityFor([work], system, { userName: '', userEmail: '' }, fromAuthor)).toBe(system);
    expect(activeIdentityFor([work], null, null, fromAuthor)).toBeNull();
  });

  test('the repository author picks the identity, and is shown as itself when none matches', () => {
    expect(activeIdentityFor([work], system, { userName: 'Ada', userEmail: 'ada@work.example' }, fromAuthor)).toBe(work);
    expect(activeIdentityFor([work], system, system, fromAuthor)).toBe(system);
    expect(activeIdentityFor([work], system, { userName: 'Someone', userEmail: 'else@example.invalid' }, fromAuthor))
      .toEqual({ id: 'local-config', name: 'Someone', userName: 'Someone', userEmail: 'else@example.invalid' });
  });
});
