import { beforeEach, describe, expect, test } from 'bun:test';
import type { ChangeRequestContext, SourceControlIdentity, SourceControlReadContext } from '@/lib/api/types';
import { getChangeRequestContextKey, useChangeRequestContextStore } from './useChangeRequestContextStore';

const identity = { provider: 'gitlab', instance: 'https://gitlab.example.com' } satisfies SourceControlIdentity;
const context = {
  ...identity,
  directory: '/repo',
  repositoryId: 'repo_one',
  accountId: 'account_one',
  bindingRevision: 3,
  primaryRemote: 'origin',
} satisfies SourceControlReadContext;
const result: ChangeRequestContext = {
  identity,
  project: null,
  changeRequest: null,
  issueComments: [],
  reviewComments: [],
  files: [],
};

beforeEach(() => useChangeRequestContextStore.getState().resetForRuntimeSwitch());

describe('change-request context store', () => {
  test('deduplicates a bound account and repository request', async () => {
    let calls = 0;
    const sourceControl = {
      changeRequestContext: async () => {
        calls += 1;
        return result;
      },
    };
    const first = useChangeRequestContextStore.getState().ensure(sourceControl, context, 4, { includeCIDetails: true });
    const second = useChangeRequestContextStore.getState().ensure(sourceControl, context, 4);
    expect(await first).toEqual(result);
    expect(await second).toEqual(result);
    expect(calls).toBe(1);
  });

  test('preserves the cached result when refresh fails', async () => {
    const success = { changeRequestContext: async () => result };
    await useChangeRequestContextStore.getState().ensure(success, context, 4);
    const failure = { changeRequestContext: async (): Promise<ChangeRequestContext> => { throw new Error('offline'); } };
    expect(await useChangeRequestContextStore.getState().ensure(failure, context, 4, { force: true })).toBeNull();
    const entry = useChangeRequestContextStore.getState().entries[getChangeRequestContextKey(context, 4)];
    expect(entry?.result).toEqual(result);
    expect(entry?.error).toBe('offline');
  });

  test('invalidates only the requested provider instance and directory', async () => {
    const sourceControl = { changeRequestContext: async () => result };
    await useChangeRequestContextStore.getState().ensure(sourceControl, context, 4);
    const other = { provider: 'gitlab', instance: 'https://other.example.com' } satisfies SourceControlIdentity;
    const otherContext = { ...context, ...other, accountId: 'account_two' };
    await useChangeRequestContextStore.getState().ensure(sourceControl, otherContext, 4);
    useChangeRequestContextStore.getState().invalidate(context);
    expect(useChangeRequestContextStore.getState().entries[getChangeRequestContextKey(context, 4)]).toBe(undefined);
    expect(useChangeRequestContextStore.getState().entries[getChangeRequestContextKey(otherContext, 4)]?.result).toEqual(result);
  });

  test('isolates entries by account, repository, binding revision, and primary remote', () => {
    const base = getChangeRequestContextKey(context, 4);
    expect(getChangeRequestContextKey({ ...context, accountId: 'account_two' }, 4)).not.toBe(base);
    expect(getChangeRequestContextKey({ ...context, repositoryId: 'repo_two' }, 4)).not.toBe(base);
    expect(getChangeRequestContextKey({ ...context, bindingRevision: 4 }, 4)).not.toBe(base);
    expect(getChangeRequestContextKey({ ...context, primaryRemote: 'upstream' }, 4)).not.toBe(base);
    expect(getChangeRequestContextKey(context, 4, { owner: 'fork', name: 'repo' })).not.toBe(base);
  });

  test('rejects an older forced completion for the same bound context', async () => {
    let resolveOlder!: (value: ChangeRequestContext) => void;
    const older = new Promise<ChangeRequestContext>((resolve) => { resolveOlder = resolve; });
    const newerResult = { ...result, fetchedAt: 2 };
    const olderRequest = useChangeRequestContextStore.getState().ensure(
      { changeRequestContext: async () => older }, context, 4, { force: true },
    );
    const newerRequest = useChangeRequestContextStore.getState().ensure(
      { changeRequestContext: async () => newerResult }, context, 4, { force: true },
    );

    expect(await newerRequest).toEqual(newerResult);
    resolveOlder({ ...result, fetchedAt: 1 });
    expect(await olderRequest).toBeNull();
    expect(useChangeRequestContextStore.getState().entries[getChangeRequestContextKey(context, 4)]?.result).toEqual(newerResult);
  });

  test('does not restore an invalidated in-flight result', async () => {
    let resolveRequest!: (value: ChangeRequestContext) => void;
    const pending = new Promise<ChangeRequestContext>((resolve) => { resolveRequest = resolve; });
    const request = useChangeRequestContextStore.getState().ensure(
      { changeRequestContext: async () => pending }, context, 4,
    );

    useChangeRequestContextStore.getState().invalidate(context);
    resolveRequest(result);

    expect(await request).toBeNull();
    expect(useChangeRequestContextStore.getState().entries[getChangeRequestContextKey(context, 4)]).toBe(undefined);
  });

  test('bounds failed entries while retaining the latest requested context', async () => {
    const failure = { changeRequestContext: async (): Promise<ChangeRequestContext> => { throw new Error('offline'); } };
    for (let number = 1; number <= 100; number += 1) {
      await useChangeRequestContextStore.getState().ensure(failure, context, number);
    }

    const entries = useChangeRequestContextStore.getState().entries;
    expect(Object.keys(entries)).toHaveLength(20);
    expect(entries[getChangeRequestContextKey(context, 100)]?.error).toBe('offline');
  });
});
