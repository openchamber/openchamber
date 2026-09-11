import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Session } from '@opencode-ai/sdk/v2';
import { I18nProvider } from '@/lib/i18n';
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
        isSessionSearchOpen: false,
        sessionSearchQuery: '',
        setSessionSearchQuery: () => undefined,
        setIsSessionSearchOpen: () => undefined,
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
