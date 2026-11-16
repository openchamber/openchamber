import { create } from 'zustand';
import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';

/**
 * The agent's todo list per session, owned by the server (`lib/session-todos`)
 * and read from OpenCode's experimental `todowrite` tool. A session is read
 * when the Work Status panel shows it; changes arrive whole on the control
 * stream (`session-todos-sync.ts`).
 */

const sessionTodoSchema = z.object({
  content: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed', 'cancelled']).catch('pending'),
});
export type SessionTodo = z.infer<typeof sessionTodoSchema>;

const answerSchema = z.discriminatedUnion('state', [
  z.object({ revision: z.number(), state: z.literal('off') }),
  z.object({ revision: z.number(), state: z.literal('ready'), todos: z.array(sessionTodoSchema) }),
]);

/** A list the server sent on the stream; `todos` null when it has to be read again. */
export const sessionTodosEventSchema = z.object({
  revision: z.number(),
  sessionId: z.string().min(1).nullable(),
  directory: z.string().min(1).nullable(),
  todos: z.array(sessionTodoSchema).nullable(),
});
export type SessionTodosEvent = z.infer<typeof sessionTodosEventSchema>;

/**
 * `off` while the tool is off in the session's directory: nothing shows.
 * A failed read keeps what was shown and counts in `failures`, which the
 * panel's loader retries on (`useLoadSessionTodos`); a read that succeeds
 * clears it.
 */
type SessionTodosEntry = {
  directory: string;
  state: 'loading' | 'off' | 'ready';
  todos: SessionTodo[];
  revision: number | null;
  failures: number;
};

type SessionTodosState = {
  entries: Record<string, SessionTodosEntry>;
  /** Reads the session's list; `isCurrent` drops an answer that arrives after a runtime switch. */
  load: (sessionId: string, directory: string, isCurrent?: () => boolean) => Promise<void>;
  /** `isCurrent` fences the reads an event starts to the runtime that sent it. */
  applyEvent: (event: SessionTodosEvent, isCurrent: () => boolean) => void;
  reset: () => void;
};

const EMPTY: SessionTodo[] = [];

// One read per session at a time; a demand during it earns one read after it.
const inFlight = new Map<string, { promise: Promise<void>; again: boolean }>();

export const useSessionTodosStore = create<SessionTodosState>()((set, get) => {
  const commit = (sessionId: string, entry: SessionTodosEntry) => {
    const current = get().entries[sessionId];
    if (current?.revision != null && entry.revision != null && entry.revision < current.revision) return;
    set({ entries: { ...get().entries, [sessionId]: entry } });
  };

  const read = async (sessionId: string, directory: string, isCurrent: () => boolean) => {
    const response = await runtimeFetch(`/api/session-todos/${encodeURIComponent(sessionId)}`, {
      query: { directory },
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`Session todos request failed with ${response.status}`);
    const answer = answerSchema.parse(await response.json());
    if (!isCurrent()) return;
    commit(sessionId, {
      directory,
      state: answer.state,
      todos: answer.state === 'ready' ? answer.todos : EMPTY,
      revision: answer.revision,
      failures: 0,
    });
  };

  return {
    entries: {},

    load: (sessionId, directory, isCurrent = () => true) => {
      const running = inFlight.get(sessionId);
      if (running) {
        running.again = true;
        return running.promise;
      }
      if (!get().entries[sessionId]) {
        set({ entries: { ...get().entries, [sessionId]: { directory, state: 'loading', todos: EMPTY, revision: null, failures: 0 } } });
      }
      const slot = { promise: Promise.resolve(), again: false };
      slot.promise = (async () => {
        try {
          do {
            slot.again = false;
            await read(sessionId, directory, isCurrent);
          } while (slot.again && isCurrent());
        } catch (error) {
          const entry = get().entries[sessionId];
          if (entry && isCurrent()) set({ entries: { ...get().entries, [sessionId]: { ...entry, failures: entry.failures + 1 } } });
          throw error;
        } finally {
          if (inFlight.get(sessionId) === slot) inFlight.delete(sessionId);
        }
      })();
      inFlight.set(sessionId, slot);
      return slot.promise;
    },

    applyEvent: (event, isCurrent) => {
      const { entries } = get();
      const reload = (sessionId: string, entry: SessionTodosEntry) => {
        void get().load(sessionId, entry.directory, isCurrent).catch((error) => console.warn('[session-todos] failed to read', error));
      };
      if (event.sessionId === null) {
        // A directory's config changed (the tool may have been turned on or
        // off there), or with no directory, OpenCode's stream had a gap.
        for (const [sessionId, entry] of Object.entries(entries)) {
          if (event.directory === null || entry.directory === event.directory) reload(sessionId, entry);
        }
        return;
      }
      const entry = entries[event.sessionId];
      // Only sessions someone looked at are kept.
      if (!entry) return;
      if (event.todos === null) {
        reload(event.sessionId, entry);
        return;
      }
      commit(event.sessionId, { directory: entry.directory, state: 'ready', todos: event.todos, revision: event.revision, failures: 0 });
    },

    reset: () => {
      inFlight.clear();
      set({ entries: {} });
    },
  };
});

/** The session's list, or nothing while it is off, unknown or loading. */
export const useSessionTodos = (sessionId: string | null): SessionTodo[] => useSessionTodosStore(
  (state) => (sessionId ? state.entries[sessionId]?.todos ?? EMPTY : EMPTY),
);

/** True once the server said the tool is on in the session's directory. */
export const selectSessionTodosOn = (sessionId: string | null) => (state: SessionTodosState): boolean => (
  sessionId ? state.entries[sessionId]?.state === 'ready' : false
);
