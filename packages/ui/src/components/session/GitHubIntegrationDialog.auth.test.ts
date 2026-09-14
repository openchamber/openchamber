import { describe, expect, test } from 'bun:test';
import type { SourceControlAuthStatus, SourceControlReadContext } from '@/lib/api/types';
import { getSourceControlReadContextAuthState } from '@/stores/useSourceControlAuthStore';

const context: SourceControlReadContext = {
  provider: 'github',
  instance: 'https://github.com',
  accountId: 'bound-account',
  repositoryId: 'repository',
  bindingRevision: 1,
  directory: '/project',
  primaryRemote: 'origin',
};
const inventory: SourceControlAuthStatus = {
  provider: context.provider,
  instance: context.instance,
  status: 'disconnected',
  connected: false,
  accounts: [{
    id: context.accountId,
    credentialId: context.accountId,
    credentialRevision: 1,
    providerUserId: 'github.com#user-one',
    providerUserStatus: 'available',
    user: { provider: context.provider, instance: context.instance, id: 'user-one', username: 'bound-user' },
    current: false,
    source: 'oauth',
    status: 'valid',
  }],
};

describe('bound read-context auth eligibility', () => {
  test('permits a valid bound credential in a successful disconnected inventory', () => {
    expect(getSourceControlReadContextAuthState({ status: inventory, isLoading: false, hasChecked: true }, context))
      .toEqual({ authChecked: true, connected: true });
  });

  for (const status of ['unreachable', 'temporarily-unavailable'] as const) {
    test(`${status} inventory cannot authorize a retained valid account`, () => {
      expect(getSourceControlReadContextAuthState({ status: { ...inventory, status }, isLoading: false, hasChecked: true }, context))
        .toEqual({ authChecked: true, connected: false });
      expect(getSourceControlReadContextAuthState({ status: { ...inventory, status }, isLoading: true, hasChecked: true }, context).connected)
        .toBe(false);
    });
  }

  test('requires checked inventory and the exact bound account', () => {
    expect(getSourceControlReadContextAuthState({ status: inventory, isLoading: false, hasChecked: false }, context).connected).toBe(false);
    expect(getSourceControlReadContextAuthState(undefined, context).connected).toBe(false);
    expect(getSourceControlReadContextAuthState({ status: inventory, isLoading: false, hasChecked: true }, { ...context, accountId: 'other-account' }).connected).toBe(false);
  });
});
