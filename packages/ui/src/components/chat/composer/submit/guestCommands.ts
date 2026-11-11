/**
 * Slash commands contributed by installed extensions. They never reach the
 * model: the composer asks the extension to resolve `/name args` into a chip
 * and attaches that instead. Planned before local commands so an extension
 * name the composer already uses can never take over (`guestCommandEntries`
 * already dropped those).
 */

import type { GuestCommandEntry, GuestCommandRoute } from '@/lib/guests/commands';

import { parseSlashCommand } from './slashCommands';

// Every name the composer runs itself; an extension command with one of
// these names is dropped before it reaches a list.
const COMPOSER_LOCAL_COMMAND_NAMES = [
    'init', 'review', 'undo', 'redo', 'timeline', 'compact', 'fork', 'btw', 'summary', 'workspace-review', 'handoff-review',
    'plan-feature', 'craft-goal', 'schedule-task', 'catch-up', 'debug', 'weigh', 'explore',
];

/**
 * The names an extension command may not take on web and desktop: the
 * composer's own commands and the OpenCode commands of its directory. The
 * slash menu and the command palette read one list through this.
 */
export function reservedComposerCommandNames(openCodeCommands: readonly { name: string }[]): Set<string> {
    const names = new Set<string>(COMPOSER_LOCAL_COMMAND_NAMES);
    for (const command of openCodeCommands) names.add(command.name.toLowerCase());
    return names;
}

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
