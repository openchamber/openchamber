import { create } from 'zustand';
import { createJSONStorage, devtools, persist } from 'zustand/middleware';
import type { Todo } from '@opencode-ai/sdk/v2/client';
import { getSafeStorage } from './utils/safeStorage';

const MAX_SESSIONS = 50;

interface SessionTodosRecord {
    todos: Todo[];
    touchedAt: number;
}

interface TodosPersistState {
    sessions: Record<string, SessionTodosRecord>;
    setSessionTodos: (sessionId: string, todos: Todo[] | undefined) => void;
    getSessionTodos: (sessionId: string) => Todo[] | undefined;
}

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
                setSessionTodos: (sessionId, todos) => {
                    if (!sessionId) return;
                    set((state) => {
                        const next = { ...state.sessions };
                        if (!todos || todos.length === 0) {
                            if (!(sessionId in next)) return state;
                            delete next[sessionId];
                            return { sessions: next };
                        }
                        next[sessionId] = { todos, touchedAt: Date.now() };
                        return { sessions: evictOldest(next) };
                    });
                },
                getSessionTodos: (sessionId) => {
                    if (!sessionId) return undefined;
                    return get().sessions[sessionId]?.todos;
                },
            }),
            {
                name: 'openchamber-session-todos',
                version: 1,
                storage: createJSONStorage(() => getSafeStorage()),
                partialize: (state) => ({ sessions: state.sessions }),
            },
        ),
        { name: 'TodosPersistStore' },
    ),
);
