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
  /** What the server last listed, less the marks of extensions that lost the right to show any. A failed read keeps it. */
  entries: readonly GuestMarkEntry[];
  /** The catalog and the known folders the lists were joined with. */
  guests: readonly InstalledGuest[];
  places: readonly GuestMarkPlace[];
  /** A read's answer for `runtimeKey`. */
  replaceEntries: (entries: readonly GuestMarkEntry[], runtimeKey: string) => void;
  /** The catalog changed: an extension that may no longer show marks loses the ones held here. */
  setGuests: (guests: readonly InstalledGuest[]) => void;
  /** The known projects or worktrees changed. */
  setPlaces: (places: readonly GuestMarkPlace[]) => void;
  resetForRuntimeSwitch: (runtimeKey: string) => void;
};

const shown = (entries: readonly GuestMarkEntry[], guests: readonly InstalledGuest[]): readonly GuestMarkEntry[] => {
  const showing = new Set(guests.filter(mayGuestShowMarks).map((guest) => guest.id));
  const kept = entries.filter((entry) => showing.has(entry.guestId));
  if (kept.length === entries.length) return entries;
  return kept.length === 0 ? NO_ENTRIES : kept;
};

/**
 * The marks extensions put on sidebar rows, joined with the catalog and the
 * folders this client knows. Rows read one list per key; a list whose content
 * did not change keeps its identity through every update.
 */
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
