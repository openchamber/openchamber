import { create } from 'zustand';
import type { GitLabAuthStatus, RuntimeAPIs } from '@/lib/api/types';
import { runtimeFetch } from '@/lib/runtime-fetch';

type GitLabAuthStatusWithError = GitLabAuthStatus & { error?: string };

type GitLabAuthStore = {
  status: GitLabAuthStatusWithError | null;
  isLoading: boolean;
  hasChecked: boolean;
  setStatus: (status: GitLabAuthStatusWithError | null) => void;
  refreshStatus: (
    runtimeGitLab?: RuntimeAPIs['gitlab'],
    options?: { force?: boolean }
  ) => Promise<GitLabAuthStatusWithError | null>;
};

const fetchStatus = async (
  runtimeGitLab?: RuntimeAPIs['gitlab']
): Promise<GitLabAuthStatusWithError> => {
  if (runtimeGitLab) {
    const payload = await runtimeGitLab.authStatus();
    return payload as GitLabAuthStatus;
  }

  const response = await runtimeFetch('/api/gitlab/auth/status', {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
  const payload = (await response.json().catch(() => null)) as GitLabAuthStatusWithError | null;
  if (!response.ok || !payload) {
    throw new Error(payload?.error || response.statusText || 'Failed to load GitLab status');
  }
  return payload;
};

// In-flight dedup for refreshStatus
let _inFlightAuthRefresh: Promise<GitLabAuthStatusWithError | null> | null = null;

export const useGitLabAuthStore = create<GitLabAuthStore>((set, get) => ({
  status: null,
  isLoading: false,
  hasChecked: false,
  setStatus: (status) => set({ status, hasChecked: true }),
  refreshStatus: async (runtimeGitLab, options) => {
    const { hasChecked, status } = get();
    if (hasChecked && !options?.force) {
      return status;
    }

    if (_inFlightAuthRefresh) return _inFlightAuthRefresh;

    set({ isLoading: true });
    _inFlightAuthRefresh = (async () => {
      try {
        const payload = await fetchStatus(runtimeGitLab);
        set({ status: payload, isLoading: false, hasChecked: true });
        return payload;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        set({
          status: { connected: false, accounts: [], defaultBaseUrl: '', error: message },
          isLoading: false,
          hasChecked: true,
        });
        return null;
      }
    })().finally(() => { _inFlightAuthRefresh = null; });

    return _inFlightAuthRefresh;
  },
}));
