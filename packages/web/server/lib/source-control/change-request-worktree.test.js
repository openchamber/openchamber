import { describe, expect, it, vi } from 'vitest';
import { createChangeRequestWorktreeSource } from './change-request-worktree.js';
import { sourceControlProviderDescriptors } from './provider-descriptors.js';
import { ownedOriginInstance } from './origin-instance.js';

const remote = (name, url) => ({
  name,
  fetch: { displayUrl: url, fingerprint: `fp-${name}` },
  push: { displayUrl: url, fingerprint: `fp-${name}` },
});
const read = ({ remotes, providers = null, revision = 4 }) => ({
  revision,
  repository: { repositoryId: 'repo_one', remotes },
  binding: providers ? { providers, remotes: [] } : null,
});
const head = {
  project: { id: 'acme/app', owner: 'acme', name: 'app' },
  headSha: 'b'.repeat(40),
  headBranch: 'feature/fix',
  headOwner: 'Alice',
};

/**
 * The registry's two built-in descriptors (priority order, default
 * instances, labels) with fake implementations whose `ownsHost` follows each
 * provider's rule: a GitHub host by name, a GitLab one only as a known origin.
 */
const registryWith = ({ gitlabInstances = [], order = ['github', 'gitlab'], failing = [] } = {}) => {
  const implementations = {
    github: { auth: {
      listInstances: async () => [],
      ownsHost: ({ host, knownInstances }) => (knownInstances.includes(host) ? host : null),
    } },
    gitlab: { auth: {
      listInstances: async () => gitlabInstances,
      ownsHost: ownedOriginInstance,
    } },
  };
  return {
    list: () => order.map((id) => sourceControlProviderDescriptors.get(id)),
    implementation: async (id) => {
      if (failing.includes(id)) throw new Error(`${id} failed to load`);
      return implementations[id] ?? null;
    },
  };
};

const setup = ({ binding, accounts = {}, gitlabInstances = [], order, failing }) => {
  const readChangeRequestHead = vi.fn(async () => head);
  const readCurrentAccountId = vi.fn(async ({ provider, instance }) => accounts[`${provider}:${instance}`] ?? null);
  const resolve = createChangeRequestWorktreeSource({
    readBinding: vi.fn(async () => binding),
    providers: registryWith({ gitlabInstances, order, failing }),
    readCurrentAccountId,
    readChangeRequestHead,
  });
  return { resolve, readChangeRequestHead, readCurrentAccountId };
};

describe('change request source for a worktree made by number', () => {
  it('reads an unbound GitHub project with the current account and its primary remote', async () => {
    const { resolve, readChangeRequestHead } = setup({
      binding: read({ remotes: [remote('upstream', 'https://example.com/x.git'), remote('origin', 'git@github.com:acme/app.git')], revision: 0 }),
      accounts: { 'github:github.com': 'github.com#7' },
    });

    const result = await resolve({ directory: '/repo', number: 42 });

    const context = {
      directory: '/repo', repositoryId: 'repo_one', provider: 'github', instance: 'github.com',
      accountId: 'github.com#7', bindingRevision: 0, primaryRemote: 'origin',
    };
    expect(readChangeRequestHead).toHaveBeenCalledExactlyOnceWith({ context, number: 42 });
    expect(result).toEqual({
      headBranch: 'feature/fix',
      sourceRequest: {
        context, project: head.project, number: 42,
        expectedHeadSha: 'b'.repeat(40), requestedRemoteName: 'pr-alice',
      },
    });
  });

  it('uses a ready bound provider and does not ask for that host\'s current account', async () => {
    const { resolve, readChangeRequestHead, readCurrentAccountId } = setup({
      binding: read({
        remotes: [remote('origin', 'https://github.com/acme/app.git')],
        providers: [{
          provider: 'github', instance: 'github.com', accountId: 'github.com#9', primaryRemote: 'origin',
          readiness: 'ready', endpoint: { fingerprint: 'fp-origin' },
        }],
      }),
      accounts: { 'github:github.com': 'github.com#7' },
    });

    await resolve({ directory: '/repo', number: 42 });

    expect(readCurrentAccountId).not.toHaveBeenCalled();
    expect(readChangeRequestHead.mock.calls[0][0].context).toMatchObject({ accountId: 'github.com#9', bindingRevision: 4 });
  });

  it('prefers the earlier provider in registry order (GitHub over GitLab), as the dialog does', async () => {
    const binding = read({ remotes: [remote('origin', 'https://gitlab.com/acme/app.git'), remote('mirror', 'https://github.com/acme/app.git')] });
    const accounts = { 'gitlab:https://gitlab.com': 'gitlab#1', 'github:github.com': 'github.com#7' };
    const { resolve, readChangeRequestHead } = setup({ binding, accounts });

    await resolve({ directory: '/repo', number: 42 });

    expect(readChangeRequestHead.mock.calls[0][0].context).toMatchObject({ provider: 'github', primaryRemote: 'mirror' });

    // The order is the registry's, not a provider name's.
    const reversed = setup({ binding, accounts, order: ['gitlab', 'github'] });
    await reversed.resolve({ directory: '/repo', number: 42 });
    expect(reversed.readChangeRequestHead.mock.calls[0][0].context).toMatchObject({ provider: 'gitlab', primaryRemote: 'origin' });
  });

  it('reads a merge request on a connected self-hosted GitLab', async () => {
    const { resolve, readChangeRequestHead } = setup({
      binding: read({ remotes: [remote('origin', 'git@gitlab.example.com:team/app.git')] }),
      accounts: { 'gitlab:https://gitlab.example.com': 'https://gitlab.example.com#3' },
      gitlabInstances: ['https://gitlab.example.com'],
    });

    await resolve({ directory: '/repo', number: 7 });

    expect(readChangeRequestHead.mock.calls[0][0]).toMatchObject({
      number: 7,
      context: { provider: 'gitlab', instance: 'https://gitlab.example.com', accountId: 'https://gitlab.example.com#3' },
    });
  });

  it('tells two GitLab instances on one host apart by the remote\'s port', async () => {
    const { resolve, readChangeRequestHead } = setup({
      binding: read({ remotes: [remote('origin', 'https://gitlab.example.com:8443/team/app.git')] }),
      accounts: {
        'gitlab:https://gitlab.example.com': 'https://gitlab.example.com#3',
        'gitlab:https://gitlab.example.com:8443': 'https://gitlab.example.com:8443#4',
      },
      gitlabInstances: ['https://gitlab.example.com', 'https://gitlab.example.com:8443'],
    });

    await resolve({ directory: '/repo', number: 7 });

    expect(readChangeRequestHead.mock.calls[0][0].context)
      .toMatchObject({ instance: 'https://gitlab.example.com:8443', accountId: 'https://gitlab.example.com:8443#4' });
  });

  it('still reads with GitHub when another provider fails to load', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { resolve, readChangeRequestHead } = setup({
      binding: read({ remotes: [remote('origin', 'https://github.com/acme/app.git')] }),
      accounts: { 'github:github.com': 'github.com#7' },
      failing: ['gitlab'],
    });

    await resolve({ directory: '/repo', number: 42 });

    expect(readChangeRequestHead.mock.calls[0][0].context).toMatchObject({ provider: 'github' });
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('refuses a project no connected account can read, before asking any provider', async () => {
    const { resolve, readChangeRequestHead } = setup({
      binding: read({ remotes: [remote('origin', 'https://github.com/acme/app.git')] }),
    });

    await expect(resolve({ directory: '/repo', number: 42 })).rejects.toMatchObject({
      status: 409, code: 'AUTHENTICATION_REQUIRED', message: 'No connected GitHub or GitLab account can read this project',
    });
    expect(readChangeRequestHead).not.toHaveBeenCalled();
  });

  it('passes a provider refusal through unchanged', async () => {
    const gone = Object.assign(new Error('Pull request #42 has no branch to check out: its fork was deleted'), { status: 409 });
    const { resolve, readChangeRequestHead } = setup({
      binding: read({ remotes: [remote('origin', 'https://github.com/acme/app.git')] }),
      accounts: { 'github:github.com': 'github.com#7' },
    });
    readChangeRequestHead.mockRejectedValueOnce(gone);

    await expect(resolve({ directory: '/repo', number: 42 })).rejects.toBe(gone);
  });
});
