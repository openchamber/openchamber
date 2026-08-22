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

import {
  createProjectNote,
  createProjectPlan,
  deleteProjectNote,
  deleteProjectPlan,
  fetchProjectContext,
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
  reset: () => void;
}

type ProjectContextStore = ProjectContextState & ProjectContextActions;

export const EMPTY_PROJECT_CONTEXT_ENTRY: ProjectContextEntry = {
  notes: [],
  todos: [],
  plans: [],
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
  const created: MutationFlags = { notes: false, todos: false, plans: false };
  mutationFlags.set(projectId, created);
  return created;
};

/**
 * Serialize writes per project so two saves cannot interleave into a
 * last-writer-wins race against the server's own read-modify-write.
 */
const enqueueWrite = <T>(projectId: string, operation: () => Promise<T>): Promise<T> => {
  const previous = writeChains.get(projectId) ?? Promise.resolve();
  const next = previous.then(operation, operation);
  writeChains.set(projectId, next.catch(() => undefined));
  return next;
};

const errorMessage = (error: unknown, fallback: string): string => (
  error instanceof Error && error.message ? error.message : fallback
);

export const useProjectContextStore = create<ProjectContextStore>((set, get) => {
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
    load: async (project, options = {}) => {
      const projectId = resolveProjectContextId(project);
      if (!projectId) return;

      const entry = currentEntry(projectId);
      if (entry.loading) return;
      if (entry.loaded && !options.force) return;

      patchEntry(projectId, { loading: true });

      try {
        const data = await fetchProjectContext(project);
        const flags = flagsFor(projectId);
        const committed = currentEntry(projectId);

        // A mutation that started after this load began is newer than the
        // snapshot; keep the local value for that field group only.
        patchEntry(projectId, {
          notes: flags.notes ? committed.notes : data.notes,
          todos: flags.todos ? committed.todos : data.todos,
          plans: flags.plans ? committed.plans : data.plans,
          loaded: true,
          loading: false,
          error: null,
        });
      } catch (error) {
        patchEntry(projectId, {
          loading: false,
          error: errorMessage(error, 'Failed to load project context'),
        });
      }
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
        const committed = await enqueueWrite(projectId, () => saveProjectTodos(project, todos));
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
        const saved = await enqueueWrite(projectId, () => updateProjectNote(project, noteId, { body: trimmed }));
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
        const saved = await enqueueWrite(projectId, () => updateProjectNote(project, noteId, { pinned }));
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
        const context = await enqueueWrite(projectId, () => deleteProjectNote(project, noteId));
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
        const { plan, context } = await enqueueWrite(projectId, () => createProjectPlan(project, value));
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
        const result = await enqueueWrite(projectId, () => updateProjectPlan(project, planId, raw));
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
        const saved = await enqueueWrite(projectId, () => setProjectPlanPinned(project, planId, pinned));
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

    deletePlan: async (project, planId) => {
      const projectId = resolveProjectContextId(project);
      if (!projectId) return false;

      const previous = currentEntry(projectId);
      patchEntry(projectId, { plans: previous.plans.filter((plan) => plan.id !== planId), error: null });

      const flags = flagsFor(projectId);
      flags.plans = true;

      try {
        const context = await enqueueWrite(projectId, () => deleteProjectPlan(project, planId));
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
      writeChains.clear();
      mutationFlags.clear();
      set({ entries: {} });
    },
  };
});
