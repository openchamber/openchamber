import { describe, expect, mock, test } from 'bun:test';
import { plugin } from 'bun';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import type { HTMLDivElement as HappyDomHTMLDivElement } from 'happy-dom';
import type { Session } from '@opencode-ai/sdk/v2';
import type { WorktreeMetadata } from '@/types/worktree';
import type { RuntimeAPIs } from '@/lib/api/types';
import { ChildStoreManager } from '@/sync/child-store';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { replaceGlobalSessionStatusById, useGlobalSessionStatusStore } from '@/sync/global-session-status';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useGlobalSyncStore } from '@/sync/global-sync-store';
import { getGitHubPrStatusKey, useGitHubPrStatusStore } from '@/stores/useGitHubPrStatusStore';
import { installHookTestDom } from '../test-utils/testDom';
import { I18nProvider } from '@/lib/i18n';
import type { SessionGroup, SessionNode } from '../types';
import { pathToFileURL } from 'node:url';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// SessionNodeItem's transitive imports reach useProviderLogo, whose Vite
// asset glob Bun cannot evaluate. Expand the same glob into real file URLs,
// like the LiveTurnActivity harness does — a loader transform, not a mock.
plugin({
  name: 'recent-worktree-resolve-provider-logos',
  setup(build) {
    build.onLoad({ filter: /useProviderLogo\.ts$/ }, ({ path }) => {
      const folder = resolve(dirname(path), '../assets/provider-logos');
      const logos = Object.fromEntries(readdirSync(folder).filter((name) => name.endsWith('.svg'))
        .map((name) => [`../assets/provider-logos/${name}`, pathToFileURL(resolve(folder, name)).href]));
      const contents = readFileSync(path, 'utf8').replace(/import\.meta\.glob<string>\([\s\S]*?\);/, `${JSON.stringify(logos)};`);
      return { contents, loader: 'ts' };
    });
  },
});

// SAFETY: sync-context.tsx publishes its context identity on globalThis
// (`__openchamber_sync_runtime_context__`) instead of exporting it, so every
// module instance shares one context; read it the same way the sync modules do.
const syncRuntimeContext = (globalThis as {
  __openchamber_sync_runtime_context__?: React.Context<unknown>;
}).__openchamber_sync_runtime_context__;

if (!syncRuntimeContext) {
  throw new Error('sync runtime context was not published on globalThis by @/sync/sync-context');
}

const { SessionProjectCollection } = await import('../list/SessionProjectCollection');
const { SessionNodeItem } = await import('../sessions/SessionNodeItem');

type CapturedSessionRow = {
  node: { session: Session; worktree: WorktreeMetadata | null; children: SessionNode[] };
  depth: number;
  projectId: string | null;
  groupDirectory: string | null;
  renderContext: string;
  secondaryMeta: { projectLabel?: string | null; branchLabel?: string | null } | null;
};

const capturedSessionRows: CapturedSessionRow[] = [];

// The scroller is the row model's single render consumer: mocking this leaf
// captures every row `buildSessionSidebarRowModel` produced while the real
// collection, ownership index, location resolver, and Recent projection run.
mock.module('../projects/SessionProjectScroller', () => ({
  SessionProjectScroller: (props: { model: { rowModel: { rows: Array<CapturedSessionRow & { kind: string }> } } }) => {
    for (const row of props.model.rowModel.rows) {
      if (row.kind === 'session') capturedSessionRows.push(row);
    }
    return null;
  },
}));

// Unrelated to the Recent projection: owns the terminal discovery loop and its
// runtime capability contract, which this test does not exercise.
mock.module('../list/SidebarTerminalActivity', () => ({
  SidebarTerminalActivity: () => null,
}));

// The precedence test renders the real SessionNodeItem outside a DndContext:
// drag interaction is unrelated to the tooltip contract this file locks.
mock.module('../folders/sessionFolderDnd', () => ({
  DraggableSessionRow: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SessionFolderDndScope: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const unavailable = (): never => { throw new Error('Activity rendering must not call runtime APIs'); };
const runtimeApis: RuntimeAPIs = {
  runtime: { platform: 'web', isDesktop: false, isVSCode: false },
  get terminal() { return unavailable(); },
  get git() { return unavailable(); },
  get files() { return unavailable(); },
  get settings() { return unavailable(); },
  get permissions() { return unavailable(); },
  get notifications() { return unavailable(); },
  get tools() { return unavailable(); },
};

// SAFETY: fixtures use the minimal Session fields the sidebar projection reads
// (id/slug/directory/title/parentID/projectID/time).
const worktreeSession = (id: string, directory: string): Session => ({
  id,
  slug: id,
  title: id,
  directory,
  projectID: 'opencode-app',
  version: '1',
  time: { created: 1, updated: 1 },
});

const worktreeMeta = (path: string, branch: string): WorktreeMetadata => ({
  path,
  projectDirectory: '/workspace/app',
  branch,
  label: branch,
});

// The global sessions cache is the authoritative source for active coverage;
// `applySnapshot` is its sanctioned snapshot setter, so Recent membership and
// the ownership index both derive from one seeded snapshot.
const applyGlobalSnapshot = (sessions: Session[]) => {
  useGlobalSessionsStore.getState().applySnapshot(sessions, [], 'ready');
};

type CollectionProps = React.ComponentProps<typeof SessionProjectCollection>;
type CollectionView = CollectionProps['view'];
type CollectionActions = CollectionProps['actions'];

// SAFETY: the sync runtime context is not exported, so the harness feeds a
// structural stand-in whose members are exactly what the projection reads:
// childStores for the group-status hook, and no-op loaders/sdk that must never
// be reached because the seeded global cache is authoritative.
const syncRuntime = (childStores: ChildStoreManager) => ({
  childStores,
  messageLoader: {
    prefetch: async () => undefined,
    retainSessionHistory: () => () => undefined,
  },
  runtimeKey: 'test-runtime',
  // SAFETY: the projection never awaits the SDK in this test; the seeded
  // global cache is authoritative, so no request can be issued through it.
  sdk: {},
  currentDirectory: {
    subscribe: () => () => undefined,
    get: () => '/workspace/app',
  },
});

const collectionView = (): CollectionView => ({
  isVisible: true,
  hasSessionSearchQuery: false,
  normalizedSessionSearchQuery: '',
  activeProjectId: null,
  showInlineArchived: false,
  useGroupedSections: true,
  homeDirectory: null,
  mobileVariant: false,
  hideDirectoryControls: false,
  showOnlyMainWorkspace: false,
  isDesktopShellRuntime: false,
  stickyZoneHeaders: false,
  projectSortOrder: 'manual',
  sidebarViewMode: 'projects',
  emptyState: null,
  searchEmptyState: null,
  isSessionsLoading: false,
  isWorktreeTopologyLoading: false,
  unresolvedWorktreeProjectPaths: new Set<string>(),
  projectView: {
    collapsedProjects: new Set<string>(),
    collapsedGroups: new Set<string>(),
    groupOrderByProject: new Map<string, string[]>(),
  },
  onSearchMatchCountChange: () => undefined,
});

const noop = () => undefined;

const collectionActions = (): CollectionActions => ({
  rowActions: {
    allowReselect: false,
    onSessionSelected: undefined,
    resetSessionSearch: noop,
  },
  alwaysShowActions: false,
  notifyOnSubtasks: false,
  setActiveProjectIdOnly: noop,
  setSessionSwitcherOpen: () => undefined,
  openNewSessionDraft: () => undefined,
  openNewWorktreeDialog: () => undefined,
  openWorktreesPage: () => undefined,
  openProjectEditDialog: () => undefined,
  removeProject: () => undefined,
  reorderProjects: () => undefined,
  startSessionWorktreeMenuLoad: () => ({ cachedTargets: [], refreshTargets: Promise.resolve([]) }),
  initialActiveSessionByProject: new Map(),
  persistActiveSessionByProject: () => undefined,
  projectViewActions: {
    getOrderedGroups: (_projectId: string, groups: SessionGroup[]) => groups,
    setGroupOrderByProject: noop,
    toggleGroup: noop,
    toggleProject: noop,
  },
});

describe('Recent session worktree resolve (SessionProjectCollection)', () => {
  test('attaches the resolved worktree to Recent rows and keeps filtered branches hidden in secondaryMeta', async () => {
    const sessions = [
      worktreeSession('visible-feature', '/tmp/wt-feature'),
      worktreeSession('filtered-head', '/tmp/wt-detached'),
      worktreeSession('filtered-redundant', '/tmp/wt-redundant'),
    ];
    const availableWorktreesByProject = new Map([
      ['/workspace/app', [
        worktreeMeta('/tmp/wt-feature', 'feature-1'),
        worktreeMeta('/tmp/wt-detached', 'HEAD'),
        worktreeMeta('/tmp/wt-redundant', 'App'),
      ]],
    ]);
    const dom = installHookTestDom();
    // The collection reads window.location through platform detectors
    // (isCapacitorApp), which installHookTestDom's bare-global stub does not
    // provide; install a happy-dom window over it, like useSessionGrouping does.
    const domWindow = new Window({ url: 'http://localhost' });
    const originals = new Map<string, PropertyDescriptor | undefined>();
    const windowGlobals = {
      window: domWindow,
      document: domWindow.document,
      navigator: domWindow.navigator,
      Element: domWindow.Element,
      HTMLElement: domWindow.HTMLElement,
      Event: domWindow.Event,
      MutationObserver: domWindow.MutationObserver,
    };
    for (const [name, value] of Object.entries(windowGlobals)) {
      originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
      Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    }
    const container = domWindow.document.createElement('div');
    domWindow.document.body.append(container);
    // SAFETY: happy-dom's DOM types are structurally distinct from the lib DOM
    // types createRoot's Container accepts, so the attached happy-dom element
    // is bridged to React's container type with an intersection assertion.
    const root = createRoot(container as HappyDomHTMLDivElement & Parameters<typeof createRoot>[0]);
    const childStores = new ChildStoreManager();
    const originalStatusState = useGlobalSessionStatusStore.getState();
    const originalProjectsState = useProjectsStore.getState();
    const originalDisplayState = useSessionDisplayStore.getState();

    try {
      // Recent membership is "active now OR fresh within 48h"; the fixtures use
      // epoch timestamps, so mark them active through the status index's
      // sanctioned setter. The global cache stays the authoritative snapshot.
      applyGlobalSnapshot(sessions);
      replaceGlobalSessionStatusById(new Map(sessions.map((session) => [session.id, {
        status: { type: 'busy' as const },
        directory: '/workspace/app',
      }])));
      useGlobalSyncStore.setState({ projects: [{ id: 'opencode-app', worktree: '/workspace/app', time: { created: 1, updated: 1 }, sandboxes: [] }] });
      useProjectsStore.setState({ projects: [{ id: 'app', path: '/workspace/app', label: 'App' }] });
      useSessionDisplayStore.setState({ showRecentSection: true, sidebarViewMode: 'projects', projectDisplayMode: 'all' });

      await act(async () => {
        root.render(
          <I18nProvider>
            <RuntimeAPIContext.Provider value={runtimeApis}>
              <syncRuntimeContext.Provider value={syncRuntime(childStores)}>
                <SessionProjectCollection
                  topology={{
                    projects: [{ id: 'app', path: '/workspace/app', label: 'App', normalizedPath: '/workspace/app' }],
                    availableWorktreesByProject: availableWorktreesByProject,
                    knownDirectories: new Set(),
                    isVSCode: false,
                    worktreeMetadata: new Map(),
                    gitBranches: new Map(),
                    projectRepoStatus: new Map(),
                    projectRootBranches: new Map(),
                    lastRepoStatus: false,
                  }}
                  view={collectionView()}
                  actions={collectionActions()}
                />
              </syncRuntimeContext.Provider>
            </RuntimeAPIContext.Provider>
          </I18nProvider>,
        );
      });

      const recent = capturedSessionRows.filter((row) => row.renderContext === 'recent');
      const byId = new Map(recent.map((row) => [row.node.session.id, row]));

      // (a) The session in a worktree outside the project root resolves owner
      // and worktree through main's resolver chain, and its Recent node carries
      // that worktree so SessionNodeItem's prLookupKey can resolve.
      const visible = byId.get('visible-feature');
      expect(visible?.projectId).toBe('app');
      expect(visible?.groupDirectory).toBe('/tmp/wt-feature');
      expect(visible?.secondaryMeta).toEqual({ projectLabel: 'App', branchLabel: 'feature-1' });
      expect(visible?.node.worktree?.path).toBe('/tmp/wt-feature');
      expect(visible?.node.worktree?.branch).toBe('feature-1');
      // The Recent row keeps its expandable subtree: the worktree attachment
      // must not flatten the tree the way Timeline's projection does.
      expect(visible?.node.children).toHaveLength(0);
      expect(visible?.depth).toBe(0);

      // (b) Filtered branches stay hidden in the row's secondaryMeta while the
      // node's worktree keeps the raw branch for the prLookupKey/fallbacks.
      const head = byId.get('filtered-head');
      expect(head?.projectId).toBe('app');
      expect(head?.secondaryMeta).toEqual({ projectLabel: 'App', branchLabel: null });
      expect(head?.node.worktree?.branch).toBe('HEAD');

      const redundant = byId.get('filtered-redundant');
      expect(redundant?.projectId).toBe('app');
      expect(redundant?.secondaryMeta).toEqual({ projectLabel: 'App', branchLabel: null });
      expect(redundant?.node.worktree?.branch).toBe('App');
    } finally {
      await act(async () => root.unmount());
      useGlobalSessionStatusStore.setState(originalStatusState, true);
      useProjectsStore.setState(originalProjectsState, true);
      useSessionDisplayStore.setState(originalDisplayState, true);
      childStores.disposeAll();
      capturedSessionRows.length = 0;
      for (const [name, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
      dom.restore();
    }
  });

  test('SessionNodeItem precedence: an explicit secondaryMeta filters the tooltip branch; rows without secondaryMeta keep the worktree fallback', async () => {
    const dom = installHookTestDom();
    // The row's guest/multi-run hooks read window.location through the runtime
    // surface detectors, which installHookTestDom's bare-global stub does not
    // provide; install a happy-dom window over it, like useSessionGrouping does.
    const domWindow = new Window({ url: 'http://localhost' });
    const originals = new Map<string, PropertyDescriptor | undefined>();
    for (const [name, value] of Object.entries({
      window: domWindow,
      document: domWindow.document,
      navigator: domWindow.navigator,
      Element: domWindow.Element,
      HTMLElement: domWindow.HTMLElement,
      Event: domWindow.Event,
      MutationObserver: domWindow.MutationObserver,
    })) {
      originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
      Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    }
    const container = domWindow.document.createElement('div');
    domWindow.document.body.append(container);
    // SAFETY: happy-dom's DOM types are structurally distinct from the lib DOM
    // types createRoot's Container accepts, so the attached happy-dom element
    // is bridged to React's container type with an intersection assertion.
    const root = createRoot(container as HappyDomHTMLDivElement & Parameters<typeof createRoot>[0]);
    const childStores = new ChildStoreManager();
    const originalPrEntries = useGitHubPrStatusStore.getState().entries;

    // Render the row exactly as the Recent projection mounts it and expose
    // its per-row tooltip contract through the user-visible inline marker
    // (showInlineBranchMarker is the row's DOM proxy for tooltipBranchLabel).
    const row = (node: { session: Session; worktree: WorktreeMetadata | null; children: SessionNode[] }, secondaryMeta: { projectLabel?: string | null; branchLabel?: string | null } | null) => (
      <I18nProvider>
        <RuntimeAPIContext.Provider value={runtimeApis}>
          <syncRuntimeContext.Provider value={syncRuntime(childStores)}>
            <SessionNodeItem
              node={node}
              pinnedSessionIds={new Set()}
              expandedParents={new Set()}
              hasSessionSearchQuery={false}
              normalizedSessionSearchQuery=""
              notifyOnSubtasks={false}
              editingId={null}
              editingRowKey={null}
              setEditingId={noop}
              setEditingRowKey={noop}
              editTitle=""
              setEditTitle={noop}
              handleSaveEdit={() => undefined}
              handleCancelEdit={() => undefined}
              toggleParent={noop}
              handleSessionSelect={() => undefined}
              handleSessionDoubleClick={() => undefined}
              handleShareSession={() => undefined}
              copiedSessionId={null}
              handleCopyShareUrl={() => undefined}
              handleCopySessionId={() => undefined}
              handleUnshareSession={() => undefined}
              openSidebarMenuKey={null}
              setOpenSidebarMenuKey={noop}
              createFolderAndStartRename={() => null}
              handleDeleteSession={() => undefined}
              handleRestoreSession={() => undefined}
              startSessionWorktreeMenuLoad={() => ({ cachedTargets: [], refreshTargets: Promise.resolve([]) })}
              mobileVariant={false}
              alwaysShowActions={false}
              projectId="app"
              groupDirectory={node.session.directory ?? null}
              secondaryMeta={secondaryMeta}
              renderContext="recent"
              rowKey={`recent:session:${node.session.id}`}
              dragKey={`recent:session:${node.session.id}`}
              subtreeContainsEditing={new Set<string>()}
              menuOpenSessionId={null}
              nodeStructureKey={node.session.id}
            />
          </syncRuntimeContext.Provider>
        </RuntimeAPIContext.Provider>
      </I18nProvider>
    );

    try {
      const visibleNode: SessionNode = {
        session: worktreeSession('visible-feature', '/tmp/wt-feature'),
        worktree: worktreeMeta('/tmp/wt-feature', 'feature-1'),
        children: [],
      };
      const filteredNode: SessionNode = {
        session: worktreeSession('filtered-redundant', '/tmp/wt-redundant'),
        worktree: worktreeMeta('/tmp/wt-redundant', 'App'),
        children: [],
      };
      // PR status is keyed by worktree directory + raw branch: seeding the
      // canonical key locks the whole prLookupKey chain from node.worktree.
      const prKey = getGitHubPrStatusKey('/tmp/wt-feature', 'feature-1');
      useGitHubPrStatusStore.setState((state) => ({
        entries: {
          ...state.entries,
          [prKey]: {
            ...state.entries[prKey],
            status: { connected: true, pr: { number: 42, title: 'PR', url: 'https://github.com/pull/42', state: 'open', draft: false, base: 'main', head: 'feature-1' } },
            isLoading: false,
            error: null,
            isInitialStatusResolved: true,
            lastRefreshAt: 1,
            lastDiscoveryPollAt: 1,
            watchers: 1,
            params: null,
            identity: null,
            resolvedRemoteName: null,
            paramsRevision: 0,
          },
        },
      }));

      // The inline branch marker (one git-branch <use> glyph per row) is the
      // recent row's DOM proxy for tooltipBranchLabel; the seeded PR status
      // resolves through node.worktree and colors that marker.
      const hasBranchMarker = (element: Element | undefined): boolean => (
        Boolean(element?.querySelector('svg use[href="#oc-git-branch"]'))
      );
      // In recent rows the PR summary only colors the branch marker inline
      // (prIconColor); the number itself is tooltip-only.
      const hasPrColor = (element: Element | undefined): boolean => {
        const marker = element?.querySelector('svg use[href="#oc-git-branch"]');
        const style = marker?.parentElement?.getAttribute('style') ?? '';
        return style.includes('var(--pr-');
      };

      await act(async () => {
        root.render(<>
          {row(visibleNode, { projectLabel: 'App', branchLabel: 'feature-1' })}
          {row(filteredNode, { projectLabel: 'App', branchLabel: null })}
          {row({ ...filteredNode, session: { ...filteredNode.session, id: 'no-meta-row' } }, null)}
        </>);
      });

      // SAFETY: the `[data-session-row]` selector only matches the row's own
      // dataset marker, which SessionNodeItem renders on the row's host
      // <div> — an HTMLElement — so the narrowing is safe.
      const rowsById = new Map(
        Array.from(document.querySelectorAll('[data-session-row]')).map((element) => [
          element.getAttribute('data-session-row'),
          element as HTMLElement,
        ]),
      );

      // An explicit secondaryMeta wins: a present branchLabel renders the
      // marker and the seeded PR status resolves through node.worktree.
      const visible = rowsById.get('visible-feature');
      expect(hasBranchMarker(visible)).toBe(true);
      expect(hasPrColor(visible)).toBe(true);

      // A deliberate null branchLabel (HEAD / branch equal to the project
      // label) must NOT fall through to the raw node.worktree.branch.
      expect(hasBranchMarker(rowsById.get('filtered-redundant'))).toBe(false);

      // Rows without secondaryMeta keep the worktree fallback.
      expect(hasBranchMarker(rowsById.get('no-meta-row'))).toBe(true);
    } finally {
      await act(async () => root.unmount());
      useGitHubPrStatusStore.setState((state) => ({ ...state, entries: originalPrEntries }), true);
      childStores.disposeAll();
      for (const [name, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
      dom.restore();
    }
  });
});