import { normalizePath } from './fileViewPaths';

const DEFAULT_IGNORED_DIR_NAMES = new Set(['node_modules']);

export const shouldIgnoreEntryName = (name: string): boolean => DEFAULT_IGNORED_DIR_NAMES.has(name);

export const shouldIgnorePath = (path: string): boolean => {
  const normalized = normalizePath(path);
  return normalized === 'node_modules' || normalized.endsWith('/node_modules') || normalized.includes('/node_modules/');
};

export const isDirectoryReadError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const normalized = message.toLowerCase();
  return normalized.includes('is a directory') || normalized.includes('eisdir');
};
