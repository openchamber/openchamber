/**
 * Client for the OpenChamber project context routes.
 *
 * Notes, todos, and plan markdown are owned by the server
 * (`packages/web/server/lib/project-context`). This module only speaks HTTP:
 * it resolves no storage paths and never reads or writes plan files directly.
 * The only paths it sees are the ones the server reports (a plan's `path`, the
 * shared plans folder), and those only name files to the user or an agent.
 *
 * Every function throws on failure. An authoritative read must never resolve
 * to an empty value that a caller could mistake for "the project has nothing".
 */

import { z } from 'zod';

import { createProjectIdFromPath } from './projectId';
import { runtimeFetch } from './runtime-fetch';

export interface ProjectTodoItem {
  id: string;
  text: string;
  completed: boolean;
  createdAt: number;
  /** The plan this todo belongs to; absent for a standalone todo. */
  planId?: string;
  /** Todos of the same plan to complete first; absent when there are none. */
  dependsOn?: string[];
}

export interface ProjectPlanLink {
  id: string;
  file: string;
  title: string;
  createdAt: number;
  pinned: boolean;
  /** The user's own plan, or one from the team's shared plans folder. */
  source?: 'shared' | 'personal';
  /** Ticked and total steps of the plan's `## Steps` checklist; absent without one. */
  progress?: ProjectPlanProgress;
  /** The session the plan was last sent to with Implement or Improve. */
  session?: ProjectPlanSession;
}

export interface ProjectPlanProgress {
  done: number;
  total: number;
}

export interface ProjectPlanSession {
  sessionId: string;
  linkedAt: number;
}

const planProgressSchema = z.object({ done: z.number().int().min(0), total: z.number().int().min(1) })
  .refine((value) => value.done <= value.total);
const planSessionSchema = z.object({ sessionId: z.string().min(1), linkedAt: z.number() });

/**
 * A plan from the server with its progress and session checked. Either field
 * that does not parse is dropped, so a malformed one shows no badge instead of
 * a wrong one.
 */
const toPlanLink = (plan: ProjectPlanLink): ProjectPlanLink => {
  const { progress, session, ...link } = plan;
  const parsedProgress = planProgressSchema.safeParse(progress);
  const parsedSession = planSessionSchema.safeParse(session);
  const checked: ProjectPlanLink = link;
  if (parsedProgress.success) checked.progress = parsedProgress.data;
  if (parsedSession.success) checked.session = parsedSession.data;
  return checked;
};

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
  /** The plan this note belongs to; absent for a standalone note. */
  planId?: string;
}

interface ProjectContextData {
  notes: ProjectNote[];
  todos: ProjectTodoItem[];
  plans: ProjectPlanLink[];
  /** Absolute path of the team's shared plans folder when the project has one. */
  sharedPlansDir: string | null;
}

interface ProjectPlanContent extends ProjectPlanLink {
  body: string;
  raw: string;
  /**
   * Absolute path of the plan's markdown on the server's machine. Only for
   * naming the plan to an agent (comments quote it); reads and writes stay
   * addressed by id through these routes.
   */
  path?: string;
}

export interface ProjectRef {
  id: string;
  path: string;
}

/**
 * A saved project plan plus the project that owns it, carried as one value so
 * a viewer can never end up with a plan id whose owner it has to guess.
 * PlanView resolves no owner on its own: the panel (or the persisted tab,
 * or the mobile surface) that opened the plan knows the owner exactly.
 */
export interface SavedProjectPlanTarget {
  projectRef: ProjectRef;
  planId: string;
}

export const PROJECT_NOTE_BODY_MAX_LENGTH = 3000;
export const PROJECT_TODO_TEXT_MAX_LENGTH = 1000;
/** The server clamps plan titles to the same length. */
export const PROJECT_PLAN_TITLE_MAX_LENGTH = 160;

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
    plans: Array.isArray(record.plans) ? record.plans.map(toPlanLink) : [],
    sharedPlansDir: typeof record.sharedPlansDir === 'string' ? record.sharedPlansDir : null,
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

/** One todo at a time; see `writeProjectTodo`. */
export type ProjectTodoChange =
  | { kind: 'create'; id: string; text: string }
  | { kind: 'complete'; id: string; completed: boolean }
  | { kind: 'delete'; id: string };

/**
 * Write one todo. The server applies the change to its current list, so a
 * todo an agent added since this client last read survives it. Answers with
 * the whole committed list, or null when the todo is already gone.
 */
export const writeProjectTodo = async (
  project: ProjectRef,
  change: ProjectTodoChange,
): Promise<ProjectContextData | null> => {
  const base = `${basePath(requireProjectId(project))}/todos`;
  const json = (method: 'POST' | 'PATCH', body: { id: string; text: string } | { completed: boolean }): RequestInit => ({
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const [url, init] = change.kind === 'create'
    ? [base, json('POST', { id: change.id, text: change.text })]
    : change.kind === 'complete'
      ? [`${base}/${encodeURIComponent(change.id)}`, json('PATCH', { completed: change.completed })]
      : [`${base}/${encodeURIComponent(change.id)}`, { method: 'DELETE' }];
  const response = await runtimeFetch(url, init);
  if (response.status === 404 && change.kind !== 'create') {
    return null;
  }
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
  return payload?.plan ? toPlanLink(payload.plan) : null;
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
  return { plan: toPlanLink(payload.plan), context: parseContext(payload.context) };
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
  return { plan: toPlanLink(payload.plan), raw: typeof payload.raw === 'string' ? payload.raw : raw };
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

/**
 * Move a plan between the user's folder and the team's shared plans folder.
 * The plan gets a new id on the other side; resolves `null` when it is gone.
 * Sharing needs a shared plans folder set for the project (Project settings).
 */
const movePlan = async (
  project: ProjectRef,
  planId: string,
  direction: 'share' | 'unshare',
): Promise<{ plan: ProjectPlanLink; context: ProjectContextData } | null> => {
  const response = await runtimeFetch(
    `${basePath(requireProjectId(project))}/plans/${encodeURIComponent(planId)}/${direction}`,
    { method: 'POST' },
  );
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, direction === 'share' ? 'Failed to share plan' : 'Failed to make plan personal'));
  }
  return readPlanWithContext(response, 'Malformed plan move response');
};

/** A `{ plan, context }` answer: the plan the write touched and the committed context. */
const readPlanWithContext = async (
  response: Response,
  malformedMessage: string,
): Promise<{ plan: ProjectPlanLink; context: ProjectContextData }> => {
  const payload = await response.json() as { plan?: ProjectPlanLink; context?: unknown };
  if (!payload?.plan) {
    throw new Error(malformedMessage);
  }
  return { plan: toPlanLink(payload.plan), context: parseContext(payload.context) };
};

/**
 * Record the session a plan was just sent to. Resolves `null` when the plan is
 * gone.
 */
export const linkProjectPlanSession = async (
  project: ProjectRef,
  planId: string,
  sessionId: string,
): Promise<{ plan: ProjectPlanLink; context: ProjectContextData } | null> => {
  const response = await runtimeFetch(
    `${basePath(requireProjectId(project))}/plans/${encodeURIComponent(planId)}/session`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    },
  );
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to link plan to session'));
  }
  return readPlanWithContext(response, 'Malformed plan session response');
};

export const shareProjectPlan = (project: ProjectRef, planId: string) => movePlan(project, planId, 'share');
export const unshareProjectPlan = (project: ProjectRef, planId: string) => movePlan(project, planId, 'unshare');
