import { create } from 'zustand';
import { opencodeClient } from '@/lib/opencode/client';
import { runtimeFetch } from '@/lib/runtime-fetch';

// Mirror the yolo flag to the server so the notification runtime silences
// ALL trigger paths (completion, error, question, permission) at the source.
// Also persists the value in OpenChamber settings for durability.
// Throws on failure so the caller can revert UI state and surface the error.
const mirrorYoloToServer = async (enabled: boolean): Promise<void> => {
  const res = await runtimeFetch('/api/notifications/yolo-suppress', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  if (!res.ok) {
    throw new Error(`Server returned ${res.status}`);
  }
};

type YoloState = {
  enabled: boolean;
  loading: boolean;
  saving: boolean;
  lastError: string | null;
  refresh: () => Promise<void>;
  setEnabled: (enabled: boolean) => Promise<void>;
};

export const useYoloStore = create<YoloState>((set) => ({
  enabled: false,
  loading: false,
  saving: false,
  lastError: null,
  refresh: async () => {
    // Dedup: two YoloStatusPill instances both call refresh() on mount.
    if (useYoloStore.getState().loading) return;
    set({ loading: true, lastError: null });
    try {
      // Source of truth is the OpenChamber server (persisted in settings).
      const res = await runtimeFetch('/api/notifications/yolo-suppress');
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
      const data = await res.json();
      const enabled = data?.enabled === true;
      set({ enabled, loading: false });

      // Best-effort: sync OpenCode config to match. If the server silently
      // drops the yolo field (documented SDK gap), the toggle stays checked
      // because server-side suppression is already armed.
      if (enabled) {
        void opencodeClient.setYolo(true).catch(() => {});
      }
    } catch (error) {
      set({
        loading: false,
        lastError: error instanceof Error ? error.message : String(error),
      });
    }
  },
  setEnabled: async (enabled: boolean) => {
    set({ saving: true, lastError: null });
    try {
      // Arm server suppression FIRST — before the OpenCode config round-trip.
      // If this fails, don't update local state — the UI stays off.
      await mirrorYoloToServer(enabled);
      set({ enabled });
      await opencodeClient.setYolo(enabled);
      set({ saving: false });
      // If setYolo fails, do NOT revert suppression. The flag was already
      // armed via mirrorYoloToServer AND persisted to OpenChamber settings.
      // Suppressing too aggressively is safer than leaking a notification.
    } catch (error) {
      set({
        saving: false,
        lastError: error instanceof Error ? error.message : String(error),
      });
    }
  },
}));
