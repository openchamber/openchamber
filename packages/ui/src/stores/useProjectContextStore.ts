/**
 * Project context store: notes, todos, and plan links, keyed by project.
 *
 * Replaces the `openchamber:project-notes-updated` / `openchamber:project-plan-saved`
 * window events that previously forced every mounted panel to re-read the whole
 * config. Writers now mutate the store and every reader re-renders from it.
 *
 * Storage is server-owned; this store is a cache with optimistic mutations.
 * See `packages/web/server/lib/project-context/DOCUMENTATION.md`.
 */

import { create } from 'zustand';
import { getRuntimeKey } from '@/lib/runtime-switch';

import {
  createProjectNote,
  createProjectPlan,
  createProjectTodo,
  deleteProjectNote,
  deleteProjectPlan,
  deleteProjectTodo,
  fetchProjectContext,
  shareProjectPlan,
  unshareProjectPlan,
  resolveProjectContextId,
  saveProjectTodos,
  setProjectPlanPinned,
  updateProjectNote,
  updateProjectPlan,
  updateProjectTodo,
  type ProjectNote,
  type ProjectNoteSource,
  type ProjectPlanLink,
  type ProjectRef,
  type ProjectTodoItem,
} from '@/lib/projectContextApi';

interface ProjectContextEntry {
  notes: ProjectNote[];
  todos: ProjectTodoItem[];
  plans: ProjectPlanLink[];
  /** The team's shared plans folder, when the project has one; sharing a plan needs it. */
  sharedPlansDir: string | null;
  /** True once an authoritative load has succeeded at least once. */
  loaded: boolean;
  loading: boolean;
  /** Last load or save failure. Never clears cached data on its own. */
  error: string | null;
}

interface MutationFlags {
  /** A note write is in flight; a slower load must not overwrite the list. */
  notes: boolean;
  /** A todo write is in flight; same rule. */
  todos: boolean;
  /** A plan write is in flight; same rule. */
  plans: boolean;
  revisions: { notes: number; todos: number; plans: number };
}

interface ProjectContextState {
  entries: Record<string, ProjectContextEntry>;
}

interface ProjectContextActions {
  getEntry: (project: ProjectRef | null | undefined) => ProjectContextEntry;
  load: (project: ProjectRef, options?: { force?: boolean }) => Promise<void>;
  saveTodos: (project: ProjectRef, todos: ProjectTodoItem[], expectedTodos?: ProjectTodoItem[]) => Promise<boolean>;
  createTodo: (project: ProjectRef, text: string) => Promise<boolean>;
  updateTodo: (project: ProjectRef, todoId: string, patch: { text?: string; completed?: boolean }) => Promise<boolean>;
  deleteTodo: (project: ProjectRef, todoId: string) => Promise<boolean>;
  createNote: (
    project: ProjectRef,
    value: { body: string; source?: ProjectNoteSource; origin?: { sessionId: string; messageId?: string } },
  ) => Promise<ProjectNote | null>;
  saveNoteBody: (project: ProjectRef, noteId: string, body: string, expectedBody?: string) => Promise<boolean>;
  setNotePinned: (project: ProjectRef, noteId: string, pinned: boolean) => Promise<boolean>;
  deleteNote: (project: ProjectRef, noteId: string) => Promise<boolean>;
  createPlan: (project: ProjectRef, value: { title: string; body: string }) => Promise<ProjectPlanLink | null>;
  savePlan: (project: ProjectRef, planId: string, raw: string, options?: { expectedRaw?: string }) => Promise<boolean>;
  setPlanPinned: (project: ProjectRef, planId: string, pinned: boolean) => Promise<boolean>;
  deletePlan: (project: ProjectRef, planId: string) => Promise<boolean>;
  /** Move a plan into the team's shared folder, or back; the plan gets a new id. */
  movePlan: (project: ProjectRef, planId: string, direction: 'share' | 'unshare') => Promise<boolean>;
  reset: () => void;
}

type ProjectContextStore = ProjectContextState & ProjectContextActions;

type NoteChange = { kind: 'pin'; id: string; pinned: boolean } | { kind: 'delete'; id: string };

type TodoChange =
  | { kind: 'create'; item: ProjectTodoItem }
  | { kind: 'update'; id: string; patch: { text?: string; completed?: boolean } }
  | { kind: 'delete'; id: string }
  | { kind: 'bulk'; todos: ProjectTodoItem[]; expectedTodos: ProjectTodoItem[] };

const insertOpenTodo = (todos: ProjectTodoItem[], item: ProjectTodoItem): ProjectTodoItem[] => {
  const index = todos.findIndex((todo) => todo.completed);
  return index < 0 ? [...todos, item] : [...todos.slice(0, index), item, ...todos.slice(index)];
};

const applyTodoChange = (todos: ProjectTodoItem[], change: TodoChange): ProjectTodoItem[] => {
  if (change.kind === 'bulk') return todos;
  if (change.kind === 'create') return insertOpenTodo(todos, change.item);
  if (change.kind === 'delete') return todos.filter((todo) => todo.id !== change.id);
  const item = todos.find((todo) => todo.id === change.id);
  if (!item) return todos;
  const updated = { ...item, ...change.patch };
  if (item.completed === updated.completed) return todos.map((todo) => todo === item ? updated : todo);
  const remaining = todos.filter((todo) => todo.id !== change.id);
  return updated.completed ? [...remaining, updated] : insertOpenTodo(remaining, updated);
};

const sameTodos = (left: ProjectTodoItem[], right: ProjectTodoItem[] | undefined): boolean => (
  right !== undefined && left.length === right.length && left.every((item, index) => {
    const other = right[index];
    return item.id === other.id && item.text === other.text && item.completed === other.completed && item.createdAt === other.createdAt;
  })
);

export const EMPTY_PROJECT_CONTEXT_ENTRY: ProjectContextEntry = {
  notes: [],
  todos: [],
  plans: [],
  sharedPlansDir: null,
  loaded: false,
  loading: false,
  error: null,
};

/**
 * Per-project write chains and in-flight mutation flags.
 *
 * Kept outside the store because they are coordination state, not rendered
 * state: putting them in the store would re-render every consumer whenever a
 * write starts or finishes.
 */
const writeChains = new Map<string, Promise<unknown>>();
const mutationFlags = new Map<string, MutationFlags>();

const flagsFor = (projectId: string): MutationFlags => {
  const existing = mutationFlags.get(projectId);
  if (existing) return existing;
  const created: MutationFlags = { notes: false, todos: false, plans: false, revisions: { notes: 0, todos: 0, plans: 0 } };
  mutationFlags.set(projectId, created);
  return created;
};

/**
 * Serialize writes per project so two saves cannot interleave into a
 * last-writer-wins race against the server's own read-modify-write.
 */
const enqueueWrite = <T>(projectId: string, field: 'notes' | 'todos' | 'plans', operation: () => Promise<T>): Promise<T> => {
  const flags = flagsFor(projectId);
  const previous = writeChains.get(projectId) ?? Promise.resolve();
  const next = previous.then(operation, operation).then((result) => {
    flags.revisions[field] += 1;
    return result;
  });
  writeChains.set(projectId, next.catch(() => undefined));
  return next;
};

const errorMessage = (error: unknown, fallback: string): string => (
  error instanceof Error && error.message ? error.message : fallback
);

export const useProjectContextStore = create<ProjectContextStore>((set, get) => {
  let generation = 0;
  const confirmedNotes = new Map<string, ProjectNote[]>();
  const pendingNotes = new Map<string, NoteChange[]>();
  const confirmedTodos = new Map<string, ProjectTodoItem[]>();
  const pendingTodos = new Map<string, TodoChange[]>();
  const loads = new Map<string, { promise: Promise<void>; refresh: () => void }>();
  const patchEntry = (projectId: string, patch: Partial<ProjectContextEntry>) => {
    set((state) => ({
      entries: {
        ...state.entries,
        [projectId]: { ...(state.entries[projectId] ?? EMPTY_PROJECT_CONTEXT_ENTRY), ...patch },
      },
    }));
  };

  const currentEntry = (projectId: string): ProjectContextEntry => (
    get().entries[projectId] ?? EMPTY_PROJECT_CONTEXT_ENTRY
  );

  const projectedTodos = (projectId: string): ProjectTodoItem[] => (
    (pendingTodos.get(projectId) ?? []).reduce(applyTodoChange, confirmedTodos.get(projectId) ?? [])
  );

  const notesFor = (projectId: string): ProjectNote[] => confirmedNotes.get(projectId) ?? [];
  const projectedNotes = (projectId: string): ProjectNote[] => (
    (pendingNotes.get(projectId) ?? []).reduce((items, change) => (
      change.kind === 'delete'
        ? items.filter((note) => note.id !== change.id)
        : items.map((note) => note.id === change.id ? { ...note, pinned: change.pinned } : note)
    ), notesFor(projectId))
  );
  const publishNotes = (projectId: string, patch: Partial<ProjectContextEntry> = {}) => {
    patchEntry(projectId, { ...patch, notes: projectedNotes(projectId) });
  };

  const mutateNote = async (
    project: ProjectRef,
    change: NoteChange,
    operation: () => Promise<ProjectNote[]>,
    fallback: string,
  ): Promise<boolean> => {
    const projectId = resolveProjectContextId(project);
    if (!projectId) return false;
    const startedGeneration = generation;
    const runtimeKey = getRuntimeKey();
    const current = () => startedGeneration === generation && runtimeKey === getRuntimeKey();
    const pending = pendingNotes.get(projectId) ?? [];
    pendingNotes.set(projectId, pending);
    pending.push(change);
    publishNotes(projectId, { error: null });
    const removePending = () => {
      const index = pending.indexOf(change);
      if (index >= 0) pending.splice(index, 1);
      if (!pending.length) pendingNotes.delete(projectId);
    };
    try {
      return await enqueueWrite(projectId, 'notes', async () => {
        if (!current()) return false;
        const flags = flagsFor(projectId);
        flags.notes = true;
        try {
          const notes = await operation();
          if (!current()) return false;
          confirmedNotes.set(projectId, notes);
          removePending();
          publishNotes(projectId);
          return true;
        } catch (error) {
          if (current()) {
            removePending();
            publishNotes(projectId, { error: errorMessage(error, fallback) });
          }
          throw error;
        } finally {
          flags.notes = false;
        }
      });
    } catch {
      return false;
    }
  };

  // Todo responses are committed snapshots. Item writes never send a cached
  // list, and bulk writes carry the snapshot the user actually saw.
  const mutateTodos = async (
    project: ProjectRef,
    operation: () => Promise<{ todos: ProjectTodoItem[] }>,
    change: TodoChange,
  ): Promise<boolean> => {
    const projectId = resolveProjectContextId(project);
    if (!projectId) return false;
    const startedGeneration = generation;
    const runtimeKey = getRuntimeKey();
    const current = () => startedGeneration === generation && runtimeKey === getRuntimeKey();
    const pending = pendingTodos.get(projectId) ?? [];
    pendingTodos.set(projectId, pending);
    pending.push(change);
    if (change.kind !== 'bulk') patchEntry(projectId, { todos: projectedTodos(projectId), error: null });
    const removePending = () => {
      const index = pending.indexOf(change);
      if (index >= 0) pending.splice(index, 1);
      if (!pending.length) pendingTodos.delete(projectId);
    };
    try {
      return await enqueueWrite(projectId, 'todos', async () => {
        if (!current()) return false;
        const flags = flagsFor(projectId);
        flags.todos = true;
        try {
          const committed = await operation();
          if (!current()) return false;
          confirmedTodos.set(projectId, committed.todos);
          removePending();
          patchEntry(projectId, { todos: projectedTodos(projectId), error: null });
          return true;
        } catch (error) {
          if (current()) {
            removePending();
            patchEntry(projectId, { todos: projectedTodos(projectId), error: errorMessage(error, 'Failed to save project todos') });
          }
          throw error;
        } finally {
          flags.todos = false;
        }
      });
    } catch {
      return false;
    }
  };

  return {
    entries: {},

    getEntry: (project) => {
      const projectId = resolveProjectContextId(project);
      if (!projectId) return EMPTY_PROJECT_CONTEXT_ENTRY;
      return get().entries[projectId] ?? EMPTY_PROJECT_CONTEXT_ENTRY;
    },

    /**
     * Load authoritative context.
     *
     * A failure sets `error` and leaves any previously loaded data in place:
     * an unreachable server must not read as "this project has no notes",
     * which is exactly how a user loses trust in a notes panel.
     */
    load: (project, options = {}) => {
      const projectId = resolveProjectContextId(project);
      if (!projectId) return Promise.resolve();

      const pending = loads.get(projectId);
      if (pending) {
        if (options.force) pending.refresh();
        return pending.promise;
      }
      const entry = currentEntry(projectId);
      if (entry.loaded && !options.force) return Promise.resolve();

      const startedGeneration = generation;
      const runtimeKey = getRuntimeKey();
      const current = () => startedGeneration === generation && runtimeKey === getRuntimeKey();
      let refreshAgain = options.force === true;
      const promise = Promise.resolve().then(async () => {
        do {
          const forced = refreshAgain;
          refreshAgain = false;
          // A peer notification can precede our own save response. Read after
          // admitted local writes finish, without changing ordinary load dedupe.
          if (forced) {
            while (current()) {
              const writes = writeChains.get(projectId);
              if (writes) await writes;
              if (writes === writeChains.get(projectId)) break;
            }
          }
          if (!current()) return;
          const revisions = { ...flagsFor(projectId).revisions };

          try {
            const data = await fetchProjectContext(project);
            if (!current()) return;
            if (refreshAgain) continue;
            const flags = flagsFor(projectId);
            if (forced && (flags.notes || flags.todos || flags.plans)) {
              refreshAgain = true;
              continue;
            }
            const committed = currentEntry(projectId);
            if (!flags.notes && flags.revisions.notes === revisions.notes) {
              confirmedNotes.set(projectId, data.notes);
            }
            if (flags.revisions.todos === revisions.todos) {
              confirmedTodos.set(projectId, data.todos);
            }

            // Completed writes still outrank a snapshot requested before them.
            patchEntry(projectId, {
              notes: projectedNotes(projectId),
              todos: flags.revisions.todos !== revisions.todos ? committed.todos : projectedTodos(projectId),
              plans: flags.plans || flags.revisions.plans !== revisions.plans ? committed.plans : data.plans,
              sharedPlansDir: data.sharedPlansDir,
              loaded: true,
              error: null,
            });
          } catch (error) {
            if (!current()) return;
            patchEntry(projectId, { error: errorMessage(error, 'Failed to load project context') });
          }
        } while (refreshAgain && current());
      }).finally(() => {
        if (loads.get(projectId)?.promise === promise) loads.delete(projectId);
        if (current()) patchEntry(projectId, { loading: false });
      });
      loads.set(projectId, {
        promise,
        refresh: () => { refreshAgain = true; },
      });
      patchEntry(projectId, { loading: true });
      return promise;
    },

    /** A reorder or bulk clear must compare the last confirmed list. */
    saveTodos: async (project, todos, snapshot) => {
      const projectId = resolveProjectContextId(project);
      if (!projectId) return false;
      const expectedTodos = snapshot ?? confirmedTodos.get(projectId);
      if (!expectedTodos || !confirmedTodos.has(projectId)) {
        patchEntry(projectId, { error: 'Project todos have not loaded' });
        return false;
      }
      const change: TodoChange = { kind: 'bulk', todos, expectedTodos };
      const hasPendingItems = (pendingTodos.get(projectId) ?? []).some(item => item.kind !== 'bulk');
      return mutateTodos(project, () => {
        const confirmed = confirmedTodos.get(projectId);
        if (hasPendingItems && !sameTodos(change.expectedTodos, confirmed)) {
          throw new Error('Failed to save project todos');
        }
        return saveProjectTodos(project, change.todos, change.expectedTodos);
      }, change);
    },

    createTodo: (project, text) => {
      const projectId = resolveProjectContextId(project);
      const change: TodoChange = { kind: 'create', item: {
        id: `pending:${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`}`,
        text, completed: false, createdAt: Date.now(),
      } };
      return mutateTodos(project, async () => {
        const { todo, context } = await createProjectTodo(project, text);
        // Rebind queued actions by the explicit server identity, even when a
        // peer added an indistinguishable item in the same committed snapshot.
        for (const pending of pendingTodos.get(projectId) ?? []) {
          if ((pending.kind === 'update' || pending.kind === 'delete') && pending.id === change.item.id) pending.id = todo.id;
          if (pending.kind === 'bulk') {
            const reconcile = (item: ProjectTodoItem) => item.id === change.item.id ? { ...item, id: todo.id, createdAt: todo.createdAt } : item;
            pending.todos = pending.todos.map(reconcile);
            pending.expectedTodos = pending.expectedTodos.map(reconcile);
          }
        }
        return context;
      }, change);
    },
    updateTodo: (project, todoId, patch) => {
      const change: TodoChange = { kind: 'update', id: todoId, patch };
      return mutateTodos(project, () => {
        if (change.id.startsWith('pending:')) throw new Error('Failed to save project todos');
        return updateProjectTodo(project, change.id, patch);
      }, change);
    },
    deleteTodo: (project, todoId) => {
      const change: TodoChange = { kind: 'delete', id: todoId };
      return mutateTodos(project, () => {
        if (change.id.startsWith('pending:')) throw new Error('Failed to save project todos');
        return deleteProjectTodo(project, change.id);
      }, change);
    },

    /**
     * Create a note. Not optimistic: the id and timestamps come from the
     * server, and a placeholder row that cannot be edited or pinned is worse
     * than a brief wait.
     *
     * The caller may be a chat action running while the panel is not mounted,
     * so the committed list is adopted wholesale rather than spliced into a
     * possibly-empty local one.
     */
    createNote: async (project, value) => {
      const projectId = resolveProjectContextId(project);
      const body = value.body.trim();
      if (!projectId || !body) return null;

      const flags = flagsFor(projectId);
      flags.notes = true;
      const startedGeneration = generation;
      const runtimeKey = getRuntimeKey();
      const current = () => startedGeneration === generation && runtimeKey === getRuntimeKey();

      try {
        return await enqueueWrite(
          projectId,
          'notes',
          async () => {
            if (!current()) return null;
            const { note, context } = await createProjectNote(project, { ...value, body });
            if (!current()) return null;
            confirmedNotes.set(projectId, context.notes);
            publishNotes(projectId, { loaded: true, error: null });
            return note;
          },
        );
      } catch (error) {
        if (current()) patchEntry(projectId, { error: errorMessage(error, 'Failed to create note') });
        return null;
      } finally {
        flags.notes = false;
      }
    },

    saveNoteBody: async (project, noteId, body, expectedBody) => {
      const projectId = resolveProjectContextId(project);
      const trimmed = body.trim();
      if (!projectId || !trimmed) return false;

      const confirmedBody = expectedBody ?? notesFor(projectId).find((note) => note.id === noteId)?.body;
      if (confirmedBody === undefined) return false;
      const startedGeneration = generation;
      const runtimeKey = getRuntimeKey();
      const current = () => startedGeneration === generation && runtimeKey === getRuntimeKey();
      try {
        return await enqueueWrite(projectId, 'notes', async () => {
          if (!current()) return false;
          const flags = flagsFor(projectId);
          flags.notes = true;
          try {
            const saved = await updateProjectNote(project, noteId, { body: trimmed }, { expectedBody: confirmedBody });
            if (!current()) return false;
            confirmedNotes.set(projectId, saved
              ? notesFor(projectId).map((note) => note.id === noteId ? saved : note)
              : notesFor(projectId).filter((note) => note.id !== noteId));
            publishNotes(projectId, saved ? { error: null } : {});
            return saved !== null;
          } finally {
            flags.notes = false;
          }
        });
      } catch (error) {
        if (current()) patchEntry(projectId, { error: errorMessage(error, 'Failed to save note') });
        return false;
      }
    },

    /** Pending pins affect only the flag; rollback keeps the confirmed body. */
    setNotePinned: async (project, noteId, pinned) => {
      const projectId = resolveProjectContextId(project);
      if (!projectId) return false;
      let found = false;
      const result = await mutateNote(project, { kind: 'pin', id: noteId, pinned }, async () => {
        const saved = await updateProjectNote(project, noteId, { pinned });
        found = saved !== null;
        return saved
          ? notesFor(projectId).map((note) => note.id === noteId ? saved : note)
          : notesFor(projectId).filter((note) => note.id !== noteId);
      }, 'Failed to save note');
      return result && found;
    },

    deleteNote: async (project, noteId) => {
      const projectId = resolveProjectContextId(project);
      if (!projectId) return false;

      return mutateNote(project, { kind: 'delete', id: noteId }, async () => {
        const context = await deleteProjectNote(project, noteId);
        return context.notes;
      }, 'Failed to delete note');
    },

    /**
     * Create a plan. Not optimistic: the id and file name are assigned by the
     * server, and a placeholder row that cannot be opened is worse than a
     * short wait.
     */
    createPlan: async (project, value) => {
      const projectId = resolveProjectContextId(project);
      if (!projectId) return null;

      const flags = flagsFor(projectId);
      flags.plans = true;

      try {
        const { plan, context } = await enqueueWrite(projectId, 'plans', () => createProjectPlan(project, value));
        patchEntry(projectId, { plans: context.plans, loaded: true, error: null });
        return plan;
      } catch (error) {
        patchEntry(projectId, { error: errorMessage(error, 'Failed to create plan') });
        return null;
      } finally {
        flags.plans = false;
      }
    },

    /**
     * Persist an edited plan and fold the refreshed title back into the list,
     * so renaming a plan's heading in the editor is reflected in the panel
     * without a reload. Resolves false when the plan is gone.
     */
    savePlan: async (project, planId, raw, options) => {
      const projectId = resolveProjectContextId(project);
      if (!projectId) return false;

      const flags = flagsFor(projectId);
      flags.plans = true;
      const startedGeneration = generation;
      const runtimeKey = getRuntimeKey();
      const current = () => startedGeneration === generation && runtimeKey === getRuntimeKey();

      try {
        const result = await enqueueWrite(projectId, 'plans', async () => {
          if (!current()) return null;
          return updateProjectPlan(project, planId, raw, options);
        });
        if (!current()) return false;
        if (!result) {
          patchEntry(projectId, {
            plans: currentEntry(projectId).plans.filter((plan) => plan.id !== planId),
          });
          return false;
        }
        patchEntry(projectId, {
          plans: currentEntry(projectId).plans.map((plan) => (plan.id === planId ? result.plan : plan)),
          error: null,
        });
        return true;
      } catch (error) {
        if (current()) patchEntry(projectId, { error: errorMessage(error, 'Failed to save plan') });
        return false;
      } finally {
        flags.plans = false;
      }
    },

    setPlanPinned: async (project, planId, pinned) => {
      const projectId = resolveProjectContextId(project);
      if (!projectId) return false;

      const previous = currentEntry(projectId).plans;
      patchEntry(projectId, {
        plans: previous.map((plan) => (plan.id === planId ? { ...plan, pinned } : plan)),
        error: null,
      });

      const flags = flagsFor(projectId);
      flags.plans = true;

      try {
        const saved = await enqueueWrite(projectId, 'plans', () => setProjectPlanPinned(project, planId, pinned));
        if (!saved) {
          patchEntry(projectId, { plans: currentEntry(projectId).plans.filter((plan) => plan.id !== planId) });
          return false;
        }
        patchEntry(projectId, {
          plans: currentEntry(projectId).plans.map((plan) => (plan.id === planId ? saved : plan)),
        });
        return true;
      } catch (error) {
        patchEntry(projectId, { plans: previous, error: errorMessage(error, 'Failed to update plan') });
        return false;
      } finally {
        flags.plans = false;
      }
    },

    movePlan: async (project, planId, direction) => {
      const projectId = resolveProjectContextId(project);
      if (!projectId) return false;

      const flags = flagsFor(projectId);
      flags.plans = true;

      try {
        const result = await enqueueWrite(projectId, 'plans', () => (
          direction === 'share' ? shareProjectPlan(project, planId) : unshareProjectPlan(project, planId)
        ));
        if (!result) {
          patchEntry(projectId, { plans: currentEntry(projectId).plans.filter((plan) => plan.id !== planId) });
          return false;
        }
        patchEntry(projectId, { plans: result.context.plans, sharedPlansDir: result.context.sharedPlansDir, error: null });
        return true;
      } catch (error) {
        patchEntry(projectId, { error: errorMessage(error, direction === 'share' ? 'Failed to share plan' : 'Failed to make plan personal') });
        return false;
      } finally {
        flags.plans = false;
      }
    },

    deletePlan: async (project, planId) => {
      const projectId = resolveProjectContextId(project);
      if (!projectId) return false;

      const previous = currentEntry(projectId);
      patchEntry(projectId, { plans: previous.plans.filter((plan) => plan.id !== planId), error: null });

      const flags = flagsFor(projectId);
      flags.plans = true;

      try {
        const context = await enqueueWrite(projectId, 'plans', () => deleteProjectPlan(project, planId));
        patchEntry(projectId, { plans: context.plans });
        return true;
      } catch (error) {
        patchEntry(projectId, {
          plans: previous.plans,
          error: errorMessage(error, 'Failed to delete plan'),
        });
        return false;
      } finally {
        flags.plans = false;
      }
    },

    /** Drop every cached project. Used when the active runtime changes. */
    reset: () => {
      generation += 1;
      confirmedNotes.clear();
      pendingNotes.clear();
      confirmedTodos.clear();
      pendingTodos.clear();
      loads.clear();
      writeChains.clear();
      mutationFlags.clear();
      set({ entries: {} });
    },
  };
});
