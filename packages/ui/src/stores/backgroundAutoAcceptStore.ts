import { create } from 'zustand';
import { runtimeFetch } from '@/lib/runtime-fetch';
import type { PermissionAutoAcceptMap } from './utils/permissionAutoAccept';

type BackgroundAutoAcceptStore = {
  enabled: boolean | null;
  loading: boolean;
  saving: boolean;
  hydrate: () => Promise<void>;
  setEnabled: (enabled: boolean, policies: PermissionAutoAcceptMap, directories: string[]) => Promise<void>;
  setSessionPolicy: (sessionId: string, enabled: boolean, directory?: string) => Promise<boolean>;
  applyEnabled: (enabled: boolean) => void;
  reset: () => void;
};

const readEnabled = async (response: Response): Promise<boolean> => {
  if (!response.ok) throw new Error(`Background auto-accept request failed (${response.status})`);
  const payload = await response.json() as { enabled?: unknown };
  if (typeof payload.enabled !== 'boolean') throw new Error('Invalid background auto-accept response');
  return payload.enabled;
};

export const useBackgroundAutoAcceptStore = create<BackgroundAutoAcceptStore>((set) => ({
  enabled: null,
  loading: false,
  saving: false,

  hydrate: async () => {
    set({ loading: true });
    try {
      const response = await runtimeFetch('/api/background-auto-accept');
      set({ enabled: await readEnabled(response) });
    } finally {
      set({ loading: false });
    }
  },

  setEnabled: async (enabled, policies, directories) => {
    set({ saving: true });
    try {
      const response = await runtimeFetch('/api/background-auto-accept', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(enabled ? { enabled, policies, directories } : { enabled }),
      });
      set({ enabled: await readEnabled(response) });
    } finally {
      set({ saving: false });
    }
  },

  setSessionPolicy: async (sessionId, enabled, directory) => {
    const response = await runtimeFetch(`/api/background-auto-accept/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled, directory }),
    });
    if (response.status === 409) {
      set({ enabled: false });
      return false;
    }
    await readEnabled(response);
    return true;
  },

  applyEnabled: (enabled) => set({ enabled }),
  reset: () => set({ enabled: null, loading: false, saving: false }),
}));
