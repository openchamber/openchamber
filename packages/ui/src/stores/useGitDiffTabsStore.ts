import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';
import type { GitCommitDiffTarget, PendingDiffScope } from './useUIStore';
import { createDeferredSafeJSONStorage } from './utils/safeStorage';

type GitDiffTabDescriptor =
  | { kind: 'working'; path: string; scope: PendingDiffScope }
  | { kind: 'commit'; target: GitCommitDiffTarget };

export type GitDiffTab =
  | { kind: 'working'; path: string; scope: PendingDiffScope; id: string; touchedAt: number }
  | { kind: 'commit'; target: GitCommitDiffTarget; id: string; touchedAt: number };

export type DirectoryState = { tabs: GitDiffTab[]; activeTabId: string | null };

type State = { byDirectory: Record<string, DirectoryState> };

type Actions = {
  openTab: (directory: string, descriptor: GitDiffTabDescriptor) => void;
  closeTab: (directory: string, id: string) => void;
  setActiveTab: (directory: string, id: string) => void;
  reorderTabs: (directory: string, activeId: string, overId: string) => void;
  updateWorkingScope: (directory: string, id: string, scope: PendingDiffScope) => void;
  clearDirectory: (directory: string) => void;
};

type GitDiffTabsStore = State & Actions;

const MAX_TABS_PER_DIRECTORY = 12;
const MAX_DIRECTORIES = 20;

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

const getTabId = (descriptor: GitDiffTabDescriptor): string => {
  if (descriptor.kind === 'working') {
    return `working:${descriptor.path}`;
  }
  return `commit:${descriptor.target.commitHash}:${descriptor.target.file.path}`;
};

const sanitizeByDirectory = (input: unknown): Record<string, DirectoryState> => {
  if (!input || typeof input !== 'object') {
    return {};
  }

  const source = input as Record<string, unknown>;
  const next: Record<string, DirectoryState> = {};

  for (const [rawDir, rawState] of Object.entries(source)) {
    const directory = normalizePath(rawDir);
    if (!directory || !rawState || typeof rawState !== 'object') {
      continue;
    }

    const state = rawState as {
      tabs?: unknown;
      activeTabId?: unknown;
    };

    const tabs = Array.isArray(state.tabs)
      ? state.tabs
        .filter((item): item is unknown => item !== null && item !== undefined)
        .filter((item): item is GitDiffTab => {
          if (typeof item !== 'object' || item === null) return false;
          const tab = item as Record<string, unknown>;
          const id = tab.id;
          const kind = tab.kind;
          const touchedAt = tab.touchedAt;

          if (typeof id !== 'string' || !id) return false;
          if (typeof kind !== 'string' || (kind !== 'working' && kind !== 'commit')) return false;
          if (typeof touchedAt !== 'number' || !Number.isFinite(touchedAt)) return false;

          if (kind === 'working') {
            const path = tab.path;
            const scope = tab.scope;
            if (typeof path === 'string' && path.length > 0 && typeof scope === 'string') {
              return true;
            }
            return false;
          }

          if (kind === 'commit') {
            const target = tab.target;
            if (target && typeof target === 'object') {
              return true;
            }
            return false;
          }

          return false;
        })
      : [];

    const activeTabId = typeof state.activeTabId === 'string' && state.activeTabId.length > 0
      ? state.activeTabId
      : null;

    if (tabs.length === 0) {
      continue;
    }

    next[directory] = {
      tabs,
      activeTabId,
    };
  }

  return clampDirectories(next, MAX_DIRECTORIES);
};

const clampDirectories = (
  byDirectory: Record<string, DirectoryState>,
  maxDirectories: number,
): Record<string, DirectoryState> => {
  const entries = Object.entries(byDirectory);
  if (entries.length <= maxDirectories) {
    return byDirectory;
  }

  entries.sort((a, b) => {
    const aTime = Math.max(...(a[1]?.tabs ?? []).map((t) => t.touchedAt), 0);
    const bTime = Math.max(...(b[1]?.tabs ?? []).map((t) => t.touchedAt), 0);
    return bTime - aTime;
  });

  const next: Record<string, DirectoryState> = {};
  for (const [dir, state] of entries.slice(0, maxDirectories)) {
    next[dir] = state;
  }
  return next;
};

const clampTabs = (
  tabs: GitDiffTab[],
  maxTabs: number,
  activeTabId: string | null,
): GitDiffTab[] => {
  if (tabs.length <= maxTabs) {
    return tabs;
  }

  const sorted = [...tabs].sort((a, b) => b.touchedAt - a.touchedAt);
  const active = sorted.find((t) => t.id === activeTabId);

  if (active) {
    const withoutActive = sorted.filter((t) => t.id !== activeTabId);
    return [active, ...withoutActive.slice(0, maxTabs - 1)];
  }

  return sorted.slice(0, maxTabs);
};

export const useGitDiffTabsStore = create<GitDiffTabsStore>()(
  devtools(
    persist(
      (set) => ({
        byDirectory: {},

        openTab: (directory, descriptor) => {
          const normalizedDir = normalizePath((directory || '').trim());
          if (!normalizedDir) {
            return;
          }

          set((state) => {
            const tabId = getTabId(descriptor);
            const current = state.byDirectory[normalizedDir];
            const existingTabIndex = current?.tabs.findIndex((t) => t.id === tabId) ?? -1;

            const tab: GitDiffTab = {
              ...descriptor,
              id: tabId,
              touchedAt: Date.now(),
            };

            let tabs: GitDiffTab[];
            if (existingTabIndex === -1) {
              tabs = [...(current?.tabs ?? []), tab];
            } else {
              tabs = current!.tabs.map((t, i) =>
                i === existingTabIndex
                  ? { ...tab, touchedAt: Date.now() }
                  : t,
              );
            }

            tabs = clampTabs(tabs, MAX_TABS_PER_DIRECTORY, tabId);

            const byDirectory = {
              ...state.byDirectory,
              [normalizedDir]: {
                tabs,
                activeTabId: tabId,
              },
            };

            return { byDirectory: clampDirectories(byDirectory, MAX_DIRECTORIES) };
          });
        },

        closeTab: (directory, id) => {
          const normalizedDir = normalizePath((directory || '').trim());
          if (!normalizedDir || !id) {
            return;
          }

          set((state) => {
            const current = state.byDirectory[normalizedDir];
            if (!current) {
              return state;
            }

            const nextTabs = current.tabs.filter((t) => t.id !== id);
            if (nextTabs.length === current.tabs.length) {
              return state;
            }

            let activeTabId: string | null;
            if (current.activeTabId === id) {
              const mostRecent = nextTabs.length > 0
                ? nextTabs.reduce((a, b) => (b.touchedAt > a.touchedAt ? b : a))
                : null;
              activeTabId = mostRecent?.id ?? null;
            } else {
              activeTabId = current.activeTabId;
            }

            const byDirectory = {
              ...state.byDirectory,
              [normalizedDir]: {
                tabs: nextTabs,
                activeTabId,
              },
            };

            return { byDirectory };
          });
        },

        setActiveTab: (directory, id) => {
          const normalizedDir = normalizePath((directory || '').trim());
          if (!normalizedDir || !id) {
            return;
          }

          set((state) => {
            const current = state.byDirectory[normalizedDir];
            if (!current || current.activeTabId === id) {
              return state;
            }

            const tabExists = current.tabs.some((t) => t.id === id);
            if (!tabExists) {
              return state;
            }

            return {
              byDirectory: {
                ...state.byDirectory,
                [normalizedDir]: {
                  ...current,
                  activeTabId: id,
                },
              },
            };
          });
        },

        reorderTabs: (directory, activeId, overId) => {
          const normalizedDir = normalizePath((directory || '').trim());
          if (!normalizedDir || !activeId || !overId) {
            return;
          }

          set((state) => {
            const current = state.byDirectory[normalizedDir];
            if (!current) {
              return state;
            }

            const activeIndex = current.tabs.findIndex((t) => t.id === activeId);
            const overIndex = current.tabs.findIndex((t) => t.id === overId);

            if (activeIndex === -1 || overIndex === -1) {
              return state;
            }

            const nextTabs = [...current.tabs];
            [nextTabs[activeIndex], nextTabs[overIndex]] = [nextTabs[overIndex]!, nextTabs[activeIndex]!];

            return {
              byDirectory: {
                ...state.byDirectory,
                [normalizedDir]: {
                  ...current,
                  tabs: nextTabs,
                },
              },
            };
          });
        },

        updateWorkingScope: (directory, id, scope) => {
          const normalizedDir = normalizePath((directory || '').trim());
          if (!normalizedDir || !id) {
            return;
          }

          set((state) => {
            const current = state.byDirectory[normalizedDir];
            if (!current) {
              return state;
            }

            const tabIndex = current.tabs.findIndex((t) => t.id === id);
            if (tabIndex === -1) {
              return state;
            }

            const tab = current.tabs[tabIndex];
            if (tab?.kind !== 'working') {
              return state;
            }

            const nextTabs = current.tabs.map((t, i) =>
              i === tabIndex
                ? { ...t, scope }
                : t,
            );

            return {
              byDirectory: {
                ...state.byDirectory,
                [normalizedDir]: {
                  ...current,
                  tabs: nextTabs,
                },
              },
            };
          });
        },

        clearDirectory: (directory) => {
          const normalizedDir = normalizePath((directory || '').trim());
          if (!normalizedDir) {
            return;
          }

          set((state) => {
            const current = state.byDirectory[normalizedDir];
            if (!current) {
              return state;
            }

            return {
              byDirectory: {
                ...state.byDirectory,
                [normalizedDir]: {
                  ...current,
                  tabs: [],
                  activeTabId: null,
                },
              },
            };
          });
        },
      }),
      {
        name: 'git-diff-tabs-store',
        version: 1,
        storage: createDeferredSafeJSONStorage(),
        migrate: (persistedState, version) => {
          if (version < 1 || !persistedState || typeof persistedState !== 'object') {
            return { byDirectory: {} };
          }
          const state = persistedState as Partial<State>;
          return {
            byDirectory: sanitizeByDirectory(state.byDirectory),
          };
        },
        partialize: (state) => ({
          byDirectory: sanitizeByDirectory(state.byDirectory),
        }),
        merge: (persistedState, currentState) => {
          const persisted = persistedState && typeof persistedState === 'object'
            ? persistedState as Partial<State>
            : {};
          return {
            ...currentState,
            byDirectory: sanitizeByDirectory(persisted.byDirectory),
          };
        },
      },
    ),
    { name: 'git-diff-tabs-store' },
  ),
);
