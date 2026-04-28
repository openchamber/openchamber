import { create } from 'zustand';
import { devtools, persist, createJSONStorage } from 'zustand/middleware';

import { closeTerminal } from '@/lib/terminalApi';
import { getSafeSessionStorage } from '@/stores/utils/safeStorage';

export interface TerminalChunk {
  id: number;
  data: string;
}

export type TerminalTabLifecycle = 'idle' | 'running' | 'exited';

export type TerminalTab = {
  id: string;
  terminalSessionId: string | null;
  lifecycle: TerminalTabLifecycle;
  label: string;
  bufferChunks: TerminalChunk[];
  bufferLength: number;
  isConnecting: boolean;
  createdAt: number;
  previewUrl: string | null;
  previewAutoOpened: boolean;
};

export type DirectoryTerminalState = {
  tabs: TerminalTab[];
  activeTabId: string | null;
};

interface TerminalStore {
  sessions: Map<string, DirectoryTerminalState>;
  nextChunkId: number;
  nextTabId: number;
  hasHydrated: boolean;

  ensureDirectory: (directory: string) => void;
  getDirectoryState: (directory: string) => DirectoryTerminalState | undefined;
  getActiveTab: (directory: string) => TerminalTab | undefined;

  createTab: (directory: string) => string;
  setActiveTab: (directory: string, tabId: string) => void;
  setTabLabel: (directory: string, tabId: string, label: string) => void;
  closeTab: (directory: string, tabId: string) => Promise<void>;

  setTabSessionId: (directory: string, tabId: string, sessionId: string | null) => void;
  setTabLifecycle: (directory: string, tabId: string, lifecycle: TerminalTabLifecycle) => void;
  setConnecting: (directory: string, tabId: string, isConnecting: boolean) => void;
  appendToBuffer: (directory: string, tabId: string, chunk: string) => void;
  clearBuffer: (directory: string, tabId: string) => void;
  markPreviewAutoOpened: (directory: string, tabId: string) => void;

  removeDirectory: (directory: string) => void;
  clearAll: () => void;
}

const TERMINAL_BUFFER_LIMIT = 1_000_000;
const TERMINAL_STORE_NAME = 'terminal-store';
let hydrationListenerAttached = false;

type PersistedTerminalTab = Pick<TerminalTab, 'id' | 'label' | 'terminalSessionId' | 'lifecycle' | 'createdAt'>;

type PersistedDirectoryTerminalState = {
  tabs: PersistedTerminalTab[];
  activeTabId: string | null;
};

type PersistedTerminalStoreState = {
  sessions: Array<[string, PersistedDirectoryTerminalState]>;
  nextTabId: number;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const tabIdNumber = (tabId: string): number | null => {
  const match = /^tab-(\d+)$/.exec(tabId);
  if (!match) return null;
  const num = Number(match[1]);
  return Number.isFinite(num) ? num : null;
};

function normalizeDirectory(dir: string): string {
  let normalized = dir.trim();
  while (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

const createEmptyTab = (id: string, label: string): TerminalTab => ({
  id,
  terminalSessionId: null,
  lifecycle: 'idle',
  label,
  bufferChunks: [],
  bufferLength: 0,
  isConnecting: false,
  createdAt: Date.now(),
  previewUrl: null,
  previewAutoOpened: false,
});

// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_PATTERN = /\x1b\[[0-9;]*m/g;
// Many dev servers print loopback as 0.0.0.0, localhost, or IPv6 ([::]/[::1]).
const URL_PATTERN = /(https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[(?:::1|::)\])(?::\d{2,5})?(?:\/[\w\-./~%!$&'()*+,;=:@?#[\]]*)?)/i;

// Dev server logs frequently wrap URLs in punctuation, e.g.
//   "Local: http://localhost:5173/ (press h to show help)"
//   "Serving on (http://127.0.0.1:50028/)."
// The URL_PATTERN above intentionally allows sub-delim characters like `()`
// in the path (RFC 3986), which means greedy capture can swallow trailing
// closing brackets that were really part of the surrounding sentence.
// Peel off any trailing closer that has no matching opener inside the URL,
// plus common trailing sentence punctuation.
const TRAILING_PUNCT = new Set(['.', ',', ';', ':', '!', '?']);
const trimUrlTrailingPunctuation = (url: string): string => {
  let result = url;
  while (result.length > 0) {
    const last = result[result.length - 1];
    if (last === ')' || last === ']' || last === '}' || last === '>') {
      const opener = last === ')' ? '(' : last === ']' ? '[' : last === '}' ? '{' : '<';
      // Count matched pairs in the rest of the URL; if there's no unmatched
      // opener, the closer is from surrounding text — strip it.
      const head = result.slice(0, -1);
      const opens = (head.match(new RegExp(`\\${opener}`, 'g')) || []).length;
      const closes = (head.match(new RegExp(`\\${last}`, 'g')) || []).length;
      if (opens > closes) break;
      result = head;
      continue;
    }
    if (TRAILING_PUNCT.has(last)) {
      result = result.slice(0, -1);
      continue;
    }
    break;
  }
  return result;
};

const extractPreviewUrl = (chunk: string): string | null => {
  if (!chunk) return null;
  const cleaned = chunk.replace(ANSI_ESCAPE_PATTERN, '');
  const match = cleaned.match(URL_PATTERN);
  if (!match?.[1]) return null;
  let url = trimUrlTrailingPunctuation(match[1]);
  // Normalize common loopback hostnames to a stable value so the iframe can load.
  url = url.replace('0.0.0.0', '127.0.0.1');
  url = url.replace('[::1]', '127.0.0.1');
  url = url.replace('[::]', '127.0.0.1');
  return url;
};

const extractPythonHttpServerUrl = (chunk: string): string | null => {
  if (!chunk) return null;
  const cleaned = chunk.replace(ANSI_ESCAPE_PATTERN, '');
  const match = cleaned.match(/Serving HTTP on .*? port (\d{2,5})/i);
  if (!match?.[1]) return null;
  const port = Number.parseInt(match[1], 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return null;
  return `http://127.0.0.1:${port}/`;
};

const createEmptyDirectoryState = (firstTab: TerminalTab): DirectoryTerminalState => ({
  tabs: [firstTab],
  activeTabId: firstTab.id,
});

const findTabIndex = (state: DirectoryTerminalState, tabId: string): number =>
  state.tabs.findIndex((t) => t.id === tabId);

export const useTerminalStore = create<TerminalStore>()(
  devtools(
    persist(
      (set, get) => ({
        sessions: new Map(),
        nextChunkId: 1,
        nextTabId: 1,
        hasHydrated: typeof window === 'undefined',

        ensureDirectory: (directory: string) => {
          const key = normalizeDirectory(directory);
          if (!key) return;

          set((state) => {
            if (state.sessions.has(key)) {
              return state;
            }

            const newSessions = new Map(state.sessions);
            const tabId = `tab-${state.nextTabId}`;
            const firstTab = createEmptyTab(tabId, 'Terminal');
            newSessions.set(key, createEmptyDirectoryState(firstTab));

            return { sessions: newSessions, nextTabId: state.nextTabId + 1 };
          });
        },

        getDirectoryState: (directory: string) => {
          const key = normalizeDirectory(directory);
          return get().sessions.get(key);
        },

        getActiveTab: (directory: string) => {
          const key = normalizeDirectory(directory);
          const entry = get().sessions.get(key);
          if (!entry) return undefined;
          const activeId = entry.activeTabId;
          if (!activeId) return entry.tabs[0];
          return entry.tabs.find((t) => t.id === activeId) ?? entry.tabs[0];
        },

        createTab: (directory: string) => {
          const key = normalizeDirectory(directory);
          if (!key) {
            return 'tab-invalid';
          }

          const tabId = `tab-${get().nextTabId}`;

          set((state) => {
            const newSessions = new Map(state.sessions);
            const existing = newSessions.get(key);

            const nextTabId = state.nextTabId + 1;
            const labelIndex = (existing?.tabs.length ?? 0) + 1;
            const label = `Terminal ${labelIndex}`;
            const tab = createEmptyTab(tabId, label);

            if (!existing) {
              newSessions.set(key, createEmptyDirectoryState(tab));
            } else {
              newSessions.set(key, {
                ...existing,
                tabs: [...existing.tabs, tab],
              });
            }

            return { sessions: newSessions, nextTabId };
          });

          return tabId;
        },

        setActiveTab: (directory: string, tabId: string) => {
          const key = normalizeDirectory(directory);
          set((state) => {
            const newSessions = new Map(state.sessions);
            const existing = newSessions.get(key);
            if (!existing) {
              return state;
            }
            if (existing.activeTabId === tabId) {
              return state;
            }
            if (findTabIndex(existing, tabId) < 0) {
              return state;
            }

            newSessions.set(key, { ...existing, activeTabId: tabId });
            return { sessions: newSessions };
          });
        },

        setTabLabel: (directory: string, tabId: string, label: string) => {
          const key = normalizeDirectory(directory);
          const normalizedLabel = label.trim();
          if (!normalizedLabel) {
            return;
          }

          set((state) => {
            const newSessions = new Map(state.sessions);
            const existing = newSessions.get(key);
            if (!existing) {
              return state;
            }

            const idx = findTabIndex(existing, tabId);
            if (idx < 0) {
              return state;
            }

            if (existing.tabs[idx]?.label === normalizedLabel) {
              return state;
            }

            const nextTabs = [...existing.tabs];
            nextTabs[idx] = {
              ...nextTabs[idx],
              label: normalizedLabel,
            };

            newSessions.set(key, {
              ...existing,
              tabs: nextTabs,
            });
            return { sessions: newSessions };
          });
        },

        closeTab: async (directory: string, tabId: string) => {
          const key = normalizeDirectory(directory);
          const entry = get().sessions.get(key);
          const tab = entry?.tabs.find((t) => t.id === tabId);
          const sessionId = tab?.terminalSessionId ?? null;

          if (sessionId) {
            try {
              await closeTerminal(sessionId);
            } catch {
              // ignore
            }
          }

          set((state) => {
            const newSessions = new Map(state.sessions);
            const existing = newSessions.get(key);
            if (!existing) {
              return state;
            }

            const idx = findTabIndex(existing, tabId);
            if (idx < 0) {
              return state;
            }

            const nextTabs = existing.tabs.filter((t) => t.id !== tabId);

            if (nextTabs.length === 0) {
              const newTabId = `tab-${state.nextTabId}`;
              const newTab = createEmptyTab(newTabId, 'Terminal');
              newSessions.set(key, createEmptyDirectoryState(newTab));
              return { sessions: newSessions, nextTabId: state.nextTabId + 1 };
            }

            let nextActive = existing.activeTabId;
            if (existing.activeTabId === tabId) {
              const fallback = nextTabs[Math.min(idx, nextTabs.length - 1)];
              nextActive = fallback?.id ?? nextTabs[0]?.id ?? null;
            }

            newSessions.set(key, {
              ...existing,
              tabs: nextTabs,
              activeTabId: nextActive,
            });

            return { sessions: newSessions };
          });
        },

        setTabSessionId: (directory: string, tabId: string, sessionId: string | null) => {
          const key = normalizeDirectory(directory);
          set((state) => {
            const newSessions = new Map(state.sessions);
            const existing = newSessions.get(key);
            if (!existing) {
              return state;
            }

            const idx = findTabIndex(existing, tabId);
            if (idx < 0) {
              return state;
            }

            const tab = existing.tabs[idx];
            const shouldResetBuffer = sessionId !== null && tab.terminalSessionId !== sessionId;

            const nextLifecycle = sessionId
              ? 'running'
              : (tab.terminalSessionId ? 'exited' : tab.lifecycle);

            const nextTab: TerminalTab = {
              ...tab,
              terminalSessionId: sessionId,
              lifecycle: nextLifecycle,
              isConnecting: false,
              ...(shouldResetBuffer ? { bufferChunks: [], bufferLength: 0 } : {}),
            };

            const nextTabs = [...existing.tabs];
            nextTabs[idx] = nextTab;
            newSessions.set(key, { ...existing, tabs: nextTabs });
            return { sessions: newSessions };
          });
        },

        setTabLifecycle: (directory: string, tabId: string, lifecycle: TerminalTabLifecycle) => {
          const key = normalizeDirectory(directory);
          set((state) => {
            const newSessions = new Map(state.sessions);
            const existing = newSessions.get(key);
            if (!existing) {
              return state;
            }

            const idx = findTabIndex(existing, tabId);
            if (idx < 0) {
              return state;
            }

            const nextTabs = [...existing.tabs];
            nextTabs[idx] = { ...nextTabs[idx], lifecycle, isConnecting: false };
            newSessions.set(key, { ...existing, tabs: nextTabs });
            return { sessions: newSessions };
          });
        },

        setConnecting: (directory: string, tabId: string, isConnecting: boolean) => {
          const key = normalizeDirectory(directory);
          set((state) => {
            const newSessions = new Map(state.sessions);
            const existing = newSessions.get(key);
            if (!existing) {
              return state;
            }

            const idx = findTabIndex(existing, tabId);
            if (idx < 0) {
              return state;
            }

            const nextTabs = [...existing.tabs];
            nextTabs[idx] = { ...nextTabs[idx], isConnecting };
            newSessions.set(key, { ...existing, tabs: nextTabs });
            return { sessions: newSessions };
          });
        },

        appendToBuffer: (directory: string, tabId: string, chunk: string) => {
          if (!chunk) {
            return;
          }

          const key = normalizeDirectory(directory);
          set((state) => {
            const newSessions = new Map(state.sessions);
            const existing = newSessions.get(key);
            if (!existing) {
              return state;
            }

            const idx = findTabIndex(existing, tabId);
            if (idx < 0) {
              return state;
            }

            const tab = existing.tabs[idx];
            const chunkId = state.nextChunkId;
            const chunkEntry: TerminalChunk = { id: chunkId, data: chunk };

            const bufferChunks = [...tab.bufferChunks, chunkEntry];
            let bufferLength = tab.bufferLength + chunk.length;

            while (bufferLength > TERMINAL_BUFFER_LIMIT && bufferChunks.length > 1) {
              const removed = bufferChunks.shift();
              if (!removed) {
                break;
              }
              bufferLength -= removed.data.length;
            }

            const maybePreviewUrl = extractPreviewUrl(chunk) ?? extractPythonHttpServerUrl(chunk);
            const shouldUpdatePreview = Boolean(maybePreviewUrl && maybePreviewUrl !== tab.previewUrl);

            const nextTabs = [...existing.tabs];
            nextTabs[idx] = {
              ...tab,
              bufferChunks,
              bufferLength,
              ...(shouldUpdatePreview
                ? { previewUrl: maybePreviewUrl, previewAutoOpened: false }
                : null),
            };
            newSessions.set(key, { ...existing, tabs: nextTabs });

            return { sessions: newSessions, nextChunkId: chunkId + 1 };
          });
        },

        markPreviewAutoOpened: (directory: string, tabId: string) => {
          const key = normalizeDirectory(directory);
          set((state) => {
            const newSessions = new Map(state.sessions);
            const existing = newSessions.get(key);
            if (!existing) {
              return state;
            }

            const idx = findTabIndex(existing, tabId);
            if (idx < 0) {
              return state;
            }

            const tab = existing.tabs[idx];
            if (!tab.previewUrl || tab.previewAutoOpened) {
              return state;
            }

            const nextTabs = [...existing.tabs];
            nextTabs[idx] = { ...tab, previewAutoOpened: true };
            newSessions.set(key, { ...existing, tabs: nextTabs });
            return { sessions: newSessions };
          });
        },

        clearBuffer: (directory: string, tabId: string) => {
          const key = normalizeDirectory(directory);
          set((state) => {
            const newSessions = new Map(state.sessions);
            const existing = newSessions.get(key);
            if (!existing) {
              return state;
            }

            const idx = findTabIndex(existing, tabId);
            if (idx < 0) {
              return state;
            }

            const nextTabs = [...existing.tabs];
            nextTabs[idx] = {
              ...nextTabs[idx],
              bufferChunks: [],
              bufferLength: 0,
            };
            newSessions.set(key, { ...existing, tabs: nextTabs });
            return { sessions: newSessions };
          });
        },

        removeDirectory: (directory: string) => {
          const key = normalizeDirectory(directory);
          set((state) => {
            const newSessions = new Map(state.sessions);
            newSessions.delete(key);
            return { sessions: newSessions };
          });
        },

        clearAll: () => {
          set({ sessions: new Map(), nextChunkId: 1, nextTabId: 1 });
        },
      }),
      {
        name: TERMINAL_STORE_NAME,
        storage: createJSONStorage(() => getSafeSessionStorage()),
        partialize: (state): PersistedTerminalStoreState => ({
          sessions: Array.from(state.sessions.entries()).map(([directory, dirState]) => [
            directory,
            {
              activeTabId: dirState.activeTabId,
              tabs: dirState.tabs.map((tab) => ({
                id: tab.id,
                label: tab.label,
                terminalSessionId: tab.terminalSessionId,
                lifecycle: tab.lifecycle,
                createdAt: tab.createdAt,
              })),
            },
          ]),
          nextTabId: state.nextTabId,
        }),
        merge: (persistedState, currentState) => {
          if (!isRecord(persistedState)) {
            return currentState;
          }

          const rawSessions = Array.isArray(persistedState.sessions)
            ? (persistedState.sessions as PersistedTerminalStoreState['sessions'])
            : [];

          const sessions = new Map<string, DirectoryTerminalState>();
          let maxTabNum = 0;

          for (const entry of rawSessions) {
            if (!Array.isArray(entry) || entry.length !== 2) {
              continue;
            }

            const [directory, rawState] = entry as [unknown, unknown];
            if (typeof directory !== 'string' || !isRecord(rawState)) {
              continue;
            }

            const rawTabs = Array.isArray(rawState.tabs) ? (rawState.tabs as unknown[]) : [];
            const tabs: TerminalTab[] = [];

            for (const rawTab of rawTabs) {
              if (!isRecord(rawTab)) {
                continue;
              }

              const id = typeof rawTab.id === 'string' ? rawTab.id : null;
              if (!id) {
                continue;
              }

              const num = tabIdNumber(id);
              if (num !== null) {
                maxTabNum = Math.max(maxTabNum, num);
              }

              const terminalSessionId =
                typeof rawTab.terminalSessionId === 'string' || rawTab.terminalSessionId === null
                  ? (rawTab.terminalSessionId as string | null)
                  : null;
              const lifecycleRaw = rawTab.lifecycle;
              const lifecycle =
                lifecycleRaw === 'idle' || lifecycleRaw === 'running' || lifecycleRaw === 'exited'
                  ? lifecycleRaw
                  : (terminalSessionId ? 'running' : 'idle');

              tabs.push({
                id,
                label: typeof rawTab.label === 'string' ? rawTab.label : 'Terminal',
                terminalSessionId,
                lifecycle,
                createdAt: typeof rawTab.createdAt === 'number' ? rawTab.createdAt : Date.now(),
                bufferChunks: [],
                bufferLength: 0,
                isConnecting: false,
                previewUrl: null,
                previewAutoOpened: false,
              });
            }

            if (tabs.length === 0) {
              continue;
            }

            const activeTabId =
              typeof rawState.activeTabId === 'string' ? (rawState.activeTabId as string) : null;
            const activeExists = activeTabId ? tabs.some((t) => t.id === activeTabId) : false;

            sessions.set(directory, {
              tabs,
              activeTabId: activeExists ? activeTabId : tabs[0].id,
            });
          }

          const persistedNextTabId =
            typeof persistedState.nextTabId === 'number' && Number.isFinite(persistedState.nextTabId)
              ? (persistedState.nextTabId as number)
              : 1;

          const nextTabId = Math.max(currentState.nextTabId, persistedNextTabId, maxTabNum + 1);

          return {
            ...currentState,
            sessions,
            nextChunkId: 1,
            nextTabId,
            hasHydrated: true,
          };
        },
      }
    )
  )
);

// Ensure hydration completes even when no persisted state exists.
if (typeof window !== 'undefined' && !hydrationListenerAttached) {
  hydrationListenerAttached = true;
  const persistApi = (
    useTerminalStore as unknown as {
      persist?: {
        hasHydrated?: () => boolean;
        onFinishHydration?: (cb: () => void) => (() => void) | void;
      };
    }
  ).persist;

  const markHydrated = () => {
    if (!useTerminalStore.getState().hasHydrated) {
      useTerminalStore.setState({ hasHydrated: true });
    }
  };

  if (persistApi?.hasHydrated?.()) {
    markHydrated();
  } else if (persistApi?.onFinishHydration) {
    persistApi.onFinishHydration(markHydrated);
  } else {
    markHydrated();
  }
}
