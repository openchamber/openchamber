import { create } from 'zustand';
import type { GiteaAuthStatus, RuntimeAPIs } from '@/lib/api/types';
import { runtimeFetch } from '@/lib/runtime-fetch';

type GiteaAuthStatusWithError = GiteaAuthStatus & { error?: string };

type GiteaAuthStore = {
  status: GiteaAuthStatusWithError | null;
  isLoading: boolean;
  hasChecked: boolean;
  setStatus: (status: GiteaAuthStatusWithError | null) => void;
  refreshStatus: (
    runtimeGitea?: RuntimeAPIs['gitea'],
    options?: { force?: boolean }
  ) => Promise<GiteaAuthStatusWithError | null>;
};

const fetchStatus = async (
  runtimeGitea?: RuntimeAPIs['gitea']
): Promise<GiteaAuthStatusWithError> => {
  if (runtimeGitea) {
    const payload = await runtimeGitea.authStatus();
    return payload as GiteaAuthStatus;
  }

  const response = await runtimeFetch('/api/gitea/auth/status', {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
  const payload = (await response.json().catch(() => null)) as GiteaAuthStatusWithError | null;
  if (!response.ok || !payload) {
    throw new Error(payload?.error || response.statusText || 'Failed to load Gitea status');
  }
  return payload;
};

// In-flight dedup for refreshStatus
let _inFlightAuthRefresh: Promise<GiteaAuthStatusWithError | null> | null = null;

export const useGiteaAuthStore = create<GiteaAuthStore>((set, get) => ({
  status: null,
  isLoading: false,
  hasChecked: false,
  setStatus: (status) => set({ status, hasChecked: true }),
  refreshStatus: async (runtimeGitea, options) => {
    const { hasChecked, status } = get();
    if (hasChecked && !options?.force) {
      return status;
    }

    if (_inFlightAuthRefresh) return _inFlightAuthRefresh;

    set({ isLoading: true });
    _inFlightAuthRefresh = (async () => {
      try {
        const payload = await fetchStatus(runtimeGitea);
        set({ status: payload, isLoading: false, hasChecked: true });
        return payload;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        set({
          status: { connected: false, accounts: [], error: message },
          isLoading: false,
          hasChecked: true,
        });
        return null;
      }
    })().finally(() => { _inFlightAuthRefresh = null; });

    return _inFlightAuthRefresh;
  },
}));
