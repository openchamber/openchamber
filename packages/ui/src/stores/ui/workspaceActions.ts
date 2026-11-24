import { shownMobileWorkspaceTabs, storedMobileWorkspaceTabOrder } from '@/lib/mobileWorkspaceTabs';
import { carrySurfaceToZone, getZoneView, resolveZoneActiveTabId, withZoneView, zoneOfMode, CONTEXT_ZONES } from '@/lib/workspace/zones';
import type { ContextZonePlacement } from '@/lib/workspace/zones';
import { sanitizeWorkStatusSectionOrder } from '@/components/chat/work-status/sections';
import { clampContextEditorTreeWidth, clampGitSidebarWidth } from './preferences';
import type { ContextPanelDirectoryState, UIStoreSlice } from './types';
import { normalizeDirectoryPath, clampContextZoneSize } from './contextTabs';
import {
  touchContextPanelState,
  clampContextPanelRoots,
  clearContextZoneReturnStack,
  pruneContextZoneReturnStacks,
  setContextZoneReturnStack,
  resolveContextZoneReturnTarget,
} from './contextPanelState';

export const createWorkspaceActions: UIStoreSlice<
  | 'toggleSidebar'
  | 'setSidebarOpen'
  | 'setSidebarFoldedForExpandedZone'
  | 'setSidebarWidth'
  | 'setContextRailOrder'
  | 'toggleContextEditorTree'
  | 'toggleContextEditor'
  | 'setContextEditorTreeWidth'
  | 'setGitSidebarWidth'
  | 'closeContextPanel'
  | 'toggleContextPanel'
  | 'closeContextZone'
  | 'toggleContextPanelExpanded'
  | 'setContextZoneSize'
  | 'setContextZoneExpandedChatSize'
  | 'moveContextSurfaceToZone'
  | 'setWorkStatusSectionExpanded'
  | 'setMessageQueueExpanded'
  | 'setWorkStatusScrollTop'
  | 'setWorkStatusPanelEnabled'
  | 'setWorkStatusPanelVisible'
  | 'setWorkStatusPanelFits'
  | 'setWorkStatusOverlayOpen'
  | 'setWorkStatusSectionVisible'
  | 'setWorkStatusHiddenSections'
  | 'setMobileWorkStatusSectionVisible'
  | 'setMobileWorkStatusHiddenSections'
  | 'setWorkStatusSectionOrder'
  | 'setContextRailSurfaceVisible'
  | 'setContextRailHiddenSurfaces'
  | 'setMobileWorkspaceTabOrder'
  | 'setMobileWorkspaceTabVisible'
> = (set, get) => ({
  toggleSidebar: () => {
    set((state) => ({ isSidebarOpen: !state.isSidebarOpen }));
  },

  setSidebarOpen: (open) => {
    set((state) => state.isSidebarOpen === open ? state : { isSidebarOpen: open });
  },

  setSidebarFoldedForExpandedZone: (folded) => {
    set((state) => state.sidebarFoldedForExpandedZone === folded ? state : { sidebarFoldedForExpandedZone: folded });
  },

  setSidebarWidth: (width) => {
    set({ sidebarWidth: width });
  },

  setContextRailOrder: (order) => {
    const sanitized = Array.isArray(order)
      ? order.filter((id, index) => typeof id === 'string' && id.trim() !== '' && order.indexOf(id) === index)
      : [];
    set({ contextRailOrder: sanitized });
  },

  toggleContextEditorTree: () => {
    set((state) => (state.contextEditorTreeVisible && !state.contextEditorVisible
      ? { contextEditorTreeVisible: false, contextEditorVisible: true }
      : { contextEditorTreeVisible: !state.contextEditorTreeVisible }));
  },

  toggleContextEditor: () => {
    set((state) => (state.contextEditorVisible && !state.contextEditorTreeVisible
      ? { contextEditorVisible: false, contextEditorTreeVisible: true }
      : { contextEditorVisible: !state.contextEditorVisible }));
  },

  setContextEditorTreeWidth: (width) => {
    if (!Number.isFinite(width)) {
      return;
    }
    set({ contextEditorTreeWidth: clampContextEditorTreeWidth(width) });
  },

  setGitSidebarWidth: (width) => {
    if (!Number.isFinite(width)) {
      return;
    }
    set({ gitSidebarWidth: clampGitSidebarWidth(width) });
  },

  closeContextPanel: (directory) => {
    get().closeContextZone(directory, 'right');
  },

  toggleContextPanel: (directory) => {
    const state = get();
    const panel = state.contextPanelByDirectory[directory];
    const rightTabId = panel
      ? resolveZoneActiveTabId(panel.tabs, state.contextSurfaceZones, 'right', getZoneView(panel, 'right').activeTabId)
      : null;
    if (panel?.isOpen) state.closeContextPanel(directory);
    else if (rightTabId) state.setActiveContextPanelTab(directory, rightTabId);
    else state.openContextSurface(directory, 'git');
  },

  closeContextZone: (directory, zone, options) => {
    const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
    if (!normalizedDirectory) {
      return;
    }

    set((state) => {
      const prev = state.contextPanelByDirectory[normalizedDirectory];
      if (!prev || !getZoneView(prev, zone).isOpen) {
        return state;
      }

      const current = touchContextPanelState(prev, state.contextSurfaceZones);
      if (options?.returnToPrevious) {
        const target = resolveContextZoneReturnTarget(
          current,
          state.contextSurfaceZones,
          zone,
          state.contextZoneReturnStack[normalizedDirectory]?.[zone],
          options.eligibleTabIds,
        );
        if (target) {
          const now = Date.now();
          const showsFile = target.tab.mode === 'file' && Boolean(target.tab.targetPath);
          const next = withZoneView({
            ...current,
            touchedAt: now,
            tabs: current.tabs.map((tab) => (tab.id === target.tab.id ? { ...tab, touchedAt: now } : tab)),
          }, zone, { isOpen: true, activeTabId: target.tab.id });
          const byDirectory = {
            ...state.contextPanelByDirectory,
            [normalizedDirectory]: next,
          };
          const clamped = clampContextPanelRoots(byDirectory, 20);
          return {
            contextPanelByDirectory: clamped,
            contextZoneReturnStack: pruneContextZoneReturnStacks(
              setContextZoneReturnStack(
                state.contextZoneReturnStack,
                normalizedDirectory,
                zone,
                target.remainingStack,
              ),
              clamped,
            ),
            contextEditorVisible: showsFile || state.contextEditorVisible,
          };
        }
      }

      const byDirectory = {
        ...state.contextPanelByDirectory,
        [normalizedDirectory]: withZoneView(current, zone, { isOpen: false }),
      };

      const clamped = clampContextPanelRoots(byDirectory, 20);
      return {
        contextPanelByDirectory: clamped,
        contextZoneReturnStack: pruneContextZoneReturnStacks(
          clearContextZoneReturnStack(state.contextZoneReturnStack, normalizedDirectory, zone),
          clamped,
        ),
      };
    });
  },

  toggleContextPanelExpanded: (directory, zone = 'right') => {
    const normalizedDirectory = normalizeDirectoryPath((directory || '').trim());
    if (!normalizedDirectory) {
      return;
    }

    set((state) => {
      const prev = state.contextPanelByDirectory[normalizedDirectory];
      const current = touchContextPanelState(prev, state.contextSurfaceZones);
      const expanded = !getZoneView(current, zone).expanded;
      let next = current;
      for (const other of CONTEXT_ZONES) {
        next = withZoneView(next, other, { expanded: other === zone ? expanded : false });
      }
      const byDirectory = {
        ...state.contextPanelByDirectory,
        [normalizedDirectory]: next,
      };

      return { contextPanelByDirectory: clampContextPanelRoots(byDirectory, 20) };
    });
  },

  setContextZoneSize: (zone, size) => {
    set((state) => ({ contextZoneSizes: { ...state.contextZoneSizes, [zone]: clampContextZoneSize(zone, size) } }));
  },

  setContextZoneExpandedChatSize: (zone, size) => {
    if (!Number.isFinite(size)) return;
    set((state) => ({ contextZoneExpandedChatSizes: { ...state.contextZoneExpandedChatSizes, [zone]: Math.max(0, Math.round(size)) } }));
  },

  moveContextSurfaceToZone: (mode, zone) => {
    set((state) => {
      const from = zoneOfMode(state.contextSurfaceZones, mode);
      if (from === zone) {
        return state;
      }

      const placement: ContextZonePlacement = { ...state.contextSurfaceZones };
      if (zone === 'right') {
        delete placement[mode];
      } else {
        placement[mode] = zone;
      }

      const byDirectory: Record<string, ContextPanelDirectoryState> = {};
      let contextZoneReturnStack = state.contextZoneReturnStack;
      for (const [directory, panel] of Object.entries(state.contextPanelByDirectory)) {
        const prevDest = getZoneView(panel, zone);
        const nextPanel = carrySurfaceToZone(panel, mode, from, zone, placement);
        const nextDest = getZoneView(nextPanel, zone);
        byDirectory[directory] = nextPanel;
        if (!getZoneView(nextPanel, from).isOpen) {
          contextZoneReturnStack = clearContextZoneReturnStack(contextZoneReturnStack, directory, from);
        }
        if (nextDest.isOpen && (nextDest.activeTabId !== prevDest.activeTabId || !prevDest.isOpen)) {
          contextZoneReturnStack = clearContextZoneReturnStack(contextZoneReturnStack, directory, zone);
        }
        const fromStack = contextZoneReturnStack[directory]?.[from];
        if (fromStack && fromStack.some((entry) => entry.mode === mode)) {
          contextZoneReturnStack = setContextZoneReturnStack(
            contextZoneReturnStack,
            directory,
            from,
            fromStack.filter((entry) => entry.mode !== mode),
          );
        }
      }

      return { contextSurfaceZones: placement, contextPanelByDirectory: byDirectory, contextZoneReturnStack };
    });
  },

  setWorkStatusSectionExpanded: (sectionId, expanded) => {
    set((state) => (
      state.workStatusExpandedSections[sectionId] === expanded
        ? state
        : {
          workStatusExpandedSections: {
            ...state.workStatusExpandedSections,
            [sectionId]: expanded,
          },
        }
    ));
  },

  setMessageQueueExpanded: (expanded) => {
    set((state) => (state.messageQueueExpanded === expanded ? state : { messageQueueExpanded: expanded }));
  },

  setWorkStatusScrollTop: (scrollTop) => {
    set({ workStatusScrollTop: Math.max(0, scrollTop) });
  },

  setWorkStatusPanelEnabled: (enabled) => {
    set({ workStatusPanelEnabled: enabled });
  },

  setWorkStatusPanelVisible: (visible) => {
    set((state) => (state.workStatusPanelVisible === visible ? state : { workStatusPanelVisible: visible }));
  },

  setWorkStatusPanelFits: (fits) => {
    set((state) => {
      if (state.workStatusPanelFits === fits) return state;
      return fits
        ? { workStatusPanelFits: true, workStatusOverlayOpen: false }
        : { workStatusPanelFits: false };
    });
  },

  setWorkStatusOverlayOpen: (open) => {
    set((state) => (state.workStatusOverlayOpen === open ? state : { workStatusOverlayOpen: open }));
  },

  setWorkStatusSectionVisible: (sectionId, visible) => {
    set((state) => {
      const hidden = state.workStatusHiddenSections;
      const isHidden = hidden.includes(sectionId);
      if (visible === !isHidden) return state;
      return {
        workStatusHiddenSectionsExplicit: true,
        workStatusHiddenSections: visible
          ? hidden.filter((entry) => entry !== sectionId)
          : [...hidden, sectionId],
      };
    });
  },

  setWorkStatusHiddenSections: (sectionIds) => {
    set({ workStatusHiddenSections: [...new Set(sectionIds)], workStatusHiddenSectionsExplicit: true });
  },

  setMobileWorkStatusSectionVisible: (sectionId, visible) => {
    set((state) => {
      const hidden = state.mobileWorkStatusHiddenSections;
      if (visible === !hidden.includes(sectionId)) return state;
      return {
        mobileWorkStatusHiddenSections: visible
          ? hidden.filter((entry) => entry !== sectionId)
          : [...hidden, sectionId],
      };
    });
  },

  setMobileWorkStatusHiddenSections: (sectionIds) => {
    set({ mobileWorkStatusHiddenSections: [...new Set(sectionIds)] });
  },

  setWorkStatusSectionOrder: (sectionIds) => {
    set({ workStatusSectionOrder: sanitizeWorkStatusSectionOrder(sectionIds), workStatusSectionOrderExplicit: true });
  },

  setContextRailSurfaceVisible: (surfaceId, visible) => {
    set((state) => {
      const hidden = state.contextRailHiddenSurfaces;
      const isHidden = hidden.includes(surfaceId);
      if (visible === !isHidden) return state;
      return {
        contextRailHiddenSurfaces: visible
          ? hidden.filter((entry) => entry !== surfaceId)
          : [...hidden, surfaceId],
      };
    });
  },

  setContextRailHiddenSurfaces: (surfaceIds) => {
    set({ contextRailHiddenSurfaces: [...new Set(surfaceIds)] });
  },

  setMobileWorkspaceTabOrder: (order) => {
    set((state) => ({ mobileWorkspaceTabOrder: storedMobileWorkspaceTabOrder(order, state.mobileWorkspaceTabOrder) }));
  },

  setMobileWorkspaceTabVisible: (tab, visible, extensions) => {
    set((state) => {
      const hidden = state.mobileWorkspaceHiddenTabs;
      if (visible) {
        return hidden.includes(tab) ? { mobileWorkspaceHiddenTabs: hidden.filter((entry) => entry !== tab) } : state;
      }
      if (hidden.includes(tab)) return state;
      const shown = shownMobileWorkspaceTabs(state.mobileWorkspaceTabOrder, hidden, extensions);
      if (shown.length <= 1) return state;
      return { mobileWorkspaceHiddenTabs: [...hidden, tab] };
    });
  },
});
