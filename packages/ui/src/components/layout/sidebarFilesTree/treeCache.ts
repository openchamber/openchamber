import { getRuntimeKey } from '@/lib/runtime-switch';
import type { FileNode } from './fileNode';

// Module-level per-root cache for the file tree. After P1.1 the component
// stays mounted across right-sidebar tab switches, so the cache also stays
// warm during that flow. The cache also survives the close-and-reopen flow
// (the component remounts but the Map is module-scoped) — without this, every
// sidebar reopen would re-list every expanded directory.
//
// LRU by touchedAt; cap is generous because large repos can have hundreds
// of expanded directories and each FileNode is small (~80 bytes). Stale
// roots are evicted on the next touch.
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
  // Touch on read promotes the key to the end of the Map's iteration order,
  // so the oldest (front) entry is the next eviction candidate.
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
