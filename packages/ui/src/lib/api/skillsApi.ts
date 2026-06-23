import { runtimeFetch } from '../runtime-fetch';
import type {
  SkillsCatalogResponse,
  SkillsCatalogSourceResponse,
  SkillsRepoScanRequest,
  SkillsRepoScanResponse,
  SkillsInstallRequest,
  SkillsInstallResponse,
} from '@/lib/api/types';
import type { SkillDetail } from '@/stores/useSkillsStore';

export type SkillScope = 'user' | 'project';

export type SkillSource = 'opencode' | 'agents' | 'claude';

export type Skill = {
  name: string;
  path: string;
  scope: SkillScope;
  source: SkillSource;
  description?: string;
  content?: string;
  sources: Record<string, {
    scope: SkillScope;
    source: SkillSource;
    exists: boolean;
    dir?: string;
  }>;
};

export type InstallSkillOptions = {
  scope?: SkillScope;
  source?: SkillSource;
  description?: string;
  content?: string;
  instructions?: string;
  supportingFiles?: Array<{ path: string; content: string }>;
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

const ensureSkillName = (name: string): string => {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed) {
    throw new Error('Skill name is required');
  }
  return trimmed;
};

export const fetchSkills = async (directory?: string): Promise<Skill[]> => {
  const query = directory ? `?directory=${encodeURIComponent(directory)}` : '';
  const response = await runtimeFetch(`/api/config/skills${query}`);
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, 'Failed to load skills'));
  }
  const parsed = await response.json().catch(() => null);
  if (!parsed || !Array.isArray(parsed.skills)) {
    return [];
  }
  return parsed.skills as Skill[];
};

export const fetchSkillDetail = async (name: string, directory?: string): Promise<SkillDetail> => {
  const safeName = ensureSkillName(name);
  const query = directory ? `?directory=${encodeURIComponent(directory)}` : '';
  const response = await runtimeFetch(`/api/config/skills/${encodeURIComponent(safeName)}${query}`);
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, 'Failed to load skill detail'));
  }
  const parsed = await response.json().catch(() => null);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid skill detail response');
  }
  return parsed as SkillDetail;
};

export const installSkill = async (
  name: string,
  body: Record<string, unknown> = {},
  directory?: string,
): Promise<Record<string, unknown> | null> => {
  const safeName = ensureSkillName(name);
  const query = directory ? `?directory=${encodeURIComponent(directory)}` : '';
  const response = await runtimeFetch(`/api/config/skills/${encodeURIComponent(safeName)}${query}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error || 'Failed to install skill');
  }
  return payload;
};

export const uninstallSkill = async (
  name: string,
  directory?: string,
): Promise<{ requiresReload?: boolean; message?: string; reloadDelayMs?: number }> => {
  const safeName = ensureSkillName(name);
  const query = directory ? `?directory=${encodeURIComponent(directory)}` : '';
  const response = await runtimeFetch(`/api/config/skills/${encodeURIComponent(safeName)}${query}`, {
    method: 'DELETE',
    headers: {
      accept: 'application/json',
    },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, payload?.error || 'Failed to uninstall skill'));
  }
  return payload || {};
};

export const fetchSkillsCatalog = async (options?: { refresh?: boolean; sourceId?: string; directory?: string }): Promise<SkillsCatalogResponse | null> => {
  try {
    const parts: string[] = [];
    if (options?.refresh) {
      parts.push('refresh=true');
    }
    if (options?.sourceId) {
      parts.push(`sourceId=${encodeURIComponent(options.sourceId)}`);
    }
    if (options?.directory) {
      parts.push(`directory=${encodeURIComponent(options.directory)}`);
    }
    const query = parts.length > 0 ? `?${parts.join('&')}` : '';
    const response = await runtimeFetch(`/api/config/skills/catalog${query}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    return (await response.json()) as SkillsCatalogResponse;
  } catch {
    return null;
  }
};

export const fetchSkillsCatalogSource = async (
  sourceId: string,
  options?: { directory?: string; refresh?: boolean; cursor?: string }
): Promise<SkillsCatalogSourceResponse | null> => {
  try {
    const parts: string[] = [`sourceId=${encodeURIComponent(sourceId)}`];
    if (options?.directory) {
      parts.push(`directory=${encodeURIComponent(options.directory)}`);
    }
    if (options?.refresh) {
      parts.push('refresh=true');
    }
    if (options?.cursor) {
      parts.push(`cursor=${encodeURIComponent(options.cursor)}`);
    }
    const query = `?${parts.join('&')}`;
    const response = await runtimeFetch(`/api/config/skills/catalog/source${query}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    return (await response.json()) as SkillsCatalogSourceResponse;
  } catch {
    return null;
  }
};

export const scanSkillsRepository = async (
  request: SkillsRepoScanRequest,
  directory?: string,
): Promise<SkillsRepoScanResponse | null> => {
  try {
    const query = directory ? `?directory=${encodeURIComponent(directory)}` : '';
    const response = await runtimeFetch(`/api/config/skills/scan${query}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(request),
    });
    return (await response.json()) as SkillsRepoScanResponse;
  } catch {
    return null;
  }
};

export const installSkillsFromRepository = async (
  request: SkillsInstallRequest,
  directory?: string,
): Promise<SkillsInstallResponse | null> => {
  try {
    const query = directory ? `?directory=${encodeURIComponent(directory)}` : '';
    const response = await runtimeFetch(`/api/config/skills/install${query}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(request),
    });
    return (await response.json()) as SkillsInstallResponse;
  } catch {
    return null;
  }
};

export const updateSkill = async (
  name: string,
  config: Record<string, unknown>,
  directory?: string,
): Promise<{ requiresReload?: boolean; message?: string; reloadDelayMs?: number }> => {
  const safeName = ensureSkillName(name);
  const query = directory ? `?directory=${encodeURIComponent(directory)}` : '';
  const response = await runtimeFetch(`/api/config/skills/${encodeURIComponent(safeName)}${query}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(config),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error || 'Failed to update skill');
  }
  return payload || { requiresReload: false };
};

export const readSupportingFile = async (
  skillName: string,
  filePath: string,
  directory?: string,
): Promise<string | null> => {
  const safeName = ensureSkillName(skillName);
  const dirQuery = directory ? `&directory=${encodeURIComponent(directory)}` : '';
  const response = await runtimeFetch(`/api/config/skills/${encodeURIComponent(safeName)}/files/${encodeURIComponent(filePath)}?${dirQuery.slice(1)}`);
  if (!response.ok) {
    return null;
  }
  const data = await response.json().catch(() => null);
  if (data && typeof data === 'object' && typeof data.content === 'string') {
    return data.content;
  }
  return null;
};

export const writeSupportingFile = async (
  skillName: string,
  filePath: string,
  content: string,
  directory?: string,
): Promise<boolean> => {
  const safeName = ensureSkillName(skillName);
  const query = directory ? `?directory=${encodeURIComponent(directory)}` : '';
  const response = await runtimeFetch(`/api/config/skills/${encodeURIComponent(safeName)}/files/${encodeURIComponent(filePath)}${query}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  return response.ok;
};

export const deleteSupportingFile = async (
  skillName: string,
  filePath: string,
  directory?: string,
): Promise<boolean> => {
  const safeName = ensureSkillName(skillName);
  const query = directory ? `?directory=${encodeURIComponent(directory)}` : '';
  const response = await runtimeFetch(`/api/config/skills/${encodeURIComponent(safeName)}/files/${encodeURIComponent(filePath)}${query}`, {
    method: 'DELETE',
  });
  return response.ok;
};
