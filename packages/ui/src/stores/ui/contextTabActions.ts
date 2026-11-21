import { directoryMayHaveActiveProjectAction, useTerminalStore } from '@/stores/useTerminalStore';
import { useFilesViewTabsStore } from '../useFilesViewTabsStore';
import { isVSCodeRuntime } from '@/lib/desktop';
import { forgetBrowserTabOpenedWithAddress, noteBrowserTabOpenedWithAddress, requestBrowserTabLoad } from '@/lib/browser/devServerWait';
import { CONTEXT_ZONES, getZoneView, resolveZoneActiveTab, resolveZoneActiveTabId, withZoneView, zoneOfMode } from '@/lib/workspace/zones';
import type { ContextPanelTab, ContextPanelDirectoryState, UIStore, UIStoreSlice } from './types';
import {
  normalizeDirectoryPath,
  normalizeContextTargetPath,
  normalizeContextTargetDirectory,
  contextPanelModeKeepsTargetDirectory,
  isTrackerBranchTab,
  normalizePendingDiffScope,
  buildContextPanelTabID,
} from './contextTabs';
import {
  touchContextPanelState,
  upsertContextPanelTab,
  closeContextPanelTabs,
  reorderContextPanelTabs,
  setContextPanelTabTargetPath,
  moveContextPanelFileTabs,
  clampContextPanelRoots,
  pushContextZoneReturnEntry,
  clearContextZoneReturnStack,
  pruneContextZoneReturnStacks,
} from './contextPanelState';

let browserTabSequence = 0;

const noteBrowserTabAddressRequested = (
  byDirectory: Record<string, ContextPanelDirectoryState>,
  directory: string,
  dedupeKey: string,
  url: string,
): void => {
  const tabID = buildContextPanelTabID('browser', dedupeKey);
  if (byDirectory[directory]?.tabs.some((tab) => tab.id === tabID)) {
    requestBrowserTabLoad(directory, tabID, url);
    return;
  }
  noteBrowserTabOpenedWithAddress(directory, tabID);
};

const openFileTab = (state: UIStore, directory: string, filePath: string, preview: boolean) => {
  const tabs = state.contextPanelByDirectory[directory]?.tabs ?? [];
  const replacedPreviewPath = preview
    ? tabs.find((tab) => tab.preview && tab.targetPath !== filePath)?.targetPath ?? null
    : null;
  const alreadyOpen = tabs.some((tab) => tab.mode === 'file' && tab.targetPath === filePath);
  state.openContextPanelTab(directory, { mode: 'file', targetPath: filePath, preview });
  if (replacedPreviewPath && !alreadyOpen) {
    useFilesViewTabsStore.getState().removeOpenPath(directory, replacedPreviewPath);
  }
};

export const createContextTabActions: UIStoreSlice<
  | 'openContextSurface'
  | 'openContextPanelTab'
  | 'openTrackerItem'
  | 'openContextDiff'
  | 'openContextFile'
  | 'openContextFileAtLine'
  | 'openContextOverview'
  | 'openContextPreview'
  | 'openAgentBrowserTab'
  | 'openNewContextBrowserTab'
  | 'openContextBrowser'
  | 'setContextPanelTabTargetPath'
  | 'moveContextFilePaths'
  | 'setActiveContextPanelTab'
  | 'reorderContextPanelTabs'
  | 'pinContextPanelTab'
  | 'closeContextPanelTab'
  | 'closeContextFile'
  | 'closeContextPanelTabs'
> = (set, get) => ({
  openContextSurface: (directory, mode) => {
    const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
    if (!normalizedDirectory) {
      return;
    }

    const state = get();
    const placement = state.contextSurfaceZones;
    const panelState = state.contextPanelByDirectory[normalizedDirectory];
    const tabs = panelState?.tabs ?? [];
    const zone = zoneOfMode(placement, mode);
    const zoneView = panelState ? getZoneView(panelState, zone) : null;
    const activeTabId = resolveZoneActiveTabId(tabs, placement, zone, zoneView?.activeTabId ?? null);
    const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;
    const clearTerminalTarget = () => {
      if (mode === 'terminal') {
        const terminalTab = tabs.find((tab) => tab.mode === 'terminal') ?? null;
        const targetDirectory = terminalTab?.targetDirectory ?? null;
        if (targetDirectory) {
          const targetState = useTerminalStore.getState().getDirectoryState(targetDirectory);
          if (directoryMayHaveActiveProjectAction(targetState)) {
            return;
          }
        }
        state.openContextPanelTab(normalizedDirectory, { mode: 'terminal', targetDirectory: null }, { reveal: false });
      }
    };

    if (zoneView?.isOpen && activeTab?.mode === mode) {
      clearTerminalTarget();
      state.closeContextZone(normalizedDirectory, zone);
      return;
    }

    if (mode === 'file' && !state.contextEditorTreeVisible
      && !tabs.some((tab) => tab.mode === 'file' && tab.targetPath)) {
      set({ contextEditorTreeVisible: true });
    }

    const tabsOfMode = tabs.filter((tab) => tab.mode === mode);
    if (tabsOfMode.length > 0) {
      clearTerminalTarget();
      const mostRecent = tabsOfMode.reduce((best, tab) => (tab.touchedAt >= best.touchedAt ? tab : best));
      if ((mode === 'diff' || mode === 'walkthrough') && mostRecent.targetDirectory) {
        state.openContextPanelTab(normalizedDirectory, {
          mode,
          targetPath: mostRecent.targetPath,
          stagedDiff: mostRecent.stagedDiff,
          diffScope: mostRecent.diffScope,
          targetDirectory: null,
        }, { recordReturn: false });
        return;
      }
      state.setActiveContextPanelTab(normalizedDirectory, mostRecent.id);
      return;
    }

    if (mode === 'chat') {
      return;
    }

    state.openContextPanelTab(normalizedDirectory, { mode }, { recordReturn: false });
  },

  openContextPanelTab: (directory, tab, options) => {
    const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
    if (!normalizedDirectory) {
      return;
    }

    const nextTab = tab.mode !== 'chat' && contextPanelModeKeepsTargetDirectory(tab.mode)
      ? {
          ...tab,
          targetDirectory: normalizeContextTargetDirectory(tab.targetDirectory) === normalizedDirectory
            ? null
            : normalizeContextTargetDirectory(tab.targetDirectory),
        }
      : tab;

    const reveals = options?.reveal !== false;
    const showsFile = nextTab.mode === 'file' && Boolean(nextTab.targetPath) && reveals;

    set((state) => {
      const placement = state.contextSurfaceZones;
      const prev = state.contextPanelByDirectory[normalizedDirectory];
      const current = touchContextPanelState(prev, placement);
      const zone = zoneOfMode(placement, nextTab.mode);
      const prevView = getZoneView(current, zone);
      const prevActiveTab = prevView.isOpen ? resolveZoneActiveTab(current, placement, zone) : null;
      const contextZoneReturnStack = !reveals
        ? state.contextZoneReturnStack
        : options?.recordReturn === false
          ? clearContextZoneReturnStack(state.contextZoneReturnStack, normalizedDirectory, zone)
          : pushContextZoneReturnEntry(state.contextZoneReturnStack, normalizedDirectory, zone, prevActiveTab, nextTab.mode);
      const byDirectory = {
        ...state.contextPanelByDirectory,
        [normalizedDirectory]: upsertContextPanelTab(current, nextTab, placement, options),
      };

      const clamped = clampContextPanelRoots(byDirectory, 20);
      return {
        contextPanelByDirectory: clamped,
        contextZoneReturnStack: pruneContextZoneReturnStacks(contextZoneReturnStack, clamped),
        contextEditorVisible: showsFile || state.contextEditorVisible,
      };
    });
  },

  openTrackerItem: (directory, item) => {
    const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
    const url = item.url.trim();
    if (!normalizedDirectory || !url) {
      return null;
    }

    const dedupeKey = `tracker:${item.key}`;
    const targetDirectory = normalizeContextTargetDirectory(item.targetDirectory);
    set((state) => {
      const placement = state.contextSurfaceZones;
      const current = touchContextPanelState(state.contextPanelByDirectory[normalizedDirectory], placement);
      const zone = zoneOfMode(placement, 'pr');
      const prevView = getZoneView(current, zone);
      const prevActiveTab = prevView.isOpen ? resolveZoneActiveTab(current, placement, zone) : null;
      const contextZoneReturnStack = pushContextZoneReturnEntry(
        state.contextZoneReturnStack,
        normalizedDirectory,
        zone,
        prevActiveTab,
        'pr',
      );
      const withBranch = current.tabs.some(isTrackerBranchTab)
        ? current
        : upsertContextPanelTab(current, { mode: 'pr' }, placement, { reveal: false });
      const byDirectory = {
        ...state.contextPanelByDirectory,
        [normalizedDirectory]: upsertContextPanelTab(withBranch, {
          mode: 'pr',
          targetPath: url,
          dedupeKey,
          label: item.label,
          targetDirectory: targetDirectory === normalizedDirectory ? null : targetDirectory,
        }, placement),
      };
      const clamped = clampContextPanelRoots(byDirectory, 20);
      return {
        contextPanelByDirectory: clamped,
        contextZoneReturnStack: pruneContextZoneReturnStacks(contextZoneReturnStack, clamped),
      };
    });
    return buildContextPanelTabID('pr', dedupeKey);
  },

  openContextDiff: (directory, filePath, staged = false, scope = null) => {
    const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
    const normalizedFilePath = (filePath || '').trim();
    if (!normalizedDirectory || !normalizedFilePath) {
      return;
    }

    const diffScope = normalizePendingDiffScope(scope) ?? (staged ? 'staged' : 'working');

    get().openContextPanelTab(normalizedDirectory, {
      mode: 'diff',
      targetPath: normalizedFilePath,
      stagedDiff: diffScope === 'staged',
      diffScope,
    });
  },

  openContextFile: (directory, filePath, options) => {
    const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
    const normalizedFilePath = normalizeContextTargetPath(filePath);
    if (!normalizedDirectory || !normalizedFilePath) {
      return;
    }

    openFileTab(get(), normalizedDirectory, normalizedFilePath, options?.preview === true);
    get().setPendingFileFocusPath(normalizedFilePath);
    get().setPendingFileNavigation(null);
    if (options?.expanded) {
      const zone = zoneOfMode(get().contextSurfaceZones, 'file');
      const panel = get().contextPanelByDirectory[normalizedDirectory];
      if (panel && !getZoneView(panel, zone).expanded) {
        get().toggleContextPanelExpanded(normalizedDirectory, zone);
      }
    }
  },

  openContextFileAtLine: (directory, filePath, line, column, options) => {
    const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
    const normalizedFilePath = normalizeContextTargetPath(filePath);
    const normalizedLine = Number.isFinite(line) ? Math.max(1, Math.trunc(line)) : 1;
    const normalizedColumn = Number.isFinite(column) ? Math.max(1, Math.trunc(column as number)) : 1;
    if (!normalizedDirectory || !normalizedFilePath) {
      return;
    }

    openFileTab(get(), normalizedDirectory, normalizedFilePath, options?.preview === true);
    get().setPendingFileFocusPath(null);
    get().setPendingFileNavigation({
      path: normalizedFilePath,
      line: normalizedLine,
      column: normalizedColumn,
    });
  },

  openContextOverview: (directory) => {
    const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
    if (!normalizedDirectory) {
      return;
    }

    get().openContextPanelTab(normalizedDirectory, { mode: 'context' });
  },

  openContextPreview: (directory, url) => {
    const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
    const normalizedUrl = (url || '').trim();
    if (!normalizedDirectory || !normalizedUrl || isVSCodeRuntime()) {
      return;
    }

    noteBrowserTabAddressRequested(get().contextPanelByDirectory, normalizedDirectory, normalizedUrl, normalizedUrl);
    get().openContextPanelTab(normalizedDirectory, {
      mode: 'browser',
      targetPath: normalizedUrl,
      dedupeKey: normalizedUrl,
      label: null,
    });
  },

  openAgentBrowserTab: (directory, url, ownerSessionId) => {
    const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
    if (!normalizedDirectory || isVSCodeRuntime()) return null;
    browserTabSequence += 1;
    const dedupeKey = `browser:agent:${Date.now()}-${browserTabSequence}`;
    if (url.trim()) noteBrowserTabAddressRequested(get().contextPanelByDirectory, normalizedDirectory, dedupeKey, url.trim());
    get().openContextPanelTab(normalizedDirectory, {
      mode: 'browser',
      targetPath: url.trim(),
      dedupeKey,
      label: null,
      ownerSessionId,
    }, { reveal: false });
    return buildContextPanelTabID('browser', dedupeKey);
  },

  openNewContextBrowserTab: (directory) => {
    const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
    if (!normalizedDirectory || isVSCodeRuntime()) return;
    browserTabSequence += 1;
    get().openContextPanelTab(normalizedDirectory, {
      mode: 'browser',
      targetPath: '',
      dedupeKey: `browser:new:${Date.now()}-${browserTabSequence}`,
      label: null,
    });
  },

  openContextBrowser: (directory, url = '', options) => {
    const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
    if (!normalizedDirectory || isVSCodeRuntime()) return;
    const targetUrl = typeof url === 'string' && url.trim().length > 0 ? url.trim() : '';
    if (targetUrl) noteBrowserTabAddressRequested(get().contextPanelByDirectory, normalizedDirectory, targetUrl, targetUrl);
    get().openContextPanelTab(normalizedDirectory, {
      mode: 'browser',
      targetPath: targetUrl,
      dedupeKey: targetUrl || 'browser',
      label: null,
    }, options);
  },

  setContextPanelTabTargetPath: (directory, tabID, targetPath) => {
    const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
    const normalizedTabID = (tabID || '').trim();
    if (!normalizedDirectory || !normalizedTabID) return;
    set((state) => {
      const current = state.contextPanelByDirectory[normalizedDirectory];
      if (!current) return state;
      return {
        contextPanelByDirectory: {
          ...state.contextPanelByDirectory,
          [normalizedDirectory]: setContextPanelTabTargetPath(current, normalizedTabID, targetPath),
        },
      };
    });
  },

  moveContextFilePaths: (directory, fromPath, toPath, filesRoot = directory) => {
    const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
    const normalizedFrom = normalizeContextTargetPath(fromPath);
    const normalizedTo = normalizeContextTargetPath(toPath);
    if (!normalizedDirectory || !normalizedFrom || !normalizedTo || normalizedFrom === normalizedTo) return;
    set((state) => {
      const current = state.contextPanelByDirectory[normalizedDirectory];
      if (!current) return state;
      const next = moveContextPanelFileTabs(current, normalizedFrom, normalizedTo);
      if (next === current) return state;
      return {
        contextPanelByDirectory: {
          ...state.contextPanelByDirectory,
          [normalizedDirectory]: next,
        },
      };
    });
    useFilesViewTabsStore.getState().movePaths(normalizeDirectoryPath(filesRoot.trim()), normalizedFrom, normalizedTo);
  },

  setActiveContextPanelTab: (directory, tabID) => {
    const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
    const normalizedTabID = (tabID || '').trim();
    if (!normalizedDirectory || !normalizedTabID) {
      return;
    }

    set((state) => {
      const prev = state.contextPanelByDirectory[normalizedDirectory];
      const current = touchContextPanelState(prev, state.contextSurfaceZones);
      const targetTab = current.tabs.find((tab) => tab.id === normalizedTabID);
      if (!targetTab) {
        return state;
      }

      const showsFile = targetTab.mode === 'file' && Boolean(targetTab.targetPath);
      const zone = zoneOfMode(state.contextSurfaceZones, targetTab.mode);
      const view = getZoneView(current, zone);
      const prevActiveTab = view.isOpen ? resolveZoneActiveTab(current, state.contextSurfaceZones, zone) : null;
      const sameModeSwitch = view.isOpen && prevActiveTab?.mode === targetTab.mode;

      if (view.activeTabId === normalizedTabID && view.isOpen) {
        return showsFile ? { contextEditorVisible: true } : state;
      }

      const contextZoneReturnStack = sameModeSwitch
        ? state.contextZoneReturnStack
        : clearContextZoneReturnStack(state.contextZoneReturnStack, normalizedDirectory, zone);

      const byDirectory = {
        ...state.contextPanelByDirectory,
        [normalizedDirectory]: withZoneView({
          ...current,
          touchedAt: Date.now(),
          tabs: current.tabs.map((tab) => (tab.id === normalizedTabID
            ? { ...tab, touchedAt: Date.now() }
            : tab)),
        }, zone, { isOpen: true, activeTabId: normalizedTabID }),
      };

      const clamped = clampContextPanelRoots(byDirectory, 20);
      return {
        contextPanelByDirectory: clamped,
        contextZoneReturnStack: pruneContextZoneReturnStacks(contextZoneReturnStack, clamped),
        contextEditorVisible: showsFile || state.contextEditorVisible,
      };
    });
  },

  reorderContextPanelTabs: (directory, activeTabID, overTabID) => {
    const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
    const normalizedActiveTabID = (activeTabID || '').trim();
    const normalizedOverTabID = (overTabID || '').trim();
    if (!normalizedDirectory || !normalizedActiveTabID || !normalizedOverTabID) {
      return;
    }

    set((state) => {
      const prev = state.contextPanelByDirectory[normalizedDirectory];
      const current = touchContextPanelState(prev, state.contextSurfaceZones);
      if (!current.tabs.some((tab) => tab.id === normalizedActiveTabID) || !current.tabs.some((tab) => tab.id === normalizedOverTabID)) {
        return state;
      }

      const next = reorderContextPanelTabs(current, normalizedActiveTabID, normalizedOverTabID);
      if (next.tabs === current.tabs) {
        return state;
      }

      const byDirectory = {
        ...state.contextPanelByDirectory,
        [normalizedDirectory]: next,
      };

      return { contextPanelByDirectory: clampContextPanelRoots(byDirectory, 20) };
    });
  },

  pinContextPanelTab: (directory, tabID) => {
    const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
    if (!normalizedDirectory) return;
    set((state) => {
      const current = state.contextPanelByDirectory[normalizedDirectory];
      if (!current?.tabs.some((tab) => tab.id === tabID && tab.preview)) return state;
      return {
        contextPanelByDirectory: {
          ...state.contextPanelByDirectory,
          [normalizedDirectory]: {
            ...current,
            tabs: current.tabs.map((tab) => (tab.id === tabID ? { ...tab, preview: false } : tab)),
          },
        },
      };
    });
  },

  closeContextPanelTab: (directory, tabID) => {
    get().closeContextPanelTabs(directory, [tabID]);
  },

  closeContextFile: (directory, filePath) => {
    const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
    const normalizedFilePath = normalizeContextTargetPath(filePath);
    if (!normalizedDirectory || !normalizedFilePath) {
      return;
    }
    const tab = get().contextPanelByDirectory[normalizedDirectory]?.tabs
      .find((candidate) => candidate.mode === 'file' && candidate.targetPath === normalizedFilePath);
    if (tab) {
      get().closeContextPanelTabs(normalizedDirectory, [tab.id]);
      return;
    }
    useFilesViewTabsStore.getState().removeOpenPath(normalizedDirectory, normalizedFilePath);
  },

  closeContextPanelTabs: (directory, tabIds) => {
    const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
    const branchTabIds = new Set((get().contextPanelByDirectory[normalizedDirectory]?.tabs ?? [])
      .filter(isTrackerBranchTab)
      .map((tab) => tab.id));
    const normalizedTabIds = (tabIds ?? [])
      .map((id) => (id || '').trim())
      .filter((id) => id.length > 0 && !branchTabIds.has(id));
    if (!normalizedDirectory || normalizedTabIds.length === 0) {
      return;
    }

    const closedTabs = normalizedTabIds
      .map((id) => get().contextPanelByDirectory[normalizedDirectory]?.tabs.find((tab) => tab.id === id))
      .filter((tab): tab is ContextPanelTab => Boolean(tab));

    set((state) => {
      const placement = state.contextSurfaceZones;
      const prev = state.contextPanelByDirectory[normalizedDirectory];
      const current = touchContextPanelState(prev, placement);
      if (!current.tabs.some((tab) => normalizedTabIds.includes(tab.id))) {
        return state;
      }

      const next = closeContextPanelTabs(current, normalizedTabIds, placement);
      let contextZoneReturnStack = state.contextZoneReturnStack;

      for (const zone of CONTEXT_ZONES) {
        if (getZoneView(current, zone).isOpen && !getZoneView(next, zone).isOpen) {
          contextZoneReturnStack = clearContextZoneReturnStack(contextZoneReturnStack, normalizedDirectory, zone);
        }
      }

      const fileView = getZoneView(next, zoneOfMode(placement, 'file'));
      const activeTab = next.tabs.find((tab) => tab.id === fileView.activeTabId);
      const returnedToTree = fileView.isOpen && activeTab?.mode === 'file' && !activeTab.targetPath;
      const byDirectory = {
        ...state.contextPanelByDirectory,
        [normalizedDirectory]: next,
      };

      const clamped = clampContextPanelRoots(byDirectory, 20);
      return {
        contextPanelByDirectory: clamped,
        contextZoneReturnStack: pruneContextZoneReturnStacks(contextZoneReturnStack, clamped),
        contextEditorTreeVisible: returnedToTree || state.contextEditorTreeVisible,
      };
    });

    for (const tab of closedTabs) {
      if (tab.mode === 'browser') forgetBrowserTabOpenedWithAddress(normalizedDirectory, tab.id);
      if (tab.mode === 'file' && tab.targetPath) {
        useFilesViewTabsStore.getState().removeOpenPath(normalizedDirectory, tab.targetPath);
      }
    }
  },
});
