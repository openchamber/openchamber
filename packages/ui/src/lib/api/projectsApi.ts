import type { DesktopSettings } from '@/lib/desktop';
import { runtimeFetch } from '../runtime-fetch';

export type Project = {
  id: string;
  path: string;
  label?: string;
  icon?: string | null;
  iconImage?: {
    mime: string;
    updatedAt: number;
    source: 'custom' | 'auto';
  } | null;
  iconBackground?: string | null;
  color?: string | null;
  addedAt?: number;
  lastOpenedAt?: number;
  sidebarCollapsed?: boolean;
};

const parseErrorMessage = async (response: Response, fallback: string) => {
  try {
    const parsed = await response.json();
    if (parsed && typeof parsed.error === 'string' && parsed.error.trim().length > 0) {
      return parsed.error;
    }
  } catch {
    return fallback;
  }
  return fallback;
};

const ensureProjectID = (projectID: string): string => {
  const trimmed = typeof projectID === 'string' ? projectID.trim() : '';
  if (!trimmed) {
    throw new Error('projectId is required');
  }
  return trimmed;
};

export const fetchProjects = async (): Promise<Project[]> => {
  const response = await runtimeFetch('/api/projects');
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, 'Failed to load projects'));
  }
  const parsed = await response.json().catch(() => null);
  if (!parsed || !Array.isArray(parsed.projects)) {
    return [];
  }
  return parsed.projects as Project[];
};

export const addProject = async (path: string): Promise<Project> => {
  const safePath = typeof path === 'string' ? path.trim() : '';
  if (!safePath) {
    throw new Error('path is required');
  }
  const response = await runtimeFetch('/api/projects', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({ path: safePath }),
  });
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, 'Failed to add project'));
  }
  const parsed = await response.json().catch(() => null);
  if (!parsed?.project) {
    throw new Error('Invalid response from server');
  }
  return parsed.project as Project;
};

export const removeProject = async (projectId: string): Promise<void> => {
  const safeProjectID = ensureProjectID(projectId);
  const response = await runtimeFetch(`/api/projects/${encodeURIComponent(safeProjectID)}`, {
    method: 'DELETE',
    headers: {
      accept: 'application/json',
    },
  });
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, 'Failed to remove project'));
  }
};

export const switchProject = async (projectId: string): Promise<void> => {
  const safeProjectID = ensureProjectID(projectId);
  const response = await runtimeFetch(`/api/projects/${encodeURIComponent(safeProjectID)}/switch`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({}),
  });
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, 'Failed to switch project'));
  }
};

export interface UploadIconResponse {
  settings?: DesktopSettings;
}

export interface DiscoverIconResponse {
  skipped?: boolean;
  reason?: string;
  settings?: DesktopSettings;
}

export const uploadProjectIcon = async (projectId: string, dataUrl: string): Promise<UploadIconResponse> => {
  const safeId = ensureProjectID(projectId);
  const response = await runtimeFetch(`/api/projects/${encodeURIComponent(safeId)}/icon`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ dataUrl }),
  });
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, 'Failed to upload project icon'));
  }
  const parsed = await response.json().catch(() => ({}));
  return parsed as UploadIconResponse;
};

export const removeProjectIcon = async (projectId: string): Promise<UploadIconResponse> => {
  const safeId = ensureProjectID(projectId);
  const response = await runtimeFetch(`/api/projects/${encodeURIComponent(safeId)}/icon`, {
    method: 'DELETE',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, 'Failed to remove project icon'));
  }
  const parsed = await response.json().catch(() => ({}));
  return parsed as UploadIconResponse;
};

export const discoverProjectIcon = async (projectId: string, force?: boolean): Promise<DiscoverIconResponse> => {
  const safeId = ensureProjectID(projectId);
  const response = await runtimeFetch(`/api/projects/${encodeURIComponent(safeId)}/icon/discover`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ force: force === true }),
  });
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, 'Failed to discover project icon'));
  }
  const parsed = await response.json().catch(() => ({}));
  return parsed as DiscoverIconResponse;
};
