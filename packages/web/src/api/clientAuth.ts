import type {
  ClientAuthAPI,
  RemoteClientCreateResult,
  RemoteClientPurgeRevokedResult,
  RemoteClientRecord,
  RemoteClientRevokeResult,
} from '@openchamber/ui/lib/api/types';
import { runtimeFetch } from '@openchamber/ui/lib/runtime-fetch';

const jsonOrNull = async <T>(response: Response): Promise<T | null> => {
  return (await response.json().catch(() => null)) as T | null;
};

export const createWebClientAuthAPI = (): ClientAuthAPI => ({
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
