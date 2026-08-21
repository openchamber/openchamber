import { requestExistingFileAccess } from '@/lib/desktop';
import { isFilePathWithinDirectory, normalizeFilePath } from '@/lib/path-utils';
import { getRuntimeKey } from '@/lib/runtime-switch';

type OutsideFileGrantEntry = {
  outsideFileGrant: string;
  expiresAt: number;
};

const GRANT_RENEWAL_BUFFER_MS = 5_000;
const grantsByCacheKey = new Map<string, OutsideFileGrantEntry>();
const pendingGrantsByCacheKey = new Map<string, Promise<string | undefined>>();

const grantCacheKey = (path: string, runtimeKey = getRuntimeKey()): string => `${runtimeKey}\0${path}`;

export const getOutsideFileGrant = (path: string): string | undefined => {
  const normalizedPath = normalizeFilePath(path);
  if (!normalizedPath) {
    return undefined;
  }

  const cacheKey = grantCacheKey(normalizedPath);
  const entry = grantsByCacheKey.get(cacheKey);
  if (!entry) {
    return undefined;
  }

  if (entry.expiresAt <= Date.now()) {
    grantsByCacheKey.delete(cacheKey);
    return undefined;
  }

  return entry.outsideFileGrant;
};

const rememberOutsideFileGrant = (
  path: string,
  outsideFileGrant: string,
  expiresAt: number,
  runtimeKey: string,
): void => {
  const normalizedPath = normalizeFilePath(path);
  if (!normalizedPath || !outsideFileGrant) {
    return;
  }

  grantsByCacheKey.set(grantCacheKey(normalizedPath, runtimeKey), {
    outsideFileGrant,
    expiresAt: expiresAt - GRANT_RENEWAL_BUFFER_MS,
  });
};

export const ensureOutsideFileGrantForDesktop = async (
  path: string,
  workspaceRoot: string,
): Promise<string | undefined> => {
  const normalizedPath = normalizeFilePath(path);
  if (!normalizedPath || !workspaceRoot || isFilePathWithinDirectory(normalizedPath, workspaceRoot)) {
    return undefined;
  }

  const runtimeKey = getRuntimeKey();
  if (runtimeKey !== 'local') {
    return undefined;
  }
  const cacheKey = grantCacheKey(normalizedPath, runtimeKey);
  const existing = getOutsideFileGrant(normalizedPath);
  if (existing) {
    return existing;
  }

  const pending = pendingGrantsByCacheKey.get(cacheKey);
  if (pending) {
    return pending;
  }

  const request = requestExistingFileAccess(normalizedPath).then((result) => {
    if (!result.success || getRuntimeKey() !== runtimeKey) {
      return undefined;
    }

    const { path: grantedPath, outsideFileGrant, expiresAt } = result;
    if (expiresAt <= Date.now() + GRANT_RENEWAL_BUFFER_MS) {
      return undefined;
    }
    rememberOutsideFileGrant(grantedPath, outsideFileGrant, expiresAt, runtimeKey);
    if (normalizeFilePath(grantedPath) !== normalizedPath) {
      rememberOutsideFileGrant(normalizedPath, outsideFileGrant, expiresAt, runtimeKey);
    }
    return outsideFileGrant;
  });
  pendingGrantsByCacheKey.set(cacheKey, request);
  try {
    return await request;
  } finally {
    pendingGrantsByCacheKey.delete(cacheKey);
  }
};

export const resolveOutsideFileReadOptions = async (
  path: string,
  workspaceRoot: string,
  enabled: boolean,
): Promise<{ allowOutsideWorkspace: boolean; outsideFileGrant?: string }> => {
  const allowOutsideWorkspace = enabled
    && Boolean(workspaceRoot)
    && !isFilePathWithinDirectory(path, workspaceRoot);
  if (!allowOutsideWorkspace) {
    return { allowOutsideWorkspace: false };
  }

  return {
    allowOutsideWorkspace: true,
    outsideFileGrant: await ensureOutsideFileGrantForDesktop(path, workspaceRoot),
  };
};
