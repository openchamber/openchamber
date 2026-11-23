import { create } from 'zustand';

import {
  EMPTY_GUEST_MARK_INDEX,
  joinGuestMarks,
  mayGuestShowMarks,
  type GuestMarkEntry,
  type GuestMarkIndex,
  type GuestMarkPlace,
} from './marks.ts';
import type { InstalledGuest } from './types.ts';

const NO_ENTRIES: readonly GuestMarkEntry[] = [];
const NO_GUESTS: readonly InstalledGuest[] = [];
const NO_PLACES: readonly GuestMarkPlace[] = [];

type GuestMarksState = GuestMarkIndex & {
  runtimeKey: string;
  entries: readonly GuestMarkEntry[];
  guests: readonly InstalledGuest[];
  places: readonly GuestMarkPlace[];
  replaceEntries: (entries: readonly GuestMarkEntry[], runtimeKey: string) => void;
  setGuests: (guests: readonly InstalledGuest[]) => void;
  setPlaces: (places: readonly GuestMarkPlace[]) => void;
  resetForRuntimeSwitch: (runtimeKey: string) => void;
};

const shown = (entries: readonly GuestMarkEntry[], guests: readonly InstalledGuest[]): readonly GuestMarkEntry[] => {
  const showing = new Set(guests.filter(mayGuestShowMarks).map((guest) => guest.id));
  const kept = entries.filter((entry) => showing.has(entry.guestId));
  if (kept.length === entries.length) return entries;
  return kept.length === 0 ? NO_ENTRIES : kept;
};

export const useGuestMarksStore = create<GuestMarksState>((set, get) => {
  const rejoin = (next: { entries?: readonly GuestMarkEntry[]; guests?: readonly InstalledGuest[]; places?: readonly GuestMarkPlace[] }): void => {
    const current = get();
    const guests = next.guests ?? current.guests;
    const places = next.places ?? current.places;
    const entries = shown(next.entries ?? current.entries, guests);
    const index = joinGuestMarks(entries, guests, places, current);
    set({ entries, guests, places, bySession: index.bySession, byFolder: index.byFolder, byBranch: index.byBranch });
  };
  return {
    ...EMPTY_GUEST_MARK_INDEX,
    runtimeKey: '',
    entries: NO_ENTRIES,
    guests: NO_GUESTS,
    places: NO_PLACES,
    replaceEntries: (entries, runtimeKey) => {
      if (get().runtimeKey === runtimeKey) rejoin({ entries });
    },
    setGuests: (guests) => rejoin({ guests }),
    setPlaces: (places) => rejoin({ places }),
    resetForRuntimeSwitch: (runtimeKey) => {
      set({ ...EMPTY_GUEST_MARK_INDEX, runtimeKey, entries: NO_ENTRIES });
    },
  };
});
