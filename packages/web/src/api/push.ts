import type { PushAPI, PushSubscribePayload, PushUnsubscribePayload } from '@alias-ade/ui/lib/api/types';

const fetchJson = async <T>(input: RequestInfo | URL, init?: RequestInit): Promise<T | null> => {
  try {
    const res = await fetch(input, {
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

  async setVisibility(payload: { visible: boolean }) {
    return fetchJson<{ ok: true }>('/api/push/visibility', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      keepalive: true,
    });
  },
});
