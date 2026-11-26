import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { getSettingsSurface } from '@/lib/settings/surface';
import { getRuntimeKey, isTransientRuntimeKey, subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch';
import type { SettingsSurface } from '@/lib/settings/registry';
import {
  clampSessionBatchSize,
  DEFAULT_SIDEBAR_SECTIONS,
  hiddenSidebarSectionsSchema,
  sidebarPageIdsSchema,
  sidebarPinListsSchema,
  sidebarSectionsSchema,
  type SidebarPinList,
  type SidebarSectionEntry,
} from '@/lib/sidebarSections';

type ProjectSortOrder = 'manual' | 'a-z' | 'z-a' | 'date-added' | 'recent';

type SidebarViewMode = 'projects' | 'timeline';
type ListSessionGrouping = 'project' | 'time';
type ProjectDisplayMode = 'all' | 'single';

type SessionDisplayStore = {
  projectDisplayMode: ProjectDisplayMode;
  singleProjectId: string | null;
  setProjectDisplayMode: (mode: ProjectDisplayMode) => void;
  setSingleProjectId: (projectId: string) => void;
  sidebarViewMode: SidebarViewMode;
  setSidebarViewMode: (mode: SidebarViewMode) => void;
  listSessionGrouping: ListSessionGrouping;
  setListSessionGrouping: (grouping: ListSessionGrouping) => void;
  sidebarGrouping: ListSessionGrouping | null;
  setSidebarGrouping: (grouping: ListSessionGrouping) => void;
  keepWorkInPlace: boolean;
  setKeepWorkInPlace: (keep: boolean) => void;
  keepPinnedInPlace: boolean;
  setKeepPinnedInPlace: (keep: boolean) => void;
  pinnedInWork: boolean;
  sessionBatchSize: number | null;
  setSessionBatchSize: (size: number) => void;
  animatedActivityIndicators: boolean;
  setAnimatedActivityIndicators: (enabled: boolean) => void;
  showChatsSection: boolean;
  showWorkSection: boolean;
  showPinnedSection: boolean;
  detailedZoneRows: boolean;
  showSubagentSessions: boolean;
  worktreeNameByBranch: boolean;
  sections: SidebarSectionEntry[];
  pinLists: SidebarPinList[];
  hiddenSections: string[];
  pageOrder: string[];
  hiddenPages: string[];
  sectionsOwner: string | null;
  setSections: (sections: SidebarSectionEntry[]) => void;
  setPinLists: (lists: SidebarPinList[]) => void;
  setHiddenSections: (ids: string[]) => void;
  setPageOrder: (ids: string[]) => void;
  setHiddenPages: (ids: string[]) => void;
  showArchivedSessions: boolean;
  projectSortOrder: ProjectSortOrder;
  setShowChatsSection: (show: boolean) => void;
  setShowWorkSection: (show: boolean) => void;
  setShowPinnedSection: (show: boolean) => void;
  setDetailedZoneRows: (detailed: boolean) => void;
  setShowSubagentSessions: (show: boolean) => void;
  setWorktreeNameByBranch: (byBranch: boolean) => void;
  setShowArchivedSessions: (show: boolean) => void;
  toggleArchivedSessions: () => void;
  setProjectSortOrder: (order: ProjectSortOrder) => void;
};

export const migrateSessionDisplayState = (
  persisted: unknown,
  version: number,
  surface: SettingsSurface = getSettingsSurface(),
): Partial<SessionDisplayStore> => {
  const state = (persisted ?? {}) as Partial<SessionDisplayStore> & {
    displayMode?: string;
    sessionGroupingMode?: string;
    stickyZoneHeaders?: boolean;
    showRecentSection?: boolean;
    worktreeSortOrder?: string;
  };
  if (version < 2) {
    state.projectSortOrder = 'manual';
  }
  if (version < 3 && state.projectSortOrder === 'recent') {
    state.projectSortOrder = 'manual';
  }
  if (version < 4) {
    delete state.displayMode;
  }
  if (version < 6) {
    delete state.sessionGroupingMode;
  }
  if (version < 7) {
    delete state.stickyZoneHeaders;
  }
  if (version < 10) {
    delete state.showRecentSection;
  }
  if (version < 11) {
    delete state.worktreeSortOrder;
  }
  if (version < 12 && surface === 'mobile' && state.sidebarViewMode !== 'projects') {
    state.detailedZoneRows = true;
  }
  return state;
};

export const resolveSidebarGrouping = (
  state: Pick<SessionDisplayStore, 'sidebarGrouping' | 'sidebarViewMode' | 'listSessionGrouping'>,
): ListSessionGrouping => state.sidebarGrouping
  ?? (state.sidebarViewMode === 'timeline' && state.listSessionGrouping === 'time' ? 'time' : 'project');

export const useSessionDisplayStore = create<SessionDisplayStore>()(
  persist(
    (set) => ({
      animatedActivityIndicators: false,
      setAnimatedActivityIndicators: (enabled) => set({ animatedActivityIndicators: enabled }),
      projectDisplayMode: 'all',
      singleProjectId: null,
      setProjectDisplayMode: (mode) => set({ projectDisplayMode: mode }),
      setSingleProjectId: (projectId) => set({ singleProjectId: projectId }),
      sidebarViewMode: 'timeline',
      setSidebarViewMode: (mode) => set({ sidebarViewMode: mode }),
      listSessionGrouping: 'project',
      setListSessionGrouping: (grouping) => set({ listSessionGrouping: grouping }),
      sidebarGrouping: null,
      setSidebarGrouping: (grouping) => set({ sidebarGrouping: grouping }),
      keepWorkInPlace: false,
      setKeepWorkInPlace: (keep) => set({ keepWorkInPlace: keep }),
      keepPinnedInPlace: true,
      setKeepPinnedInPlace: (keep) => set({ keepPinnedInPlace: keep }),
      pinnedInWork: false,
      sessionBatchSize: null,
      setSessionBatchSize: (size) => set({ sessionBatchSize: clampSessionBatchSize(size) }),
      showChatsSection: true,
      showWorkSection: true,
      showPinnedSection: true,
      detailedZoneRows: getSettingsSurface() === 'mobile',
      showSubagentSessions: true,
      worktreeNameByBranch: false,
      sections: [...DEFAULT_SIDEBAR_SECTIONS],
      pinLists: [],
      hiddenSections: [],
      pageOrder: [],
      hiddenPages: [],
      sectionsOwner: null,
      setSections: (sections) => set({ sections: sidebarSectionsSchema.parse(sections), sectionsOwner: getRuntimeKey() }),
      setPinLists: (lists) => set({ pinLists: sidebarPinListsSchema.parse(lists), sectionsOwner: getRuntimeKey() }),
      setHiddenSections: (ids) => set({ hiddenSections: hiddenSidebarSectionsSchema.parse(ids), sectionsOwner: getRuntimeKey() }),
      setPageOrder: (ids) => set({ pageOrder: sidebarPageIdsSchema.parse(ids), sectionsOwner: getRuntimeKey() }),
      setHiddenPages: (ids) => set({ hiddenPages: sidebarPageIdsSchema.parse(ids), sectionsOwner: getRuntimeKey() }),
      showArchivedSessions: false,
      projectSortOrder: 'manual',
      setShowChatsSection: (show) => set({ showChatsSection: show }),
      setShowWorkSection: (show) => set({ showWorkSection: show }),
      setShowPinnedSection: (show) => set({ showPinnedSection: show }),
      setDetailedZoneRows: (detailed) => set({ detailedZoneRows: detailed }),
      setShowSubagentSessions: (show) => set({ showSubagentSessions: show }),
      setWorktreeNameByBranch: (byBranch) => set({ worktreeNameByBranch: byBranch }),
      setShowArchivedSessions: (show) => set({ showArchivedSessions: show }),
      toggleArchivedSessions: () => set((state) => ({ showArchivedSessions: !state.showArchivedSessions })),
      setProjectSortOrder: (order) => set({ projectSortOrder: order }),
    }),
    {
      name: 'session-display-mode',
      version: 12,
      migrate: migrateSessionDisplayState,
      merge: (persisted, current) => {
        // SAFETY: `migrate` has already brought the stored state to this version's shape.
        const state = (persisted ?? {}) as Partial<SessionDisplayStore>;
        const sections = sidebarSectionsSchema.safeParse(state.sections ?? current.sections);
        return { ...current, ...state, sections: sections.success ? sections.data : [...DEFAULT_SIDEBAR_SECTIONS] };
      },
    },
  ),
);

export type {
  ProjectSortOrder
};

export const useSidebarRowDisplay = (): Pick<SessionDisplayStore, 'showChatsSection' | 'showSubagentSessions'> => ({
  showChatsSection: useSessionDisplayStore((state) => state.showChatsSection),
  showSubagentSessions: useSessionDisplayStore((state) => state.showSubagentSessions),
});

export const dropSectionsOfOtherInstance = (runtimeKey: string): void => {
  const state = useSessionDisplayStore.getState();
  if (state.sectionsOwner === null || state.sectionsOwner === runtimeKey || isTransientRuntimeKey(runtimeKey)) return;
  useSessionDisplayStore.setState({ sections: [...DEFAULT_SIDEBAR_SECTIONS], pinLists: [], hiddenSections: [], pageOrder: [], hiddenPages: [], sectionsOwner: null });
};
subscribeRuntimeEndpointWillChange(({ runtimeKey }) => dropSectionsOfOtherInstance(runtimeKey));
queueMicrotask(() => dropSectionsOfOtherInstance(getRuntimeKey()));
