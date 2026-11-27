import { resolveAttachMode, type GuestItem } from '@openchamber/sdk';
import { create } from 'zustand';

import { pluginModeFromId } from '@/lib/surfaces/modes';

import { isMobileSurfaceRuntime } from '@/lib/runtimeSurface';

import { openGuestSurface } from './open-surface.ts';
import { mayGuestShowOnPhone } from './phone.ts';
import { useGuestsStore } from './store.ts';
import type { InstalledGuest } from './types.ts';

type GuestDialogState = {
  request: { guestId: string; item: GuestItem } | null;
  open: (guestId: string, item: GuestItem) => void;
  close: () => void;
};

export const useGuestDialogStore = create<GuestDialogState>((set) => ({
  request: null,
  open: (guestId, item) => set({ request: { guestId, item } }),
  close: () => set({ request: null }),
}));

export const openGuestWithItem = (
  guest: Pick<InstalledGuest, 'id' | 'attach'>,
  item: GuestItem,
  directory: string | null | undefined,
): boolean => {
  const phone = isMobileSurfaceRuntime();
  if (phone) {
    const installed = useGuestsStore.getState().guests.find((candidate) => candidate.id === guest.id);
    if (!installed || !mayGuestShowOnPhone(installed, 'panel')) return false;
  }
  if (resolveAttachMode(guest.attach) === 'dialog') {
    useGuestDialogStore.getState().open(guest.id, item);
    return true;
  }
  return openGuestSurface({
    mode: pluginModeFromId(guest.id), directory: directory ?? null, supported: true, options: { item },
  }).ok;
};
