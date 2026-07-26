import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';
import type { Todo } from '@opencode-ai/sdk/v2/client';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { normalizePath } from '@/lib/pathNormalization';
import { createDeferredSafeJSONStorage } from './utils/safeStorage';

const MAX_SESSIONS = 50;

interface SessionTodosRecord {
    todos: Todo[];
    touchedAt: number;
}

interface TodosPersistState {
    sessions: Record<string, SessionTodosRecord>;
    setSessionTodos: (directory: string, sessionId: string, todos: Todo[] | undefined) => void;
    getSessionTodos: (directory: string, sessionId: string) => Todo[] | undefined;
    clearSessionTodos: (runtimeKey: string, directory: string, sessionId: string) => void;
}

export const getTodosPersistenceKey = (runtimeKey: string, directory: string, sessionId: string): string =>
    JSON.stringify([runtimeKey, normalizePath(directory), sessionId]);

const getCurrentSessionKey = (directory: string, sessionId: string): string | null => {
    if (!directory || !sessionId) return null;
    return getTodosPersistenceKey(getRuntimeKey(), directory, sessionId);
};

const evictOldest = (sessions: Record<string, SessionTodosRecord>): Record<string, SessionTodosRecord> => {
    const ids = Object.keys(sessions);
    if (ids.length <= MAX_SESSIONS) return sessions;

    const sorted = ids
        .map((id) => [id, sessions[id].touchedAt] as const)
        .sort((a, b) => a[1] - b[1]);
    const drop = sorted.slice(0, ids.length - MAX_SESSIONS).map(([id]) => id);
    const next = { ...sessions };
    for (const id of drop) delete next[id];
    return next;
};

export const useTodosPersistStore = create<TodosPersistState>()(
    devtools(
        persist(
            (set, get) => ({
                sessions: {},
                setSessionTodos: (directory, sessionId, todos) => {
                    const key = getCurrentSessionKey(directory, sessionId);
                    if (!key) return;
                    set((state) => {
                        const next = { ...state.sessions };
                        if (!todos || todos.length === 0) {
                            if (!(key in next)) return state;
                            delete next[key];
                            return { sessions: next };
                        }
                        next[key] = { todos, touchedAt: Date.now() };
                        return { sessions: evictOldest(next) };
                    });
                },
                getSessionTodos: (directory, sessionId) => {
                    const key = getCurrentSessionKey(directory, sessionId);
                    return key ? get().sessions[key]?.todos : undefined;
                },
                clearSessionTodos: (runtimeKey, directory, sessionId) => {
                    if (!runtimeKey || !directory || !sessionId) return;
                    const key = getTodosPersistenceKey(runtimeKey, directory, sessionId);
                    set((state) => {
                        if (!(key in state.sessions)) return state;
                        const sessions = { ...state.sessions };
                        delete sessions[key];
                        return { sessions };
                    });
                },
            }),
            {
                name: 'openchamber-session-todos',
                version: 2,
                storage: createDeferredSafeJSONStorage(),
                partialize: (state) => ({ sessions: state.sessions }),
                migrate: () => ({ sessions: {} }),
            },
        ),
        { name: 'TodosPersistStore' },
    ),
);
