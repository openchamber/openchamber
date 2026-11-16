const WINDOWS_DRIVE_ROOT_PATTERN = /^[A-Za-z]:\/$/;
const WINDOWS_DRIVE_ABSOLUTE_PATTERN = /^[A-Za-z]:\//;

type FilePathOptions = { preserveWhitespace?: boolean };

export const normalizeFilePath = (value: string | null | undefined, options?: FilePathOptions): string => {
  if (typeof value !== 'string') {
    return '';
  }

  const trimmed = options?.preserveWhitespace ? value : value.trim();
  if (!trimmed) {
    return '';
  }

  const withSlashes = trimmed.replace(/\\/g, '/');
  // A markdown href can carry a bare Windows drive reference in RFC 8089
  // E.2.1 form (`/C:/...`); Windows would read the leading slash as part of
  // the path (`C:\C:\...`). Drop it the same way a `file:///C:/` URL is
  // handled. UNC (`//server/share`) and `\\?\` device paths keep their prefix.
  const withoutDriveSlash = /^\/[A-Za-z]:\//.test(withSlashes) ? withSlashes.slice(1) : withSlashes;
  const hadUncPrefix = withoutDriveSlash.startsWith('//');
  let normalized = withoutDriveSlash.replace(/\/+/g, '/');

  if (hadUncPrefix && !normalized.startsWith('//')) {
    normalized = `/${normalized}`;
  }

  const isUnixRoot = normalized === '/';
  const isWindowsDriveRoot = WINDOWS_DRIVE_ROOT_PATTERN.test(normalized);
  if (!isUnixRoot && !isWindowsDriveRoot) {
    normalized = normalized.replace(/\/+$/, '');
  }

  return normalized;
};

export const isAbsoluteFilePath = (value: string | null | undefined, options?: FilePathOptions): boolean => {
  const normalized = normalizeFilePath(value, options);
  return normalized.startsWith('/') || WINDOWS_DRIVE_ABSOLUTE_PATTERN.test(normalized);
};

const isCaseInsensitiveFilePath = (normalized: string): boolean => (
  WINDOWS_DRIVE_ABSOLUTE_PATTERN.test(normalized) || normalized.startsWith('//')
);

const toComparableFilePath = (value: string | null | undefined, options?: FilePathOptions): string => {
  const normalized = normalizeFilePath(value, options);
  return isCaseInsensitiveFilePath(normalized) ? normalized.toLowerCase() : normalized;
};

const splitPathParts = (value: string): string[] => value.split('/').filter(Boolean);

const applyRelativeParts = (baseParts: string[], relativePath: string): string[] => {
  const stack = [...baseParts];
  for (const part of splitPathParts(relativePath)) {
    if (part === '.') {
      continue;
    }
    if (part === '..') {
      if (stack.length > 0) {
        stack.pop();
      }
      continue;
    }
    stack.push(part);
  }
  return stack;
};

export const toAbsoluteFilePath = (basePath: string | null | undefined, targetPath: string | null | undefined, options?: FilePathOptions): string => {
  const normalizedTarget = normalizeFilePath(targetPath, options);
  if (!normalizedTarget) {
    return normalizeFilePath(basePath);
  }

  if (isAbsoluteFilePath(normalizedTarget, options)) {
    return normalizedTarget;
  }

  const normalizedBase = normalizeFilePath(basePath);
  if (!normalizedBase) {
    return normalizedTarget;
  }

  const drivePrefix = WINDOWS_DRIVE_ABSOLUTE_PATTERN.test(normalizedBase) ? normalizedBase.slice(0, 2) : '';
  const isUncBase = normalizedBase.startsWith('//');
  const isUnixBase = normalizedBase.startsWith('/') && !isUncBase;
  const baseRemainder = drivePrefix ? normalizedBase.slice(2) : normalizedBase;
  const parts = applyRelativeParts(splitPathParts(baseRemainder), normalizedTarget);
  const joined = parts.join('/');

  if (drivePrefix) {
    return joined ? `${drivePrefix}/${joined}` : `${drivePrefix}/`;
  }

  if (isUncBase) {
    return `//${joined}`;
  }

  if (isUnixBase) {
    return `/${joined}`;
  }

  return joined;
};

export const isFilePathWithinDirectory = (filePath: string | null | undefined, directory: string | null | undefined, options?: FilePathOptions): boolean => {
  const normalizedFilePath = normalizeFilePath(filePath, options);
  const normalizedDirectory = normalizeFilePath(directory);
  if (!normalizedFilePath || !normalizedDirectory) {
    return false;
  }

  const comparablePath = toComparableFilePath(normalizedFilePath, options);
  const comparableDirectory = toComparableFilePath(normalizedDirectory);
  return comparablePath === comparableDirectory || comparablePath.startsWith(`${comparableDirectory}/`);
};

export const getRelativeFilePath = (filePath: string | null | undefined, directory: string | null | undefined, options?: FilePathOptions): string => {
  const normalizedFilePath = normalizeFilePath(filePath, options);
  const normalizedDirectory = normalizeFilePath(directory);
  if (!normalizedFilePath) {
    return '';
  }

  if (!normalizedDirectory) {
    return normalizedFilePath;
  }

  if (toComparableFilePath(normalizedFilePath, options) === toComparableFilePath(normalizedDirectory)) {
    return '.';
  }

  if (!isFilePathWithinDirectory(normalizedFilePath, normalizedDirectory, options)) {
    return normalizedFilePath;
  }

  return normalizedFilePath.slice(normalizedDirectory.length + 1);
};

const endsWithPath = (path: string, tail: string): boolean => path === tail || path.endsWith(`/${tail}`);

/**
 * Whether a path git reports names an absolute file. Git answers relative to
 * the repository's top, which can sit above `directory` (a project in a
 * subfolder of a repository), so inside `directory` the listed path has to end
 * with the file's path there: `vendor/README.md` is not the root's `README.md`.
 * A file outside `directory` can only be told by the end of its own path.
 */
export const isSameRepoFile = (
  filePath: string | null | undefined,
  directory: string | null | undefined,
  repoPath: string | null | undefined,
): boolean => {
  const normalizedPath = normalizeFilePath(filePath);
  const normalizedRepoPath = normalizeFilePath(repoPath);
  if (!normalizedPath || !normalizedRepoPath) {
    return false;
  }

  const [path, listed, base] = isCaseInsensitiveFilePath(normalizedPath)
    ? [normalizedPath.toLowerCase(), normalizedRepoPath.toLowerCase(), normalizeFilePath(directory).toLowerCase()]
    : [normalizedPath, normalizedRepoPath, normalizeFilePath(directory)];
  return isFilePathWithinDirectory(path, base)
    ? endsWithPath(listed, getRelativeFilePath(path, base))
    : endsWithPath(path, listed);
};

/**
 * The entry of a git listing that names an absolute file. Several can match,
 * since the root's `a.md` also matches a listed `docs/a.md`. The longest entry
 * the file's whole path ends with is the exact one; the shortest match stands
 * in when none does, as with a file reached through a symlink.
 */
export const findRepoFile = (
  filePath: string | null | undefined,
  directory: string | null | undefined,
  repoPaths: readonly string[],
): string | undefined => {
  const matches = repoPaths
    .filter((repoPath) => isSameRepoFile(filePath, directory, repoPath))
    .sort((a, b) => a.length - b.length);
  return matches.filter((repoPath) => isSameRepoFile(filePath, null, repoPath)).at(-1) ?? matches[0];
};

const sameParts = (a: readonly string[], b: readonly string[]): boolean => (
  a.length === b.length && a.every((part, index) => part === b[index])
);

/**
 * Folders that tell apart open files sharing a name, keyed by the given path.
 * Each path gets the shortest run of its closest folders no other same-named
 * path ends with ("docs", "ui/src"). Files with a unique name, and a file that
 * has no folders of its own (the project root), get no entry. Pass paths
 * relative to the project, or the whole absolute path becomes the folder.
 */
export const getDisambiguatingFolders = (paths: readonly string[]): Map<string, string> => {
  const byName = new Map<string, { path: string; folders: string[] }[]>();
  for (const path of new Set(paths)) {
    const parts = splitPathParts(normalizeFilePath(path));
    const name = parts.pop();
    if (!name) continue;
    const group = byName.get(name) ?? [];
    group.push({ path, folders: parts });
    byName.set(name, group);
  }

  const result = new Map<string, string>();
  for (const group of byName.values()) {
    if (group.length < 2) continue;
    for (const entry of group) {
      const { folders } = entry;
      let depth = 1;
      while (depth < folders.length) {
        const tail = folders.slice(-depth);
        const clashes = group.some((other) => other !== entry && sameParts(other.folders.slice(-depth), tail));
        if (!clashes) break;
        depth += 1;
      }
      if (folders.length > 0) {
        result.set(entry.path, folders.slice(-depth).join('/'));
      }
    }
  }
  return result;
};

export const getDirectoryForFilePath = (currentDirectory: string | null | undefined, filePath: string | null | undefined): string => {
  const normalizedDirectory = normalizeFilePath(currentDirectory);
  const normalizedPath = normalizeFilePath(filePath);
  if (normalizedDirectory && (!normalizedPath || isFilePathWithinDirectory(normalizedPath, normalizedDirectory))) {
    return normalizedDirectory;
  }

  if (!normalizedPath) {
    return normalizedDirectory;
  }

  const lastSlash = normalizedPath.lastIndexOf('/');
  if (lastSlash === 0) {
    return '/';
  }
  if (lastSlash < 0) {
    return normalizedDirectory || normalizedPath;
  }

  if (/^[A-Za-z]:\//.test(normalizedPath) && lastSlash === 2) {
    return normalizedPath.slice(0, 3);
  }

  return normalizedPath.slice(0, lastSlash);
};
