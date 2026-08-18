/**
 * Client for the OpenChamber project context routes.
 *
 * Notes, todos, and plan markdown are owned by the server
 * (`packages/web/server/lib/project-context`). This module only speaks HTTP:
 * it resolves no storage paths and never reads plan files directly, so the
 * shared UI has no knowledge of where any of it lives on disk.
 *
 * Every function throws on failure. An authoritative read must never resolve
 * to an empty value that a caller could mistake for "the project has nothing".
 */

import { createProjectIdFromPath } from './projectId';
import { runtimeFetch } from './runtime-fetch';

export interface ProjectTodoItem {
  id: string;
  text: string;
  completed: boolean;
  createdAt: number;
}

export interface ProjectPlanLink {
  id: string;
  file: string;
  title: string;
  createdAt: number;
  pinned: boolean;
}

export type ProjectNoteSource = 'manual' | 'selection' | 'agent';

export interface ProjectNote {
  id: string;
  body: string;
  createdAt: number;
  updatedAt: number;
  source: ProjectNoteSource;
  pinned: boolean;
  /** The message this note was distilled from, when it came from a chat. */
  origin?: { sessionId: string; messageId?: string };
}

interface ProjectContextData {
  notes: ProjectNote[];
  todos: ProjectTodoItem[];
  plans: ProjectPlanLink[];
}

interface ProjectPlanContent extends ProjectPlanLink {
  body: string;
  raw: string;
}

export interface ProjectRef {
  id: string;
  path: string;
}

export const PROJECT_NOTE_BODY_MAX_LENGTH = 3000;
export const PROJECT_TODO_TEXT_MAX_LENGTH = 120;

/**
 * Split a plan document into title and body, mirroring the server's own rule so
 * an unsaved editor buffer and an imported file title exactly the way the
 * stored file will.
 */
export const parsePlanMarkdown = (raw: string, fallback: string): { title: string; body: string } => {
  const normalized = (typeof raw === 'string' ? raw : '').replace(/\r\n?/g, '\n');
  const heading = normalized.match(/^\s*#\s+(.+?)\s*(?:\n+|$)/);
  if (heading) {
    return {
      title: heading[1].trim() || fallback,
      body: normalized.slice(heading[0].length).replace(/^\n+/, ''),
    };
  }
  const firstLine = normalized.split('\n').map((line) => line.trim()).find(Boolean);
  return {
    title: firstLine ? firstLine.replace(/^#+\s*/, '').trim() || fallback : fallback,
    body: normalized.trim(),
  };
};

/**
 * The storage id is derived from the project path, not from `project.id`.
 * Project ids in settings have churned across versions; the path-derived id is
 * what the server uses to name the config file, so both sides must agree on it.
 */
export const resolveProjectContextId = (project: ProjectRef | null | undefined): string => {
  const projectPath = typeof project?.path === 'string' ? project.path.trim() : '';
  if (!projectPath) {
    return '';
  }
  return createProjectIdFromPath(projectPath);
};

const basePath = (projectId: string): string => `/api/project-context/${encodeURIComponent(projectId)}`;

const requireProjectId = (project: ProjectRef): string => {
  const projectId = resolveProjectContextId(project);
  if (!projectId) {
    throw new Error('Project has no resolvable path');
  }
  return projectId;
};

const readErrorMessage = async (response: Response, fallback: string): Promise<string> => {
  try {
    const payload = await response.json() as { error?: unknown } | null;
    if (payload && typeof payload.error === 'string' && payload.error.trim()) {
      return payload.error;
    }
  } catch {
    // Fall through to the generic message.
  }
  return `${fallback} (${response.status})`;
};

const parseContext = (payload: unknown): ProjectContextData => {
  const record = payload as Partial<ProjectContextData> | null;
  if (!record || typeof record !== 'object') {
    throw new Error('Malformed project context response');
  }
  return {
    notes: Array.isArray(record.notes) ? record.notes : [],
    todos: Array.isArray(record.todos) ? record.todos : [],
    plans: Array.isArray(record.plans) ? record.plans : [],
  };
};

export const fetchProjectContext = async (
  project: ProjectRef,
  options: { signal?: AbortSignal } = {},
): Promise<ProjectContextData> => {
  const response = await runtimeFetch(basePath(requireProjectId(project)), {
    cache: 'no-store',
    signal: options.signal,
  });
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to load project context'));
  }
  return parseContext(await response.json());
};

export const saveProjectTodos = async (
  project: ProjectRef,
  todos: ProjectTodoItem[],
): Promise<ProjectContextData> => {
  const response = await runtimeFetch(`${basePath(requireProjectId(project))}/todos`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ todos }),
  });
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to save project todos'));
  }
  return parseContext(await response.json());
};

export const createProjectNote = async (
  project: ProjectRef,
  value: { body: string; source?: ProjectNoteSource; origin?: { sessionId: string; messageId?: string } },
): Promise<{ note: ProjectNote; context: ProjectContextData }> => {
  const response = await runtimeFetch(`${basePath(requireProjectId(project))}/notes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      body: value.body,
      ...(value.source ? { source: value.source } : {}),
      ...(value.origin ? { origin: value.origin } : {}),
    }),
  });
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to create note'));
  }
  const payload = await response.json() as { note?: ProjectNote; context?: unknown };
  if (!payload?.note) {
    throw new Error('Malformed note create response');
  }
  return { note: payload.note, context: parseContext(payload.context) };
};

/**
 * Patch a note. Only the supplied fields are sent, so pinning cannot roll back
 * an edit that landed between the two requests.
 *
 * Resolves `null` when the note is gone.
 */
export const updateProjectNote = async (
  project: ProjectRef,
  noteId: string,
  patch: { body?: string; pinned?: boolean },
): Promise<ProjectNote | null> => {
  const response = await runtimeFetch(
    `${basePath(requireProjectId(project))}/notes/${encodeURIComponent(noteId)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    },
  );
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to save note'));
  }
  const payload = await response.json() as { note?: ProjectNote };
  if (!payload?.note) {
    throw new Error('Malformed note save response');
  }
  return payload.note;
};

export const deleteProjectNote = async (
  project: ProjectRef,
  noteId: string,
): Promise<ProjectContextData> => {
  const response = await runtimeFetch(
    `${basePath(requireProjectId(project))}/notes/${encodeURIComponent(noteId)}`,
    { method: 'DELETE' },
  );
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to delete note'));
  }
  return parseContext(await response.json());
};

/** Resolves `null` when the plan is gone. */
export const setProjectPlanPinned = async (
  project: ProjectRef,
  planId: string,
  pinned: boolean,
): Promise<ProjectPlanLink | null> => {
  const response = await runtimeFetch(
    `${basePath(requireProjectId(project))}/plans/${encodeURIComponent(planId)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinned }),
    },
  );
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to update plan'));
  }
  const payload = await response.json() as { plan?: ProjectPlanLink };
  return payload?.plan ?? null;
};

/**
 * Plans are addressed by id. The caller supplies content, never a path, so a
 * plan can only ever be created inside the project's own plans directory.
 */
export const createProjectPlan = async (
  project: ProjectRef,
  value: { title: string; body: string },
): Promise<{ plan: ProjectPlanLink; context: ProjectContextData }> => {
  const response = await runtimeFetch(`${basePath(requireProjectId(project))}/plans`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: value.title, body: value.body }),
  });
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to create plan'));
  }
  const payload = await response.json() as { plan?: ProjectPlanLink; context?: unknown };
  if (!payload?.plan) {
    throw new Error('Malformed plan create response');
  }
  return { plan: payload.plan, context: parseContext(payload.context) };
};

/** Resolves `null` only when the plan or its markdown is genuinely gone. */
export const fetchProjectPlan = async (
  project: ProjectRef,
  planId: string,
  options: { signal?: AbortSignal } = {},
): Promise<ProjectPlanContent | null> => {
  const response = await runtimeFetch(
    `${basePath(requireProjectId(project))}/plans/${encodeURIComponent(planId)}`,
    { cache: 'no-store', signal: options.signal },
  );
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to read plan'));
  }
  return await response.json() as ProjectPlanContent;
};

/**
 * Overwrite a plan's markdown with the editor's exact buffer.
 *
 * Resolves `null` when the plan or its file is gone, so an editor open on a
 * deleted plan reports that instead of silently recreating it.
 */
export const updateProjectPlan = async (
  project: ProjectRef,
  planId: string,
  raw: string,
): Promise<{ plan: ProjectPlanLink; raw: string } | null> => {
  const response = await runtimeFetch(
    `${basePath(requireProjectId(project))}/plans/${encodeURIComponent(planId)}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw }),
    },
  );
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to save plan'));
  }
  const payload = await response.json() as { plan?: ProjectPlanLink; raw?: string };
  if (!payload?.plan) {
    throw new Error('Malformed plan save response');
  }
  return { plan: payload.plan, raw: typeof payload.raw === 'string' ? payload.raw : raw };
};

export const deleteProjectPlan = async (
  project: ProjectRef,
  planId: string,
): Promise<ProjectContextData> => {
  const response = await runtimeFetch(
    `${basePath(requireProjectId(project))}/plans/${encodeURIComponent(planId)}`,
    { method: 'DELETE' },
  );
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to delete plan'));
  }
  return parseContext(await response.json());
};
