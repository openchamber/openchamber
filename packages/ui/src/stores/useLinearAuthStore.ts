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
  /**
   * Linear is authenticated on the OpenChamber instance, not in the browser, so
   * this status belongs to whichever instance is connected. Switching instances
   * must drop it — otherwise the previous instance's login stays on screen and
   * its issue surfaces remain usable against a runtime that has no Linear at all.
   */
  resetForRuntimeSwitch: () => void;
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
// Bumped by every reset so a response already in flight for the previous
// instance cannot write itself into the new instance's status.
let authGeneration = 0;

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

    const generation = authGeneration;
    set({ isLoading: true });
    inFlightAuthRefresh = (async () => {
      try {
        const payload = await fetchStatus(runtimeLinear);
        if (generation !== authGeneration) return null;
        set({ status: payload, isLoading: false, hasChecked: true });
        return payload;
      } catch (error) {
        if (generation !== authGeneration) return null;
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
  resetForRuntimeSwitch: () => {
    authGeneration += 1;
    inFlightAuthRefresh = null;
    set({ status: null, isLoading: false, hasChecked: false });
  },
}));
