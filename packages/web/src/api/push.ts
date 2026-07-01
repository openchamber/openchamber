import type { ApnsTokenPayload, PushAPI, PushSubscribePayload, PushUnsubscribePayload } from '@openchamber/ui/lib/api/types';
import { runtimeFetch } from '@openchamber/ui/lib/runtime-fetch';

const fetchJson = async <T>(input: string | URL | Request, init?: RequestInit): Promise<T | null> => {
  try {
    const res = await runtimeFetch(input, {
      ...init,
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        ...(init?.headers ?? {}),
      },
    });

    if (!res.ok) {
      return null;
    }

    return (await res.json()) as T;
  } catch {
    return null;
  }
};

export const createWebPushAPI = (): PushAPI => ({
  async getVapidPublicKey() {
    return fetchJson<{ publicKey: string }>('/api/push/vapid-public-key');
  },

  async subscribe(payload: PushSubscribePayload) {
    return fetchJson<{ ok: true }>('/api/push/subscribe', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  },

  async unsubscribe(payload: PushUnsubscribePayload) {
    return fetchJson<{ ok: true }>('/api/push/subscribe', {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  },

  async setVisibility(payload: { visible: boolean; platform?: string }) {
    return fetchJson<{ ok: true }>('/api/push/visibility', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      keepalive: true,
    });
  },

  async registerApnsToken(payload: ApnsTokenPayload) {
    return fetchJson<{ ok: true }>('/api/push/apns-token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  },

  async unregisterApnsToken(payload: ApnsTokenPayload) {
    return fetchJson<{ ok: true }>('/api/push/apns-token', {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  },
});
