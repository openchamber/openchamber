import { describe, expect, test } from 'bun:test';

import type { GuestCommandEntry } from '@/lib/guests/commands';

import { reservedComposerCommandNames, routeGuestSlashCommand } from '../guestCommands';

const entries: GuestCommandEntry[] = [
    { guestId: 'tasks-demo', guestName: 'Tasks Demo', command: { name: 'task', description: 'Attach a task' } },
    { guestId: 'other', guestName: 'Other', command: { name: 'pr' } },
];

describe('routeGuestSlashCommand', () => {
    test('routes a guest command with its argument as typed', () => {
        expect(routeGuestSlashCommand('/task DEMO-1 please', 'normal', entries)).toEqual({
            entry: entries[0],
            args: 'DEMO-1 please',
        });
        expect(routeGuestSlashCommand('  /pr', 'normal', entries)).toEqual({ entry: entries[1], args: '' });
        expect(routeGuestSlashCommand('/Task x', 'normal', entries)?.entry.guestId).toBe('tasks-demo');
    });

    test('leaves everything else to the composer', () => {
        expect(routeGuestSlashCommand('/summary', 'normal', entries)).toBeNull();
        expect(routeGuestSlashCommand('task DEMO-1', 'normal', entries)).toBeNull();
        expect(routeGuestSlashCommand('/task', 'shell', entries)).toBeNull();
        expect(routeGuestSlashCommand('/task', 'normal', [])).toBeNull();
        expect(routeGuestSlashCommand('', 'normal', entries)).toBeNull();
    });
});

describe('reservedComposerCommandNames', () => {
    test('holds the composer commands and the OpenCode commands, lowercased', () => {
        const names = reservedComposerCommandNames([{ name: 'Deploy' }]);
        expect(names.has('deploy')).toBe(true);
        expect(names.has('summary')).toBe(true);
        expect(names.has('btw')).toBe(true);
        expect(names.has('task')).toBe(false);
    });
});
