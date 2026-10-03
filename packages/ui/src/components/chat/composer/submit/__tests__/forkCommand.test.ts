import { describe, expect, test } from 'bun:test';

import type { ChatDraftIdentity } from '@/lib/chatDraftPersistence';
import type { Session } from '@/lib/opencode/model';

import { runForkCommand, type ForkCommandDeps } from '../forkCommand';

const forked: Session = {
    id: 'session-fork',
    projectID: 'project-a',
    directory: '/repo',
    title: 'Fork',
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 },
};
const selection = { providerID: 'p', modelID: 'm', agent: 'build' };

function createDeps(overrides: Partial<ForkCommandDeps> = {}) {
    const sends: Array<{ text: string; sessionId: string; directory?: string }> = [];
    const restores: Array<{ target: ChatDraftIdentity; text: string }> = [];
    const deps: ForkCommandDeps = {
        fork: async () => forked,
        directoryFor: (session) => session.directory,
        send: async (text, _selection, target) => {
            sends.push({ text, ...target });
        },
        draftIdentity: (directory, sessionId) => (directory ? { runtimeKey: 'rt', directory, sessionId } : null),
        restoreText: (target, text) => {
            restores.push({ target, text });
        },
        ...overrides,
    };
    return { deps, sends, restores };
}

describe('runForkCommand', () => {
    test('sends the text into the fork, not the source session', async () => {
        const { deps, sends } = createDeps();
        expect(await runForkCommand('session-a', '  try again  ', selection, deps)).toBe('sent');
        expect(sends).toEqual([{ text: 'try again', sessionId: 'session-fork', directory: '/repo' }]);
    });

    test('a bare /fork only opens the fork', async () => {
        const { deps, sends } = createDeps();
        expect(await runForkCommand('session-a', '', selection, deps)).toBe('forked');
        expect(sends).toEqual([]);
    });

    test('a failed fork throws and sends nothing', async () => {
        const { deps, sends } = createDeps({ fork: async () => { throw new Error('boom'); } });
        await expect(runForkCommand('session-a', 'text', selection, deps)).rejects.toThrow('boom');
        expect(sends).toEqual([]);
    });

    test('a failed send puts the text into the fork composer', async () => {
        const { deps, restores } = createDeps({ send: async () => { throw new Error('offline'); } });
        expect(await runForkCommand('session-a', 'text', selection, deps)).toBe('send-failed');
        expect(restores).toEqual([{ target: { runtimeKey: 'rt', directory: '/repo', sessionId: 'session-fork' }, text: 'text' }]);
    });

    test('a runtime switch mid-fork stops before sending', async () => {
        const { deps, sends } = createDeps({ fork: async () => null });
        expect(await runForkCommand('session-a', 'text', selection, deps)).toBe('stale');
        expect(sends).toEqual([]);
    });
});
