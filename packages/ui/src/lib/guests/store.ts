import { create } from 'zustand';

import type { GuestUpdate, InstalledGuest } from './types.ts';
import type { GuestRequestFailure } from './request-failure.ts';

type GuestsStatus = 'idle' | 'loading' | 'ready' | 'error' | 'unsupported';

type GuestsState = {
  status: GuestsStatus;
  failure: GuestRequestFailure | null;
  guests: InstalledGuest[];
  runtimeKey: string;
  markLoading: () => void;
  replaceCatalog: (guests: InstalledGuest[], runtimeKey: string) => void;
  /** Overlay a fresh server update check: listed guests get `update`, every other guest loses it. */
  applyUpdates: (updates: Record<string, GuestUpdate>, runtimeKey: string) => void;
  markFailed: (runtimeKey: string, failure?: GuestRequestFailure) => void;
  markUnsupported: (runtimeKey: string) => void;
  resetForRuntimeSwitch: (runtimeKey: string) => void;
};

export const useGuestsStore = create<GuestsState>((set, get) => ({
  status: 'idle',
  failure: null,
  guests: [],
  runtimeKey: '',
  markLoading: () => {
    if (get().status === 'ready') return;
    set({ status: 'loading', failure: null });
  },
  replaceCatalog: (guests, runtimeKey) => {
    if (get().runtimeKey !== runtimeKey) return;
    set({ status: 'ready', guests, failure: null });
  },
  applyUpdates: (updates, runtimeKey) => {
    if (get().runtimeKey !== runtimeKey) return;
    let changed = false;
    const guests = get().guests.map((guest) => {
      const next = updates[guest.id];
      if (next && guest.update?.version === next.version) return guest;
      if (!next && !guest.update) return guest;
      changed = true;
      if (!next) {
        const rest = { ...guest };
        delete rest.update;
        return rest;
      }
      return { ...guest, update: next };
    });
    if (changed) set({ guests });
  },
  markFailed: (runtimeKey, failure) => {
    if (get().runtimeKey !== runtimeKey) return;
    if (get().status === 'ready') {
      set({ failure: failure ?? null });
      return;
    }
    set({ status: 'error', guests: [], failure: failure ?? null });
  },
  markUnsupported: (runtimeKey) => {
    if (get().runtimeKey !== runtimeKey) return;
    set({ status: 'unsupported', guests: [], failure: null });
  },
  resetForRuntimeSwitch: (runtimeKey) => {
    set({ status: 'idle', guests: [], runtimeKey, failure: null });
  },
}));
