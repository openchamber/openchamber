export const normalizePath = (value: string): string => {
  if (!value) return '';

  const raw = value.replace(/\\/g, '/');
  const hadUncPrefix = raw.startsWith('//');

  let normalized = raw.replace(/\/+$/g, '');
  normalized = normalized.replace(/\/+/g, '/');
  if (hadUncPrefix && !normalized.startsWith('//')) {
    normalized = `/${normalized}`;
  }

  if (normalized === '') {
    return raw.startsWith('/') ? '/' : '';
  }

  return normalized;
};

export const getRelativePath = (root: string, path: string): string => {
  const normalizedPath = normalizePath(path);
  const normalizedRoot = normalizePath(root).replace(/\/+$/, '');
  if (normalizedPath === normalizedRoot) {
    return '.';
  }
  if (!normalizedRoot || !normalizedPath.startsWith(`${normalizedRoot}/`)) {
    return normalizedPath;
  }
  return normalizedPath.slice(normalizedRoot.length + 1);
};

export const getDropTargetLabel = (root: string, target: string): string => {
  const relativePath = getRelativePath(root, target);
  if (relativePath !== '.') return relativePath;

  const normalizedRoot = normalizePath(root);
  return normalizedRoot.split('/').filter(Boolean).pop() ?? normalizedRoot;
};

export const getParentPath = (value: string): string => {
  const normalized = normalizePath(value);
  const separatorIndex = normalized.lastIndexOf('/');
  if (separatorIndex < 0) return '';
  if (separatorIndex === 0) return '/';
  return normalized.slice(0, separatorIndex);
};

export const isAbsolutePath = (value: string): boolean => {
  return value.startsWith('/') || value.startsWith('//') || /^[A-Za-z]:\//.test(value);
};

const DEFAULT_IGNORED_DIR_NAMES = new Set(['node_modules']);

export const shouldIgnoreEntryName = (name: string): boolean => DEFAULT_IGNORED_DIR_NAMES.has(name);

export const shouldIgnorePath = (path: string): boolean => {
  const normalized = normalizePath(path);
  return normalized === 'node_modules' || normalized.endsWith('/node_modules') || normalized.includes('/node_modules/');
};
