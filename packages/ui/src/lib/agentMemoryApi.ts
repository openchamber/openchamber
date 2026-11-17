
import { z } from 'zod';

import { createProjectIdFromPath } from './projectId';
import { runtimeFetch } from './runtime-fetch';

export type AgentMemoryType = 'fact' | 'preference' | 'reference';
export type AgentMemoryScope = 'global' | 'project';

export interface AgentMemoryEntry {
  id: string;
  title: string;
  body: string;
  type: AgentMemoryType;
  createdAt: number;
  updatedAt: number;
  flagged?: boolean;
  sessionId?: string;
}

interface AgentMemorySnapshot {
  global: AgentMemoryEntry[];
  project: AgentMemoryEntry[];
  globalFailed: boolean;
  projectFailed: boolean;
  dream: { global: AgentMemoryDream | null; project: AgentMemoryDream | null };
}

export interface AgentMemoryDream {
  finishedAt: number;
  status: 'done' | 'failed';
  merged: number;
  removed: number;
  rewritten: number;
  undone: boolean;
  canUndo: boolean;
  toDocs: string[];
}

export const AGENT_MEMORY_TITLE_MAX_LENGTH = 120;
export const AGENT_MEMORY_BODY_MAX_LENGTH = 2000;

export class AgentMemoryDisabledError extends Error {
  constructor() {
    super('Agent memory is disabled');
    this.name = 'AgentMemoryDisabledError';
  }
}

const BASE_PATH = '/api/agent-memory';

const resolveMemoryProjectId = (projectPath: string | null | undefined): string => {
  const trimmed = typeof projectPath === 'string' ? projectPath.trim() : '';
  return trimmed ? createProjectIdFromPath(trimmed) : '';
};

const scopeQuery = (scope: AgentMemoryScope, projectId: string): string => {
  if (scope === 'global') {
    return 'scope=global';
  }
  if (!projectId) {
    throw new Error('Project memory needs a resolvable project path');
  }
  return `scope=project&projectId=${encodeURIComponent(projectId)}`;
};

interface ErrorPayload {
  error?: unknown;
  disabled?: unknown;
}

const failed = async (response: Response, fallback: string): Promise<never> => {
  let payload: ErrorPayload | null = null;
  try {
    payload = await response.json() as ErrorPayload | null;
  } catch {
    // Fall through to the generic message.
  }
  if (response.status === 404 && payload?.disabled === true) {
    throw new AgentMemoryDisabledError();
  }
  const message = typeof payload?.error === 'string' && payload.error.trim()
    ? payload.error
    : `${fallback} (${response.status})`;
  throw new Error(message);
};

const parseEntry = (value: unknown): AgentMemoryEntry | null => {
  const record = value as Partial<AgentMemoryEntry> | null;
  if (!record || typeof record !== 'object') {
    return null;
  }
  if (typeof record.id !== 'string' || typeof record.title !== 'string' || typeof record.body !== 'string') {
    return null;
  }
  return {
    id: record.id,
    title: record.title,
    body: record.body,
    type: record.type === 'preference' || record.type === 'reference' ? record.type : 'fact',
    createdAt: typeof record.createdAt === 'number' ? record.createdAt : 0,
    updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : 0,
    ...(record.flagged === true ? { flagged: true } : {}),
    ...(typeof record.sessionId === 'string' ? { sessionId: record.sessionId } : {}),
  };
};

const parseEntries = (value: unknown): AgentMemoryEntry[] => (
  Array.isArray(value) ? value.map(parseEntry).filter((entry): entry is AgentMemoryEntry => entry !== null) : []
);

export const fetchAgentMemory = async (
  projectPath: string | null,
  options: { signal?: AbortSignal } = {},
): Promise<AgentMemorySnapshot> => {
  const projectId = resolveMemoryProjectId(projectPath);
  const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
  const response = await runtimeFetch(`${BASE_PATH}/all${query}`, {
    cache: 'no-store',
    signal: options.signal,
  });
  if (!response.ok) {
    return failed(response, 'Failed to load agent memory');
  }

  const payload = await response.json() as Record<string, unknown> | null;
  if (!payload || typeof payload !== 'object') {
    throw new Error('Malformed agent memory response');
  }
  return {
    global: parseEntries(payload.global),
    project: parseEntries(payload.project),
    globalFailed: payload.globalFailed === true,
    projectFailed: payload.projectFailed === true,
    dream: dreamsSchema.parse(payload.dream ?? {}),
  };
};

const dreamCountSchema = z.number().int().nonnegative().catch(0);
const dreamSchema = z.object({
  finishedAt: z.number(),
  status: z.enum(['done', 'failed']).catch('done'),
  merged: dreamCountSchema,
  removed: dreamCountSchema,
  rewritten: dreamCountSchema,
  undone: z.boolean().catch(false),
  canUndo: z.boolean().catch(false),
  toDocs: z.array(z.string()).catch([]),
});
const dreamsSchema = z.object({
  global: dreamSchema.nullable().catch(null),
  project: dreamSchema.nullable().catch(null),
}).catch({ global: null, project: null });

export const undoAgentMemoryDream = async (
  scope: AgentMemoryScope,
  projectPath: string | null,
): Promise<void> => {
  const query = scopeQuery(scope, resolveMemoryProjectId(projectPath));
  const response = await runtimeFetch(`${BASE_PATH}/dream/undo?${query}`, { method: 'POST' });
  if (!response.ok) {
    await failed(response, 'Failed to undo the memory tidy-up');
  }
};

export const updateAgentMemory = async (
  scope: AgentMemoryScope,
  projectPath: string | null,
  memoryId: string,
  patch: { title?: string; body?: string; type?: AgentMemoryType },
): Promise<AgentMemoryEntry> => {
  const query = scopeQuery(scope, resolveMemoryProjectId(projectPath));
  const response = await runtimeFetch(`${BASE_PATH}/${encodeURIComponent(memoryId)}?${query}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!response.ok) {
    return failed(response, 'Failed to save memory');
  }

  const payload = await response.json() as { entry?: unknown } | null;
  const entry = parseEntry(payload?.entry);
  if (!entry) {
    throw new Error('Malformed agent memory response');
  }
  return entry;
};

export const deleteAgentMemory = async (
  scope: AgentMemoryScope,
  projectPath: string | null,
  memoryId: string,
): Promise<void> => {
  const query = scopeQuery(scope, resolveMemoryProjectId(projectPath));
  const response = await runtimeFetch(`${BASE_PATH}/${encodeURIComponent(memoryId)}?${query}`, {
    method: 'DELETE',
  });
  if (!response.ok) {
    await failed(response, 'Failed to delete memory');
  }
};
