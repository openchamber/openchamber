import { runtimeFetch } from '../runtime-fetch';

export type Provider = {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  apiKey?: string;
  baseUrl?: string;
  models?: string[];
};

export type Model = {
  id: string;
  name: string;
  provider: string;
  capabilities?: string[];
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

const ensureProviderID = (providerId: string): string => {
  const trimmed = typeof providerId === 'string' ? providerId.trim() : '';
  if (!trimmed) {
    throw new Error('providerId is required');
  }
  return trimmed;
};

export const fetchProviders = async (): Promise<Provider[]> => {
  const response = await runtimeFetch('/api/providers');
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, 'Failed to load providers'));
  }
  const parsed = await response.json().catch(() => null);
  if (!parsed || !Array.isArray(parsed.providers)) {
    return [];
  }
  return parsed.providers as Provider[];
};

export const fetchProviderModels = async (providerId: string): Promise<Model[]> => {
  const safeID = ensureProviderID(providerId);
  const response = await runtimeFetch(`/api/provider/${encodeURIComponent(safeID)}/models`);
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, 'Failed to load models'));
  }
  const parsed = await response.json().catch(() => null);
  if (!parsed || !Array.isArray(parsed.models)) {
    return [];
  }
  return parsed.models as Model[];
};

export const addProvider = async (config: Partial<Provider>): Promise<Provider> => {
  const response = await runtimeFetch('/api/providers', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({ provider: config }),
  });
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, 'Failed to add provider'));
  }
  const parsed = await response.json().catch(() => null);
  if (!parsed?.provider) {
    throw new Error('Invalid response from server');
  }
  return parsed.provider as Provider;
};

export const removeProvider = async (providerId: string): Promise<void> => {
  const safeID = ensureProviderID(providerId);
  const response = await runtimeFetch(`/api/providers/${encodeURIComponent(safeID)}`, {
    method: 'DELETE',
    headers: { accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, 'Failed to remove provider'));
  }
};

export const updateProvider = async (providerId: string, config: Partial<Provider>): Promise<Provider> => {
  const safeID = ensureProviderID(providerId);
  const response = await runtimeFetch(`/api/providers/${encodeURIComponent(safeID)}`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({ provider: config }),
  });
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, 'Failed to update provider'));
  }
  const parsed = await response.json().catch(() => null);
  if (!parsed?.provider) {
    throw new Error('Invalid response from server');
  }
  return parsed.provider as Provider;
};

export type ProviderSourceInfo = {
  exists: boolean;
  path?: string | null;
};

export type ProviderSources = {
  auth: ProviderSourceInfo;
  user: ProviderSourceInfo;
  project: ProviderSourceInfo;
  custom?: ProviderSourceInfo;
};

export const fetchProviderSource = async (providerId: string, directory?: string): Promise<ProviderSources | null> => {
  const safeID = ensureProviderID(providerId);
  const query = directory ? `?directory=${encodeURIComponent(directory)}` : '';
  const response = await runtimeFetch(`/api/provider/${encodeURIComponent(safeID)}/source${query}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    return null;
  }
  const parsed = await response.json().catch(() => null);
  const sources = (parsed?.sources ?? parsed?.data?.sources) as ProviderSources | undefined;
  return sources ?? null;
};
