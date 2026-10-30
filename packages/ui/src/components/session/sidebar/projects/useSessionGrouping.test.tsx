import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Session } from '@/lib/opencode/model';
import type { WorktreeMetadata } from '@/types/worktree';
import { I18nProvider } from '@/lib/i18n';
import { useSessionActions } from '../sessions/useSessionActions';
import { createSessionOwnershipIndex } from '../sessions/sessionOwnership';
import { buildSidebarSessionProjection } from '../list/sessionCollection';
import { useSessionGrouping } from './useSessionGrouping';
import type { SessionNode } from '../types';

type FixtureSession = Session & { parentID?: string };
type GroupingCapture = { buildGroupedSessions?: ReturnType<typeof useSessionGrouping>['buildGroupedSessions'] };
type BuildCapture = { build?: ReturnType<typeof useSessionGrouping>['buildGroupedSessions'] };
const session = (id: string, parentID?: string): Session => {
  const value: FixtureSession = {
    id,
    projectID: 'project',
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    title: id,
    directory: '/workspace',
    time: { created: 1, updated: 1 },
  };
  if (parentID) value.parentID = parentID;
  return value;
};

const collectIds = (nodes: SessionNode[]): string[] => {
  const ids: string[] = [];
  const visit = (items: SessionNode[]): void => {
    for (const node of items) {
      ids.push(node.session.id);
      visit(node.children);
    }
  };
  visit(nodes);
  return ids;
};

const groupingFixture = (
  activeSessions: readonly Session[],
  sessionOrderRanks: ReadonlyMap<string, number> = new Map(),
  archivedSessions: readonly Session[] = [],
) => {
  const projection = buildSidebarSessionProjection({
    globalActiveSessions: [...activeSessions],
    liveSessions: [],
    knownDirectories: new Set(),
    isVSCode: false,
    pinnedSessionIds: new Set(),
    sessionOrderRanks,
  });
  const sessionById = new Map([
    ...projection.sessionById,
    ...archivedSessions.map((entry) => [entry.id, entry] as const),
  ]);
  const childrenMap = new Map(
    [...projection.childrenMap].map(([parentId, children]) => [parentId, [...children]]),
  );
  for (const archived of archivedSessions) {
    if (!archived.parentID) continue;
    const children = childrenMap.get(archived.parentID) ?? [];
    children.push(archived);
    childrenMap.set(archived.parentID, children);
  }
  const nestedSessionIds = new Set(
    [...childrenMap]
      .filter(([parentId]) => sessionById.has(parentId))
      .flatMap(([, children]) => children.map((child) => child.id)),
  );
  return {
    orderedProjectSessions: projection.projectSessions,
    authority: { sessionById, childrenMap, nestedSessionIds },
  };
};

describe('useSessionGrouping malformed hierarchy fallbacks', () => {
  test('keeps the grouping builder stable when an unrelated git branch changes', async () => {
    const dom = new Window({ url: 'http://localhost' });
    const originals = new Map<string, PropertyDescriptor | undefined>();
    const globals = {
      window: dom,
      document: dom.document,
      navigator: dom.navigator,
      Node: dom.Node,
      Element: dom.Element,
      HTMLElement: dom.HTMLElement,
      Event: dom.Event,
      MutationObserver: dom.MutationObserver,
      IS_REACT_ACT_ENVIRONMENT: true,
    };
    for (const [name, value] of Object.entries(globals)) {
      originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
      Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    }

    const container = document.createElement('div');
    document.body.append(container);
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container);
    const captured = React.createRef<ReturnType<typeof useSessionGrouping>['buildGroupedSessions']>();
    const worktreeMetadata = new Map();
    const pinnedSessionIds = new Set<string>();
    const sessionOrderRanks = new Map<string, number>();
    const Harness = ({ gitBranches }: { gitBranches: Map<string, string | null> }) => {
      captured.current = useSessionGrouping({
        homeDirectory: null,
        worktreeMetadata,
        pinnedSessionIds,
        sessionOrderRanks,
        gitBranches,
        isVSCode: false,
        ...groupingFixture([]).authority,
      }).buildGroupedSessions;
      return null;
    };

    try {
      await act(async () => root.render(<I18nProvider><Harness gitBranches={new Map()} /></I18nProvider>));
      const initialBuilder = captured.current;
      if (!initialBuilder) throw new Error('grouping callback was not mounted');

      await act(async () => root.render(
        <I18nProvider><Harness gitBranches={new Map([['/unrelated', 'main']])} /></I18nProvider>,
      ));
      expect(captured.current).toBe(initialBuilder);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      for (const [name, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    }
  });

  test('renders a deterministic cycle/orphan fallback tree without duplicate sessions', async () => {
    const sessions = [session('a', 'b'), session('b', 'a'), session('orphan', 'missing')];
    const state: GroupingCapture = {};
    const Harness = () => {
      state.buildGroupedSessions = useSessionGrouping({
        homeDirectory: null,
        worktreeMetadata: new Map(),
        pinnedSessionIds: new Set(),
        sessionOrderRanks: new Map(),
        gitBranches: new Map(),
        isVSCode: false,
        ...groupingFixture(sessions).authority,
      }).buildGroupedSessions;
      return null;
    };

    renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(Harness)));
    const buildGroupedSessions = state.buildGroupedSessions;
    if (!buildGroupedSessions) throw new Error('grouping callback was not mounted');

    const groups = buildGroupedSessions(
      sessions,
      '/workspace',
      [],
      null,
      false,
    );
    const rootGroup = groups.find((group) => group.isMain);
    const ids = collectIds(rootGroup?.sessions ?? []);

    expect(ids).toEqual(['orphan', 'a', 'b']);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('worktrees follow their latest activity', () => {
    const worktree = (name: string): WorktreeMetadata => ({
      source: 'sdk', name, path: `/workspace/.wt/${name}`, projectDirectory: '/workspace', branch: name, label: name,
    });
    const busy = { ...session('busy'), directory: '/workspace/.wt/zeta', time: { created: 1, updated: 99 } };
    const worktreeOrder = () => {
      const state: BuildCapture = {};
      const Harness = () => {
        state.build = useSessionGrouping({
          homeDirectory: null,
          worktreeMetadata: new Map(),
          pinnedSessionIds: new Set(),
          sessionOrderRanks: new Map(),
          gitBranches: new Map(),
          isVSCode: false,
          ...groupingFixture([busy]).authority,
        }).buildGroupedSessions;
        return null;
      };
      renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(Harness)));
      if (!state.build) throw new Error('grouping callback was not mounted');
      return state.build([busy], '/workspace', [worktree('zeta'), worktree('alpha')], null, true)
        .filter((group) => group.worktree)
        .map((group) => group.label);
    };

    expect(worktreeOrder()).toEqual(['zeta', 'alpha']);
  });

  test('groups a session inside a worktree sub-folder under that worktree', () => {
    const alpha: WorktreeMetadata = {
      source: 'sdk', name: 'alpha', path: '/workspace/.wt/alpha', projectDirectory: '/workspace', branch: 'alpha', label: 'alpha',
    };
    const inSubfolder = { ...session('sub'), directory: '/workspace/.wt/alpha/ai', time: { created: 1, updated: 1 } };
    const state: GroupingCapture = {};
    const Harness = () => {
      state.buildGroupedSessions = useSessionGrouping({
        homeDirectory: null,
        worktreeMetadata: new Map(),
        pinnedSessionIds: new Set(),
        sessionOrderRanks: new Map(),
        gitBranches: new Map(),
        isVSCode: false,
        ...groupingFixture([inSubfolder]).authority,
      }).buildGroupedSessions;
      return null;
    };
    renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(Harness)));
    if (!state.buildGroupedSessions) throw new Error('grouping callback was not mounted');

    const groups = state.buildGroupedSessions([inSubfolder], '/workspace', [alpha], null, true);
    const worktreeGroup = groups.find((group) => group.worktree);

    expect(worktreeGroup?.directory).toBe('/workspace/.wt/alpha');
    expect(collectIds(worktreeGroup?.sessions ?? [])).toEqual(['sub']);
    expect(collectIds(groups.find((group) => group.isMain)?.sessions ?? [])).toEqual([]);
  });

  test('uses the row-local descendant snapshot for archive and hard-delete actions', async () => {
    type ActionsCapture = { handleDeleteSession?: ReturnType<typeof useSessionActions>['handleDeleteSession'] };
    const state: ActionsCapture = {};
    const Harness = () => {
      state.handleDeleteSession = useSessionActions({
        mobileVariant: false,
        allowReselect: false,
        resetSessionSearch: () => undefined,
        descendantIds: ['active-child', 'archived-child'],
        showDeletionDialog: false,
        setDeleteSessionConfirm: () => undefined,
        deleteSessionConfirm: null,
        setEditingId: () => undefined,
        setEditingRowKey: () => undefined,
        editingSessionId: 'root',
        editingOccurrenceKey: 'project:session:root',
        setEditTitle: () => undefined,
        editingId: null,
        editTitle: '',
      }).handleDeleteSession;
      return null;
    };

    renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(Harness)));
    const handleDeleteSession = state.handleDeleteSession;
    if (!handleDeleteSession) throw new Error('session actions callback was not mounted');

    handleDeleteSession(session('root'));
    handleDeleteSession(session('root'), { hardDelete: true });
  });

  test('keeps active unknown-directory sessions in their resolved project root group', () => {
    const state: GroupingCapture = {};
    const restored = { ...session('restored'), directory: '/deleted/worktree', time: { created: 1, updated: 1 } };
    const ownership = createSessionOwnershipIndex(
      [restored],
      [{ id: 'configured-workspace', normalizedPath: '/workspace' }],
      new Map(),
      false,
      [],
      [{ id: 'project', worktree: '/workspace' }],
    );
    const Harness = () => {
      state.buildGroupedSessions = useSessionGrouping({
        homeDirectory: null,
        worktreeMetadata: new Map(),
        pinnedSessionIds: new Set(),
        sessionOrderRanks: new Map(),
        gitBranches: new Map(),
        isVSCode: false,
        sessionOwners: ownership.bySessionId,
        ...groupingFixture([restored]).authority,
      }).buildGroupedSessions;
      return null;
    };

    renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(Harness)));
    const buildGroupedSessions = state.buildGroupedSessions;
    if (!buildGroupedSessions) throw new Error('grouping callback was not mounted');

    const groups = buildGroupedSessions([restored], '/workspace', [], null, false);

    expect(groups.find((group) => group.isMain)?.sessions.map((node) => node.session.id)).toEqual(['restored']);
    expect(groups.some((group) => group.isArchivedBucket)).toBe(false);
  });

  test('shows subsessions only nested under an active parent, never in the archive or as rows of their own', () => {
    const archived = (value: Session): Session => ({ ...value, time: { ...value.time, archived: 2 } });
    const sessions = [
      session('active-parent'),
      session('active-child', 'active-parent'),
      archived(session('archived-child-of-active', 'active-parent')),
      archived(session('archived-parent')),
      archived(session('archived-child', 'archived-parent')),
      session('live-child-of-archived', 'archived-parent'),
      session('child-of-unloaded', 'not-loaded'),
    ];
    const activeSessions = sessions.filter((entry) => !entry.time.archived);
    const archivedSessions = sessions.filter((entry) => Boolean(entry.time.archived));
    const state: GroupingCapture = {};
    const Harness = () => {
      state.buildGroupedSessions = useSessionGrouping({
        homeDirectory: null,
        worktreeMetadata: new Map(),
        pinnedSessionIds: new Set(),
        sessionOrderRanks: new Map(),
        gitBranches: new Map(),
        isVSCode: false,
        ...groupingFixture(activeSessions, new Map(), archivedSessions).authority,
      }).buildGroupedSessions;
      return null;
    };
    renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(Harness)));
    const buildGroupedSessions = state.buildGroupedSessions;
    if (!buildGroupedSessions) throw new Error('grouping callback was not mounted');

    const groups = buildGroupedSessions(
      sessions,
      '/workspace',
      [],
      null,
      false,
    );

    const rootGroup = groups.find((group) => group.isMain);
    const archiveGroup = groups.find((group) => group.isArchivedBucket);
    expect(rootGroup?.sessions.map((node) => node.session.id)).toEqual(['active-parent', 'child-of-unloaded']);
    expect(collectIds(rootGroup?.sessions ?? [])).toEqual(['active-parent', 'active-child', 'child-of-unloaded']);
    expect(collectIds(archiveGroup?.sessions ?? [])).toEqual(['archived-parent']);
  });

  test('nests a lifecycle-ordered cross-project subtree under its parent and leaves the child worktree empty', () => {
    const parent = session('parent');
    const older = { ...session('older', 'parent'), directory: '/workspace/.wt/child' };
    const newer = { ...session('newer', 'parent'), directory: '/workspace/.wt/child' };
    const grandchild = { ...session('grandchild', 'newer'), directory: '/workspace/.wt/grandchild' };
    const all = [parent, older, grandchild, newer];
    const ranks = new Map([['newer', 3], ['older', 2]]);
    const fixture = groupingFixture(all, ranks);
    const childWorktree: WorktreeMetadata = {
      source: 'sdk', name: 'child', path: '/workspace/.wt/child', projectDirectory: '/workspace', branch: 'child', label: 'child',
    };
    const grandchildWorktree: WorktreeMetadata = {
      source: 'sdk', name: 'grandchild', path: '/workspace/.wt/grandchild', projectDirectory: '/workspace', branch: 'grandchild', label: 'grandchild',
    };
    const state: BuildCapture = {};
    const Harness = () => {
      state.build = useSessionGrouping({
        homeDirectory: null,
        worktreeMetadata: new Map(),
        pinnedSessionIds: new Set(),
        sessionOrderRanks: ranks,
        gitBranches: new Map(),
        isVSCode: false,
        ...fixture.authority,
      }).buildGroupedSessions;
      return null;
    };
    renderToStaticMarkup(<I18nProvider><Harness /></I18nProvider>);
    if (!state.build) throw new Error('grouping callback was not mounted');

    const parentGroups = state.build(fixture.orderedProjectSessions.filter((entry) => entry.id === 'parent'), '/workspace', [childWorktree, grandchildWorktree], null, true);
    const parentNode = parentGroups.find((group) => group.isMain)?.sessions[0];
    const childGroups = state.build(fixture.orderedProjectSessions.filter((entry) => entry.id !== 'parent'), '/workspace/.wt/child', [], null, true);

    expect(parentNode?.children.map((node) => node.session.id)).toEqual(['newer', 'older']);
    expect(parentNode?.children[0]?.children.map((node) => node.session.id)).toEqual(['grandchild']);
    expect(parentNode?.children[0]?.session.directory).toBe('/workspace/.wt/child');
    expect(parentNode?.children[0]?.worktree?.path).toBe('/workspace/.wt/child');
    expect(parentNode?.children[0]?.children[0]?.worktree?.path).toBe('/workspace/.wt/grandchild');
    expect(childGroups.find((group) => group.isMain)?.sessions).toEqual([]);
  });

  test('promotes a child only until its active or archived parent becomes known', () => {
    const child = session('child', 'parent');
    const activeParent = session('parent');
    const archivedParent = { ...activeParent, time: { ...activeParent.time, archived: 2 } };
    const renderRoots = (known: readonly Session[]) => {
      const state: BuildCapture = {};
      const Harness = () => {
        state.build = useSessionGrouping({
          homeDirectory: null,
          worktreeMetadata: new Map(),
          pinnedSessionIds: new Set(),
          sessionOrderRanks: new Map(),
          gitBranches: new Map(),
          isVSCode: false,
          ...groupingFixture(
            known.filter((entry) => !entry.time.archived),
            new Map(),
            known.filter((entry) => Boolean(entry.time.archived)),
          ).authority,
        }).buildGroupedSessions;
        return null;
      };
      renderToStaticMarkup(<I18nProvider><Harness /></I18nProvider>);
      return state.build?.([child], '/workspace', [], null, false)
        .find((group) => group.isMain)?.sessions.map((node) => node.session.id);
    };

    expect(renderRoots([child])).toEqual(['child']);
    expect(renderRoots([activeParent, child])).toEqual([]);
    expect(renderRoots([archivedParent, child])).toEqual([]);
  });

  test('hides an active grandchild below an archived intermediate known only globally', () => {
    const root = { ...session('root'), directory: '/workspace' };
    const intermediate = {
      ...session('archived-intermediate', 'root'),
      directory: '/workspace/.wt/archived',
      time: { created: 1, updated: 1, archived: 2 },
    };
    const grandchild = {
      ...session('grandchild', 'archived-intermediate'),
      directory: '/workspace/.wt/active',
    };
    const fixture = groupingFixture([root, grandchild], new Map(), [intermediate]);
    const activeWorktree: WorktreeMetadata = {
      source: 'sdk', name: 'active', path: '/workspace/.wt/active', projectDirectory: '/workspace', branch: 'active', label: 'active',
    };
    const state: BuildCapture = {};
    const Harness = () => {
      state.build = useSessionGrouping({
        homeDirectory: null,
        worktreeMetadata: new Map(),
        pinnedSessionIds: new Set(),
        sessionOrderRanks: new Map(),
        gitBranches: new Map(),
        isVSCode: false,
        ...fixture.authority,
      }).buildGroupedSessions;
      return null;
    };
    renderToStaticMarkup(<I18nProvider><Harness /></I18nProvider>);
    if (!state.build) throw new Error('grouping callback was not mounted');

    const rootNode = state.build([root], '/workspace', [activeWorktree], null, true)
      .find((group) => group.isMain)?.sessions[0];
    const grandchildGroups = state.build([grandchild], '/workspace', [activeWorktree], null, true);

    expect(rootNode?.children).toEqual([]);
    expect(grandchildGroups.find((group) => group.isMain)?.sessions).toEqual([]);
    expect(grandchildGroups.find((group) => group.worktree)?.sessions).toEqual([]);
  });
});
