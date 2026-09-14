import { describe, expect, test } from 'bun:test';
import type { SourceControlBindingRead } from '@/lib/api/types';
import { RepositoryBindingOwner } from './repository-binding';

const endpoint = { displayUrl: 'https://github.com/team/repo', fingerprint: 'fetch' };
const repository = { repositoryId: 'repo', configRevision: 'config', bare: false,
  remotes: [{ name: 'origin', fetch: endpoint, push: endpoint }] };
const missing = (revision = 0): SourceControlBindingRead => ({ status: 'missing', repository, revision, binding: null });
const bound = (revision = 1, accountId = 'account'): SourceControlBindingRead => ({
  status: 'bound', repository, revision,
  binding: { repositoryId: 'repo', configRevision: 'config', revision, state: 'bound',
    providers: [{ provider: 'github', instance: 'github.com', accountId, primaryRemote: 'origin', readiness: 'ready', endpoint }],
    remotes: [], auxiliary: [],
  },
});
const deferred = () => {
  let resolve!: (read: SourceControlBindingRead) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<SourceControlBindingRead>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

describe('repository binding authority', () => {
  test('a partial binding publishes only ready provider contexts at the new CAS revision', async () => {
    const owner = new RepositoryBindingOwner(() => 'runtime');
    const scope = owner.scope('/repo');
    const initial = bound();
    if (!initial.binding) throw new Error('fixture binding required');
    const read: SourceControlBindingRead = { ...initial, status: 'needs-attention', revision: 2, binding: {
      ...initial.binding, revision: 2, state: 'needs-attention', providers: [
        { ...initial.binding.providers[0], readiness: 'account-unavailable' },
        { ...initial.binding.providers[0], accountId: 'sibling-account' },
      ],
    } };
    const snapshot = await owner.read(scope, { repositoryBinding: async () => read });
    expect(snapshot.status).toBe('ready');
    expect(snapshot.read).toBe(read);
    expect(snapshot.contexts.map((context) => [context.accountId, context.bindingRevision])).toEqual([['sibling-account', 2]]);
  });
  test('deferred initial failure settles as retryable error, not loading or successful empty', async () => {
    const owner = new RepositoryBindingOwner(() => 'runtime');
    const scope = owner.scope('/repo');
    const response = deferred();
    const error = Object.assign(new Error('offline'), { code: 'NETWORK' });
    const pending = owner.read(scope, { repositoryBinding: () => response.promise });
    expect(owner.snapshot(scope).status).toBe('loading');
    response.reject(error);
    const failed = await pending;
    expect(failed.status).toBe('error');
    expect(failed.error).toBe(error);
    expect(failed.read).toBeNull();
    expect(failed.contexts).toEqual([]);
    const empty = await owner.reconcile(scope, { repositoryBinding: async () => missing() });
    expect(empty.status).toBe('ready');
    expect(empty.read?.status).toBe('missing');
    expect(empty.error).toBeNull();
  });

  test('failed refresh retains the complete snapshot as stale but grants no read authority', async () => {
    const owner = new RepositoryBindingOwner(() => 'runtime');
    const scope = owner.scope('/repo');
    const previous = bound();
    await owner.read(scope, { repositoryBinding: async () => previous });
    const response = deferred();
    const pending = owner.read(scope, { repositoryBinding: () => response.promise }, true);
    expect(owner.snapshot(scope).read).toBe(previous);
    expect(owner.snapshot(scope).contexts).toEqual([]);
    response.reject(new Error('unavailable'));
    await pending;
    expect(owner.snapshot(scope).read).toBe(previous);
    expect(owner.snapshot(scope).status).toBe('error');
    const empty = await owner.reconcile(scope, { repositoryBinding: async () => missing(2) });
    expect(empty.read?.binding).toBeNull();
    expect(empty.contexts).toEqual([]);
  });

  test('100 concurrent consumers share one request and warm snapshot reads perform no operations', async () => {
    const owner = new RepositoryBindingOwner(() => 'runtime');
    const scope = owner.scope('/repo');
    const response = deferred();
    let requests = 0;
    let notifications = 0;
    const api = { repositoryBinding: () => { requests += 1; return response.promise; } };
    const releases = Array.from({ length: 100 }, () => owner.subscribe(scope, () => { notifications += 1; }));
    const pending = Array.from({ length: 100 }, () => owner.read(scope, api));
    expect(new Set(pending).size).toBe(1);
    response.resolve(bound());
    await Promise.all(pending);
    expect(requests).toBe(1);
    expect(notifications).toBe(200);
    const snapshot = owner.snapshot(scope);
    for (let index = 0; index < 10_000; index += 1) expect(owner.snapshot(scope)).toBe(snapshot);
    await Promise.all(Array.from({ length: 100 }, () => owner.read(scope, api)));
    expect(requests).toBe(1);
    expect(notifications).toBe(200);
    releases.forEach((release) => release());
  });

  test('a loading subscriber joins the request even when it requests a forced read synchronously', async () => {
    const owner = new RepositoryBindingOwner(() => 'runtime');
    const scope = owner.scope('/repo');
    let requests = 0;
    const api = { repositoryBinding: async () => { requests += 1; return bound(); } };
    let joined: ReturnType<typeof owner.read> | undefined;
    const release = owner.subscribe(scope, () => {
      if (owner.snapshot(scope).status === 'loading') joined = owner.read(scope, api, true);
    });
    const pending = owner.read(scope, api);
    expect(joined).toBe(pending);
    await pending;
    expect(requests).toBe(1);
    release();
  });

  test('mutation result wins an in-flight read, including removal and a late failed read', async () => {
    for (const outcome of ['success', 'failure'] as const) {
      const owner = new RepositoryBindingOwner(() => 'runtime');
      const scope = owner.scope('/repo');
      const previous = bound();
      await owner.read(scope, { repositoryBinding: async () => previous });
      const response = deferred();
      const pending = owner.read(scope, { repositoryBinding: () => response.promise }, true);
      const removed = missing(2);
      expect(owner.setMutationResult(owner.captureMutation(scope, previous), removed)).toBe(true);
      if (outcome === 'success') response.resolve(previous);
      else response.reject(new Error('old error'));
      expect((await pending).read).toBe(removed);
      expect(owner.snapshot(scope).status).toBe('ready');
      expect(owner.snapshot(scope).contexts).toEqual([]);
    }
  });

  test('known worktrees and first in-flight worktree reads converge to the mutation revision', async () => {
    const owner = new RepositoryBindingOwner(() => 'runtime');
    const scopes = ['/repo', '/worktree', '/mounting'].map((directory) => owner.scope(directory));
    const previous = bound();
    await owner.read(scopes[0], { repositoryBinding: async () => previous });
    await owner.read(scopes[1], { repositoryBinding: async () => previous });
    const response = deferred();
    const pending = owner.read(scopes[2], { repositoryBinding: () => response.promise });
    const next = bound(2, 'new-account');
    owner.setMutationResult(owner.captureMutation(scopes[0], previous), next);
    response.resolve(previous);
    await pending;
    for (const scope of scopes) {
      expect(owner.snapshot(scope).read).toBe(next);
      expect(owner.snapshot(scope).contexts[0]).toEqual({ directory: scope.directory, bindingRevision: 2, accountId: 'new-account',
        repositoryId: 'repo', provider: 'github', instance: 'github.com', primaryRemote: 'origin' });
    }
  });

  test('setter rejects another repository, non-advancing revisions and old scope generations', async () => {
    const owner = new RepositoryBindingOwner(() => 'runtime');
    const scope = owner.scope('/repo');
    const previous = bound();
    await owner.read(scope, { repositoryBinding: async () => previous });
    const mutation = owner.captureMutation(scope, previous);
    expect(owner.setMutationResult(mutation, previous)).toBe(false);
    expect(owner.setMutationResult(mutation, { ...missing(2), repository: { ...repository, repositoryId: 'other' } })).toBe(false);
    owner.reset();
    await owner.read(owner.scope('/repo'), { repositoryBinding: async () => previous });
    expect(owner.setMutationResult(mutation, bound(2))).toBe(false);
    expect(owner.snapshot(owner.scope('/repo')).read).toBe(previous);
  });

  test('newer mutation completions cannot regress when an older result arrives last', async () => {
    const owner = new RepositoryBindingOwner(() => 'runtime');
    const scope = owner.scope('/repo');
    const previous = bound();
    await owner.read(scope, { repositoryBinding: async () => previous });
    const mutation = owner.captureMutation(scope, previous);
    const newest = bound(3);
    owner.setMutationResult(mutation, newest);
    owner.setMutationResult(mutation, bound(2));
    expect(owner.snapshot(scope).read).toBe(newest);
  });

  test('directory and runtime switches reject obsolete completions without clearing unrelated complete scopes', async () => {
    let runtime = 'a';
    const owner = new RepositoryBindingOwner(() => runtime);
    const oldScope = owner.scope('/repo');
    const response = deferred();
    const pending = owner.read(oldScope, { repositoryBinding: () => response.promise });
    const other = owner.scope('/other');
    await owner.read(other, { repositoryBinding: async () => ({ ...missing(), repository: { ...repository, repositoryId: 'other' } }) });
    expect(owner.snapshot(other).status).toBe('ready');
    runtime = 'b';
    owner.reset();
    const nextScope = owner.scope('/repo');
    const next = bound(1, 'runtime-b');
    await owner.read(nextScope, { repositoryBinding: async () => next });
    response.resolve(bound(10, 'runtime-a'));
    expect((await pending).status).toBe('idle');
    expect(owner.snapshot(oldScope).read).toBeNull();
    expect(owner.snapshot(nextScope).read).toBe(next);
  });

  test('conflict refresh waits out an older read and refreshes all mounted aliases without retrying a write', async () => {
    const owner = new RepositoryBindingOwner(() => 'runtime');
    const scope = owner.scope('/repo');
    const alias = owner.scope('/alias');
    const previous = bound();
    await owner.read(scope, { repositoryBinding: async () => previous });
    await owner.read(alias, { repositoryBinding: async () => previous });
    const response = deferred();
    const pending = owner.read(scope, { repositoryBinding: () => response.promise }, true);
    const next = bound(4);
    let reads = 0;
    const api = { repositoryBinding: async () => { reads += 1; return next; } };
    const retries = [owner.reconcile(scope, api), owner.reconcile(scope, api)];
    expect(reads).toBe(0);
    response.resolve(previous);
    await pending;
    await Promise.all(retries);
    expect(reads).toBe(1);
    expect(owner.snapshot(scope).read).toBe(next);
    expect(owner.snapshot(alias).read).toBe(next);
  });

  test('active scopes can exceed retention, and only idle scopes are evicted after release', async () => {
    const owner = new RepositoryBindingOwner(() => 'runtime', 2);
    let reads = 0;
    const api = { repositoryBinding: async () => { reads += 1; return missing(); } };
    const scopes = Array.from({ length: 100 }, (_, index) => owner.scope(`/repo-${index}`));
    const releases = scopes.map((scope) => owner.subscribe(scope, () => {}));
    await Promise.all(scopes.map((scope) => owner.read(scope, api)));
    await new Promise((resolve) => setTimeout(resolve, 10));
    for (const scope of scopes) expect(owner.snapshot(scope).status).toBe('ready');
    expect(reads).toBe(100);
    releases.forEach((release) => release());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(scopes.filter((scope) => owner.snapshot(scope).status === 'stale')).toHaveLength(2);
  });

  test('last release marks complete data stale and remount deduplicates its refresh', async () => {
    const owner = new RepositoryBindingOwner(() => 'runtime');
    const scope = owner.scope('/repo');
    const release = owner.subscribe(scope, () => {});
    const previous = bound();
    await owner.read(scope, { repositoryBinding: async () => previous });
    release();
    expect(owner.snapshot(scope).status).toBe('stale');
    expect(owner.snapshot(scope).read).toBe(previous);
    const releases = [owner.subscribe(scope, () => {}), owner.subscribe(scope, () => {})];
    let requests = 0;
    const api = { repositoryBinding: async () => { requests += 1; return bound(2); } };
    await Promise.all([owner.read(scope, api), owner.read(scope, api)]);
    expect(requests).toBe(1);
    expect(owner.snapshot(scope).status).toBe('ready');
    releases.forEach((dispose) => dispose());
  });

  test('pending mutation pins a released scope until its explicit release', async () => {
    const owner = new RepositoryBindingOwner(() => 'runtime', 0);
    const scope = owner.scope('/repo');
    const release = owner.subscribe(scope, () => {});
    const previous = bound();
    await owner.read(scope, { repositoryBinding: async () => previous });
    const mutation = owner.captureMutation(scope, previous);
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(owner.snapshot(scope).read).toBe(previous);
    expect(owner.setMutationResult(mutation, bound(2))).toBe(true);
    mutation.release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(owner.snapshot(scope).status).toBe('idle');
  });
});
