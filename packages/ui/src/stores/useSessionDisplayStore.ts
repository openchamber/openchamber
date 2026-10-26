import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { getSettingsSurface } from '@/lib/settings/surface';
import type { SettingsSurface } from '@/lib/settings/registry';

type ProjectSortOrder = 'manual' | 'a-z' | 'z-a' | 'date-added' | 'recent';
// Worktree groups inside a project. 'recent' floats worktrees with the latest
// session activity to the top, so the list moves as sessions run; 'manual'
// and 'a-z' keep positions stable.

// The Tree/List pair the one view replaced, read only until a grouping is
// chosen (`resolveSidebarGrouping`). 'projects' was Tree; 'timeline' was
// List, laid out by `listSessionGrouping`.
type SidebarViewMode = 'projects' | 'timeline';
// `sidebarGrouping`, and the old List's: 'project' puts each project's sessions under its header;
// 'time' lists every project's sessions together, newest activity first.
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
  /**
   * The sidebar's one view, on the desktop, the web and the phone: under each
   * project, or one list by time. Null until chosen, when it follows the
   * List/Tree pair it replaced (`resolveSidebarGrouping`).
   */
  sidebarGrouping: ListSessionGrouping | null;
  setSidebarGrouping: (grouping: ListSessionGrouping) => void;
  /** A work in the In work block also stays in its project or folder; off by default. */
  keepWorkInPlace: boolean;
  setKeepWorkInPlace: (keep: boolean) => void;
  /** Local display preference; motion remains opt-in. */
  animatedActivityIndicators: boolean;
  setAnimatedActivityIndicators: (enabled: boolean) => void;
  /** The managed Chats block in the sidebar (web and desktop). */
  showChatsSection: boolean;
  /** The In work block; hidden, its sessions stay in their projects. */
  showWorkSection: boolean;
  /** The Pinned block above In work; off by default. Hidden, pinned sessions stay in their projects. */
  showPinnedSection: boolean;
  /**
   * Works in two lines (branch, reference, project where projects mix) rather
   * than one. Off by default on a computer, on by default on a phone, whose
   * full-width rows have the room.
   */
  detailedZoneRows: boolean;
  // VS Code only: the compact webview keeps archived buckets inline because it
  // has no room for the full Archive page. Web/desktop ignore this flag and
  // always route archived sessions to the Archive page instead.
  showArchivedSessions: boolean;
  projectSortOrder: ProjectSortOrder;
  setShowChatsSection: (show: boolean) => void;
  setShowWorkSection: (show: boolean) => void;
  setShowPinnedSection: (show: boolean) => void;
  setDetailedZoneRows: (detailed: boolean) => void;
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
    // v4 removes the default/minimal display mode: the sidebar now has a
    // single row layout. Drop the stale key from persisted state.
    delete state.displayMode;
  }
  if (version < 6) {
    // v6 removes the by-worktree/flat grouping choice: the projects view always
    // groups by worktree, and the flat recency list became the timeline view.
    delete state.sessionGroupingMode;
  }
  if (version < 7) {
    // v7 removes the sticky-headers toggle: zone headers are always pinned.
    delete state.stickyZoneHeaders;
  }
  if (version < 10) {
    // v10 removes Recent: In work holds the sessions being worked on, and the
    // timeline view answers "what was I doing" across projects.
    delete state.showRecentSection;
  }
  if (version < 11) {
    // v11 removes the worktree sort: a worktree is a work among the
    // project's works, listed by activity like the rest.
    delete state.worktreeSortOrder;
  }
  if (version < 12 && surface === 'mobile' && state.sidebarViewMode !== 'projects') {
    // v12 gives the phone the works view, two-line by default. Its List always
    // drew two lines, so a phone on List keeps them; Tree keeps its choice.
    state.detailedZoneRows = true;
  }
  return state;
};

/**
 * How the desktop and web sidebar groups works. Before the choice is made in
 * the one view, a List sorted by time keeps its list by time; Tree and List by
 * project both group under projects.
 */
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
      // New installs start on the timeline. Stored state keeps an earlier
      // choice, and VS Code always renders the grouped view.
      sidebarViewMode: 'timeline',
      setSidebarViewMode: (mode) => set({ sidebarViewMode: mode }),
      listSessionGrouping: 'project',
      setListSessionGrouping: (grouping) => set({ listSessionGrouping: grouping }),
      sidebarGrouping: null,
      setSidebarGrouping: (grouping) => set({ sidebarGrouping: grouping }),
      keepWorkInPlace: false,
      setKeepWorkInPlace: (keep) => set({ keepWorkInPlace: keep }),
      showChatsSection: true,
      showWorkSection: true,
      // On for new installs: pinned work gets its own block on top. Stored
      // state keeps an earlier choice.
      showPinnedSection: true,
      detailedZoneRows: getSettingsSurface() === 'mobile',
      // Default to HIDDEN so the pre-hydration state matches the quiet/safe
      // option: archived sessions must never flash visible on startup and then
      // disappear once the persisted preference rehydrates.
      showArchivedSessions: false,
      projectSortOrder: 'manual',
      setShowChatsSection: (show) => set({ showChatsSection: show }),
      setShowWorkSection: (show) => set({ showWorkSection: show }),
      setShowPinnedSection: (show) => set({ showPinnedSection: show }),
      setDetailedZoneRows: (detailed) => set({ detailedZoneRows: detailed }),
      setShowArchivedSessions: (show) => set({ showArchivedSessions: show }),
      toggleArchivedSessions: () => set((state) => ({ showArchivedSessions: !state.showArchivedSessions })),
      setProjectSortOrder: (order) => set({ projectSortOrder: order }),
    }),
    {
      name: 'session-display-mode',
      version: 12,
      // v1→v2 adds projectSortOrder using the canonical manual ordering.
      // v2→v3 replaces the previously shipped recent default with manual.
      // v3→v4 removes displayMode (single sidebar row layout).
      // v4→v5 adds the independent all-projects/single-project view mode.
      // v5→v6 drops sessionGroupingMode in favour of sidebarViewMode.
      // v6→v7 drops stickyZoneHeaders (derived from the view mode now).
      // v7→v8 turned Recent off by default.
      // v8→v9 added worktreeSortOrder; v10→v11 drops it again.
      // v9→v10 drops showRecentSection (Recent is gone).
      // v11→v12 turns two-line rows on for a phone that was on List.
      migrate: migrateSessionDisplayState,
    },
  ),
);

export type {
  ProjectSortOrder
};
