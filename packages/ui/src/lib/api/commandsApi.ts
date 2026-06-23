import { runtimeFetch } from '../runtime-fetch';

export type CommandScope = 'user' | 'project';

export type CommandSource = {
  md?: {
    exists: boolean;
    scope?: CommandScope;
  };
  json?: {
    exists: boolean;
    scope?: CommandScope;
  };
};

export type CommandDetails = {
  name: string;
  scope?: CommandScope;
  sources?: CommandSource;
};

export type CommandConfig = {
  template?: string;
  description?: string;
  agent?: string;
  model?: string;
  scope?: CommandScope;
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

const ensureCommandName = (name: string): string => {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed) {
    throw new Error('command name is required');
  }
  return trimmed;
};

const buildCommandUrl = (name: string, directory?: string | null): string => {
  const safeName = encodeURIComponent(ensureCommandName(name));
  const query = directory ? `?directory=${encodeURIComponent(directory)}` : '';
  return `/api/config/commands/${safeName}${query}`;
};

const buildHeaders = (directory?: string | null, extraHeaders?: Record<string, string>) => {
  const headers: Record<string, string> = { ...extraHeaders };
  if (directory) {
    headers['x-opencode-directory'] = directory;
  }
  return headers;
};

export const fetchCommandDetails = async (name: string, directory?: string | null): Promise<CommandDetails> => {
  const response = await runtimeFetch(buildCommandUrl(name, directory), {
    headers: buildHeaders(directory, {
      'Cache-Control': 'no-cache',
    }),
  });
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, 'Failed to load command details'));
  }
  const parsed = await response.json().catch(() => null);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid response from server');
  }
  return parsed as CommandDetails;
};

export const createCommand = async (name: string, config: CommandConfig, directory?: string | null): Promise<{ requiresReload?: boolean; message?: string; reloadDelayMs?: number }> => {
  const response = await runtimeFetch(buildCommandUrl(name, directory), {
    method: 'POST',
    headers: buildHeaders(directory, {
      'content-type': 'application/json',
    }),
    body: JSON.stringify(config),
  });
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, 'Failed to create command'));
  }
  return (await response.json().catch(() => ({}))) as { requiresReload?: boolean; message?: string; reloadDelayMs?: number };
};

export const updateCommand = async (name: string, config: CommandConfig, directory?: string | null): Promise<{ requiresReload?: boolean; message?: string; reloadDelayMs?: number }> => {
  const response = await runtimeFetch(buildCommandUrl(name, directory), {
    method: 'PATCH',
    headers: buildHeaders(directory, {
      'content-type': 'application/json',
    }),
    body: JSON.stringify(config),
  });
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, 'Failed to update command'));
  }
  return (await response.json().catch(() => ({}))) as { requiresReload?: boolean; message?: string; reloadDelayMs?: number };
};

export const deleteCommand = async (name: string, directory?: string | null): Promise<{ requiresReload?: boolean; message?: string; reloadDelayMs?: number }> => {
  const response = await runtimeFetch(buildCommandUrl(name, directory), {
    method: 'DELETE',
    headers: buildHeaders(directory),
  });
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, 'Failed to delete command'));
  }
  return (await response.json().catch(() => ({}))) as { requiresReload?: boolean; message?: string; reloadDelayMs?: number };
};

export const reloadConfiguration = async (): Promise<void> => {
  const response = await runtimeFetch('/api/config/reload', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
  });
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, 'Failed to reload configuration'));
  }
};
