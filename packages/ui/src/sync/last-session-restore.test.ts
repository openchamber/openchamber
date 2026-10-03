import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { clearLastActiveSession, persistLastActiveSession, readLastActiveSession } from './last-session-cache';
import { restoreLastActiveSession } from './last-session-restore';
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
    useSessionUIStore.setState({ setCurrentSession: originalSetCurrentSession, currentSessionId: null });
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
});
