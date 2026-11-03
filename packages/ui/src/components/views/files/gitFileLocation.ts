type GitFileLocation = {
  directory: string;
  path: string;
};

const normalizePath = (value: string): string => {
  const raw = value.replace(/\\/g, '/');
  const hadUncPrefix = raw.startsWith('//');
  let normalized = raw.replace(/\/+/g, '/');
  if (hadUncPrefix && !normalized.startsWith('//')) normalized = `/${normalized}`;
  if (normalized !== '/' && !/^[A-Za-z]:\/$/.test(normalized)) {
    normalized = normalized.replace(/\/+$/, '');
  }
  return normalized;
};

const fileParts = (filePath: string): { directory: string; name: string } | null => {
  const normalized = normalizePath(filePath);
  const separator = normalized.lastIndexOf('/');
  if (separator < 0 || separator === normalized.length - 1) return null;
  let directory = normalized.slice(0, separator);
  if (separator === 0) directory = '/';
  if (/^[A-Za-z]:$/.test(directory)) directory += '/';
  return { directory, name: normalized.slice(separator + 1) };
};

/** Resolves the repository that actually owns an open file without relying on another Git surface's selection. */
export const resolveGitFileLocation = async (
  filePath: string | null | undefined,
  resolveRepositoryPrefix: (directory: string) => Promise<string>,
): Promise<GitFileLocation | null> => {
  if (!filePath) return null;
  const parts = fileParts(filePath);
  if (!parts) return null;
  const prefix = normalizePath(await resolveRepositoryPrefix(parts.directory)).replace(/^\/+|\/+$/g, '');
  if (!prefix) return { directory: parts.directory, path: parts.name };

  const suffix = `/${prefix}`;
  const caseInsensitive = /^[A-Za-z]:\//.test(parts.directory) || parts.directory.startsWith('//');
  const comparableDirectory = caseInsensitive ? parts.directory.toLowerCase() : parts.directory;
  const comparableSuffix = caseInsensitive ? suffix.toLowerCase() : suffix;
  if (!comparableDirectory.endsWith(comparableSuffix)) return null;
  let directory = parts.directory.slice(0, -suffix.length);
  if (!directory) directory = '/';
  if (/^[A-Za-z]:$/.test(directory)) directory += '/';
  return { directory, path: `${prefix}/${parts.name}` };
};
