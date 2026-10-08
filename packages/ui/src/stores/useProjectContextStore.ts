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
  deleteProjectNote,
  deleteProjectPlan,
  fetchProjectContext,
  shareProjectPlan,
  unshareProjectPlan,
  resolveProjectContextId,
  saveProjectTodos,
  setProjectPlanPinned,
  updateProjectNote,
  updateProjectPlan,
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
  saveTodos: (project: ProjectRef, todos: ProjectTodoItem[]) => Promise<boolean>;
  createNote: (
    project: ProjectRef,
    value: { body: string; source?: ProjectNoteSource; origin?: { sessionId: string; messageId?: string } },
  ) => Promise<ProjectNote | null>;
  saveNoteBody: (project: ProjectRef, noteId: string, body: string) => Promise<boolean>;
  setNotePinned: (project: ProjectRef, noteId: string, pinned: boolean) => Promise<boolean>;
  deleteNote: (project: ProjectRef, noteId: string) => Promise<boolean>;
  createPlan: (project: ProjectRef, value: { title: string; body: string }) => Promise<ProjectPlanLink | null>;
  savePlan: (project: ProjectRef, planId: string, raw: string) => Promise<boolean>;
  setPlanPinned: (project: ProjectRef, planId: string, pinned: boolean) => Promise<boolean>;
  deletePlan: (project: ProjectRef, planId: string) => Promise<boolean>;
  /** Move a plan into the team's shared folder, or back; the plan gets a new id. */
  movePlan: (project: ProjectRef, planId: string, direction: 'share' | 'unshare') => Promise<boolean>;
  reset: () => void;
}

type ProjectContextStore = ProjectContextState & ProjectContextActions;

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

            // Completed writes still outrank a snapshot requested before them.
            patchEntry(projectId, {
              notes: flags.notes || flags.revisions.notes !== revisions.notes ? committed.notes : data.notes,
              todos: flags.todos || flags.revisions.todos !== revisions.todos ? committed.todos : data.todos,
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

    /**
     * Optimistically apply todos, then persist.
     *
     * On failure the previous list is restored, so the panel never shows a
     * state that is not on disk without also showing the error.
     */
    saveTodos: async (project, todos) => {
      const projectId = resolveProjectContextId(project);
      if (!projectId) return false;

      const previous = currentEntry(projectId).todos;
      patchEntry(projectId, { todos, error: null });

      const flags = flagsFor(projectId);
      flags.todos = true;

      try {
        const committed = await enqueueWrite(projectId, 'todos', () => saveProjectTodos(project, todos));
        patchEntry(projectId, { todos: committed.todos, loaded: true });
        return true;
      } catch (error) {
        patchEntry(projectId, {
          todos: previous,
          error: errorMessage(error, 'Failed to save project todos'),
        });
        return false;
      } finally {
        flags.todos = false;
      }
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

      try {
        const { note, context } = await enqueueWrite(
          projectId,
          'notes',
          () => createProjectNote(project, { ...value, body }),
        );
        patchEntry(projectId, { notes: context.notes, loaded: true, error: null });
        return note;
      } catch (error) {
        patchEntry(projectId, { error: errorMessage(error, 'Failed to create note') });
        return null;
      } finally {
        flags.notes = false;
      }
    },

    saveNoteBody: async (project, noteId, body) => {
      const projectId = resolveProjectContextId(project);
      const trimmed = body.trim();
      if (!projectId || !trimmed) return false;

      const previous = currentEntry(projectId).notes;
      patchEntry(projectId, {
        notes: previous.map((note) => (note.id === noteId ? { ...note, body: trimmed } : note)),
        error: null,
      });

      const flags = flagsFor(projectId);
      flags.notes = true;

      try {
        const saved = await enqueueWrite(projectId, 'notes', () => updateProjectNote(project, noteId, { body: trimmed }));
        if (!saved) {
          patchEntry(projectId, { notes: currentEntry(projectId).notes.filter((note) => note.id !== noteId) });
          return false;
        }
        patchEntry(projectId, {
          notes: currentEntry(projectId).notes.map((note) => (note.id === noteId ? saved : note)),
        });
        return true;
      } catch (error) {
        patchEntry(projectId, { notes: previous, error: errorMessage(error, 'Failed to save note') });
        return false;
      } finally {
        flags.notes = false;
      }
    },

    /** Sends `pinned` alone, so it cannot roll back a concurrent body edit. */
    setNotePinned: async (project, noteId, pinned) => {
      const projectId = resolveProjectContextId(project);
      if (!projectId) return false;

      const previous = currentEntry(projectId).notes;
      patchEntry(projectId, {
        notes: previous.map((note) => (note.id === noteId ? { ...note, pinned } : note)),
        error: null,
      });

      const flags = flagsFor(projectId);
      flags.notes = true;

      try {
        const saved = await enqueueWrite(projectId, 'notes', () => updateProjectNote(project, noteId, { pinned }));
        if (!saved) {
          patchEntry(projectId, { notes: currentEntry(projectId).notes.filter((note) => note.id !== noteId) });
          return false;
        }
        patchEntry(projectId, {
          notes: currentEntry(projectId).notes.map((note) => (note.id === noteId ? saved : note)),
        });
        return true;
      } catch (error) {
        patchEntry(projectId, { notes: previous, error: errorMessage(error, 'Failed to save note') });
        return false;
      } finally {
        flags.notes = false;
      }
    },

    deleteNote: async (project, noteId) => {
      const projectId = resolveProjectContextId(project);
      if (!projectId) return false;

      const previous = currentEntry(projectId).notes;
      patchEntry(projectId, { notes: previous.filter((note) => note.id !== noteId), error: null });

      const flags = flagsFor(projectId);
      flags.notes = true;

      try {
        const context = await enqueueWrite(projectId, 'notes', () => deleteProjectNote(project, noteId));
        patchEntry(projectId, { notes: context.notes });
        return true;
      } catch (error) {
        patchEntry(projectId, { notes: previous, error: errorMessage(error, 'Failed to delete note') });
        return false;
      } finally {
        flags.notes = false;
      }
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
    savePlan: async (project, planId, raw) => {
      const projectId = resolveProjectContextId(project);
      if (!projectId) return false;

      const flags = flagsFor(projectId);
      flags.plans = true;

      try {
        const result = await enqueueWrite(projectId, 'plans', () => updateProjectPlan(project, planId, raw));
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
        patchEntry(projectId, { error: errorMessage(error, 'Failed to save plan') });
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
      loads.clear();
      writeChains.clear();
      mutationFlags.clear();
      set({ entries: {} });
    },
  };
});
