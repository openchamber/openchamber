import type { RemoteClientCapability, RemoteClientRecord } from '@/lib/api/types';

export const canManageRemoteClientCapabilities = (client: RemoteClientRecord, hostSessionAuthorized: boolean): boolean => (
  hostSessionAuthorized && !client.revokedAt && client.clientKind !== 'desktop-local'
);

export const buildRemoteClientCapabilityMutation = (
  clientId: string,
  capability: RemoteClientCapability,
  grant: boolean,
) => ({
  id: clientId,
  grant: grant ? [capability] : [],
  revoke: grant ? [] : [capability],
});
