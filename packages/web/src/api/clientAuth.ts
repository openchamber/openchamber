import type {
  ClientAuthAPI,
  PairingSessionCreateResult,
  PendingPairingRecord,
  RemoteClientCreateResult,
  RemoteClientPurgeRevokedResult,
  RemoteClientRecord,
  RemoteClientCapability,
  RemoteClientRevokeResult,
} from '@openchamber/ui/lib/api/types';
import { runtimeFetch } from '@openchamber/ui/lib/runtime-fetch';
import { requestReauthProof } from './reauth';

const jsonOrNull = async <T>(response: Response): Promise<T | null> => {
  return (await response.json().catch(() => null)) as T | null;
};

export const createWebClientAuthAPI = (): ClientAuthAPI => ({
  reauthenticate: requestReauthProof,

  async canManageCapabilities(): Promise<boolean> {
    const response = await runtimeFetch('/api/host-admin/status', { method: 'GET', headers: { Accept: 'application/json' } });
    return response.ok;
  },
  async listClients(): Promise<RemoteClientRecord[]> {
    const response = await runtimeFetch('/api/client-auth/clients', {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    const payload = await jsonOrNull<{ clients?: RemoteClientRecord[]; error?: string }>(response);
    if (!response.ok || !payload) {
      throw new Error(payload?.error || response.statusText || 'Failed to load remote clients');
    }
    return Array.isArray(payload.clients) ? payload.clients : [];
  },

  async createClient(input = {}): Promise<RemoteClientCreateResult> {
    const response = await runtimeFetch('/api/client-auth/clients', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ label: input.label ?? '' }),
    });
    const payload = await jsonOrNull<RemoteClientCreateResult & { error?: string }>(response);
    if (!response.ok || !payload?.client || typeof payload.token !== 'string') {
      throw new Error(payload?.error || response.statusText || 'Failed to create remote client token');
    }
    return payload;
  },

  async createPairingSession(input = {}): Promise<PairingSessionCreateResult> {
    const response = await runtimeFetch('/api/client-auth/pairing/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        label: input.label ?? '',
        ...(input.allowedClientKinds ? { allowedClientKinds: input.allowedClientKinds } : {}),
        ...(input.serverUrl ? { serverUrl: input.serverUrl } : {}),
        ...(typeof input.includeRelay === 'boolean' ? { includeRelay: input.includeRelay } : {}),
        ...(typeof input.includeDirect === 'boolean' ? { includeDirect: input.includeDirect } : {}),
      }),
    });
    const payload = await jsonOrNull<PairingSessionCreateResult & { error?: string }>(response);
    if (!response.ok || typeof payload?.pairing?.secret !== 'string' || !payload?.server) {
      throw new Error(payload?.error || response.statusText || 'Failed to create pairing session');
    }
    return payload;
  },

  async listPendingPairings(): Promise<PendingPairingRecord[]> {
    const response = await runtimeFetch('/api/client-auth/pairing/sessions', {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    const payload = await jsonOrNull<{ pending?: PendingPairingRecord[]; error?: string }>(response);
    if (!response.ok || !payload) {
      throw new Error(payload?.error || response.statusText || 'Failed to load pending pairings');
    }
    return Array.isArray(payload.pending) ? payload.pending : [];
  },

  async getPairingTransports(): Promise<{ local: string | null; lan: string | null; relayAvailable: boolean }> {
    const response = await runtimeFetch('/api/client-auth/pairing/transports', {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    const payload = await jsonOrNull<{ local?: string | null; lan?: string | null; relayAvailable?: boolean; error?: string }>(response);
    if (!response.ok || !payload) {
      throw new Error(payload?.error || response.statusText || 'Failed to load pairing transports');
    }
    return { local: payload.local ?? null, lan: payload.lan ?? null, relayAvailable: payload.relayAvailable !== false };
  },

  async cancelPairing(id: string): Promise<{ cancelled: boolean }> {
    const response = await runtimeFetch(`/api/client-auth/pairing/sessions/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { Accept: 'application/json' },
    });
    const payload = await jsonOrNull<{ cancelled?: boolean; error?: string }>(response);
    if (!response.ok || !payload) {
      throw new Error(payload?.error || response.statusText || 'Failed to cancel pairing');
    }
    return { cancelled: payload.cancelled === true };
  },

  async revokeClient(id: string): Promise<RemoteClientRevokeResult> {
    const response = await runtimeFetch(`/api/client-auth/clients/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { Accept: 'application/json' },
    });
    const payload = await jsonOrNull<RemoteClientRevokeResult & { error?: string }>(response);
    if (!response.ok || !payload) {
      throw new Error(payload?.error || response.statusText || 'Failed to revoke remote client');
    }
    return payload;
  },

  async updateClientCapabilities(id: string, input: { grant?: RemoteClientCapability[]; revoke?: RemoteClientCapability[]; reauthProof?: string; reauthNonce?: string }) {
    const response = await runtimeFetch(`/api/host-admin/clients/${encodeURIComponent(id)}/capabilities`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(input.reauthProof && input.reauthNonce ? {
          'X-OpenChamber-Reauth-Proof': input.reauthProof,
          'X-OpenChamber-Reauth-Nonce': input.reauthNonce,
        } : {}),
      },
      body: JSON.stringify({ grant: input.grant ?? [], revoke: input.revoke ?? [] }),
    });
    const payload = await jsonOrNull<{ updated?: boolean; client?: RemoteClientRecord; error?: string }>(response);
    if (!response.ok || !payload) throw new Error(payload?.error || response.statusText || 'Failed to update client capabilities');
    return { updated: payload.updated === true, client: payload.client };
  },

  async purgeRevokedClients(): Promise<RemoteClientPurgeRevokedResult> {
    const response = await runtimeFetch('/api/client-auth/clients', {
      method: 'DELETE',
      headers: { Accept: 'application/json' },
    });
    const payload = await jsonOrNull<RemoteClientPurgeRevokedResult & { error?: string }>(response);
    if (!response.ok || !payload) {
      throw new Error(payload?.error || response.statusText || 'Failed to clear revoked clients');
    }
    return payload;
  },
});
