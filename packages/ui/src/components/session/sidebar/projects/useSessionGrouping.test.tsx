import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Session } from '@/lib/opencode/model';
import type { WorktreeMetadata } from '@/types/worktree';
import { I18nProvider } from '@/lib/i18n';
import { useSessionActions } from '../sessions/useSessionActions';
import { createSessionOwnershipIndex } from '../sessions/sessionOwnership';
import { useSessionGrouping } from './useSessionGrouping';
import type { SessionNode } from '../types';

type FixtureSession = Session & { parentID?: string };
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
        worktreeSortOrder: 'recent' as const,
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
    type GroupingCapture = { buildGroupedSessions?: ReturnType<typeof useSessionGrouping>['buildGroupedSessions'] };
    const state: GroupingCapture = {};
    const Harness = () => {
      state.buildGroupedSessions = useSessionGrouping({
        homeDirectory: null,
        worktreeMetadata: new Map(),
        pinnedSessionIds: new Set(),
        sessionOrderRanks: new Map(),
        gitBranches: new Map(),
        isVSCode: false,
        worktreeSortOrder: 'recent' as const,
      }).buildGroupedSessions;
      return null;
    };

    renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(Harness)));
    const buildGroupedSessions = state.buildGroupedSessions;
    if (!buildGroupedSessions) throw new Error('grouping callback was not mounted');

    const groups = buildGroupedSessions(
      [session('a', 'b'), session('b', 'a'), session('orphan', 'missing')],
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

  test('stable worktree sorts ignore session activity', () => {
    const worktree = (name: string): WorktreeMetadata => ({
      source: 'sdk', name, path: `/workspace/.wt/${name}`, projectDirectory: '/workspace', branch: name, label: name,
    });
    const busy = { ...session('busy'), directory: '/workspace/.wt/zeta', time: { created: 1, updated: 99 } };
    const worktreeOrder = (worktreeSortOrder: 'recent' | 'a-z') => {
      const state: { build?: ReturnType<typeof useSessionGrouping>['buildGroupedSessions'] } = {};
      const Harness = () => {
        state.build = useSessionGrouping({
          homeDirectory: null,
          worktreeMetadata: new Map(),
          pinnedSessionIds: new Set(),
          sessionOrderRanks: new Map(),
          gitBranches: new Map(),
          isVSCode: false,
          worktreeSortOrder,
        }).buildGroupedSessions;
        return null;
      };
      renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(Harness)));
      if (!state.build) throw new Error('grouping callback was not mounted');
      return state.build([busy], '/workspace', [worktree('zeta'), worktree('alpha')], null, true)
        .filter((group) => group.worktree)
        .map((group) => group.label);
    };

    expect(worktreeOrder('recent')).toEqual(['zeta', 'alpha']);
    expect(worktreeOrder('a-z')).toEqual(['alpha', 'zeta']);
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
    type GroupingCapture = { buildGroupedSessions?: ReturnType<typeof useSessionGrouping>['buildGroupedSessions'] };
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
        worktreeSortOrder: 'recent' as const,
        sessionOwners: ownership.bySessionId,
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
});
