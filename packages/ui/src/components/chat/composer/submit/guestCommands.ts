/**
 * Slash commands contributed by installed extensions. They never reach the
 * model: the composer asks the extension to resolve `/name args` into a chip
 * and attaches that instead. Planned before local commands so an extension
 * name the composer already uses can never take over (`guestCommandEntries`
 * already dropped those).
 */

import type { GuestCommandEntry, GuestCommandRoute } from '@/lib/guests/commands';

import { parseSlashCommand } from './slashCommands';

/**
 * Whether the composer text is one of the guest commands. Only normal input
 * routes here; shell mode never does. The match is on the first word after
 * the slash, the rest is the argument string handed to the guest as typed.
 */
export function routeGuestSlashCommand(
    text: string,
    inputMode: 'normal' | 'shell' | undefined,
    entries: readonly GuestCommandEntry[],
): GuestCommandRoute | null {
    if (inputMode !== 'normal' || entries.length === 0) return null;
    const parsed = parseSlashCommand(text);
    if (!parsed) return null;
    const entry = entries.find((candidate) => candidate.command.name === parsed.name);
    return entry ? { entry, args: parsed.argument } : null;
}
