import { requestExistingFileAccess } from '@/lib/desktop';
import { isFilePathWithinDirectory, normalizeFilePath } from '@/lib/path-utils';

type OutsideFileGrantEntry = {
  outsideFileGrant: string;
  expiresAt: number;
};

const DEFAULT_GRANT_TTL_MS = 10 * 60 * 1000;
const grantsByPath = new Map<string, OutsideFileGrantEntry>();

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
  expiresAt?: number,
): void => {
  const normalizedPath = normalizeFilePath(path);
  if (!normalizedPath || !outsideFileGrant) {
    return;
  }

  grantsByPath.set(normalizedPath, {
    outsideFileGrant,
    expiresAt: typeof expiresAt === 'number' && Number.isFinite(expiresAt)
      ? expiresAt
      : Date.now() + DEFAULT_GRANT_TTL_MS,
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

  const result = await requestExistingFileAccess(normalizedPath);
  if (!result.success || !result.path || !result.outsideFileGrant) {
    return undefined;
  }

  rememberOutsideFileGrant(result.path, result.outsideFileGrant);
  if (normalizeFilePath(result.path) !== normalizedPath) {
    rememberOutsideFileGrant(normalizedPath, result.outsideFileGrant);
  }
  return result.outsideFileGrant;
};
