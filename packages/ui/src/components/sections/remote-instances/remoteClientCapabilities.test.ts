import { describe, expect, test } from 'bun:test';
import type { RemoteClientRecord } from '@/lib/api/types';
import { buildRemoteClientCapabilityMutation, canManageRemoteClientCapabilities } from './remoteClientCapabilities';

const client: RemoteClientRecord = {
  id: 'client-1', label: 'Phone', createdAt: '', lastUsedAt: null, revokedAt: null,
  clientKind: 'mobile', capabilities: ['workspace.read', 'workspace.use'],
};

describe('remote client capability controls', () => {
  test('shows controls only for active non-local clients with host-session authorization', () => {
    expect(canManageRemoteClientCapabilities(client, true)).toBe(true);
    expect(canManageRemoteClientCapabilities({ ...client, revokedAt: '2026-01-01T00:00:00Z' }, true)).toBe(false);
    expect(canManageRemoteClientCapabilities({ ...client, clientKind: 'desktop-local' }, true)).toBe(false);
    expect(canManageRemoteClientCapabilities(client, false)).toBe(false);
  });

  test('builds exact grant and revoke payloads', () => {
    expect(buildRemoteClientCapabilityMutation('client-1', 'workspace.admin', true)).toEqual({ id: 'client-1', grant: ['workspace.admin'], revoke: [] });
    expect(buildRemoteClientCapabilityMutation('client-1', 'workspace.use', false)).toEqual({ id: 'client-1', grant: [], revoke: ['workspace.use'] });
  });
});
