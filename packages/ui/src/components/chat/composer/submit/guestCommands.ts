
import type { GuestCommandEntry, GuestCommandRoute } from '@/lib/guests/commands';

import { parseSlashCommand } from './slashCommands';

const COMPOSER_LOCAL_COMMAND_NAMES = [
    'init', 'review', 'undo', 'redo', 'timeline', 'compact', 'fork', 'btw', 'summary', 'workspace-review', 'handoff-review',
    'plan-feature', 'craft-goal', 'schedule-task', 'catch-up', 'debug', 'weigh', 'explore',
];

export function reservedComposerCommandNames(openCodeCommands: readonly { name: string }[]): Set<string> {
    const names = new Set<string>(COMPOSER_LOCAL_COMMAND_NAMES);
    for (const command of openCodeCommands) names.add(command.name.toLowerCase());
    return names;
}

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
