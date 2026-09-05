import { create } from 'zustand';
import { devtools, persist, createJSONStorage } from 'zustand/middleware';
import type { PersistStorage } from 'zustand/middleware';
import { z } from 'zod';

import { getSafeSessionStorage } from '@/stores/utils/safeStorage';
import type { TerminalServerSession } from '@/lib/api/types';
import { normalizeTerminalDirectory } from '@/lib/pathNormalization';

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

export type TerminalTabLifecycle = 'idle' | 'starting' | 'running' | 'stopping' | 'exited';

export const ACTIVE_PROJECT_ACTION_LIFECYCLES: ReadonlySet<TerminalTabLifecycle> = new Set([
  'starting',
  'running',
  'stopping',
]);

export type TerminalTabPurpose =
  | { type: 'terminal' }
  | { type: 'project-action'; actionId: string; executionId: string | null };

export type TerminalTab = {
  id: string;
  terminalSessionId: string | null;
  lifecycle: TerminalTabLifecycle;
  purpose: TerminalTabPurpose;
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

export const directoryMayHaveActiveProjectAction = (state: DirectoryTerminalState | undefined): boolean =>
  Boolean(state?.tabs.some((tab) => isProjectActionPurpose(tab.purpose) && tab.lifecycle !== 'exited'));

type TerminalActionMutationRevisions = ReadonlyMap<string, number>;

type ReconcileServerSessionsOptions = {
  startedActionMutationRevisions?: TerminalActionMutationRevisions;
};

interface TerminalStore {
  sessions: Map<string, DirectoryTerminalState>;
  buffers: Map<string, TerminalBuffer>;
  actionMutationRevisions: Map<string, number>;
  nextActionMutationRevision: number;
  nextChunkId: number;
  nextTabId: number;
  hasHydrated: boolean;

  ensureDirectory: (directory: string) => void;
  getDirectoryState: (directory: string) => DirectoryTerminalState | undefined;
  getActiveTab: (directory: string) => TerminalTab | undefined;
  getBuffer: (directory: string, tabId: string) => TerminalBuffer;
  matchesActionExecution: (directory: string, tabId: string, executionId: string | null | undefined) => boolean;
  captureStartedActionMutationRevisions: (directory: string) => TerminalActionMutationRevisions;

  createTab: (directory: string) => string;
  reconcileServerSessions: (directory: string, serverSessions: TerminalServerSession[], options?: ReconcileServerSessionsOptions) => void;
  setActiveTab: (directory: string, tabId: string) => void;
  setTabLabel: (directory: string, tabId: string, label: string) => void;
  setTabIconKey: (directory: string, tabId: string, iconKey: string | null) => void;
  closeTab: (directory: string, tabId: string) => void;

  setTabPurpose: (directory: string, tabId: string, purpose: TerminalTabPurpose) => void;
  allocateActionExecution: (directory: string, tabId: string, actionId: string) => string | null;
  setTabSessionId: (directory: string, tabId: string, sessionId: string | null, options?: { expectedExecutionId?: string | null }) => void;
  setTabLifecycle: (directory: string, tabId: string, lifecycle: TerminalTabLifecycle, options?: { expectedExecutionId?: string | null }) => void;
  setConnecting: (directory: string, tabId: string, isConnecting: boolean, options?: { expectedExecutionId?: string | null }) => void;
  replaceBuffer: (directory: string, tabId: string, content: string, sequence: number) => void;
  appendToBuffer: (directory: string, tabId: string, chunk: string, sequence?: number, replayData?: string) => void;
  setTabPreviewUrl: (directory: string, tabId: string, url: string | null, options?: { locked?: boolean; autoOpened?: boolean; expectedExecutionId?: string | null }) => void;
  markPreviewAutoOpened: (directory: string, tabId: string) => void;

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
const persistedProjectActionPurposeSchema = z.object({
  type: z.literal('project-action'),
  actionId: z.string(),
});

const createTerminalTabId = (): string => {
  if (typeof globalThis.crypto?.randomUUID === 'function') return `tab-${globalThis.crypto.randomUUID()}`;
  fallbackTabId += 1;
  return `tab-${Date.now().toString(36)}-${fallbackTabId.toString(36)}`;
};

type PersistedTerminalTabPurpose =
  | { type: 'terminal' }
  | { type: 'project-action'; actionId: string };

type PersistedTerminalTab = Pick<TerminalTab, 'id' | 'label' | 'iconKey' | 'createdAt'> & {
  purpose?: PersistedTerminalTabPurpose;
};

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

const isProjectActionPurpose = (purpose: TerminalTabPurpose): purpose is Extract<TerminalTabPurpose, { type: 'project-action' }> =>
  purpose.type === 'project-action';

const shouldApplyExecutionGuard = (tab: TerminalTab, expectedExecutionId: string | null | undefined): boolean => {
  if (!isProjectActionPurpose(tab.purpose)) {
    return expectedExecutionId == null;
  }
  if (expectedExecutionId === undefined) {
    return true;
  }
  return tab.purpose.executionId === expectedExecutionId;
};

const createExecutionId = (): string => createTerminalTabId().replace(/^tab-/, 'exec-');

const toActionLifecycle = (status: TerminalServerSession['status']): TerminalTabLifecycle =>
  status === 'running' ? 'running' : 'exited';

const toActionPurposeFromSession = (
  purpose: Extract<TerminalServerSession['purpose'], { type: 'project-action' }>,
  status: TerminalServerSession['status'],
): Extract<TerminalTabPurpose, { type: 'project-action' }> => ({
  type: 'project-action',
  actionId: purpose.actionId,
  executionId: status === 'running' ? purpose.executionId : null,
});

const authoritativeTerminalSessions = (sessions: TerminalServerSession[]): TerminalServerSession[] => {
  const actions = new Map<string, TerminalServerSession>();
  const terminals: TerminalServerSession[] = [];
  for (const session of sessions) {
    if (session.purpose?.type !== 'project-action') {
      terminals.push(session);
      continue;
    }
    const previous = actions.get(session.purpose.actionId);
    if (!previous
      || (session.status === 'running' && previous.status !== 'running')
      || (session.status === previous.status && (
        (session.createdAt ?? 0) > (previous.createdAt ?? 0)
        || (session.createdAt === previous.createdAt && session.sessionId > previous.sessionId)
      ))) actions.set(session.purpose.actionId, session);
  }
  return [...terminals, ...actions.values()];
};

const resetActionPreview = { previewUrl: null, previewAutoOpened: false, previewUrlLocked: false };

const toAdoptedActionLabel = (actionId: string): string => {
  const trimmed = actionId.trim();
  return trimmed || 'Action';
};

const tabIdNumber = (tabId: string): number | null => {
  const match = /^tab-(\d+)$/.exec(tabId);
  if (!match) return null;
  const num = Number(match[1]);
  return Number.isFinite(num) ? num : null;
};

const normalizeDirectory = normalizeTerminalDirectory;

const actionMutationRevisionKey = (directory: string, actionId: string): string => `${directory}\u0000${actionId}`;

const updateActionMutationRevision = (
  revisions: Map<string, number>,
  directory: string,
  actionId: string,
  revision: number,
) => {
  revisions.set(actionMutationRevisionKey(directory, actionId), revision);
};

const hasActionMutatedSinceRequestStarted = (
  state: Pick<TerminalStore, 'actionMutationRevisions'>,
  directory: string,
  actionId: string,
  startedActionMutationRevisions: TerminalActionMutationRevisions | undefined,
): boolean => {
  if (!startedActionMutationRevisions) {
    return false;
  }
  const revisionKey = actionMutationRevisionKey(directory, actionId);
  const currentRevision = state.actionMutationRevisions.get(revisionKey) ?? 0;
  const startedRevision = startedActionMutationRevisions.get(revisionKey) ?? 0;
  return currentRevision > startedRevision;
};

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

/** A project action the user would expect to see marked as running. */
export const isActiveProjectActionTab = (tab: TerminalTab): boolean =>
  tab.purpose.type === 'project-action'
  && tab.purpose.executionId !== null
  && ACTIVE_PROJECT_ACTION_LIFECYCLES.has(tab.lifecycle);

const isLiveRunningTerminal = (tab: TerminalTab | undefined): boolean =>
  Boolean(tab && tab.terminalSessionId !== null && tab.lifecycle === 'running');

const createEmptyTab = (id: string, label: string): TerminalTab => ({
  id,
  terminalSessionId: null,
  lifecycle: 'idle',
  purpose: { type: 'terminal' },
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
          purpose: tab.purpose.type === 'project-action'
            ? { type: 'project-action', actionId: tab.purpose.actionId }
            : { type: 'terminal' },
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
        actionMutationRevisions: new Map(),
        nextActionMutationRevision: 1,
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

        matchesActionExecution: (directory, tabId, executionId) => {
          const tab = get().sessions.get(normalizeDirectory(directory))?.tabs.find((entry) => entry.id === tabId);
          return Boolean(tab && isProjectActionPurpose(tab.purpose) && tab.purpose.executionId === executionId);
        },

        captureStartedActionMutationRevisions: (directory) => {
          const key = normalizeDirectory(directory);
          const prefix = actionMutationRevisionKey(key, '');
          const snapshot = new Map<string, number>();
          for (const [actionKey, revision] of get().actionMutationRevisions.entries()) {
            if (!actionKey.startsWith(prefix)) continue;
            snapshot.set(actionKey, revision);
          }
          return snapshot;
        },

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

        reconcileServerSessions: (directory, serverSessions, options) => {
          const key = normalizeDirectory(directory);
          if (!key) return;

          set((state) => {
            const existing = state.sessions.get(key);
            if (!existing && serverSessions.length === 0) {
              return state;
            }
            const tabs = [...(existing?.tabs ?? [])];
            let buffers = state.buffers;
            let tabsChanged = false;
            let activationCandidate: { tabId: string; createdAt: number; index: number } | null = null;
            const listedActionIds = new Set<string>();
            const matchedTabIds = new Set<string>();
            const placeholder = tabs.length === 1
              && tabs[0].terminalSessionId === null
              && tabs[0].lifecycle === 'idle'
              && tabs[0].purpose.type === 'terminal'
              && !state.buffers.has(bufferKey(key, tabs[0].id))
              ? tabs[0]
              : null;
            if (placeholder && serverSessions.length > 0) tabs.length = 0;

            for (const session of authoritativeTerminalSessions(serverSessions)) {
              let matchIndex = tabs.findIndex((tab) => tab.terminalSessionId === session.sessionId || tab.id === session.sessionId);
              const sessionPurpose = session.purpose;
              const staleActionAuthority = sessionPurpose?.type === 'project-action'
                && hasActionMutatedSinceRequestStarted(state, key, sessionPurpose.actionId, options?.startedActionMutationRevisions);
              if (sessionPurpose?.type === 'project-action') {
                listedActionIds.add(sessionPurpose.actionId);
                const actionMatchIndex = tabs.findIndex((tab) => (
                  isProjectActionPurpose(tab.purpose) && tab.purpose.actionId === sessionPurpose.actionId
                ));
                if (staleActionAuthority) {
                  if (actionMatchIndex >= 0) {
                    matchedTabIds.add(tabs[actionMatchIndex]!.id);
                  }
                  continue;
                }
                if (matchIndex < 0) {
                  matchIndex = actionMatchIndex;
                }
              }

              const nextPurpose: TerminalTabPurpose = sessionPurpose?.type === 'project-action'
                ? toActionPurposeFromSession(sessionPurpose, session.status)
                : { type: 'terminal' };

              if (matchIndex >= 0) {
                const current = tabs[matchIndex]!;
                let nextLifecycle = current.purpose.type === 'project-action' || sessionPurpose?.type === 'project-action'
                  ? toActionLifecycle(session.status)
                  : session.status;
                if (current.lifecycle === 'stopping' && session.status === 'running'
                  && current.purpose.type === 'project-action' && nextPurpose.type === 'project-action'
                  && current.purpose.executionId === nextPurpose.executionId) nextLifecycle = 'stopping';
                const nextCreatedAt = session.createdAt ?? current.createdAt;
                const executionChanged = sessionPurpose?.type === 'project-action'
                  && (current.terminalSessionId !== session.sessionId
                    || (nextPurpose.type === 'project-action' && nextPurpose.executionId !== null
                      && (current.purpose.type !== 'project-action' || current.purpose.executionId !== nextPurpose.executionId)));
                if (executionChanged) {
                  const keyToDrop = bufferKey(key, current.id);
                  buffers = dropBufferKeys(buffers, (entry) => entry === keyToDrop) ?? buffers;
                }
                const activatesRunningAction = sessionPurpose?.type === 'project-action'
                  && session.status === 'running'
                  && (current.terminalSessionId !== session.sessionId || current.lifecycle !== 'running');
                const purposeChanged = current.purpose.type !== nextPurpose.type
                  || (current.purpose.type === 'project-action' && nextPurpose.type === 'project-action'
                    && (current.purpose.actionId !== nextPurpose.actionId || current.purpose.executionId !== nextPurpose.executionId));
                if (
                  current.terminalSessionId !== session.sessionId
                  || current.lifecycle !== nextLifecycle
                  || current.isConnecting !== false
                  || current.createdAt !== nextCreatedAt
                  || purposeChanged
                ) {
                  tabs[matchIndex] = {
                    ...current,
                    terminalSessionId: session.sessionId,
                    lifecycle: nextLifecycle,
                    purpose: nextPurpose,
                    isConnecting: false,
                    createdAt: nextCreatedAt,
                  };
                  if (executionChanged) Object.assign(tabs[matchIndex], resetActionPreview);
                  tabsChanged = true;
                }
                if (activatesRunningAction) {
                  const candidate = { tabId: current.id, createdAt: nextCreatedAt, index: matchIndex };
                  if (
                    !activationCandidate
                    || candidate.createdAt > activationCandidate.createdAt
                    || (candidate.createdAt === activationCandidate.createdAt && candidate.index > activationCandidate.index)
                  ) {
                    activationCandidate = candidate;
                  }
                }
                matchedTabIds.add(current.id);
                continue;
              }

              const label = sessionPurpose?.type === 'project-action'
                ? toAdoptedActionLabel(sessionPurpose.actionId)
                : (placeholder && tabs.length === 0 ? placeholder.label : nextDefaultTabLabel(tabs));
              const iconKey = sessionPurpose?.type === 'project-action' ? 'play' : null;
              const tab: TerminalTab = {
                ...createEmptyTab(session.sessionId, label),
                terminalSessionId: session.sessionId,
                lifecycle: sessionPurpose?.type === 'project-action' ? toActionLifecycle(session.status) : session.status,
                purpose: nextPurpose,
                iconKey,
                createdAt: session.createdAt ?? Date.now(),
              };
              tabs.push(tab);
              tabsChanged = true;
              if (sessionPurpose?.type === 'project-action' && session.status === 'running') {
                const candidate = { tabId: tab.id, createdAt: tab.createdAt, index: tabs.length - 1 };
                if (
                  !activationCandidate
                  || candidate.createdAt > activationCandidate.createdAt
                  || (candidate.createdAt === activationCandidate.createdAt && candidate.index > activationCandidate.index)
                ) {
                  activationCandidate = candidate;
                }
              }
              matchedTabIds.add(tab.id);
            }

            let changed = tabsChanged || Boolean(placeholder && serverSessions.length > 0);
            const reconciledTabs: TerminalTab[] = tabs.map((tab) => {
              if (!isProjectActionPurpose(tab.purpose)) return tab;
              if (listedActionIds.has(tab.purpose.actionId) || matchedTabIds.has(tab.id)) return tab;
              if (
                tab.lifecycle === 'starting'
                || hasActionMutatedSinceRequestStarted(state, key, tab.purpose.actionId, options?.startedActionMutationRevisions)
              ) {
                return tab;
              }
              if (tab.lifecycle === 'exited' && !tab.isConnecting) return tab;
              changed = true;
              return {
                ...tab,
                lifecycle: 'exited',
                isConnecting: false,
                purpose: { type: 'project-action', actionId: tab.purpose.actionId, executionId: null },
              };
            });

            const previousActive = existing?.activeTabId ?? null;
            const resolvedActiveTabId = previousActive && reconciledTabs.some((tab) => tab.id === previousActive)
              ? previousActive
              : reconciledTabs[0]?.id ?? null;
            const resolvedActiveTab = resolvedActiveTabId
              ? reconciledTabs.find((tab) => tab.id === resolvedActiveTabId)
              : reconciledTabs[0];
            const activeTabId = activationCandidate && !isLiveRunningTerminal(resolvedActiveTab)
              ? activationCandidate.tabId
              : resolvedActiveTabId;

            // Activation transitions always rewrite the adopted tab, so today
            // `changed` is true whenever `activeTabId` moved; the explicit
            // activeTabId comparison keeps this guard honest if a future
            // activation path stops touching the tabs array.
            if (
              !changed
              && existing
              && activeTabId === existing.activeTabId
              && reconciledTabs.length === existing.tabs.length
              && reconciledTabs.every((tab, index) => tab === existing.tabs[index])
            ) {
              return state;
            }

            const newSessions = new Map(state.sessions);
            newSessions.set(key, { tabs: reconciledTabs, activeTabId });
            return { sessions: newSessions, buffers };
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

            const closedPurpose = existing.tabs[idx].purpose;
            let actionMutationRevisions = state.actionMutationRevisions;
            let nextActionMutationRevision = state.nextActionMutationRevision;
            if (closedPurpose.type === 'project-action') {
              actionMutationRevisions = new Map(actionMutationRevisions);
              updateActionMutationRevision(actionMutationRevisions, key, closedPurpose.actionId, nextActionMutationRevision);
              nextActionMutationRevision += 1;
            }
            const mutationState = { actionMutationRevisions, nextActionMutationRevision };
            const nextTabs = existing.tabs.filter((t) => t.id !== tabId);
            const closedBufferKey = bufferKey(key, tabId);
            const nextBuffers = state.buffers.has(closedBufferKey)
              ? dropBufferKeys(state.buffers, (bufferEntryKey) => bufferEntryKey === closedBufferKey)
              : null;

            if (nextTabs.length === 0) {
              const newTabId = createTerminalTabId();
              const newTab = createEmptyTab(newTabId, 'Terminal');
              newSessions.set(key, createEmptyDirectoryState(newTab));
              const nextState: Pick<TerminalStore, 'sessions' | 'nextTabId'> & { buffers?: Map<string, TerminalBuffer> } = {
                sessions: newSessions,
                nextTabId: state.nextTabId + 1,
              };
              if (nextBuffers) {
                nextState.buffers = nextBuffers;
              }
              return { ...nextState, ...mutationState };
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

            const nextState: Pick<TerminalStore, 'sessions'> & { buffers?: Map<string, TerminalBuffer> } = {
              sessions: newSessions,
            };
            if (nextBuffers) {
              nextState.buffers = nextBuffers;
            }
            return { ...nextState, ...mutationState };
          });
        },

        setTabPurpose: (directory, tabId, purpose) => {
          const key = normalizeDirectory(directory);
          set((state) => {
            const existing = state.sessions.get(key);
            if (!existing) return state;
            const idx = findTabIndex(existing, tabId);
            if (idx < 0) return state;
            const current = existing.tabs[idx]!;
            if (JSON.stringify(current.purpose) === JSON.stringify(purpose)) {
              return state;
            }
            const nextTabs = [...existing.tabs];
            const executionChanged = purpose.type === 'project-action' && purpose.executionId !== null
              && (current.purpose.type !== 'project-action' || current.purpose.executionId !== purpose.executionId);
            nextTabs[idx] = { ...current, purpose };
            if (executionChanged) Object.assign(nextTabs[idx], resetActionPreview);
            const keyToDrop = bufferKey(key, tabId);
            const buffers = executionChanged
              ? dropBufferKeys(state.buffers, (entry) => entry === keyToDrop) ?? state.buffers
              : state.buffers;
            const sessions = new Map(state.sessions);
            sessions.set(key, { ...existing, tabs: nextTabs });
            if (purpose.type !== 'project-action') {
              return { sessions };
            }
            const actionMutationRevisions = new Map(state.actionMutationRevisions);
            updateActionMutationRevision(actionMutationRevisions, key, purpose.actionId, state.nextActionMutationRevision);
            return { sessions, buffers, actionMutationRevisions, nextActionMutationRevision: state.nextActionMutationRevision + 1 };
          });
        },

        allocateActionExecution: (directory, tabId, actionId) => {
          const key = normalizeDirectory(directory);
          const existing = get().sessions.get(key);
          if (!existing || findTabIndex(existing, tabId) < 0) return null;
          const executionId = createExecutionId();
          set((state) => {
            const current = state.sessions.get(key);
            if (!current) return state;
            const idx = findTabIndex(current, tabId);
            if (idx < 0) return state;
            const nextTabs = [...current.tabs];
            nextTabs[idx] = {
              ...nextTabs[idx]!,
              purpose: { type: 'project-action', actionId, executionId },
              lifecycle: 'starting',
              terminalSessionId: null,
              ...resetActionPreview,
              isConnecting: false,
            };
            const sessions = new Map(state.sessions);
            sessions.set(key, { ...current, tabs: nextTabs });
            const actionMutationRevisions = new Map(state.actionMutationRevisions);
            updateActionMutationRevision(actionMutationRevisions, key, actionId, state.nextActionMutationRevision);
            const keyToDrop = bufferKey(key, tabId);
            const buffers = dropBufferKeys(state.buffers, (entry) => entry === keyToDrop) ?? state.buffers;
            return { sessions, buffers, actionMutationRevisions, nextActionMutationRevision: state.nextActionMutationRevision + 1 };
          });
          return executionId;
        },

        setTabSessionId: (directory: string, tabId: string, sessionId: string | null, options) => {
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
            if (!shouldApplyExecutionGuard(tab, options?.expectedExecutionId)) {
              return state;
            }
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
            const nextState: Pick<TerminalStore, 'sessions' | 'nextActionMutationRevision'> & {
              buffers?: Map<string, TerminalBuffer>;
              actionMutationRevisions?: Map<string, number>;
            } = {
              sessions: newSessions,
              nextActionMutationRevision: state.nextActionMutationRevision,
            };
            if (isProjectActionPurpose(tab.purpose)) {
              const actionMutationRevisions = new Map(state.actionMutationRevisions);
              updateActionMutationRevision(actionMutationRevisions, key, tab.purpose.actionId, state.nextActionMutationRevision);
              nextState.actionMutationRevisions = actionMutationRevisions;
              nextState.nextActionMutationRevision = state.nextActionMutationRevision + 1;
            }
            if (nextBuffers) {
              nextState.buffers = nextBuffers;
            }
            return nextState;
          });
        },

        setTabLifecycle: (directory: string, tabId: string, lifecycle: TerminalTabLifecycle, options) => {
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

            if (!shouldApplyExecutionGuard(existing.tabs[idx]!, options?.expectedExecutionId)) {
              return state;
            }

            const current = existing.tabs[idx]!;
            if (current.lifecycle === lifecycle && !current.isConnecting) return state;
            const nextTabs = [...existing.tabs];
            nextTabs[idx] = { ...current, lifecycle, isConnecting: false };
            newSessions.set(key, { ...existing, tabs: nextTabs });
            if (current.purpose.type !== 'project-action' || current.lifecycle === lifecycle) return { sessions: newSessions };
            const actionMutationRevisions = new Map(state.actionMutationRevisions);
            updateActionMutationRevision(actionMutationRevisions, key, current.purpose.actionId, state.nextActionMutationRevision);
            return { sessions: newSessions, actionMutationRevisions, nextActionMutationRevision: state.nextActionMutationRevision + 1 };
          });
        },

        setConnecting: (directory: string, tabId: string, isConnecting: boolean, options) => {
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

            if (!shouldApplyExecutionGuard(existing.tabs[idx]!, options?.expectedExecutionId)) {
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
            if (!shouldApplyExecutionGuard(tab, options.expectedExecutionId)) {
              return state;
            }
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

        removeDirectory: (directory: string) => {
          const key = normalizeDirectory(directory);
          set((state) => {
            const newSessions = new Map(state.sessions);
            newSessions.delete(key);
            const prefix = bufferKey(key, '');
            const nextBuffers = dropBufferKeys(state.buffers, (entryKey) => entryKey.startsWith(prefix));
            const revisionPrefix = actionMutationRevisionKey(key, '');
            let actionMutationRevisions: Map<string, number> | undefined;
            for (const actionKey of state.actionMutationRevisions.keys()) {
              if (!actionKey.startsWith(revisionPrefix)) continue;
              actionMutationRevisions ??= new Map(state.actionMutationRevisions);
              actionMutationRevisions.delete(actionKey);
            }
            const nextState: Pick<TerminalStore, 'sessions'> & {
              buffers?: Map<string, TerminalBuffer>;
              actionMutationRevisions?: Map<string, number>;
            } = {
              sessions: newSessions,
            };
            if (nextBuffers) {
              nextState.buffers = nextBuffers;
            }
            if (actionMutationRevisions) {
              nextState.actionMutationRevisions = actionMutationRevisions;
            }
            return nextState;
          });
        },

        clearAll: () => {
          set({ sessions: new Map(), buffers: new Map(), actionMutationRevisions: new Map(), nextActionMutationRevision: 1, nextChunkId: 1, nextTabId: 1 });
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
              const persistedPurpose = persistedProjectActionPurposeSchema.safeParse(rawTab.purpose).data;
              const purpose: TerminalTabPurpose = persistedPurpose
                ? { type: 'project-action', actionId: persistedPurpose.actionId, executionId: null }
                : { type: 'terminal' };

              tabs.push({
                id,
                label: typeof rawTab.label === 'string' ? rawTab.label : 'Terminal',
                iconKey: typeof rawTab.iconKey === 'string' ? rawTab.iconKey : null,
                terminalSessionId: null,
                lifecycle: 'idle',
                purpose,
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
            actionMutationRevisions: new Map(),
            nextActionMutationRevision: 1,
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
