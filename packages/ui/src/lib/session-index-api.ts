import type { Session } from '@opencode-ai/sdk/v2';

import { runtimeFetch } from './runtime-fetch';

export type SessionIndexDirectory = {
  directory: string;
  cursor: number | null;
  hasMore: boolean;
  lastSyncedAt: number;
  lastFullSyncedAt: number;
  lastAccessedAt: number;
  sessions: Session[];
};

export type SessionIndexSnapshot = {
  revision: number;
  sync: {
    active: boolean;
    completed: number;
    total: number;
    pendingDirectories: string[];
    completedDirectories: string[];
    failedDirectories: string[];
  };
  directories: SessionIndexDirectory[];
};

const ensureOk = async (response: Response): Promise<void> => {
  if (response.ok) return;
  throw new Error(`session index request failed (${response.status})`);
};

export const loadSessionIndexSnapshot = async (): Promise<SessionIndexSnapshot | null> => {
  if (typeof window === 'undefined') return null;
  const response = await runtimeFetch('/api/openchamber/session-index');
  if (response.status === 501) return null;
  await ensureOk(response);
  const payload = await response.json() as Partial<SessionIndexSnapshot> & { available?: boolean };
  if (payload.available !== true || !Array.isArray(payload.directories)) return null;
  return {
    revision: typeof payload.revision === 'number' ? payload.revision : 0,
    sync: payload.sync ?? {
      active: false,
      completed: 0,
      total: 0,
      pendingDirectories: [],
      completedDirectories: [],
      failedDirectories: [],
    },
    directories: payload.directories,
  };
};

export const startSessionIndexBackgroundSync = async (
  directories: string[],
): Promise<SessionIndexSnapshot | null> => {
  if (typeof window === 'undefined') return null;
  const response = await runtimeFetch('/api/openchamber/session-index/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ directories }),
  });
  if (response.status === 501) return null;
  await ensureOk(response);
  return response.json() as Promise<SessionIndexSnapshot>;
};

export const pollSessionIndexChanges = async (
  revision: number,
  signal: AbortSignal,
): Promise<SessionIndexSnapshot | null> => {
  if (typeof window === 'undefined') return null;
  const response = await runtimeFetch('/api/openchamber/session-index/changes', {
    query: { since: revision, timeout: 25_000 },
    signal,
  });
  if (response.status === 501) return null;
  await ensureOk(response);
  return response.json() as Promise<SessionIndexSnapshot>;
};

export const persistSessionIndexDirectory = async (input: {
  directory: string;
  sessions: Session[];
  cursor: number | null;
  hasMore: boolean;
  fullSync?: boolean;
}): Promise<void> => {
  if (typeof window === 'undefined') return;
  const response = await runtimeFetch('/api/openchamber/session-index/directory', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (response.status === 501) return;
  await ensureOk(response);
};

export const persistSessionIndexDirectories = async (directories: Array<{
  directory: string;
  sessions: Session[];
  cursor: number | null;
  hasMore: boolean;
  fullSync?: boolean;
}>): Promise<void> => {
  if (typeof window === 'undefined' || directories.length === 0) return;
  const response = await runtimeFetch('/api/openchamber/session-index/snapshot', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ directories }),
  });
  if (response.status === 501) return;
  await ensureOk(response);
};

export const persistSessionIndexSession = async (session: Session): Promise<void> => {
  if (typeof window === 'undefined') return;
  const response = await runtimeFetch('/api/openchamber/session-index/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session }),
  });
  if (response.status === 501) return;
  await ensureOk(response);
};

export const removeSessionIndexSession = async (sessionID: string): Promise<void> => {
  if (typeof window === 'undefined') return;
  const response = await runtimeFetch(`/api/openchamber/session-index/session/${encodeURIComponent(sessionID)}`, {
    method: 'DELETE',
  });
  if (response.status === 501) return;
  await ensureOk(response);
};
