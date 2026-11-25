import { getParentDirectoryPath, isAbsolutePath, normalizePath } from '@/components/views/files/view/fileViewPaths';

export { getParentDirectoryPath as getParentPath, isAbsolutePath, normalizePath };

export const getRootPrefix = (root: string): string => (root.endsWith('/') ? root : `${root}/`);

export const getRelativePath = (root: string, path: string): string => {
  const normalizedPath = normalizePath(path);
  if (normalizedPath === normalizePath(root)) {
    return '.';
  }
  const normalizedRoot = normalizePath(root).replace(/\/+$/, '');
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

const DEFAULT_IGNORED_DIR_NAMES = new Set(['node_modules']);

export const shouldIgnoreEntryName = (name: string): boolean => DEFAULT_IGNORED_DIR_NAMES.has(name);

export const shouldIgnorePath = (path: string): boolean => {
  const normalized = normalizePath(path);
  return normalized === 'node_modules' || normalized.endsWith('/node_modules') || normalized.includes('/node_modules/');
};
