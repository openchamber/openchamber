import type { FileNode } from './fileViewTypes';

export const getParentDirectoryPath = (path: string): string => {
  const normalized = normalizePath(path);
  if (!normalized) return '';
  if (normalized === '/' || /^[A-Za-z]:\/$/.test(normalized)) {
    return normalized;
  }

  const lastSlash = normalized.lastIndexOf('/');
  if (lastSlash < 0) {
    return normalized;
  }
  if (lastSlash === 0) {
    return '/';
  }

  const parent = normalized.slice(0, lastSlash);
  if (/^[A-Za-z]:$/.test(parent)) {
    return `${parent}/`;
  }
  return parent;
};

export const sortNodes = (items: FileNode[]) =>
  items.slice().sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === 'directory' ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });

export const normalizePath = (value: string): string => {
  if (!value) return '';

  const raw = value.replace(/\\/g, '/');
  const hadUncPrefix = raw.startsWith('//');

  let normalized = raw.replace(/\/+/g, '/');
  if (hadUncPrefix && !normalized.startsWith('//')) {
    normalized = `/${normalized}`;
  }

  const isUnixRoot = normalized === '/';
  const isWindowsDriveRoot = /^[A-Za-z]:\/$/.test(normalized);
  if (!isUnixRoot && !isWindowsDriveRoot) {
    normalized = normalized.replace(/\/+$/, '');
  }

  return normalized;
};

export const isAbsolutePath = (value: string): boolean => {
  return value.startsWith('/') || value.startsWith('//') || /^[A-Za-z]:\//.test(value);
};

export const toComparablePath = (value: string): string => {
  if (/^[A-Za-z]:\//.test(value)) {
    return value.toLowerCase();
  }
  return value;
};

export const isPathWithinRoot = (path: string, root: string): boolean => {
  const normalizedRoot = normalizePath(root);
  const normalizedPath = normalizePath(path);
  if (!normalizedRoot || !normalizedPath) return false;

  const comparableRoot = toComparablePath(normalizedRoot);
  const comparablePath = toComparablePath(normalizedPath);
  if (comparablePath === comparableRoot) return true;
  const prefix = comparableRoot.endsWith('/') ? comparableRoot : `${comparableRoot}/`;
  return comparablePath.startsWith(prefix);
};

export const getAncestorPaths = (filePath: string, root: string): string[] => {
  const normalizedRoot = normalizePath(root);
  const normalizedFile = normalizePath(filePath);

  if (!isPathWithinRoot(normalizedFile, normalizedRoot)) return [];

  const relative = normalizedFile.slice(normalizedRoot.length).replace(/^\//, '');
  const parts = relative.split('/');
  const ancestors: string[] = [];
  let current = normalizedRoot;

  for (let i = 0; i < parts.length - 1; i++) {
    current = current.endsWith('/') ? `${current}${parts[i]}` : `${current}/${parts[i]}`;
    ancestors.push(current);
  }
  return ancestors;
};

export const getDisplayPath = (root: string | null, path: string): string => {
  if (!path) {
    return '';
  }

  const normalizedFilePath = normalizePath(path);
  if (!root || !isPathWithinRoot(normalizedFilePath, root)) {
    return normalizedFilePath;
  }

  const relative = normalizedFilePath.slice(root.length);
  return relative.startsWith('/') ? relative.slice(1) : relative;
};
