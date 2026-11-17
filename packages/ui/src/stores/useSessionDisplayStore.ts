import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { z } from 'zod';
import { DEFAULT_SIDEBAR_LAYOUT, sidebarLayoutSchema, type SidebarLayout } from './sidebarLayout';

type ProjectSortOrder = 'manual' | 'a-z' | 'z-a' | 'date-added' | 'recent';
// Worktree groups inside a project. 'recent' floats worktrees with the latest
// session activity to the top, so the list moves as sessions run; 'manual'
// and 'a-z' keep positions stable.
type WorktreeSortOrder = 'recent' | 'manual' | 'a-z';

// 'projects' is the grouped sidebar, labelled Tree: project zones with
// worktree sub-headers. 'timeline', labelled List, lists root sessions
// without worktree groups or folders, laid out by `listSessionGrouping`.
export type SidebarViewMode = 'projects' | 'timeline';
// List only: 'project' puts each project's sessions under its header;
// 'time' lists every project's sessions together, newest activity first.
type ListSessionGrouping = 'project' | 'time';
type ProjectDisplayMode = 'all' | 'single';

/** Tree zone rows (Pinned, In work): one line like the tree, or two with branch, PR and model. */
export type SessionRowLines = 'one' | 'two';

/**
 * Optional row elements, shown where the row already has a slot for them.
 * Live status and permission/question badges are not here: a row always
 * says when it needs the user.
 */
export type SessionRowElements = {
  showBranch: boolean;
  showPrBadge: boolean;
  showProviderLogo: boolean;
  showProjectIcon: boolean;
  showGoal: boolean;
  showTime: boolean;
  /** The pin glyph on a pinned row. */
  showPinnedMarker: boolean;
  /** Jev's "looks done" check next to the time. */
  showDoneHint: boolean;
  /** The directory action indicator on rows whose session has a directory. */
  showDirectoryIndicator: boolean;
};

/** Which row lines the Tree zones take, and which optional elements rows show. */
/** Line counts per row kind: the Tree zones, the List rows, Chats rows, and the Tree's project rows. */
export type SessionRowDisplay = {
  zoneLines: SessionRowLines;
  listLines: SessionRowLines;
  chatsLines: SessionRowLines;
  projectLines: SessionRowLines;
} & SessionRowElements;

export const DEFAULT_SESSION_ROW_ELEMENTS: SessionRowElements = Object.freeze({
  showBranch: true,
  showPrBadge: true,
  showProviderLogo: true,
  showProjectIcon: true,
  showGoal: true,
  showTime: true,
  showPinnedMarker: true,
  showDoneHint: true,
  showDirectoryIndicator: true,
});

const DEFAULT_SESSION_ROW_DISPLAY: SessionRowDisplay = Object.freeze({
  zoneLines: 'one',
  // List rows carry two lines today (the folded layout option defaulted off),
  // Chats and project rows one, so the defaults reproduce today's rows.
  listLines: 'two',
  chatsLines: 'one',
  projectLines: 'one',
  ...DEFAULT_SESSION_ROW_ELEMENTS,
});

/**
 * A stored row display, completed with the defaults: a field that is
 * missing or holds a value this version does not know falls back to its
 * default, so a display saved by a newer version still applies what this
 * one understands. Anything that is not an object fails to parse.
 */
export const sessionRowDisplaySchema = z.object({
  zoneLines: z.enum(['one', 'two']).optional().catch(undefined),
  listLines: z.enum(['one', 'two']).optional().catch(undefined),
  chatsLines: z.enum(['one', 'two']).optional().catch(undefined),
  projectLines: z.enum(['one', 'two']).optional().catch(undefined),
  showBranch: z.boolean().optional().catch(undefined),
  showPrBadge: z.boolean().optional().catch(undefined),
  showProviderLogo: z.boolean().optional().catch(undefined),
  showProjectIcon: z.boolean().optional().catch(undefined),
  showGoal: z.boolean().optional().catch(undefined),
  showTime: z.boolean().optional().catch(undefined),
  showPinnedMarker: z.boolean().optional().catch(undefined),
  showDoneHint: z.boolean().optional().catch(undefined),
  showDirectoryIndicator: z.boolean().optional().catch(undefined),
}).transform((stored): SessionRowDisplay => ({
  zoneLines: stored.zoneLines ?? DEFAULT_SESSION_ROW_DISPLAY.zoneLines,
  listLines: stored.listLines ?? DEFAULT_SESSION_ROW_DISPLAY.listLines,
  chatsLines: stored.chatsLines ?? DEFAULT_SESSION_ROW_DISPLAY.chatsLines,
  projectLines: stored.projectLines ?? DEFAULT_SESSION_ROW_DISPLAY.projectLines,
  showBranch: stored.showBranch ?? DEFAULT_SESSION_ROW_DISPLAY.showBranch,
  showPrBadge: stored.showPrBadge ?? DEFAULT_SESSION_ROW_DISPLAY.showPrBadge,
  showProviderLogo: stored.showProviderLogo ?? DEFAULT_SESSION_ROW_DISPLAY.showProviderLogo,
  showProjectIcon: stored.showProjectIcon ?? DEFAULT_SESSION_ROW_DISPLAY.showProjectIcon,
  showGoal: stored.showGoal ?? DEFAULT_SESSION_ROW_DISPLAY.showGoal,
  showTime: stored.showTime ?? DEFAULT_SESSION_ROW_DISPLAY.showTime,
  showPinnedMarker: stored.showPinnedMarker ?? DEFAULT_SESSION_ROW_DISPLAY.showPinnedMarker,
  showDoneHint: stored.showDoneHint ?? DEFAULT_SESSION_ROW_DISPLAY.showDoneHint,
  showDirectoryIndicator: stored.showDirectoryIndicator ?? DEFAULT_SESSION_ROW_DISPLAY.showDirectoryIndicator,
}));

type SessionDisplayStore = {
  projectDisplayMode: ProjectDisplayMode;
  singleProjectId: string | null;
  setProjectDisplayMode: (mode: ProjectDisplayMode) => void;
  setSingleProjectId: (projectId: string) => void;
  sidebarViewMode: SidebarViewMode;
  setSidebarViewMode: (mode: SidebarViewMode) => void;
  listSessionGrouping: ListSessionGrouping;
  setListSessionGrouping: (grouping: ListSessionGrouping) => void;
  /** Local display preference; motion remains opt-in. */
  animatedActivityIndicators: boolean;
  setAnimatedActivityIndicators: (enabled: boolean) => void;
  /** The managed Chats block in the sidebar (web and desktop). */
  showChatsSection: boolean;
  /** The In work block; hidden, its sessions stay in their projects. */
  showWorkSection: boolean;
  /** The Pinned block above In work; off by default. Hidden, pinned sessions stay in their projects. */
  showPinnedSection: boolean;
  /** How many lines each sidebar row kind takes, and which optional elements rows show. */
  sessionRowDisplay: SessionRowDisplay;
  setSessionRowDisplay: (patch: Partial<SessionRowDisplay>) => void;
  setSessionRowElement: <K extends keyof SessionRowElements>(key: K, value: SessionRowElements[K]) => void;
  // VS Code only: the compact webview keeps archived buckets inline because it
  // has no room for the full Archive page. Web/desktop ignore this flag and
  // always route archived sessions to the Archive page instead.
  showArchivedSessions: boolean;
  projectSortOrder: ProjectSortOrder;
  worktreeSortOrder: WorktreeSortOrder;
  /** Section order, attention sections, the open session's hold and the List layout (`sidebarLayout.ts`). */
  sidebarLayout: SidebarLayout;
  setSidebarLayout: (layout: SidebarLayout) => void;
  setShowChatsSection: (show: boolean) => void;
  setShowWorkSection: (show: boolean) => void;
  setShowPinnedSection: (show: boolean) => void;
  setShowArchivedSessions: (show: boolean) => void;
  toggleArchivedSessions: () => void;
  setProjectSortOrder: (order: ProjectSortOrder) => void;
  setWorktreeSortOrder: (order: WorktreeSortOrder) => void;
};

export const migrateSessionDisplayState = (
  persisted: unknown,
  version: number,
): Partial<SessionDisplayStore> => {
  const state = (persisted ?? {}) as Partial<SessionDisplayStore> & {
    displayMode?: string;
    sessionGroupingMode?: string;
    stickyZoneHeaders?: boolean;
    showRecentSection?: boolean;
    detailedZoneRows?: boolean;
    sidebarLayout?: { timelineCompactRows?: unknown };
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
  if (version < 9 && !state.worktreeSortOrder) {
    // v9 adds the worktree sort. Everyone starts on a stable manual order:
    // an activity-sorted list moved rows under the pointer, next to
    // destructive actions like deleting a worktree.
    state.worktreeSortOrder = 'manual';
  }
  if (version < 10) {
    // v10 removes Recent: In work holds the sessions being worked on, and the
    // timeline view answers "what was I doing" across projects.
    delete state.showRecentSection;
  }
  if (version < 12) {
    // v12 folds the Detailed rows toggle into the row display: the toggle's
    // value becomes the Tree zone line count, every element starts shown
    // (exactly today's rows), and the old key goes away.
    const detailedZoneRows = state.detailedZoneRows;
    delete state.detailedZoneRows;
    const zoneLines: SessionRowLines | undefined = detailedZoneRows === true ? 'two' : detailedZoneRows === false ? 'one' : undefined;
    state.sessionRowDisplay = {
      ...DEFAULT_SESSION_ROW_DISPLAY,
      ...state.sessionRowDisplay,
      ...(zoneLines === undefined ? null : { zoneLines }),
    };
  }
  if (version < 13) {
    // v13 folds the List view's one-line layout option (the sidebar layout's
    // timelineCompactRows) into the row display as listLines, and adds the
    // Chats and Tree project line counts at their defaults. A row display
    // saved by a newer version keeps its own listLines.
    const compactRows = state.sidebarLayout?.timelineCompactRows;
    const listLines: SessionRowLines | undefined = compactRows === true ? 'one' : compactRows === false ? 'two' : undefined;
    state.sessionRowDisplay = {
      ...DEFAULT_SESSION_ROW_DISPLAY,
      ...state.sessionRowDisplay,
      ...(listLines === undefined || state.sessionRowDisplay?.listLines !== undefined ? null : { listLines }),
    };
  }
  return state;
};

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
      showChatsSection: true,
      showWorkSection: true,
      showPinnedSection: false,
      sessionRowDisplay: DEFAULT_SESSION_ROW_DISPLAY,
      // Default to HIDDEN so the pre-hydration state matches the quiet/safe
      // option: archived sessions must never flash visible on startup and then
      // disappear once the persisted preference rehydrates.
      showArchivedSessions: false,
      projectSortOrder: 'manual',
      worktreeSortOrder: 'manual',
      sidebarLayout: DEFAULT_SIDEBAR_LAYOUT,
      setSidebarLayout: (layout) => set({ sidebarLayout: layout }),
      setShowChatsSection: (show) => set({ showChatsSection: show }),
      setShowWorkSection: (show) => set({ showWorkSection: show }),
      setShowPinnedSection: (show) => set({ showPinnedSection: show }),
      setSessionRowDisplay: (patch) => set((state) => ({ sessionRowDisplay: { ...state.sessionRowDisplay, ...patch } })),
      setSessionRowElement: (key, value) => set((state) => ({ sessionRowDisplay: { ...state.sessionRowDisplay, [key]: value } })),
      setShowArchivedSessions: (show) => set({ showArchivedSessions: show }),
      toggleArchivedSessions: () => set((state) => ({ showArchivedSessions: !state.showArchivedSessions })),
      setProjectSortOrder: (order) => set({ projectSortOrder: order }),
      setWorktreeSortOrder: (order) => set({ worktreeSortOrder: order }),
    }),
    {
      name: 'session-display-mode',
      version: 13,
      // v1→v2 adds projectSortOrder using the canonical manual ordering.
      // v2→v3 replaces the previously shipped recent default with manual.
      // v3→v4 removes displayMode (single sidebar row layout).
      // v4→v5 adds the independent all-projects/single-project view mode.
      // v5→v6 drops sessionGroupingMode in favour of sidebarViewMode.
      // v6→v7 drops stickyZoneHeaders (derived from the view mode now).
      // v7→v8 turned Recent off by default.
      // v8→v9 adds worktreeSortOrder (manual by default).
      // v9→v10 drops showRecentSection (Recent is gone).
      // v10→v11 adds sidebarLayout (default on hydration when missing).
      // v11→v12 folds detailedZoneRows into sessionRowDisplay.zoneLines.
      // v12→v13 folds sidebarLayout.timelineCompactRows into
      // sessionRowDisplay.listLines and adds chatsLines/projectLines.
      migrate: migrateSessionDisplayState,
      // Hydration parses the sidebar layout and the row display whatever the
      // stored version: a missing one keeps the default, a stored one (also
      // from a newer version or edited by hand) keeps what this version
      // understands field by field, and one that is not a layout or display
      // is dropped, so the sidebar never draws from a partial value.
      merge: (persisted, current) => {
        // SAFETY: the persisted value is this store's own state written by `persist`;
        // the layout and the row display, the fields the sidebar cannot draw
        // from partially, are parsed below.
        const stored = (persisted ?? {}) as Partial<SessionDisplayStore>;
        const layout = stored.sidebarLayout === undefined ? null : sidebarLayoutSchema.safeParse(stored.sidebarLayout);
        const rowDisplay = stored.sessionRowDisplay === undefined ? null : sessionRowDisplaySchema.safeParse(stored.sessionRowDisplay);
        return {
          ...current,
          ...stored,
          sidebarLayout: layout?.success ? layout.data : current.sidebarLayout,
          sessionRowDisplay: rowDisplay?.success ? rowDisplay.data : current.sessionRowDisplay,
        };
      },
    },
  ),
);

export type {
  ProjectSortOrder,
  WorktreeSortOrder
};
