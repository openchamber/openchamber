import type { OpenCodeManager } from './opencode';

export const normalizePermissionAutoAcceptStorageIdentity = (apiUrl: string): string => {
  const trimmed = apiUrl.trim();
  if (!trimmed) return 'workspace-local';
  try {
    const url = new URL(trimmed);
    url.hash = '';
    url.search = '';
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return `url:${url.toString().replace(/\/+$/, '')}`;
  } catch {
    return `url:${trimmed.replace(/\/+$/, '')}`;
  }
};

export const resolvePermissionAutoAcceptStorageIdentity = (options: {
  manager?: Pick<OpenCodeManager, 'getPermissionAutoAcceptStorageIdentity'> | null;
  configuredApiUrl?: string | null;
}): string => {
  const managerIdentity = options.manager?.getPermissionAutoAcceptStorageIdentity();
  if (typeof managerIdentity === 'string' && managerIdentity.trim().length > 0) {
    return managerIdentity;
  }
  return normalizePermissionAutoAcceptStorageIdentity(options.configuredApiUrl || '');
};
