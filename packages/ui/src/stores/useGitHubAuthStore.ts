import { create } from 'zustand';
import type { GitHubAuthStatus, RuntimeAPIs } from '@/lib/api/types';
import { runtimeFetch } from '@/lib/runtime-fetch';

type GitHubAuthStatusWithError = GitHubAuthStatus & { error?: string };

type GitHubAuthStore = {
  status: GitHubAuthStatusWithError | null;
  isLoading: boolean;
  hasChecked: boolean;
  setStatus: (status: GitHubAuthStatusWithError | null) => void;
  refreshStatus: (
    runtimeGitHub?: RuntimeAPIs['github'],
    options?: { force?: boolean }
  ) => Promise<GitHubAuthStatusWithError | null>;
  /** Same instance-scoping as Linear: the login lives on the connected instance. */
  resetForRuntimeSwitch: () => void;
};

const fetchStatus = async (
  runtimeGitHub?: RuntimeAPIs['github']
): Promise<GitHubAuthStatusWithError> => {
  if (runtimeGitHub) {
    const payload = await runtimeGitHub.authStatus();
    return payload as GitHubAuthStatus;
  }

  const response = await runtimeFetch('/api/github/auth/status', {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
  const payload = (await response.json().catch(() => null)) as GitHubAuthStatusWithError | null;
  if (!response.ok || !payload) {
    throw new Error(payload?.error || response.statusText || 'Failed to load GitHub status');
  }
  return payload;
};

// In-flight dedup for refreshStatus
let _inFlightAuthRefresh: Promise<GitHubAuthStatusWithError | null> | null = null;
// Bumped by every reset so a response already in flight for the previous
// instance cannot write itself into the new instance's status.
let authGeneration = 0;

export const useGitHubAuthStore = create<GitHubAuthStore>((set, get) => ({
  status: null,
  isLoading: false,
  hasChecked: false,
  setStatus: (status) => set({ status, hasChecked: true }),
  refreshStatus: async (runtimeGitHub, options) => {
    const { hasChecked, status } = get();
    if (hasChecked && !options?.force) {
      return status;
    }

    if (_inFlightAuthRefresh) return _inFlightAuthRefresh;

    const generation = authGeneration;
    set({ isLoading: true });
    _inFlightAuthRefresh = (async () => {
      try {
        const payload = await fetchStatus(runtimeGitHub);
        if (generation !== authGeneration) return null;
        set({ status: payload, isLoading: false, hasChecked: true });
        return payload;
      } catch (error) {
        if (generation !== authGeneration) return null;
        const message = error instanceof Error ? error.message : String(error);
        set({
          status: { connected: false, error: message },
          isLoading: false,
          hasChecked: true,
        });
        return null;
      }
    })().finally(() => { _inFlightAuthRefresh = null; });

    return _inFlightAuthRefresh;
  },
  resetForRuntimeSwitch: () => {
    authGeneration += 1;
    _inFlightAuthRefresh = null;
    set({ status: null, isLoading: false, hasChecked: false });
  },
}));
