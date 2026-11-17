import { getRuntimeKey } from '@/lib/runtime-switch';
import type { FileNode } from './fileNode';

type FileTreeCache = {
  childrenByDir: Record<string, FileNode[]>;
  loadErrorsByDir: Record<string, string>;
  loadedDirs: Set<string>;
  touchedAt: number;
};
const FILE_TREE_CACHE_MAX_ROOTS = 8;
export const fileTreeCacheByRoot = new Map<string, FileTreeCache>();
export const fileTreeCacheKey = (root: string): string => JSON.stringify([getRuntimeKey(), root]);

export const touchCache = (root: string): FileTreeCache | null => {
  const key = fileTreeCacheKey(root);
  const entry = fileTreeCacheByRoot.get(key);
  if (!entry) return null;
  entry.touchedAt = Date.now();
  fileTreeCacheByRoot.delete(key);
  fileTreeCacheByRoot.set(key, entry);
  return entry;
};

export const getOrCreateCache = (root: string): FileTreeCache => {
  const key = fileTreeCacheKey(root);
  const existing = fileTreeCacheByRoot.get(key);
  if (existing) {
    existing.touchedAt = Date.now();
    return existing;
  }
  if (fileTreeCacheByRoot.size >= FILE_TREE_CACHE_MAX_ROOTS) {
    const oldest = fileTreeCacheByRoot.keys().next().value;
    if (oldest !== undefined) {
      fileTreeCacheByRoot.delete(oldest);
    }
  }
  const created: FileTreeCache = {
    childrenByDir: {},
    loadErrorsByDir: {},
    loadedDirs: new Set(),
    touchedAt: Date.now(),
  };
  fileTreeCacheByRoot.set(key, created);
  return created;
};
