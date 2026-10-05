const WINDOWS_DRIVE_ROOT_PATTERN = /^[A-Za-z]:\/$/;
const WINDOWS_DRIVE_ABSOLUTE_PATTERN = /^[A-Za-z]:\//;

export const normalizeFilePath = (value: string | null | undefined): string => {
  if (typeof value !== 'string') {
    return '';
  }

  const trimmed = value.trim();
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

export const isAbsoluteFilePath = (value: string | null | undefined): boolean => {
  const normalized = normalizeFilePath(value);
  return normalized.startsWith('/') || WINDOWS_DRIVE_ABSOLUTE_PATTERN.test(normalized);
};

const toComparableFilePath = (value: string | null | undefined): string => {
  const normalized = normalizeFilePath(value);
  return WINDOWS_DRIVE_ABSOLUTE_PATTERN.test(normalized) || normalized.startsWith('//')
    ? normalized.toLowerCase()
    : normalized;
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

export const toAbsoluteFilePath = (basePath: string | null | undefined, targetPath: string | null | undefined): string => {
  const normalizedTarget = normalizeFilePath(targetPath);
  if (!normalizedTarget) {
    return normalizeFilePath(basePath);
  }

  if (isAbsoluteFilePath(normalizedTarget)) {
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

export const isFilePathWithinDirectory = (filePath: string | null | undefined, directory: string | null | undefined): boolean => {
  const normalizedFilePath = normalizeFilePath(filePath);
  const normalizedDirectory = normalizeFilePath(directory);
  if (!normalizedFilePath || !normalizedDirectory) {
    return false;
  }

  const comparablePath = toComparableFilePath(normalizedFilePath);
  const comparableDirectory = toComparableFilePath(normalizedDirectory);
  return comparablePath === comparableDirectory || comparablePath.startsWith(`${comparableDirectory}/`);
};

export const getRelativeFilePath = (filePath: string | null | undefined, directory: string | null | undefined): string => {
  const normalizedFilePath = normalizeFilePath(filePath);
  const normalizedDirectory = normalizeFilePath(directory);
  if (!normalizedFilePath) {
    return '';
  }

  if (!normalizedDirectory) {
    return normalizedFilePath;
  }

  if (toComparableFilePath(normalizedFilePath) === toComparableFilePath(normalizedDirectory)) {
    return '.';
  }

  if (!isFilePathWithinDirectory(normalizedFilePath, normalizedDirectory)) {
    return normalizedFilePath;
  }

  return normalizedFilePath.slice(normalizedDirectory.length + 1);
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
