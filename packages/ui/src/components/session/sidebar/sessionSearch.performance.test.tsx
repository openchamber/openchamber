import { describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Session } from '@opencode-ai/sdk/v2';
import { I18nProvider } from '@/lib/i18n';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import type { SessionFoldersMap } from '@/stores/useSessionFoldersStore';
import type { WorktreeMetadata } from '@/types/worktree';
import { useSessionActions } from './sessions/useSessionActions';
import { createSessionOwnershipIndex } from './sessions/sessionOwnership';
import { useProjectSessionLists } from './projects/useProjectSessionLists';
import { useSessionGrouping } from './projects/useSessionGrouping';
import { useSessionSidebarSections } from './projects/useSessionSidebarSections';
import type { SessionGroup, SessionNode, SessionNodeSearchResult } from './types';
import { installHookTestDom } from './test-utils/testDom';

/**
 * Session sidebar search performance harness.
 *
 * What is real:
 * - `useDebouncedValue` (the production 120ms debounce).
 * - `useSessionGrouping` and its real `filterSessionNodesForSearch` matcher.
 * - `useSessionSidebarSections` and its real per-group search pass, flat/grouped
 *   projections and `searchMatchCount`.
 * - `useProjectSessionLists` + `createSessionOwnershipIndex` project routing.
 * - `useSessionActions` row callbacks, exactly as `SessionTreeItem` wires them.
 *
 * What is simulated:
 * - The raw-query state owner and the prop construction that live in
 *   `SessionSidebar` / `SessionProjectCollection`. The memoized components in
 *   between (`SessionProjectScroller`, `SessionGroupSection`, `SessionNodeItem`)
 *   cannot be imported by a `bun test` file: their transitive import graph
 *   reaches `hooks/useProviderLogo.ts`, whose `import.meta.glob(...)` is a
 *   Vite-only transform and throws `TypeError: import.meta.glob is not a
 *   function` under Bun. This file therefore uses no module mocking and
 *   measures the closest importable real boundary instead.
 *
 * Regression contract:
 * - `useSessionActions`' `handleSessionSelect` must keep its identity while
 *   the raw query changes. `SessionNodeItem`'s memo comparator
 *   (`callbacksEqual`) compares exactly this callback, so identity churn on a
 *   raw pre-debounce keystroke would force every mounted row to re-render.
 *   The sidebar now passes a single dependency-free `resetSessionSearch`
 *   intent instead of the raw query and setters, and the assertion below
 *   guards that wiring.
 * - `SessionGroupSection`'s comparator must not compare raw
 *   `sessionSearchQuery`; it only sees `hasSessionSearchQuery` /
 *   `normalizedSessionSearchQuery`, which change after the debounce. That is
 *   the component-level half this harness cannot mount; it proves the
 *   row-callback half and the data-path half.
 *
 * Scale baselines print `[session-search-perf]` JSON lines with the filter
 * invocation count/time and the matched-node counts per scenario.
 *
 * Measurement limitation: the row data path is real, but `SessionGroupSection`
 * cannot be mounted here, so this file cannot count mounted rows. It pins the
 * exact node count the component receives (`filteredNodes.length` = every
 * matched session). Since Step 4 the component virtualizes 50+ row search
 * results in both buckets, so that model count is no longer the mounted-row
 * count.
 */

const PROJECT_ROOT = '/repo/perf';
const HOME_DIR = '/home/user';

const PROJECTS = [{ id: 'project', path: PROJECT_ROOT, normalizedPath: PROJECT_ROOT }];
const EMPTY_WORKTREES = new Map<string, WorktreeMetadata[]>();
const EMPTY_WORKTREE_METADATA = new Map<string, WorktreeMetadata>();
const EMPTY_BRANCHES = new Map<string, string | null>();
const EMPTY_REPO_STATUS = new Map<string, boolean | null>();
const EMPTY_ROOT_BRANCHES = new Map<string, string | null>();
const EMPTY_SESSION_ORDER = new Map<string, number>();
const EMPTY_PINNED = new Set<string>();
const EMPTY_IDS: readonly string[] = [];
const EMPTY_FOLDERS: SessionFoldersMap = {};
const EMPTY_STANDALONE_GROUPS: SessionGroup[] = [];

const noop = (): void => undefined;
const noopString = (): void => undefined;
const noopStringOrNull = (): void => undefined;
const noopDeleteConfirm = (): void => undefined;

const makeSession = (index: number, archived: boolean): Session => {
  const base: Session = {
    id: `ses_${archived ? 'archived' : 'active'}_${index}`,
    slug: `session-${index}`,
    projectID: 'project',
    title: `Session release ${index}`,
    version: '1',
    directory: PROJECT_ROOT,
    time: { created: 1, updated: index + 1 },
  };
  if (!archived) return base;
  return { ...base, time: { created: 1, updated: index + 1, archived: 2 } };
};

const makeSessions = (count: number, archived: boolean): Session[] => (
  Array.from({ length: count }, (_, index) => makeSession(index, archived))
);

type FilterCost = {
  calls: number;
  ms: number;
};

type SearchedSessions = {
  active: Session[];
  archived: Session[];
};

type SectionsResult = ReturnType<typeof useSessionSidebarSections>;

type WiredSearchState = {
  actions: ReturnType<typeof useSessionActions>;
  sections: SectionsResult;
};

type WiredSearchArgs = {
  sessions: SearchedSessions;
  /** Debounced + normalized query exactly as the sections hook receives it. */
  normalizedSessionSearchQuery: string;
  /** The one stable intent the list subtree receives from the sidebar owner. */
  resetSessionSearch: () => void;
  filterCost: FilterCost;
};

// One real wiring definition for both the live harness and the static scale
// harness: it mirrors how `SessionSidebar` feeds the debounced query into
// `SessionProjectCollection` and passes row actions only the stable
// `resetSessionSearch` intent.
const useWiredSearchState = ({
  sessions,
  normalizedSessionSearchQuery,
  resetSessionSearch,
  filterCost,
}: WiredSearchArgs): WiredSearchState => {
  const ownership = React.useMemo(
    () => createSessionOwnershipIndex(sessions.active, PROJECTS, EMPTY_WORKTREES, false, sessions.archived),
    [sessions],
  );
  const { getSessionsForProject, getArchivedSessionsForProject } = useProjectSessionLists({ ownership });
  const grouping = useSessionGrouping({
    homeDirectory: HOME_DIR,
    worktreeMetadata: EMPTY_WORKTREE_METADATA,
    pinnedSessionIds: EMPTY_PINNED,
    sessionOrderRanks: EMPTY_SESSION_ORDER,
    gitBranches: EMPTY_BRANCHES,
    isVSCode: false,
  });
  const { filterSessionNodesForSearch: runFilterSessionNodesForSearch } = grouping;
  const filterSessionNodesForSearch = React.useCallback((nodes: SessionNode[], query: string): SessionNodeSearchResult => {
    filterCost.calls += 1;
    const startedAt = performance.now();
    const filtered = runFilterSessionNodesForSearch(nodes, query);
    filterCost.ms += performance.now() - startedAt;
    return filtered;
  }, [filterCost, runFilterSessionNodesForSearch]);
  const hasSessionSearchQuery = normalizedSessionSearchQuery.length > 0;
  const sections = useSessionSidebarSections({
    normalizedProjects: PROJECTS,
    getSessionsForProject,
    getArchivedSessionsForProject,
    availableWorktreesByProject: EMPTY_WORKTREES,
    projectRepoStatus: EMPTY_REPO_STATUS,
    projectRootBranches: EMPTY_ROOT_BRANCHES,
    gitBranches: EMPTY_BRANCHES,
    lastRepoStatus: false,
    buildGroupedSessions: grouping.buildGroupedSessions,
    hasSessionSearchQuery,
    normalizedSessionSearchQuery,
    filterSessionNodesForSearch,
    buildGroupSearchText: grouping.buildGroupSearchText,
    foldersMap: EMPTY_FOLDERS,
    standaloneGroups: EMPTY_STANDALONE_GROUPS,
  });
  const actions = useSessionActions({
    mobileVariant: false,
    allowReselect: false,
    resetSessionSearch,
    descendantIds: EMPTY_IDS,
    showDeletionDialog: false,
    setDeleteSessionConfirm: noopDeleteConfirm,
    deleteSessionConfirm: null,
    setEditingId: noopStringOrNull,
    setEditTitle: noopString,
    editingId: null,
    editTitle: '',
    copiedSessionId: null,
    setCopiedSessionId: noopStringOrNull,
  });
  return { actions, sections };
};

const renderSectionsSnapshot = (sessions: SearchedSessions, query: string, filterCost: FilterCost): SectionsResult => {
  let captured: SectionsResult | null = null;
  const Harness = () => {
    const { sections } = useWiredSearchState({
      sessions,
      normalizedSessionSearchQuery: query,
      resetSessionSearch: noop,
      filterCost,
    });
    captured = sections;
    return null;
  };
  renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(Harness)));
  if (!captured) throw new Error('sections hook did not run');
  return captured;
};

const groupById = (sections: SectionsResult, groupId: string): SessionGroup | null => (
  sections.visibleProjectSections[0]?.groups.find((group) => group.id === groupId) ?? null
);

const groupMatchCount = (sections: SectionsResult, groupId: string): number => {
  const group = groupById(sections, groupId);
  if (!group) return 0;
  return sections.groupSearchDataByGroup.get(group)?.filteredNodes.length ?? 0;
};

type ScenarioMetrics = {
  scenario: string;
  activeSessions: number;
  archivedSessions: number;
  query: string;
  filterCalls: number;
  filterMs: number;
  renderMs: number;
  matchedRoot: number;
  matchedArchived: number;
  searchMatchCount: number;
  rootRowsWithoutSearch: number;
  archivedRowsWithoutSearch: number;
};

const roundMs = (value: number): number => Math.round(value * 100) / 100;

const measureScenario = (
  scenario: string,
  activeCount: number,
  archivedCount: number,
  query: string,
): ScenarioMetrics => {
  const sessions = {
    active: makeSessions(activeCount, false),
    archived: makeSessions(archivedCount, true),
  };
  // Warm up the hook/render path so the reported time is not first-render JIT.
  renderSectionsSnapshot(sessions, query, { calls: 0, ms: 0 });
  const filterCost: FilterCost = { calls: 0, ms: 0 };
  const startedAt = performance.now();
  const sections = renderSectionsSnapshot(sessions, query, filterCost);
  const renderMs = performance.now() - startedAt;
  const metrics: ScenarioMetrics = {
    scenario,
    activeSessions: activeCount,
    archivedSessions: archivedCount,
    query,
    filterCalls: filterCost.calls,
    filterMs: roundMs(filterCost.ms),
    renderMs: roundMs(renderMs),
    matchedRoot: groupMatchCount(sections, 'root'),
    matchedArchived: groupMatchCount(sections, 'archived'),
    searchMatchCount: sections.searchMatchCount,
    rootRowsWithoutSearch: groupById(sections, 'root')?.sessions.length ?? 0,
    archivedRowsWithoutSearch: groupById(sections, 'archived')?.sessions.length ?? 0,
  };
  console.log(`[session-search-perf] ${JSON.stringify(metrics)}`);
  return metrics;
};

describe('session search data path at scale', () => {
  test('active sessions: 100 and 1000 sessions run one filtered pass and match every row', () => {
    for (const count of [100, 1000]) {
      const unfiltered = measureScenario(`active-${count}-no-query`, count, 0, '');
      expect(unfiltered.filterCalls).toBe(0);
      expect(unfiltered.rootRowsWithoutSearch).toBe(count);
      expect(unfiltered.searchMatchCount).toBe(0);

      const searched = measureScenario(`active-${count}-broad`, count, 0, 'release');
      expect(searched.filterCalls).toBe(1);
      expect(searched.matchedRoot).toBe(count);
      expect(searched.matchedArchived).toBe(0);
      expect(searched.searchMatchCount).toBe(count);
    }
  });

  test('archived sessions: 100 and 1000 sessions are all search-matched while search is active', () => {
    for (const count of [100, 1000]) {
      const unfiltered = measureScenario(`archived-${count}-no-query`, 0, count, '');
      expect(unfiltered.filterCalls).toBe(0);
      expect(unfiltered.archivedRowsWithoutSearch).toBe(count);

      const searched = measureScenario(`archived-${count}-broad`, 0, count, 'release');
      // Two groups carry the search data: the project root and the archived bucket.
      expect(searched.filterCalls).toBe(2);
      // Every archived row is search-matched. The component virtualizes 50+
      // row search results, so this is the model count it receives, not the
      // mounted-row count (which this harness cannot measure).
      expect(searched.matchedArchived).toBe(count);
      expect(searched.matchedRoot).toBe(0);
      expect(searched.searchMatchCount).toBe(count);
    }
  });

  test('mixed active and archived rows keep the search result responsive per bucket', () => {
    const searched = measureScenario('mixed-500-active-500-archived-broad', 500, 500, 'release');
    expect(searched.filterCalls).toBe(2);
    expect(searched.matchedRoot).toBe(500);
    expect(searched.matchedArchived).toBe(500);
    expect(searched.searchMatchCount).toBe(1000);
  });
});

type LiveCapture = {
  state: WiredSearchState | null;
  setRawQuery: ((value: string) => void) | null;
  setSearchOpen: ((open: boolean) => void) | null;
  filterCost: FilterCost;
};

const LiveHarness = ({ sessions, capture }: { sessions: SearchedSessions; capture: LiveCapture }) => {
  const [rawQuery, setRawQuery] = React.useState('');
  const [, setIsSessionSearchOpen] = React.useState(true);
  const debouncedQuery = useDebouncedValue(rawQuery, 120);
  const normalizedQuery = React.useMemo(() => debouncedQuery.trim().toLowerCase(), [debouncedQuery]);
  // Same dependency-free intent callback SessionSidebar passes into rowActions.
  const resetSessionSearch = React.useCallback(() => {
    setRawQuery((current) => (current.length === 0 ? current : ''));
    setIsSessionSearchOpen((current) => (current ? false : current));
  }, []);
  const { actions, sections } = useWiredSearchState({
    sessions,
    normalizedSessionSearchQuery: normalizedQuery,
    resetSessionSearch,
    filterCost: capture.filterCost,
  });
  capture.state = { actions, sections };
  capture.setRawQuery = setRawQuery;
  capture.setSearchOpen = setIsSessionSearchOpen;
  return null;
};

const flushDebounce = async (): Promise<number> => {
  let flushStartedAt = 0;
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 140));
    flushStartedAt = performance.now();
  });
  return performance.now() - flushStartedAt;
};

describe('pre-debounce referential contract', () => {
  test('a raw keystroke before the debounce does not enter the search data path', async () => {
    const dom = installHookTestDom();
    const root = createRoot(dom.container);
    const capture: LiveCapture = { state: null, setRawQuery: null, setSearchOpen: null, filterCost: { calls: 0, ms: 0 } };
    const sessions: SearchedSessions = { active: makeSessions(40, false), archived: makeSessions(10, true) };
    try {
      await act(async () => {
        root.render(React.createElement(I18nProvider, null, React.createElement(LiveHarness, { sessions, capture })));
      });
      const initialSections = capture.state!.sections;
      const initialFlat = initialSections.flatSectionsForRender;

      act(() => capture.setRawQuery!('release'));

      // The raw query has changed but 120ms have not elapsed: the search pass
      // must not run and the render-ready sections must keep their references.
      expect(capture.filterCost.calls).toBe(0);
      expect(capture.state!.sections.searchMatchCount).toBe(0);
      expect(capture.state!.sections.sectionsForRender).toBe(initialSections.sectionsForRender);
      expect(capture.state!.sections.flatSectionsForRender).toBe(initialFlat);

      await flushDebounce();

      // Only the debounced query starts the real search work.
      expect(capture.filterCost.calls).toBe(2);
      expect(capture.state!.sections.searchMatchCount).toBe(50);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  test('a raw keystroke before the debounce must not churn row action callbacks', async () => {
    const dom = installHookTestDom();
    const root = createRoot(dom.container);
    const capture: LiveCapture = { state: null, setRawQuery: null, setSearchOpen: null, filterCost: { calls: 0, ms: 0 } };
    const sessions: SearchedSessions = { active: makeSessions(40, false), archived: makeSessions(10, true) };
    try {
      await act(async () => {
        root.render(React.createElement(I18nProvider, null, React.createElement(LiveHarness, { sessions, capture })));
      });
      const beforeSelect = capture.state!.actions.handleSessionSelect;
      const beforeDelete = capture.state!.actions.handleDeleteSession;

      act(() => capture.setRawQuery!('r'));

      // Pre-fix signal: `handleSessionSelect` is rebuilt from the raw query, so
      // every mounted `SessionNodeItem` fails its `callbacksEqual` memo check on
      // a keystroke that has not even reached the debounce. The unrelated
      // callback keeps its identity, so only the query-coupled one is at fault.
      // A pre-debounce raw keystroke must not rebuild the row select callback:
      // SessionNodeItem compares it by identity.
      expect(capture.state!.actions.handleDeleteSession).toBe(beforeDelete);
      expect(capture.state!.actions.handleSessionSelect).toBe(beforeSelect);

      await flushDebounce();
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});

describe('debounced search flush at scale', () => {
  test('reports the flush cost after the 120ms debounce at 100 and 1000 sessions', async () => {
    for (const count of [100, 1000]) {
      const dom = installHookTestDom();
      const root = createRoot(dom.container);
      const capture: LiveCapture = { state: null, setRawQuery: null, setSearchOpen: null, filterCost: { calls: 0, ms: 0 } };
      const sessions: SearchedSessions = { active: makeSessions(count, false), archived: makeSessions(10, true) };
      try {
        await act(async () => {
          root.render(React.createElement(I18nProvider, null, React.createElement(LiveHarness, { sessions, capture })));
        });
        act(() => capture.setRawQuery!('release'));
        const flushMs = await flushDebounce();
        const metrics = {
          scenario: `live-flush-${count}`,
          activeSessions: count,
          archivedSessions: 10,
          query: 'release',
          filterCalls: capture.filterCost.calls,
          filterMs: roundMs(capture.filterCost.ms),
          flushMs: roundMs(flushMs),
          searchMatchCount: capture.state!.sections.searchMatchCount,
        };
        console.log(`[session-search-perf] ${JSON.stringify(metrics)}`);
        expect(metrics.filterCalls).toBe(2);
        expect(metrics.searchMatchCount).toBe(count + 10);
        expect(metrics.flushMs).toBeGreaterThanOrEqual(0);
      } finally {
        await act(async () => root.unmount());
        dom.restore();
      }
    }
  });
});
