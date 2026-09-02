import { create } from 'zustand';
import { devtools, persist, createJSONStorage } from 'zustand/middleware';
import type { PersistStorage } from 'zustand/middleware';

import { getSafeSessionStorage } from '@/stores/utils/safeStorage';

export interface TerminalChunk {
  id: number;
  data: string;
  replayData?: string;
  byteLength: number;
}

/**
 * Scrollback lives outside `sessions` because PTY output arrives at streaming
 * frequency. Keeping it here leaves tab metadata referentially stable, so
 * output cannot rerender the tab strip or rewrite the persisted snapshot.
 */
export type TerminalBuffer = {
  chunks: TerminalChunk[];
  byteLength: number;
  lastSequence: number;
};

export const EMPTY_TERMINAL_BUFFER: TerminalBuffer = Object.freeze({
  chunks: Object.freeze([]) as unknown as TerminalChunk[],
  byteLength: 0,
  lastSequence: -1,
});

export type TerminalTabLifecycle = 'idle' | 'running' | 'exited';

export type TerminalTab = {
  id: string;
  terminalSessionId: string | null;
  lifecycle: TerminalTabLifecycle;
  label: string;
  iconKey: string | null;
  isConnecting: boolean;
  createdAt: number;
  previewUrl: string | null;
  previewAutoOpened: boolean;
  previewUrlLocked: boolean;
};

export type DirectoryTerminalState = {
  tabs: TerminalTab[];
  activeTabId: string | null;
};

export type TerminalProjectActionRun = {
  key: string;
  directory: string;
  actionId: string;
  tabId: string;
  sessionId: string;
  status: 'running' | 'waiting-for-preview' | 'stopping';
};

interface TerminalStore {
  sessions: Map<string, DirectoryTerminalState>;
  buffers: Map<string, TerminalBuffer>;
  projectActionRuns: Record<string, TerminalProjectActionRun>;
  nextChunkId: number;
  nextTabId: number;
  hasHydrated: boolean;

  ensureDirectory: (directory: string) => void;
  getDirectoryState: (directory: string) => DirectoryTerminalState | undefined;
  getActiveTab: (directory: string) => TerminalTab | undefined;
  getBuffer: (directory: string, tabId: string) => TerminalBuffer;

  createTab: (directory: string) => string;
  adoptServerSessions: (
    directory: string,
    serverSessions: Array<{ sessionId: string; status: 'running' | 'exited'; createdAt: number | null }>,
  ) => void;
  setActiveTab: (directory: string, tabId: string) => void;
  setTabLabel: (directory: string, tabId: string, label: string) => void;
  setTabIconKey: (directory: string, tabId: string, iconKey: string | null) => void;
  closeTab: (directory: string, tabId: string) => void;

  setTabSessionId: (directory: string, tabId: string, sessionId: string | null) => void;
  setTabLifecycle: (directory: string, tabId: string, lifecycle: TerminalTabLifecycle) => void;
  setConnecting: (directory: string, tabId: string, isConnecting: boolean) => void;
  replaceBuffer: (directory: string, tabId: string, content: string, sequence: number) => void;
  appendToBuffer: (directory: string, tabId: string, chunk: string, sequence?: number, replayData?: string) => void;
  setTabPreviewUrl: (directory: string, tabId: string, url: string | null, options?: { locked?: boolean; autoOpened?: boolean }) => void;
  markPreviewAutoOpened: (directory: string, tabId: string) => void;
  setProjectActionRun: (run: TerminalProjectActionRun) => void;
  updateProjectActionRunStatus: (runKey: string, status: TerminalProjectActionRun['status']) => void;
  removeProjectActionRun: (runKey: string) => void;

  removeDirectory: (directory: string) => void;
  clearAll: () => void;
}

const TERMINAL_BUFFER_LIMIT = 512 * 1024;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
/** One encode per chunk: the trimmed text and its UTF-8 size are needed together. */
const trimToBufferLimit = (value: string): { text: string; byteLength: number } => {
  const bytes = textEncoder.encode(value);
  if (bytes.byteLength <= TERMINAL_BUFFER_LIMIT) return { text: value, byteLength: bytes.byteLength };
  let start = bytes.byteLength - TERMINAL_BUFFER_LIMIT;
  while (start < bytes.byteLength && (bytes[start] & 0xc0) === 0x80) start += 1;
  const retained = bytes.subarray(start);
  return { text: textDecoder.decode(retained), byteLength: retained.byteLength };
};
// NUL cannot appear in a directory path or a tab id, so the composite key is unambiguous.
const bufferKey = (directory: string, tabId: string): string => `${directory}\u0000${tabId}`;
const dropBufferKeys = (
  buffers: Map<string, TerminalBuffer>,
  matches: (key: string) => boolean,
): Map<string, TerminalBuffer> | null => {
  let next: Map<string, TerminalBuffer> | null = null;
  for (const key of buffers.keys()) {
    if (!matches(key)) continue;
    next ??= new Map(buffers);
    next.delete(key);
  }
  return next;
};
const TERMINAL_STORE_NAME = 'terminal-store';
let hydrationListenerAttached = false;
let fallbackTabId = 0;

const createTerminalTabId = (): string => {
  if (typeof globalThis.crypto?.randomUUID === 'function') return `tab-${globalThis.crypto.randomUUID()}`;
  fallbackTabId += 1;
  return `tab-${Date.now().toString(36)}-${fallbackTabId.toString(36)}`;
};

type PersistedTerminalTab = Pick<TerminalTab, 'id' | 'label' | 'iconKey' | 'createdAt'>;

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

const DEFAULT_TAB_LABEL_PATTERN = /^Terminal(?: (\d+))?$/;

/**
 * Default labels must stay unique among the directory's open tabs even after
 * closes (#2718), so number from the highest existing "Terminal N" suffix
 * instead of the live tab count. Labels are persisted with the tabs, so the
 * derivation also survives reloads without a dedicated counter. User-renamed
 * labels only participate when they match the default pattern; they are never
 * rewritten.
 */
const nextDefaultTabLabel = (tabs: readonly TerminalTab[]): string => {
  let highest = 0;
  for (const tab of tabs) {
    const match = DEFAULT_TAB_LABEL_PATTERN.exec(tab.label);
    if (!match) continue;
    const value = match[1] ? Number.parseInt(match[1], 10) : 1;
    if (Number.isSafeInteger(value)) highest = Math.max(highest, value);
  }
  return highest === 0 ? 'Terminal' : `Terminal ${highest + 1}`;
};

const createEmptyTab = (id: string, label: string): TerminalTab => ({
  id,
  terminalSessionId: null,
  lifecycle: 'idle',
  label,
  iconKey: null,
  isConnecting: false,
  createdAt: Date.now(),
  previewUrl: null,
  previewAutoOpened: false,
  previewUrlLocked: false,
});

const createEmptyDirectoryState = (firstTab: TerminalTab): DirectoryTerminalState => ({
  tabs: [firstTab],
  activeTabId: firstTab.id,
});

const findTabIndex = (state: DirectoryTerminalState, tabId: string): number =>
  state.tabs.findIndex((t) => t.id === tabId);

/**
 * Zustand persist runs `partialize` and writes storage after every `set`, and
 * terminal output calls `set` at streaming frequency. Only `sessions` and
 * `nextTabId` are persisted, so reuse the previous projection whenever both are
 * referentially unchanged and skip the write for an unchanged projection.
 */
let lastPartializeInput: { sessions: unknown; nextTabId: number } | null = null;
let lastPartializeResult: PersistedTerminalStoreState | null = null;

const partializeTerminalStore = (state: TerminalStore): PersistedTerminalStoreState => {
  if (
    lastPartializeResult
    && lastPartializeInput?.sessions === state.sessions
    && lastPartializeInput.nextTabId === state.nextTabId
  ) {
    return lastPartializeResult;
  }

  const result: PersistedTerminalStoreState = {
    sessions: Array.from(state.sessions.entries()).map(([directory, dirState]) => [
      directory,
      {
        activeTabId: dirState.activeTabId,
        tabs: dirState.tabs.map((tab) => ({
          id: tab.id,
          label: tab.label,
          iconKey: tab.iconKey,
          createdAt: tab.createdAt,
        })),
      },
    ]),
    nextTabId: state.nextTabId,
  };

  lastPartializeInput = { sessions: state.sessions, nextTabId: state.nextTabId };
  lastPartializeResult = result;
  return result;
};

const createDedupedTerminalStorage = (): PersistStorage<PersistedTerminalStoreState> | undefined => {
  const base = createJSONStorage<PersistedTerminalStoreState>(() => getSafeSessionStorage());
  if (!base) return undefined;

  let lastWrittenState: PersistedTerminalStoreState | null = null;
  return {
    getItem: (name) => base.getItem(name),
    setItem: (name, value) => {
      if (value.state === lastWrittenState) return;
      lastWrittenState = value.state;
      return base.setItem(name, value);
    },
    removeItem: (name) => {
      lastWrittenState = null;
      return base.removeItem(name);
    },
  };
};

export const useTerminalStore = create<TerminalStore>()(
  devtools(
    persist(
      (set, get) => ({
        sessions: new Map(),
        buffers: new Map(),
        projectActionRuns: {},
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
            const tabId = createTerminalTabId();
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

        getBuffer: (directory: string, tabId: string) =>
          get().buffers.get(bufferKey(normalizeDirectory(directory), tabId)) ?? EMPTY_TERMINAL_BUFFER,

        createTab: (directory: string) => {
          const key = normalizeDirectory(directory);
          if (!key) {
            return 'tab-invalid';
          }

          const tabId = createTerminalTabId();

          set((state) => {
            const newSessions = new Map(state.sessions);
            const existing = newSessions.get(key);

            const nextTabId = state.nextTabId + 1;
            const label = nextDefaultTabLabel(existing?.tabs ?? []);
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

        /**
         * The server owns which terminal sessions exist; the local tab list is
         * only this client's projection. Adoption is strictly additive: server
         * sessions no local tab references become tabs (id = session id, the
         * create/attach contract), and nothing is ever removed here, so a
         * failed or partial listing cannot destroy local tabs.
         */
        adoptServerSessions: (directory, serverSessions) => {
          const key = normalizeDirectory(directory);
          if (!key || serverSessions.length === 0) return;

          set((state) => {
            const existing = state.sessions.get(key);
            const knownIds = new Set<string>();
            for (const tab of existing?.tabs ?? []) {
              knownIds.add(tab.id);
              if (tab.terminalSessionId) knownIds.add(tab.terminalSessionId);
            }

            const newcomers = serverSessions.filter((session) => !knownIds.has(session.sessionId));
            if (newcomers.length === 0) return state;

            const tabs = [...(existing?.tabs ?? [])];
            // A single untouched placeholder tab (fresh directory state) is
            // replaced by the first adopted session instead of sitting next to it.
            const placeholder = tabs.length === 1
              && tabs[0].terminalSessionId === null
              && tabs[0].lifecycle === 'idle'
              && !state.buffers.has(bufferKey(key, tabs[0].id))
              ? tabs[0]
              : null;
            if (placeholder) tabs.length = 0;

            for (const session of newcomers) {
              const tab: TerminalTab = {
                ...createEmptyTab(session.sessionId, placeholder && tabs.length === 0 ? placeholder.label : nextDefaultTabLabel(tabs)),
                terminalSessionId: session.sessionId,
                lifecycle: session.status,
                createdAt: session.createdAt ?? Date.now(),
              };
              tabs.push(tab);
            }

            const previousActive = existing?.activeTabId ?? null;
            const activeTabId = previousActive && tabs.some((tab) => tab.id === previousActive)
              ? previousActive
              : tabs[0]?.id ?? null;

            const newSessions = new Map(state.sessions);
            newSessions.set(key, { tabs, activeTabId });
            return { sessions: newSessions };
          });
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

        setTabIconKey: (directory: string, tabId: string, iconKey: string | null) => {
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

            const normalizedIconKey = iconKey?.trim() || null;
            if (existing.tabs[idx]?.iconKey === normalizedIconKey) {
              return state;
            }

            const nextTabs = [...existing.tabs];
            nextTabs[idx] = {
              ...nextTabs[idx],
              iconKey: normalizedIconKey,
            };

            newSessions.set(key, {
              ...existing,
              tabs: nextTabs,
            });
            return { sessions: newSessions };
          });
        },

        closeTab: (directory: string, tabId: string) => {
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

            const nextTabs = existing.tabs.filter((t) => t.id !== tabId);
            const nextRuns = Object.fromEntries(
              Object.entries(state.projectActionRuns).filter(([, run]) => !(run.directory === key && run.tabId === tabId))
            );
            const runsChanged = Object.keys(nextRuns).length !== Object.keys(state.projectActionRuns).length;
            const closedBufferKey = bufferKey(key, tabId);
            const nextBuffers = state.buffers.has(closedBufferKey)
              ? dropBufferKeys(state.buffers, (bufferEntryKey) => bufferEntryKey === closedBufferKey)
              : null;

            if (nextTabs.length === 0) {
              const newTabId = createTerminalTabId();
              const newTab = createEmptyTab(newTabId, 'Terminal');
              newSessions.set(key, createEmptyDirectoryState(newTab));
              return {
                sessions: newSessions,
                nextTabId: state.nextTabId + 1,
                ...(nextBuffers ? { buffers: nextBuffers } : {}),
                ...(runsChanged ? { projectActionRuns: nextRuns } : {}),
              };
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

            return {
              sessions: newSessions,
              ...(nextBuffers ? { buffers: nextBuffers } : {}),
              ...(runsChanged ? { projectActionRuns: nextRuns } : {}),
            };
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
            };

            const resetKey = bufferKey(key, tabId);
            const nextBuffers = shouldResetBuffer && state.buffers.has(resetKey)
              ? dropBufferKeys(state.buffers, (bufferEntryKey) => bufferEntryKey === resetKey)
              : null;

            const nextTabs = [...existing.tabs];
            nextTabs[idx] = nextTab;
            newSessions.set(key, { ...existing, tabs: nextTabs });
            return { sessions: newSessions, ...(nextBuffers ? { buffers: nextBuffers } : {}) };
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

        replaceBuffer: (directory: string, tabId: string, content: string, sequence: number) => {
          const key = normalizeDirectory(directory);
          set((state) => {
            const existing = state.sessions.get(key);
            if (!existing || findTabIndex(existing, tabId) < 0) return state;
            const entryKey = bufferKey(key, tabId);
            const buffer = state.buffers.get(entryKey) ?? EMPTY_TERMINAL_BUFFER;
            if (buffer.lastSequence > sequence) return state;
            const retained = trimToBufferLimit(content);
            if (
              buffer.lastSequence === sequence &&
              buffer.byteLength === retained.byteLength &&
              buffer.chunks.map((chunk) => chunk.data).join('') === retained.text
            ) {
              return state;
            }
            const chunkId = state.nextChunkId;
            const buffers = new Map(state.buffers);
            buffers.set(entryKey, {
              chunks: retained.text ? [{ id: chunkId, data: retained.text, byteLength: retained.byteLength }] : [],
              byteLength: retained.byteLength,
              lastSequence: sequence,
            });
            return { buffers, nextChunkId: retained.text ? chunkId + 1 : chunkId };
          });
        },

        appendToBuffer: (directory: string, tabId: string, chunk: string, sequence?: number, replayData?: string) => {
          if (!chunk) {
            return;
          }

          const key = normalizeDirectory(directory);
          set((state) => {
            const existing = state.sessions.get(key);
            if (!existing || findTabIndex(existing, tabId) < 0) {
              return state;
            }

            const entryKey = bufferKey(key, tabId);
            const buffer = state.buffers.get(entryKey) ?? EMPTY_TERMINAL_BUFFER;
            if (sequence !== undefined && sequence <= buffer.lastSequence) return state;
            const chunkId = state.nextChunkId;
            const retainedChunk = trimToBufferLimit(chunk);
            const retainedReplayData = replayData !== undefined && replayData !== chunk
              ? trimToBufferLimit(replayData).text
              : undefined;
            const chunkEntry: TerminalChunk = {
              id: chunkId,
              data: retainedChunk.text,
              ...(retainedReplayData !== undefined ? { replayData: retainedReplayData } : {}),
              byteLength: retainedChunk.byteLength,
            };

            const chunks = [...buffer.chunks, chunkEntry];
            let bufferLength = buffer.byteLength + chunkEntry.byteLength;

            while (bufferLength > TERMINAL_BUFFER_LIMIT && chunks.length > 1) {
              const removed = chunks.shift();
              if (!removed) {
                break;
              }
              bufferLength -= removed.byteLength;
            }

            const buffers = new Map(state.buffers);
            buffers.set(entryKey, {
              chunks,
              byteLength: bufferLength,
              lastSequence: sequence ?? buffer.lastSequence,
            });

            return { buffers, nextChunkId: chunkId + 1 };
          });
        },

        setTabPreviewUrl: (directory: string, tabId: string, url: string | null, options = {}) => {
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
            const nextPreviewAutoOpened = options.autoOpened ?? tab.previewAutoOpened;
            const nextPreviewUrlLocked = options.locked ?? tab.previewUrlLocked;
            if (tab.previewUrl === url && tab.previewAutoOpened === nextPreviewAutoOpened && tab.previewUrlLocked === nextPreviewUrlLocked) {
              return state;
            }

            const nextTabs = [...existing.tabs];
            nextTabs[idx] = {
              ...tab,
              previewUrl: url,
              previewAutoOpened: nextPreviewAutoOpened,
              previewUrlLocked: nextPreviewUrlLocked,
            };
            newSessions.set(key, { ...existing, tabs: nextTabs });
            return { sessions: newSessions };
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

        setProjectActionRun: (run: TerminalProjectActionRun) => {
          set((state) => {
            const existing = state.projectActionRuns[run.key];
            if (existing
              && existing.directory === run.directory
              && existing.actionId === run.actionId
              && existing.tabId === run.tabId
              && existing.sessionId === run.sessionId
              && existing.status === run.status) {
              return state;
            }
            return { projectActionRuns: { ...state.projectActionRuns, [run.key]: run } };
          });
        },

        updateProjectActionRunStatus: (runKey: string, status: TerminalProjectActionRun['status']) => {
          set((state) => {
            const existing = state.projectActionRuns[runKey];
            if (!existing || existing.status === status) {
              return state;
            }
            return {
              projectActionRuns: {
                ...state.projectActionRuns,
                [runKey]: { ...existing, status },
              },
            };
          });
        },

        removeProjectActionRun: (runKey: string) => {
          set((state) => {
            if (!state.projectActionRuns[runKey]) {
              return state;
            }
            const next = { ...state.projectActionRuns };
            delete next[runKey];
            return { projectActionRuns: next };
          });
        },

        removeDirectory: (directory: string) => {
          const key = normalizeDirectory(directory);
          set((state) => {
            const newSessions = new Map(state.sessions);
            newSessions.delete(key);
            const prefix = bufferKey(key, '');
            const nextBuffers = dropBufferKeys(state.buffers, (entryKey) => entryKey.startsWith(prefix));
            const nextRuns = Object.fromEntries(
              Object.entries(state.projectActionRuns).filter(([, run]) => run.directory !== key)
            );
            return {
              sessions: newSessions,
              ...(nextBuffers ? { buffers: nextBuffers } : {}),
              projectActionRuns: nextRuns,
            };
          });
        },

        clearAll: () => {
          set({ sessions: new Map(), buffers: new Map(), projectActionRuns: {}, nextChunkId: 1, nextTabId: 1 });
        },
      }),
      {
        name: TERMINAL_STORE_NAME,
        storage: createDedupedTerminalStorage(),
        partialize: partializeTerminalStore,
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
            const migratedTabIds = new Map<string, string>();

            for (const rawTab of rawTabs) {
              if (!isRecord(rawTab)) {
                continue;
              }

              const persistedId = typeof rawTab.id === 'string' ? rawTab.id : null;
              if (!persistedId) {
                continue;
              }

              const num = tabIdNumber(persistedId);
              if (num !== null) {
                maxTabNum = Math.max(maxTabNum, num);
              }
              const id = num === null ? persistedId : createTerminalTabId();
              migratedTabIds.set(persistedId, id);

              tabs.push({
                id,
                label: typeof rawTab.label === 'string' ? rawTab.label : 'Terminal',
                iconKey: typeof rawTab.iconKey === 'string' ? rawTab.iconKey : null,
                terminalSessionId: null,
                lifecycle: 'idle',
                createdAt: typeof rawTab.createdAt === 'number' ? rawTab.createdAt : Date.now(),
                isConnecting: false,
                previewUrl: null,
                previewAutoOpened: false,
                previewUrlLocked: false,
              });
            }

            if (tabs.length === 0) {
              continue;
            }

            const activeTabId =
              typeof rawState.activeTabId === 'string' ? (rawState.activeTabId as string) : null;
            const migratedActiveTabId = activeTabId ? (migratedTabIds.get(activeTabId) ?? activeTabId) : null;
            const activeExists = migratedActiveTabId ? tabs.some((t) => t.id === migratedActiveTabId) : false;

            sessions.set(directory, {
              tabs,
              activeTabId: activeExists ? migratedActiveTabId : tabs[0].id,
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
            buffers: new Map(),
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
