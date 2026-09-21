/**
 * Client for the OpenChamber agent memory routes.
 *
 * The store is owned by the server (`packages/web/server/lib/agent-memory`).
 * This module only speaks HTTP and resolves no storage paths.
 *
 * Every function throws on failure. An authoritative read must never resolve to
 * an empty list a caller could mistake for "the agent remembers nothing" — that
 * reading is exactly what would make the user think memory had been lost.
 *
 * A 404 is the one exception, and it means the feature is switched off rather
 * than that the entry is missing: the server disables the whole surface, so
 * callers translate it into `disabled` instead of an error.
 */

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
  /**
   * Reads as an instruction to the model rather than a fact. Kept in the store
   * and shown here, but withheld from what sessions are told.
   */
  flagged?: boolean;
  /** The session this was learned in, when the agent recorded one. */
  sessionId?: string;
}

interface AgentMemorySnapshot {
  global: AgentMemoryEntry[];
  project: AgentMemoryEntry[];
  /**
   * A scope that failed to load. Kept separate from an empty list so the panel
   * can say "could not load" rather than showing an empty tab that reads as
   * "the agent has forgotten everything".
   */
  globalFailed: boolean;
  projectFailed: boolean;
}

/** Mirrors the server's clamps, so the editor stops where storage would cut. */
export const AGENT_MEMORY_TITLE_MAX_LENGTH = 120;
export const AGENT_MEMORY_BODY_MAX_LENGTH = 2000;

/** Raised when the server reports the whole memory surface as switched off. */
export class AgentMemoryDisabledError extends Error {
  constructor() {
    super('Agent memory is disabled');
    this.name = 'AgentMemoryDisabledError';
  }
}

const BASE_PATH = '/api/agent-memory';

/**
 * Mirrors the server: the storage id comes from the project path, not from
 * `project.id`, because the path-derived id is what names the file on disk.
 */
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

/**
 * A 404 alone does not mean the feature is off — a deleted entry answers 404
 * too. Only the server's explicit `disabled` flag distinguishes them.
 */
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

/**
 * Both scopes in one request. Two requests would let one scope render while the
 * other is still in flight, which reads as memory that has gone missing.
 */
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
  };
};

/** A user correction from the panel; the agent rewrites by saving again. */
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
