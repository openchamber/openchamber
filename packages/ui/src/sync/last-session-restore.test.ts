import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { clearLastActiveSession, persistLastActiveSession, readLastActiveSession } from './last-session-cache';
import { beginLastSessionRestore, restoreLastActiveSession } from './last-session-restore';
import { useSessionUIStore } from './session-ui-store';

const session = (id: string): Session => ({
    id,
    projectID: 'project',
    directory: '/repo',
    title: id,
    time: { created: 1, updated: 1 },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
});

const originalSetCurrentSession = useSessionUIStore.getState().setCurrentSession;
let selected: Array<{ id: string | null; directory: string | null | undefined }> = [];

beforeEach(() => {
    selected = [];
    useSessionUIStore.setState({
        currentSessionId: null,
        setCurrentSession: (id, directory) => { selected.push({ id, directory }); },
    });
    useGlobalSessionsStore.setState({
        hasLoaded: true,
        status: 'ready',
        activeSessions: [session('ses_open'), session('ses_other')],
        archivedSessions: [],
    });
    clearLastActiveSession(getRuntimeKey());
});

afterEach(() => {
    useSessionUIStore.setState({ setCurrentSession: originalSetCurrentSession, currentSessionId: null, currentSessionDirectory: null });
    clearLastActiveSession(getRuntimeKey());
});

describe('restoreLastActiveSession', () => {
    test('reopens exactly the session left open', async () => {
        persistLastActiveSession(getRuntimeKey(), { sessionId: 'ses_open', directory: '/repo' });

        expect(await restoreLastActiveSession({ refresh: false })).toBe('restored');
        expect(selected).toEqual([{ id: 'ses_open', directory: '/repo' }]);
    });

    test('leaves the launch alone without a pointer', async () => {
        expect(await restoreLastActiveSession({ refresh: false })).toBe('none');
        expect(selected).toEqual([]);
    });

    test('does not replace a session a link already opened', async () => {
        persistLastActiveSession(getRuntimeKey(), { sessionId: 'ses_open', directory: '/repo' });
        useSessionUIStore.setState({ currentSessionId: 'ses_other' });

        expect(await restoreLastActiveSession({ refresh: false })).toBe('none');
        expect(selected).toEqual([]);
    });

    test('drops the pointer to a session that no longer exists', async () => {
        persistLastActiveSession(getRuntimeKey(), { sessionId: 'ses_deleted', directory: '/repo' });

        expect(await restoreLastActiveSession({ refresh: false })).toBe('none');
        expect(selected).toEqual([]);
        expect(readLastActiveSession(getRuntimeKey())).toBeNull();
    });

    test('keeps the pointer and reports failure when the session list could not be read', async () => {
        persistLastActiveSession(getRuntimeKey(), { sessionId: 'ses_open', directory: '/repo' });
        // Cold start: OpenCode is not ready, so the load falls back to what the
        // store holds and marks it as an error instead of rejecting.
        const originalLoadSessions = useGlobalSessionsStore.getState().loadSessions;
        useGlobalSessionsStore.setState({
            hasLoaded: false,
            status: 'idle',
            activeSessions: [],
            loadSessions: async () => {
                useGlobalSessionsStore.setState({ status: 'error' });
                return { activeSessions: [], archivedSessions: [] };
            },
        });
        try {
            expect(await restoreLastActiveSession({ refresh: false })).toBe('failed');
            expect(selected).toEqual([]);
            expect(readLastActiveSession(getRuntimeKey())?.sessionId).toBe('ses_open');

            // Once OpenCode is ready the retry finds the session.
            useGlobalSessionsStore.setState({
                loadSessions: async () => {
                    useGlobalSessionsStore.setState({ hasLoaded: true, status: 'ready', activeSessions: [session('ses_open')] });
                    return { activeSessions: [session('ses_open')], archivedSessions: [] };
                },
            });
            expect(await restoreLastActiveSession({ refresh: false })).toBe('restored');
            expect(selected).toEqual([{ id: 'ses_open', directory: '/repo' }]);
        } finally {
            useGlobalSessionsStore.setState({ loadSessions: originalLoadSessions });
        }
    });

    test('a failed refresh after an earlier load is not authoritative either', async () => {
        persistLastActiveSession(getRuntimeKey(), { sessionId: 'ses_open', directory: '/repo' });
        const originalLoadSessions = useGlobalSessionsStore.getState().loadSessions;
        useGlobalSessionsStore.setState({
            loadSessions: async () => {
                useGlobalSessionsStore.setState({ status: 'error', activeSessions: [] });
                return { activeSessions: [], archivedSessions: [] };
            },
        });
        try {
            expect(await restoreLastActiveSession({ refresh: true })).toBe('failed');
            expect(readLastActiveSession(getRuntimeKey())?.sessionId).toBe('ses_open');
        } finally {
            useGlobalSessionsStore.setState({ loadSessions: originalLoadSessions });
        }
    });
});

describe('beginLastSessionRestore', () => {
    // Selection here moves the store, as the real action does, so "the user
    // opened something else" can be told apart from "still on the restored one".
    beforeEach(() => {
        useSessionUIStore.setState({
            setCurrentSession: (id, directory) => {
                selected.push({ id, directory });
                useSessionUIStore.setState({ currentSessionId: id, currentSessionDirectory: id ? directory ?? null : null });
            },
        });
    });

    const holdSessionList = () => {
        const original = useGlobalSessionsStore.getState().loadSessions;
        let loads = 0;
        let answer: (sessions: Session[] | null) => void = () => undefined;
        useGlobalSessionsStore.setState({
            hasLoaded: false,
            status: 'idle',
            loadSessions: () => {
                loads += 1;
                return new Promise((resolve) => {
                    answer = (sessions) => {
                        if (sessions === null) {
                            useGlobalSessionsStore.setState({ status: 'error' });
                            resolve({ activeSessions: [], archivedSessions: [] });
                            return;
                        }
                        useGlobalSessionsStore.setState({ hasLoaded: true, status: 'ready', activeSessions: sessions });
                        resolve({ activeSessions: sessions, archivedSessions: [] });
                    };
                });
            },
        });
        return {
            loads: () => loads,
            answer: (sessions: Session[] | null) => answer(sessions),
            restore: () => useGlobalSessionsStore.setState({ loadSessions: original }),
        };
    };

    test('opens the last session at once, without waiting for the session list', async () => {
        persistLastActiveSession(getRuntimeKey(), { sessionId: 'ses_open', directory: '/repo' });
        const list = holdSessionList();
        try {
            const attempt = beginLastSessionRestore({ selectNow: true });
            // Selected synchronously, before the list was even asked for.
            expect(selected).toEqual([{ id: 'ses_open', directory: '/repo' }]);
            expect(list.loads()).toBe(0);

            const result = attempt();
            list.answer([session('ses_open')]);
            expect(await result).toBe('restored');
            expect(selected).toEqual([{ id: 'ses_open', directory: '/repo' }]);
            expect(readLastActiveSession(getRuntimeKey())?.sessionId).toBe('ses_open');
        } finally {
            list.restore();
        }
    });

    test('takes the directory from the persisted session list when the pointer has none', () => {
        persistLastActiveSession(getRuntimeKey(), { sessionId: 'ses_open', directory: null });
        const original = useGlobalSessionsStore.getState().entityById;
        useGlobalSessionsStore.setState({ entityById: new Map([['ses_open', session('ses_open')]]) });
        try {
            beginLastSessionRestore({ selectNow: true });
            expect(selected).toEqual([{ id: 'ses_open', directory: '/repo' }]);
        } finally {
            useGlobalSessionsStore.setState({ entityById: original });
        }
    });

    test('waits for the session list when the directory is unknown', async () => {
        persistLastActiveSession(getRuntimeKey(), { sessionId: 'ses_open', directory: null });
        const original = useGlobalSessionsStore.getState().entityById;
        useGlobalSessionsStore.setState({ entityById: new Map() });
        const list = holdSessionList();
        try {
            const attempt = beginLastSessionRestore({ selectNow: true });
            expect(selected).toEqual([]);
            const result = attempt();
            list.answer([session('ses_open')]);
            expect(await result).toBe('restored');
            expect(selected).toEqual([{ id: 'ses_open', directory: '/repo' }]);
        } finally {
            list.restore();
            useGlobalSessionsStore.setState({ entityById: original });
        }
    });

    test('leaves the launch to a route that names a session', () => {
        persistLastActiveSession(getRuntimeKey(), { sessionId: 'ses_open', directory: '/repo' });
        beginLastSessionRestore({ selectNow: false });
        expect(selected).toEqual([]);
    });

    test('falls back to the draft and drops the pointer when the list says the session is gone', async () => {
        persistLastActiveSession(getRuntimeKey(), { sessionId: 'ses_deleted', directory: '/repo' });
        const list = holdSessionList();
        try {
            const attempt = beginLastSessionRestore({ selectNow: true });
            expect(useSessionUIStore.getState().currentSessionId).toBe('ses_deleted');

            // OpenCode still starting: the list proves nothing, nothing changes.
            const early = attempt();
            list.answer(null);
            expect(await early).toBe('failed');
            expect(useSessionUIStore.getState().currentSessionId).toBe('ses_deleted');
            expect(readLastActiveSession(getRuntimeKey())?.sessionId).toBe('ses_deleted');

            const result = attempt();
            list.answer([session('ses_other')]);
            expect(await result).toBe('none');
            expect(useSessionUIStore.getState().currentSessionId).toBeNull();
            expect(readLastActiveSession(getRuntimeKey())).toBeNull();
        } finally {
            list.restore();
        }
    });

    test('keeps what the user opened meanwhile when the reopened session turns out gone', async () => {
        persistLastActiveSession(getRuntimeKey(), { sessionId: 'ses_deleted', directory: '/repo' });
        const list = holdSessionList();
        try {
            const attempt = beginLastSessionRestore({ selectNow: true });
            const result = attempt();
            // The user clicks another session while the list loads; selecting
            // it moves the pointer, as setCurrentSession does.
            useSessionUIStore.getState().setCurrentSession('ses_other', '/repo');
            persistLastActiveSession(getRuntimeKey(), { sessionId: 'ses_other', directory: '/repo' });
            list.answer([session('ses_other')]);
            expect(await result).toBe('none');
            expect(useSessionUIStore.getState().currentSessionId).toBe('ses_other');
            expect(readLastActiveSession(getRuntimeKey())?.sessionId).toBe('ses_other');
        } finally {
            list.restore();
        }
    });
});
