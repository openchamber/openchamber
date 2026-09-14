import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Session } from '@opencode-ai/sdk/v2';
import { I18nProvider } from '@/lib/i18n';
import { matchesRankQuery } from '@/lib/search/fuzzySearch';
import { useSessionActions } from '../sessions/useSessionActions';
import { useSessionGrouping } from './useSessionGrouping';
import type { SessionNode } from '../types';

type FixtureSession = Session & { parentID?: string };
const session = (id: string, parentID?: string): Session => {
  const value: FixtureSession = {
    id,
    slug: id,
    projectID: 'project',
    title: id,
    version: '1',
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
        setEditTitle: () => undefined,
        editingId: null,
        editTitle: '',
        copiedSessionId: null,
        setCopiedSessionId: () => undefined,
      }).handleDeleteSession;
      return null;
    };

    renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(Harness)));
    const handleDeleteSession = state.handleDeleteSession;
    if (!handleDeleteSession) throw new Error('session actions callback was not mounted');

    handleDeleteSession(session('root'));
    handleDeleteSession(session('root'), { hardDelete: true });
  });
});

/**
 * The old two-pass behavior, kept as the parity oracle: the hook returned the
 * filtered tree, then `countNodes` in `useSessionSidebarSections` walked that
 * tree again. `buildSessionSearchText` is captured from the real hook so the
 * matcher input is identical.
 */
const oldFilterSessionNodesForSearch = (
  nodes: SessionNode[],
  query: string,
  buildSessionSearchText: (value: Session) => string,
): SessionNode[] => {
  if (!query) return nodes;
  const normalizedQuery = query.trim().toLowerCase();
  const isIdQuery = normalizedQuery.startsWith('ses_');
  return nodes.flatMap((node) => {
    if (isIdQuery && Boolean(node.session.time?.archived)) return [];
    const nodeMatches = isIdQuery
      ? node.session.id.toLowerCase() === normalizedQuery
      : matchesRankQuery([buildSessionSearchText(node.session)], query);
    if (nodeMatches) return [node];
    const filteredChildren = oldFilterSessionNodesForSearch(node.children, query, buildSessionSearchText);
    if (filteredChildren.length === 0) return [];
    return [{ ...node, children: filteredChildren }];
  });
};

const oldCountNodes = (nodes: SessionNode[], query: string): number => {
  const normalizedQuery = query.trim().toLowerCase();
  const isIdQuery = normalizedQuery.startsWith('ses_');
  return nodes.reduce((total, node) => (
    total + (!isIdQuery || node.session.id.toLowerCase() === normalizedQuery ? 1 : 0)
    + oldCountNodes(node.children, query)
  ), 0);
};

type SearchFilter = ReturnType<typeof useSessionGrouping>['filterSessionNodesForSearch'];

type SearchFilterCapture = {
  filterSessionNodesForSearch: SearchFilter | null;
  buildSessionSearchText: ((value: Session) => string) | null;
};

type CapturedSearchFilter = {
  filterSessionNodesForSearch: SearchFilter;
  buildSessionSearchText: (value: Session) => string;
};

const captureSearchFilter = (): CapturedSearchFilter => {
  const state: SearchFilterCapture = { filterSessionNodesForSearch: null, buildSessionSearchText: null };
  const Harness = () => {
    const grouping = useSessionGrouping({
      homeDirectory: null,
      worktreeMetadata: new Map(),
      pinnedSessionIds: new Set(),
      sessionOrderRanks: new Map(),
      gitBranches: new Map(),
      isVSCode: false,
    });
    state.filterSessionNodesForSearch = grouping.filterSessionNodesForSearch;
    state.buildSessionSearchText = grouping.buildSessionSearchText;
    return null;
  };

  renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(Harness)));
  const { filterSessionNodesForSearch, buildSessionSearchText } = state;
  if (!filterSessionNodesForSearch || !buildSessionSearchText) throw new Error('grouping search callbacks were not mounted');
  return { filterSessionNodesForSearch, buildSessionSearchText };
};

let cachedSearchFilter: ReturnType<typeof captureSearchFilter> | null = null;
const getSearchFilter = (): ReturnType<typeof captureSearchFilter> => {
  if (!cachedSearchFilter) {
    cachedSearchFilter = captureSearchFilter();
  }
  return cachedSearchFilter;
};

describe('search filtering parity with the old two-pass algorithm', () => {
  type NodeOptions = {
    title?: string;
    directory?: string;
    archived?: boolean;
    children?: SessionNode[];
  };

  const makeNode = (id: string, options: NodeOptions = {}): SessionNode => ({
    session: {
      id,
      slug: id,
      projectID: 'project',
      title: options.title ?? id,
      version: '1',
      directory: options.directory ?? '/projects/alpha',
      time: options.archived
        ? { created: 1, updated: 1, archived: 2 }
        : { created: 1, updated: 1 },
    },
    children: options.children ?? [],
    worktree: null,
  });

  const totalNodeCount = (nodes: SessionNode[]): number => nodes.reduce(
    (total, node) => total + 1 + totalNodeCount(node.children),
    0,
  );

  const tree: SessionNode[] = [
    makeNode('root-release', {
      title: 'Release planning',
      children: [
        makeNode('child-fix', {
          title: 'Fix release bug',
          children: [
            makeNode('ses_grand_note', { title: 'Deep release note' }),
            makeNode('grand-grocery', { title: 'Grocery list' }),
          ],
        }),
        makeNode('child-grocery', { title: 'Grocery sibling' }),
      ],
    }),
    makeNode('root-prerelease', { title: 'prerelease checklist' }),
    makeNode('root-dir', { title: 'Quarterly report', directory: '/workspace/archive' }),
    makeNode('root-compact', { title: 'Release-notes v1.21' }),
    makeNode('ses_archived_root', { title: 'Release archived root', archived: true }),
    makeNode('root-dup-1', { title: 'Duplicate title' }),
    makeNode('root-dup-2', { title: 'Duplicate title' }),
    makeNode('deep-1', {
      title: 'level one',
      children: [
        makeNode('deep-2', {
          title: 'level two',
          children: [
            makeNode('deep-3', {
              title: 'level three',
              children: [makeNode('deep-4', { title: 'grocery deep' })],
            }),
          ],
        }),
      ],
    }),
    makeNode('ses_parent_match', {
      title: 'Context parent',
      children: [makeNode('ses_archived_child', { title: 'Archived child', archived: true })],
    }),
  ];

  const expectParity = (query: string): ReturnType<SearchFilter> => {
    const { filterSessionNodesForSearch, buildSessionSearchText } = getSearchFilter();
    const referenceNodes = oldFilterSessionNodesForSearch(tree, query, buildSessionSearchText);
    const referenceCount = oldCountNodes(referenceNodes, query);
    const result = filterSessionNodesForSearch(tree, query);

    expect(result.nodes).toEqual(referenceNodes);
    expect(result.matchedCount).toBe(referenceCount);
    return result;
  };

  test('matches the old filter and count for every text query shape', () => {
    for (const query of [
      'release',
      'planning',
      'release planning',
      'workspace',
      'rel',
      'notes',
      'grocery',
      'deep',
      'releasenotes',
      'duplicate title',
      'nothing-matches-this',
    ]) {
      expectParity(query);
    }
  });

  test('matches the old filter and count for ID queries', () => {
    for (const query of [
      'ses_grand_note',
      'SES_GRAND_NOTE',
      'ses_grand',
      'ses_',
      'ses_archived_root',
      'ses_archived_child',
      'ses_parent_match',
      'ses_parent',
    ]) {
      expectParity(query);
    }
  });

  test('keeps the empty-query identity and full tree count', () => {
    const { filterSessionNodesForSearch } = getSearchFilter();
    const result = filterSessionNodesForSearch(tree, '');

    expect(result.nodes).toBe(tree);
    expect(result.matchedCount).toBe(totalNodeCount(tree));
    expectParity('');
    expectParity('   ');
  });

  test('keeps a directly matched parent subtree and counts every node in it', () => {
    const result = expectParity('release planning');

    expect(collectIds(result.nodes)).toEqual([
      'root-release',
      'child-fix',
      'ses_grand_note',
      'grand-grocery',
      'child-grocery',
    ]);
    expect(result.matchedCount).toBe(5);
  });

  test('keeps the ancestor chain of a child match and filters unrelated siblings', () => {
    const result = expectParity('grocery list');

    expect(collectIds(result.nodes)).toEqual(['root-release', 'child-fix', 'grand-grocery']);
    expect(result.matchedCount).toBe(3);
  });

  test('counts only the exact ID match, not its context or kept descendants', () => {
    const exact = expectParity('SES_GRAND_NOTE');
    expect(collectIds(exact.nodes)).toEqual(['root-release', 'child-fix', 'ses_grand_note']);
    expect(exact.matchedCount).toBe(1);

    const keptSubtree = expectParity('ses_parent_match');
    expect(collectIds(keptSubtree.nodes)).toEqual(['ses_parent_match', 'ses_archived_child']);
    expect(keptSubtree.matchedCount).toBe(1);
  });

  test('prunes archived sessions and partial IDs', () => {
    const partial = expectParity('ses_grand');
    expect(partial.nodes).toEqual([]);
    expect(partial.matchedCount).toBe(0);

    const archived = expectParity('ses_archived_root');
    expect(archived.nodes).toEqual([]);
    expect(archived.matchedCount).toBe(0);
  });

  test('counts directory, compact-punctuation, and duplicate-title matches exactly', () => {
    const directory = expectParity('workspace');
    expect(collectIds(directory.nodes)).toEqual(['root-dir']);
    expect(directory.matchedCount).toBe(1);

    const compact = expectParity('releasenotes');
    expect(collectIds(compact.nodes)).toEqual(['root-compact']);
    expect(compact.matchedCount).toBe(1);

    const duplicates = expectParity('duplicate title');
    expect(collectIds(duplicates.nodes)).toEqual(['root-dup-1', 'root-dup-2']);
    expect(duplicates.matchedCount).toBe(2);
  });
});
