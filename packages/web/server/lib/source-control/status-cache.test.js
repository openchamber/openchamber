import { describe, expect, it } from 'vitest';
import { createChangeRequestStatusCache } from './status-cache.js';

const context = (overrides = {}) => ({
  instance: 'https://gitlab.example.com', accountId: 'acct', credentialRevision: 1,
  repositoryId: 'repo_one', bindingRevision: 2, directory: '/repo', branch: 'feature', remote: 'origin',
  ...overrides,
});

describe('createChangeRequestStatusCache', () => {
  it('answers a fresh repeat, keeps the last answer past the TTL, and stamps fetchedAt', () => {
    let clock = 1_000;
    const cache = createChangeRequestStatusCache({ ttlMs: 100, now: () => clock });
    cache.store(context(), { branch: 'feature' });
    expect(cache.fresh(context())).toEqual({ branch: 'feature', fetchedAt: 1_000 });
    clock = 1_150;
    expect(cache.fresh(context())).toBeNull();
    expect(cache.last(context())).toEqual({ branch: 'feature', fetchedAt: 1_000 });
  });

  it('never answers a different credential revision or binding revision', () => {
    const cache = createChangeRequestStatusCache({ ttlMs: 100 });
    cache.store(context(), { branch: 'feature' });
    expect(cache.last(context({ credentialRevision: 2 }))).toBeNull();
    expect(cache.last(context({ bindingRevision: 3 }))).toBeNull();
  });

  it('drops a repository after a mutation and an account after invalidation, leaving others', () => {
    const cache = createChangeRequestStatusCache({ ttlMs: 100 });
    cache.store(context(), { branch: 'feature' });
    cache.store(context({ repositoryId: 'repo_two' }), { branch: 'feature' });
    cache.store(context({ accountId: 'other' }), { branch: 'feature' });
    cache.invalidate({ instance: 'https://gitlab.example.com', accountId: 'acct', repositoryId: 'repo_one' });
    expect(cache.last(context())).toBeNull();
    expect(cache.last(context({ repositoryId: 'repo_two' }))).not.toBeNull();
    cache.invalidate({ instance: 'https://gitlab.example.com', accountId: 'acct' });
    expect(cache.last(context({ repositoryId: 'repo_two' }))).toBeNull();
    expect(cache.last(context({ accountId: 'other' }))).not.toBeNull();
  });

  it('evicts the oldest entry at capacity', () => {
    const cache = createChangeRequestStatusCache({ ttlMs: 100, maxEntries: 2 });
    cache.store(context({ branch: 'a' }), {});
    cache.store(context({ branch: 'b' }), {});
    cache.store(context({ branch: 'c' }), {});
    expect(cache.last(context({ branch: 'a' }))).toBeNull();
    expect(cache.last(context({ branch: 'c' }))).not.toBeNull();
  });
});
