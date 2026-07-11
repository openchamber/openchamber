import { create } from 'zustand';

/**
 * Transient Ctrl+X leader-key pending state (OpenCode-style chords).
 * Kept in a narrow store so arming/clearing does not fan out through useUIStore.
 */
type LeaderKeyStore = {
  pending: boolean;
  expiresAt: number | null;
  arm: (durationMs?: number) => number;
  clear: () => void;
};

export const LEADER_KEY_TIMEOUT_MS = 2000;

export const useLeaderKeyStore = create<LeaderKeyStore>((set, get) => ({
  pending: false,
  expiresAt: null,
  // Arm the leader chord window; returns the expiry timestamp for the caller's timeout.
  arm: (durationMs = LEADER_KEY_TIMEOUT_MS) => {
    const expiresAt = Date.now() + durationMs;
    set({ pending: true, expiresAt });
    return expiresAt;
  },
  clear: () => {
    if (!get().pending && get().expiresAt === null) {
      return;
    }
    set({ pending: false, expiresAt: null });
  },
}));
