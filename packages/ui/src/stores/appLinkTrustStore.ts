import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { createDeferredSafeJSONStorage } from '@/stores/utils/safeStorage';

export const MAX_TRUSTED_SCHEMES = 64;

interface AppLinkTrustState {
  /** Application deep-link schemes (obsidian, vscode, ...) the user chose to always allow. */
  trustedSchemes: string[];
  trustScheme: (scheme: string) => void;
  removeTrustedScheme: (scheme: string) => void;
  isSchemeTrusted: (scheme: string) => boolean;
}

const normalizeScheme = (scheme: string): string => scheme.trim().toLowerCase();

/**
 * Per-device trust for application deep links rendered in chat. Security
 * decisions do not roam, so this persists locally through the shared safe
 * storage rather than server-synced settings.
 */
export const useAppLinkTrustStore = create<AppLinkTrustState>()(
  persist(
    (set, get) => ({
      trustedSchemes: [],
      trustScheme: (scheme) => {
        const normalized = normalizeScheme(scheme);
        if (!normalized) return;
        set((state) => {
          const next = [normalized, ...state.trustedSchemes.filter((entry) => entry !== normalized)];
          return { trustedSchemes: next.slice(0, MAX_TRUSTED_SCHEMES) };
        });
      },
      removeTrustedScheme: (scheme) => {
        const normalized = normalizeScheme(scheme);
        set((state) => ({ trustedSchemes: state.trustedSchemes.filter((entry) => entry !== normalized) }));
      },
      isSchemeTrusted: (scheme) => get().trustedSchemes.includes(normalizeScheme(scheme)),
    }),
    {
      name: 'app-link-trust-store',
      storage: createDeferredSafeJSONStorage(),
      version: 1,
      partialize: (state) => ({ trustedSchemes: state.trustedSchemes }),
    },
  ),
);
