import { GUEST_REQUEST_TIMEOUT_MS } from '@openchamber/sdk';
import { create } from 'zustand';

import type { GuestCommandRoute } from './commands.ts';
import { getGuestResolver, waitForGuestResolver, type GuestResolveOutcome } from './resolve.ts';

/**
 * Which guest `GuestHosts` keeps mounted off-screen so a slash command can be
 * answered while that guest's panel is closed. One at a time; the frame goes
 * away as soon as the command has an outcome.
 */
type GuestResolveHostState = {
  guestId: string | null;
  mount: (guestId: string) => void;
  unmount: (guestId: string) => void;
};

export const useGuestResolveHostStore = create<GuestResolveHostState>((set, get) => ({
  guestId: null,
  mount: (guestId) => set({ guestId }),
  unmount: (guestId) => {
    if (get().guestId === guestId) set({ guestId: null });
  },
}));

/**
 * Ask the guest behind `route` to turn `/name args` into a chip. Uses the
 * rail pane when it is up; otherwise mounts a hidden pane for the call and
 * unmounts it after. A guest that never connects is `unavailable`, not a
 * silent null.
 */
export const runGuestCommand = async (route: GuestCommandRoute): Promise<GuestResolveOutcome> => {
  const { guestId } = route.entry;
  let resolver = getGuestResolver(guestId);
  let mounted = false;
  if (!resolver) {
    useGuestResolveHostStore.getState().mount(guestId);
    mounted = true;
    resolver = await waitForGuestResolver(guestId, GUEST_REQUEST_TIMEOUT_MS);
  }
  try {
    if (!resolver) {
      return { ok: false, reason: 'unavailable' };
    }
    return await resolver({ command: route.entry.command.name, args: route.args });
  } finally {
    if (mounted) useGuestResolveHostStore.getState().unmount(guestId);
  }
};
