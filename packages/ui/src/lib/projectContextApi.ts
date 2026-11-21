
import { z } from 'zod';

import { createProjectIdFromPath } from './projectId';
import { runtimeFetch } from './runtime-fetch';

export interface ProjectTodoItem {
  id: string;
  text: string;
  completed: boolean;
  createdAt: number;
  planId?: string;
  dependsOn?: string[];
}

export interface ProjectPlanLink {
  id: string;
  file: string;
  title: string;
  createdAt: number;
  pinned: boolean;
  source?: 'shared' | 'personal';
  progress?: ProjectPlanProgress;
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
  origin?: { sessionId: string; messageId?: string };
  planId?: string;
}

interface ProjectContextData {
  notes: ProjectNote[];
  todos: ProjectTodoItem[];
  plans: ProjectPlanLink[];
  sharedPlansDir: string | null;
  notesTodosStore: ProjectNotesTodosStore | null;
}

export type ProjectNotesTodosStore = string;
const NOTES_TODOS_STORE_TOKEN = /^(local|repository):/;

interface ProjectPlanContent extends ProjectPlanLink {
  body: string;
  raw: string;
  path?: string;
}

export interface ProjectRef {
  id: string;
  path: string;
}

export interface SavedProjectPlanTarget {
  projectRef: ProjectRef;
  planId: string;
}

export const PROJECT_NOTE_BODY_MAX_LENGTH = 3000;
export const PROJECT_TODO_TEXT_MAX_LENGTH = 1000;
export const PROJECT_PLAN_TITLE_MAX_LENGTH = 160;

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
  const store = record.notesTodosStore ?? null;
  return {
    notes: Array.isArray(record.notes) ? record.notes : [],
    todos: Array.isArray(record.todos) ? record.todos : [],
    plans: Array.isArray(record.plans) ? record.plans.map(toPlanLink) : [],
    sharedPlansDir: typeof record.sharedPlansDir === 'string' ? record.sharedPlansDir : null,
    notesTodosStore: store !== null && NOTES_TODOS_STORE_TOKEN.test(store) ? store : null,
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
  store: ProjectNotesTodosStore | null,
): Promise<ProjectContextData> => {
  const response = await runtimeFetch(`${basePath(requireProjectId(project))}/todos`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(store ? { todos, store } : { todos }),
  });
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'Failed to save project todos'));
  }
  return parseContext(await response.json());
};

export type ProjectTodoChange =
  | { kind: 'create'; id: string; text: string }
  | { kind: 'complete'; id: string; completed: boolean }
  | { kind: 'edit'; id: string; text: string }
  | { kind: 'delete'; id: string };

export const writeProjectTodo = async (
  project: ProjectRef,
  change: ProjectTodoChange,
): Promise<ProjectContextData | null> => {
  const base = `${basePath(requireProjectId(project))}/todos`;
  const json = (method: 'POST' | 'PATCH', body: { id: string; text: string } | { text: string } | { completed: boolean }): RequestInit => ({
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const [url, init] = change.kind === 'create'
    ? [base, json('POST', { id: change.id, text: change.text })]
    : change.kind === 'complete'
      ? [`${base}/${encodeURIComponent(change.id)}`, json('PATCH', { completed: change.completed })]
      : change.kind === 'edit'
        ? [`${base}/${encodeURIComponent(change.id)}`, json('PATCH', { text: change.text })]
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
