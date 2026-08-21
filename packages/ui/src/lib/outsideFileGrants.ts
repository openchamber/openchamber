import { requestExistingFileAccess } from '@/lib/desktop';
import { isFilePathWithinDirectory, normalizeFilePath } from '@/lib/path-utils';

type OutsideFileGrantEntry = {
  outsideFileGrant: string;
  expiresAt: number;
};

const DEFAULT_GRANT_TTL_MS = 10 * 60 * 1000;
const grantsByPath = new Map<string, OutsideFileGrantEntry>();
const pendingGrantsByPath = new Map<string, Promise<string | undefined>>();

export const getOutsideFileGrant = (path: string): string | undefined => {
  const normalizedPath = normalizeFilePath(path);
  if (!normalizedPath) {
    return undefined;
  }

  const entry = grantsByPath.get(normalizedPath);
  if (!entry) {
    return undefined;
  }

  if (entry.expiresAt <= Date.now()) {
    grantsByPath.delete(normalizedPath);
    return undefined;
  }

  return entry.outsideFileGrant;
};

const rememberOutsideFileGrant = (
  path: string,
  outsideFileGrant: string,
): void => {
  const normalizedPath = normalizeFilePath(path);
  if (!normalizedPath || !outsideFileGrant) {
    return;
  }

  grantsByPath.set(normalizedPath, {
    outsideFileGrant,
    expiresAt: Date.now() + DEFAULT_GRANT_TTL_MS,
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

  const existing = getOutsideFileGrant(normalizedPath);
  if (existing) {
    return existing;
  }

  const pending = pendingGrantsByPath.get(normalizedPath);
  if (pending) {
    return pending;
  }

  const request = requestExistingFileAccess(normalizedPath).then((result) => {
    if (!result.success || !result.path || !result.outsideFileGrant) {
      return undefined;
    }

    rememberOutsideFileGrant(result.path, result.outsideFileGrant);
    if (normalizeFilePath(result.path) !== normalizedPath) {
      rememberOutsideFileGrant(normalizedPath, result.outsideFileGrant);
    }
    return result.outsideFileGrant;
  });
  pendingGrantsByPath.set(normalizedPath, request);
  try {
    return await request;
  } finally {
    pendingGrantsByPath.delete(normalizedPath);
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
