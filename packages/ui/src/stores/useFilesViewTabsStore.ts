import { create } from 'zustand';
import { createJSONStorage, devtools, persist } from 'zustand/middleware';

import { getSafeStorage } from './utils/safeStorage';

type RootTabsState = {
  openPaths: string[];
  selectedPath: string | null;
  expandedPaths: string[];
  touchedAt: number;
};

type FilesViewTabsState = {
  byRoot: Record<string, RootTabsState>;
};

type FilesViewTabsActions = {
  addOpenPath: (root: string, path: string) => void;
  removeOpenPath: (root: string, path: string) => void;
  removeOpenPathsByPrefix: (root: string, prefixPath: string) => void;
  setSelectedPath: (root: string, path: string | null) => void;
  ensureSelectedPath: (root: string) => void;
  toggleExpandedPath: (root: string, path: string) => void;
  expandPath: (root: string, path: string) => void;
  expandPaths: (root: string, paths: string[]) => void;
};

export type FilesViewTabsStore = FilesViewTabsState & FilesViewTabsActions;

const normalizePath = (value: string): string => {
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

const toComparablePath = (value: string): string => {
  if (/^[A-Za-z]:\//.test(value)) {
    return value.toLowerCase();
  }
  return value;
};

const isPathWithinRoot = (path: string, root: string): boolean => {
  const normalizedRoot = normalizePath(root);
  const normalizedPath = normalizePath(path);
  if (!normalizedRoot || !normalizedPath) return false;

  const comparableRoot = toComparablePath(normalizedRoot);
  const comparablePath = toComparablePath(normalizedPath);
  return comparablePath === comparableRoot || comparablePath.startsWith(`${comparableRoot}/`);
};

const sanitizeByRoot = (input: unknown): Record<string, RootTabsState> => {
  if (!input || typeof input !== 'object') {
    return {};
  }

  const source = input as Record<string, unknown>;
  const next: Record<string, RootTabsState> = {};

  for (const [rawRoot, rawState] of Object.entries(source)) {
    const root = normalizePath(rawRoot);
    if (!root || !rawState || typeof rawState !== 'object') {
      continue;
    }

    const state = rawState as {
      openPaths?: unknown;
      selectedPath?: unknown;
      expandedPaths?: unknown;
      touchedAt?: unknown;
    };

    const openPaths = Array.isArray(state.openPaths)
      ? Array.from(new Set(state.openPaths
        .filter((value): value is string => typeof value === 'string')
        .map((value) => normalizePath(value))
        .filter((value) => isPathWithinRoot(value, root))))
      : [];

    const expandedPaths = Array.isArray(state.expandedPaths)
      ? Array.from(new Set(state.expandedPaths
        .filter((value): value is string => typeof value === 'string')
        .map((value) => normalizePath(value))
        .filter((value) => isPathWithinRoot(value, root))))
      : [];

    const selectedPathCandidate = typeof state.selectedPath === 'string'
      ? normalizePath(state.selectedPath)
      : null;

    const selectedPath = selectedPathCandidate && isPathWithinRoot(selectedPathCandidate, root)
      ? selectedPathCandidate
      : (openPaths[0] ?? null);

    const touchedAt = typeof state.touchedAt === 'number' && Number.isFinite(state.touchedAt)
      ? state.touchedAt
      : Date.now();

    const existing = next[root];
    if (existing) {
      const mergedOpenPaths = Array.from(new Set([...existing.openPaths, ...openPaths]));
      const mergedExpandedPaths = Array.from(new Set([...existing.expandedPaths, ...expandedPaths]));
      const mergedSelectedPath = existing.selectedPath ?? selectedPath ?? (mergedOpenPaths[0] ?? null);
      next[root] = {
        openPaths: mergedOpenPaths,
        selectedPath: mergedSelectedPath,
        expandedPaths: mergedExpandedPaths,
        touchedAt: Math.max(existing.touchedAt, touchedAt),
      };
      continue;
    }

    next[root] = {
      openPaths,
      selectedPath,
      expandedPaths,
      touchedAt,
    };
  }

  return next;
};

const clampRoots = (byRoot: Record<string, RootTabsState>, maxRoots: number): Record<string, RootTabsState> => {
  const entries = Object.entries(byRoot);
  if (entries.length <= maxRoots) {
    return byRoot;
  }

  entries.sort((a, b) => (b[1]?.touchedAt ?? 0) - (a[1]?.touchedAt ?? 0));
  const next: Record<string, RootTabsState> = {};
  for (const [root, state] of entries.slice(0, maxRoots)) {
    next[root] = state;
  }
  return next;
};

const touchRoot = (prev: RootTabsState | undefined): RootTabsState => {
  if (prev) {
    return { ...prev, touchedAt: Date.now() };
  }
  return { openPaths: [], selectedPath: null, expandedPaths: [], touchedAt: Date.now() };
};

export const useFilesViewTabsStore = create<FilesViewTabsStore>()(
  devtools(
    persist(
      (set, get) => ({
        byRoot: {},

        addOpenPath: (root, path) => {
          const normalizedRoot = normalizePath((root || '').trim());
          const normalizedPath = normalizePath((path || '').trim());
          if (!normalizedRoot || !normalizedPath || !isPathWithinRoot(normalizedPath, normalizedRoot)) {
            return;
          }

          set((state) => {
            const prev = state.byRoot[normalizedRoot];
            const current = touchRoot(prev);
            const exists = current.openPaths.includes(normalizedPath);
            const nextOpenPaths = exists ? current.openPaths : [...current.openPaths, normalizedPath];
            const nextSelectedPath = current.selectedPath ?? normalizedPath;

            if (prev && exists && prev.selectedPath === nextSelectedPath) {
              return state;
            }
            const byRoot = {
              ...state.byRoot,
              [normalizedRoot]: {
                ...current,
                openPaths: nextOpenPaths,
                selectedPath: nextSelectedPath,
              },
            };
            return { byRoot: clampRoots(byRoot, 20) };
          });
        },

        removeOpenPath: (root, path) => {
          const normalizedRoot = normalizePath((root || '').trim());
          const normalizedPath = normalizePath((path || '').trim());
          if (!normalizedRoot || !normalizedPath) {
            return;
          }

          set((state) => {
            const current = state.byRoot[normalizedRoot];
            if (!current) {
              return state;
            }

            const comparablePath = toComparablePath(normalizedPath);
            const isMatchingPath = (candidate: string) => toComparablePath(candidate) === comparablePath;
            const selectedPathMatches = current.selectedPath ? isMatchingPath(current.selectedPath) : false;
            if (!current.openPaths.some(isMatchingPath) && !selectedPathMatches) {
              return state;
            }

            const openPaths = current.openPaths.filter((p) => !isMatchingPath(p));
            const selectedPath = selectedPathMatches ? (openPaths[0] ?? null) : current.selectedPath;

            const byRoot = {
              ...state.byRoot,
              [normalizedRoot]: {
                ...current,
                openPaths,
                selectedPath,
                touchedAt: Date.now(),
              },
            };
            return { byRoot: clampRoots(byRoot, 20) };
          });
        },

        removeOpenPathsByPrefix: (root, prefixPath) => {
          const normalizedRoot = normalizePath((root || '').trim());
          const normalizedPrefix = normalizePath((prefixPath || '').trim());
          if (!normalizedRoot || !normalizedPrefix) {
            return;
          }

          set((state) => {
            const current = state.byRoot[normalizedRoot];
            if (!current) {
              return state;
            }

            const comparablePrefix = toComparablePath(normalizedPrefix);
            const comparablePrefixWithSlash = comparablePrefix.endsWith('/') ? comparablePrefix : `${comparablePrefix}/`;
            const isWithinPrefix = (candidate: string) => {
              const comparablePath = toComparablePath(candidate);
              return comparablePath === comparablePrefix || comparablePath.startsWith(comparablePrefixWithSlash);
            };
            const openPaths = current.openPaths.filter((p) => !isWithinPrefix(p));
            if (openPaths.length === current.openPaths.length) {
              return state;
            }

            const selectedPath = current.selectedPath && isWithinPrefix(current.selectedPath)
              ? (openPaths[0] ?? null)
              : current.selectedPath;

            const byRoot = {
              ...state.byRoot,
              [normalizedRoot]: {
                ...current,
                openPaths,
                selectedPath,
                touchedAt: Date.now(),
              },
            };

            return { byRoot: clampRoots(byRoot, 20) };
          });
        },

        setSelectedPath: (root, path) => {
          const normalizedRoot = normalizePath((root || '').trim());
          const normalizedPath = path ? normalizePath(path.trim()) : null;
          if (!normalizedRoot || (normalizedPath && !isPathWithinRoot(normalizedPath, normalizedRoot))) {
            return;
          }

          set((state) => {
            const prev = state.byRoot[normalizedRoot];
            const current = touchRoot(prev);
            const openPaths = normalizedPath && !current.openPaths.includes(normalizedPath)
              ? [...current.openPaths, normalizedPath]
              : current.openPaths;

            if (prev && prev.selectedPath === normalizedPath && openPaths === prev.openPaths) {
              return state;
            }

            const byRoot = {
              ...state.byRoot,
              [normalizedRoot]: {
                ...current,
                openPaths,
                selectedPath: normalizedPath,
              },
            };
            return { byRoot: clampRoots(byRoot, 20) };
          });
        },

        ensureSelectedPath: (root) => {
          const normalizedRoot = normalizePath((root || '').trim());
          if (!normalizedRoot) {
            return;
          }

          const current = get().byRoot[normalizedRoot];
          if (!current || current.selectedPath) {
            return;
          }

          const first = current.openPaths[0] ?? null;
          if (!first) {
            return;
          }

          get().setSelectedPath(normalizedRoot, first);
        },

        toggleExpandedPath: (root, path) => {
          const normalizedRoot = normalizePath((root || '').trim());
          const normalizedPath = normalizePath((path || '').trim());
          if (!normalizedRoot || !normalizedPath || !isPathWithinRoot(normalizedPath, normalizedRoot)) {
            return;
          }

          set((state) => {
            const prev = state.byRoot[normalizedRoot];
            const current = touchRoot(prev);
            const isExpanded = current.expandedPaths.includes(normalizedPath);
            const nextExpandedPaths = isExpanded
              ? current.expandedPaths.filter((p) => p !== normalizedPath)
              : [...current.expandedPaths, normalizedPath];

            if (prev && prev.expandedPaths === nextExpandedPaths && prev.selectedPath === current.selectedPath && prev.openPaths === current.openPaths) {
              return state;
            }

            const byRoot = {
              ...state.byRoot,
              [normalizedRoot]: {
                ...current,
                expandedPaths: nextExpandedPaths,
              },
            };
            return { byRoot: clampRoots(byRoot, 20) };
          });
        },

        expandPath: (root, path) => {
          const normalizedRoot = normalizePath((root || '').trim());
          const normalizedPath = normalizePath((path || '').trim());
          if (!normalizedRoot || !normalizedPath || !isPathWithinRoot(normalizedPath, normalizedRoot)) {
            return;
          }

          set((state) => {
            const prev = state.byRoot[normalizedRoot];
            const current = touchRoot(prev);
            const isExpanded = current.expandedPaths.includes(normalizedPath);

            if (isExpanded && prev) {
              return state;
            }

            const byRoot = {
              ...state.byRoot,
              [normalizedRoot]: {
                ...current,
                expandedPaths: [...current.expandedPaths, normalizedPath],
              },
            };
            return { byRoot: clampRoots(byRoot, 20) };
          });
        },

        expandPaths: (root, paths) => {
          const normalizedRoot = normalizePath((root || '').trim());
          if (!normalizedRoot || !paths || paths.length === 0) {
            return;
          }

          const normalizedPaths = paths
            .map((p) => normalizePath((p || '').trim()))
            .filter((p) => p && isPathWithinRoot(p, normalizedRoot));
          if (normalizedPaths.length === 0) {
            return;
          }

          set((state) => {
            const prev = state.byRoot[normalizedRoot];
            const current = touchRoot(prev);
            const existingPaths = new Set(current.expandedPaths);
            const newPaths = normalizedPaths.filter((p) => !existingPaths.has(p));

            if (newPaths.length === 0) {
              return state;
            }

            const byRoot = {
              ...state.byRoot,
              [normalizedRoot]: {
                ...current,
                expandedPaths: [...current.expandedPaths, ...newPaths],
              },
            };
            return { byRoot: clampRoots(byRoot, 20) };
          });
        },
      }),
      {
        name: 'files-view-tabs-store',
        version: 2,
        storage: createJSONStorage(() => getSafeStorage()),
        migrate: (persistedState) => {
          if (!persistedState || typeof persistedState !== 'object') {
            return { byRoot: {} };
          }

          const rawByRoot = (persistedState as { byRoot?: unknown }).byRoot;
          return {
            byRoot: sanitizeByRoot(rawByRoot),
          };
        },
        partialize: (state) => ({ byRoot: state.byRoot }),
      }
    ),
    { name: 'files-view-tabs-store' }
  )
);
