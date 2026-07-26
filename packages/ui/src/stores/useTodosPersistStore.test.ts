import { beforeEach, describe, expect, test } from 'bun:test';
import type { Todo } from '@opencode-ai/sdk/v2/client';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { getTodosPersistenceKey, useTodosPersistStore } from './useTodosPersistStore';

const todo = (content: string): Todo => ({ content, status: 'pending', priority: 'medium' });

describe('useTodosPersistStore', () => {
    beforeEach(() => {
        useTodosPersistStore.setState({ sessions: {} });
    });

    test('isolates identical session IDs by directory', () => {
        const store = useTodosPersistStore.getState();
        store.setSessionTodos('/repo-a', 'session-1', [todo('a')]);
        store.setSessionTodos('/repo-b', 'session-1', [todo('b')]);

        expect(useTodosPersistStore.getState().getSessionTodos('/repo-a', 'session-1')).toEqual([todo('a')]);
        expect(useTodosPersistStore.getState().getSessionTodos('/repo-b', 'session-1')).toEqual([todo('b')]);
    });

    test('stores entries under the active runtime identity', () => {
        useTodosPersistStore.getState().setSessionTodos('/repo', 'session-1', [todo('active')]);

        const key = getTodosPersistenceKey(getRuntimeKey(), '/repo', 'session-1');
        expect(useTodosPersistStore.getState().sessions[key]?.todos).toEqual([todo('active')]);
        expect(getTodosPersistenceKey('runtime-a', '/repo', 'session-1'))
            .not.toBe(getTodosPersistenceKey('runtime-b', '/repo', 'session-1'));
    });

    test('removes only the matching composite session', () => {
        const store = useTodosPersistStore.getState();
        store.setSessionTodos('/repo-a', 'session-1', [todo('a')]);
        store.setSessionTodos('/repo-b', 'session-1', [todo('b')]);
        store.setSessionTodos('/repo-a', 'session-1', []);

        expect(useTodosPersistStore.getState().getSessionTodos('/repo-a', 'session-1')).toBe(undefined);
        expect(useTodosPersistStore.getState().getSessionTodos('/repo-b', 'session-1')).toEqual([todo('b')]);
    });

    test('clears an explicitly owned runtime session', () => {
        const runtimeKey = getRuntimeKey();
        const store = useTodosPersistStore.getState();
        store.setSessionTodos('/repo', 'session-1', [todo('active')]);
        store.clearSessionTodos('other-runtime', '/repo', 'session-1');
        expect(useTodosPersistStore.getState().getSessionTodos('/repo', 'session-1')).toEqual([todo('active')]);

        store.clearSessionTodos(runtimeKey, '/repo/', 'session-1');
        expect(useTodosPersistStore.getState().getSessionTodos('/repo', 'session-1')).toBe(undefined);
    });
});
