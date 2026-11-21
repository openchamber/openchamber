import type { GuestCommandContribution } from '@openchamber/sdk';

import { isGuestActive } from './capabilities.ts';
import type { InstalledGuest } from './types.ts';

export type GuestCommandEntry = {
  guestId: string;
  guestName: string;
  command: GuestCommandContribution;
};

const warned = new Set<string>();

export const guestCommandEntries = (
  guests: readonly InstalledGuest[],
  reservedNames: ReadonlySet<string>,
): GuestCommandEntry[] => {
  const entries: GuestCommandEntry[] = [];
  const taken = new Set<string>();
  for (const guest of guests) {
    if (!isGuestActive(guest) || (!guest.entry && !guest.backgroundEntry) || !guest.commands?.length) continue;
    for (const command of guest.commands) {
      const name = command.name;
      const collides = reservedNames.has(name) || taken.has(name);
      if (collides) {
        const key = `${guest.id}:${name}`;
        if (!warned.has(key)) {
          warned.add(key);
          console.warn(`[guests] Extension "${guest.id}" declared /${name}, which already exists; the extension's command is ignored.`);
        }
        continue;
      }
      taken.add(name);
      entries.push({ guestId: guest.id, guestName: guest.name, command });
    }
  }
  return entries;
};

export type GuestCommandRoute = {
  entry: GuestCommandEntry;
  args: string;
};
