import { afterEach, describe, expect, test } from 'bun:test';
import type { SourceControlAuthStatus } from '@/lib/api/types';
import { GITHUB_SOURCE_CONTROL_IDENTITY } from '@/lib/source-control/identity';
import { getSourceControlAuthKey, useSourceControlAuthStore } from '@/stores/useSourceControlAuthStore';

const inventory: SourceControlAuthStatus = {
  ...GITHUB_SOURCE_CONTROL_IDENTITY,
  status: 'disconnected',
  connected: false,
  accounts: [{
    id: 'account-one',
    credentialId: 'account-one',
    credentialRevision: 1,
    providerUserId: 'github.com#user-one',
    providerUserStatus: 'available',
    user: { ...GITHUB_SOURCE_CONTROL_IDENTITY, id: 'user-one', username: 'retained-user' },
    current: false,
    source: 'oauth',
    status: 'valid',
  }],
};

afterEach(() => useSourceControlAuthStore.getState().resetForRuntimeSwitch());

describe('GitHub settings auth refresh feedback', () => {
  test('failed refresh preserves the inventory and error until a forced retry succeeds', async () => {
    const store = useSourceControlAuthStore.getState();
    const key = getSourceControlAuthKey(GITHUB_SOURCE_CONTROL_IDENTITY);
    store.setStatus(GITHUB_SOURCE_CONTROL_IDENTITY, inventory);
    await store.refreshStatus({ authStatus: async () => { throw new Error('Auth inventory request failed'); } }, GITHUB_SOURCE_CONTROL_IDENTITY, { force: true });

    const failed = useSourceControlAuthStore.getState().entries[key]?.status;
    expect(failed?.status).toBe('unreachable');
    expect(failed?.accounts).toBe(inventory.accounts);
    expect(failed && 'message' in failed ? failed.message : null).toBe('Auth inventory request failed');

    let resolveRetry!: (status: SourceControlAuthStatus) => void;
    const pending = store.refreshStatus({
      authStatus: () => new Promise<SourceControlAuthStatus>((resolve) => { resolveRetry = resolve; }),
    }, GITHUB_SOURCE_CONTROL_IDENTITY, { force: true });
    const refreshing = useSourceControlAuthStore.getState().entries[key];
    expect(refreshing?.isLoading).toBe(true);
    expect(refreshing?.status).toBe(failed);

    resolveRetry(inventory);
    await pending;
    expect(useSourceControlAuthStore.getState().entries[key]?.status).toBe(inventory);
    expect(useSourceControlAuthStore.getState().entries[key]?.isLoading).toBe(false);
  });
});
