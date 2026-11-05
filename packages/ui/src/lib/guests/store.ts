import { create } from 'zustand';

import type { GuestUpdate, InstalledGuest, UnreadableGuest } from './types.ts';
import type { GuestRequestFailure } from './request-failure.ts';

type GuestsStatus = 'idle' | 'loading' | 'ready' | 'error' | 'unsupported';

type GuestsState = {
  status: GuestsStatus;
  failure: GuestRequestFailure | null;
  guests: InstalledGuest[];
  /** Installed rows this build could not read; Settings lists them so they can be removed. */
  unreadable: UnreadableGuest[];
  runtimeKey: string;
  markLoading: () => void;
  replaceCatalog: (guests: InstalledGuest[], runtimeKey: string, unreadable?: UnreadableGuest[]) => void;
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
  unreadable: [],
  runtimeKey: '',
  markLoading: () => {
    if (get().status === 'ready') return;
    set({ status: 'loading', failure: null });
  },
  replaceCatalog: (guests, runtimeKey, unreadable = []) => {
    if (get().runtimeKey !== runtimeKey) return;
    const current = get();
    // The catalog does not carry update offers: one stays while its version does.
    const offered = new Map(current.guests.flatMap((guest) => (guest.update ? [[guest.id, guest] as const] : [])));
    const next = guests.map((guest) => {
      const known = offered.get(guest.id);
      const sameCopy = known?.version === guest.version && known?.source === guest.source
        && JSON.stringify(known?.origin) === JSON.stringify(guest.origin);
      return known?.update && !guest.update && sameCopy ? { ...guest, update: known.update } : guest;
    });
    // Every row in the app reads this list: a reload that found nothing new changes nothing.
    const same = current.status === 'ready' && current.failure === null
      && JSON.stringify(next) === JSON.stringify(current.guests)
      && JSON.stringify(unreadable) === JSON.stringify(current.unreadable);
    if (!same) set({ status: 'ready', guests: next, unreadable, failure: null });
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
    set({ status: 'error', guests: [], unreadable: [], failure: failure ?? null });
  },
  markUnsupported: (runtimeKey) => {
    if (get().runtimeKey !== runtimeKey) return;
    set({ status: 'unsupported', guests: [], unreadable: [], failure: null });
  },
  resetForRuntimeSwitch: (runtimeKey) => {
    set({ status: 'idle', guests: [], unreadable: [], runtimeKey, failure: null });
  },
}));
