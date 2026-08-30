import { create } from 'zustand';
import type { LinearAuthStatus, RuntimeAPIs } from '@/lib/api/types';

type LinearAuthStatusWithError = LinearAuthStatus & { error?: string };

type LinearAuthStore = {
  status: LinearAuthStatusWithError | null;
  isLoading: boolean;
  hasChecked: boolean;
  setStatus: (status: LinearAuthStatusWithError | null) => void;
  refreshStatus: (
    runtimeLinear?: RuntimeAPIs['linear'],
    options?: { force?: boolean }
  ) => Promise<LinearAuthStatusWithError | null>;
};

const fetchStatus = async (
  runtimeLinear?: RuntimeAPIs['linear']
): Promise<LinearAuthStatusWithError> => {
  if (!runtimeLinear) {
    return { connected: false };
  }
  return runtimeLinear.authStatus();
};

let inFlightAuthRefresh: Promise<LinearAuthStatusWithError | null> | null = null;

export const useLinearAuthStore = create<LinearAuthStore>((set, get) => ({
  status: null,
  isLoading: false,
  hasChecked: false,
  setStatus: (status) => set({ status, hasChecked: true }),
  refreshStatus: async (runtimeLinear, options) => {
    if (!runtimeLinear) {
      return get().status;
    }
    const { hasChecked, status } = get();
    if (hasChecked && !options?.force) {
      return status;
    }

    if (inFlightAuthRefresh) return inFlightAuthRefresh;

    set({ isLoading: true });
    inFlightAuthRefresh = (async () => {
      try {
        const payload = await fetchStatus(runtimeLinear);
        set({ status: payload, isLoading: false, hasChecked: true });
        return payload;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // A failed request is not an authoritative disconnect. Keep the last
        // known status and leave `hasChecked` false so the next caller retries
        // instead of hiding Linear for the rest of the session.
        set((state) => ({
          status: state.status
            ? { ...state.status, error: message }
            : { connected: false, error: message },
          isLoading: false,
        }));
        return null;
      }
    })().finally(() => { inFlightAuthRefresh = null; });

    return inFlightAuthRefresh;
  },
}));
