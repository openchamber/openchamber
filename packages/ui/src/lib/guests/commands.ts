import type { GuestCommandContribution } from '@openchamber/sdk';

import { isGuestActive } from './capabilities.ts';
import type { InstalledGuest } from './types.ts';

export type GuestCommandEntry = {
  guestId: string;
  guestName: string;
  command: GuestCommandContribution;
};

const warned = new Set<string>();

/**
 * The slash commands active guests contribute, in catalog order. A name the
 * composer already knows (a local command, an OpenCode command, or a skill)
 * or one an earlier guest already took is dropped with a console warning,
 * once per name, so an extension can never shadow what the user has.
 */
export const guestCommandEntries = (
  guests: readonly InstalledGuest[],
  reservedNames: ReadonlySet<string>,
): GuestCommandEntry[] => {
  const entries: GuestCommandEntry[] = [];
  const taken = new Set<string>();
  for (const guest of guests) {
    if (!isGuestActive(guest) || !guest.commands?.length) continue;
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

/** A composer submission that matched one of the guest commands. */
export type GuestCommandRoute = {
  entry: GuestCommandEntry;
  args: string;
};
