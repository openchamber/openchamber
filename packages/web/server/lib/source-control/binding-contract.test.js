import { describe, expect, it } from 'vitest';
import { parseBinding, parseBindingStore } from './binding-contract.js';

const binding = (provider, instance) => ({
  repositoryId: 'repo_one',
  revision: 1,
  state: 'bound',
  configRevision: 'config_one',
  providers: [{
    provider,
    instance,
    accountId: 'account_one',
    primaryRemote: 'origin',
    readiness: 'ready',
    endpoint: { displayUrl: 'https://example.com/repo.git', fingerprint: 'fetch' },
  }],
  remotes: [{
    name: 'origin',
    fetch: { displayUrl: 'https://example.com/repo.git', fingerprint: 'fetch' },
    push: { displayUrl: 'https://example.com/repo.git', fingerprint: 'push' },
    mode: 'system',
    readiness: 'ready',
  }],
  auxiliary: [],
});

describe('source-control binding contract', () => {
  it('accepts a gitea provider entry', () => {
    const parsed = parseBinding(binding('gitea', 'https://example.com'));
    expect(parsed.providers[0]).toMatchObject({ provider: 'gitea', instance: 'https://example.com' });
  });

  it('rejects a provider the registry does not know', () => {
    expect(() => parseBinding(binding('bitbucket', 'https://example.com'))).toThrow();
  });

  it('reads a store that carries a provider this build has no module for', () => {
    const stored = { version: 2, repositories: { repo_one: { revision: 1, binding: binding('gitea', 'https://example.com') } } };
    expect(parseBindingStore(stored).repositories.repo_one.binding.providers[0].provider).toBe('gitea');
  });
});
