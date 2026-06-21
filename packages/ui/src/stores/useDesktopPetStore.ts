import { create } from 'zustand';
import { canUseElectronDesktopIPC, invokeDesktop } from '@/lib/desktop';

// Narrow store mirroring the desktop pet's persisted state (`settings.json`
// `desktopPet`). It exists so the main renderer can REACTIVELY gate `usePetSync`
// on whether the pet is enabled — per the perf rule, the producer must not
// subscribe to live session state unless the feature is actually on.
//
// Source of truth is the Electron settings file; this store is a mirror. It is
// hydrated once over IPC and kept in sync by the `openchamber:pet-window-state`
// event the main process emits on every pet mutation (Settings toggle, native
// menu, restore-on-launch). Mutations here are optimistic and reconciled by that
// event, so the toggle feels instant while staying authoritative.

type PetWindowStatePayload = {
  enabled?: boolean;
  selectedSlug?: string;
};

interface DesktopPetStore {
  enabled: boolean;
  selectedSlug: string;
  /** Merge an authoritative payload (hydrate result or main-process event). */
  apply: (next: PetWindowStatePayload) => void;
  hydrate: () => Promise<void>;
  setEnabled: (enabled: boolean) => Promise<void>;
  selectPet: (slug: string) => Promise<void>;
}

export const useDesktopPetStore = create<DesktopPetStore>((set, get) => ({
  enabled: false,
  selectedSlug: '',
  apply: (next) =>
    set((prev) => ({
      enabled: typeof next.enabled === 'boolean' ? next.enabled : prev.enabled,
      selectedSlug: typeof next.selectedSlug === 'string' ? next.selectedSlug : prev.selectedSlug,
    })),
  hydrate: async () => {
    if (!canUseElectronDesktopIPC()) return;
    try {
      const state = await invokeDesktop<PetWindowStatePayload | null>('desktop_get_pet_window_state');
      if (state) get().apply(state);
    } catch {
      // Best-effort: leave the pet inert until we learn the real state.
    }
  },
  setEnabled: async (enabled) => {
    if (!canUseElectronDesktopIPC()) return;
    // Optimistic so the producer (de)activates immediately; the main process
    // echoes the authoritative state back over the pet-window-state event.
    get().apply({ enabled });
    try {
      await invokeDesktop(enabled ? 'desktop_open_pet_window' : 'desktop_close_pet_window');
    } catch {
      void get().hydrate();
    }
  },
  selectPet: async (slug) => {
    if (!canUseElectronDesktopIPC()) return;
    get().apply({ selectedSlug: slug });
    try {
      await invokeDesktop('desktop_set_pet', { slug });
    } catch {
      void get().hydrate();
    }
  },
}));
